//! Real implementer: invokes a provider as a subprocess, parses its streaming output via
//! the provider trait, and emits the corresponding phase_run events.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;
use ulid::Ulid;

use crate::events::types::{EventMetadata, NewEvent};
use crate::providers::{Provider, ProviderEvent};
use crate::subprocess::{self, ChildTracker, SubprocessError};
use crate::workspace_db::open_workspace_db;

use super::runtime::{append_phase_run_step, started_payload};

const PROMPT_TEMPLATE_ID: &str = "implementer.v1";

fn make_metadata(actor: &str) -> EventMetadata {
    EventMetadata {
        command_id: Ulid::new().to_string(),
        actor: actor.to_string(),
        correlation_id: None,
        causation_id: None,
    }
}

fn build_prompt(spec_markdown: &str) -> String {
    format!(
        "You are the implementer. A task spec is given below. Implement it. The codebase \
         is at the current working directory. Be focused and concise.\n\n--- TASK SPEC ---\n{}\n",
        spec_markdown
    )
}

pub struct ImplementerInput {
    pub workspace_id: String,
    pub workspace_path: String,
    pub task_id: String,
    pub phase: String,
    pub phase_run_id: String,
    pub spec_markdown: String,
    pub provider: Box<dyn Provider>,
    pub provider_path: String,
    pub options: Value,
    pub cancel: CancellationToken,
}

pub async fn run(
    app: AppHandle,
    tracker: Arc<ChildTracker>,
    input: ImplementerInput,
) -> Result<(), String> {
    let ImplementerInput {
        workspace_id,
        workspace_path,
        task_id,
        phase,
        phase_run_id,
        spec_markdown,
        provider,
        provider_path,
        options,
        cancel,
    } = input;

    let mut conn = open_workspace_db(&workspace_path).map_err(|e| e.to_string())?;

    let model = options
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Started.
    let started = started_payload(
        &task_id,
        &phase,
        provider.id(),
        if model.is_empty() { provider.id() } else { &model },
        PROMPT_TEMPLATE_ID,
        &workspace_path,
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
            payload: started,
        },
        &make_metadata("system:implementer"),
    )?;

    let prompt = build_prompt(&spec_markdown);
    let invocation = provider.build_invocation(&prompt, &options);

    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let chunk_tx_cb = chunk_tx.clone();

    let cancel_for_proc = cancel.clone();
    let workspace_path_clone = workspace_path.clone();
    let tracker_clone = Arc::clone(&tracker);
    let args_owned = invocation.args.clone();
    let stdin = invocation.stdin.clone();
    let env = invocation.env.clone();
    let provider_path_clone = provider_path.clone();

    let proc_task = tokio::spawn(async move {
        let args_refs: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();
        subprocess::run_streaming(
            &provider_path_clone,
            &args_refs,
            Path::new(&workspace_path_clone),
            env,
            stdin,
            cancel_for_proc,
            &tracker_clone,
            move |chunk| {
                let _ = chunk_tx_cb.send(chunk.text);
            },
        )
        .await
    });
    drop(chunk_tx);

    let mut seq = 1i64;
    let mut chunk_seq = 0i64;
    let mut line_buf = String::new();
    while let Some(text) = chunk_rx.recv().await {
        line_buf.push_str(&text);
        while let Some(pos) = line_buf.find('\n') {
            let line: String = line_buf.drain(..=pos).collect();
            seq = handle_line(
                provider.as_ref(),
                &mut conn,
                &app,
                &workspace_id,
                &phase_run_id,
                seq,
                &mut chunk_seq,
                line.trim_end_matches('\n'),
            )?;
        }
    }
    if !line_buf.trim().is_empty() {
        let trailing = std::mem::take(&mut line_buf);
        seq = handle_line(
            provider.as_ref(),
            &mut conn,
            &app,
            &workspace_id,
            &phase_run_id,
            seq,
            &mut chunk_seq,
            &trailing,
        )?;
    }

    let proc_result = proc_task.await.map_err(|e| e.to_string())?;

    match proc_result {
        Ok(result) => {
            let summary = format!("Process completed with exit code {}", result.exit_code);
            let payload = json!({
                "exit_code": result.exit_code,
                "summary": summary,
                "files_changed": [],
                "token_usage": { "input": 0, "output": 0 }
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
                &make_metadata("system:implementer"),
            )?;
        }
        Err(SubprocessError::Cancelled) => {
            let payload = json!({
                "error_kind": "user_cancelled",
                "error_message": "subprocess cancelled by user",
            })
            .to_string();
            append_phase_run_step(
                &mut conn,
                &app,
                &workspace_id,
                &phase_run_id,
                seq,
                NewEvent {
                    event_type: "PhaseRunFailed".into(),
                    version: 1,
                    payload,
                },
                &make_metadata("system:implementer"),
            )?;
        }
        Err(e) => {
            let payload = json!({
                "error_kind": "subprocess_error",
                "error_message": e.to_string(),
            })
            .to_string();
            append_phase_run_step(
                &mut conn,
                &app,
                &workspace_id,
                &phase_run_id,
                seq,
                NewEvent {
                    event_type: "PhaseRunFailed".into(),
                    version: 1,
                    payload,
                },
                &make_metadata("system:implementer"),
            )?;
        }
    }

    Ok(())
}

fn handle_line(
    provider: &dyn Provider,
    conn: &mut rusqlite::Connection,
    app: &AppHandle,
    workspace_id: &str,
    phase_run_id: &str,
    mut seq: i64,
    chunk_seq: &mut i64,
    line: &str,
) -> Result<i64, String> {
    for ev in provider.parse_line(line) {
        match ev {
            ProviderEvent::TextChunk(text) => {
                if text.is_empty() {
                    continue;
                }
                *chunk_seq += 1;
                let payload = json!({ "chunk": text, "chunk_seq": *chunk_seq }).to_string();
                seq = append_phase_run_step(
                    conn,
                    app,
                    workspace_id,
                    phase_run_id,
                    seq,
                    NewEvent {
                        event_type: "PhaseRunOutputAppended".into(),
                        version: 1,
                        payload,
                    },
                    &make_metadata("system:implementer"),
                )?;
            }
            ProviderEvent::ToolCall { name, args } => {
                let payload = json!({ "tool_name": name, "args": args }).to_string();
                seq = append_phase_run_step(
                    conn,
                    app,
                    workspace_id,
                    phase_run_id,
                    seq,
                    NewEvent {
                        event_type: "PhaseRunToolCalled".into(),
                        version: 1,
                        payload,
                    },
                    &make_metadata("system:implementer"),
                )?;
            }
        }
    }
    Ok(seq)
}
