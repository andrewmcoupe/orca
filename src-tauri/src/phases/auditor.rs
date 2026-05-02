//! Auditor phase: runs the provider against the diff base..HEAD with a structured-output
//! prompt, parses the response into an `AuditorVerdict`, and emits both `PhaseRunCompleted`
//! and `AuditorVerdictRendered`.
//!
//! The provider trait stays streaming-only for now; the auditor extracts JSON from the
//! accumulated text output and retries the whole subprocess invocation once on parse
//! failure. If the second attempt also fails, we emit `PhaseRunFailed` with
//! `error_kind = "auditor_parse_error"` so the user can decide what to do.

use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
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

use super::runtime::append_phase_run_step;

const PHASE_NAME: &str = "auditor";
/// Hard cap on the diff text shipped to the auditor. Anything beyond is replaced by a
/// "...diff truncated" marker pointing the auditor at the worktree.
const DIFF_TRUNCATION_LIMIT: usize = 50 * 1024;

fn make_metadata(actor: &str) -> EventMetadata {
    EventMetadata {
        command_id: Ulid::new().to_string(),
        actor: actor.to_string(),
        correlation_id: None,
        causation_id: None,
    }
}

pub struct AuditorInput {
    pub workspace_id: String,
    pub workspace_path: String,
    pub task_id: String,
    pub task_title: String,
    pub phase_run_id: String,
    pub spec_markdown: String,
    pub provider: Box<dyn Provider>,
    pub provider_path: String,
    pub options: Value,
    pub cancel: CancellationToken,
}

#[derive(Debug, Deserialize)]
struct AuditorVerdict {
    verdict: String,
    confidence: f64,
    summary: String,
    #[serde(default)]
    concerns: Vec<Value>,
}

