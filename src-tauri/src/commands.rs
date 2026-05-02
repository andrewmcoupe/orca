use std::process::Command;
use std::time::Duration;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use ulid::Ulid;

use crate::events::projections::{
    self, apply_phase_run_event, apply_task_event, apply_workspace_event,
};
use crate::events::types::{EventMetadata, NewEvent};
use crate::events::{append::append_events_in_tx, AppendError};
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

const PROJECTION_UPDATED_EVENT: &str = "projection_updated";

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
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    emit_projection_updated(&app, Some(&workspace_id), "task", &task_id);

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
// Fake phase flow
// ======================================================================

/// Append a single phase_run event in its own transaction, apply the projection, and emit.
/// Returns the new seq.
fn append_phase_run_step(
    conn: &mut rusqlite::Connection,
    app: &AppHandle,
    workspace_id: &str,
    phase_run_id: &str,
    expected_seq: i64,
    new_event: NewEvent,
    metadata: &EventMetadata,
) -> Result<i64, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let outcome = append_events_in_tx(
        &tx,
        "phase_run",
        phase_run_id,
        expected_seq,
        vec![new_event],
        metadata,
    )
    .map_err(map_append_err)?;

    let mut top_seq = expected_seq;
    let mut affected_task: Option<String> = None;
    for ev in &outcome.events {
        apply_phase_run_event(&tx, ev).map_err(|e| e.to_string())?;
        top_seq = ev.seq;
        // Sniff task_id for the start event so we can also emit a task projection_updated.
        if ev.event_type == "PhaseRunStarted" {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&ev.payload) {
                if let Some(tid) = v.get("task_id").and_then(|x| x.as_str()) {
                    affected_task = Some(tid.to_string());
                }
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    emit_projection_updated(app, Some(workspace_id), "phase_run", phase_run_id);
    if let Some(tid) = affected_task {
        emit_projection_updated(app, Some(workspace_id), "task", &tid);
    }
    Ok(top_seq)
}

#[tauri::command]
pub async fn start_fake_phase(
    app: AppHandle,
    task_id: String,
    phase: String,
) -> Result<String, String> {
    // Capture the workspace this run is bound to. The fake phase will own its own
    // connection to that workspace's events.sqlite for its full duration, so switching
    // the active workspace mid-run doesn't redirect writes or kill the task.
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
        if let Err(e) = run_fake_phase(
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

async fn run_fake_phase(
    app: AppHandle,
    workspace_id: String,
    workspace_path: String,
    task_id: String,
    phase: String,
    phase_run_id: String,
) -> Result<(), String> {
    let mut conn = open_workspace_db(&workspace_path).map_err(|e| e.to_string())?;

    // Started
    {
        let payload = json!({
            "task_id": task_id,
            "phase": phase,
            "provider": "claude_code",
            "model": "claude-sonnet-4-5",
            "prompt_template_id": "fake.v1",
            "worktree_path": format!("{}/.orca/worktrees/{}", workspace_path, phase_run_id),
        })
        .to_string();
        append_phase_run_step(
            &mut conn,
            &app,
            &workspace_id,
            &phase_run_id,
            0,
            NewEvent {
                event_type: "PhaseRunStarted".into(),
                version: 1,
                payload,
            },
            &make_metadata("system:fake_runner"),
        )?;
    }

    // 5 chunks
    let mut seq = 1i64;
    for i in 1..=5 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let chunk = format!("fake chunk {}/5 for {}\n", i, phase_run_id);
        let payload = json!({ "chunk": chunk, "chunk_seq": i }).to_string();
        seq = append_phase_run_step(
            &mut conn,
            &app,
            &workspace_id,
            &phase_run_id,
            seq,
            NewEvent {
                event_type: "PhaseRunOutputAppended".into(),
                version: 1,
                payload,
            },
            &make_metadata("system:fake_runner"),
        )?;
    }

    // Completed
    {
        let payload = json!({
            "exit_code": 0,
            "summary": "fake phase completed",
            "files_changed": [],
            "token_usage": { "input": 1234, "output": 567 }
        })
        .to_string();
        append_phase_run_step(
            &mut conn,
            &app,
            &workspace_id,
            &phase_run_id,
            seq,
            NewEvent {
                event_type: "PhaseRunCompleted".into(),
                version: 1,
                payload,
            },
            &make_metadata("system:fake_runner"),
        )?;
    }

    Ok(())
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
                 DROP TABLE IF EXISTS task_projection;",
            )
            .map_err(|e| e.to_string())?;
            tx.execute_batch(crate::events::projections::TASK_PROJECTION_DDL)
                .map_err(|e| e.to_string())?;

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

