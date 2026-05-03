# Brief for Claude Code: Reliability — Worktree Init, Non-Interactive Guarantees, Stall Detection

## Context

Three related problems block the app from being usable for real work:

1. **Worktrees aren't ready to run.** A fresh worktree has no `node_modules`, no virtualenv, no installed deps. The first phase that needs them (typecheck, test, even just imports) fails.
2. **Subprocesses can hang on interactive prompts.** Tools that prompt for input (`pnpm install`, `gh auth login`, npm package post-install scripts, anything reading stdin) wait forever because there's no human to respond. The agent appears to be working but is silently stalled.
3. **Phases can run unboundedly long.** A model going off the rails or stalled can burn tokens and time without ever completing or failing.

This brief addresses all three. It's prerequisite to dogfooding — without these, the pipeline appears unreliable in ways that are environmental, not architectural, and you'll waste dogfooding sessions debugging the wrong things.

**Prerequisites already in place:**

- Subprocess module with cancellation and output streaming (phase 2)
- Per-task worktrees auto-created on first phase (phase 3)
- `WorktreeCreated` event on Task aggregate
- Workspace settings system with `WorkspaceSettingsChanged` event
- Provider trait with permission mode configurable
- Recent events strip showing app activity

Read `docs/events.md` first.

## Goals

1. Worktrees are initialised (deps installed, env set up) automatically before the first phase runs.
2. Every subprocess the app spawns runs with stdin closed and non-interactive environment variables set, so subprocesses that would prompt either error fast or proceed with defaults.
3. Phases that produce no output for too long, or run too long overall, are killed with a clear failure reason.
4. All of the above is configurable per workspace with sensible defaults.

## Schema additions

Update `docs/events.md` and the implementation.

**`WorktreeInitialized`** — new event on Task aggregate. Emitted between `WorktreeCreated` and the first `PhaseRunStarted`.
- `command: string` — the actual command that ran
- `exit_code: i32`
- `duration_ms: u64`
- `output: string` — captured stdout+stderr; truncate to ~10KB if larger
- `detection_kind: "package_json_pnpm" | "package_json_npm" | "package_json_yarn" | "pyproject_uv" | "pyproject_poetry" | "requirements_txt" | "cargo_toml" | "go_mod" | "user_configured" | "none"` — what triggered this initialization

**`WorktreeInitializationFailed`** — new event on Task aggregate. Emitted when initialization runs but fails.
- `command: string`
- `exit_code: i32`
- `duration_ms: u64`
- `output: string`
- `detection_kind: string` (same enum as above)

When this fires, the pipeline does not auto-progress to the first phase. The user sees the error in the UI and can either fix the underlying issue and retry, or skip initialization for this task.

**`PhaseRunFailed`** — existing event. Add new variants to the `error_kind` enum:
- `"stalled_no_output"` — silence timeout exceeded
- `"stalled_wall_clock"` — total runtime exceeded
- `"non_interactive_eof"` — subprocess closed stdin and exited (this isn't an error per se, but worth distinguishing from a real crash)

Existing `error_kind` values remain.

**Workspace settings** extended via `WorkspaceSettingsChanged`:

```
{
  worktree_init: {
    enabled: bool,                       // default true
    detection_enabled: bool,             // default true; if false, only user_command is used
    user_command: string | null,         // override; if set, replaces detection
    timeout_seconds: integer,            // default 600 (10 min)
  },
  phase_timeouts: {
    silence_timeout_seconds: integer,    // default 300 (5 min)
    wall_clock_timeout_seconds: integer, // default 1800 (30 min)
  },
  subprocess: {
    additional_env: { [key: string]: string }  // user-defined env vars passed to all phase subprocesses
  }
}
```

These have defaults that work out of the box for most projects. The user only touches them if defaults are wrong.

## Milestones

### Milestone 1: Subprocess hardening

This is the first piece because everything else depends on it. Audit and harden the existing subprocess module.

**Required changes to `subprocess::run_streaming` (or whatever it's called):**

- **Stdin closed by default.** The function already takes `stdin_input: Option<String>`. When that's `None`, close stdin explicitly (don't leave it inherited or open). Use `Stdio::null()` for stdin in the `tokio::process::Command` config.
- **Default non-interactive environment variables** merged into every subprocess's env unless explicitly overridden by the caller:
  ```
  CI=true
  DEBIAN_FRONTEND=noninteractive
  NPM_CONFIG_YES=true
  npm_config_yes=true
  GH_PROMPT_DISABLED=1
  GIT_TERMINAL_PROMPT=0
  GIT_ASKPASS=                          // empty value disables credential prompts
  SSH_ASKPASS=
  PYTHONUNBUFFERED=1                    // makes Python output flush in real-time
  PIP_DISABLE_PIP_VERSION_CHECK=1
  PIP_NO_INPUT=1
  ```
  Implement this as a `default_env()` helper that returns a `HashMap`, merged with the caller's env (caller's env wins on conflict).
