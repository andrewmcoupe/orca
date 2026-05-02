//! Pipeline orchestrator: decides what runs after each phase, runs gates between
//! phases, and gates progression on the auditor verdict.
//!
//! Wired up from `runtime::append_phase_run_step`: when a `PhaseRunCompleted` or
//! `AuditorVerdictRendered` event lands, the runtime fires the matching hook on a
//! background tokio task. Errors are logged but never propagated — the pipeline is
//! best-effort, and the user can always intervene via the UI.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use serde_json::json;
use tauri::{AppHandle, Manager};
use thiserror::Error;
use ulid::Ulid;

use crate::events::projections;
use crate::events::types::{EventMetadata, NewEvent};
use crate::gates::{self, GateResult};
use crate::phases::runtime::{append_phase_run_step, current_seq};
use crate::settings::{PhaseConfig, PhaseType, WorkspaceSettings};
use crate::subprocess::ChildTracker;
use crate::workspace_db::open_workspace_db;
use crate::{ActiveWorkspaceState, GlobalDb};

#[derive(Debug, Error)]
pub enum PipelineError {
    #[error("task not found: {0}")]
    TaskNotFound(String),
    #[error("no active workspace")]
    NoActiveWorkspace,
    #[error("phase config has no phases")]
    EmptyPhaseConfig,
    #[error("dispatch failed: {0}")]
    Dispatch(String),
    #[error("internal: {0}")]
    Internal(String),
}

fn make_metadata(actor: &str) -> EventMetadata {
    EventMetadata {
        command_id: Ulid::new().to_string(),
        actor: actor.to_string(),
        correlation_id: None,
        causation_id: None,
    }
}

/// Pure decision: given a task's phase config and the phase that just completed, return
/// the phase that should run next. Returns `None` if the completed phase is the last in
/// the configured list (or not found at all — defensive).
pub fn decide_next_phase(
    config: &PhaseConfig,
    completed_phase: PhaseType,
) -> Option<PhaseType> {
    let idx = config.phases.iter().position(|p| *p == completed_phase)?;
    config.phases.get(idx + 1).copied()
}

/// Pure helper: which gates run after `phase` for this task. Per-task `gate_overrides`
/// (when present and containing an entry for the phase) wins over the workspace's
/// `phase_gates`. Returns the resolved `(name, command, timeout_seconds)` tuples; gate
/// names referenced but absent from `settings.gates` are silently skipped (the user
/// can fix and re-run).
pub fn gates_for_phase(
    settings: &WorkspaceSettings,
    task_phase_config: &PhaseConfig,
    phase: PhaseType,
) -> Vec<(String, String, u64)> {
    let phase_name = phase.as_str().to_string();
    let names: Vec<String> = match &task_phase_config.gate_overrides {
        Some(overrides) => match overrides.get(&phase_name) {
            Some(list) => list.clone(),
            None => settings
                .phase_gates
                .get(&phase_name)
                .cloned()
                .unwrap_or_default(),
        },
        None => settings
            .phase_gates
            .get(&phase_name)
            .cloned()
            .unwrap_or_default(),
    };
    let mut out = Vec::new();
    for name in names {
        if let Some(g) = settings.gates.get(&name) {
            out.push((name, g.command.clone(), g.timeout_seconds));
        }
    }
    out
}

