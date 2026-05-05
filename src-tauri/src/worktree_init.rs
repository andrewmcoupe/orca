//! Worktree initialization: detect what kind of project lives in a freshly-created
//! worktree and run the right install command (`pnpm install --frozen-lockfile`,
//! `uv sync`, etc.) before any phase tries to use the tree.
//!
//! This module is intentionally small and pure-ish: detection inspects marker files
//! and returns an `InitKind`; `InitKind::command()` produces the command string the
//! caller will execute via the subprocess module. Wiring into the worktree creation
//! flow lives in the implementer / test_author phase runners (where the worktree
//! gets created); see those modules for the actual integration.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;
use ulid::Ulid;

use crate::events::types::{EventMetadata, NewEvent};
use crate::phases::runtime::{append_task_step, current_seq};
use crate::settings::WorktreeInitSettings;
use crate::subprocess::{self, ChildTracker, StreamOptions};
use crate::workspace_db::open_workspace_db;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InitKind {
    /// `pnpm-lock.yaml` present alongside `package.json`.
    PackageJsonPnpm,
    /// `yarn.lock` present alongside `package.json`.
    PackageJsonYarn,
    /// `package.json` present (with `package-lock.json` selecting `npm ci`,
    /// otherwise plain `npm install`).
    PackageJsonNpm,
    /// `pyproject.toml` + `uv.lock`.
    PyprojectUv,
    /// `pyproject.toml` + `poetry.lock`.
    PyprojectPoetry,
    /// `requirements.txt` (no other Python marker took precedence).
    RequirementsTxt,
    /// `Cargo.toml`.
    CargoToml,
    /// `go.mod`.
    GoMod,
    /// Nothing matched; the caller should skip init silently.
    None,
}

impl InitKind {
    /// Stable string used in the `WorktreeInitialized.detection_kind` event field.
    /// Must match the enum documented in `docs/events.md`.
    pub fn as_str(&self) -> &'static str {
        match self {
            InitKind::PackageJsonPnpm => "package_json_pnpm",
            InitKind::PackageJsonYarn => "package_json_yarn",
            InitKind::PackageJsonNpm => "package_json_npm",
            InitKind::PyprojectUv => "pyproject_uv",
            InitKind::PyprojectPoetry => "pyproject_poetry",
            InitKind::RequirementsTxt => "requirements_txt",
            InitKind::CargoToml => "cargo_toml",
            InitKind::GoMod => "go_mod",
            InitKind::None => "none",
        }
    }

    /// The shell command this kind runs at init time, or `None` if there's nothing
    /// to do. Lockfile-aware variants (`--frozen-lockfile`, `npm ci`) are used so
    /// the worktree mirrors what the user has on disk rather than auto-updating
    /// dependencies behind their back.
    pub fn command(&self, worktree_path: &Path) -> Option<String> {
        match self {
            InitKind::PackageJsonPnpm => Some("pnpm install --frozen-lockfile".into()),
            InitKind::PackageJsonYarn => Some("yarn install --frozen-lockfile".into()),
            InitKind::PackageJsonNpm => {
                if worktree_path.join("package-lock.json").exists() {
                    Some("npm ci".into())
                } else {
                    Some("npm install".into())
                }
            }
            InitKind::PyprojectUv => Some("uv sync".into()),
            InitKind::PyprojectPoetry => Some("poetry install".into()),
            // No venv management: the user is responsible for activating one if
            // their project needs it. They can override via `user_command` if so.
            InitKind::RequirementsTxt => Some("pip install -r requirements.txt".into()),
            InitKind::CargoToml => Some("cargo fetch".into()),
            InitKind::GoMod => Some("go mod download".into()),
            InitKind::None => None,
        }
    }
}

/// Detect the project kind by inspecting marker files at `worktree_path`. First
/// match wins; the order is important because some markers are subsets of others
/// (a pnpm project still has `package.json`, so we must check `pnpm-lock.yaml`
/// before falling through to npm).
pub fn detect(worktree_path: &Path) -> InitKind {
    let exists = |name: &str| worktree_path.join(name).exists();

    // Node ecosystem: prefer the more specific lockfiles first.
    if exists("package.json") {
        if exists("pnpm-lock.yaml") {
            return InitKind::PackageJsonPnpm;
        }
        if exists("yarn.lock") {
            return InitKind::PackageJsonYarn;
        }
        return InitKind::PackageJsonNpm;
    }

    // Python: pyproject + lockfile combinations beat plain requirements.txt.
    if exists("pyproject.toml") {
        if exists("uv.lock") {
            return InitKind::PyprojectUv;
        }
        if exists("poetry.lock") {
            return InitKind::PyprojectPoetry;
        }
        // pyproject.toml alone has too many possible toolchains (hatch, flit,
        // setuptools, pdm…) to guess safely. Fall through to None — the user
        // can configure `user_command` if they want auto-init.
    }
    if exists("requirements.txt") {
        return InitKind::RequirementsTxt;
    }

    if exists("Cargo.toml") {
        return InitKind::CargoToml;
    }

    if exists("go.mod") {
        return InitKind::GoMod;
    }

    InitKind::None
}

