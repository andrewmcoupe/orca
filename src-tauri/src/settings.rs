//! Typed workspace settings and phase config.
//!
//! The on-disk shape of `WorkspaceSettingsChanged.settings` is freeform JSON. Readers
//! parse via these types with serde defaults, so old workspaces (which lack the
//! pipeline fields) materialise sensible defaults instead of failing.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhaseType {
    TestAuthor,
    Implementer,
    Auditor,
}

impl PhaseType {
    pub fn as_str(self) -> &'static str {
        match self {
            PhaseType::TestAuthor => "test_author",
            PhaseType::Implementer => "implementer",
            PhaseType::Auditor => "auditor",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "test_author" => Some(PhaseType::TestAuthor),
            "implementer" => Some(PhaseType::Implementer),
            "auditor" => Some(PhaseType::Auditor),
            _ => None,
        }
    }
}

/// A specific model choice: which provider, which model id within that provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelChoice {
    pub provider: String,
    pub model: String,
}

/// Phase configuration for a single task (or workspace default). The phase types are a
/// closed enum — what's configurable is which phases run, in what order, and which gates
/// run after which phases for this scope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseConfig {
    pub phases: Vec<PhaseType>,
    /// Per-phase gate name overrides. `None` means "use workspace default".
    #[serde(default)]
    pub gate_overrides: Option<HashMap<String, Vec<String>>>,
    /// Per-phase model overrides for this task. `None` means "inherit workspace default".
    /// Keys are phase names (e.g. "implementer").
    #[serde(default)]
    pub models: Option<HashMap<String, ModelChoice>>,
}

impl PhaseConfig {
    /// The bundled default: implementer + auditor, no gate overrides.
    pub fn bundled_default() -> Self {
        Self {
            phases: vec![PhaseType::Implementer, PhaseType::Auditor],
            gate_overrides: None,
            models: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateConfig {
    pub command: String,
    pub timeout_seconds: u64,
}

/// Full workspace settings. Every field is defaulted so missing keys in stored JSON
/// produce a usable struct rather than a parse error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSettings {
    #[serde(default = "PhaseConfig::bundled_default")]
    pub default_phase_config: PhaseConfig,
    /// Named gates: `{ name -> { command, timeout_seconds } }`.
    #[serde(default)]
    pub gates: HashMap<String, GateConfig>,
    /// Which gates run after which phase: `{ phase_name -> [gate_name, ...] }`.
    #[serde(default)]
    pub phase_gates: HashMap<String, Vec<String>>,
    /// Per-phase default model. `{ phase_name -> { provider, model } }`. Tasks that do
    /// not override fall back here; phases without an entry fall back to the provider's
    /// hardcoded default.
    #[serde(default)]
    pub default_models: HashMap<String, ModelChoice>,
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            default_phase_config: PhaseConfig::bundled_default(),
            gates: HashMap::new(),
            phase_gates: HashMap::new(),
            default_models: HashMap::new(),
        }
    }
}

impl WorkspaceSettings {
    /// Parse the workspace settings JSON blob, populating defaults for any missing
    /// fields. An empty/absent blob yields fully-default settings.
    pub fn from_json_str(s: &str) -> Self {
        if s.trim().is_empty() {
            return Self::default();
        }
        serde_json::from_str(s).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_json_yields_defaults() {
        let s = WorkspaceSettings::from_json_str("{}");
        assert_eq!(s.default_phase_config.phases.len(), 2);
        assert!(s.gates.is_empty());
        assert!(s.phase_gates.is_empty());
    }

    #[test]
    fn missing_pipeline_fields_get_defaults() {
        // Old-shape settings with unrelated fields — should still parse.
        let s = WorkspaceSettings::from_json_str(r#"{"theme":"dark"}"#);
        assert_eq!(s.default_phase_config.phases.len(), 2);
    }

    #[test]
    fn round_trip_phase_config() {
        let cfg = PhaseConfig {
            phases: vec![PhaseType::TestAuthor, PhaseType::Implementer, PhaseType::Auditor],
            gate_overrides: None,
            models: None,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: PhaseConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.phases.len(), 3);
        assert_eq!(back.phases[0], PhaseType::TestAuthor);
    }

    #[test]
    fn parse_full_settings() {
        let json = r#"{
            "default_phase_config": {
                "phases": ["test_author", "implementer", "auditor"],
                "gate_overrides": null
            },
            "gates": {
                "typecheck": {"command": "pnpm tsc --noEmit", "timeout_seconds": 60}
            },
            "phase_gates": {
                "implementer": ["typecheck"]
            }
        }"#;
        let s = WorkspaceSettings::from_json_str(json);
        assert_eq!(s.default_phase_config.phases.len(), 3);
        assert!(s.gates.contains_key("typecheck"));
        assert_eq!(s.phase_gates["implementer"], vec!["typecheck".to_string()]);
    }
}
