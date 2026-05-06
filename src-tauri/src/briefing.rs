//! Briefing: iterative plan generation. A user describes a feature; a CLI provider
//! produces a structured draft (title, description, tasks with relevant_files,
//! assumptions); the user edits/pushes back/refines; on accept, a Plan + N Tasks
//! are created. Briefing is its own aggregate; events live in the per-workspace
//! store under `aggregate_type = "briefing"`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::providers::Provider;
use crate::subprocess::{self, ChildTracker};

/// Tauri event name for live LLM text chunks emitted during briefing generation.
/// Frontend subscribes per-briefing and accumulates the text in a transient
/// buffer (no DB persistence — option-2 of the planned rollout).
pub const BRIEFING_CHUNK_EVENT: &str = "briefing_chunk";

#[derive(Debug, Clone, Serialize)]
pub struct BriefingChunkPayload {
    pub briefing_id: String,
    /// Cumulative-friendly text fragment. Already provider-decoded — for
    /// stream-json providers we emit the human-readable `TextChunk` content.
    pub text: String,
}

const BUNDLED_BRIEFING_PROMPT: &str = include_str!("prompts/defaults/briefing.md");
const BRIEFING_PROMPT_FILENAME: &str = "briefing.md";

// ============================================================================
// Domain types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
#[derive(Default)]
pub enum FileCertainty {
    Confirmed,
    #[default]
    Candidate,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RelevantFile {
    pub path: String,
    pub certainty: FileCertainty,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DraftTask {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub spec_markdown: String,
    #[serde(default)]
    pub relevant_files: Vec<RelevantFile>,
    /// IDs of *other tasks within this same draft* that this task depends
    /// on. References resolve to actual task ULIDs at briefing accept-time
    /// — see `accept_briefing` for the translation. Defaults to empty so
    /// older drafts (and models that ignore the field) replay cleanly.
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftAssumption {
    pub id: String,
    pub statement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BriefingDraft {
    pub title: String,
    pub description: String,
    pub tasks: Vec<DraftTask>,
    pub assumptions: Vec<DraftAssumption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskEdit {
    pub task_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub spec_markdown: Option<String>,
    #[serde(default)]
    pub file_additions: Vec<RelevantFile>,
    #[serde(default)]
    pub file_removals: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssumptionPushback {
    pub assumption_id: String,
    pub pushback: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BriefingEdits {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub task_edits: Vec<TaskEdit>,
    #[serde(default)]
    pub task_additions: Vec<DraftTask>,
    #[serde(default)]
    pub task_removals: Vec<String>,
    #[serde(default)]
    pub assumption_pushbacks: Vec<AssumptionPushback>,
    /// Freeform "anything else" feedback the user wants the model to consider
    /// during refinement. Passed through to the prompt as a dedicated section
    /// so the model treats it as top-level guidance rather than burying it.
    #[serde(default)]
    pub general_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathValidationResult {
    pub task_id: String,
    pub path: String,
    pub exists: bool,
}

// ============================================================================
// Errors
// ============================================================================

#[derive(Debug, Error)]
pub enum BriefingError {
    #[error("workspace path not found: {0}")]
    WorkspaceNotFound(String),
    #[error("provider not installed or unavailable: {0}")]
    #[allow(dead_code)]
    ProviderUnavailable(String),
    #[error("CLI invocation failed: {0}")]
    CliInvocationFailed(String),
    #[error("model output could not be parsed as JSON after retry")]
    ParseFailed {
        last_output: String,
        last_error: String,
    },
    #[error("prompt template error: {0}")]
    Prompt(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

// ============================================================================
// Prompt templating
// ============================================================================

#[derive(Debug, Serialize)]
struct BriefingPromptContext<'a> {
    user_description: &'a str,
    previous_draft: bool,
    previous_draft_json: Option<String>,
    user_feedback_json: Option<String>,
    /// User's freeform refinement notes, surfaced as its own section in the
    /// prompt so the model can't miss it.
    general_notes: Option<String>,
}

fn briefing_prompt_path(workspace_path: &Path) -> PathBuf {
    workspace_path
        .join(crate::workspace_db::WORKSPACE_DIR)
        .join("prompts")
        .join(BRIEFING_PROMPT_FILENAME)
}

pub fn resolve_briefing_prompt(workspace_path: &Path) -> Result<String, BriefingError> {
    let p = briefing_prompt_path(workspace_path);
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(BUNDLED_BRIEFING_PROMPT.to_string())
        }
        Err(e) => Err(BriefingError::Io(e)),
    }
}

pub fn render_briefing_prompt(
    template: &str,
    user_description: &str,
    previous_draft: Option<&BriefingDraft>,
    user_feedback: Option<&BriefingEdits>,
) -> Result<String, BriefingError> {
    let mut hb = handlebars::Handlebars::new();
    hb.set_strict_mode(false);
    hb.register_escape_fn(handlebars::no_escape);
    let ctx = BriefingPromptContext {
        user_description,
        previous_draft: previous_draft.is_some(),
        previous_draft_json: previous_draft
            .map(|d| serde_json::to_string_pretty(d).unwrap_or_default()),
        user_feedback_json: user_feedback
            .map(|f| serde_json::to_string_pretty(f).unwrap_or_default()),
        general_notes: user_feedback
            .and_then(|f| f.general_notes.as_ref())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    };
    hb.render_template(template, &ctx)
        .map_err(|e| BriefingError::Prompt(e.to_string()))
}

// ============================================================================
// JSON extraction
// ============================================================================

/// The model is instructed to emit JSON only. Real CLIs wrap text with prose,
/// chain-of-thought, or markdown fences. Codex with `--output-schema` is worse:
/// it emits a schema-conforming *stub* up front (all fields empty) before its
/// tool-call discovery phase, then the populated draft at the end. We can't
/// distinguish "stub" from "real" from text alone, so we scan for every
/// balanced top-level `{...}` object and return the longest one (the populated
/// draft will always dwarf the stub).
fn extract_json_object(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut best: Option<(usize, usize)> = None;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'{' {
            i += 1;
            continue;
        }
        let mut depth = 0i32;
        let mut in_str = false;
        let mut escape = false;
        let mut end: Option<usize> = None;
        for (j, &b) in bytes.iter().enumerate().skip(i) {
            if in_str {
                if escape {
                    escape = false;
                } else if b == b'\\' {
                    escape = true;
                } else if b == b'"' {
                    in_str = false;
                }
                continue;
            }
            match b {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(j);
                        break;
                    }
                }
                _ => {}
            }
        }
        match end {
            Some(j) => {
                let len = j - i + 1;
                if best.map(|(s, e)| (e - s + 1) < len).unwrap_or(true) {
                    best = Some((i, j));
                }
                // Continue past this object — siblings (other balanced objects
                // in the same stream) may be larger.
                i = j + 1;
            }
            None => break, // unmatched `{` — no more complete objects
        }
    }
    best.map(|(s, e)| &text[s..=e])
}

fn parse_draft(raw: &str) -> Result<BriefingDraft, (String, String)> {
    let candidate = extract_json_object(raw).unwrap_or(raw);
    serde_json::from_str::<BriefingDraft>(candidate)
        .map_err(|e| (candidate.to_string(), e.to_string()))
}

// ============================================================================
// File path validation
// ============================================================================

pub fn validate_draft_paths(
    workspace_path: &Path,
    draft: &BriefingDraft,
) -> Vec<PathValidationResult> {
    let mut out = Vec::new();
    for task in &draft.tasks {
        for f in &task.relevant_files {
            let candidate = workspace_path.join(&f.path);
            out.push(PathValidationResult {
                task_id: task.id.clone(),
                path: f.path.clone(),
                exists: candidate.exists(),
            });
        }
    }
    out
}

// ============================================================================
// CLI invocation
// ============================================================================

/// Result of one generation attempt: parsed draft + the rendered prompt that produced it.
pub struct GenerationOutcome {
    pub draft: BriefingDraft,
    pub rendered_prompt: String,
    pub duration_ms: u64,
}

/// Run one briefing generation pass. Calls the CLI provider in `--print`-equivalent mode
/// (whatever `provider.build_invocation` resolves to), captures stdout, extracts the JSON
/// draft, and returns it. Retries once with a stricter suffix on parse failure.
///
/// The CWD for the subprocess is the workspace root.
pub async fn run_briefing_generation(
    workspace_path: &Path,
    provider_path: &str,
    provider: &dyn Provider,
    model: &str,
    user_description: &str,
    previous_draft: Option<&BriefingDraft>,
    user_feedback: Option<&BriefingEdits>,
    tracker: Arc<ChildTracker>,
    cancel: CancellationToken,
    // Optional live-output sink. When `Some`, each provider-decoded text chunk
    // is forwarded as a `BRIEFING_CHUNK_EVENT` Tauri event so the UI can render
    // it live. Tests / non-Tauri callers pass None.
    live_output: Option<(AppHandle, String)>,
) -> Result<GenerationOutcome, BriefingError> {
    if !workspace_path.exists() {
        return Err(BriefingError::WorkspaceNotFound(
            workspace_path.display().to_string(),
        ));
    }

    let template = resolve_briefing_prompt(workspace_path)?;
    let base_prompt =
        render_briefing_prompt(&template, user_description, previous_draft, user_feedback)?;

    let mut last_parse_err: Option<(String, String)> = None;
    for attempt in 0..2 {
        let prompt = if attempt == 0 {
            base_prompt.clone()
        } else {
            format!(
                "{}\n\nIMPORTANT: respond with ONLY a JSON object matching the schema. \
                 No markdown fences, no prose, no explanation — JSON only.",
                base_prompt
            )
        };

        let mut options = build_provider_options(provider, model);
        if provider.supports_structured_output() {
            if let Some(map) = options.as_object_mut() {
                map.insert("output_schema".into(), briefing_draft_schema());
                map.insert(
                    "cwd".into(),
                    serde_json::Value::String(workspace_path.to_string_lossy().to_string()),
                );
            }
        }
        let invocation = provider.build_invocation(&prompt, &options);

        let started = std::time::Instant::now();
        let collected = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let collected_cb = std::sync::Arc::clone(&collected);
        // Per-attempt line buffer: stream-json providers emit JSONL, so we
        // hold partial lines until a `\n` arrives, then feed `parse_line`.
        let pending_line = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let pending_line_cb = std::sync::Arc::clone(&pending_line);
        let provider_id_owned = provider.id().to_string();
        let live_output_cb = live_output.clone();

        let args_owned = invocation.args.clone();
        let args_refs: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();

        let result = subprocess::run_streaming(
            provider_path,
            &args_refs,
            workspace_path,
            invocation.env.clone(),
            invocation.stdin.clone(),
            // No timeouts at this layer; the user's UI shows elapsed time and they can
            // cancel. Briefings are pre-task, no worktree, so the standard phase timeouts
            // don't apply.
            subprocess::StreamOptions::default(),
            cancel.clone(),
            &tracker,
            move |chunk| {
                if let Ok(mut g) = collected_cb.lock() {
                    g.push_str(&chunk.text);
                }
                if let Some((app, briefing_id)) = &live_output_cb {
                    forward_live_text(
                        app,
                        briefing_id,
                        &provider_id_owned,
                        &chunk.text,
                        &pending_line_cb,
                    );
                }
            },
        )
        .await
        .map_err(|e| BriefingError::CliInvocationFailed(e.to_string()))?;

        if result.exit_code != 0 {
            return Err(BriefingError::CliInvocationFailed(format!(
                "provider exited with code {}",
                result.exit_code
            )));
        }

        let raw = collected.lock().map(|g| g.clone()).unwrap_or_default();
        // For stream-json providers, extract the human-readable text out of the JSONL.
        // We don't need precise parsing here — `extract_json_object` will hunt for a
        // JSON object inside whatever blob we collect.
        let visible = collect_text_from_provider_stream(provider, &raw);
        match parse_draft(&visible) {
            Ok(mut draft) => {
                ensure_draft_ids(&mut draft);
                return Ok(GenerationOutcome {
                    draft,
                    rendered_prompt: prompt,
                    duration_ms: started.elapsed().as_millis() as u64,
                });
            }
            Err(err) => {
                last_parse_err = Some(err);
            }
        }
    }

    let (output, error) = last_parse_err.unwrap_or_default();
    Err(BriefingError::ParseFailed {
        last_output: output,
        last_error: error,
    })
}

/// Render a one-line, human-friendly summary of a tool-call's args. Picks the
/// "most identifying" field for common Claude tools (file_path, pattern,
/// command, …) and falls back to a truncated JSON dump. Kept short so the
/// live pane reads as a sequence of "→ Read(foo.ts)"-style lines rather than
/// a wall of structured args.
fn summarise_tool_args(args: &serde_json::Value) -> String {
    let obj = match args.as_object() {
        Some(o) => o,
        None => return truncate_inline(&args.to_string()),
    };
    for key in [
        "file_path",
        "path",
        "pattern",
        "query",
        "command",
        "url",
        "todos",
    ] {
        if let Some(v) = obj.get(key).and_then(|x| x.as_str()) {
            return truncate_inline(v);
        }
    }
    // Generic object: show the first scalar value we find.
    for (_, v) in obj {
        if let Some(s) = v.as_str() {
            return truncate_inline(s);
        }
    }
    truncate_inline(&args.to_string())
}

fn truncate_inline(s: &str) -> String {
    let s = s.replace('\n', " ");
    if s.chars().count() > 80 {
        let trimmed: String = s.chars().take(77).collect();
        format!("{}…", trimmed)
    } else {
        s
    }
}

/// Append a streaming chunk to the per-attempt line buffer, drain any complete
/// lines through the provider's parser, and emit each resulting `TextChunk` to
/// the UI. For providers that don't emit JSONL we fall back to forwarding the
/// raw chunk so plain-text streams still reach the UI.
fn forward_live_text(
    app: &AppHandle,
    briefing_id: &str,
    provider_id: &str,
    chunk_text: &str,
    pending_line: &std::sync::Arc<std::sync::Mutex<String>>,
) {
    let provider = match crate::providers::get(provider_id) {
        Some(p) => p,
        None => return,
    };
    let mut emitted_any = false;
    if let Ok(mut buf) = pending_line.lock() {
        buf.push_str(chunk_text);
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line_trim = line.trim_end_matches('\n');
            for ev in provider.parse_line(line_trim) {
                let payload_text = match ev {
                    crate::providers::ProviderEvent::TextChunk(t) if !t.is_empty() => Some(t),
                    crate::providers::ProviderEvent::ToolCall { name, args } => {
                        Some(format!("\n→ {}({})\n", name, summarise_tool_args(&args)))
                    }
                    _ => None,
                };
                if let Some(t) = payload_text {
                    let _ = app.emit(
                        BRIEFING_CHUNK_EVENT,
                        BriefingChunkPayload {
                            briefing_id: briefing_id.to_string(),
                            text: t,
                        },
                    );
                    emitted_any = true;
                }
            }
        }
    }
    // Plain-text fallback: nothing parsed and the chunk has no newlines, so
    // forward verbatim. JSONL chunks are handled above; if a JSONL chunk arrived
    // without a trailing newline its text gets emitted on the next chunk that
    // closes the line.
    if !emitted_any && !chunk_text.is_empty() && !chunk_text.contains('\n') {
        let _ = app.emit(
            BRIEFING_CHUNK_EVENT,
            BriefingChunkPayload {
                briefing_id: briefing_id.to_string(),
                text: chunk_text.to_string(),
            },
        );
    }
}

/// Best-effort: feed each line through `provider.parse_line` and collect the text chunks.
/// Falls back to the raw blob if the provider produced nothing parseable (e.g. a plain
/// stdout-printing CLI). The combined text is what we hunt for JSON in.
fn collect_text_from_provider_stream(provider: &dyn Provider, raw: &str) -> String {
    let mut out = String::new();
    let mut any_parsed = false;
    for line in raw.lines() {
        for ev in provider.parse_line(line) {
            if let crate::providers::ProviderEvent::TextChunk(t) = ev {
                out.push_str(&t);
                any_parsed = true;
            }
        }
    }
    if any_parsed {
        out
    } else {
        raw.to_string()
    }
}

/// JSON Schema describing a `BriefingDraft`. Codex consumes this via
/// `--output-schema` to produce a JSON object that matches our deserializer
/// without resorting to "JSON only please" prompt tricks.
fn briefing_draft_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "description": { "type": "string" },
            "tasks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "title": { "type": "string" },
                        "spec_markdown": { "type": "string" },
                        "relevant_files": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "path": { "type": "string" },
                                    "certainty": { "type": "string", "enum": ["Confirmed", "Candidate"] },
                                    "reason": { "type": "string" }
                                }
                            }
                        },
                        "depends_on": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    }
                }
            },
            "assumptions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "statement": { "type": "string" }
                    }
                }
            }
        }
    })
}