/// Cap on the captured init output stored in the event payload. Init logs are
/// useful for debugging a failed `pnpm install`, but unbounded capture would bloat
/// the event store. 10KB matches the brief.
const OUTPUT_TRUNCATION_LIMIT: usize = 10 * 1024;

/// Outcome of a single init invocation. Mirrors the `WorktreeInitialized` event
/// payload shape — both success and failure paths emit events of this shape and
/// `success` distinguishes them.
#[derive(Debug, Clone)]
pub struct InitOutcome {
    pub command: String,
    pub exit_code: i32,
    pub duration_ms: u64,
    pub output: String,
    pub detection_kind: String,
    pub success: bool,
}

/// Marker emitted in `detection_kind` when a user explicitly clicks "Skip" after
/// a failure. The init didn't actually run; we record a synthetic "initialized"
/// event so subsequent phase starts proceed without re-prompting.
pub const DETECTION_KIND_USER_SKIPPED: &str = "user_skipped";

/// Decide which command (if any) should run for this worktree, given workspace
/// settings. Returns `(command, detection_kind)` or `None` if init should be
/// skipped entirely (settings disabled, or detection found nothing and no
/// override). Pure: no IO beyond the marker-file checks already in `detect`.
pub fn resolve_command(
    worktree_path: &Path,
    settings: &WorktreeInitSettings,
) -> Option<(String, String)> {
    if !settings.enabled {
        return None;
    }
    if let Some(cmd) = settings.user_command.as_ref() {
        let cmd = cmd.trim();
        if !cmd.is_empty() {
            return Some((cmd.to_string(), "user_configured".into()));
        }
    }
    if !settings.detection_enabled {
        return None;
    }
    let kind = detect(worktree_path);
    let cmd = kind.command(worktree_path)?;
    Some((cmd, kind.as_str().to_string()))
}

/// Run the resolved init command in `worktree_path`, returning a structured
/// outcome. The command is invoked through `sh -c` (cmd /C on Windows) so users
/// can write natural shell expressions in `user_command`.
pub async fn run_init(
    worktree_path: &Path,
    command: &str,
    detection_kind: &str,
    settings: &WorktreeInitSettings,
    extra_env: HashMap<String, String>,
    tracker: &ChildTracker,
    cancel: CancellationToken,
) -> InitOutcome {
    let (sh, args) = shell_command(command);
    let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    let output_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let output_for_cb = Arc::clone(&output_buf);

    let stream_opts = StreamOptions {
        // Init has its own wall-clock cap; we don't apply silence detection
        // because installs can legitimately go quiet during long downloads.
        silence_timeout: None,
        wall_clock_timeout: Some(Duration::from_secs(settings.timeout_seconds.max(1))),
    };

    let result = subprocess::run_streaming(
        &sh,
        &args_refs,
        worktree_path,
        extra_env,
        None,
        stream_opts,
        cancel,
        tracker,
        move |chunk| {
            // Both streams interleave into a single human-readable log so the
            // user sees the install transcript exactly as the tool printed it.
            if let Ok(mut buf) = output_for_cb.lock() {
                if buf.len() < OUTPUT_TRUNCATION_LIMIT {
                    buf.push_str(&chunk.text);
                }
            }
        },
    )
    .await;

    let mut output = output_buf
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    if output.len() >= OUTPUT_TRUNCATION_LIMIT {
        // Cut on a UTF-8 boundary to avoid producing invalid output.
        let mut cut = OUTPUT_TRUNCATION_LIMIT;
        while cut > 0 && !output.is_char_boundary(cut) {
            cut -= 1;
        }
        output.truncate(cut);
        output.push_str(
            "\n...[init output truncated; rerun the command in the worktree for the full log]\n",
        );
    }

    match result {
        Ok(proc) => InitOutcome {
            command: command.to_string(),
            exit_code: proc.exit_code,
            duration_ms: proc.duration_ms,
            output,
            detection_kind: detection_kind.to_string(),
            success: proc.exit_code == 0,
        },
        Err(e) => {
            let suffix = format!("\n...[init aborted: {}]\n", e);
            InitOutcome {
                command: command.to_string(),
                exit_code: -1,
                duration_ms: settings.timeout_seconds * 1000,
                output: output + &suffix,
                detection_kind: detection_kind.to_string(),
                success: false,
            }
        }
    }
}

