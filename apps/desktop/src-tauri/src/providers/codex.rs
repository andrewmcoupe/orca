//! Codex CLI provider. Wraps `codex exec --json --ephemeral` and translates the
//! resulting NDJSON stream into the same `ProviderEvent`s the rest of orca already
//! consumes.
//!
//! Differences from the Claude provider that matter:
//!
//! * Authentication is a separate command (`codex login status`) — `--version` only
//!   reports the binary works, not whether the user has logged in.
//! * `plan` permission mode is *not* hazardous here: it maps to `--sandbox read-only`,
//!   so Codex can run as the auditor with `plan` whereas Claude can't.
//! * Structured output uses `--output-schema <file>`. OpenAI's schema rules require
//!   `additionalProperties: false` and an exhaustive `required` array on every object
//!   node — we transform the schema before writing it. Without the transform, Codex
//!   refuses the schema outright.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};
use ulid::Ulid;

use super::{
    Invocation, KnownModel, OptionDecl, Provider, ProviderEvent, ProviderStatus, SelectChoice,
};
use crate::settings::{PermissionMode, PhaseType};

pub struct CodexProvider;

const DEFAULT_MODEL: &str = "gpt-5.5";

impl Provider for CodexProvider {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn display_name(&self) -> &'static str {
        "Codex"
    }

    fn detect(&self) -> ProviderStatus {
        let mut status = ProviderStatus {
            id: self.id().into(),
            display_name: self.display_name().into(),
            installed: false,
            version: None,
            authenticated: false,
            path: None,
            error: None,
        };

        let path = match which::which("codex") {
            Ok(p) => p,
            Err(_) => {
                status.error = Some("Codex CLI not found on PATH.".into());
                return status;
            }
        };
        status.installed = true;
        status.path = Some(path.display().to_string());

        match std::process::Command::new(&path).arg("--version").output() {
            Ok(o) if o.status.success() => {
                let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !v.is_empty() {
                    status.version = Some(v);
                }
            }
            Ok(o) => {
                status.error = Some(format!(
                    "`codex --version` exited with {}",
                    o.status.code().unwrap_or(-1)
                ));
                return status;
            }
            Err(e) => {
                status.error = Some(format!("failed to run `codex --version`: {}", e));
                return status;
            }
        }

        // Auth probe: `codex login status` exits 0 and writes "Logged in" to either
        // stdout or stderr when the user is authenticated. The reference adapter
        // confirms stderr is the more common channel.
        match std::process::Command::new(&path)
            .args(["login", "status"])
            .output()
        {
            Ok(o) => {
                let combined = format!(
                    "{}\n{}",
                    String::from_utf8_lossy(&o.stdout),
                    String::from_utf8_lossy(&o.stderr)
                );
                let ok = o.status.success() && combined.contains("Logged in");
                status.authenticated = ok;
                if !ok {
                    status.error = Some(
                        "Codex installed but not logged in. Run `codex login` in your terminal."
                            .into(),
                    );
                }
            }
            Err(e) => {
                status.error = Some(format!("failed to run `codex login status`: {}", e));
            }
        }

        status
    }

    fn default_options(&self) -> Value {
        json!({
            "permission_mode": "acceptEdits",
            "model": DEFAULT_MODEL,
        })
    }

    fn options_schema(&self) -> Vec<OptionDecl> {
        vec![
            OptionDecl::Select {
                id: "permission_mode".into(),
                label: "Permission mode".into(),
                description: Some(
                    "How Codex's sandbox is configured. `plan` is read-only, \
                     `acceptEdits` enables --full-auto, `bypassPermissions` removes \
                     all sandboxing (dangerous)."
                        .into(),
                ),
                default: "acceptEdits".into(),
                choices: vec![
                    SelectChoice {
                        value: "plan".into(),
                        label: "Plan (read-only)".into(),
                    },
                    SelectChoice {
                        value: "acceptEdits".into(),
                        label: "Accept edits (--full-auto)".into(),
                    },
                    SelectChoice {
                        value: "bypassPermissions".into(),
                        label: "Bypass sandbox (dangerous)".into(),
                    },
                ],
            },
            OptionDecl::Text {
                id: "model".into(),
                label: "Model".into(),
                description: Some("OpenAI Codex model identifier.".into()),
                default: DEFAULT_MODEL.into(),
            },
        ]
    }

    fn build_invocation(&self, prompt: &str, options: &Value) -> Invocation {
        // Resolve worktree cwd from options (caller supplies). When absent the
        // subprocess runner already sets cwd to the worktree, but Codex needs it on
        // the command line too — `--cd` is what tells Codex which directory the
        // sandbox is rooted at. Default to "." which Codex interprets relative to its
        // own cwd (i.e. the worktree the runner sets).
        let cwd = options
            .get("cwd")
            .and_then(|v| v.as_str())
            .unwrap_or(".")
            .to_string();

        let model = options
            .get("model")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_MODEL)
            .to_string();

        let mut args: Vec<String> = vec![
            "exec".into(),
            "--json".into(),
            "--ephemeral".into(),
            "--cd".into(),
            cwd,
            "--model".into(),
            model,
        ];

        // Permission mode: codex's plan/acceptEdits/bypass map cleanly. Auditor's
        // bypass clamp is enforced upstream (resolver + clamp_for); we trust the value
        // we receive but fall back to acceptEdits on anything unrecognised.
        let mode = options
            .get("permission_mode")
            .and_then(|v| v.as_str())
            .and_then(PermissionMode::parse)
            .unwrap_or(PermissionMode::AcceptEdits);
        match mode {
            PermissionMode::Plan => {
                args.push("--sandbox".into());
                args.push("read-only".into());
            }
            PermissionMode::AcceptEdits => {
                args.push("--sandbox".into());
                args.push("workspace-write".into());
            }
            PermissionMode::BypassPermissions => {
                args.push("--dangerously-bypass-approvals-and-sandbox".into());
            }
        }

        // Structured output: callers (auditor, briefing) put a JSON Schema on
        // `options["output_schema"]`. We rewrite it for OpenAI's strict-schema rules
        // and pass it as a temp file. Failure to materialise the temp file falls back
        // to a prompt-only run so the phase still produces *something* parseable.
        if let Some(schema) = options.get("output_schema") {
            if !schema.is_null() {
                if let Some(path) = write_schema_temp_file(schema) {
                    args.push("--output-schema".into());
                    args.push(path.display().to_string());
                }
            }
        }

        // Trailing `-` tells Codex to read the prompt from stdin. This avoids ARG_MAX
        // limits when the prompt carries large diffs (auditor) or briefing context.
        args.push("-".into());

        Invocation {
            args,
            stdin: Some(prompt.to_string()),
            env: Default::default(),
        }
    }

    fn parse_line(&self, line: &str) -> Vec<ProviderEvent> {
        let line = line.trim();
        if line.is_empty() {
            return vec![];
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            // Codex sometimes interleaves a banner line on startup. Surface it as text
            // so the user can still see it in the live phase output.
            Err(_) => return vec![ProviderEvent::TextChunk(format!("{}\n", line))],
        };

        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match kind {
            // thread.started / turn.started carry no user-visible payload — the
            // phase runner already records PhaseRunStarted before we begin.
            "thread.started" | "turn.started" => vec![],
            "item.started" => match item_type(&v) {
                Some("command_execution") | Some("file_change") => {
                    vec![tool_call_for_item(&v)]
                }
                _ => vec![],
            },
            "item.completed" => match item_type(&v) {
                Some("agent_message") => {
                    let text = v
                        .pointer("/item/text")
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    if text.is_empty() {
                        vec![]
                    } else {
                        vec![ProviderEvent::TextChunk(text.to_string())]
                    }
                }
                // command_execution / file_change started events already populated the
                // tool-call view; the completed payloads are bookkeeping.
                _ => vec![],
            },
            // turn.completed carries token usage we don't yet plumb through.
            _ => vec![],
        }
    }

    fn known_models(&self) -> Vec<KnownModel> {
        vec![
            KnownModel {
                id: "gpt-5.5".into(),
                label: "GPT-5.5".into(),
            },
            KnownModel {
                id: "gpt-5.4".into(),
                label: "GPT-5.4".into(),
            },
            KnownModel {
                id: "gpt-5.4-mini".into(),
                label: "GPT-5.4 mini".into(),
            },
            KnownModel {
                id: "gpt-5.3-codex".into(),
                label: "GPT-5.3 Codex".into(),
            },
        ]
    }

    fn available_permission_modes(&self, phase: PhaseType) -> Vec<PermissionMode> {
        // Codex's `plan` mode maps to `--sandbox read-only` — no ExitPlanMode-style
        // approval to deadlock on, so it's safe across every phase including the
        // auditor. Auditor still rejects bypass on principle.
        let mut modes = vec![PermissionMode::Plan, PermissionMode::AcceptEdits];
        if phase != PhaseType::Auditor {
            modes.push(PermissionMode::BypassPermissions);
        }
        modes
    }

    fn supports_structured_output(&self) -> bool {
        true
    }
}

