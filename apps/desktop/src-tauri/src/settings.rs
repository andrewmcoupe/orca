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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BriefingPersonaConfig {
    #[serde(default)]
    pub global_default: Option<ModelChoice>,
    #[serde(default)]
    pub personas: HashMap<String, Option<ModelChoice>>,
}

/// How much trust the underlying provider CLI extends to the agent. Three modes are
/// exposed; the CLI's `default` ("prompt for every action") is intentionally absent
/// because it deadlocks our non-interactive subprocess harness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PermissionMode {
    /// Read-only. Agent can analyse but cannot modify files or run commands.
    #[serde(rename = "plan")]
    Plan,
    /// Auto-accept file edits within the working directory; gate shell commands.
    #[serde(rename = "acceptEdits")]
    AcceptEdits,
    /// Full trust. Agent runs anything without prompting.
    #[serde(rename = "bypassPermissions")]
    BypassPermissions,
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Plan => "plan",
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::BypassPermissions => "bypassPermissions",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "plan" => Some(PermissionMode::Plan),
            "acceptEdits" => Some(PermissionMode::AcceptEdits),
            "bypassPermissions" => Some(PermissionMode::BypassPermissions),
            _ => None,
        }
    }

    /// Bundled fallback when no override exists at any level. `acceptEdits` for every
    /// phase: the auditor only emits a JSON verdict so it doesn't *need* edit rights,
    /// but `plan` deadlocks against our closed-stdin subprocess (the model can call
    /// ExitPlanMode and sit there waiting for an approval that never arrives), so we
    /// avoid that mode for any phase running non-interactively.
    pub fn bundled_default_for(phase: PhaseType) -> Self {
        match phase {
            PhaseType::Auditor | PhaseType::TestAuthor | PhaseType::Implementer => {
                PermissionMode::AcceptEdits
            }
        }
    }

    /// Belt-and-braces auditor enforcement: the auditor never runs with full bypass and
    /// never runs in plan mode. `bypassPermissions` is wrong on principle (verification
    /// phase shouldn't get full trust); `plan` deadlocks against our closed-stdin
    /// subprocess. Both clamp to `acceptEdits`. Other phase/mode combinations pass
    /// through.
    pub fn clamp_for(self, phase: PhaseType) -> Self {
        if phase == PhaseType::Auditor
            && (self == PermissionMode::BypassPermissions || self == PermissionMode::Plan)
        {
            PermissionMode::AcceptEdits
        } else {
            self
        }
    }

    /// Whether this mode is selectable for the given phase. Used by the UI to filter
    /// dropdown options and by the resolution layer to validate inputs from older event
    /// payloads. `plan` is unavailable for *every* phase: it deadlocks against our
    /// closed-stdin subprocess (ExitPlanMode waits for an approval that never arrives).
    pub fn is_available_for(self, phase: PhaseType) -> bool {
        !matches!(
            (phase, self),
            (PhaseType::Auditor, PermissionMode::BypassPermissions) | (_, PermissionMode::Plan)
        )
    }
}

/// Per-phase workspace defaults: model choice and permission mode together. Tasks that
/// don't override inherit these values at creation time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefaultPhaseSetting {
    /// `None` means "use the provider's hardcoded default model".
    #[serde(default)]
    pub model: Option<ModelChoice>,
    /// `None` means "use the bundled default for this phase".
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
}

/// Output of the resolution function — everything a phase runner needs to launch the
/// provider for a single phase of a single task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPhaseSettings {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
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
    /// Per-phase permission mode overrides for this task. `None`/missing entry means
    /// "inherit workspace default". Keys are phase names.
    #[serde(default)]
    pub permission_modes: Option<HashMap<String, PermissionMode>>,
}