/// Outcome returned by `ensure_initialized`. The successful states tell the
/// caller it's safe to dispatch the first phase; the failure state means the
/// pipeline must halt and the user must intervene.
#[derive(Debug)]
pub enum EnsureInitOutcome {
    /// A successful (or user-skipped) init has previously been recorded for
    /// this worktree — no work needed.
    AlreadyDone,
    /// Settings or detection indicated nothing to install — no event emitted.
    Skipped,
    /// Init just ran successfully; `WorktreeInitialized` has been appended.
    JustInitialized,
}

#[derive(Debug)]
pub enum EnsureInitError {
    /// The task has no worktree on disk to initialize.
    NoWorktree,
    /// Init ran and failed; `WorktreeInitializationFailed` has been appended.
    /// The caller should NOT dispatch a phase — the user must retry or skip.
    Failed,
    /// Internal infrastructure error (db open, etc). Distinct from a clean init
    /// failure because the user can't usefully retry from the UI.
    Internal(String),
}

/// Idempotent: ensure init has run for this task's current worktree. Reads the
/// projection to decide whether init is needed; if so, runs it via `run_init`
/// and emits the matching event on the task aggregate.
///
/// This is the entry point used by both the phase runners (just before
/// `PhaseRunStarted`) and the explicit "Retry initialization" Tauri command.
pub async fn ensure_initialized(
    app: &AppHandle,
    workspace_id: &str,
    workspace_path: &str,
    task_id: &str,
    tracker: Arc<ChildTracker>,
    cancel: CancellationToken,
) -> Result<EnsureInitOutcome, EnsureInitError> {
    let mut conn =
        open_workspace_db(workspace_path).map_err(|e| EnsureInitError::Internal(e.to_string()))?;

    let task = crate::events::projections::get_task(&conn, task_id)
        .map_err(|e| EnsureInitError::Internal(e.to_string()))?
        .ok_or_else(|| EnsureInitError::Internal(format!("task not found: {}", task_id)))?;

    let worktree_path = task
        .worktree_path
        .as_deref()
        .ok_or(EnsureInitError::NoWorktree)?;
    let worktree_pathbuf = std::path::PathBuf::from(worktree_path);
    if !worktree_pathbuf.exists() {
        return Err(EnsureInitError::NoWorktree);
    }

    if task.worktree_init_status.as_deref() == Some("initialized") {
        return Ok(EnsureInitOutcome::AlreadyDone);
    }

    let settings = crate::pipeline::load_workspace_settings(app, workspace_id);
    let extra_env = settings.subprocess.additional_env.clone();
    let init_settings = settings.worktree_init.clone();

    let (command, detection_kind) = match resolve_command(&worktree_pathbuf, &init_settings) {
        Some(pair) => pair,
        None => return Ok(EnsureInitOutcome::Skipped),
    };

    // Mark init as running before we kick off the (potentially long) command.
    // Without this the UI sees `worktree_init_status = NULL` for the entire
    // duration and renders nothing — leaving the user staring at a blank panel
    // while `pnpm install` chugs through node_modules.
    let started_payload = json!({
        "command": command,
        "detection_kind": detection_kind,
    })
    .to_string();
    let started_seq = current_seq(&conn, "task", task_id)
        .map_err(EnsureInitError::Internal)?;
    append_task_step(
        &mut conn,
        app,
        workspace_id,
        task_id,
        started_seq,
        NewEvent {
            event_type: "WorktreeInitializationStarted".into(),
            version: 1,
            payload: started_payload,
        },
        &EventMetadata {
            command_id: Ulid::new().to_string(),
            actor: "system:worktree_init".into(),
            correlation_id: None,
            causation_id: None,
        },
    )
    .map_err(EnsureInitError::Internal)?;

    let outcome = run_init(
        &worktree_pathbuf,
        &command,
        &detection_kind,
        &init_settings,
        extra_env,
        &tracker,
        cancel,
    )
    .await;

    let event_type = if outcome.success {
        "WorktreeInitialized"
    } else {
        "WorktreeInitializationFailed"
    };
    let payload = json!({
        "command": outcome.command,
        "exit_code": outcome.exit_code,
        "duration_ms": outcome.duration_ms,
        "output": outcome.output,
        "detection_kind": outcome.detection_kind,
    })
    .to_string();
    let seq = current_seq(&conn, "task", task_id)
        .map_err(EnsureInitError::Internal)?;
    append_task_step(
        &mut conn,
        app,
        workspace_id,
        task_id,
        seq,
        NewEvent {
            event_type: event_type.into(),
            version: 1,
            payload,
        },
        &EventMetadata {
            command_id: Ulid::new().to_string(),
            actor: "system:worktree_init".into(),
            correlation_id: None,
            causation_id: None,
        },
    )
    .map_err(EnsureInitError::Internal)?;

    if outcome.success {
        Ok(EnsureInitOutcome::JustInitialized)
    } else {
        Err(EnsureInitError::Failed)
    }
}

