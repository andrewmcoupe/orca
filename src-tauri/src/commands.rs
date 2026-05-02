use std::process::Command;
use std::sync::Arc;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;
use ulid::Ulid;

use crate::events::projections::{
    self, apply_phase_run_event, apply_plan_event, apply_task_event, apply_workspace_event,
};
use crate::events::types::{EventMetadata, NewEvent};
use crate::events::{append::append_events_in_tx, AppendError};
use crate::phases::{self, InflightRuns};
use crate::providers::{self, OptionDecl, ProviderCache, ProviderStatus};
use crate::recent_events::{self, RecentEventRow};
use crate::subprocess::ChildTracker;
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
    EventMetadata {
        command_id: new_command_id(),
        actor: actor.to_string(),
        correlation_id: None,
        causation_id: None,
    }
}

fn emit_projection_updated(
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

    Ok(ActiveWorkspaceInfo { id: ws.id, path: ws.path })
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
    let dir = std::path::Path::new(workspace_path).join(".orca").join("worktrees");
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
    for r in rows {
        if let Ok(id) = r {
            active_task_ids.insert(id);
        }
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
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
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
        append_plan_event(aw, &plan_id, "PlanPaused", json!({ "reason": reason }), "user:local")?;
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

#[tauri::command]
pub fn cancel_plan(
    app: AppHandle,
    plan_id: String,
    reason: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<(), String> {
    let workspace_id;
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();
        append_plan_event(aw, &plan_id, "PlanCancelled", json!({ "reason": reason }), "user:local")?;
    }
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
    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();
        append_plan_event(aw, &plan_id, "PlanArchived", json!({}), "user:local")?;
    }
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
    guard.as_mut().ok_or_else(|| "no active workspace".to_string())
}

#[tauri::command]
pub fn create_task(
    app: AppHandle,
    plan_id: String,
    title: String,
    spec_markdown: String,
    active: State<'_, ActiveWorkspaceState>,
) -> Result<projections::TaskProjection, String> {
    let task_id = format!("task_{}", Ulid::new());
    let workspace_id;

    {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        workspace_id = aw.id.clone();

        let payload = json!({
            "plan_id": plan_id,
            "title": title,
            "spec_markdown": spec_markdown,
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
                version: 2,
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
    let p = providers::get(&provider_id)
        .ok_or_else(|| format!("unknown provider: {}", provider_id))?;
    Ok(ProviderOptionsSchema {
        provider_id: p.id().to_string(),
        schema: p.options_schema(),
        defaults: p.default_options(),
    })
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
) -> Result<String, String> {
    if phase != "implementer" {
        return Err(format!("only 'implementer' phase is supported, got '{}'", phase));
    }

    let provider_id = provider_id.unwrap_or_else(|| "claude".to_string());
    let provider = providers::get(&provider_id)
        .ok_or_else(|| format!("unknown provider: {}", provider_id))?;

    // Merge user-supplied options over defaults so missing keys still get sensible values.
    let options = merge_options(provider.default_options(), options.unwrap_or(json!({})));

    let (workspace_id, workspace_path) = {
        let active_state = app.state::<ActiveWorkspaceState>();
        let guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = guard
            .as_ref()
            .ok_or_else(|| "no active workspace".to_string())?;
        (aw.id.clone(), aw.path.clone())
    };

    let (spec_markdown, task_title) = {
        let active_state = app.state::<ActiveWorkspaceState>();
        let mut guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        let task = projections::get_task(&aw.conn, &task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("task not found: {}", task_id))?;
        (task.spec_markdown, task.title)
    };

    // Resolve the binary path via the cached detection — refresh if the cached entry says
    // not-installed, in case the user just fixed it.
    let provider_path = {
        let cache = app.state::<ProviderCache>();
        let mut g = cache.0.lock().map_err(|e| e.to_string())?;
        let needs_refresh = g
            .iter()
            .find(|p| p.id == provider_id)
            .map_or(true, |p| !p.installed);
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

    let phase_run_id = format!("pr_{}", Ulid::new());
    let cancel = CancellationToken::new();

    let inflight = app.state::<InflightRuns>();
    inflight.register(&phase_run_id, cancel.clone());

    let app_clone = app.clone();
    let phase_run_id_clone = phase_run_id.clone();
    let tracker: Arc<ChildTracker> = app.state::<Arc<ChildTracker>>().inner().clone();

    tokio::spawn(async move {
        let input = phases::implementer::ImplementerInput {
            workspace_id,
            workspace_path,
            task_id,
            task_title,
            phase,
            phase_run_id: phase_run_id_clone.clone(),
            spec_markdown,
            provider,
            provider_path,
            options,
            cancel,
        };
        if let Err(e) = phases::implementer::run(app_clone.clone(), tracker, input).await {
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

#[tauri::command]
pub fn cancel_phase_run(
    phase_run_id: String,
    inflight: State<'_, InflightRuns>,
) -> Result<bool, String> {
    Ok(inflight.cancel(&phase_run_id))
}

// ======================================================================
// Worktree commands
// ======================================================================

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

    cleanup_task_worktree(&app, &workspace_id, &workspace_path, &task_id, "task_merged")?;
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

    cleanup_task_worktree(&app, &workspace_id, &workspace_path, &task_id, "task_cancelled")?;
    Ok(())
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
                    return Err("worktree has uncommitted changes; pass force=true to delete".into());
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

    let do_workspace = aggregate_type.as_deref().map_or(true, |t| t == "workspace");
    let do_plan = aggregate_type.as_deref().map_or(true, |t| t == "plan");
    let do_task = aggregate_type.as_deref().map_or(true, |t| t == "task");
    let do_phase_run = aggregate_type.as_deref().map_or(true, |t| t == "phase_run");

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
    if do_plan || do_task || do_phase_run {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        if let Some(aw) = guard.as_mut() {
            let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch(
                "DROP TABLE IF EXISTS phase_run_gate;
                 DROP TABLE IF EXISTS phase_run_tool_call;
                 DROP TABLE IF EXISTS phase_run_output;
                 DROP TABLE IF EXISTS phase_run_projection;
                 DROP TABLE IF EXISTS task_projection;
                 DROP TABLE IF EXISTS plan_projection;
                 DROP TABLE IF EXISTS recent_events;",
            )
            .map_err(|e| e.to_string())?;
            tx.execute_batch(crate::events::projections::TASK_PROJECTION_DDL)
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

            tx.commit().map_err(|e| e.to_string())?;
        } else if aggregate_type.as_deref().map_or(false, |t| t == "task" || t == "phase_run") {
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

type ApplyFn = fn(&rusqlite::Transaction, &crate::events::types::AppendedEvent) -> Result<(), projections::ProjectionError>;

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