impl PhaseConfig {
    /// The bundled default: implementer + auditor, no gate overrides.
    pub fn bundled_default() -> Self {
        Self {
            phases: vec![PhaseType::Implementer, PhaseType::Auditor],
            gate_overrides: None,
            models: None,
            permission_modes: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateConfig {
    pub command: String,
    pub timeout_seconds: u64,
}

/// Worktree initialization settings — what runs after a worktree is created and
/// before the first phase. Defaults work for most projects; the user can disable
/// detection or override with a custom command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeInitSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub detection_enabled: bool,
    /// Override: when set, this command runs instead of any detected one.
    #[serde(default)]
    pub user_command: Option<String>,
    #[serde(default = "default_init_timeout_seconds")]
    pub timeout_seconds: u64,
}

impl Default for WorktreeInitSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            detection_enabled: true,
            user_command: None,
            timeout_seconds: default_init_timeout_seconds(),
        }
    }
}

/// Per-phase subprocess timeouts. The phase runner reads these and passes them to
/// `subprocess::run_streaming` so a hung agent can't burn time/tokens unboundedly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseTimeoutSettings {
    #[serde(default = "default_silence_timeout_seconds")]
    pub silence_timeout_seconds: u64,
    #[serde(default = "default_wall_clock_timeout_seconds")]
    pub wall_clock_timeout_seconds: u64,
}

impl Default for PhaseTimeoutSettings {
    fn default() -> Self {
        Self {
            silence_timeout_seconds: default_silence_timeout_seconds(),
            wall_clock_timeout_seconds: default_wall_clock_timeout_seconds(),
        }
    }
}

/// Additional, user-defined environment variables merged into every phase
/// subprocess. Useful for `PATH` extensions, language runtime selectors, project
/// secrets that aren't appropriate to inherit from the user's shell.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SubprocessSettings {
    #[serde(default)]
    pub additional_env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewServerSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default = "default_preview_base_url")]
    pub base_url: String,
    #[serde(default = "default_preview_path")]
    pub health_path: String,
    #[serde(default = "default_preview_path")]
    pub default_route_path: String,
    #[serde(default = "default_preview_startup_timeout_seconds")]
    pub startup_timeout_seconds: u64,
}

impl Default for PreviewServerSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            command: None,
            base_url: default_preview_base_url(),
            health_path: default_preview_path(),
            default_route_path: default_preview_path(),
            startup_timeout_seconds: default_preview_startup_timeout_seconds(),
        }
    }
}

