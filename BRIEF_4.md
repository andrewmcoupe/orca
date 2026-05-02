# Brief for Claude Code: Multi-Phase Pipeline

## Progress so far (resume here)

**Done — M1 (schema and config plumbing), committed on `main` as `a70db4a`:**

- New `src-tauri/src/settings.rs` module: typed `WorkspaceSettings`,
  `PhaseConfig`, `GateConfig`, `PhaseType` enum. Serde-tolerant —
  missing pipeline fields materialise bundled defaults via
  `WorkspaceSettings::from_json_str`. Bundled `PhaseConfig::bundled_default()`
  is `{ phases: ["implementer", "auditor"], gate_overrides: None }`.
- `TaskCreated` bumped to **v3** with `phase_config` field. Resolved at
  create time in `commands::create_task` from a per-task override or
  the workspace's stored `default_phase_config`. Decision: no upcaster
  written; the v3 applier deserializes `phase_config` as `Option` and
  defaults to bundled when absent, so any v2 events on disk replay
  losslessly. (This diverges slightly from the brief's "wipe again"
  suggestion — preserved dev data instead.)
- New events: `TaskBaseCommitRecorded` (Task aggregate; payload
  `{ commit_sha }`) and `AuditorVerdictRendered` (PhaseRun aggregate;
  payload `{ phase_run_id, verdict, confidence, summary, concerns }`).
  Both have appliers in `events/projections.rs`.
- `task_projection` gains `phase_config TEXT NOT NULL DEFAULT '{}'`
  and `task_base_commit TEXT` columns. New `auditor_verdict_projection`
  table keyed by auditor `phase_run_id`, with `get_auditor_verdict`
  and `list_auditor_verdicts_for_task` reads.
- `WorkspaceSettingsChanged` applier unchanged (it stores raw JSON);
  tolerance is at read time via `WorkspaceSettings::from_json_str`.
  No command exists yet to emit `WorkspaceSettingsChanged` — that
  comes with M9's settings UI.
- `recent_events::summarize` extended for `TaskBaseCommitRecorded` and
  `AuditorVerdictRendered`.
- `docs/events.md` updated: TaskCreated v3 with PhaseConfig spec, the
  two new events, expanded `WorkspaceSettingsChanged` settings shape
  (default_phase_config, gates, phase_gates), PhaseRunStarted gains
  `prior_phase_commits`, `prompt_template_hash`, `is_retry_of`, GateRan
  gate_name no longer a closed enum and carries
  `triggering_phase_run_id`.
- Frontend `src/features/tasks/types.ts` gains `PhaseType`,
  `PhaseConfig`, and the new fields on `Task`. `tasksApi.create`
  accepts an optional `phaseConfig` override.

**Known state to be aware of when starting M2:**

- Existing per-workspace event DB at
  `/Users/andycoupe/web-dev/orchestrator/.orca/events.sqlite` was
  **not** wiped. It still has its old `task_projection` shape (no
  `phase_config` column). Run `rebuild_projections` against that
  workspace once before creating new tasks, otherwise the v3 applier
  will hit "no such column: phase_config" on insert.
- `cargo test --lib` is green (20 tests). `pnpm tsc --noEmit` is clean.
- `PhaseRunStarted` applier was **not** updated to consume the new
  optional fields (`prior_phase_commits`, `prompt_template_hash`,
  `is_retry_of`). The current applier struct only deserializes the
  fields it uses, so emitting them is a no-op at the projection level
  — fine for M1, but M3-M5 will need to either store them on
  `phase_run_projection` or read them off the events directly.
- `PhaseRunStarted` payload version was **not** bumped. Per the brief
  the new fields are additive; old events still replay. If a future
  milestone wants to enforce the new fields, bump there.
- The `auditor_verdict_projection` reads (`get_auditor_verdict`,
  `list_auditor_verdicts_for_task`) are currently dead code (compiler
  warning suppressed) — they wire up in M5/M8/M10 when the auditor
  emits and the UI reads.
- No Tauri commands yet for reading/writing workspace settings or for
  the new prompt/gate concepts — those land in later milestones.

**Done — M2 (prompt files and templating):**

- New `src-tauri/src/prompts/` module with `resolve`, `render`, `hash`,
  `save`, `reset`, `is_customised`, `prompt_file_path`, `bundled_default`,
  `ensure_prompts_dir`. Templating via `handlebars` crate; hash is hex
  SHA-256 (`sha2`).
