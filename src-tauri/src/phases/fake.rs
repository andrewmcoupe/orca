//! Fake implementer: emits scripted events without invoking any real provider. Useful
//! for development and for exercising the event flow.

use std::time::Duration;

use serde_json::json;
use tauri::AppHandle;
use ulid::Ulid;

use crate::events::types::{EventMetadata, NewEvent};
use crate::workspace_db::open_workspace_db;

use super::runtime::{append_phase_run_step, started_payload};

fn make_metadata(actor: &str) -> EventMetadata {
    EventMetadata {
        command_id: Ulid::new().to_string(),
        actor: actor.to_string(),
        correlation_id: None,
        causation_id: None,
    }
}

pub async fn run(
    app: AppHandle,
    workspace_id: String,
    workspace_path: String,
    task_id: String,
    phase: String,
    phase_run_id: String,
) -> Result<(), String> {
    let mut conn = open_workspace_db(&workspace_path).map_err(|e| e.to_string())?;

    let payload = started_payload(
        &task_id,
        &phase,
        "claude_code",
        "claude-sonnet-4-5",
        "fake.v1",
        &format!("{}/.orca/worktrees/{}", workspace_path, phase_run_id),
    );
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

    Ok(())
}
