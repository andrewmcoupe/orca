use std::process::Command;
use std::sync::Arc;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;
use ulid::Ulid;

use crate::events::projections::{
    self, apply_phase_run_event, apply_task_event, apply_workspace_event,
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
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(ActiveWorkspace {
        id: ws.id.clone(),
        path: ws.path.clone(),
        conn,
    });

    Ok(ActiveWorkspaceInfo { id: ws.id, path: ws.path })
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
            "workspace_id": aw.id,
            "title": title,
            "spec_markdown": spec_markdown,
            "source": "manual",
            "prd_id": null,
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
        .ok_or_else(|| "task not found after insert".into())
}

#[tauri::command]
pub fn list_tasks(
    active: State<'_, ActiveWorkspaceState>,
) -> Result<Vec<projections::TaskProjection>, String> {
    let mut guard = active.0.lock().map_err(|e| e.to_string())?;
    let aw = require_active_workspace(&mut guard)?;
    let workspace_id = aw.id.clone();
    projections::list_tasks(&aw.conn, &workspace_id).map_err(|e| e.to_string())
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

    let spec_markdown = {
        let active_state = app.state::<ActiveWorkspaceState>();
        let mut guard = active_state.0.lock().map_err(|e| e.to_string())?;
        let aw = require_active_workspace(&mut guard)?;
        projections::get_task(&aw.conn, &task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("task not found: {}", task_id))?
            .spec_markdown
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
    if do_task || do_phase_run {
        let mut guard = active.0.lock().map_err(|e| e.to_string())?;
        if let Some(aw) = guard.as_mut() {
            let tx = aw.conn.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch(
                "DROP TABLE IF EXISTS phase_run_gate;
                 DROP TABLE IF EXISTS phase_run_tool_call;
                 DROP TABLE IF EXISTS phase_run_output;
                 DROP TABLE IF EXISTS phase_run_projection;
                 DROP TABLE IF EXISTS task_projection;
                 DROP TABLE IF EXISTS recent_events;",
            )
            .map_err(|e| e.to_string())?;
            tx.execute_batch(crate::events::projections::TASK_PROJECTION_DDL)
                .map_err(|e| e.to_string())?;
            tx.execute_batch(crate::recent_events::RECENT_EVENTS_DDL)
                .map_err(|e| e.to_string())?;
            // Re-populate recent_events from the per-workspace event log. Don't double-count
            // these against events_replayed — the task/phase_run replays below already do.
            let mut sink = 0i64;
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