/// Mark the current worktree as initialized via a synthetic `WorktreeInitialized`
/// event. Used by the "Skip initialization" UI affordance after a failure: the
/// user is acknowledging they'll handle deps themselves and asking the pipeline
/// to proceed regardless.
pub fn mark_skipped(
    app: &AppHandle,
    workspace_id: &str,
    workspace_path: &str,
    task_id: &str,
) -> Result<(), String> {
    let mut conn = open_workspace_db(workspace_path).map_err(|e| e.to_string())?;
    let payload = json!({
        "command": "<skipped by user>",
        "exit_code": 0,
        "duration_ms": 0,
        "output": "Initialization was skipped by the user.",
        "detection_kind": DETECTION_KIND_USER_SKIPPED,
    })
    .to_string();
    let seq = current_seq(&conn, "task", task_id)?;
    append_task_step(
        &mut conn,
        app,
        workspace_id,
        task_id,
        seq,
        NewEvent {
            event_type: "WorktreeInitialized".into(),
            version: 1,
            payload,
        },
        &EventMetadata {
            command_id: Ulid::new().to_string(),
            actor: "user:local".into(),
            correlation_id: None,
            causation_id: None,
        },
    )?;
    Ok(())
}

#[cfg(unix)]
fn shell_command(command: &str) -> (String, Vec<String>) {
    ("sh".to_string(), vec!["-c".to_string(), command.to_string()])
}

