//! Provider abstraction. Each AI provider (Claude Code, Codex, …) implements `Provider`,
//! describing how it's detected, how it's invoked, what user-facing options it exposes,
//! and how its streaming output is parsed into normalised events.
//!
//! The registry below is the single place new providers are registered.

mod claude;

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStatus {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub authenticated: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

pub struct ProviderCache(pub Mutex<Vec<ProviderStatus>>);

/// A normalised event produced by parsing one line of provider output.
#[derive(Debug, Clone)]
pub enum ProviderEvent {
    TextChunk(String),
    ToolCall { name: String, args: Value },
}

/// What the runner needs to launch the provider as a subprocess. The runner supplies
/// `cwd` and the `prompt` (which the provider may either inject as an arg or pass via
/// `stdin`).
#[derive(Debug, Clone)]
pub struct Invocation {
    pub args: Vec<String>,
    pub stdin: Option<String>,
    pub env: std::collections::HashMap<String, String>,
}

/// Declares one user-facing option the frontend can render a control for. Providers
/// emit a list of these so the UI doesn't need provider-specific knowledge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OptionDecl {
    Bool {
        id: String,
        label: String,
        description: Option<String>,
        default: bool,
    },
    Select {
        id: String,
        label: String,
        description: Option<String>,
        default: String,
        choices: Vec<SelectChoice>,
    },
    Text {
        id: String,
        label: String,
        description: Option<String>,
        default: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectChoice {
    pub value: String,
    pub label: String,
}

/// A model offered by a provider. Surfaced via `list_models` so the UI can render
/// dropdowns without provider-specific logic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownModel {
    pub id: String,
    pub label: String,
}

/// Implemented once per provider.
pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;

    /// Detect whether the provider is installed and usable on this machine.
    fn detect(&self) -> ProviderStatus;

    /// Default values for each option, by id. Used when the frontend doesn't supply some.
    fn default_options(&self) -> Value;

    /// Schema describing the controls the frontend should render.
    fn options_schema(&self) -> Vec<OptionDecl>;

    /// Resolve the prompt + options into a concrete subprocess invocation. The caller
    /// will use the binary path stored on `ProviderStatus`.
    fn build_invocation(&self, prompt: &str, options: &Value) -> Invocation;

    /// Parse one line of streaming output. Returns zero or more normalised events.
    /// Stateless across calls — providers should be line-buffered upstream.
    fn parse_line(&self, line: &str) -> Vec<ProviderEvent>;

    /// Known models for this provider. Default: empty (caller treats as "unknown — use
    /// the provider's `default_options().model`"). Providers with a fixed catalogue
    /// (e.g. Claude) override this.
    fn known_models(&self) -> Vec<KnownModel> {
        Vec::new()
    }
}

// ---------- Registry ----------

pub fn all() -> Vec<Box<dyn Provider>> {
    vec![Box::new(claude::ClaudeProvider)]
}

pub fn get(id: &str) -> Option<Box<dyn Provider>> {
    all().into_iter().find(|p| p.id() == id)
}

pub fn detect_providers() -> Vec<ProviderStatus> {
    all().into_iter().map(|p| p.detect()).collect()
}