fn item_type(v: &Value) -> Option<&str> {
    v.pointer("/item/type").and_then(|x| x.as_str())
}

fn tool_call_for_item(v: &Value) -> ProviderEvent {
    let item = v.get("item").cloned().unwrap_or(json!({}));
    let name = item
        .get("type")
        .and_then(|x| x.as_str())
        .unwrap_or("unknown")
        .to_string();
    ProviderEvent::ToolCall { name, args: item }
}

/// Recursively transforms `schema` to satisfy OpenAI's structured-output rules:
/// every object node with `properties` must set `additionalProperties: false` and
/// list every property key in `required`. Without these the Codex `--output-schema`
/// validator rejects the schema before the model ever runs.
pub fn enforce_openai_schema_rules(schema: &Value) -> Value {
    match schema {
        Value::Array(items) => {
            Value::Array(items.iter().map(enforce_openai_schema_rules).collect())
        }
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), enforce_openai_schema_rules(v));
            }
            let is_object = out
                .get("type")
                .and_then(|t| t.as_str())
                .map(|t| t == "object")
                .unwrap_or(false);
            if is_object {
                if let Some(props) = out.get("properties").and_then(|p| p.as_object()).cloned() {
                    out.insert("additionalProperties".into(), Value::Bool(false));
                    let keys: Vec<Value> = props.keys().map(|k| Value::String(k.clone())).collect();
                    out.insert("required".into(), Value::Array(keys));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn write_schema_temp_file(schema: &Value) -> Option<PathBuf> {
    let transformed = enforce_openai_schema_rules(schema);
    let body = serde_json::to_vec(&transformed).ok()?;
    let path = std::env::temp_dir().join(format!("orca-codex-schema-{}.json", Ulid::new()));
    fs::write(&path, body).ok()?;
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "verdict": { "type": "string", "enum": ["approve", "revise", "reject"] },
                "concerns": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "severity": { "type": "string" },
                            "rationale": { "type": "string" }
                        }
                    }
                }
            }
        })
    }

    #[test]
    fn schema_rules_set_additional_properties_and_required() {
        let out = enforce_openai_schema_rules(&sample_schema());
        assert_eq!(out["additionalProperties"], Value::Bool(false));
        let required: Vec<String> = out["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(required.contains(&"verdict".to_string()));
        assert!(required.contains(&"concerns".to_string()));

        // Recursion: the nested object inside `concerns.items` must also be tightened.
        let nested = &out["properties"]["concerns"]["items"];
        assert_eq!(nested["additionalProperties"], Value::Bool(false));
        let nreq: Vec<String> = nested["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(nreq.contains(&"severity".to_string()));
        assert!(nreq.contains(&"rationale".to_string()));
    }

    #[test]
    fn schema_rules_leave_non_object_nodes_alone() {
        let v = json!({ "type": "string", "enum": ["a", "b"] });
        let out = enforce_openai_schema_rules(&v);
        assert!(out.get("additionalProperties").is_none());
        assert!(out.get("required").is_none());
    }

    fn opts(schema: Option<Value>, mode: &str, cwd: &str) -> Value {
        let mut v = json!({
            "permission_mode": mode,
            "model": "gpt-5.5",
            "cwd": cwd,
        });
        if let Some(s) = schema {
            v.as_object_mut().unwrap().insert("output_schema".into(), s);
        }
        v
    }

    #[test]
    fn build_invocation_plan_maps_to_sandbox_read_only() {
        let inv = CodexProvider.build_invocation("hi", &opts(None, "plan", "/tmp/wt"));
        let joined = inv.args.join(" ");
        assert!(joined.contains("--sandbox read-only"), "{}", joined);
        assert!(joined.contains("--cd /tmp/wt"));
        assert!(joined.contains("--model gpt-5.5"));
        assert!(inv.args.last().map(String::as_str) == Some("-"));
        assert_eq!(inv.stdin.as_deref(), Some("hi"));
    }

    #[test]
    fn build_invocation_accept_edits_maps_to_workspace_write() {
        let inv = CodexProvider.build_invocation("hi", &opts(None, "acceptEdits", "."));
        let joined = inv.args.join(" ");
        assert!(joined.contains("--sandbox workspace-write"), "{}", joined);
    }

    #[test]
    fn build_invocation_bypass_maps_to_dangerous_flag() {
        let inv = CodexProvider.build_invocation("hi", &opts(None, "bypassPermissions", "."));
        assert!(inv
            .args
            .iter()
            .any(|a| a == "--dangerously-bypass-approvals-and-sandbox"));
    }

    #[test]
    fn build_invocation_with_schema_writes_temp_file_and_passes_flag() {
        let schema = sample_schema();
        let inv = CodexProvider.build_invocation("hi", &opts(Some(schema), "plan", "."));
        let idx = inv
            .args
            .iter()
            .position(|a| a == "--output-schema")
            .expect("--output-schema flag present");
        let path = inv.args.get(idx + 1).expect("path arg follows flag");
        let body = std::fs::read_to_string(path).expect("schema file exists");
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["additionalProperties"], Value::Bool(false));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn parse_line_thread_started_yields_no_events() {
        let line = json!({ "type": "thread.started", "thread_id": "t1" }).to_string();
        assert!(CodexProvider.parse_line(&line).is_empty());
    }

    #[test]
    fn parse_line_item_started_command_execution_emits_tool_call() {
        let line = json!({
            "type": "item.started",
            "item": { "type": "command_execution", "id": "i1", "command": "ls" }
        })
        .to_string();
        let evs = CodexProvider.parse_line(&line);
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            ProviderEvent::ToolCall { name, args } => {
                assert_eq!(name, "command_execution");
                assert_eq!(args["command"], "ls");
            }
            _ => panic!("expected ToolCall, got {:?}", evs[0]),
        }
    }

    #[test]
    fn parse_line_item_started_file_change_emits_tool_call_with_paths() {
        let line = json!({
            "type": "item.started",
            "item": {
                "type": "file_change",
                "id": "i2",
                "changes": [{ "path": "src/foo.rs", "kind": "update" }]
            }
        })
        .to_string();
        let evs = CodexProvider.parse_line(&line);
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            ProviderEvent::ToolCall { name, args } => {
                assert_eq!(name, "file_change");
                assert_eq!(args["changes"][0]["path"], "src/foo.rs");
            }
            _ => panic!("expected ToolCall"),
        }
    }

    #[test]
    fn parse_line_item_completed_agent_message_emits_text_chunk() {
        let line = json!({
            "type": "item.completed",
            "item": { "type": "agent_message", "id": "i3", "text": "hello" }
        })
        .to_string();
        let evs = CodexProvider.parse_line(&line);
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            ProviderEvent::TextChunk(t) => assert_eq!(t, "hello"),
            _ => panic!("expected TextChunk"),
        }
    }

    #[test]
    fn parse_line_turn_completed_yields_no_events() {
        let line = json!({
            "type": "turn.completed",
            "turn_id": "t",
            "usage": { "input_tokens": 1, "output_tokens": 2 }
        })
        .to_string();
        assert!(CodexProvider.parse_line(&line).is_empty());
    }

    #[test]
    fn parse_line_non_json_falls_through_as_text() {
        let evs = CodexProvider.parse_line("welcome to codex");
        assert!(matches!(evs.as_slice(), [ProviderEvent::TextChunk(_)]));
    }

    #[test]
    fn available_modes_include_plan_for_every_phase_including_auditor() {
        let p = CodexProvider;
        for ph in [
            PhaseType::Implementer,
            PhaseType::TestAuthor,
            PhaseType::Auditor,
        ] {
            assert!(
                p.available_permission_modes(ph)
                    .contains(&PermissionMode::Plan),
                "plan must be available for {:?}",
                ph
            );
        }
        // Bypass still excluded from auditor — verification phase shouldn't get full
        // trust regardless of provider.
        assert!(!p
            .available_permission_modes(PhaseType::Auditor)
            .contains(&PermissionMode::BypassPermissions));
    }
}
