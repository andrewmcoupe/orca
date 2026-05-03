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
                        value: "default".into(),
                        label: "Default (prompt — likely to deadlock)".into(),
                    },
                    SelectChoice {
                        value: "acceptEdits".into(),
                        label: "Accept edits".into(),
                    },
                    SelectChoice {
                        value: "bypassPermissions".into(),
                        label: "Bypass all permissions (dangerous)".into(),
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

        let permission_mode = options
            .get("permission_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("acceptEdits");

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
