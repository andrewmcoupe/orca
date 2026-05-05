use std::process::Command;
use std::sync::Arc;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;
use ulid::Ulid;

use crate::commands_briefing;
use crate::events::projections::{
    self, apply_briefing_event, apply_phase_run_event, apply_plan_event, apply_task_event,
    apply_workspace_event,
};
use crate::events::types::{EventMetadata, NewEvent};
use crate::events::{append::append_events_in_tx, AppendError};
use crate::phases::{self, InflightRuns};
use crate::providers::{self, KnownModel, OptionDecl, ProviderCache, ProviderStatus};
use crate::recent_events::{self, RecentEventRow};
use crate::settings::{self, PermissionMode, PhaseConfig, PhaseType};
use crate::subprocess::{ChildTracker, StreamOptions};
use crate::workspace_db::open_workspace_db;
use crate::{ActiveWorkspace, ActiveWorkspaceState, GlobalDb};

#[derive(Debug, Serialize, Clone)]
pub struct ProjectionUpdated {
    /// Per-workspace aggregates carry the workspace id; workspace-aggregate events
    /// (which are app-level, not scoped to a workspace) carry null.
    pub workspace_id: Option<String>,
    pub aggregate_type: String,
    pub aggregate_id: String,
}

pub const PROJECTION_UPDATED_EVENT: &str = "projection_updated";

fn new_command_id() -> String {
    Ulid::new().to_string()
}

fn make_metadata(actor: &str) -> EventMetadata {
    make_metadata_for(actor)
}

pub(crate) fn make_metadata_for(actor: &str) -> EventMetadata {
    EventMetadata {
        command_id: new_command_id(),
        actor: actor.to_string(),
        correlation_id: None,
        causation_id: None,
    }
}

pub(crate) fn emit_projection_updated(
    app: &AppHandle,
    workspace_id: Option<&str>,
    aggregate_type: &str,
    aggregate_id: &str,
) {
    let _ = app.emit(
        PROJECTION_UPDATED_EVENT,
        ProjectionUpdated {
            workspace_id: workspace_id.map(|s| s.to_string()),
            aggregate_type: aggregate_type.to_string(),
            aggregate_id: aggregate_id.to_string(),
        },
    );
}

fn map_append_err(e: AppendError) -> String {
    e.to_string()
}

// ======================================================================
// Workspace commands
// ======================================================================

