//! Shared runtime helpers for phase runners: tracking in-flight runs (so they can be
//! cancelled), and the per-step append-and-emit dance.

use std::collections::HashMap;
use std::sync::Mutex;

/// Merge workspace `additional_env` into a base env (typically the provider's
/// invocation env). User-supplied overrides win — they are the most-specific intent
/// for this workspace.
pub fn merge_extra_env(
    mut base: HashMap<String, String>,
    extra: &HashMap<String, String>,
) -> HashMap<String, String> {
    for (k, v) in extra {
        base.insert(k.clone(), v.clone());
    }
    base
}

use rusqlite::Connection;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use crate::commands::{ProjectionUpdated, PROJECTION_UPDATED_EVENT};
use crate::events::projections::{apply_phase_run_event, apply_task_event};
use crate::events::types::{EventMetadata, NewEvent};
use crate::events::{append::append_events_in_tx, AppendError};

pub struct PhaseRunHandle {
    pub cancel: CancellationToken,
}

pub struct InflightRuns(pub Mutex<HashMap<String, PhaseRunHandle>>);

impl InflightRuns {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    pub fn register(&self, phase_run_id: &str, cancel: CancellationToken) {
        if let Ok(mut g) = self.0.lock() {
            g.insert(phase_run_id.to_string(), PhaseRunHandle { cancel });
        }
    }

    pub fn unregister(&self, phase_run_id: &str) {
        if let Ok(mut g) = self.0.lock() {
            g.remove(phase_run_id);
        }
    }

    pub fn cancel(&self, phase_run_id: &str) -> bool {
        let g = match self.0.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        match g.get(phase_run_id) {
            Some(h) => {
                h.cancel.cancel();
                true
            }
            None => false,
        }
    }
}

pub fn emit_projection_updated(
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

/// Append one phase_run event in its own transaction, run the projection applier, commit,
/// then emit `projection_updated`. Returns the new latest seq for the aggregate.
pub fn append_phase_run_step(
    conn: &mut Connection,
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
    let mut fire_on_completed = false;
    let mut fire_on_auditor_verdict = false;
    // PhaseRunStarted/Completed/Failed mutate `plan_projection.running_task_count`
    // cross-aggregate; without a `plan` projection_updated emit, the frontend's plans
    // query goes stale and the status-bar in-flight counter sticks at the old value.
    let mut affects_plan_counter = false;
    for ev in &outcome.events {
        apply_phase_run_event(&tx, ev).map_err(|e| e.to_string())?;
        // Mirror into the recent_events strip projection.
        crate::recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        top_seq = ev.seq;
        if ev.event_type == "PhaseRunStarted" {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&ev.payload) {
                if let Some(tid) = v.get("task_id").and_then(|x| x.as_str()) {
                    affected_task = Some(tid.to_string());
                }
            }
            affects_plan_counter = true;
        }
        if ev.event_type == "PhaseRunCompleted" {
            fire_on_completed = true;
            affects_plan_counter = true;
        }
        if ev.event_type == "PhaseRunFailed" {
            affects_plan_counter = true;
        }
        if ev.event_type == "AuditorVerdictRendered" {
            fire_on_auditor_verdict = true;
            // Surface the verdict to task-scoped queries (the verdict projection is
            // task-keyed even though the event lives on the phase_run aggregate).
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&ev.payload) {
                if let Some(tid) = v.get("task_id").and_then(|x| x.as_str()) {
                    affected_task = Some(tid.to_string());
                }
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    emit_projection_updated(app, Some(workspace_id), "phase_run", phase_run_id);
    emit_projection_updated(app, Some(workspace_id), "recent_events", workspace_id);
    if let Some(tid) = affected_task {
        emit_projection_updated(app, Some(workspace_id), "task", &tid);
    }
    // Cross-aggregate plan counter changed — invalidate the plan list/detail so the
    // status-bar in-flight count and per-plan running badge reflect reality.
    if affects_plan_counter {
        let plan_id: Option<String> = conn
            .query_row(
                "SELECT t.plan_id FROM task_projection t
                 JOIN phase_run_projection pr ON pr.task_id = t.id
                 WHERE pr.id = ?1",
                rusqlite::params![phase_run_id],
                |r| r.get(0),
            )
            .ok();
        if let Some(pid) = plan_id {
            emit_projection_updated(app, Some(workspace_id), "plan", &pid);
        }
    }

    // Pipeline orchestrator hooks. Best-effort: spawned on the tokio runtime so the
    // sync caller (a phase runner) doesn't block on gates / next-phase dispatch. Errors
    // are logged; the user can recover via the UI if auto-progression stalls.
    if fire_on_completed {
        let app_clone = app.clone();
        let ws = workspace_id.to_string();
        let pr = phase_run_id.to_string();
        tokio::spawn(async move {
            if let Err(e) = crate::pipeline::on_phase_completed(app_clone, ws, pr).await {
                eprintln!("pipeline::on_phase_completed failed: {}", e);
            }
        });
    }
    if fire_on_auditor_verdict {
        let app_clone = app.clone();
        let ws = workspace_id.to_string();
        let pr = phase_run_id.to_string();
        tokio::spawn(async move {
            if let Err(e) = crate::pipeline::on_auditor_verdict(app_clone, ws, pr).await {
                eprintln!("pipeline::on_auditor_verdict failed: {}", e);
            }
        });
    }
    Ok(top_seq)
}

fn map_append_err(e: AppendError) -> String {
    e.to_string()
}

/// Append one task event in its own transaction, run the projection applier, commit, then
/// emit `projection_updated`. Returns the new latest seq for the task aggregate.
pub fn append_task_step(
    conn: &mut Connection,
    app: &AppHandle,
    workspace_id: &str,
    task_id: &str,
    expected_seq: i64,
    new_event: NewEvent,
    metadata: &EventMetadata,
) -> Result<i64, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let outcome = append_events_in_tx(
        &tx,
        "task",
        task_id,
        expected_seq,
        vec![new_event],
        metadata,
    )
    .map_err(map_append_err)?;

    let mut top_seq = expected_seq;
    let mut fire_on_task_merged = false;
    for ev in &outcome.events {
        apply_task_event(&tx, ev).map_err(|e| e.to_string())?;
        crate::recent_events::record_event(&tx, ev).map_err(|e| e.to_string())?;
        top_seq = ev.seq;
        if ev.event_type == "TaskMerged" {
            fire_on_task_merged = true;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    emit_projection_updated(app, Some(workspace_id), "task", task_id);
    emit_projection_updated(app, Some(workspace_id), "recent_events", workspace_id);

    // Queue manager hook: fires after the merge transaction commits so
    // any TaskUnblocked events (and downstream auto-start dispatches) land
    // as their own events. Best-effort — failures are logged but never
    // propagate, so a queue-manager bug can't strand the merge.
    if fire_on_task_merged {
        let app_clone = app.clone();
        let ws = workspace_id.to_string();
        let tid = task_id.to_string();
        tokio::spawn(async move {
            if let Err(e) = crate::pipeline::on_task_merged(app_clone, ws, tid).await {
                eprintln!("pipeline::on_task_merged failed: {}", e);
            }
        });
    }
    Ok(top_seq)
}

/// Look up the current seq for an aggregate (0 if no events yet).
pub fn current_seq(
    conn: &Connection,
    aggregate_type: &str,
    aggregate_id: &str,
) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM events WHERE aggregate_type = ?1 AND aggregate_id = ?2",
        rusqlite::params![aggregate_type, aggregate_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