- **No TTY allocation.** Don't allocate a PTY. Subprocesses run with plain pipes. (You may already do this — verify.)

**Test additions:**

Write a test that proves a subprocess *can't* read from stdin:

```rust
// Spawn a process that tries to read stdin. Confirm it sees EOF immediately.
let result = run_streaming("sh", &["-c", "read line && echo got: $line || echo no_input"], ...).await?;
assert!(result.stdout.contains("no_input"));
```

This test is the canary — if anyone later changes the subprocess module to inherit stdin, the test catches it.

**Audit:** find every place in the codebase that spawns a subprocess outside `subprocess::run_streaming` (provider invocations, gate runs, git ops via `Command`, etc.) and confirm they go through the same module or apply equivalent hardening. If any spawn `tokio::process::Command` directly without these guarantees, fix them.

### Milestone 2: Project-type detection

A new module `worktree_init` that handles detection and initialization.

**Detection helpers:**

```rust
pub enum InitKind {
    PackageJsonPnpm,    // pnpm-lock.yaml present
    PackageJsonYarn,    // yarn.lock present
    PackageJsonNpm,     // package-lock.json or just package.json
    PyprojectUv,        // pyproject.toml + uv.lock
    PyprojectPoetry,    // pyproject.toml + poetry.lock
    RequirementsTxt,
    CargoToml,
    GoMod,
    None,
}

pub fn detect(worktree_path: &Path) -> InitKind;
```

The function looks for marker files in priority order. First match wins. The order matters — pnpm-lock takes precedence over package.json alone, etc.

**Init commands per kind:**

```
PackageJsonPnpm    → pnpm install --frozen-lockfile
PackageJsonYarn    → yarn install --frozen-lockfile
PackageJsonNpm     → npm ci  (if package-lock.json exists) else npm install
PyprojectUv        → uv sync
PyprojectPoetry    → poetry install
RequirementsTxt    → pip install -r requirements.txt   (relies on a venv being active or system pip)
CargoToml          → cargo fetch
GoMod              → go mod download
None               → no command runs; emit no event
```

These commands use frozen/locked variants where available — the worktree should match what the user has, not auto-update deps.

For Python `requirements.txt` and Cargo, no virtual env management is attempted. If the user's project needs a venv, they configure it via `user_command` instead.

### Milestone 3: Initialization integration

Wire the init flow into worktree creation.

When `WorktreeCreated` is emitted by the existing flow, before any phase runs:

1. Read workspace settings. If `worktree_init.enabled == false`, skip everything and proceed to first phase.
2. If `worktree_init.user_command` is set, use it. `detection_kind = "user_configured"`.
3. Otherwise, if `worktree_init.detection_enabled == true`, run `detect()`. If result is not `None`, build the appropriate command. `detection_kind` matches the detected kind.
4. If detection returns `None` and no user command, skip and proceed.
5. Run the chosen command via `subprocess::run_streaming` with `cwd` set to the worktree path, `timeout` set to `worktree_init.timeout_seconds`. Capture all output.
6. On success (exit 0): emit `WorktreeInitialized`. Pipeline proceeds to the first phase.
7. On failure: emit `WorktreeInitializationFailed`. Pipeline stops; user must intervene.

The init runs as part of the same task lifecycle. From the UI's perspective, "init" is a phase-like step that happens before phases — it shows up in the recent events strip and the task detail view.

### Milestone 4: Stall detection

Two timeouts in the subprocess module:

**Silence timeout.** If no output (stdout or stderr) has been produced for `silence_timeout_seconds`, kill the subprocess. Implement with a `tokio::time::sleep` reset every time output arrives, racing with process completion via `select!`.

**Wall-clock timeout.** Total elapsed time since spawn exceeds `wall_clock_timeout_seconds`. Same `select!` pattern — additional branch for the wall-clock timer.

When either fires:
- The process is killed (existing kill machinery from cancellation).
- The function returns a typed error: `SubprocessError::StalledNoOutput { duration_ms: u64 }` or `SubprocessError::StalledWallClock { duration_ms: u64 }`.

**Wiring into phases:**

The phase runner reads the workspace's `phase_timeouts` settings and passes them to `run_streaming` for every phase invocation. On stall, the phase runner translates the typed error into the appropriate `PhaseRunFailed` event variant.

