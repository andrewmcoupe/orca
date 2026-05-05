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
use crate::settings::{PermissionMode, PhaseType};
use crate::subprocess::{self, ChildTracker, StreamOptions};
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
    /// Resolved at dispatch time and recorded on `PhaseRunStarted`. Carried separately
    /// from `options` so the value emitted on the event always matches the value the
    /// provider actually receives — both are derived from this field.
    pub permission_mode: PermissionMode,
    pub cancel: CancellationToken,
    /// Set by `pass_back_to_implementer` (M8) when the auditor returned `revise`.
    pub is_retry: bool,
    /// Auditor's concerns from the prior verdict, formatted as bulleted markdown.
    /// Surfaced to the implementer via the prompt's retry context block.
    pub retry_context: Option<String>,
    /// The phase_run_id of the prior implementer attempt this run is retrying.
    /// Persisted on `phase_run_projection.is_retry_of` so the UI can render the
    /// audit trail of retries.
    pub is_retry_of: Option<String>,
    /// Per-phase silence/wall-clock timeouts pulled from workspace settings, plus
    /// any caller-driven knobs.
    pub stream_options: StreamOptions,
    /// Workspace-level extra env vars merged into the provider's invocation env
    /// (caller env wins). The phase runner applies these alongside the provider's
    /// own env when spawning the subprocess.
    pub extra_env: std::collections::HashMap<String, String>,
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
        permission_mode,
        cancel,
        is_retry,
        retry_context,
        is_retry_of,
        stream_options,
        extra_env,
    } = input;

    let mut conn = open_workspace_db(&workspace_path).map_err(|e| e.to_string())?;

    // Build the prior_phase_commits map up front so it's available both for the prompt
    // context and the PhaseRunStarted payload.
    let prior_phase_commits = projections::prior_phase_commits(&conn, &task_id)
        .map_err(|e| e.to_string())?;

    let workspace_path_buf = std::path::PathBuf::from(&workspace_path);
    let template = prompts::resolve(&workspace_path_buf, PhaseType::Implementer)
        .map_err(|e| e.to_string())?;
    let (retry_auditor_block, retry_user_feedback) =
        parse_retry_context(retry_context.as_deref());

    // Pull the task's `relevant_files` from the projection. This is task-level data
    // (set on TaskCreated by the briefing flow); empty array for tasks created via
    // other paths, in which case the prompt section is omitted entirely.
    let relevant_files = projections::get_task(&conn, &task_id)
        .map_err(|e| e.to_string())?
        .map(|t| prompts::relevant_files_from_value(&t.relevant_files))
        .unwrap_or_default();

    let context = PromptContext {
        task_title: task_title.clone(),
        task_spec_markdown: spec_markdown.clone(),
        acceptance_criteria: spec_markdown.clone(),
        prior_phase_commits: prior_phase_commits.clone(),
        is_retry,
        retry_context: retry_context.clone(),
        retry_auditor_block,
        retry_user_feedback,
        relevant_files,
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
                permission_mode,
                &prompt_template_hash,
                &prior_phase_commits,
                is_retry,
                is_retry_of.as_deref(),
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

    // Worktree initialization (deps install). Runs once per worktree, between
    // creation and the first phase. If init has previously succeeded (or the
    // user explicitly skipped after a failure), this is a cheap projection-read
    // no-op. On failure, we silently return without emitting any phase events —
    // the user sees the `WorktreeInitializationFailed` event on the task and
    // can retry or skip from the UI; the pipeline does not auto-progress.
    drop(conn); // release the workspace db lock; ensure_initialized opens its own
    match crate::worktree_init::ensure_initialized(
        &app,
        &workspace_id,
        &workspace_path,
        &task_id,
        std::sync::Arc::clone(&tracker),
        cancel.clone(),
    )
    .await
    {
        Ok(_) => {}
        Err(crate::worktree_init::EnsureInitError::Failed) => return Ok(()),
        Err(e) => {
            return Err(format!("worktree init internal error: {:?}", e));
        }
    }
    let mut conn = open_workspace_db(&workspace_path).map_err(|e| e.to_string())?;

    // Started.
    let worktree_path_str = worktree_dir.to_string_lossy().to_string();
    let started = started_payload(
        &task_id,
        provider.id(),
        model_str,
        permission_mode,
        &prompt_template_hash,
        &prior_phase_commits,
        is_retry,
        is_retry_of.as_deref(),
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

    // Surface the worktree path through options so providers that need it on the CLI
    // (e.g. codex's `--cd`) can pick it up. Claude ignores; the subprocess runner
    // sets cwd anyway.
    let mut options = options;
    if let Some(map) = options.as_object_mut() {
        map.insert(
            "cwd".into(),
            json!(worktree_dir.to_string_lossy().to_string()),
        );
    }
    let invocation = provider.build_invocation(&prompt, &options);

    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let chunk_tx_cb = chunk_tx.clone();

    let cancel_for_proc = cancel.clone();
    let cwd_for_proc = worktree_dir.clone();
    let tracker_clone = Arc::clone(&tracker);
    let args_owned = invocation.args.clone();
    let stdin = invocation.stdin.clone();
    let env = super::runtime::merge_extra_env(invocation.env.clone(), &extra_env);
    let provider_path_clone = provider_path.clone();

    let stream_opts_for_proc = stream_options.clone();
    let proc_task = tokio::spawn(async move {
        let args_refs: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();
        subprocess::run_streaming(
            &provider_path_clone,
            &args_refs,
            cwd_for_proc.as_path(),
            env,
            stdin,
            stream_opts_for_proc,
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
        Err(e) => {
            let payload = json!({
                "error_kind": subprocess::error_kind_for(&e),
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
    let next_seq = append_task_step(
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
    // Anchor the task's diff base. Idempotent in practice: the worktree is only created
    // once per task, so this event fires exactly once per task too.
    let base_payload = json!({ "commit_sha": info.head_commit }).to_string();
    append_task_step(
        conn,
        app,
        workspace_id,
        task_id,
        next_seq,
        NewEvent {
            event_type: "TaskBaseCommitRecorded".into(),
            version: 1,
            payload: base_payload,
        },
        &make_metadata("system:implementer"),
    )?;
    Ok((info.path, info.head_commit))
}

/// PhaseRunStarted payload. Now carries `prompt_template_hash`, `prior_phase_commits`,
/// and `is_retry_of` (set later when retry plumbing lands; for now just a flag in
/// `is_retry`). The applier currently only reads the legacy fields, so the additional
/// fields ride along for replay/audit but don't affect projections yet.
/// Pull the structured fields out of the `retry_context` JSON payload built by
/// `pass_back_to_implementer`. Returns `(auditor_block, user_feedback)`.
///
/// The payload shape is `{ auditor_summary, auditor_concerns: [...], user_feedback }`.
/// If the input is `None`, empty, or unparseable (legacy plain-text retry contexts), we
/// return `(None, None)` and the prompt falls back to its `retry_context` variable.
fn parse_retry_context(raw: Option<&str>) -> (Option<String>, Option<String>) {
    let s = match raw {
        Some(s) if !s.trim().is_empty() => s,
        _ => return (None, None),
    };
    let v: serde_json::Value = match serde_json::from_str(s) {
        Ok(v) => v,
        Err(_) => return (None, None),
    };

    let summary = v
        .get("auditor_summary")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let concerns = v.get("auditor_concerns").cloned().unwrap_or(json!([]));
    let formatted = format_auditor_block(&summary, &concerns);
    let auditor_block = if formatted.trim().is_empty() {
        None
    } else {
        Some(formatted)
    };

    let user_feedback = v
        .get("user_feedback")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    (auditor_block, user_feedback)
}

fn format_auditor_block(summary: &str, concerns: &serde_json::Value) -> String {
    let mut out = String::new();
    if !summary.is_empty() {
        out.push_str("Auditor summary:\n");
        out.push_str(summary);
        out.push_str("\n\n");
    }
    if let Some(arr) = concerns.as_array() {
        if !arr.is_empty() {
            out.push_str("Concerns to address:\n");
            for c in arr {
                let severity = c.get("severity").and_then(|v| v.as_str()).unwrap_or("");
                let category = c.get("category").and_then(|v| v.as_str()).unwrap_or("");
                let rationale = c.get("rationale").and_then(|v| v.as_str()).unwrap_or("");
                let anchor = c
                    .get("anchor")
                    .and_then(|a| {
                        let path = a.get("path").and_then(|v| v.as_str())?;
                        let line = a.get("line").and_then(|v| v.as_i64())?;
                        Some(format!(" ({}:{})", path, line))
                    })
                    .unwrap_or_default();
                out.push_str(&format!(
                    "- [{}] {}{}: {}\n",
                    severity, category, anchor, rationale
                ));
            }
        }
    }
    out
}

fn started_payload(
    task_id: &str,
    provider: &str,
    model: &str,
    permission_mode: PermissionMode,
    prompt_template_hash: &str,
    prior_phase_commits: &std::collections::HashMap<String, String>,
    is_retry: bool,
    is_retry_of: Option<&str>,
    worktree_path: &str,
    base_commit: &str,
) -> String {
    json!({
        "task_id": task_id,
        "phase": PHASE_NAME,
        "provider": provider,
        "model": model,
        "permission_mode": permission_mode.as_str(),
        "prompt_template_hash": prompt_template_hash,
        "prior_phase_commits": prior_phase_commits,
        "is_retry": is_retry,
        "is_retry_of": is_retry_of,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_retry_context_none_when_absent() {
        let (a, u) = parse_retry_context(None);
        assert!(a.is_none());
        assert!(u.is_none());
    }

    #[test]
    fn parse_retry_context_none_when_unparseable() {
        let (a, u) = parse_retry_context(Some("not json"));
        assert!(a.is_none());
        assert!(u.is_none());
    }

    #[test]
    fn parse_retry_context_returns_auditor_block_and_user_feedback() {
        let payload = json!({
            "auditor_summary": "Looks close but two issues.",
            "auditor_concerns": [
                {
                    "category": "tests",
                    "severity": "blocking",
                    "anchor": { "path": "src/foo.rs", "line": 42 },
                    "rationale": "missing assertion"
                },
                {
                    "category": "style",
                    "severity": "advisory",
                    "anchor": null,
                    "rationale": "prefer let-else"
                }
            ],
            "user_feedback": "  also rename Foo to Bar  ",
        })
        .to_string();
        let (a, u) = parse_retry_context(Some(&payload));
        let a = a.expect("auditor block");
        assert!(a.contains("Auditor summary:"));
        assert!(a.contains("Looks close but two issues."));
        assert!(a.contains("[blocking] tests (src/foo.rs:42): missing assertion"));
        assert!(a.contains("[advisory] style: prefer let-else"));
        assert_eq!(u.as_deref(), Some("also rename Foo to Bar"));
    }

    #[test]
    fn parse_retry_context_user_feedback_only() {
        let payload = json!({
            "auditor_summary": "",
            "auditor_concerns": [],
            "user_feedback": "do the other thing",
        })
        .to_string();
        let (a, u) = parse_retry_context(Some(&payload));
        assert!(a.is_none());
        assert_eq!(u.as_deref(), Some("do the other thing"));
    }

    #[test]
    fn parse_retry_context_blank_user_feedback_is_none() {
        let payload = json!({
            "auditor_summary": "s",
            "auditor_concerns": [],
            "user_feedback": "   ",
        })
        .to_string();
        let (_, u) = parse_retry_context(Some(&payload));
        assert!(u.is_none());
    }
}