#[cfg(not(unix))]
fn shell_command(command: &str) -> (String, Vec<String>) {
    (
        "cmd".to_string(),
        vec!["/C".to_string(), command.to_string()],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), "").unwrap();
    }

    #[test]
    fn detects_pnpm_when_pnpm_lock_present() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "package.json");
        touch(d.path(), "pnpm-lock.yaml");
        assert_eq!(detect(d.path()), InitKind::PackageJsonPnpm);
        assert_eq!(
            InitKind::PackageJsonPnpm.command(d.path()).as_deref(),
            Some("pnpm install --frozen-lockfile")
        );
    }

    #[test]
    fn detects_yarn_when_yarn_lock_present() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "package.json");
        touch(d.path(), "yarn.lock");
        assert_eq!(detect(d.path()), InitKind::PackageJsonYarn);
    }

    #[test]
    fn npm_uses_ci_when_lockfile_present() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "package.json");
        touch(d.path(), "package-lock.json");
        assert_eq!(detect(d.path()), InitKind::PackageJsonNpm);
        assert_eq!(
            InitKind::PackageJsonNpm.command(d.path()).as_deref(),
            Some("npm ci")
        );
    }

    #[test]
    fn npm_uses_install_when_no_lockfile() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "package.json");
        assert_eq!(detect(d.path()), InitKind::PackageJsonNpm);
        assert_eq!(
            InitKind::PackageJsonNpm.command(d.path()).as_deref(),
            Some("npm install")
        );
    }

    #[test]
    fn pnpm_lock_wins_over_npm() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "package.json");
        touch(d.path(), "package-lock.json");
        touch(d.path(), "pnpm-lock.yaml");
        assert_eq!(detect(d.path()), InitKind::PackageJsonPnpm);
    }

    #[test]
    fn detects_uv_over_poetry_when_both_lockfiles_present() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "pyproject.toml");
        touch(d.path(), "uv.lock");
        touch(d.path(), "poetry.lock");
        assert_eq!(detect(d.path()), InitKind::PyprojectUv);
    }

    #[test]
    fn detects_poetry() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "pyproject.toml");
        touch(d.path(), "poetry.lock");
        assert_eq!(detect(d.path()), InitKind::PyprojectPoetry);
    }

    #[test]
    fn pyproject_alone_falls_through() {
        // Without a lockfile we can't pick a tool — better to do nothing than
        // guess. The user can configure user_command if they want auto-init.
        let d = TempDir::new().unwrap();
        touch(d.path(), "pyproject.toml");
        assert_eq!(detect(d.path()), InitKind::None);
    }

    #[test]
    fn detects_requirements_txt() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "requirements.txt");
        assert_eq!(detect(d.path()), InitKind::RequirementsTxt);
    }

    #[test]
    fn detects_cargo() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "Cargo.toml");
        assert_eq!(detect(d.path()), InitKind::CargoToml);
        assert_eq!(
            InitKind::CargoToml.command(d.path()).as_deref(),
            Some("cargo fetch")
        );
    }

    #[test]
    fn detects_go_mod() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "go.mod");
        assert_eq!(detect(d.path()), InitKind::GoMod);
    }

    #[test]
    fn empty_directory_is_none() {
        let d = TempDir::new().unwrap();
        assert_eq!(detect(d.path()), InitKind::None);
        assert!(InitKind::None.command(d.path()).is_none());
    }

    #[test]
    fn resolve_command_disabled_returns_none() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "package.json");
        let s = WorktreeInitSettings {
            enabled: false,
            ..Default::default()
        };
        assert!(resolve_command(d.path(), &s).is_none());
    }

    #[test]
    fn resolve_command_user_command_wins_over_detection() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "package.json");
        touch(d.path(), "pnpm-lock.yaml");
        let s = WorktreeInitSettings {
            user_command: Some("make setup".into()),
            ..Default::default()
        };
        let (cmd, kind) = resolve_command(d.path(), &s).unwrap();
        assert_eq!(cmd, "make setup");
        assert_eq!(kind, "user_configured");
    }

    #[test]
    fn resolve_command_detection_disabled_falls_through() {
        let d = TempDir::new().unwrap();
        touch(d.path(), "package.json");
        let s = WorktreeInitSettings {
            detection_enabled: false,
            ..Default::default()
        };
        assert!(resolve_command(d.path(), &s).is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_init_success_path() {
        let d = TempDir::new().unwrap();
        let tracker = ChildTracker::new();
        let outcome = run_init(
            d.path(),
            "echo installed",
            "package_json_pnpm",
            &WorktreeInitSettings::default(),
            HashMap::new(),
            &tracker,
            CancellationToken::new(),
        )
        .await;
        assert!(outcome.success);
        assert_eq!(outcome.exit_code, 0);
        assert_eq!(outcome.detection_kind, "package_json_pnpm");
        assert!(outcome.output.contains("installed"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_init_failure_path() {
        let d = TempDir::new().unwrap();
        let tracker = ChildTracker::new();
        let outcome = run_init(
            d.path(),
            "echo broken && exit 7",
            "user_configured",
            &WorktreeInitSettings::default(),
            HashMap::new(),
            &tracker,
            CancellationToken::new(),
        )
        .await;
        assert!(!outcome.success);
        assert_eq!(outcome.exit_code, 7);
        assert!(outcome.output.contains("broken"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_init_respects_wall_clock_timeout() {
        let d = TempDir::new().unwrap();
        let tracker = ChildTracker::new();
        let settings = WorktreeInitSettings {
            timeout_seconds: 1, // minimal — the subprocess module bumps to 1s min
            ..Default::default()
        };
        let outcome = run_init(
            d.path(),
            "sleep 30",
            "user_configured",
            &settings,
            HashMap::new(),
            &tracker,
            CancellationToken::new(),
        )
        .await;
        assert!(!outcome.success);
        assert!(outcome.output.contains("init aborted"));
    }

    #[test]
    fn detection_kind_strings_match_event_schema() {
        // Spot-check the wire strings — they're load-bearing for replay/audit.
        assert_eq!(InitKind::PackageJsonPnpm.as_str(), "package_json_pnpm");
        assert_eq!(InitKind::PyprojectUv.as_str(), "pyproject_uv");
        assert_eq!(InitKind::None.as_str(), "none");
    }
}