fn default_true() -> bool {
    true
}
fn default_init_timeout_seconds() -> u64 {
    600
}
fn default_silence_timeout_seconds() -> u64 {
    300
}
fn default_wall_clock_timeout_seconds() -> u64 {
    1800
}
fn default_preview_base_url() -> String {
    "http://127.0.0.1:5173".to_string()
}
fn default_preview_path() -> String {
    "/".to_string()
}
fn default_preview_startup_timeout_seconds() -> u64 {
    60
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
    ///
    /// Retained alongside `default_phase_settings` for backwards-compatibility with
    /// stored settings JSON written before the per-phase permission-mode landed; readers
    /// should prefer `default_phase_settings[phase].model` and only fall back here if
    /// missing. The settings UI writes both fields in lock-step so on-disk state stays
    /// internally consistent.
    #[serde(default)]
    pub default_models: HashMap<String, ModelChoice>,
    /// Per-phase default model + permission mode. Supersedes `default_models` for new
    /// installs; `default_models` is kept for back-compat. Keys are phase names.
    #[serde(default)]
    pub default_phase_settings: HashMap<String, DefaultPhaseSetting>,
    /// When true, the ⌘N quick-task dialog jumps straight from form to execution and
    /// skips the per-phase preview. Default: false (preview shown) — users build a
    /// mental model of "what will run" before opting out.
    #[serde(default)]
    pub skip_preview_for_quick_tasks: bool,
    #[serde(default)]
    pub worktree_init: WorktreeInitSettings,
    #[serde(default)]
    pub phase_timeouts: PhaseTimeoutSettings,
    #[serde(default)]
    pub subprocess: SubprocessSettings,
    #[serde(default)]
    pub preview_server: PreviewServerSettings,
    #[serde(default)]
    pub briefing_personas: BriefingPersonaConfig,
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            default_phase_config: PhaseConfig::bundled_default(),
            gates: HashMap::new(),
            phase_gates: HashMap::new(),
            default_models: HashMap::new(),
            default_phase_settings: HashMap::new(),
            skip_preview_for_quick_tasks: false,
            worktree_init: WorktreeInitSettings::default(),
            phase_timeouts: PhaseTimeoutSettings::default(),
            subprocess: SubprocessSettings::default(),
            preview_server: PreviewServerSettings::default(),
            briefing_personas: BriefingPersonaConfig::default(),
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

    /// The workspace-level default model for `phase`. Prefers the new
    /// `default_phase_settings` entry; falls back to legacy `default_models`. `None`
    /// means "no workspace-level model is set" — the caller should fall through to the
    /// provider's hardcoded default.
    pub fn workspace_default_model(&self, phase: PhaseType) -> Option<ModelChoice> {
        let key = phase.as_str();
        if let Some(s) = self.default_phase_settings.get(key) {
            if let Some(m) = &s.model {
                return Some(m.clone());
            }
        }
        self.default_models.get(key).cloned()
    }

    /// The workspace-level default permission mode for `phase` under the conservative
    /// (provider-agnostic) availability matrix. Provider-aware resolution lives in
    /// `resolve_phase_settings_with`; this helper is retained for callers that don't
    /// have a provider in hand and for back-compat tests.
    #[cfg(test)]
    #[allow(dead_code)]
    pub fn workspace_default_permission_mode(&self, phase: PhaseType) -> PermissionMode {
        let key = phase.as_str();
        let stored = self
            .default_phase_settings
            .get(key)
            .and_then(|s| s.permission_mode);
        match stored {
            Some(m) if m.is_available_for(phase) => m,
            _ => PermissionMode::bundled_default_for(phase),
        }
    }
}

/// Resolve the (provider, model, permission_mode) for a phase using the precedence:
///
/// 1. Per-task `phase_config.permission_modes[phase]` / `models[phase]`.
/// 2. Workspace `default_phase_settings[phase]` (or legacy `default_models[phase]`).
/// 3. Bundled fallback (`acceptEdits` for write phases, `plan` for the auditor; no
///    model — provider picks).
///
/// The auditor downgrade is applied as the final step: if the resolved mode is
/// `bypassPermissions` for the auditor (which can only happen via a stale event payload
/// or hand-edited settings), it's clamped to `acceptEdits`. Defence-in-depth — the UI
/// shouldn't let the user pick it, but the runtime guarantees it regardless.
#[allow(dead_code)]
pub fn resolve_phase_settings(
    workspace_settings: &WorkspaceSettings,
    task_phase_config: &PhaseConfig,
    phase: PhaseType,
) -> ResolvedPhaseSettings {
    // Provider-agnostic resolution: applies the conservative universal availability
    // matrix. Use `resolve_phase_settings_with` when the chosen provider is known and
    // its `available_permission_modes` should widen or narrow the menu.
    resolve_phase_settings_with(workspace_settings, task_phase_config, phase, |_| {
        [
            PermissionMode::Plan,
            PermissionMode::AcceptEdits,
            PermissionMode::BypassPermissions,
        ]
        .into_iter()
        .filter(|m| m.is_available_for(phase))
        .collect()
    })
}

