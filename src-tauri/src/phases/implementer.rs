//! Real implementer: invokes a provider as a subprocess, parses its streaming output via
//! the provider trait, and emits the corresponding phase_run events.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;
use ulid::Ulid;

use crate::events::projections;
use crate::events::types::{EventMetadata, NewEvent};
use crate::prompts::{self, PromptContext};
use crate::providers::{Provider, ProviderEvent};
use crate::settings::PhaseType;
use crate::subprocess::{self, ChildTracker, SubprocessError};
use crate::workspace_db::open_workspace_db;
use crate::worktree;

use super::runtime::{append_phase_run_step, append_task_step, current_seq};

const PHASE_NAME: &str = "implementer";

fn make_metadata(actor: &str) -> EventMetadata {
    EventMetadata {
        command_id: Ulid::new().to_string(),
        actor: actor.to_string(),
        correlation_id: None,
        causation_id: None,
    }
}

pub struct ImplementerInput {
    pub workspace_id: String,
    pub workspace_path: String,
    pub task_id: String,
    pub task_title: String,
    /// Retained for the start_real_phase dispatcher; the runner ignores it and always
    /// emits PHASE_NAME ("implementer") on its events.
    pub phase: String,
    pub phase_run_id: String,
    pub spec_markdown: String,
    pub provider: Box<dyn Provider>,
    pub provider_path: String,
    pub options: Value,
    pub cancel: CancellationToken,
    /// Set by `pass_back_to_implementer` (M8) when the auditor returned `revise`.
    pub is_retry: bool,
    /// Auditor's concerns from the prior verdict, formatted as bulleted markdown.
    /// Surfaced to the implementer via the prompt's retry context block.
    pub retry_context: Option<String>,
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
        task_title,
        phase: _phase_arg,
        phase_run_id,
        spec_markdown,
        provider,
        provider_path,
        options,
        cancel,
        is_retry,
        retry_context,
    } = input;

    let mut conn = open_workspace_db(&workspace_path).map_err(|e| e.to_string())?;

    // Build the prior_phase_commits map up front so it's available both for the prompt
    // context and the PhaseRunStarted payload.
    let prior_phase_commits = projections::prior_phase_commits(&conn, &task_id)
        .map_err(|e| e.to_string())?;

    let workspace_path_buf = std::path::PathBuf::from(&workspace_path);
    let template = prompts::resolve(&workspace_path_buf, PhaseType::Implementer)
        .map_err(|e| e.to_string())?;
    let context = PromptContext {
        task_title: task_title.clone(),
        task_spec_markdown: spec_markdown.clone(),
        acceptance_criteria: spec_markdown.clone(),
        prior_phase_commits: prior_phase_commits.clone(),
        is_retry,
        retry_context: retry_context.clone(),
        ..Default::default()
    };
    let prompt = prompts::render(&template, &context).map_err(|e| e.to_string())?;
    let prompt_template_hash = prompts::hash(&prompt);

    let model = options
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let model_str = if model.is_empty() { provider.id() } else { &model };

    // Per-task worktree: reuse if it exists, otherwise create lazily.
    let (worktree_dir, base_commit) = match ensure_task_worktree(
        &mut conn,
        &app,
        &workspace_id,
        &workspace_path_buf,
        &task_id,
    ) {
        Ok(pair) => pair,
        Err(err) => {
            // Worktree creation failed: still emit PhaseRunStarted (so the run is visible
            // in the UI) and PhaseRunFailed back-to-back.
            let started = started_payload(
                &task_id,
                provider.id(),
                model_str,
                &prompt_template_hash,
                &prior_phase_commits,
                is_retry,
                "",
                "",
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
            let payload = json!({
                "error_kind": "worktree_creation_failed",
                "error_message": err,
            })
            .to_string();
            append_phase_run_step(
                &mut conn,
                &app,
                &workspace_id,
                &phase_run_id,
                1,
                NewEvent {
                    event_type: "PhaseRunFailed".into(),
                    version: 1,
                    payload,
                },
                &make_metadata("system:implementer"),
            )?;
            return Ok(());
        }
    };

    // Started.
    let worktree_path_str = worktree_dir.to_string_lossy().to_string();
    let started = started_payload(
        &task_id,
        provider.id(),
        model_str,
        &prompt_template_hash,
        &prior_phase_commits,
        is_retry,
        &worktree_path_str,
        &base_commit,
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

    let invocation = provider.build_invocation(&prompt, &options);

    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let chunk_tx_cb = chunk_tx.clone();

    let cancel_for_proc = cancel.clone();
    let cwd_for_proc = worktree_dir.clone();
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
            cwd_for_proc.as_path(),
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
            // Auto-commit any worktree changes so phase runs always have a deterministic
            // head_commit_after. If commit fails, fall back to base_commit and surface the
            // error in the summary.
            let commit_message = format!("[phase: {}] {}", PHASE_NAME, task_title);
            let (head_commit_after, commit_note) =
                match worktree::commit_all(&worktree_dir, &commit_message) {
                    Ok(sha) => (sha, None),
                    Err(e) => (base_commit.clone(), Some(format!("auto-commit failed: {}", e))),
                };

            let summary = match commit_note {
                Some(note) => format!(
                    "Process completed with exit code {} ({})",
                    result.exit_code, note
                ),
                None => format!("Process completed with exit code {}", result.exit_code),
            };
            let payload = json!({
                "exit_code": result.exit_code,
                "summary": summary,
                "files_changed": [],
                "token_usage": { "input": 0, "output": 0 },
                "head_commit_after": head_commit_after,
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

/// Reuse the task's existing worktree if one is registered in the projection, otherwise
/// create a fresh one and emit `WorktreeCreated` on the task aggregate. Returns
/// `(worktree_path, base_commit)`.
fn ensure_task_worktree(
    conn: &mut rusqlite::Connection,
    app: &AppHandle,
    workspace_id: &str,
    workspace_path: &Path,
    task_id: &str,
) -> Result<(std::path::PathBuf, String), String> {
    if let Some(task) = projections::get_task(conn, task_id).map_err(|e| e.to_string())? {
        if task.worktree_status.as_deref() == Some("active") {
            if let (Some(p), Some(base)) = (task.worktree_path, task.worktree_base_commit) {
                let path = std::path::PathBuf::from(p);
                if path.exists() {
                    return Ok((path, base));
                }
            }
        }
    }

    let info = worktree::create_worktree(workspace_path, task_id, "")
        .map_err(|e| e.to_string())?;
    let payload = json!({
        "worktree_path": info.path.to_string_lossy(),
        "branch_name": info.branch,
        "base_commit": info.head_commit,
    })
    .to_string();
    let seq = current_seq(conn, "task", task_id)?;
    append_task_step(
        conn,
        app,
        workspace_id,
        task_id,
        seq,
        NewEvent {
            event_type: "WorktreeCreated".into(),
            version: 1,
            payload,
        },
        &make_metadata("system:implementer"),
    )?;
    Ok((info.path, info.head_commit))
}

/// PhaseRunStarted payload. Now carries `prompt_template_hash`, `prior_phase_commits`,
/// and `is_retry_of` (set later when retry plumbing lands; for now just a flag in
/// `is_retry`). The applier currently only reads the legacy fields, so the additional
/// fields ride along for replay/audit but don't affect projections yet.
fn started_payload(
    task_id: &str,
    provider: &str,
    model: &str,
    prompt_template_hash: &str,
    prior_phase_commits: &std::collections::HashMap<String, String>,
    is_retry: bool,
    worktree_path: &str,
    base_commit: &str,
) -> String {
    json!({
        "task_id": task_id,
        "phase": PHASE_NAME,
        "provider": provider,
        "model": model,
        "prompt_template_hash": prompt_template_hash,
        "prior_phase_commits": prior_phase_commits,
        "is_retry": is_retry,
        "worktree_path": worktree_path,
        "base_commit": base_commit,
    })
    .to_string()
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