#[tauri::command]
pub fn add_workspace(
    app: AppHandle,
    path: String,
    state: State<'_, GlobalDb>,
) -> Result<projections::WorkspaceProjection, String> {
    let output = Command::new("git")
        .args(["-C", &path, "rev-parse", "--git-dir"])
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;
    if !output.status.success() {
        return Err(format!("not a git repository: {}", path));
    }

    let name = std::path::Path::new(&path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&path)
        .to_string();

    let id = format!("ws_{}", Ulid::new());
    let payload = json!({ "path": path, "name": name }).to_string();

    {
        let mut conn = state.0.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "workspace",
            &id,
            0,
            vec![NewEvent {
                event_type: "WorkspaceRegistered".into(),
                version: 1,
                payload,
            }],
            &make_metadata("user:local"),
        )
        .map_err(map_append_err)?;
        for ev in &outcome.events {
            apply_workspace_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    emit_projection_updated(&app, None, "workspace", &id);

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    projections::get_workspace(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "workspace not found after insert".into())
}

#[tauri::command]
pub fn list_workspaces(
    state: State<'_, GlobalDb>,
) -> Result<Vec<projections::WorkspaceProjection>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    projections::list_active_workspaces(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_workspace(
    app: AppHandle,
    id: String,
    state: State<'_, GlobalDb>,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    // Determine current seq
    let payload = json!({ "reason": "user_removed" }).to_string();

    {
        let mut conn = state.0.lock().map_err(|e| e.to_string())?;
        let expected_seq: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM events WHERE aggregate_type = 'workspace' AND aggregate_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "workspace",
            &id,
            expected_seq,
            vec![NewEvent {
                event_type: "WorkspaceArchived".into(),
                version: 1,
                payload,
            }],
            &make_metadata("user:local"),
        )
        .map_err(map_append_err)?;
        for ev in &outcome.events {
            apply_workspace_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    // If this was the active workspace, close it
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        if let Some(aw) = guard.as_ref() {
            if aw.id == id {
                *guard = None;
            }
        }
    }

    emit_projection_updated(&app, None, "workspace", &id);
    Ok(())
}

#[tauri::command]
pub fn get_workspace_settings(
    workspace_id: String,
    state: State<'_, GlobalDb>,
) -> Result<crate::settings::WorkspaceSettings, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let settings_json: String = conn
        .query_row(
            "SELECT settings_json FROM workspace_projection WHERE id = ?1",
            params![workspace_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(crate::settings::WorkspaceSettings::from_json_str(
        &settings_json,
    ))
}

#[tauri::command]
pub fn update_workspace_settings(
    app: AppHandle,
    workspace_id: String,
    settings: crate::settings::WorkspaceSettings,
    state: State<'_, GlobalDb>,
) -> Result<crate::settings::WorkspaceSettings, String> {
    let settings_value = serde_json::to_value(&settings).map_err(|e| e.to_string())?;
    let payload = json!({ "settings": settings_value }).to_string();
    {
        let mut conn = state.0.lock().map_err(|e| e.to_string())?;
        let expected_seq: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM events WHERE aggregate_type = 'workspace' AND aggregate_id = ?1",
                params![workspace_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "workspace",
            &workspace_id,
            expected_seq,
            vec![NewEvent {
                event_type: "WorkspaceSettingsChanged".into(),
                version: 1,
                payload,
            }],
            &make_metadata("user:local"),
        )
        .map_err(map_append_err)?;
        for ev in &outcome.events {
            apply_workspace_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    emit_projection_updated(&app, None, "workspace", &workspace_id);
    Ok(settings)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActiveWorkspaceInfo {
    pub id: String,
    pub path: String,
}

#[tauri::command]
pub fn set_active_workspace(
    app: AppHandle,
    id: String,
    global: State<'_, GlobalDb>,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<ActiveWorkspaceInfo, String> {
    let ws = {
        let conn = global.0.lock().map_err(|e| e.to_string())?;
        projections::get_workspace(&conn, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("workspace not found: {}", id))?
    };
    if ws.archived {
        return Err("workspace is archived".into());
    }

    let conn = open_workspace_db(&ws.path).map_err(|e| e.to_string())?;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(ActiveWorkspace {
            id: ws.id.clone(),
            path: ws.path.clone(),
            conn,
        });
    }

    // Best-effort orphan reconciliation. Failures here must not block activation.
    if let Err(e) = reconcile_worktrees(&app, &ws.id, &ws.path) {
        eprintln!("worktree reconciliation failed for {}: {}", ws.path, e);
    }

    // Restart-recovery sweep: any briefing flagged `is_generating = 1` whose
    // owning process didn't survive gets a synthetic GenerationFailed event so
    // the spinner clears. Held under the active conn lock so the sweep sees a
    // consistent snapshot; non-fatal on error (we'd rather have a workspace
    // with stale spinners than refuse activation).
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        if let Some(aw) = guard.as_mut() {
            match commands_briefing::sweep_stale_inflight_on_activation(&app, &mut aw.conn, &ws.id)
            {
                Ok(0) => {}
                Ok(n) => {
                    eprintln!(
                        "workspace {}: cleared {n} stale in-flight briefing(s) on activation",
                        ws.id
                    );
                }
                Err(e) => {
                    eprintln!("workspace {}: stale-briefing sweep failed: {}", ws.id, e);
                }
            }
        }
    }

    Ok(ActiveWorkspaceInfo {
        id: ws.id,
        path: ws.path,
    })
}

/// Read the current branch of the workspace's main worktree. Returns `None`
/// when HEAD is detached or unborn — both legitimate states for the status
/// bar to render as "—" rather than crashing the bar with an error toast.
#[tauri::command]
pub fn get_workspace_branch(path: String) -> Result<Option<String>, String> {
    let repo = match git2::Repository::discover(&path) {
        Ok(r) => r,
        Err(e) => return Err(e.message().to_string()),
    };
    let head = match repo.head() {
        Ok(h) => h,
        Err(e)
            if e.code() == git2::ErrorCode::UnbornBranch
                || e.code() == git2::ErrorCode::NotFound =>
        {
            return Ok(None);
        }
        Err(e) => return Err(e.message().to_string()),
    };
    if !head.is_branch() {
        return Ok(None);
    }
    Ok(head.shorthand().map(|s| s.to_string()))
}

#[derive(Debug, Serialize)]
pub struct OrphanWorktree {
    pub path: String,
    pub task_id: Option<String>,
    pub branch: Option<String>,
    pub head_commit: Option<String>,
    pub has_uncommitted_changes: bool,
}

#[tauri::command]
pub fn list_orphan_worktrees(
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Vec<OrphanWorktree>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    find_orphans(&aw.conn, &aw.path)
}

fn find_orphans(
    conn: &rusqlite::Connection,
    workspace_path: &str,
) -> Result<Vec<OrphanWorktree>, String> {
    let dir = std::path::Path::new(workspace_path)
        .join(".orca")
        .join("worktrees");
    if !dir.exists() {
        return Ok(Vec::new());
    }

    // Tasks the projection knows about with an active worktree.
    let mut active_task_ids = std::collections::HashSet::<String>::new();
    let mut stmt = conn
        .prepare("SELECT id FROM task_projection WHERE worktree_status = 'active'")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for id in rows.flatten() {
        active_task_ids.insert(id);
    }

    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if active_task_ids.contains(&name) {
            continue;
        }
        let dirty = crate::worktree::worktree_status(&path)
            .map(|s| s.has_uncommitted_changes)
            .unwrap_or(false);
        out.push(OrphanWorktree {
            path: path.to_string_lossy().to_string(),
            task_id: Some(name),
            branch: None,
            head_commit: None,
            has_uncommitted_changes: dirty,
        });
    }
    Ok(out)
}

/// On workspace activation, walk the task projection and reconcile each "active" worktree
/// against disk. Worktrees whose directories are gone get a `WorktreeRemoved` event with
/// `reason: "cleanup_orphan"`. Worktrees that exist on disk but aren't tracked are logged
/// (and surfaced via `list_orphan_worktrees`).
fn reconcile_worktrees(
    app: &AppHandle,
    workspace_id: &str,
    workspace_path: &str,
) -> Result<(), String> {
    // Collect tracked tasks whose worktree dir is missing.
    let stale: Vec<(String, String)> = {
        let active_state = app.state::<ActiveWorkspaceState>();
        let mut guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        let mut stmt = aw
            .conn
            .prepare(
                "SELECT id, worktree_path FROM task_projection
                 WHERE worktree_status = 'active' AND worktree_path IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            let (task_id, path) = r.map_err(|e| e.to_string())?;
            if !std::path::Path::new(&path).exists() {
                out.push((task_id, path));
            }
        }
        out
    };

    for (task_id, path) in stale {
        // Best-effort prune of the registration in case the dir is gone but `.git/worktrees`
        // still has a leftover entry. Errors here are non-fatal.
        let _ = crate::worktree::remove_worktree(
            std::path::Path::new(workspace_path),
            std::path::Path::new(&path),
            true,
        );

        let active_state = app.state::<ActiveWorkspaceState>();
        let mut guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        let seq = current_task_seq(&aw.conn, &task_id)?;
        let payload = json!({
            "worktree_path": path,
            "reason": "cleanup_orphan",
        })
        .to_string();
        let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "task",
            &task_id,
            seq,
            vec![NewEvent {
                event_type: "WorktreeRemoved".into(),
                version: 1,
                payload,
            }],
            &make_metadata("system:worktree_reconcile"),
        )
        .map_err(map_append_err)?;
        for ev in &outcome.events {
            apply_task_event(&tx, ev).map_err(|e| e.to_string())?;
            recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        drop(guard);

        emit_projection_updated(app, Some(workspace_id), "task", &task_id);
        emit_projection_updated(app, Some(workspace_id), "recent_events", workspace_id);
    }

    // Log unknown on-disk worktrees. Don't auto-delete — could be the user investigating.
    {
        let active_state = app.state::<ActiveWorkspaceState>();
        let mut guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        if let Ok(orphans) = find_orphans(&aw.conn, &aw.path) {
            for o in &orphans {
                eprintln!("orphan worktree on disk: {}", o.path);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn get_active_workspace(
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Option<ActiveWorkspaceInfo>, String> {
    let guard = active.0.lock().map_err(|e| e.to_string())?;
    Ok(guard.as_ref().map(|a| ActiveWorkspaceInfo {
        id: a.id.clone(),
        path: a.path.clone(),
    }))
}

// ======================================================================
// Plan auto-completion
// ======================================================================

/// Returns Some(plan_id) if the plan owning `task_id` has just become eligible for
/// PlanCompleted: every sibling task is in a terminal state (merged | cancelled |
/// archived) AND the plan itself is in a non-terminal state (active | paused). Returns
/// None otherwise — including when the task or plan can't be found, which is a benign
/// race (e.g. plan archived between commit and check).
pub fn plan_completion_eligible(
    conn: &rusqlite::Connection,
    task_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT t.plan_id, p.status
             FROM task_projection t
             JOIN plan_projection p ON p.id = t.plan_id
             WHERE t.id = ?1",
            params![task_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (plan_id, status) = match row {
        Some(v) => v,
        None => return Ok(None),
    };
    if status != "active" && status != "paused" {
        return Ok(None);
    }
    let non_terminal: i64 = conn.query_row(
        "SELECT COUNT(*) FROM task_projection
         WHERE plan_id = ?1 AND status NOT IN ('merged', 'cancelled', 'archived')",
        params![plan_id],
        |r| r.get(0),
    )?;
    if non_terminal == 0 {
        Ok(Some(plan_id))
    } else {
        Ok(None)
    }
}

/// After a task has transitioned to a terminal state, check if the parent plan is now
/// fully terminal and emit `PlanCompleted` as a separate append. Concurrency conflicts
/// (e.g. user paused/cancelled the plan in the same instant) are logged and ignored —
/// this is a best-effort projection convenience, not a correctness requirement.
fn maybe_complete_plan(app: &AppHandle, workspace_id: &str, task_id: &str) {
    let active = app.state::<ActiveWorkspaceState>();
    let plan_id = {
        let mut guard = match active.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let aw = match guard.as_mut() {
            Some(aw) => aw,
            None => return,
        };
        match plan_completion_eligible(&aw.conn, task_id) {
            Ok(Some(pid)) => pid,
            Ok(None) => return,
            Err(e) => {
                eprintln!(
                    "plan_completion_eligible failed for task {}: {}",
                    task_id, e
                );
                return;
            }
        }
    };

    let mut guard = match active.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let aw = match guard.as_mut() {
        Some(aw) => aw,
        None => return,
    };
    if let Err(e) = append_plan_event(
        aw,
        &plan_id,
        "PlanCompleted",
        json!({}),
        "system:auto_complete",
    ) {
        eprintln!("auto-emit PlanCompleted for {} failed: {}", plan_id, e);
        return;
    }
    drop(guard);
    emit_projection_updated(app, Some(workspace_id), "plan", &plan_id);
    emit_projection_updated(app, Some(workspace_id), "recent_events", workspace_id);
}

// ======================================================================
// Plan commands (per-workspace)
// ======================================================================

fn current_plan_seq(conn: &rusqlite::Connection, plan_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM events WHERE aggregate_type = 'plan' AND aggregate_id = ?1",
        params![plan_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn append_plan_event(
    aw: &mut ActiveWorkspace,
    plan_id: &str,
    event_type: &str,
    payload: serde_json::Value,
    actor: &str,
) -> Result<(), String> {
    let seq = current_plan_seq(&aw.conn, plan_id)?;
    let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
    let outcome = append_events_in_tx(
        &tx,
        "plan",
        plan_id,
        seq,
        vec![NewEvent {
            event_type: event_type.into(),
            version: 1,
            payload: payload.to_string(),
        }],
        &make_metadata(actor),
    )
    .map_err(map_append_err)?;
    for ev in &outcome.events {
        apply_plan_event(&tx, ev).map_err(|e| e.to_string())?;
        recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn create_plan(
    app: AppHandle,
    title: String,
    description: String,
    source: String,
    source_metadata: Option<serde_json::Value>,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<projections::PlanProjection, String> {
    let plan_id = format!("plan_{}", Ulid::new());
    let workspace_id;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();
        let payload = json!({
            "workspace_id": aw.id,
            "title": title,
            "description": description,
            "source": source,
            "source_metadata": source_metadata,
        });
        append_plan_event(aw, &plan_id, "PlanCreated", payload, "user:local")?;
    }
    emit_projection_updated(&app, Some(&workspace_id), "plan", &plan_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);

    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    projections::get_plan(&aw.conn, &plan_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "plan not found after insert".into())
}

#[tauri::command]
pub fn revise_plan(
    app: AppHandle,
    plan_id: String,
    title: String,
    description: String,
    reason: Option<String>,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<projections::PlanProjection, String> {
    let workspace_id;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();
        append_plan_event(
            aw,
            &plan_id,
            "PlanDescriptionRevised",
            json!({ "title": title, "description": description, "reason": reason }),
            "user:local",
        )?;
    }
    emit_projection_updated(&app, Some(&workspace_id), "plan", &plan_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);

    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    projections::get_plan(&aw.conn, &plan_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "plan not found".into())
}

#[tauri::command]
pub fn pause_plan(
    app: AppHandle,
    plan_id: String,
    reason: Option<String>,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    let workspace_id;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();
        append_plan_event(
            aw,
            &plan_id,
            "PlanPaused",
            json!({ "reason": reason }),
            "user:local",
        )?;
    }
    emit_projection_updated(&app, Some(&workspace_id), "plan", &plan_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);
    Ok(())
}

#[tauri::command]
pub fn resume_plan(
    app: AppHandle,
    plan_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    let workspace_id;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();
        append_plan_event(aw, &plan_id, "PlanResumed", json!({}), "user:local")?;
    }
    emit_projection_updated(&app, Some(&workspace_id), "plan", &plan_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);
    Ok(())
}

/// A task that's still alive on a plan: anything not in `cancelled` / `merged` /
/// `archived`. Used by the cancel/archive plan dialogs to preview what will be cascaded
/// and by the cascade itself to know what to cancel.
#[derive(Debug, Serialize)]
pub struct PlanCascadePreview {
    pub task_id: String,
    pub title: String,
    pub status: String,
    pub has_running_phase_run: bool,
    pub worktree_path: Option<String>,
}

/// Internal cascade target — what `cascade_cancel_tasks` actually needs.
struct CascadeTarget {
    task_id: String,
    latest_phase_run_id: Option<String>,
}

fn build_cascade_targets(
    aw: &ActiveWorkspace,
    plan_id: &str,
) -> Result<Vec<CascadeTarget>, String> {
    let tasks = projections::list_tasks_in_plan(&aw.conn, plan_id).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for t in tasks {
        if t.status == "cancelled" || t.status == "merged" || t.status == "archived" {
            continue;
        }
        out.push(CascadeTarget {
            task_id: t.id,
            latest_phase_run_id: t.latest_phase_run_id,
        });
    }
    Ok(out)
}

fn collect_active_tasks_for_plan(
    aw: &ActiveWorkspace,
    plan_id: &str,
) -> Result<Vec<PlanCascadePreview>, String> {
    let tasks = projections::list_tasks_in_plan(&aw.conn, plan_id).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for t in tasks {
        let status = t.status.clone();
        if status == "cancelled" || status == "merged" || status == "archived" {
            continue;
        }
        let has_running_phase_run = match &t.latest_phase_run_id {
            Some(pr_id) => projections::list_phase_runs_for_task(&aw.conn, &t.id)
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|r| &r.id == pr_id)
                .is_some_and(|r| r.status == "running"),
            None => false,
        };
        out.push(PlanCascadePreview {
            task_id: t.id,
            title: t.title,
            status,
            has_running_phase_run,
            worktree_path: t.worktree_path,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn preview_plan_cascade(
    plan_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Vec<PlanCascadePreview>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    collect_active_tasks_for_plan(aw, &plan_id)
}

/// Cancel any in-flight phase runs for the given tasks and emit `TaskCancelled` for
/// each. Does NOT touch worktrees — the user is told to remove them manually. Errors on
/// a single task are logged but don't abort the cascade; best-effort cleanup avoids
/// stranding other tasks in a half-cancelled state.
fn cascade_cancel_tasks(
    app: &AppHandle,
    workspace_id: &str,
    cascade: &[CascadeTarget],
    reason: &str,
) {
    let inflight = app.state::<InflightRuns>();
    for target in cascade {
        if let Some(pr_id) = &target.latest_phase_run_id {
            inflight.cancel(pr_id);
        }
    }

    let active = app.state::<ActiveWorkspaceState>();
    let mut guard = match active.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let aw = match guard.as_mut() {
        Some(aw) => aw,
        None => return,
    };

    for target in cascade {
        let task_id = &target.task_id;
        let payload = json!({ "reason": reason }).to_string();
        let seq = match current_task_seq(&aw.conn, task_id) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let tx = match aw.conn.transaction() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let outcome = append_events_in_tx(
            &tx,
            "task",
            task_id,
            seq,
            vec![NewEvent {
                event_type: "TaskCancelled".into(),
                version: 1,
                payload,
            }],
            &make_metadata("user:local"),
        );
        let outcome = match outcome {
            Ok(o) => o,
            Err(e) => {
                eprintln!("cascade cancel: append failed for {}: {}", task_id, e);
                continue;
            }
        };
        let mut applied_ok = true;
        for ev in &outcome.events {
            if let Err(e) = apply_task_event(&tx, ev) {
                eprintln!("cascade cancel: applier failed for {}: {}", task_id, e);
                applied_ok = false;
                break;
            }
            if let Err(e) = recent_events::record_event(&tx, ev) {
                eprintln!(
                    "cascade cancel: recent_events failed for {}: {}",
                    task_id, e
                );
                applied_ok = false;
                break;
            }
        }
        if !applied_ok {
            continue;
        }
        if tx.commit().is_err() {
            continue;
        }
        emit_projection_updated(app, Some(workspace_id), "task", task_id);
    }
    emit_projection_updated(app, Some(workspace_id), "recent_events", workspace_id);
}

#[tauri::command]
pub fn cancel_plan(
    app: AppHandle,
    plan_id: String,
    reason: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    let workspace_id;
    let cascade: Vec<CascadeTarget>;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();
        cascade = build_cascade_targets(aw, &plan_id)?;
        append_plan_event(
            aw,
            &plan_id,
            "PlanCancelled",
            json!({ "reason": reason }),
            "user:local",
        )?;
    }
    cascade_cancel_tasks(&app, &workspace_id, &cascade, "plan_cancelled");
    emit_projection_updated(&app, Some(&workspace_id), "plan", &plan_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);
    Ok(())
}

#[tauri::command]
pub fn archive_plan(
    app: AppHandle,
    plan_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    let workspace_id;
    let cascade: Vec<CascadeTarget>;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();
        cascade = build_cascade_targets(aw, &plan_id)?;
        append_plan_event(aw, &plan_id, "PlanArchived", json!({}), "user:local")?;
    }
    cascade_cancel_tasks(&app, &workspace_id, &cascade, "plan_archived");
    emit_projection_updated(&app, Some(&workspace_id), "plan", &plan_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);
    Ok(())
}

#[tauri::command]
pub fn list_plans(
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Vec<projections::PlanProjection>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    let workspace_id = aw.id.clone();
    projections::list_plans(&aw.conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_plan(
    id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Option<projections::PlanProjection>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    projections::get_plan(&aw.conn, &id).map_err(|e| e.to_string())
}

// ======================================================================
// Task commands (per-workspace)
// ======================================================================

fn require_active_workspace<'a>(
    guard: &'a mut std::sync::MutexGuard<'_, Option<ActiveWorkspace>>,
) -> Result<&'a mut ActiveWorkspace, String> {
    guard
        .as_mut()
        .ok_or_else(|| "no active workspace".to_string())
}

#[tauri::command]
pub fn create_task(
    app: AppHandle,
    plan_id: String,
    title: String,
    spec_markdown: String,
    phase_config: Option<serde_json::Value>,
    depends_on: Option<Vec<String>>,
    global: State<'_, GlobalDb>,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<projections::TaskProjection, String> {
    let task_id = format!("task_{}", Ulid::new());
    let workspace_id;
    let depends_on = depends_on.unwrap_or_default();

    // Validate proposed dependencies before we touch the event store. Cycle
    // detection at create time is mostly defensive — a brand-new task can't
    // be in any cycle by definition since nobody else points at it yet —
    // but the same validator catches missing-id and cross-plan errors that
    // are very real.
    if !depends_on.is_empty() {
        let guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_ref()
            .ok_or_else(|| "no active workspace".to_string())?;
        crate::dependencies::validate_dependencies(&aw.conn, &task_id, &plan_id, &depends_on)
            .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))?;
    }

    // Resolve phase_config at create time. Per-task override wins; otherwise inherit
    // the workspace default (from the workspace's stored settings, parsed tolerantly).
    // Events are immutable: whatever ends up here is the config that sticks.
    let resolved_phase_config: serde_json::Value = {
        if let Some(pc) = phase_config {
            pc
        } else {
            let conn = global.0.lock().map_err(|e| e.to_string())?;
            let active_guard = active.0.lock().map_err(|e| e.to_string())?;
            let workspace_id_for_settings = active_guard
                .as_ref()
                .ok_or_else(|| "no active workspace".to_string())?
                .id
                .clone();
            drop(active_guard);
            let settings_json: String = conn
                .query_row(
                    "SELECT settings_json FROM workspace_projection WHERE id = ?1",
                    params![workspace_id_for_settings],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| "{}".to_string());
            let settings = crate::settings::WorkspaceSettings::from_json_str(&settings_json);
            serde_json::to_value(settings.default_phase_config).map_err(|e| e.to_string())?
        }
    };

    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();

        let payload = json!({
            "plan_id": plan_id,
            "title": title,
            "spec_markdown": spec_markdown,
            "phase_config": resolved_phase_config,
            "depends_on": depends_on,
        })
        .to_string();

        let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "task",
            &task_id,
            0,
            vec![NewEvent {
                event_type: "TaskCreated".into(),
                version: 4,
                payload,
            }],
            &make_metadata("user:local"),
        )
        .map_err(map_append_err)?;
        for ev in &outcome.events {
            apply_task_event(&tx, ev).map_err(|e| e.to_string())?;
            recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    emit_projection_updated(&app, Some(&workspace_id), "task", &task_id);
    emit_projection_updated(&app, Some(&workspace_id), "plan", &plan_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);

    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    projections::get_task(&aw.conn, &task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "task not found after insert".into())
}

#[tauri::command]
pub fn list_tasks(
    plan_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Vec<projections::TaskProjection>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    projections::list_tasks_in_plan(&aw.conn, &plan_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_task(
    id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Option<projections::TaskProjection>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    projections::get_task(&aw.conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_phase_runs(
    task_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Vec<projections::PhaseRunProjection>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    projections::list_phase_runs_for_task(&aw.conn, &task_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_phase_run_output(
    phase_run_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Vec<projections::PhaseRunOutputChunk>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    projections::list_phase_run_output(&aw.conn, &phase_run_id).map_err(|e| e.to_string())
}

// ======================================================================
// Provider commands
// ======================================================================

#[tauri::command]
pub fn list_providers(cache: State<'_, ProviderCache>) -> Result<Vec<ProviderStatus>, String> {
    Ok(cache.0.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
pub fn refresh_providers(cache: State<'_, ProviderCache>) -> Result<Vec<ProviderStatus>, String> {
    let detected = providers::detect_providers();
    let mut g = cache.0.lock().map_err(|e| e.to_string())?;
    *g = detected.clone();
    Ok(detected)
}

#[derive(Debug, Serialize)]
pub struct ProviderOptionsSchema {
    pub provider_id: String,
    pub schema: Vec<OptionDecl>,
    pub defaults: serde_json::Value,
}

#[tauri::command]
pub fn get_provider_options(provider_id: String) -> Result<ProviderOptionsSchema, String> {
    let p =
        providers::get(&provider_id).ok_or_else(|| format!("unknown provider: {}", provider_id))?;
    Ok(ProviderOptionsSchema {
        provider_id: p.id().to_string(),
        schema: p.options_schema(),
        defaults: p.default_options(),
    })
}

#[tauri::command]
pub fn list_models(provider_id: String) -> Result<Vec<KnownModel>, String> {
    let p =
        providers::get(&provider_id).ok_or_else(|| format!("unknown provider: {}", provider_id))?;
    Ok(p.known_models())
}

/// Permission modes the named provider supports for `phase`. Returned as snake-case
/// strings matching `PermissionMode::as_str` so the frontend can use them directly
/// as option values. Unknown providers fall back to the universal availability matrix.
#[tauri::command]
pub fn list_permission_modes(provider_id: String, phase: String) -> Result<Vec<String>, String> {
    let phase_typed =
        PhaseType::parse(&phase).ok_or_else(|| format!("invalid phase: {}", phase))?;
    Ok(
        providers::available_permission_modes(&provider_id, phase_typed)
            .into_iter()
            .map(|m| m.as_str().to_string())
            .collect(),
    )
}

// ======================================================================
// Phase commands
// ======================================================================

#[tauri::command]
pub async fn start_fake_phase(
    app: AppHandle,
    task_id: String,
    phase: String,
) -> Result<String, String> {
    let (workspace_id, workspace_path) = {
        let active_state = app.state::<ActiveWorkspaceState>();
        let guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_ref()
            .ok_or_else(|| "no active workspace".to_string())?;
        (aw.id.clone(), aw.path.clone())
    };

    let phase_run_id = format!("pr_{}", Ulid::new());
    let app_clone = app.clone();
    let phase_run_id_clone = phase_run_id.clone();

    tokio::spawn(async move {
        if let Err(e) = phases::fake::run(
            app_clone,
            workspace_id,
            workspace_path,
            task_id,
            phase,
            phase_run_id_clone,
        )
        .await
        {
            eprintln!("fake phase failed: {}", e);
        }
    });

    Ok(phase_run_id)
}

#[tauri::command]
pub async fn start_real_phase(
    app: AppHandle,
    task_id: String,
    phase: String,
    provider_id: Option<String>,
    options: Option<serde_json::Value>,
    is_retry: Option<bool>,
    retry_context: Option<String>,
    is_retry_of: Option<String>,
) -> Result<String, String> {
    let phase_typed = PhaseType::parse(&phase).ok_or_else(|| {
        format!(
            "only 'implementer', 'test_author', and 'auditor' phases are supported, got '{}'",
            phase
        )
    })?;

    let (workspace_id, workspace_path) = {
        let active_state = app.state::<ActiveWorkspaceState>();
        let guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_ref()
            .ok_or_else(|| "no active workspace".to_string())?;
        (aw.id.clone(), aw.path.clone())
    };

    let (spec_markdown, task_title, task_phase_config) = {
        let active_state = app.state::<ActiveWorkspaceState>();
        let mut guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        let task = projections::get_task(&aw.conn, &task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("task not found: {}", task_id))?;
        // Resolve from `current_phase_config` so user edits via
        // `TaskPhaseConfigChanged` take effect on the next run; the original
        // `phase_config` snapshot is preserved on the task for audit only.
        let cfg: PhaseConfig = serde_json::from_value(task.current_phase_config.clone())
            .unwrap_or_else(|_| PhaseConfig::bundled_default());
        (task.spec_markdown, task.title, cfg)
    };

    // Resolve provider/model/permission_mode from settings; caller-supplied options
    // win where present (e.g. the legacy run-real form lets the user pick ad-hoc).
    let workspace_settings = crate::pipeline::load_workspace_settings(&app, &workspace_id);
    let resolved = settings::resolve_phase_settings_with(
        &workspace_settings,
        &task_phase_config,
        phase_typed,
        |pid| providers::available_permission_modes(pid, phase_typed),
    );

    let caller_options = options.unwrap_or_else(|| json!({}));
    let provider_id = provider_id
        .or_else(|| resolved.provider.clone())
        .unwrap_or_else(|| "claude".to_string());
    let provider =
        providers::get(&provider_id).ok_or_else(|| format!("unknown provider: {}", provider_id))?;

    // Final permission_mode = caller override (if the chosen provider accepts it for
    // this phase) > resolved. Auditor clamp applies last so `bypassPermissions` can
    // never reach the runner.
    let provider_modes = providers::available_permission_modes(&provider_id, phase_typed);
    let permission_mode = caller_options
        .get("permission_mode")
        .and_then(|v| v.as_str())
        .and_then(PermissionMode::parse)
        .filter(|m| provider_modes.contains(m))
        .unwrap_or(resolved.permission_mode)
        .clamp_for(phase_typed);

    // Compose the options dict the provider sees. Defaults from the provider, then any
    // resolved values, then caller overrides. The permission_mode and model fields are
    // always written from the final resolved values so the provider sees consistent
    // state with what gets recorded on PhaseRunStarted.
    let mut options = merge_options(provider.default_options(), caller_options);
    if let Some(map) = options.as_object_mut() {
        map.insert(
            "permission_mode".into(),
            serde_json::Value::String(permission_mode.as_str().to_string()),
        );
        // Surface the phase to the provider so it can apply phase-specific safety
        // checks (e.g. claude's auditor downgrade). Distinct from the event's `phase`
        // — this one is a hint for the provider only.
        map.insert(
            "phase".into(),
            serde_json::Value::String(phase_typed.as_str().to_string()),
        );
        if !map.contains_key("model")
            || map.get("model") == Some(&serde_json::Value::String(String::new()))
        {
            if let Some(model) = &resolved.model {
                map.insert("model".into(), serde_json::Value::String(model.clone()));
            }
        }
    }

    // Resolve the binary path via the cached detection — refresh if the cached entry says
    // not-installed, in case the user just fixed it.
    let provider_path = {
        let cache = app.state::<ProviderCache>();
        let mut g = cache.0.lock().map_err(|e| e.to_string())?;
        let needs_refresh = g
            .iter()
            .find(|p| p.id == provider_id)
            .is_none_or(|p| !p.installed);
        if needs_refresh {
            *g = providers::detect_providers();
        }
        let entry = g
            .iter()
            .find(|p| p.id == provider_id)
            .ok_or_else(|| format!("provider '{}' not registered", provider_id))?;
        if !entry.installed {
            return Err(entry
                .error
                .clone()
                .unwrap_or_else(|| format!("provider '{}' not installed", provider_id)));
        }
        entry
            .path
            .clone()
            .ok_or_else(|| format!("provider '{}' has no path", provider_id))?
    };

    // Pull workspace reliability settings: timeouts and any user-defined env vars.
    // These are per-workspace so reading once at dispatch time is sufficient — a
    // running phase intentionally keeps the timeouts it started with even if the
    // user edits settings while it's executing.
    let settings = crate::pipeline::load_workspace_settings(&app, &workspace_id);
    let stream_options = StreamOptions {
        silence_timeout: Some(std::time::Duration::from_secs(
            settings.phase_timeouts.silence_timeout_seconds.max(1),
        )),
        wall_clock_timeout: Some(std::time::Duration::from_secs(
            settings.phase_timeouts.wall_clock_timeout_seconds.max(1),
        )),
    };
    let extra_env = settings.subprocess.additional_env.clone();

    let phase_run_id = format!("pr_{}", Ulid::new());
    let cancel = CancellationToken::new();

    let inflight = app.state::<InflightRuns>();
    inflight.register(&phase_run_id, cancel.clone());

    let app_clone = app.clone();
    let phase_run_id_clone = phase_run_id.clone();
    let tracker: Arc<ChildTracker> = app.state::<Arc<ChildTracker>>().inner().clone();

    let phase_for_dispatch = phase.clone();
    tokio::spawn(async move {
        let result = match phase_for_dispatch.as_str() {
            "test_author" => {
                let input = phases::test_author::TestAuthorInput {
                    workspace_id,
                    workspace_path,
                    task_id,
                    task_title,
                    phase_run_id: phase_run_id_clone.clone(),
                    spec_markdown,
                    provider,
                    provider_path,
                    options,
                    permission_mode,
                    cancel,
                    stream_options,
                    extra_env,
                };
                phases::test_author::run(app_clone.clone(), tracker, input).await
            }
            "auditor" => {
                let input = phases::auditor::AuditorInput {
                    workspace_id,
                    workspace_path,
                    task_id,
                    task_title,
                    phase_run_id: phase_run_id_clone.clone(),
                    spec_markdown,
                    provider,
                    provider_path,
                    options,
                    permission_mode,
                    cancel,
                    stream_options,
                    extra_env,
                };
                phases::auditor::run(app_clone.clone(), tracker, input).await
            }
            _ => {
                let input = phases::implementer::ImplementerInput {
                    workspace_id,
                    workspace_path,
                    task_id,
                    task_title,
                    phase: phase_for_dispatch,
                    phase_run_id: phase_run_id_clone.clone(),
                    spec_markdown,
                    provider,
                    provider_path,
                    options,
                    permission_mode,
                    cancel,
                    is_retry: is_retry.unwrap_or(false),
                    retry_context,
                    is_retry_of,
                    stream_options,
                    extra_env,
                };
                phases::implementer::run(app_clone.clone(), tracker, input).await
            }
        };
        if let Err(e) = result {
            eprintln!("real phase failed: {}", e);
        }
        let inflight = app_clone.state::<InflightRuns>();
        inflight.unregister(&phase_run_id_clone);
    });

    Ok(phase_run_id)
}

fn merge_options(
    mut defaults: serde_json::Value,
    overrides: serde_json::Value,
) -> serde_json::Value {
    if let (Some(d), Some(o)) = (defaults.as_object_mut(), overrides.as_object()) {
        for (k, v) in o {
            d.insert(k.clone(), v.clone());
        }
    }
    defaults
}

/// Pipeline entry point: start the first phase configured on this task,
/// or queue the task if it has unmet dependencies. Set `force_run` true
/// to bypass the dependency check (the toolbar's "Run anyway (ignore
/// dependencies)" overflow option).
#[tauri::command]
pub async fn start_task(
    app: AppHandle,
    task_id: String,
    force_run: Option<bool>,
) -> Result<crate::pipeline::StartTaskResult, String> {
    crate::pipeline::start_task(app, task_id, force_run.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())
}

/// Spawn a specific phase for a task using the task's resolved settings — used by
/// the toolbar's "Re-run auditor only" overflow action. Routes through the same
/// pipeline dispatcher as auto-progression so provider/model resolution stays
/// in one place.
#[tauri::command]
pub async fn start_task_phase(
    app: AppHandle,
    task_id: String,
    phase: String,
) -> Result<String, String> {
    let phase_typed = PhaseType::parse(&phase).ok_or_else(|| {
        format!(
            "only 'implementer', 'test_author', and 'auditor' phases are supported, got '{}'",
            phase
        )
    })?;
    crate::pipeline::dispatch_task_phase(app, task_id, phase_typed)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_phase_run(app: AppHandle, phase_run_id: String) -> Result<bool, String> {
    // `async` so `tokio::spawn` below has a runtime context — sync Tauri commands run
    // on the main thread without a reactor and panic on spawn.
    let inflight = app.state::<InflightRuns>();
    let fired = inflight.cancel(&phase_run_id);

    // Watchdog: if the runner doesn't emit a terminal event within the grace period,
    // force-fail the phase run so the projection (and the in-flight counter) recovers.
    // Covers the orphan cases the cancel token can't reach: subprocess that already
    // exited (so the token has nothing to kill), runner stuck in JSON parse / DB write
    // / retry path that doesn't poll the token, or `inflight.cancel` returning false
    // because the run was never registered. The append is seq-checked, so if the
    // runner *does* emit a terminal event first we lose the race and bail — that's
    // the desired behaviour.
    let app_clone = app.clone();
    let phase_run_id_clone = phase_run_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        if let Err(e) = force_fail_if_still_running(&app_clone, &phase_run_id_clone) {
            eprintln!(
                "cancel_phase_run watchdog: force-fail of {} failed: {}",
                phase_run_id_clone, e
            );
        }
    });

    Ok(fired)
}

/// If `phase_run_id` is still `running` in the projection, append a `PhaseRunFailed`
/// event with `error_kind = "user_cancelled"` so the in-flight counter releases. No-op
/// if the run already reached a terminal state — the runner beat us to it.
fn force_fail_if_still_running(app: &AppHandle, phase_run_id: &str) -> Result<(), String> {
    let (workspace_id, workspace_path) = {
        let active_state = app.state::<ActiveWorkspaceState>();
        let guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_ref()
            .ok_or_else(|| "no active workspace".to_string())?;
        (aw.id.clone(), aw.path.clone())
    };

    let mut conn = open_workspace_db(&workspace_path).map_err(|e| e.to_string())?;
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM phase_run_projection WHERE id = ?1",
            params![phase_run_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if status.as_deref() != Some("running") {
        return Ok(());
    }

    let seq = phases::runtime::current_seq(&conn, "phase_run", phase_run_id)?;
    let payload = json!({
        "error_kind": "user_cancelled",
        "error_message": "Cancelled by user (force-failed by watchdog after the cancel signal didn't produce a terminal event)",
    })
    .to_string();
    phases::runtime::append_phase_run_step(
        &mut conn,
        app,
        &workspace_id,
        phase_run_id,
        seq,
        NewEvent {
            event_type: "PhaseRunFailed".into(),
            version: 1,
            payload,
        },
        &make_metadata("user:cancel_watchdog"),
    )?;
    Ok(())
}

/// Retry worktree initialization for a task that previously failed init. Re-runs
/// the init command (detected or user-configured) and emits the matching event.
/// Does NOT auto-start the next phase — the user explicitly clicks "Start" or a
/// retry once init succeeds, so the failure→retry→start path stays under their
/// control.
#[tauri::command]
pub async fn retry_worktree_init(app: AppHandle, task_id: String) -> Result<(), String> {
    let (workspace_id, workspace_path) = {
        let active_state = app.state::<ActiveWorkspaceState>();
        let guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_ref()
            .ok_or_else(|| "no active workspace".to_string())?;
        (aw.id.clone(), aw.path.clone())
    };

    // Reset the projection's status so `ensure_initialized` actually re-runs (it
    // short-circuits on `initialized`, but for `failed` we want to retry, which
    // is the *not-yet-initialized* path — clear the row to NULL).
    {
        let active_state = app.state::<ActiveWorkspaceState>();
        let mut guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        aw.conn
            .execute(
                "UPDATE task_projection SET worktree_init_status = NULL WHERE id = ?1",
                params![task_id],
            )
            .map_err(|e| e.to_string())?;
    }
    emit_projection_updated(&app, Some(&workspace_id), "task", &task_id);

    let tracker: Arc<ChildTracker> = app.state::<Arc<ChildTracker>>().inner().clone();
    let cancel = CancellationToken::new();
    match crate::worktree_init::ensure_initialized(
        &app,
        &workspace_id,
        &workspace_path,
        &task_id,
        tracker,
        cancel,
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(crate::worktree_init::EnsureInitError::Failed) => {
            // The failure event was already emitted; surface a friendly error to
            // the UI so the toast can say "init failed again, see output".
            Err("worktree initialization failed".into())
        }
        Err(crate::worktree_init::EnsureInitError::NoWorktree) => {
            Err("task has no worktree to initialize".into())
        }
        Err(crate::worktree_init::EnsureInitError::Internal(e)) => Err(e),
    }
}

/// Skip worktree initialization for a task: emits a `WorktreeInitialized` event
/// with `detection_kind = "user_skipped"` so future starts treat init as done.
/// Used when the user has resolved the underlying setup themselves and wants to
/// proceed despite the prior failure.
#[tauri::command]
pub fn skip_worktree_init(app: AppHandle, task_id: String) -> Result<(), String> {
    let (workspace_id, workspace_path) = {
        let active_state = app.state::<ActiveWorkspaceState>();
        let guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_ref()
            .ok_or_else(|| "no active workspace".to_string())?;
        (aw.id.clone(), aw.path.clone())
    };
    crate::worktree_init::mark_skipped(&app, &workspace_id, &workspace_path, &task_id)?;
    Ok(())
}

// ======================================================================
// Worktree commands
// ======================================================================

// ----------------------------------------------------------------------
// Merge commands (analyze / execute)
// ----------------------------------------------------------------------

/// Errors surfaced to the UI for the analyze/execute task-merge commands. Variants are
/// serialized as `{ kind, details }` so the frontend can pattern-match on `kind` and
/// render specific guidance per error mode (dirty tree, detached HEAD, etc.).
#[derive(Debug, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "details")]
pub enum MergeCommandError {
    #[error("no active workspace")]
    NoActiveWorkspace,
    #[error("task not found")]
    TaskNotFound,
    #[error("task has no worktree branch recorded")]
    NoWorktreeBranch,
    #[error("invalid merge strategy: {0}")]
    InvalidStrategy(String),
    #[error("main worktree is in detached-HEAD state")]
    DetachedHead,
    #[error("main worktree has uncommitted changes")]
    WorkingTreeDirty { dirty_files: Vec<String> },
    #[error("source branch missing: {0}")]
    SourceBranchMissing(String),
    #[error("target branch missing: {0}")]
    TargetBranchMissing(String),
    #[error("conflicts prevent merge")]
    Conflicts { conflicts: Vec<String> },
    #[error("source already merged into target at {commit_sha}")]
    AlreadyMerged {
        commit_sha: String,
        target_branch: String,
    },
    #[error("git error: {0}")]
    GitError(String),
    #[error("internal error: {0}")]
    InternalError(String),
}

impl From<crate::merge::MergeError> for MergeCommandError {
    fn from(e: crate::merge::MergeError) -> Self {
        use crate::merge::MergeError;
        match e {
            MergeError::DetachedHead => Self::DetachedHead,
            MergeError::WorkingTreeDirty { dirty_files } => Self::WorkingTreeDirty { dirty_files },
            MergeError::SourceBranchMissing(b) => Self::SourceBranchMissing(b),
            MergeError::TargetBranchMissing(b) => Self::TargetBranchMissing(b),
            MergeError::Conflicts { conflicts } => Self::Conflicts { conflicts },
            MergeError::AlreadyMerged { commit_sha } => Self::AlreadyMerged {
                commit_sha,
                target_branch: String::new(),
            },
            MergeError::GitError(s) => Self::GitError(s),
            MergeError::InternalError(s) => Self::InternalError(s),
        }
    }
}

fn lookup_task_workspace_and_branch(
    aw: &ActiveWorkspace,
    task_id: &str,
) -> Result<(String, String, String), MergeCommandError> {
    let task = projections::get_task(&aw.conn, task_id)
        .map_err(|e| MergeCommandError::InternalError(e.to_string()))?
        .ok_or(MergeCommandError::TaskNotFound)?;
    let branch = task
        .worktree_branch
        .ok_or(MergeCommandError::NoWorktreeBranch)?;
    Ok((aw.id.clone(), aw.path.clone(), branch))
}

/// Read-side: inspect what a merge would do. Side effects:
/// - If the analysis surfaces conflicts, append `TaskMergeAttempted` so the audit trail
///   records the failed attempt (and so the UI can show it inline near the Merge button
///   later).
/// - If the source is already an ancestor of the target, append `TaskMerged` with the
///   existing target SHA and synthetic strategy `"squash"` — the merge result already
///   exists, so the "right" thing for the projection is to mark the task merged rather
///   than ask the user to do it again.
#[tauri::command]
pub fn analyze_task_merge(
    app: AppHandle,
    task_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<crate::merge::MergeAnalysis, MergeCommandError> {
    let (workspace_id, workspace_path, source_branch) = {
        let mut guard = active.0.lock().map_err(|_| {
            MergeCommandError::InternalError("active workspace mutex poisoned".into())
        })?;
        let aw = guard.as_mut().ok_or(MergeCommandError::NoActiveWorkspace)?;
        lookup_task_workspace_and_branch(aw, &task_id)?
    };

    let analysis =
        crate::merge::analyze_merge(std::path::Path::new(&workspace_path), &source_branch)?;

    if analysis.already_merged {
        // Materialise the merge as a TaskMerged event so the projection reflects reality.
        // Strategy is synthetic — squash is the closest semantic fit.
        let payload = json!({
            "commit_sha": analysis.target_head_sha,
            "merge_strategy": "squash",
            "target_branch": analysis.target_branch,
            "source_branch": analysis.source_branch,
            "parent_commits": analysis
                .source_commits
                .iter()
                .map(|c| c.sha.clone())
                .collect::<Vec<_>>(),
        });
        let _ = append_task_event_simple(&app, &workspace_id, &task_id, "TaskMerged", payload);
        // Cleanup the worktree just like a real merge would.
        let _ = cleanup_task_worktree(
            &app,
            &workspace_id,
            &workspace_path,
            &task_id,
            "task_merged",
        );
        maybe_complete_plan(&app, &workspace_id, &task_id);
    } else if !analysis.conflicts.is_empty() {
        let payload = json!({
            "target_branch": analysis.target_branch,
            "source_branch": analysis.source_branch,
            "conflicts": analysis.conflicts,
            "target_head_sha": analysis.target_head_sha,
        });
        let _ =
            append_task_event_simple(&app, &workspace_id, &task_id, "TaskMergeAttempted", payload);
    }

    Ok(analysis)
}

#[tauri::command]
pub fn execute_task_merge(
    app: AppHandle,
    task_id: String,
    strategy: String,
    commit_message: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<crate::merge::ExecutedMerge, MergeCommandError> {
    let (workspace_id, workspace_path, source_branch) = {
        let mut guard = active.0.lock().map_err(|_| {
            MergeCommandError::InternalError("active workspace mutex poisoned".into())
        })?;
        let aw = guard.as_mut().ok_or(MergeCommandError::NoActiveWorkspace)?;
        lookup_task_workspace_and_branch(aw, &task_id)?
    };

    let result = match strategy.as_str() {
        "squash" => crate::merge::execute_squash_merge(
            std::path::Path::new(&workspace_path),
            &source_branch,
            &commit_message,
        )?,
        "merge" => crate::merge::execute_merge_commit(
            std::path::Path::new(&workspace_path),
            &source_branch,
            &commit_message,
        )?,
        other => return Err(MergeCommandError::InvalidStrategy(other.to_string())),
    };

    let payload = json!({
        "commit_sha": result.commit_sha,
        "merge_strategy": strategy,
        "target_branch": result.target_branch,
        "source_branch": result.source_branch,
        "parent_commits": result.parent_commits,
    });
    append_task_event_simple(&app, &workspace_id, &task_id, "TaskMerged", payload)
        .map_err(MergeCommandError::InternalError)?;

    // Existing wiring: cleanup the worktree (force=true since we just merged its branch
    // into the target — the worktree files are now redundant), then check plan completion.
    let _ = cleanup_task_worktree(
        &app,
        &workspace_id,
        &workspace_path,
        &task_id,
        "task_merged",
    );
    maybe_complete_plan(&app, &workspace_id, &task_id);

    Ok(result)
}

/// Append a single event to a task aggregate, applying its projection in the same
/// transaction and emitting `projection_updated`. Caller-friendly helper for the merge
/// commands above; on failure returns a String the caller wraps in
/// [`MergeCommandError::InternalError`].
fn append_task_event_simple(
    app: &AppHandle,
    workspace_id: &str,
    task_id: &str,
    event_type: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let active = app.state::<ActiveWorkspaceState>();
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        let seq = current_task_seq(&aw.conn, task_id)?;
        let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "task",
            task_id,
            seq,
            vec![NewEvent {
                event_type: event_type.into(),
                version: if event_type == "TaskMerged" { 2 } else { 1 },
                payload: payload.to_string(),
            }],
            &make_metadata("user:local"),
        )
        .map_err(map_append_err)?;
        for ev in &outcome.events {
            apply_task_event(&tx, ev).map_err(|e| e.to_string())?;
            recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    emit_projection_updated(app, Some(workspace_id), "task", task_id);
    emit_projection_updated(app, Some(workspace_id), "recent_events", workspace_id);
    // Queue manager hook (Brief 4): a merge may unblock dependents.
    // Spawn outside the transaction lock — best-effort, failures logged.
    // Use Tauri's runtime-agnostic spawner: this helper is invoked from sync
    // `#[tauri::command]` functions whose thread has no Tokio reactor in
    // scope, so a bare `tokio::spawn` panics with "there is no reactor
    // running" and aborts the process. `async_runtime::spawn` finds the
    // global Tauri runtime and dispatches there.
    if event_type == "TaskMerged" {
        let app_clone = app.clone();
        let ws = workspace_id.to_string();
        let tid = task_id.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::pipeline::on_task_merged(app_clone, ws, tid).await {
                eprintln!("pipeline::on_task_merged failed: {}", e);
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn get_latest_merge_attempt_for_task(
    task_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Option<projections::TaskMergeAttempt>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    projections::latest_merge_attempt_for_task(&aw.conn, &task_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_task_merged(
    app: AppHandle,
    task_id: String,
    commit_sha: Option<String>,
    merge_strategy: Option<String>,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    // Stub for the merge trigger. Real merge logic comes in a later phase; for now this
    // command lets us exercise the WorktreeRemoved-on-merge cleanup path from the UI.
    let workspace_id;
    let workspace_path;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();
        workspace_path = aw.path.clone();

        let payload = json!({
            "commit_sha": commit_sha.unwrap_or_else(|| "<stub>".into()),
            "merge_strategy": merge_strategy.unwrap_or_else(|| "squash".into()),
        })
        .to_string();
        let seq = current_task_seq(&aw.conn, &task_id)?;
        let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "task",
            &task_id,
            seq,
            vec![NewEvent {
                event_type: "TaskMerged".into(),
                version: 1,
                payload,
            }],
            &make_metadata("user:local"),
        )
        .map_err(map_append_err)?;
        for ev in &outcome.events {
            apply_task_event(&tx, ev).map_err(|e| e.to_string())?;
            recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    emit_projection_updated(&app, Some(&workspace_id), "task", &task_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);

    cleanup_task_worktree(
        &app,
        &workspace_id,
        &workspace_path,
        &task_id,
        "task_merged",
    )?;
    maybe_complete_plan(&app, &workspace_id, &task_id);
    // Queue manager hook (Brief 4) — dependents may now be unblocked.
    // `mark_task_merged` is a sync `#[tauri::command]`, so we must use
    // `tauri::async_runtime::spawn` rather than `tokio::spawn` (the calling
    // thread has no Tokio reactor; a bare `tokio::spawn` aborts the process).
    {
        let app_clone = app.clone();
        let ws = workspace_id.clone();
        let tid = task_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::pipeline::on_task_merged(app_clone, ws, tid).await {
                eprintln!("pipeline::on_task_merged failed: {}", e);
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_task(
    app: AppHandle,
    task_id: String,
    reason: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    let workspace_id;
    let workspace_path;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();
        workspace_path = aw.path.clone();

        let payload = json!({ "reason": reason }).to_string();
        let seq = current_task_seq(&aw.conn, &task_id)?;
        let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "task",
            &task_id,
            seq,
            vec![NewEvent {
                event_type: "TaskCancelled".into(),
                version: 1,
                payload,
            }],
            &make_metadata("user:local"),
        )
        .map_err(map_append_err)?;
        for ev in &outcome.events {
            apply_task_event(&tx, ev).map_err(|e| e.to_string())?;
            recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    emit_projection_updated(&app, Some(&workspace_id), "task", &task_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);

    cleanup_task_worktree(
        &app,
        &workspace_id,
        &workspace_path,
        &task_id,
        "task_cancelled",
    )?;
    maybe_complete_plan(&app, &workspace_id, &task_id);
    Ok(())
}

#[tauri::command]
pub async fn pass_back_to_implementer(
    app: AppHandle,
    task_id: String,
    user_feedback: Option<String>,
) -> Result<String, String> {
    let (retry_context, prior_implementer_run_id) = {
        let active = app.state::<ActiveWorkspaceState>();
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        let verdicts = projections::list_auditor_verdicts_for_task(&aw.conn, &task_id)
            .map_err(|e| e.to_string())?;
        let latest = verdicts
            .into_iter()
            .next()
            .ok_or_else(|| "no auditor verdict for task".to_string())?;
        let runs =
            projections::list_phase_runs_for_task(&aw.conn, &task_id).map_err(|e| e.to_string())?;
        let prior = runs
            .iter()
            .rev()
            .find(|r| r.phase == "implementer")
            .map(|r| r.id.clone());
        let trimmed_feedback = user_feedback
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let payload = json!({
            "auditor_summary": latest.summary,
            "auditor_concerns": latest.concerns,
            "user_feedback": trimmed_feedback,
        })
        .to_string();
        (payload, prior)
    };

    start_real_phase(
        app,
        task_id,
        "implementer".to_string(),
        None,
        None,
        Some(true),
        Some(retry_context),
        prior_implementer_run_id,
    )
    .await
}

#[tauri::command]
pub fn reject_task(
    app: AppHandle,
    task_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    cancel_task(app, task_id, "auditor_rejected".to_string(), active)
}

#[tauri::command]
pub fn approve_task_anyway(
    app: AppHandle,
    task_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    let workspace_id;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();

        let payload = json!({ "by": "user:local" }).to_string();
        let seq = current_task_seq(&aw.conn, &task_id)?;
        let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "task",
            &task_id,
            seq,
            vec![NewEvent {
                event_type: "TaskApproved".into(),
                version: 1,
                payload,
            }],
            &make_metadata("user:local"),
        )
        .map_err(map_append_err)?;
        for ev in &outcome.events {
            apply_task_event(&tx, ev).map_err(|e| e.to_string())?;
            recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    emit_projection_updated(&app, Some(&workspace_id), "task", &task_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);
    Ok(())
}

// ======================================================================
// Task dependencies (Brief 4)
// ======================================================================

/// Replace a task's `depends_on` list. The new list is validated for cycles
/// and same-plan membership before any event lands; on failure we surface
/// the typed `DependencyError` JSON-encoded as the error string so the UI
/// can pattern-match on `kind` for inline messaging (e.g. "this would
/// create a cycle" vs "task X is in a different plan").
#[tauri::command]
pub fn update_task_dependencies(
    app: AppHandle,
    task_id: String,
    depends_on: Vec<String>,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<projections::TaskProjection, String> {
    let workspace_id;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();

        let task = projections::get_task(&aw.conn, &task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("task not found: {}", task_id))?;
        if matches!(task.status.as_str(), "merged" | "archived") {
            // Editing deps on a terminal task is meaningless and would put
            // the projection in an inconsistent state.
            return Err(format!(
                "cannot edit dependencies on a {} task",
                task.status
            ));
        }
        crate::dependencies::validate_dependencies(&aw.conn, &task_id, &task.plan_id, &depends_on)
            .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))?;

        let payload = json!({ "depends_on": depends_on }).to_string();
        let seq = current_task_seq(&aw.conn, &task_id)?;
        let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "task",
            &task_id,
            seq,
            vec![NewEvent {
                event_type: "TaskDependenciesChanged".into(),
                version: 1,
                payload,
            }],
            &make_metadata("user:local"),
        )
        .map_err(map_append_err)?;
        for ev in &outcome.events {
            apply_task_event(&tx, ev).map_err(|e| e.to_string())?;
            recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    emit_projection_updated(&app, Some(&workspace_id), "task", &task_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);

    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    projections::get_task(&aw.conn, &task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("task not found after update: {}", task_id))
}

/// Cancel a queued task's queued state. The task remains blocked (until
/// its dependencies resolve), but the queue manager will not auto-start
/// it — the user explicitly opted out. To re-queue, click Run again.
#[tauri::command]
pub fn unqueue_task(
    app: AppHandle,
    task_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<projections::TaskProjection, String> {
    let workspace_id;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();
        let task = projections::get_task(&aw.conn, &task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("task not found: {}", task_id))?;
        if !task.is_queued {
            // Idempotent: nothing to do. Don't error — the UI may have
            // raced with the queue manager auto-starting the task, in
            // which case the click is harmless.
            return Ok(task);
        }
        let seq = current_task_seq(&aw.conn, &task_id)?;
        let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "task",
            &task_id,
            seq,
            vec![NewEvent {
                event_type: "TaskUnqueued".into(),
                version: 1,
                payload: json!({}).to_string(),
            }],
            &make_metadata("user:local"),
        )
        .map_err(map_append_err)?;
        for ev in &outcome.events {
            apply_task_event(&tx, ev).map_err(|e| e.to_string())?;
            recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    emit_projection_updated(&app, Some(&workspace_id), "task", &task_id);
    emit_projection_updated(&app, Some(&workspace_id), "recent_events", &workspace_id);

    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    projections::get_task(&aw.conn, &task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("task not found: {}", task_id))
}

/// File-overlap detection for the pre-start warning dialog (Brief 4 M8).
/// Returns the in-flight tasks whose `relevant_files` intersect with the
/// given task's. Empty vec means no overlap. The frontend caches a
/// suppression set per `(starting, other)` ordered pair within the
/// session — see the dialog component.
#[tauri::command]
pub fn detect_task_file_overlap(
    task_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Vec<crate::dependencies::FileOverlap>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    let workspace_id = aw.id.clone();
    crate::dependencies::detect_file_overlap(&aw.conn, &task_id, &workspace_id)
        .map_err(|e| e.to_string())
}

// ======================================================================
// Per-task phase config editing
// ======================================================================

/// Set provider/model/permission_mode for one phase of one task. The change is
/// recorded as a `TaskPhaseConfigChanged` event; the projection's
/// `current_phase_config` reflects the new value, and the next phase run resolves
/// against it. The original `TaskCreated.phase_config` snapshot is preserved.
///
/// Editing is rejected while any phase of the task is currently running — the UI
/// disables the affordance, but we guard server-side too.
#[tauri::command]
pub fn update_task_phase_config(
    app: AppHandle,
    task_id: String,
    phase: String,
    provider: String,
    model: String,
    permission_mode: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<projections::TaskProjection, String> {
    // Phase + permission mode validation up front — defence-in-depth against the UI
    // calling with a forbidden combination.
    let phase_typed =
        PhaseType::parse(&phase).ok_or_else(|| format!("invalid phase: {}", phase))?;
    let mode_typed = PermissionMode::parse(&permission_mode)
        .ok_or_else(|| format!("invalid permission_mode: {}", permission_mode))?;
    if provider.trim().is_empty() {
        return Err("provider must not be empty".into());
    }
    // Ask the chosen provider whether it accepts this mode for this phase. Falls back
    // to the universal `is_available_for` matrix when the provider isn't registered
    // (defence-in-depth — the UI shouldn't pick an unknown provider).
    let allowed = providers::available_permission_modes(&provider, phase_typed);
    if !allowed.contains(&mode_typed) {
        return Err(format!(
            "permission mode '{}' is not allowed for phase '{}' on provider '{}'",
            permission_mode, phase, provider
        ));
    }
    if model.trim().is_empty() {
        return Err("model must not be empty".into());
    }

    let payload = json!({
        "phase": phase,
        "provider": provider,
        "model": model,
        "permission_mode": permission_mode,
    });
    apply_task_phase_config_change(&app, &active, &task_id, payload)
}

/// Revert one phase of one task back to the workspace default — emits a
/// `TaskPhaseConfigChanged` with `provider`, `model`, and `permission_mode` all
/// `null`, which the applier interprets as "remove this phase's per-phase entries
/// from `current_phase_config`."
#[tauri::command]
pub fn reset_task_phase_config(
    app: AppHandle,
    task_id: String,
    phase: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<projections::TaskProjection, String> {
    if PhaseType::parse(&phase).is_none() {
        return Err(format!("invalid phase: {}", phase));
    }
    let payload = json!({
        "phase": phase,
        "provider": serde_json::Value::Null,
        "model": serde_json::Value::Null,
        "permission_mode": serde_json::Value::Null,
    });
    apply_task_phase_config_change(&app, &active, &task_id, payload)
}

/// Shared body for `update_task_phase_config` and `reset_task_phase_config`. Both
/// emit the same event type with different payload shapes; gating, append, and
/// projection refresh logic is identical.
fn apply_task_phase_config_change(
    app: &AppHandle,
    active: &State<'_, ActiveWorkspaceState>,
    task_id: &str,
    payload: serde_json::Value,
) -> Result<projections::TaskProjection, String> {
    let workspace_id;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();

        // Task existence check — surfaces a clearer error than letting the seq lookup
        // succeed with 0 (which would happily append an event for a missing task).
        let task_exists: bool = aw
            .conn
            .query_row(
                "SELECT 1 FROM task_projection WHERE id = ?1",
                params![task_id],
                |_| Ok(true),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(false);
        if !task_exists {
            return Err(format!("task not found: {}", task_id));
        }

        // Defence-in-depth: refuse to mutate config while a phase is mid-flight. The
        // UI disables the edit button in this state, but a stale tab or a direct
        // command call could still slip through.
        let running: i64 = aw
            .conn
            .query_row(
                "SELECT COUNT(*) FROM phase_run_projection
                 WHERE task_id = ?1 AND status = 'running'",
                params![task_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if running > 0 {
            return Err(
                "phase_running: cannot edit phase config while a phase of this task is running"
                    .into(),
            );
        }

        let seq = current_task_seq(&aw.conn, task_id)?;
        let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
        let outcome = append_events_in_tx(
            &tx,
            "task",
            task_id,
            seq,
            vec![NewEvent {
                event_type: "TaskPhaseConfigChanged".into(),
                version: 1,
                payload: payload.to_string(),
            }],
            &make_metadata("user:local"),
        )
        .map_err(map_append_err)?;
        for ev in &outcome.events {
            apply_task_event(&tx, ev).map_err(|e| e.to_string())?;
            recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    emit_projection_updated(app, Some(&workspace_id), "task", task_id);
    emit_projection_updated(app, Some(&workspace_id), "recent_events", &workspace_id);

    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    projections::get_task(&aw.conn, task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("task not found after update: {}", task_id))
}

#[tauri::command]
pub fn open_in_editor(
    task_id: String,
    path: String,
    line: u32,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    let worktree_path = {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        let task = projections::get_task(&aw.conn, &task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("task not found: {}", task_id))?;
        task.worktree_path
            .ok_or_else(|| "task has no worktree".to_string())?
    };
    let abs = std::path::PathBuf::from(&worktree_path).join(&path);
    Command::new("code")
        .arg("--goto")
        .arg(format!("{}:{}", abs.to_string_lossy(), line))
        .spawn()
        .map_err(|e| format!("failed to launch editor: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn get_latest_auditor_verdict_for_task(
    task_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Option<projections::AuditorVerdictProjection>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    let verdicts = projections::list_auditor_verdicts_for_task(&aw.conn, &task_id)
        .map_err(|e| e.to_string())?;
    Ok(verdicts.into_iter().next())
}

#[tauri::command]
pub fn delete_worktree(
    app: AppHandle,
    task_id: String,
    force: bool,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    let workspace_id;
    let workspace_path;
    let task;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();
        workspace_path = aw.path.clone();
        task = projections::get_task(&aw.conn, &task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("task not found: {}", task_id))?;
    }

    let path_str = task
        .worktree_path
        .clone()
        .ok_or_else(|| "task has no worktree".to_string())?;
    if task.worktree_status.as_deref() != Some("active") {
        return Err("task worktree is not active".into());
    }
    let path = std::path::PathBuf::from(&path_str);

    if !force {
        // Surface a typed error so the UI can prompt the user. Use git2 to check status.
        if path.exists() {
            if let Ok(status) = crate::worktree::worktree_status(&path) {
                if status.has_uncommitted_changes {
                    return Err(
                        "worktree has uncommitted changes; pass force=true to delete".into(),
                    );
                }
            }
        }
    }

    perform_worktree_removal(
        &app,
        &workspace_id,
        &workspace_path,
        &task_id,
        &path,
        force,
        "manual",
    );
    Ok(())
}

fn current_task_seq(conn: &rusqlite::Connection, task_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM events WHERE aggregate_type = 'task' AND aggregate_id = ?1",
        params![task_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Best-effort cleanup of a task's worktree triggered by merge/cancel. Reads the task's
/// projection, removes the worktree if active, and appends WorktreeRemoved (or
/// WorktreeRemovalFailed) on the task aggregate. Failures are non-fatal — the caller has
/// already committed its own state-changing event.
fn cleanup_task_worktree(
    app: &AppHandle,
    workspace_id: &str,
    workspace_path: &str,
    task_id: &str,
    reason: &str,
) -> Result<(), String> {
    let active = app.state::<ActiveWorkspaceState>();
    let task = {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        match projections::get_task(&aw.conn, task_id).map_err(|e| e.to_string())? {
            Some(t) => t,
            None => return Ok(()),
        }
    };
    if task.worktree_status.as_deref() != Some("active") {
        return Ok(());
    }
    let path_str = match task.worktree_path {
        Some(p) => p,
        None => return Ok(()),
    };
    perform_worktree_removal(
        app,
        workspace_id,
        workspace_path,
        task_id,
        &std::path::PathBuf::from(&path_str),
        true,
        reason,
    );
    Ok(())
}

/// Run the on-disk worktree removal and append the corresponding event on the task
/// aggregate. Always force-removes since the caller has already gated on dirty status.
fn perform_worktree_removal(
    app: &AppHandle,
    workspace_id: &str,
    workspace_path: &str,
    task_id: &str,
    worktree_path: &std::path::Path,
    force: bool,
    reason: &str,
) {
    let result = crate::worktree::remove_worktree(
        std::path::Path::new(workspace_path),
        worktree_path,
        force,
    );

    let active = app.state::<ActiveWorkspaceState>();
    let mut guard = match active.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let aw = match guard.as_mut() {
        Some(aw) => aw,
        None => return,
    };

    let seq = match current_task_seq(&aw.conn, task_id) {
        Ok(s) => s,
        Err(_) => return,
    };

    let (event_type, payload) = match &result {
        Ok(_) => (
            "WorktreeRemoved",
            json!({
                "worktree_path": worktree_path.to_string_lossy(),
                "reason": reason,
            })
            .to_string(),
        ),
        Err(e) => (
            "WorktreeRemovalFailed",
            json!({
                "worktree_path": worktree_path.to_string_lossy(),
                "error": e.to_string(),
                "reason": reason,
            })
            .to_string(),
        ),
    };

    let tx = match aw.conn.transaction() {
        Ok(t) => t,
        Err(_) => return,
    };
    let outcome = append_events_in_tx(
        &tx,
        "task",
        task_id,
        seq,
        vec![NewEvent {
            event_type: event_type.into(),
            version: 1,
            payload,
        }],
        &make_metadata("system:worktree_cleanup"),
    );
    let outcome = match outcome {
        Ok(o) => o,
        Err(_) => return,
    };
    for ev in &outcome.events {
        let _ = apply_task_event(&tx, ev);
        let _ = recent_events::record_event(&tx, ev);
    }
    let _ = tx.commit();

    drop(guard);

    emit_projection_updated(app, Some(workspace_id), "task", task_id);
    emit_projection_updated(app, Some(workspace_id), "recent_events", workspace_id);
}

// ======================================================================
// Prompt commands
// ======================================================================

#[derive(Debug, Serialize)]
pub struct ResolvedPrompt {
    pub phase: String,
    pub content: String,
    pub is_customised: bool,
}

fn parse_phase_arg(phase: &str) -> Result<crate::settings::PhaseType, String> {
    crate::settings::PhaseType::parse(phase).ok_or_else(|| format!("unknown phase: {}", phase))
}

#[tauri::command]
pub fn get_prompt(
    phase: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<ResolvedPrompt, String> {
    let phase_t = parse_phase_arg(&phase)?;
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    let workspace_path = std::path::PathBuf::from(&aw.path);
    let content = crate::prompts::resolve(&workspace_path, phase_t).map_err(|e| e.to_string())?;
    let is_customised = crate::prompts::is_customised(&workspace_path, phase_t);
    Ok(ResolvedPrompt {
        phase: phase_t.as_str().to_string(),
        content,
        is_customised,
    })
}

#[tauri::command]
pub fn save_prompt(
    phase: String,
    content: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    let phase_t = parse_phase_arg(&phase)?;
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    let workspace_path = std::path::PathBuf::from(&aw.path);
    crate::prompts::save(&workspace_path, phase_t, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reset_prompt(phase: String, active: State<'_, ActiveWorkspaceState>) -> Result<(), String> {
    let phase_t = parse_phase_arg(&phase)?;
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    let workspace_path = std::path::PathBuf::from(&aw.path);
    crate::prompts::reset(&workspace_path, phase_t).map_err(|e| e.to_string())
}

// ======================================================================
// Recent events
// ======================================================================

#[tauri::command]
pub fn list_recent_events(
    limit: Option<i64>,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Vec<RecentEventRow>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    recent_events::list_recent(&aw.conn, limit).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct EventDetail {
    pub id: String,
    pub aggregate_type: String,
    pub aggregate_id: String,
    pub seq: i64,
    pub event_type: String,
    pub version: i64,
    pub payload: String,
    pub metadata: String,
    pub created_at: i64,
}

#[tauri::command]
pub fn get_event_by_id(
    event_id: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Option<EventDetail>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    aw.conn
        .query_row(
            "SELECT id, aggregate_type, aggregate_id, seq, event_type, version, payload, metadata, created_at
             FROM events WHERE id = ?1",
            rusqlite::params![event_id],
            |r| {
                Ok(EventDetail {
                    id: r.get(0)?,
                    aggregate_type: r.get(1)?,
                    aggregate_id: r.get(2)?,
                    seq: r.get(3)?,
                    event_type: r.get(4)?,
                    version: r.get(5)?,
                    payload: r.get(6)?,
                    metadata: r.get(7)?,
                    created_at: r.get(8)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
}

// ======================================================================
// rebuild_projections
// ======================================================================

#[derive(Debug, Serialize)]
pub struct RebuildSummary {
    pub events_replayed: i64,
    pub projections_rebuilt: Vec<String>,
}

#[tauri::command]
pub fn rebuild_projections(
    app: AppHandle,
    aggregate_type: Option<String>,
    global: State<'_, GlobalDb>,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<RebuildSummary, String> {
    let mut events_replayed = 0i64;
    let mut rebuilt = Vec::new();

    let do_workspace = aggregate_type.as_deref().is_none_or(|t| t == "workspace");
    let do_plan = aggregate_type.as_deref().is_none_or(|t| t == "plan");
    let do_task = aggregate_type.as_deref().is_none_or(|t| t == "task");
    let do_phase_run = aggregate_type.as_deref().is_none_or(|t| t == "phase_run");
    let do_briefing = aggregate_type.as_deref().is_none_or(|t| t == "briefing");

    // --- Workspace (global db) ---
    if do_workspace {
        let mut conn = global.0.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch("DROP TABLE IF EXISTS workspace_projection;")
            .map_err(|e| e.to_string())?;
        tx.execute_batch(crate::events::projections::WORKSPACE_PROJECTION_DDL)
            .map_err(|e| e.to_string())?;
        let count = replay_into(
            &tx,
            "workspace",
            apply_workspace_event_wrapper,
            &mut events_replayed,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        rebuilt.push(format!("workspace ({} events)", count));
    }

    // --- Per-workspace projections ---
    if do_plan || do_task || do_phase_run || do_briefing {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        if let Some(aw) = guard.as_mut() {
            let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch(
                "DROP TABLE IF EXISTS phase_run_gate;
                 DROP TABLE IF EXISTS phase_run_tool_call;
                 DROP TABLE IF EXISTS phase_run_output;
                 DROP TABLE IF EXISTS phase_run_projection;
                 DROP TABLE IF EXISTS auditor_verdict_projection;
                 DROP TABLE IF EXISTS task_merge_attempt_projection;
                 DROP TABLE IF EXISTS task_projection;
                 DROP TABLE IF EXISTS plan_projection;
                 DROP TABLE IF EXISTS briefing_projection;
                 DROP TABLE IF EXISTS recent_events;",
            )
            .map_err(|e| e.to_string())?;
            // Use the full setup (DDL + additive ALTER migrations + backfills) — the
            // raw DDL alone misses columns added in later migrations like
            // `worktree_init_status`, which the applier then crashes against.
            crate::events::projections::apply_workspace_db_projection_ddl(&tx)
                .map_err(|e| e.to_string())?;
            tx.execute_batch(crate::recent_events::RECENT_EVENTS_DDL)
                .map_err(|e| e.to_string())?;
            // Re-populate recent_events from the per-workspace event log. Don't double-count
            // these against events_replayed — the plan/task/phase_run replays below already do.
            let mut sink = 0i64;
            replay_into(
                &tx,
                "plan",
                |tx, ev| crate::recent_events::record_event(tx, ev).map_err(|e| e.into()),
                &mut sink,
            )?;
            replay_into(
                &tx,
                "task",
                |tx, ev| crate::recent_events::record_event(tx, ev).map_err(|e| e.into()),
                &mut sink,
            )?;
            replay_into(
                &tx,
                "phase_run",
                |tx, ev| crate::recent_events::record_event(tx, ev).map_err(|e| e.into()),
                &mut sink,
            )?;
            replay_into(
                &tx,
                "briefing",
                |tx, ev| crate::recent_events::record_event(tx, ev).map_err(|e| e.into()),
                &mut sink,
            )?;
            rebuilt.push("recent_events".into());

            if do_plan {
                let count =
                    replay_into(&tx, "plan", apply_plan_event_wrapper, &mut events_replayed)?;
                rebuilt.push(format!("plan ({} events)", count));
            }
            if do_task {
                let count =
                    replay_into(&tx, "task", apply_task_event_wrapper, &mut events_replayed)?;
                rebuilt.push(format!("task ({} events)", count));
            }
            if do_phase_run {
                let count = replay_into(
                    &tx,
                    "phase_run",
                    apply_phase_run_event_wrapper,
                    &mut events_replayed,
                )?;
                rebuilt.push(format!("phase_run ({} events)", count));
            }
            if do_briefing {
                let count = replay_into(
                    &tx,
                    "briefing",
                    apply_briefing_event_wrapper,
                    &mut events_replayed,
                )?;
                rebuilt.push(format!("briefing ({} events)", count));
            }

            tx.commit().map_err(|e| e.to_string())?;
        } else if aggregate_type
            .as_deref()
            .is_some_and(|t| t == "task" || t == "phase_run" || t == "briefing")
        {
            return Err("no active workspace; cannot rebuild task/phase_run projections".into());
        }
    }

    // Best-effort cache nudge — invalidate everything.
    let _ = app.emit(
        PROJECTION_UPDATED_EVENT,
        ProjectionUpdated {
            workspace_id: None,
            aggregate_type: "workspace".into(),
            aggregate_id: "*".into(),
        },
    );

    Ok(RebuildSummary {
        events_replayed,
        projections_rebuilt: rebuilt,
    })
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;
    use crate::events::projections::apply_workspace_db_projection_ddl;
    use crate::events::schema::apply_events_ddl;
    use rusqlite::Connection;

    fn make_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        apply_events_ddl(&conn).unwrap();
        apply_workspace_db_projection_ddl(&conn).unwrap();
        conn
    }

    fn insert_plan(conn: &Connection, id: &str, status: &str) {
        conn.execute(
            "INSERT INTO plan_projection
                (id, workspace_id, title, description, source, source_metadata, status,
                 task_count, running_task_count, done_task_count, failed_task_count,
                 created_at, updated_at)
             VALUES (?1, 'ws', 'p', '', 'manual', NULL, ?2, 0, 0, 0, 0, 0, 0)",
            params![id, status],
        )
        .unwrap();
    }

    fn insert_task(conn: &Connection, id: &str, plan_id: &str, status: &str) {
        conn.execute(
            "INSERT INTO task_projection
                (id, workspace_id, plan_id, title, spec_markdown, status, created_at, updated_at)
             VALUES (?1, 'ws', ?2, 't', '', ?3, 0, 0)",
            params![id, plan_id, status],
        )
        .unwrap();
    }

    fn set_task_status(conn: &Connection, id: &str, status: &str) {
        conn.execute(
            "UPDATE task_projection SET status = ?1 WHERE id = ?2",
            params![status, id],
        )
        .unwrap();
    }

    #[test]
    fn not_eligible_while_tasks_non_terminal() {
        let conn = make_db();
        insert_plan(&conn, "plan_1", "active");
        insert_task(&conn, "task_a", "plan_1", "created");
        insert_task(&conn, "task_b", "plan_1", "merged");
        insert_task(&conn, "task_c", "plan_1", "merged");
        assert_eq!(plan_completion_eligible(&conn, "task_c").unwrap(), None);
    }

    #[test]
    fn eligible_when_last_task_terminates() {
        let conn = make_db();
        insert_plan(&conn, "plan_1", "active");
        insert_task(&conn, "task_a", "plan_1", "merged");
        insert_task(&conn, "task_b", "plan_1", "cancelled");
        insert_task(&conn, "task_c", "plan_1", "created");
        assert_eq!(plan_completion_eligible(&conn, "task_c").unwrap(), None);
        set_task_status(&conn, "task_c", "merged");
        assert_eq!(
            plan_completion_eligible(&conn, "task_c").unwrap(),
            Some("plan_1".to_string())
        );
    }

    #[test]
    fn not_eligible_when_plan_already_terminal() {
        let conn = make_db();
        insert_plan(&conn, "plan_1", "completed");
        insert_task(&conn, "task_a", "plan_1", "merged");
        assert_eq!(plan_completion_eligible(&conn, "task_a").unwrap(), None);

        insert_plan(&conn, "plan_2", "cancelled");
        insert_task(&conn, "task_b", "plan_2", "merged");
        assert_eq!(plan_completion_eligible(&conn, "task_b").unwrap(), None);

        insert_plan(&conn, "plan_3", "archived");
        insert_task(&conn, "task_c", "plan_3", "merged");
        assert_eq!(plan_completion_eligible(&conn, "task_c").unwrap(), None);
    }

    #[test]
    fn eligible_when_plan_paused() {
        // Paused plans still get auto-completed — pausing means "no new work suggested",
        // not "freeze terminal-state transitions".
        let conn = make_db();
        insert_plan(&conn, "plan_1", "paused");
        insert_task(&conn, "task_a", "plan_1", "merged");
        assert_eq!(
            plan_completion_eligible(&conn, "task_a").unwrap(),
            Some("plan_1".to_string())
        );
    }

    #[test]
    fn missing_task_returns_none() {
        let conn = make_db();
        assert_eq!(plan_completion_eligible(&conn, "nope").unwrap(), None);
    }
}

type ApplyFn = fn(
    &rusqlite::Transaction,
    &crate::events::types::AppendedEvent,
) -> Result<(), projections::ProjectionError>;

fn apply_workspace_event_wrapper(
    tx: &rusqlite::Transaction,
    ev: &crate::events::types::AppendedEvent,
) -> Result<(), projections::ProjectionError> {
    apply_workspace_event(tx, ev)
}
fn apply_plan_event_wrapper(
    tx: &rusqlite::Transaction,
    ev: &crate::events::types::AppendedEvent,
) -> Result<(), projections::ProjectionError> {
    apply_plan_event(tx, ev)
}
fn apply_task_event_wrapper(
    tx: &rusqlite::Transaction,
    ev: &crate::events::types::AppendedEvent,
) -> Result<(), projections::ProjectionError> {
    apply_task_event(tx, ev)
}
fn apply_phase_run_event_wrapper(
    tx: &rusqlite::Transaction,
    ev: &crate::events::types::AppendedEvent,
) -> Result<(), projections::ProjectionError> {
    apply_phase_run_event(tx, ev)
}
fn apply_briefing_event_wrapper(
    tx: &rusqlite::Transaction,
    ev: &crate::events::types::AppendedEvent,
) -> Result<(), projections::ProjectionError> {
    apply_briefing_event(tx, ev)
}

fn replay_into(
    tx: &rusqlite::Transaction,
    aggregate_type: &str,
    apply: ApplyFn,
    events_replayed: &mut i64,
) -> Result<i64, String> {
    let mut stmt = tx
        .prepare(
            "SELECT id, aggregate_type, aggregate_id, seq, event_type, version, payload, metadata, created_at
             FROM events
             WHERE aggregate_type = ?1
             ORDER BY aggregate_id ASC, seq ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![aggregate_type], |r| {
            Ok(crate::events::types::AppendedEvent {
                id: r.get(0)?,
                aggregate_type: r.get(1)?,
                aggregate_id: r.get(2)?,
                seq: r.get(3)?,
                event_type: r.get(4)?,
                version: r.get(5)?,
                payload: r.get(6)?,
                metadata: r.get(7)?,
                created_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut count = 0i64;
    for r in rows {
        let ev = r.map_err(|e| e.to_string())?;
        apply(tx, &ev).map_err(|e| e.to_string())?;
        count += 1;
        *events_replayed += 1;
    }
    Ok(count)
}
