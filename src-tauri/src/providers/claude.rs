//! Claude Code provider. Wraps the `claude` CLI in `--print --output-format stream-json`
//! mode and parses the resulting JSONL into normalised events.

use serde_json::{json, Value};

use super::{
    Invocation, KnownModel, OptionDecl, Provider, ProviderEvent, ProviderStatus, SelectChoice,
};

pub struct ClaudeProvider;

impl Provider for ClaudeProvider {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn display_name(&self) -> &'static str {
        "Claude Code"
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

        let path = match which::which("claude") {
            Ok(p) => p,
            Err(_) => {
                status.error = Some("Claude Code not found on PATH.".into());
                return status;
            }
        };

        status.installed = true;
        status.path = Some(path.display().to_string());

        let output = match std::process::Command::new(&path).arg("--version").output() {
            Ok(o) => o,
            Err(e) => {
                status.error = Some(format!("failed to run `claude --version`: {}", e));
                return status;
            }
        };

        if !output.status.success() {
            status.error = Some(format!(
                "`claude --version` exited with {}",
                output.status.code().unwrap_or(-1)
            ));
            return status;
        }

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            status.version = Some(stdout);
        }
        // No cheap dedicated auth probe — a successful --version implies the binary is
        // wired up well enough.
        status.authenticated = true;
        status
    }

    fn default_options(&self) -> Value {
        json!({
            "permission_mode": "acceptEdits",
            "model": "claude-sonnet-4-5",
        })
    }

    fn options_schema(&self) -> Vec<OptionDecl> {
        vec![
            OptionDecl::Select {
                id: "permission_mode".into(),
                label: "Permission mode".into(),
                description: Some(
                    "How the agent handles tool permissions. `acceptEdits` is the safe \
                     default; `bypassPermissions` skips all prompts (dangerous)."
                        .into(),
                ),
                default: "acceptEdits".into(),
                choices: vec![
                    SelectChoice {
                        value: "acceptEdits".into(),
                        label: "Accept edits".into(),
                    },
                    SelectChoice {
                        value: "bypassPermissions".into(),
                        label: "Bypass permissions (dangerous)".into(),
                    },
                ],
            },
            OptionDecl::Text {
                id: "model".into(),
                label: "Model".into(),
                description: Some("Anthropic model identifier.".into()),
                default: "claude-sonnet-4-5".into(),
            },
        ]
    }

    fn build_invocation(&self, prompt: &str, options: &Value) -> Invocation {
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
        ];

        // Permission flow: the resolved mode lands in `options.permission_mode` via the
        // resolution layer in `commands::start_real_phase`. The provider trusts that
        // value — except for the auditor, where we re-clamp `bypassPermissions` to
        // `acceptEdits` defensively. `bypassPermissions` maps to the CLI's
        // `--dangerously-skip-permissions` flag; everything else passes through to
        // `--permission-mode <mode>`. The CLI's own `default` (prompt-on-every-action)
        // is never selected — it would deadlock against our closed-stdin subprocess.
        let raw_mode = options
            .get("permission_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("acceptEdits");
        let phase = options.get("phase").and_then(|v| v.as_str());
        // Defence-in-depth: the auditor never runs with `bypassPermissions` (full trust
        // on a verification phase is wrong) or `plan` (the model can call ExitPlanMode
        // and stall the run waiting for an approval our closed-stdin subprocess can't
        // deliver). The resolution layer already clamps; we mirror that here so a stale
        // call site can't slip a bad mode through.
        let permission_mode = if phase == Some("auditor")
            && (raw_mode == "bypassPermissions" || raw_mode == "plan")
        {
            eprintln!(
                "claude provider: refusing {} for auditor phase; downgrading to acceptEdits",
                raw_mode
            );
            "acceptEdits"
        } else {
            raw_mode
        };

        if permission_mode == "bypassPermissions" {
            args.push("--dangerously-skip-permissions".into());
        } else {
            args.push("--permission-mode".into());
            args.push(permission_mode.into());
        }

        if let Some(model) = options.get("model").and_then(|v| v.as_str()) {
            if !model.is_empty() {
                args.push("--model".into());
                args.push(model.into());
            }
        }

        Invocation {
            args,
            stdin: Some(prompt.to_string()),
            env: Default::default(),
        }
    }

    fn known_models(&self) -> Vec<KnownModel> {
        vec![
            KnownModel {
                id: "claude-opus-4-5".into(),
                label: "Claude Opus 4.5".into(),
            },
            KnownModel {
                id: "claude-sonnet-4-5".into(),
                label: "Claude Sonnet 4.5".into(),
            },
            KnownModel {
                id: "claude-haiku-4-5".into(),
                label: "Claude Haiku 4.5".into(),
            },
        ]
    }

    fn parse_line(&self, line: &str) -> Vec<ProviderEvent> {
        let line = line.trim();
        if line.is_empty() {
            return vec![];
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return vec![ProviderEvent::TextChunk(format!("{}\n", line))],
        };

        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match kind {
            "stream_event" => {
                let event_type = v
                    .pointer("/event/type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                if event_type == "content_block_delta" {
                    if let Some(text) = v
                        .pointer("/event/delta/text")
                        .and_then(|t| t.as_str())
                    {
                        if !text.is_empty() {
                            return vec![ProviderEvent::TextChunk(text.to_string())];
                        }
                    }
                }
                vec![]
            }
            "assistant" => {
                let mut out = Vec::new();
                if let Some(blocks) = v
                    .pointer("/message/content")
                    .and_then(|c| c.as_array())
                {
                    for block in blocks {
                        if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                            let name = block
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("unknown")
                                .to_string();
                            let args = block.get("input").cloned().unwrap_or(json!({}));
                            out.push(ProviderEvent::ToolCall { name, args });
                        }
                    }
                }
                out
            }
            // `system`, `user` (tool results), `result` — currently ignored. Future work:
            // pull token_usage out of `result` for PhaseRunCompleted.
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(phase: &str, mode: &str) -> Value {
        json!({ "phase": phase, "model": "claude-sonnet-4-5", "permission_mode": mode })
    }

    #[test]
    fn auditor_bypass_downgrades_to_accept_edits() {
        let invocation = ClaudeProvider.build_invocation("hi", &opts("auditor", "bypassPermissions"));
        // The downgrade should produce `--permission-mode acceptEdits` rather than the
        // dangerous `--dangerously-skip-permissions` flag.
        let args = invocation.args.join(" ");
        assert!(
            args.contains("--permission-mode acceptEdits"),
            "expected downgrade, got: {args}"
        );
        assert!(
            !args.contains("--dangerously-skip-permissions"),
            "auditor must never get full bypass: {args}"
        );
    }

    #[test]
    fn implementer_bypass_passes_through() {
        let invocation =
            ClaudeProvider.build_invocation("hi", &opts("implementer", "bypassPermissions"));
        let args = invocation.args.join(" ");
        assert!(
            args.contains("--dangerously-skip-permissions"),
            "implementer should keep bypass: {args}"
        );
    }

    #[test]
    fn auditor_plan_downgrades_to_accept_edits() {
        let invocation = ClaudeProvider.build_invocation("hi", &opts("auditor", "plan"));
        let args = invocation.args.join(" ");
        assert!(
            args.contains("--permission-mode acceptEdits"),
            "expected downgrade, got: {args}"
        );
        assert!(
            !args.contains("--permission-mode plan"),
            "auditor must not run in plan mode (deadlocks closed-stdin): {args}"
        );
    }

    #[test]
    fn accept_edits_passes_through() {
        let invocation =
            ClaudeProvider.build_invocation("hi", &opts("implementer", "acceptEdits"));
        let args = invocation.args.join(" ");
        assert!(
            args.contains("--permission-mode acceptEdits"),
            "got: {args}"
        );
    }
}