The phase runner does *not* apply timeouts to gate runs or worktree init — those have their own timeouts (gate config has `timeout_seconds`, worktree init has its own). Each subprocess call sets its own timeouts based on its purpose.

### Milestone 5: UI surfacing

Three UI changes; small.

**Task detail view, init state.** When `WorktreeInitialized` exists, show a small collapsed item above the phase row: "✓ Initialized · `pnpm install` · 4.2s". Clickable to expand and show the captured output. Quiet state — most of the time you don't care.

When `WorktreeInitializationFailed` exists and no `WorktreeInitialized` followed it, show this prominently with the error: "✗ Initialization failed: `pnpm install` exited 1. See output." Expanded by default. With "Retry initialization" and "Skip and proceed to first phase" buttons. Both are Tauri commands; "skip" is a manual override that proceeds despite the init failure.

**Phase failure rendering.** When a phase ends in `PhaseRunFailed` with `stalled_no_output` or `stalled_wall_clock`, the UI shows this distinctly:

- `stalled_no_output`: "Phase killed: no output for {N} minutes. The agent may have been waiting for input or stuck."
- `stalled_wall_clock`: "Phase killed: ran for {N} minutes (timeout). The agent may have been stuck in a loop."

Both with a "Retry" button.

**Workspace settings UI.** A new "Reliability" or "Execution" section in workspace settings with controls for:
- Init enabled (toggle)
- Init detection enabled (toggle)
- Init user command (text input, with a help text noting that this overrides detection)
- Init timeout (number input, seconds)
- Phase silence timeout (number input, seconds)
- Phase wall-clock timeout (number input, seconds)
- Additional environment variables (key/value list, optional)

Defaults visible as placeholder text. Save calls `WorkspaceSettingsChanged` with the new settings.

### Milestone 6: Provider permission mode (verification)

You set up provider permission configuration in an earlier phase. This milestone is verification, not new work — but worth doing now while we're thinking about non-interactive operation.

Audit the provider invocation path:
- Confirm the workspace's permission mode setting is actually being passed to the provider's CLI invocation.
- Confirm the default for new workspaces is "bypass within worktree" or whatever permits agents to run typecheck/test/lint without prompting, but doesn't trust them with arbitrary network or filesystem operations.
- For Claude Code specifically: confirm the relevant flag (`--permission-mode bypassPermissions` or whatever the current name is) is set when the workspace's permission mode requires it.

If anything's missing, fix it. If it's all wired correctly, write a brief comment in the provider module explaining the permission flow so it's not lost knowledge.

## Conventions

- All subprocess invocations go through the hardened `subprocess::run_streaming`. No direct `Command::new` for any phase, gate, init, or provider invocation.
- Workspace settings defaults are sane out of the box. The settings UI is for power users; most users never touch it.
- Tauri events emitted **after** transaction commit. One `projection_updated` per affected aggregate.
- Typed errors with `thiserror` — new error variants added as needed.
- shadcn primitives for new UI elements.

## Out of scope

- Auto-detecting Python virtual environments (too many ways users do this; keep it explicit)
- Automatic dependency caching across worktrees (potentially valuable but a substantial separate piece — for now, each worktree installs deps independently)
- Detecting Docker / docker-compose projects and starting containers (too project-specific)
- Real-time progress streams for init commands (it's a black box for now; output shows on completion)
- Per-task init overrides (workspace-level only for v1)
- Graceful shutdown of init on app quit (kill it, accept that next run re-installs)
- Auto-retry on init failure (user explicitly retries)

## Deliverable

A working app where:

1. Adding a new task to a Node-based workspace triggers `pnpm install` (or equivalent) automatically before the first phase, with the install output captured.
2. A subprocess that tries to prompt for input fails fast instead of hanging.
3. A phase that produces no output for 5 minutes is killed with a clear "stalled, no output" error.
4. A phase that runs for 30 minutes is killed with a "stalled, wall clock" error.
5. Workspace settings UI lets the user override init behaviour, configure timeouts, and add custom env vars.
6. The task detail view shows initialization state and stall failures clearly.
7. `docs/events.md` reflects the new events and `error_kind` variants.

Plus tests on:
- The "subprocess can't read stdin" canary test (Milestone 1)
- Project type detection (a few synthetic worktrees, asserts the detected kind)
- Stall detection — both silence and wall-clock — using a synthetic long-running subprocess
- The init success and failure paths emitting the correct events

Commit after each milestone. Milestone 1 (subprocess hardening) is the foundation — get it right with the canary test before integrating with init or stall detection.