/// Read the workspace settings JSON for a workspace from the global db, parsing
/// tolerantly into `WorkspaceSettings`.
fn load_workspace_settings(app: &AppHandle, workspace_id: &str) -> WorkspaceSettings {
    let global = match app.try_state::<GlobalDb>() {
        Some(g) => g,
        None => return WorkspaceSettings::default(),
    };
    let conn = match global.0.lock() {
        Ok(g) => g,
        Err(_) => return WorkspaceSettings::default(),
    };
    let json: String = conn
        .query_row(
            "SELECT settings_json FROM workspace_projection WHERE id = ?1",
            params![workspace_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "{}".to_string());
    WorkspaceSettings::from_json_str(&json)
}

/// Parse a task's stored `phase_config` JSON into the typed `PhaseConfig`. Falls back to
/// bundled default if parsing fails — old tasks without a config still progress sensibly.
fn parse_phase_config(value: &serde_json::Value) -> PhaseConfig {
    serde_json::from_value(value.clone()).unwrap_or_else(|_| PhaseConfig::bundled_default())
}

/// Public command: kicks off the first phase in a task's `phase_config`. If the task
/// already has phase runs, this still starts the first configured phase — useful for
/// retry-from-scratch flows. (For "continue from where we left off" behaviour, use the
/// per-phase `start_real_phase` directly.)
pub async fn start_task(app: AppHandle, task_id: String) -> Result<String, PipelineError> {
    let (phase_config_value, _workspace_id) = read_task_pipeline_state(&app, &task_id)?;
    let config = parse_phase_config(&phase_config_value);
    let first = config
        .phases
        .first()
        .copied()
        .ok_or(PipelineError::EmptyPhaseConfig)?;
    dispatch_phase(app, task_id, first, false, None).await
}

fn read_task_pipeline_state(
    app: &AppHandle,
    task_id: &str,
) -> Result<(serde_json::Value, String), PipelineError> {
    let active = app
        .try_state::<ActiveWorkspaceState>()
        .ok_or(PipelineError::NoActiveWorkspace)?;
    let mut guard = active
        .0
        .lock()
        .map_err(|e| PipelineError::Internal(e.to_string()))?;
    let aw = guard
        .as_mut()
        .ok_or(PipelineError::NoActiveWorkspace)?;
    let task = projections::get_task(&aw.conn, task_id)
        .map_err(|e| PipelineError::Internal(e.to_string()))?
        .ok_or_else(|| PipelineError::TaskNotFound(task_id.to_string()))?;
    Ok((task.phase_config, aw.id.clone()))
}

/// Spawn the next phase for a task. Defers to `commands::start_real_phase` so the
/// dispatcher logic (provider detection, options merge, inflight-run tracking) lives in
/// exactly one place.
async fn dispatch_phase(
    app: AppHandle,
    task_id: String,
    phase: PhaseType,
    is_retry: bool,
    retry_context: Option<String>,
) -> Result<String, PipelineError> {
    crate::commands::start_real_phase(
        app,
        task_id,
        phase.as_str().to_string(),
        None,
        None,
        Some(is_retry),
        retry_context,
        None,
    )
    .await
    .map_err(PipelineError::Dispatch)
}

/// Hook fired after a `PhaseRunCompleted` event commits. For non-auditor phases: run
/// configured gates and, on success, dispatch the next phase. For auditor: do nothing
/// here — the matching `AuditorVerdictRendered` handler progresses the pipeline.
pub async fn on_phase_completed(
    app: AppHandle,
    workspace_id: String,
    phase_run_id: String,
) -> Result<(), PipelineError> {
    // Identify which task / phase this run belongs to.
    let (task_id, phase_str) = {
        let active = app
            .try_state::<ActiveWorkspaceState>()
            .ok_or(PipelineError::NoActiveWorkspace)?;
        let mut guard = active
            .0
            .lock()
            .map_err(|e| PipelineError::Internal(e.to_string()))?;
        let aw = guard
            .as_mut()
            .ok_or(PipelineError::NoActiveWorkspace)?;
        let row: Option<(String, String)> = aw
            .conn
            .query_row(
                "SELECT task_id, phase FROM phase_run_projection WHERE id = ?1",
                params![phase_run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        match row {
            Some(v) => v,
            None => return Ok(()), // race: row not yet visible — let it go
        }
    };
    let phase = match PhaseType::parse(&phase_str) {
        Some(p) => p,
        None => return Ok(()),
    };

    if phase == PhaseType::Auditor {
        // Auditor progression is decided once the verdict event lands.
        return Ok(());
    }

    // Run gates configured for this phase. If any fail (or error), stop the pipeline.
    let all_passed = run_gates_for_phase(&app, &workspace_id, &task_id, &phase_run_id, phase).await?;
    if !all_passed {
        return Ok(());
    }

    // Identify the next phase from the task's phase_config and dispatch it.
    let (phase_config_value, _) = read_task_pipeline_state(&app, &task_id)?;
    let config = parse_phase_config(&phase_config_value);
    if let Some(next) = decide_next_phase(&config, phase) {
        if let Err(e) = dispatch_phase(app, task_id, next, false, None).await {
            eprintln!("pipeline: dispatch_phase({:?}) failed: {}", next, e);
        }
    }
    Ok(())
}

/// Hook fired after `AuditorVerdictRendered` commits. Runs gates configured for the
/// auditor phase, then stops — the user decides what to do based on the verdict.
pub async fn on_auditor_verdict(
    app: AppHandle,
    workspace_id: String,
    phase_run_id: String,
) -> Result<(), PipelineError> {
    let task_id = {
        let active = app
            .try_state::<ActiveWorkspaceState>()
            .ok_or(PipelineError::NoActiveWorkspace)?;
        let mut guard = active
            .0
            .lock()
            .map_err(|e| PipelineError::Internal(e.to_string()))?;
        let aw = guard
            .as_mut()
            .ok_or(PipelineError::NoActiveWorkspace)?;
        let row: Option<String> = aw
            .conn
            .query_row(
                "SELECT task_id FROM phase_run_projection WHERE id = ?1",
                params![phase_run_id],
                |r| r.get(0),
            )
            .ok();
        match row {
            Some(v) => v,
            None => return Ok(()),
        }
    };
    let _ =
        run_gates_for_phase(&app, &workspace_id, &task_id, &phase_run_id, PhaseType::Auditor).await?;
    // Regardless of verdict, auto-progression stops. The user takes the next action via
    // the auditor verdict UI (M8).
    Ok(())
}

/// Run all gates configured for `phase` on the task, emitting a `GateRan` event per gate.
/// Returns `true` if every gate passed (or there were none); `false` if any gate failed
/// or errored (in which case progression must stop).
async fn run_gates_for_phase(
    app: &AppHandle,
    workspace_id: &str,
    task_id: &str,
    phase_run_id: &str,
    phase: PhaseType,
) -> Result<bool, PipelineError> {
    // Resolve worktree path + task phase_config from the projection.
    let (worktree_path, task_phase_config_value) = {
        let active = app
            .try_state::<ActiveWorkspaceState>()
            .ok_or(PipelineError::NoActiveWorkspace)?;
        let mut guard = active
            .0
            .lock()
            .map_err(|e| PipelineError::Internal(e.to_string()))?;
        let aw = guard
            .as_mut()
            .ok_or(PipelineError::NoActiveWorkspace)?;
        let task = projections::get_task(&aw.conn, task_id)
            .map_err(|e| PipelineError::Internal(e.to_string()))?
            .ok_or_else(|| PipelineError::TaskNotFound(task_id.to_string()))?;
        (task.worktree_path, task.phase_config)
    };

    let task_phase_config = parse_phase_config(&task_phase_config_value);
    let settings = load_workspace_settings(app, workspace_id);
    let gates_to_run = gates_for_phase(&settings, &task_phase_config, phase);
    if gates_to_run.is_empty() {
        return Ok(true);
    }

    let worktree_path = match worktree_path {
        Some(p) => PathBuf::from(p),
        None => return Ok(true), // no worktree (shouldn't happen post-phase) — skip gates
    };

    let workspace_path = {
        let active = app
            .try_state::<ActiveWorkspaceState>()
            .ok_or(PipelineError::NoActiveWorkspace)?;
        let guard = active
            .0
            .lock()
            .map_err(|e| PipelineError::Internal(e.to_string()))?;
        guard
            .as_ref()
            .ok_or(PipelineError::NoActiveWorkspace)?
            .path
            .clone()
    };

    let tracker: Arc<ChildTracker> = match app.try_state::<Arc<ChildTracker>>() {
        Some(s) => s.inner().clone(),
        None => return Ok(true),
    };

    // Use a fresh per-workspace connection to append GateRan events; the runtime helpers
    // expect &mut Connection.
    let mut conn = open_workspace_db(&workspace_path)
        .map_err(|e| PipelineError::Internal(e.to_string()))?;

    let mut all_passed = true;
    for (name, command, timeout_secs) in gates_to_run {
        let result = gates::run_gate(
            &worktree_path,
            &name,
            &command,
            Duration::from_secs(timeout_secs.max(1)),
            phase_run_id,
            &tracker,
        )
        .await;

        let (passed, output, duration_ms) = match result {
            Ok(GateResult {
                passed,
                output,
                duration_ms,
                ..
            }) => (passed, output, duration_ms),
            Err(e) => (false, format!("gate spawn failed: {}", e), 0i64),
        };

        let seq = current_seq(&conn, "phase_run", phase_run_id)
            .map_err(PipelineError::Internal)?;
        let payload = json!({
            "gate_name": name,
            "passed": passed,
            "output": output,
            "duration_ms": duration_ms,
            "triggering_phase_run_id": phase_run_id,
        })
        .to_string();
        if let Err(e) = append_phase_run_step(
            &mut conn,
            app,
            workspace_id,
            phase_run_id,
            seq,
            NewEvent {
                event_type: "GateRan".into(),
                version: 1,
                payload,
            },
            &make_metadata("system:gate_runner"),
        ) {
            eprintln!("pipeline: append GateRan failed: {}", e);
            return Ok(false);
        }
        if !passed {
            all_passed = false;
            break;
        }
    }
    Ok(all_passed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::GateConfig;
    use std::collections::HashMap;

    fn cfg(phases: &[PhaseType]) -> PhaseConfig {
        PhaseConfig {
            phases: phases.to_vec(),
            gate_overrides: None,
        }
    }

    #[test]
    fn next_phase_after_implementer_is_auditor() {
        let c = cfg(&[PhaseType::Implementer, PhaseType::Auditor]);
        assert_eq!(
            decide_next_phase(&c, PhaseType::Implementer),
            Some(PhaseType::Auditor)
        );
    }

    #[test]
    fn next_phase_after_test_author_is_implementer() {
        let c = cfg(&[
            PhaseType::TestAuthor,
            PhaseType::Implementer,
            PhaseType::Auditor,
        ]);
        assert_eq!(
            decide_next_phase(&c, PhaseType::TestAuthor),
            Some(PhaseType::Implementer)
        );
    }

    #[test]
    fn no_next_phase_after_last() {
        let c = cfg(&[PhaseType::Implementer, PhaseType::Auditor]);
        assert_eq!(decide_next_phase(&c, PhaseType::Auditor), None);
    }

    #[test]
    fn no_next_phase_when_completed_phase_not_in_config() {
        // Defensive: someone ran a phase that isn't in the task's config — don't progress.
        let c = cfg(&[PhaseType::Implementer]);
        assert_eq!(decide_next_phase(&c, PhaseType::TestAuthor), None);
    }

    fn settings_with(
        gates: &[(&str, &str, u64)],
        phase_gates: &[(&str, &[&str])],
    ) -> WorkspaceSettings {
        let mut s = WorkspaceSettings::default();
        for (n, cmd, t) in gates {
            s.gates.insert(
                (*n).to_string(),
                GateConfig {
                    command: (*cmd).to_string(),
                    timeout_seconds: *t,
                },
            );
        }
        for (phase, names) in phase_gates {
            s.phase_gates.insert(
                (*phase).to_string(),
                names.iter().map(|s| s.to_string()).collect(),
            );
        }
        s
    }

    #[test]
    fn gates_for_phase_uses_workspace_default_when_no_override() {
        let s = settings_with(
            &[("typecheck", "tsc", 60), ("test", "pnpm test", 120)],
            &[("implementer", &["typecheck", "test"])],
        );
        let pc = cfg(&[PhaseType::Implementer]);
        let g = gates_for_phase(&s, &pc, PhaseType::Implementer);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].0, "typecheck");
        assert_eq!(g[1].0, "test");
    }

    #[test]
    fn gates_for_phase_task_override_wins() {
        let s = settings_with(
            &[("typecheck", "tsc", 60), ("test", "pnpm test", 120)],
            &[("implementer", &["typecheck", "test"])],
        );
        let mut overrides: HashMap<String, Vec<String>> = HashMap::new();
        overrides.insert("implementer".into(), vec!["typecheck".into()]);
        let pc = PhaseConfig {
            phases: vec![PhaseType::Implementer],
            gate_overrides: Some(overrides),
        };
        let g = gates_for_phase(&s, &pc, PhaseType::Implementer);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].0, "typecheck");
    }

    #[test]
    fn gates_for_phase_skips_unknown_gate_names() {
        let s = settings_with(
            &[("typecheck", "tsc", 60)],
            &[("implementer", &["typecheck", "ghost"])],
        );
        let pc = cfg(&[PhaseType::Implementer]);
        let g = gates_for_phase(&s, &pc, PhaseType::Implementer);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].0, "typecheck");
    }

    #[test]
    fn gates_for_phase_empty_when_phase_has_no_gates() {
        let s = settings_with(&[], &[]);
        let pc = cfg(&[PhaseType::Implementer]);
        let g = gates_for_phase(&s, &pc, PhaseType::Implementer);
        assert!(g.is_empty());
    }
}