pub async fn run(
    app: AppHandle,
    tracker: Arc<ChildTracker>,
    input: AuditorInput,
) -> Result<(), String> {
    let AuditorInput {
        workspace_id,
        workspace_path,
        task_id,
        task_title,
        phase_run_id,
        spec_markdown,
        provider,
        provider_path,
        options,
        cancel,
    } = input;

    let mut conn = open_workspace_db(&workspace_path).map_err(|e| e.to_string())?;

    let prior_phase_commits = projections::prior_phase_commits(&conn, &task_id)
        .map_err(|e| e.to_string())?;

    let task = projections::get_task(&conn, &task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("task not found: {}", task_id))?;

    // The auditor needs the worktree; if it doesn't exist yet, the prior phases never
    // ran. Refuse rather than papering over it.
    let worktree_dir = task
        .worktree_path
        .as_ref()
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "auditor requires a worktree but task has none".to_string())?;
    let task_base_commit = task
        .task_base_commit
        .clone()
        .or_else(|| task.worktree_base_commit.clone())
        .ok_or_else(|| "auditor requires task_base_commit but none recorded".to_string())?;

    let raw_diff = worktree::diff_against_base(&worktree_dir, &task_base_commit)
        .map_err(|e| e.to_string())?;
    let diff_for_prompt =
        worktree::truncate_diff(&raw_diff, DIFF_TRUNCATION_LIMIT, &task_base_commit);

    let workspace_path_buf = std::path::PathBuf::from(&workspace_path);
    let template = prompts::resolve(&workspace_path_buf, PhaseType::Auditor)
        .map_err(|e| e.to_string())?;
    let context = PromptContext {
        task_title: task_title.clone(),
        task_spec_markdown: spec_markdown.clone(),
        acceptance_criteria: spec_markdown.clone(),
        prior_phase_commits: prior_phase_commits.clone(),
        git_diff: Some(diff_for_prompt),
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

    let worktree_path_str = worktree_dir.to_string_lossy().to_string();
    let started = started_payload(
        &task_id,
        provider.id(),
        model_str,
        &prompt_template_hash,
        &prior_phase_commits,
        &worktree_path_str,
        &task_base_commit,
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
        &make_metadata("system:auditor"),
    )?;

    // Run once, parse; on parse failure, run a second time with a clarifying suffix
    // appended to the prompt. If both attempts fail to yield a usable verdict, emit
    // PhaseRunFailed and return.
    let verdict_result = invoke_and_parse(
        &app,
        &mut conn,
        &workspace_id,
        &phase_run_id,
        provider.as_ref(),
        &provider_path,
        &options,
        &worktree_dir,
        &prompt,
        cancel.clone(),
        &tracker,
        1, // starting seq for the run's first non-Started event
    )
    .await;

    let (verdict, last_seq) = match verdict_result {
        Ok((v, seq)) => (v, seq),
        Err(InvokeError::ParseFailed { last_seq, raw }) => {
            // Retry once with a brief instruction to emit JSON only.
            let retry_prompt = format!(
                "{}\n\n---\n\nThe previous response could not be parsed. Reply with the \
                 JSON verdict object only, no surrounding prose.\n",
                prompt
            );
            match invoke_and_parse(
                &app,
                &mut conn,
                &workspace_id,
                &phase_run_id,
                provider.as_ref(),
                &provider_path,
                &options,
                &worktree_dir,
                &retry_prompt,
                cancel.clone(),
                &tracker,
                last_seq,
            )
            .await
            {
                Ok((v, seq)) => (v, seq),
                Err(InvokeError::ParseFailed { last_seq, .. }) => {
                    let payload = json!({
                        "error_kind": "auditor_parse_error",
                        "error_message": format!(
                            "could not parse verdict JSON after one retry; last response:\n{}",
                            truncate_for_error(&raw),
                        ),
                    })
                    .to_string();
                    append_phase_run_step(
                        &mut conn,
                        &app,
                        &workspace_id,
                        &phase_run_id,
                        last_seq,
                        NewEvent {
                            event_type: "PhaseRunFailed".into(),
                            version: 1,
                            payload,
                        },
                        &make_metadata("system:auditor"),
                    )?;
                    return Ok(());
                }
                Err(InvokeError::Subprocess(payload, last_seq)) => {
                    append_phase_run_step(
                        &mut conn,
                        &app,
                        &workspace_id,
                        &phase_run_id,
                        last_seq,
                        NewEvent {
                            event_type: "PhaseRunFailed".into(),
                            version: 1,
                            payload,
                        },
                        &make_metadata("system:auditor"),
                    )?;
                    return Ok(());
                }
            }
        }
        Err(InvokeError::Subprocess(payload, last_seq)) => {
            append_phase_run_step(
                &mut conn,
                &app,
                &workspace_id,
                &phase_run_id,
                last_seq,
                NewEvent {
                    event_type: "PhaseRunFailed".into(),
                    version: 1,
                    payload,
                },
                &make_metadata("system:auditor"),
            )?;
            return Ok(());
        }
    };

    // Empty-commit guard: auditor may modify code as part of review; commit_all skips the
    // commit if the tree is unchanged and returns the parent SHA.
    let commit_message = format!("[phase: {}] {}", PHASE_NAME, task_title);
    let head_commit_after = match worktree::commit_all(&worktree_dir, &commit_message) {
        Ok(sha) => sha,
        Err(_) => task_base_commit.clone(),
    };

    let payload = json!({
        "exit_code": 0,
        "summary": verdict.summary.clone(),
        "files_changed": [],
        "token_usage": { "input": 0, "output": 0 },
        "head_commit_after": head_commit_after,
    })
    .to_string();
    let after_completed = append_phase_run_step(
        &mut conn,
        &app,
        &workspace_id,
        &phase_run_id,
        last_seq,
        NewEvent {
            event_type: "PhaseRunCompleted".into(),
            version: 1,
            payload,
        },
        &make_metadata("system:auditor"),
    )?;

    let verdict_payload = json!({
        "phase_run_id": phase_run_id,
        "task_id": task_id,
        "verdict": verdict.verdict,
        "confidence": verdict.confidence,
        "summary": verdict.summary,
        "concerns": verdict.concerns,
    })
    .to_string();
    append_phase_run_step(
        &mut conn,
        &app,
        &workspace_id,
        &phase_run_id,
        after_completed,
        NewEvent {
            event_type: "AuditorVerdictRendered".into(),
            version: 1,
            payload: verdict_payload,
        },
        &make_metadata("system:auditor"),
    )?;

    Ok(())
}

enum InvokeError {
    /// All output collected, but no parseable verdict object found.
    ParseFailed { last_seq: i64, raw: String },
    /// Subprocess errored or was cancelled. The carried payload is ready to ship into
    /// PhaseRunFailed.
    Subprocess(String, i64),
}

