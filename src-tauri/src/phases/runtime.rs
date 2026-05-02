//! Shared runtime helpers for phase runners: tracking in-flight runs (so they can be
//! cancelled), and the per-step append-and-emit dance.

use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use crate::commands::{ProjectionUpdated, PROJECTION_UPDATED_EVENT};
use crate::events::projections::apply_phase_run_event;
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
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    emit_projection_updated(app, Some(workspace_id), "phase_run", phase_run_id);
    emit_projection_updated(app, Some(workspace_id), "recent_events", workspace_id);
    if let Some(tid) = affected_task {
        emit_projection_updated(app, Some(workspace_id), "task", &tid);
    }
    Ok(top_seq)
}

fn map_append_err(e: AppendError) -> String {
    e.to_string()
}

pub fn started_payload(
    task_id: &str,
    phase: &str,
    provider: &str,
    model: &str,
    prompt_template_id: &str,
    worktree_path: &str,
) -> String {
    json!({
        "task_id": task_id,
        "phase": phase,
        "provider": provider,
        "model": model,
        "prompt_template_id": prompt_template_id,
        "worktree_path": worktree_path,
    })
    .to_string()
}