- Bundled defaults at `src-tauri/src/prompts/defaults/{test_author,implementer,auditor}.md`,
  embedded at compile time via `include_str!`. Each file leads with a
  Handlebars comment block listing the available variables. Implementer's
  default includes the `prior_phase_commits.test_author` conditional block;
  the auditor's default includes the `git_diff` block at the end. The
  user's "validated" prompt bodies were not provided in the brief — wrote
  reasonable working defaults; user can edit per-workspace via the M9 UI.
- `PromptContext` matches the brief's shape exactly: `task_title`,
  `task_spec_markdown`, `acceptance_criteria`, `prior_phase_commits`,
  `git_diff: Option<String>`, `is_retry: bool`, `retry_context: Option<String>`.
  `Default` impl provided so phases that don't use every field can build
  the context easily.
- `Handlebars` configured with `set_strict_mode(false)` (missing vars
  render empty, matching the brief's tolerance) and `no_escape` (auditor
  diffs contain `<` `>` `&` and must not be HTML-escaped).
- `<workspace>/.orca/prompts/` is created on workspace activation —
  `open_workspace_db` calls `prompts::ensure_prompts_dir`. Prompt path
  uses `WORKSPACE_DIR` (`.orca`); the brief's `.yourapp/` was a placeholder.
- Tauri commands: `get_prompt(phase)`, `save_prompt(phase, content)`,
  `reset_prompt(phase)`. All operate on the active workspace
  (consistent with how every other per-workspace command works in this
  codebase — the brief's `(workspace_id, phase)` signature was advisory).
  `get_prompt` returns `{ phase, content, is_customised }`.
- `PhaseType::parse(&str) -> Option<Self>` added so commands can take the
  phase as a string.
- Tests (12, all green): variable substitution, `{{#if}}` blocks, nested
  `prior_phase_commits.test_author` resolution, no-HTML-escaping for
  diffs, full implementer + auditor template renders, hash stability /
  uniqueness / format, resolve fallback to bundled, save→resolve
  round-trip, reset removes file + idempotent on missing file, all
  bundled defaults non-empty.
- `cargo build --lib` clean, `cargo test --lib` green (32 tests, 20
  prior + 12 new).
- New crate deps: `handlebars = "5"`, `sha2 = "0.10"`.

**Known state for M3 (test-author phase):**

- No frontend `promptsApi` yet — added in M9 alongside the editor UI.
- The `prompt_template_hash` field on `PhaseRunStarted` is still produced
  by phase runners themselves; M3-M5 will switch from
  `PROMPT_TEMPLATE_ID = "implementer.v1"` (hardcoded in
  `phases/implementer.rs`) to `prompts::resolve(...)` →
  `prompts::render(...)` → `prompts::hash(...)` and emit the hash.
- The implementer phase still uses its own ad-hoc `build_prompt`
  function. M4 swaps it for `prompts::resolve`/`render`. Left untouched
  in M2 to keep the diff focused.

**Done — M3 (test-author phase):**

- New `src-tauri/src/phases/test_author.rs`. Mirrors the structure of
  `phases/implementer.rs` but: resolves and renders the bundled
  test-author prompt via `prompts::resolve` + `prompts::render` before
  the worktree dance (so a templating error fails fast); commits with
  message `[phase: test_author] {task_title}`; uses
  `system:test_author` as the actor in event metadata.
- `PhaseRunStarted` payload includes `prompt_template_hash` (SHA-256 of
  the rendered prompt) instead of the legacy `prompt_template_id`. The
  applier struct in `events/projections.rs` only deserializes the
  fields it cares about, so this is forward-compatible without an
  applier change. Implementer still emits the legacy
  `prompt_template_id` — M4 will switch it over.
- Empty-commit guard: relies on `worktree::commit_all`, which already
  detects an unchanged tree and returns the parent commit SHA without
  creating a commit. Surfaced uniformly across both phases.
- `start_real_phase` now accepts `phase = "test_author"` and dispatches
  to the right runner. Other phase names still error out.
- Test-author has no prior phase commits and no diff, so its
  `PromptContext` is just `{ task_title, task_spec_markdown,
  acceptance_criteria }`; everything else is `Default`.
- Did NOT factor out a shared subprocess-phase helper between
  test_author and implementer yet — most of the runner is duplicated.
  M4 is the natural moment to extract a `runner::run_subprocess_phase`
  once we know what implementer needs from the new prompt context.
- `cargo build --lib` clean, `cargo test --lib` green (32 tests).

**Done — M4 (implementer phase updates):**

- `phases/implementer.rs` now resolves and renders its prompt via the
  `prompts` module (PhaseType::Implementer), the same way test_author
  does. Removed the ad-hoc `build_prompt` and the legacy
  `PROMPT_TEMPLATE_ID = "implementer.v1"` constant.
- `ImplementerInput` gains `is_retry: bool` and `retry_context:
  Option<String>` (used by M8's `pass_back_to_implementer`). The current
  `start_real_phase` dispatcher passes `false` / `None` — manual
  invocations are always fresh attempts.
- The `phase` field on the input is preserved for the dispatcher's sake
  but unused by the runner; the runner emits a constant `PHASE_NAME =
  "implementer"` on its events instead. Ditto for the commit message,
  which is now `[phase: implementer] {task_title}` regardless.
- New `phases/implementer.rs::started_payload` carries
  `prompt_template_hash`, `prior_phase_commits`, and `is_retry` on
  `PhaseRunStarted`. (test_author still has its own simpler started
  payload — it never has prior phases.)
- `prior_phase_commits` is built from `phase_run_projection` via the
  new helper `events::projections::prior_phase_commits(conn, task_id)`,
  which takes the most recent `head_commit_after` for each phase that
  has at least one completed run on this task.
- **Schema**: `phase_run_projection` gains a `head_commit_after TEXT`
  column. `PhaseRunCompleted` applier now persists it.
  `PhaseRunCompletedPayload` deserializes the field as `Option<String>`
  (legacy events without the field replay cleanly).
  `PhaseRunProjection` Rust struct gets the field too.
- `list_phase_runs_for_task` query updated to read the new column.
- Existing dev DB note (still relevant): if there's a per-workspace
  events.sqlite predating M4, run `rebuild_projections` so the
  `phase_run_projection.head_commit_after` column materialises before
  starting new phases. Otherwise the applier hits "no such column".
- The implementer's bundled prompt's `{{#if prior_phase_commits.test_author}}`
  block now renders correctly: when a test_author phase has run and
  succeeded for this task, the prompt instructs the implementer to read
  the failing tests from that commit.
- `cargo build --lib` clean, `cargo test --lib` green (32 tests).

**Done — M5 (auditor phase):**

- New `phases/auditor.rs`. Reads the task's `task_base_commit` (set by
  `TaskBaseCommitRecorded` — see below), computes
  `worktree::diff_against_base(...)`, truncates to 50 KB via
  `worktree::truncate_diff(...)`, and renders the auditor prompt with
  `git_diff` + `prior_phase_commits` populated.
- The provider trait stays streaming-only for v1. The auditor's
  `invoke_and_parse` runs the same subprocess flow as the other phase
  runners, accumulates the streamed text, then attempts to extract a
  verdict JSON object. Three parse strategies, in order: whole text →
  fenced ```json``` block → largest balanced top-level `{...}`. On
  failure, the auditor retries the subprocess once with a clarifying
  suffix asking for JSON only. After two failed attempts it emits
  `PhaseRunFailed` with `error_kind = "auditor_parse_error"` and the
  truncated raw response in `error_message`.
- On success: empty-commit guard via `worktree::commit_all` (the
  auditor may modify code as part of review), then `PhaseRunCompleted`
  with `head_commit_after`, then `AuditorVerdictRendered` with
  `{ phase_run_id, verdict, confidence, summary, concerns }` matching
  the M1 schema. The applier for `AuditorVerdictRendered` is the one
  added in M1.
- New helpers in `worktree.rs`:
  - `diff_against_base(worktree_path, base_sha) -> String` — git2
    tree-to-tree patch text.
  - `truncate_diff(diff, max_bytes, base_sha) -> String` — UTF-8-safe
    truncation with the brief's "...diff truncated, X bytes total. The
    full diff can be inspected by running `git diff
    {base_commit}..HEAD` in the worktree." marker appended.
- `TaskBaseCommitRecorded` now actually fires. Both implementer and
  test_author runners emit it immediately after `WorktreeCreated`,
  with `commit_sha = info.head_commit`. Idempotent in practice because
  the worktree is created exactly once per task. The auditor reads
  `task.task_base_commit` (falling back to `worktree_base_commit` for
  pre-M5 tasks) as the diff anchor.
- `start_real_phase` dispatcher accepts `phase = "auditor"` and routes
  to the new runner. Other phase names still error.
- The auditor doesn't accept retry plumbing — auditor retries are
  handled by the pipeline (M7) re-emitting a fresh phase run, not by
  passing context through the runner.
- Tests (11 new):
  - `parse_verdict` strategies (4 happy paths + garbage + braces inside
    strings).
  - `truncate_for_error_caps_length`.
  - Worktree diff tests (added file shows up, empty when unchanged,
    truncate marker, passthrough when small).
- `cargo build --lib` clean, `cargo test --lib` green (43 tests, 32
  prior + 11 new).

**Done — M6 (gate runner):**

- New `src-tauri/src/gates.rs` module: `pub async fn run_gate(
  worktree_path, gate_name, gate_command, timeout, triggering_phase_run_id,
  tracker) -> Result<GateResult, GateError>`.
- Commands run via the platform shell (`sh -c` on Unix, `cmd /C` on
  Windows) so user gate commands can use `&&`, pipes, env-var
  expansion etc. naturally — important since the brief explicitly
  wants "user writes `pnpm test` (or `pytest`, or `cargo test`) and it
  Just Works".
- Output: combined stdout+stderr accumulated into a single string,
  capped at 64 KB with a "[gate output truncated]" suffix when the
  cap is hit.
- Timeout: a side timer fires `cancel.cancel()` on the existing
  subprocess cancellation token, and a flag distinguishes timeout-fail
  from clean non-zero exit. `GateResult` carries `timed_out: bool`.
- Non-zero exits are NOT errors — they're a normal failed-gate
  outcome. Only spawn failure produces `Err(GateError::SpawnFailed)`.
- `GateResult` shape: `{ gate_name, passed, output, duration_ms,
  exit_code, timed_out, triggering_phase_run_id }`. The orchestrator
  in M7 will translate this into a `GateRan` event on the phase_run
  aggregate. `GateError` and `GateResult` are marked
  `#[allow(dead_code)]` for now — fields wire up in M7.
- Tests (4): pass on zero exit, fail on non-zero exit, shell chaining
  (`echo x && echo y`), timeout fires and reports `timed_out=true`
  with the timeout marker in the output. `cargo test --lib` green
  (47 tests, 43 prior + 4 new).
- The events.md schema and `phase_run_gate` projection table already
  carry `gate_name, passed, output, duration_ms` from prior work — no
  schema change needed in M6. M1's note about "GateRan...carries
  `triggering_phase_run_id`" still holds: the runner returns it on
  GateResult; M7 will include it on the emitted event payload (current
  applier ignores extra fields, so adding it is additive).

**Next: M7 (pipeline orchestrator — `start_task`, `on_phase_completed`,
auto-progression, gate hooks, auditor verdict gating).**

## Context

The app currently runs a single phase (implementer) per task. This brief turns that into a real pipeline: configurable phases per task, real test-author and auditor phases, gate runners, structured auditor verdicts, editable prompts, and the UI to drive it all.

This is the product-defining phase. Until this lands, the app is "claude in a window with an event log." After this, it's an actual orchestrator.

**Prerequisites already in place:**

- Plan / Task / PhaseRun aggregates with their projections
- Per-task git worktrees, lazy-created on first phase, branch `yourapp/<task_id>`
- Auto-commit per phase with `head_commit_after` recorded; structured commit messages
- TanStack Router (code-based) with the workspace → plan → task hierarchy
- shadcn/ui with Tailwind v4
- Provider trait with `claude` working; `codex` not yet implemented (still out of scope for this brief)
- Subprocess module with cancellation, output streaming, orphan cleanup
- Recent events strip at the bottom of the app

Read `docs/events.md` first. You'll be updating it as part of this work.

## Goals

1. Phases are configurable per task (which phases run, in what order). Workspace-level defaults that tasks inherit and can override.
2. Three real phases working: test-author, implementer, auditor. Auditor uses structured output for its verdict.
3. Gates configurable per workspace, runnable after specific phases, tech-stack-agnostic.
4. Editable prompts per phase, stored as files in the workspace, with template variable substitution.
5. Empty-commit guard across all phases.
6. UI for: phase configuration, prompt editing, gate config, auditor verdict display, retry/reject actions on auditor failure.

## Design notes (read before implementing)

**Pipeline progression is mostly auto, decisions are user-driven.** When a phase completes successfully, the orchestrator auto-starts the next phase. When a phase fails, or the auditor returns `revise` or `reject`, the pipeline stops and waits for the user. No automatic retries, no retry budgets — the user clicks "retry" / "pass back to implementer" / "reject" / "approve anyway" explicitly.

**Phases are configurable, not pluggable.** The phase types (`test_author`, `implementer`, `auditor`) are a closed enum. What's configurable is *which phases run for a given task* and *in what order*. Adding new phase types is a code change, not a config change.

**Auditor verdict and pipeline progression are separate events.** The auditor's `PhaseRunCompleted` records that the auditor finished. A separate `AuditorVerdictRendered` event records the verdict. The pipeline orchestrator reads the verdict event to decide what to do next.

**Prompts are files in the workspace, templated at runtime.** Default prompts ship bundled. On first edit, a file is written to `<workspace>/.yourapp/prompts/{phase}.md`. The runtime reads from the file if it exists, falls back to bundled default otherwise. Templates use Handlebars syntax (or equivalent — pick a Rust crate, `handlebars` is fine).

**Gates are commands, not primitives.** Gate config is `{ name, command, timeout }`. A gate "passes" if its command exits 0. The app doesn't care whether it's `pnpm test`, `pytest`, or `cargo test` — it runs the configured command from the worktree directory and checks the exit code.

## Schema additions

Update `docs/events.md` and the implementation accordingly.

### Task aggregate

**`TaskCreated`** — gains:
- `phase_config: PhaseConfig` — the phase config for this task. If absent, inherits workspace default at task-creation time (resolved at create time, not at runtime — events are immutable, the config at creation is the config that stuck).

`PhaseConfig`:
```
{
  phases: ["test_author" | "implementer" | "auditor", ...],   // ordered list
  gate_overrides: { [phase: string]: string[] } | null         // phase -> gate names; if null, use workspace default
}
```

**`TaskBaseCommitRecorded`** — emitted when the worktree is created for a task. Captures the commit the worktree was created from. This is the reference point for "the diff for this task."
- `commit_sha: string`

### PhaseRun aggregate

**`PhaseRunStarted`** — gains:
- `prior_phase_commits: { [phase_name: string]: string }` — map of phase type to `head_commit_after` for prior completed phases on this task. Populated by the phase runner.
- `prompt_template_hash: string` — content hash of the resolved prompt at the moment of execution. Replaces (or supplements) `prompt_template_id`.
- `is_retry_of: string | null` — the `phase_run_id` this is a retry of, when applicable.

**`AuditorVerdictRendered`** — new event. Emitted after the auditor's `PhaseRunCompleted`, by the auditor phase runner.
- `phase_run_id: string` — the auditor phase run that produced this
- `verdict: "approve" | "revise" | "reject"`
- `confidence: number` — 0.0 to 1.0
- `summary: string`
- `concerns: Array<{ category: string, severity: "blocking" | "advisory", anchor: { path: string, line: number } | null, rationale: string, reference_proposition_id: string | null }>`

### Workspace aggregate

**`WorkspaceSettingsChanged`** — settings now include:
- `default_phase_config: PhaseConfig`
- `gates: { [name: string]: { command: string, timeout_seconds: number } }`
- `phase_gates: { [phase_name: string]: string[] }` — which gates run after which phases

### Schema versioning

`TaskCreated` bumps to v3 (was v2). No upcaster needed — there are no v2 events on disk in production yet (or wipe again if there are dev events; you've done this before).

## Milestones

### Milestone 1: Schema and config plumbing

- Update `docs/events.md` with the new events and field changes.
- Update Rust event types and serialization.
- Update `task_projection` to include `phase_config` (serialize the JSON; deserialize on read).
- Update `WorkspaceSettingsChanged` applier to handle the new settings shape. If existing workspace settings don't have the new fields, populate with sensible defaults on read (this is the one place where reading old data must be tolerant — populate in-memory defaults rather than failing).
- Bundled defaults:
  - `default_phase_config`: `{ phases: ["implementer", "auditor"], gate_overrides: null }`
  - `gates`: empty (user configures per workspace)
  - `phase_gates`: empty

### Milestone 2: Prompt files and templating

- Add `<workspace>/.yourapp/prompts/` to the directories created on workspace activation.
- Create a `prompts` Rust module:
  - `pub fn resolve(workspace_path: &Path, phase: PhaseType) -> Result<String, PromptError>` — reads from `<workspace>/.yourapp/prompts/{phase}.md` if present, otherwise returns bundled default.
  - `pub fn render(template: &str, context: &PromptContext) -> Result<String, PromptError>` — Handlebars substitution.
  - `pub fn hash(rendered: &str) -> String` — content hash for `prompt_template_hash`.
- Bundled default prompts go in `src-tauri/src/prompts/defaults/{phase}.md`, embedded at compile time (`include_str!`).
- Use the prompts in the Provided Prompts section of this document, with the variable templating modifications described.
- `PromptContext` shape (keep this simple — it's the variables available to all prompts):
  ```rust
  struct PromptContext {
      task_title: String,
      task_spec_markdown: String,
      acceptance_criteria: String,         // for now, same as task_spec_markdown — can split later
      prior_phase_commits: HashMap<String, String>,
      git_diff: Option<String>,            // populated for auditor; None for others
      is_retry: bool,
      retry_context: Option<String>,        // auditor concerns from prior verdict
  }
  ```
- Document the available variables at the top of each bundled default prompt as a comment block. Users editing prompts can see what they have access to.
- Tauri commands:
  - `get_prompt(workspace_id, phase)` — returns the current resolved prompt content (file or default) and a flag indicating whether it's been customised.
  - `save_prompt(workspace_id, phase, content)` — writes the file.
  - `reset_prompt(workspace_id, phase)` — deletes the file (next read returns default).

### Milestone 3: Test-author phase

- Implement test-author phase in `phases/test_author.rs`.
- Uses the bundled test-author prompt with `task_title` and `acceptance_criteria` variables.
- Runs claude in the worktree with the rendered prompt as input.
- Streams output as `PhaseRunOutputAppended` events.
- On completion, runs the empty-commit guard: `git status --porcelain` (or `git2` equivalent). If clean, skip commit; emit `PhaseRunCompleted` with `head_commit_after = base_commit`. If dirty, commit with message `[phase: test_author] {task_title}` and emit `PhaseRunCompleted` with the new commit SHA.

### Milestone 4: Implementer phase updates

- Update implementer phase to use the new prompt template with the full variable set.
- Specifically, the prompt now includes `prior_phase_commits.test_author` (when present) so the implementer knows where to find the tests.
- On retry, `is_retry: true` and `retry_context` populated with the auditor's concerns from the prior verdict. The prompt includes a section addressing the retry context.
- Empty-commit guard same as test-author.
- Phase runner populates `prior_phase_commits` on `PhaseRunStarted` from the task's prior phase runs (read from projection).

### Milestone 5: Auditor phase

- Implement auditor phase in `phases/auditor.rs`.
- Computes the diff: `git diff {task_base_commit}..HEAD` from the worktree. If the diff is larger than ~50KB, truncate with a message ("...diff truncated, X bytes total. The full diff can be inspected by running `git diff {base_commit}..HEAD` in the worktree.").
- Renders the prompt with `git_diff` and `acceptance_criteria` populated.
- Runs claude *with structured output*. The provider trait needs an extension here: the existing `invoke` flow returns text; we need a way to invoke with a tool/function definition and receive a structured object back.
  - Add `invoke_structured(prompt, schema) -> Result<serde_json::Value, ProviderError>` to the provider trait.
  - For claude, this means using claude CLI's tool-use mode (or whatever invocation pattern produces structured output reliably). If the CLI doesn't support this directly, fall back to: run normally, parse JSON from response, retry once on parse failure, then escalate.
  - The schema corresponds to the `AuditorVerdict` struct (matches the `AuditorVerdictRendered` payload).
- After getting the verdict, emit `PhaseRunCompleted` (auditor may modify code as part of review — empty-commit guard still applies), then emit `AuditorVerdictRendered` with the parsed verdict.
- If verdict parsing fails entirely (after one retry), emit `PhaseRunFailed` with `error_kind: "auditor_parse_error"`.

### Milestone 6: Gate runner

- Implement `gates` Rust module.
- `pub async fn run_gate(workspace_path, gate_name, gate_command, timeout, triggering_phase_run_id) -> GateResult`
- Spawns subprocess via the existing subprocess module, captures output, exit code, duration.
- Emits `GateRan` event with `passed: bool`, `output: string`, `duration_ms`, `triggering_phase_run_id`.
- Pipeline orchestrator (Milestone 7) calls `run_gate` after each phase as configured.

### Milestone 7: Pipeline orchestrator

This is the heart of this brief. A new `pipeline` Rust module that owns "what happens next."

- `pub async fn start_task(task_id) -> Result<(), PipelineError>` — kicks off the task's first phase.
- `pub async fn on_phase_completed(phase_run_id) -> Result<(), PipelineError>` — called when any phase emits `PhaseRunCompleted`. Decides what's next.
- The `on_phase_completed` logic, in order:
  1. Read the task's `phase_config`.
  2. Identify the completed phase. Check if any gates are configured to run after it.
  3. If gates are configured, run them sequentially. On gate failure, stop the pipeline (don't progress) and emit no further events. The user sees the gate failure in the UI and decides what to do.
  4. If the completed phase is the auditor, wait for `AuditorVerdictRendered` (which arrives shortly after `PhaseRunCompleted` for the auditor). Read the verdict. If `approve`, the task pipeline is complete (auto-progression stops; user can approve and merge). If `revise` or `reject`, the pipeline stops and waits for user action.
  5. Otherwise, identify the next phase in the task's `phase_config`. Start it.
- Wiring: the existing event-emission pipeline gains a hook. After the projection_updated event for `PhaseRunCompleted`, the pipeline orchestrator's `on_phase_completed` is invoked. Async; doesn't block the event flow. Errors logged but don't propagate up.

### Milestone 8: Auditor failure UI actions

When the auditor returns `revise` or `reject`, three actions are available in the task detail view:

- **Pass back to implementer** — creates a new implementer phase run with `is_retry: true` and `retry_context` set from the auditor's concerns. Pipeline auto-runs from there.
- **Reject** — emits `TaskCancelled` with `reason: "auditor_rejected"`.
- **Approve anyway** — manual override. Marks the task as approved despite the auditor's verdict. Implementation: emit `TaskApproved` (this event already exists). The auditor's verdict remains in history.

These are Tauri commands: `pass_back_to_implementer(task_id)`, `reject_task(task_id)`, `approve_task_anyway(task_id)`.

The same UI also shows the auditor's verdict prominently: verdict badge (approve/revise/reject), confidence percentage, summary, and the list of concerns with their anchors clickable (open the file at the line in the worktree — `Command::new("code").arg("--goto").arg(format!("{}:{}", path, line))`).

### Milestone 9: Configuration UI

Three settings panels, accessed from workspace settings:

**Phase config (workspace defaults).** UI to choose the default phase order. Drag-and-drop or simple checkboxes-with-order. For v1, simple is fine: checkboxes for "include test_author", "include implementer", "include auditor", with the order fixed (test_author always first, auditor always last, implementer always in the middle if included). Implementer is required; the others are optional. Save updates `default_phase_config`.

**Gate config.** A table of gates with name, command, timeout. Add/remove rows. Plus a `phase_gates` section: for each phase, a multiselect of which gates run after it.

**Prompts.** Three textareas (one per phase) showing the current resolved prompt. "Reset to default" button per phase. Save calls `save_prompt`. Document the available variables in a help panel above the editor.

Per-task phase config override: on the task creation dialog, an "Advanced" disclosure that lets you override the workspace default. Most users won't touch this; tasks created through the quick-task shortcut just inherit.

### Milestone 10: Pipeline visualisation

The task detail view's phase row already shows phase cards. Update for the pipeline reality:

- Cards for *all* phases in the task's `phase_config`, not just completed ones. Pending phases shown in muted state.
- Active phase shown with a subtle pulse.
- Arrows between cards.
- Each card shows: phase name, status, model used, duration if completed, link to phase run detail.
- Below the cards: a "Phase runs" expandable list showing every phase run in chronological order, including retries. Each retry shows its `is_retry_of` link to the prior attempt. This is the audit trail.
- When an auditor verdict exists for the latest auditor run, show it prominently as a separate section above the phase cards: verdict badge, confidence, summary, concerns list, action buttons.

## Conventions

- Read and update `docs/events.md` before implementing.
- Tauri events emitted **after** transaction commit. One `projection_updated` per affected aggregate.
- Cross-aggregate updates (Task applier updating Plan projection counts when phase runs change task state) happen in the same transaction.
- TanStack Query for all reads, Tanstack Router for all navigation. No route loaders.
- Typed errors with `thiserror`. No `anyhow` in library code.
- Empty-commit guard is a phase-agnostic helper used by every phase's commit step.
- Auto-progression in the pipeline is best-effort. Failures are logged, never propagated to user-facing errors directly. The UI reads state from projections; if the orchestrator quietly stops, the user sees a phase that didn't progress and can intervene.
- shadcn primitives for new UI. Use `react-markdown` for rendering plan descriptions and any markdown content.

## Out of scope

- Automatic retries / retry budgets (user-driven for now)
- `codex` provider (next phase)
- Real merge logic (still stubbed; comes later)
- Test framework auto-detection for gates (user configures gates explicitly)
- PRD ingestion (next phase)
- Linear / external integrations
- Per-task gate overrides (in the schema as `gate_overrides`, but UI is workspace-level only for v1)
- Confidence threshold gating (auditor's confidence shown but doesn't gate progression)
- Notification on phase completion (would be nice, defer)

## Provided Prompts (use as bundled defaults)

These are the prompts the user has already validated against real usage. Port them as bundled defaults at `src-tauri/src/prompts/defaults/{phase}.md`. The prompts are mostly portable as-is with the variable substitution wrapped around them.

The structure for each bundled default file:

```
{{!-- Available variables: task_title, acceptance_criteria, prior_phase_commits, is_retry, retry_context, git_diff (auditor only) --}}

[the prompt content from the user]

## Acceptance Criteria

{{acceptance_criteria}}

{{#if is_retry}}
## Retry Context

The previous attempt was not approved. The auditor's concerns:

{{retry_context}}
{{/if}}
```

For the **implementer prompt specifically**, add this conditional block before the Acceptance Criteria:

```
{{#if prior_phase_commits.test_author}}
## Tests

The test-author has written failing tests in commit `{{prior_phase_commits.test_author}}`. Read these tests with `git show {{prior_phase_commits.test_author}}`. Your job is to make them pass.
{{/if}}
```

For the **auditor prompt specifically**, add at the end:

```
## Diff to audit

{{git_diff}}

## Acceptance Criteria

{{acceptance_criteria}}
```

The user's original prompt content is preserved verbatim — only the variable injection is added at the appropriate locations.

[Test-author, implementer, and auditor prompt content as provided in the conversation]

## Deliverable

A working app where:

1. A workspace has configurable default phase config, gate definitions, and per-phase gate assignments.
2. A task created in the workspace inherits the default phase config; an "Advanced" panel on task creation lets the user override.
3. Running a task with `[test_author, implementer, auditor]` configured causes all three to run in sequence, with each phase's commit referenceable from the next.
4. The auditor produces a structured verdict that's stored as an event and displayed in the UI with confidence percentage and clickable concerns.
5. On `revise` or `reject` verdict, the user has three buttons: pass back to implementer (with auditor's concerns in the retry prompt), reject (cancels the task), or approve anyway.
6. Gates configured to run after a phase actually run after that phase, and gate failures stop the pipeline.
7. Prompts can be edited per workspace, persisted as files, and reset to defaults.
8. The empty-commit guard prevents empty commits across all phases.
9. The task detail view shows the full pipeline state: pending phases, active phase, completed phases, retries, and auditor verdict prominently.
10. `docs/events.md` reflects all schema additions.

Plus tests on:
- The pipeline orchestrator's `on_phase_completed` decision logic (state transitions are exactly the place a subtle bug would silently break the pipeline).
- The empty-commit guard.
- Prompt template rendering with the full variable set.

This is a meaty phase. Commit after each milestone — the milestones are deliberately scoped to be commit-sized. Milestones 1-2 are foundation, 3-5 are individual phases, 6-7 are pipeline glue, 8-10 are UI.