#[allow(clippy::too_many_arguments)]
async fn invoke_and_parse(
    app: &AppHandle,
    conn: &mut rusqlite::Connection,
    workspace_id: &str,
    phase_run_id: &str,
    provider: &dyn Provider,
    provider_path: &str,
    options: &Value,
    worktree_dir: &Path,
    prompt: &str,
    cancel: CancellationToken,
    tracker: &Arc<ChildTracker>,
    seq_start: i64,
) -> Result<(AuditorVerdict, i64), InvokeError> {
    let invocation = provider.build_invocation(prompt, options);
    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let chunk_tx_cb = chunk_tx.clone();
    let cancel_for_proc = cancel.clone();
    let cwd_for_proc = worktree_dir.to_path_buf();
    let args_owned = invocation.args.clone();
    let stdin = invocation.stdin.clone();
    let env = invocation.env.clone();
    let provider_path_clone = provider_path.to_string();
    let tracker_clone = Arc::clone(tracker);

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

    let mut seq = seq_start;
    let mut chunk_seq = 0i64;
    let mut accumulated = String::new();
    let mut line_buf = String::new();
    while let Some(text) = chunk_rx.recv().await {
        line_buf.push_str(&text);
        while let Some(pos) = line_buf.find('\n') {
            let line: String = line_buf.drain(..=pos).collect();
            seq = relay_line(
                provider,
                conn,
                app,
                workspace_id,
                phase_run_id,
                seq,
                &mut chunk_seq,
                &mut accumulated,
                line.trim_end_matches('\n'),
            )
            .map_err(|e| InvokeError::Subprocess(
                json!({ "error_kind": "subprocess_error", "error_message": e }).to_string(),
                seq,
            ))?;
        }
    }
    if !line_buf.trim().is_empty() {
        let trailing = std::mem::take(&mut line_buf);
        seq = relay_line(
            provider,
            conn,
            app,
            workspace_id,
            phase_run_id,
            seq,
            &mut chunk_seq,
            &mut accumulated,
            &trailing,
        )
        .map_err(|e| InvokeError::Subprocess(
            json!({ "error_kind": "subprocess_error", "error_message": e }).to_string(),
            seq,
        ))?;
    }

    let proc_result = proc_task.await.map_err(|e| {
        InvokeError::Subprocess(
            json!({ "error_kind": "subprocess_error", "error_message": e.to_string() })
                .to_string(),
            seq,
        )
    })?;

    if let Err(e) = proc_result {
        let payload = match e {
            SubprocessError::Cancelled => json!({
                "error_kind": "user_cancelled",
                "error_message": "subprocess cancelled by user",
            }),
            other => json!({
                "error_kind": "subprocess_error",
                "error_message": other.to_string(),
            }),
        };
        return Err(InvokeError::Subprocess(payload.to_string(), seq));
    }

    match parse_verdict(&accumulated) {
        Some(v) => Ok((v, seq)),
        None => Err(InvokeError::ParseFailed {
            last_seq: seq,
            raw: accumulated,
        }),
    }
}

#[allow(clippy::too_many_arguments)]
fn relay_line(
    provider: &dyn Provider,
    conn: &mut rusqlite::Connection,
    app: &AppHandle,
    workspace_id: &str,
    phase_run_id: &str,
    mut seq: i64,
    chunk_seq: &mut i64,
    accumulated: &mut String,
    line: &str,
) -> Result<i64, String> {
    for ev in provider.parse_line(line) {
        match ev {
            ProviderEvent::TextChunk(text) => {
                if text.is_empty() {
                    continue;
                }
                accumulated.push_str(&text);
                *chunk_seq += 1;
                let payload =
                    json!({ "chunk": text, "chunk_seq": *chunk_seq }).to_string();
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
                    &make_metadata("system:auditor"),
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
                    &make_metadata("system:auditor"),
                )?;
            }
        }
    }
    Ok(seq)
}

fn started_payload(
    task_id: &str,
    provider: &str,
    model: &str,
    prompt_template_hash: &str,
    prior_phase_commits: &std::collections::HashMap<String, String>,
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
        "worktree_path": worktree_path,
        "base_commit": base_commit,
    })
    .to_string()
}