fn build_provider_options(provider: &dyn Provider, model: &str) -> serde_json::Value {
    let mut opts = provider.default_options();
    if let Some(map) = opts.as_object_mut() {
        if !model.is_empty() {
            map.insert("model".into(), serde_json::Value::String(model.into()));
        }
        // Briefings explore the codebase and produce structured JSON. We use
        // `acceptEdits` — same as the auditor — because `plan` mode reroutes the
        // model's answer through the ExitPlanMode tool call, which our text-stream
        // collector doesn't see, so the JSON never arrives. The prompt itself
        // never asks the model to edit anything; acceptEdits keeps the door open
        // for read tools (which the model needs) without the plan-mode side effect.
        map.insert(
            "permission_mode".into(),
            serde_json::Value::String("acceptEdits".into()),
        );
        // The Claude provider clamps `bypassPermissions` for the auditor by inspecting
        // `phase`; we reuse the same hint so the briefing inherits the read-only clamp.
        map.insert("phase".into(), serde_json::Value::String("auditor".into()));
    }
    opts
}

/// Models occasionally omit task ids or assumption ids; backfill ULIDs so the rest of
/// the system has stable references.
fn ensure_draft_ids(draft: &mut BriefingDraft) {
    let mut seen: HashMap<String, ()> = HashMap::new();
    for t in &mut draft.tasks {
        if t.id.trim().is_empty() || seen.contains_key(&t.id) {
            t.id = format!("dt_{}", ulid::Ulid::new());
        }
        seen.insert(t.id.clone(), ());
    }
    let mut seen_a: HashMap<String, ()> = HashMap::new();
    for a in &mut draft.assumptions {
        if a.id.trim().is_empty() || seen_a.contains_key(&a.id) {
            a.id = format!("da_{}", ulid::Ulid::new());
        }
        seen_a.insert(a.id.clone(), ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_draft() -> BriefingDraft {
        BriefingDraft {
            title: "T".into(),
            description: "D".into(),
            tasks: vec![DraftTask {
                id: "t1".into(),
                title: "first".into(),
                spec_markdown: "do it".into(),
                relevant_files: vec![RelevantFile {
                    path: "src/foo.ts".into(),
                    certainty: FileCertainty::Confirmed,
                    reason: "x".into(),
                }],
                depends_on: vec![],
            }],
            assumptions: vec![DraftAssumption {
                id: "a1".into(),
                statement: "x".into(),
            }],
        }
    }

    #[test]
    fn render_without_previous_draft_omits_block() {
        let template = include_str!("prompts/defaults/briefing.md");
        let out = render_briefing_prompt(template, "build a thing", None, None).unwrap();
        assert!(out.contains("build a thing"));
        assert!(!out.contains("Previous draft"));
    }

    #[test]
    fn render_with_previous_draft_includes_block() {
        let template = include_str!("prompts/defaults/briefing.md");
        let draft = sample_draft();
        let edits = BriefingEdits::default();
        let out = render_briefing_prompt(template, "build", Some(&draft), Some(&edits)).unwrap();
        assert!(out.contains("Previous draft"));
        assert!(out.contains("first"));
    }

    #[test]
    fn extract_json_object_pulls_from_prose() {
        let raw = "Here is the plan:\n```json\n{\"title\":\"T\",\"tasks\":[]}\n```\nDone.";
        let extracted = extract_json_object(raw).unwrap();
        assert!(extracted.starts_with('{') && extracted.ends_with('}'));
        let v: serde_json::Value = serde_json::from_str(extracted).unwrap();
        assert_eq!(v["title"], "T");
    }

    #[test]
    fn extract_json_object_picks_largest_when_multiple_present() {
        // Codex with --output-schema emits an empty stub before its tool calls
        // and a populated draft after. Concatenated, both end up in the visible
        // text — we must pick the populated one.
        let stub = r#"{"assumptions":[],"description":"","tasks":[],"title":""}"#;
        let real = r#"{"title":"T","description":"D","tasks":[{"id":"t1","title":"first","spec_markdown":"do it","relevant_files":[]}],"assumptions":[]}"#;
        let combined = format!("{}{}", stub, real);
        let extracted = extract_json_object(&combined).unwrap();
        let v: serde_json::Value = serde_json::from_str(extracted).unwrap();
        assert_eq!(v["title"], "T");
        assert_eq!(v["tasks"][0]["id"], "t1");
    }

    #[test]
    fn extract_json_object_handles_nested_braces_and_strings() {
        let raw = r#"prefix {"a":"with } inside","b":{"c":1}} suffix"#;
        let extracted = extract_json_object(raw).unwrap();
        let v: serde_json::Value = serde_json::from_str(extracted).unwrap();
        assert_eq!(v["b"]["c"], 1);
    }

    #[test]
    fn validate_draft_paths_marks_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("real.txt"), "x").unwrap();
        let draft = BriefingDraft {
            title: "".into(),
            description: "".into(),
            assumptions: vec![],
            tasks: vec![DraftTask {
                id: "t".into(),
                title: "".into(),
                spec_markdown: "".into(),
                relevant_files: vec![
                    RelevantFile {
                        path: "real.txt".into(),
                        certainty: FileCertainty::Confirmed,
                        reason: "".into(),
                    },
                    RelevantFile {
                        path: "missing.txt".into(),
                        certainty: FileCertainty::Candidate,
                        reason: "".into(),
                    },
                ],
                depends_on: vec![],
            }],
        };
        let results = validate_draft_paths(dir.path(), &draft);
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|r| r.path == "real.txt" && r.exists));
        assert!(results.iter().any(|r| r.path == "missing.txt" && !r.exists));
    }

    #[test]
    fn ensure_draft_ids_backfills_blank() {
        let mut draft = BriefingDraft {
            title: "".into(),
            description: "".into(),
            tasks: vec![DraftTask {
                id: "".into(),
                title: "".into(),
                spec_markdown: "".into(),
                relevant_files: vec![],
                depends_on: vec![],
            }],
            assumptions: vec![DraftAssumption {
                id: "".into(),
                statement: "".into(),
            }],
        };
        ensure_draft_ids(&mut draft);
        assert!(!draft.tasks[0].id.is_empty());
        assert!(!draft.assumptions[0].id.is_empty());
    }
}