/// Provider-aware resolver. `available_modes(provider_id)` returns the modes the
/// provider supports for `phase`; we filter task and workspace overrides through it
/// before falling back. The closure shape (rather than a `&dyn Provider`) keeps
/// `settings` from depending on the providers module.
pub fn resolve_phase_settings_with<F>(
    workspace_settings: &WorkspaceSettings,
    task_phase_config: &PhaseConfig,
    phase: PhaseType,
    available_modes: F,
) -> ResolvedPhaseSettings
where
    F: Fn(&str) -> Vec<PermissionMode>,
{
    let key = phase.as_str();

    let model_choice = task_phase_config
        .models
        .as_ref()
        .and_then(|m| m.get(key).cloned())
        .or_else(|| workspace_settings.workspace_default_model(phase));

    let provider_id = model_choice.as_ref().map(|c| c.provider.clone());
    let modes_for = |provider: Option<&str>| -> Vec<PermissionMode> {
        match provider {
            Some(id) => available_modes(id),
            None => [
                PermissionMode::Plan,
                PermissionMode::AcceptEdits,
                PermissionMode::BypassPermissions,
            ]
            .into_iter()
            .filter(|m| m.is_available_for(phase))
            .collect(),
        }
    };
    let allowed = modes_for(provider_id.as_deref());

    let task_mode = task_phase_config
        .permission_modes
        .as_ref()
        .and_then(|m| m.get(key).copied())
        .filter(|m| allowed.contains(m));

    let workspace_mode = workspace_settings
        .default_phase_settings
        .get(key)
        .and_then(|s| s.permission_mode)
        .filter(|m| allowed.contains(m));

    let permission_mode = task_mode
        .or(workspace_mode)
        .unwrap_or_else(|| PermissionMode::bundled_default_for(phase))
        .clamp_for(phase);

    let (provider, model) = match model_choice {
        Some(c) => (Some(c.provider), Some(c.model)),
        None => (None, None),
    };

    ResolvedPhaseSettings {
        provider,
        model,
        permission_mode,
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
            phases: vec![
                PhaseType::TestAuthor,
                PhaseType::Implementer,
                PhaseType::Auditor,
            ],
            gate_overrides: None,
            models: None,
            permission_modes: None,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: PhaseConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.phases.len(), 3);
        assert_eq!(back.phases[0], PhaseType::TestAuthor);
    }

    #[test]
    fn missing_reliability_fields_get_defaults() {
        let s = WorkspaceSettings::from_json_str("{}");
        assert!(s.worktree_init.enabled);
        assert!(s.worktree_init.detection_enabled);
        assert!(s.worktree_init.user_command.is_none());
        assert_eq!(s.worktree_init.timeout_seconds, 600);
        assert_eq!(s.phase_timeouts.silence_timeout_seconds, 300);
        assert_eq!(s.phase_timeouts.wall_clock_timeout_seconds, 1800);
        assert!(s.subprocess.additional_env.is_empty());
        assert!(!s.preview_server.enabled);
        assert!(s.preview_server.command.is_none());
        assert_eq!(s.preview_server.base_url, "http://127.0.0.1:5173");
        assert_eq!(s.preview_server.health_path, "/");
        assert_eq!(s.preview_server.default_route_path, "/");
        assert_eq!(s.preview_server.startup_timeout_seconds, 60);
    }

    #[test]
    fn reliability_fields_round_trip() {
        let json = r#"{
            "worktree_init": {
                "enabled": false,
                "detection_enabled": false,
                "user_command": "make setup",
                "timeout_seconds": 120
            },
            "phase_timeouts": {
                "silence_timeout_seconds": 60,
                "wall_clock_timeout_seconds": 3600
            },
            "subprocess": {
                "additional_env": { "FOO": "bar" }
            },
            "preview_server": {
                "enabled": true,
                "command": "pnpm dev --host 127.0.0.1",
                "base_url": "http://127.0.0.1:3000",
                "health_path": "/health",
                "default_route_path": "/dashboard",
                "startup_timeout_seconds": 15
            }
        }"#;
        let s = WorkspaceSettings::from_json_str(json);
        assert!(!s.worktree_init.enabled);
        assert!(!s.worktree_init.detection_enabled);
        assert_eq!(s.worktree_init.user_command.as_deref(), Some("make setup"));
        assert_eq!(s.worktree_init.timeout_seconds, 120);
        assert_eq!(s.phase_timeouts.silence_timeout_seconds, 60);
        assert_eq!(s.phase_timeouts.wall_clock_timeout_seconds, 3600);
        assert_eq!(
            s.subprocess.additional_env.get("FOO").map(String::as_str),
            Some("bar")
        );
        assert!(s.preview_server.enabled);
        assert_eq!(
            s.preview_server.command.as_deref(),
            Some("pnpm dev --host 127.0.0.1")
        );
        assert_eq!(s.preview_server.base_url, "http://127.0.0.1:3000");
        assert_eq!(s.preview_server.health_path, "/health");
        assert_eq!(s.preview_server.default_route_path, "/dashboard");
        assert_eq!(s.preview_server.startup_timeout_seconds, 15);

        let json = serde_json::to_string(&s).unwrap();
        let back: WorkspaceSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.preview_server.base_url, "http://127.0.0.1:3000");
    }

    fn ws_with_phase_settings(
        entries: &[(PhaseType, Option<&str>, Option<PermissionMode>)],
    ) -> WorkspaceSettings {
        let mut s = WorkspaceSettings::default();
        for (phase, model, mode) in entries {
            s.default_phase_settings.insert(
                phase.as_str().to_string(),
                DefaultPhaseSetting {
                    model: model.map(|m| ModelChoice {
                        provider: "claude".into(),
                        model: m.to_string(),
                    }),
                    permission_mode: *mode,
                },
            );
        }
        s
    }

    fn task_cfg_with(
        models: &[(PhaseType, &str)],
        modes: &[(PhaseType, PermissionMode)],
    ) -> PhaseConfig {
        let mut models_map: HashMap<String, ModelChoice> = HashMap::new();
        for (p, m) in models {
            models_map.insert(
                p.as_str().to_string(),
                ModelChoice {
                    provider: "claude".into(),
                    model: (*m).to_string(),
                },
            );
        }
        let mut modes_map: HashMap<String, PermissionMode> = HashMap::new();
        for (p, m) in modes {
            modes_map.insert(p.as_str().to_string(), *m);
        }
        PhaseConfig {
            phases: vec![PhaseType::Implementer, PhaseType::Auditor],
            gate_overrides: None,
            models: if models_map.is_empty() {
                None
            } else {
                Some(models_map)
            },
            permission_modes: if modes_map.is_empty() {
                None
            } else {
                Some(modes_map)
            },
        }
    }

    #[test]
    fn resolve_falls_back_to_bundled_default_when_nothing_set() {
        let ws = WorkspaceSettings::default();
        let cfg = task_cfg_with(&[], &[]);
        let r = resolve_phase_settings(&ws, &cfg, PhaseType::Implementer);
        assert_eq!(r.permission_mode, PermissionMode::AcceptEdits);
        assert!(r.model.is_none());
        let a = resolve_phase_settings(&ws, &cfg, PhaseType::Auditor);
        assert_eq!(a.permission_mode, PermissionMode::AcceptEdits);
    }

    #[test]
    fn resolve_uses_workspace_default_when_no_task_override() {
        let ws = ws_with_phase_settings(&[
            (
                PhaseType::Implementer,
                Some("claude-opus-4-5"),
                Some(PermissionMode::BypassPermissions),
            ),
            (
                PhaseType::Auditor,
                Some("claude-sonnet-4-5"),
                Some(PermissionMode::AcceptEdits),
            ),
        ]);
        let cfg = task_cfg_with(&[], &[]);
        let r = resolve_phase_settings(&ws, &cfg, PhaseType::Implementer);
        assert_eq!(r.permission_mode, PermissionMode::BypassPermissions);
        assert_eq!(r.model.as_deref(), Some("claude-opus-4-5"));
        let a = resolve_phase_settings(&ws, &cfg, PhaseType::Auditor);
        assert_eq!(a.permission_mode, PermissionMode::AcceptEdits);
    }

    #[test]
    fn resolve_task_override_wins_over_workspace_default() {
        let ws = ws_with_phase_settings(&[(
            PhaseType::Implementer,
            Some("claude-sonnet-4-5"),
            Some(PermissionMode::AcceptEdits),
        )]);
        let cfg = task_cfg_with(
            &[(PhaseType::Implementer, "claude-opus-4-5")],
            &[(PhaseType::Implementer, PermissionMode::BypassPermissions)],
        );
        let r = resolve_phase_settings(&ws, &cfg, PhaseType::Implementer);
        assert_eq!(r.permission_mode, PermissionMode::BypassPermissions);
        assert_eq!(r.model.as_deref(), Some("claude-opus-4-5"));
    }

    #[test]
    fn resolve_legacy_default_models_still_honoured_when_no_phase_settings_entry() {
        let mut ws = WorkspaceSettings::default();
        ws.default_models.insert(
            "implementer".into(),
            ModelChoice {
                provider: "claude".into(),
                model: "legacy-model".into(),
            },
        );
        let cfg = task_cfg_with(&[], &[]);
        let r = resolve_phase_settings(&ws, &cfg, PhaseType::Implementer);
        assert_eq!(r.model.as_deref(), Some("legacy-model"));
    }

    #[test]
    fn resolve_clamps_bypass_for_auditor_at_workspace_level() {
        // A bypassPermissions value lurking in stored settings for the auditor must
        // never reach the runtime; clamped down to acceptEdits.
        let ws = ws_with_phase_settings(&[(
            PhaseType::Auditor,
            None,
            Some(PermissionMode::BypassPermissions),
        )]);
        let cfg = task_cfg_with(&[], &[]);
        let r = resolve_phase_settings(&ws, &cfg, PhaseType::Auditor);
        assert_eq!(r.permission_mode, PermissionMode::AcceptEdits); // invalid → bundled default
    }

    #[test]
    fn resolve_clamps_bypass_for_auditor_at_task_level() {
        let ws = WorkspaceSettings::default();
        let cfg = task_cfg_with(
            &[],
            &[(PhaseType::Auditor, PermissionMode::BypassPermissions)],
        );
        let r = resolve_phase_settings(&ws, &cfg, PhaseType::Auditor);
        // The task-level override is filtered out as not-available-for-auditor and we
        // fall through to the bundled default (`acceptEdits` for every phase).
        assert_eq!(r.permission_mode, PermissionMode::AcceptEdits);
    }

    #[test]
    fn resolve_filters_plan_mode_for_write_phases() {
        let ws =
            ws_with_phase_settings(&[(PhaseType::Implementer, None, Some(PermissionMode::Plan))]);
        let cfg = task_cfg_with(&[], &[]);
        let r = resolve_phase_settings(&ws, &cfg, PhaseType::Implementer);
        assert_eq!(r.permission_mode, PermissionMode::AcceptEdits);
    }

    #[test]
    fn permission_mode_availability_per_phase() {
        // Auditor never accepts bypassPermissions — the rule the per-task editor
        // enforces both at the command layer (`update_task_phase_config`) and as
        // the final clamp in `resolve_phase_settings`.
        assert!(!PermissionMode::BypassPermissions.is_available_for(PhaseType::Auditor));
        // Plan mode is unavailable for every phase — it deadlocks against our
        // closed-stdin subprocess (ExitPlanMode waits on an approval that never lands).
        assert!(!PermissionMode::Plan.is_available_for(PhaseType::Auditor));
        assert!(!PermissionMode::Plan.is_available_for(PhaseType::Implementer));
        assert!(!PermissionMode::Plan.is_available_for(PhaseType::TestAuthor));
        assert!(PermissionMode::AcceptEdits.is_available_for(PhaseType::Auditor));
        assert!(PermissionMode::AcceptEdits.is_available_for(PhaseType::Implementer));
        assert!(PermissionMode::BypassPermissions.is_available_for(PhaseType::Implementer));
    }

    #[test]
    fn permission_mode_round_trips_via_serde() {
        for m in [
            PermissionMode::Plan,
            PermissionMode::AcceptEdits,
            PermissionMode::BypassPermissions,
        ] {
            let s = serde_json::to_string(&m).unwrap();
            let back: PermissionMode = serde_json::from_str(&s).unwrap();
            assert_eq!(m, back);
            assert_eq!(PermissionMode::parse(m.as_str()), Some(m));
        }
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