/// Try, in order: (1) parse the whole accumulated text as JSON, (2) parse the body of a
/// fenced ```json``` block, (3) find the largest top-level `{...}` substring that parses.
/// Returns `None` if all three strategies fail. Independently of which strategy works, the
/// extracted object must deserialize into `AuditorVerdict`.
fn parse_verdict(text: &str) -> Option<AuditorVerdict> {
    let trimmed = text.trim();

    if let Ok(v) = serde_json::from_str::<AuditorVerdict>(trimmed) {
        return Some(v);
    }

    if let Some(body) = extract_fenced_json(trimmed) {
        if let Ok(v) = serde_json::from_str::<AuditorVerdict>(body.trim()) {
            return Some(v);
        }
    }

    for cand in candidate_objects(trimmed) {
        if let Ok(v) = serde_json::from_str::<AuditorVerdict>(&cand) {
            return Some(v);
        }
    }
    None
}

fn extract_fenced_json(text: &str) -> Option<&str> {
    // Look for ```json ... ``` (or ``` ... ```) and return the inside. Use the *first*
    // fenced block — auditors that emit multiple are in unrecoverable territory anyway.
    let opener = ["```json", "```JSON", "```"];
    for op in opener {
        if let Some(start) = text.find(op) {
            let after = &text[start + op.len()..];
            // Skip an optional newline immediately after the opener.
            let after = after.strip_prefix('\n').unwrap_or(after);
            if let Some(end) = after.find("```") {
                return Some(&after[..end]);
            }
        }
    }
    None
}

/// Yield candidate balanced `{...}` substrings from `text`, longest first. Naïve
/// brace-counter that ignores escapes inside strings — good enough for an LLM's verdict
/// blob, not for general JSON in arbitrary prose.
fn candidate_objects(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let bytes = text.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] != b'{' {
            continue;
        }
        let mut depth = 0i32;
        let mut in_str = false;
        let mut esc = false;
        for j in i..bytes.len() {
            let c = bytes[j];
            if in_str {
                if esc {
                    esc = false;
                } else if c == b'\\' {
                    esc = true;
                } else if c == b'"' {
                    in_str = false;
                }
                continue;
            }
            match c {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        if let Ok(s) = std::str::from_utf8(&bytes[i..=j]) {
                            out.push(s.to_string());
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.len()));
    out
}

fn truncate_for_error(s: &str) -> String {
    const LIMIT: usize = 1024;
    if s.len() <= LIMIT {
        return s.to_string();
    }
    let mut cut = LIMIT;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n...[truncated, {} bytes total]", &s[..cut], s.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good_verdict_json() -> &'static str {
        r#"{
            "verdict": "approve",
            "confidence": 0.9,
            "summary": "Looks good.",
            "concerns": []
        }"#
    }

    #[test]
    fn parse_pure_json() {
        let v = parse_verdict(good_verdict_json()).unwrap();
        assert_eq!(v.verdict, "approve");
        assert!((v.confidence - 0.9).abs() < 1e-9);
    }

    #[test]
    fn parse_fenced_json_block() {
        let text = format!(
            "Here's my verdict:\n\n```json\n{}\n```\n\nThanks.",
            good_verdict_json()
        );
        let v = parse_verdict(&text).unwrap();
        assert_eq!(v.verdict, "approve");
    }

    #[test]
    fn parse_inline_object_in_prose() {
        let text = format!(
            "I have looked at the diff. My verdict is: {} — that's all.",
            good_verdict_json()
        );
        let v = parse_verdict(&text).unwrap();
        assert_eq!(v.summary, "Looks good.");
    }

    #[test]
    fn parse_picks_largest_balanced_object() {
        // A small `{}` followed by the real verdict — must skip the dummy.
        let text = format!("{{}} and now: {}", good_verdict_json());
        let v = parse_verdict(&text).unwrap();
        assert_eq!(v.verdict, "approve");
    }

    #[test]
    fn parse_returns_none_on_garbage() {
        assert!(parse_verdict("nothing structured here").is_none());
        assert!(parse_verdict("").is_none());
        // Object that doesn't fit the schema.
        assert!(parse_verdict(r#"{"foo":"bar"}"#).is_none());
    }

    #[test]
    fn parse_handles_braces_inside_strings() {
        let text = r#"
        Here is the verdict:
        {
            "verdict": "revise",
            "confidence": 0.5,
            "summary": "the closing brace } is inside a string and must not break parsing",
            "concerns": []
        }
        "#;
        let v = parse_verdict(text).unwrap();
        assert_eq!(v.verdict, "revise");
        assert!(v.summary.contains("must not break parsing"));
    }

    #[test]
    fn truncate_for_error_caps_length() {
        let big = "a".repeat(5000);
        let out = truncate_for_error(&big);
        assert!(out.len() < 1500);
        assert!(out.contains("[truncated"));
    }
}
