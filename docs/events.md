# Event Schema

Design doc for the event-sourced core. **Events are forever; projections are disposable.** Spend design care on event shape; be relaxed about projections.

## Principles

- Events are facts. Past tense, immutable, describe what happened — never what should happen.
- Append-only. Events are never updated or deleted in normal operation.
- Additive evolution only. New fields are optional with defaults; never rename or remove fields.
- Per-workspace event store. Each workspace has its own SQLite database at `<repo>/.yourapp/events.sqlite`. The global app db holds workspace registrations and app-level settings, nothing else.
- Projections are derived state. They can be dropped and rebuilt from events at any time.

## Aggregates

Four aggregates. Each has a stable ULID and its own ordered event stream. Cross-aggregate consistency is eventual; within an aggregate, events are strictly ordered by `seq`.

### Workspace

Coarse-grained, rarely emits events. Represents a registered repo and its settings. Lives in the global app db (one row per workspace) and emits the few events listed below.

### Plan

A plan groups related tasks and carries shared context — a PRD, a Linear ticket, or an ad-hoc grouping. Has its own lifecycle independent of tasks: a plan can be paused or cancelled even while tasks are idle. Tasks always belong to exactly one plan; the manual one-off task case is modelled as a single-task plan (see UX shortcut in the route layer).

### Task

A task is a unit of work belonging to a plan. It owns its lifecycle from creation through merge or cancellation. The PRD section or external ticket that motivated the task lives on the parent Plan, not on the Task itself.

### Briefing

A briefing is a long-lived aggregate that captures the iterative plan-generation flow. The user describes a feature; a CLI provider produces a structured draft (title, description, tasks with relevant files, assumptions); the user edits inline, pushes back on assumptions, and iteratively refines. On acceptance, the briefing produces a Plan and N Tasks (each with its `relevant_files`). The briefing's event log doubles as an audit trail for "why does this plan look the way it does."

### PhaseRun

A single execution of one phase (test-author, implementer, auditor) against one task with a specific provider and model. Modeled as its own aggregate rather than as events on Task because phase runs are self-contained, retriable, and comparable across models. A task has many phase runs over its lifetime.

## Event catalog

All events carry standard fields (`id`, `aggregate_type`, `aggregate_id`, `seq`, `event_type`, `version`, `created_at`, `metadata`) plus an event-specific `payload`. Only payload fields are documented below.

### Workspace events

**WorkspaceRegistered** — workspace added by user.
- `path: string` — absolute path on disk
- `name: string` — display name (defaults to repo dir name)

**WorkspaceSettingsChanged** — settings updated.
- `settings: object` — full new settings snapshot (not a diff — simpler to reason about). Pipeline-relevant fields:
  - `default_phase_config: PhaseConfig` — phase config that new tasks inherit at creation time. Bundled default: `{ phases: ["implementer", "auditor"], gate_overrides: null }`.
  - `default_phase_settings: { [phase_name]: { model?: { provider, model }, permission_mode?: "plan" | "acceptEdits" | "bypassPermissions" } }` — per-phase defaults that new tasks inherit. Either field may be absent (in which case the bundled default applies: `acceptEdits` for `test_author`/`implementer`, `plan` for `auditor`; no model — provider picks). The auditor entry is treated as `acceptEdits` if it somehow holds `bypassPermissions` — defence-in-depth against stale settings. Bundled default: empty map.
  - `default_models: { [phase_name]: { provider, model } }` — legacy per-phase model defaults. Superseded by `default_phase_settings[phase].model` but retained for back-compat with workspaces written before per-phase permission modes landed. Readers prefer `default_phase_settings` and fall back here.
  - `skip_preview_for_quick_tasks: boolean` — when true, the ⌘N quick-task dialog skips the per-phase preview screen and runs the task immediately. Default `false` so users see exactly what's about to run while building a mental model of the modes.
  - `gates: { [name]: { command: string, timeout_seconds: integer } }` — named gate definitions. Bundled default: empty.
  - `phase_gates: { [phase_name]: string[] }` — which gates run after which phases. Bundled default: empty.
  - `worktree_init: { enabled: bool, detection_enabled: bool, user_command: string | null, timeout_seconds: integer }` — controls the M3 init step that runs after `WorktreeCreated`. Bundled defaults: `{ enabled: true, detection_enabled: true, user_command: null, timeout_seconds: 600 }`.
  - `phase_timeouts: { silence_timeout_seconds: integer, wall_clock_timeout_seconds: integer }` — applied to every phase subprocess. Bundled defaults: `{ silence_timeout_seconds: 300, wall_clock_timeout_seconds: 1800 }`.
  - `subprocess: { additional_env: { [key]: string } }` — user-defined env vars merged into every phase subprocess (caller env wins on conflict). Bundled default: empty.

  Readers parse settings tolerantly: missing pipeline fields materialise as bundled defaults rather than failing. Other settings keys (theme, etc.) are preserved verbatim.

`PhaseConfig`:
```
{
  phases: ("test_author" | "implementer" | "auditor")[],   // ordered list
  gate_overrides: { [phase_name]: string[] } | null,        // per-phase gate name overrides; null = use workspace default
  models?: { [phase_name]: { provider, model } } | null,    // per-phase model overrides; missing entries inherit workspace default
  permission_modes?: { [phase_name]: "plan" | "acceptEdits" | "bypassPermissions" } | null   // per-phase permission mode overrides; missing entries inherit workspace default. The auditor never accepts `bypassPermissions` — invalid values fall through to the workspace default.
}
```

**WorkspaceArchived** — workspace removed from active list.
- `reason: "user_removed" | "path_missing"`

### Plan events

**PlanCreated** — new plan entered the system.
- `workspace_id: string`
- `title: string`
- `description: string` — markdown; the PRD content, Linear ticket body, or short manual description
- `source: "manual" | "prd_file" | "linear" | "github_issue" | "briefing"` — extensible; `manual`, `prd_file`, and `briefing` are used immediately
- `source_metadata: object | null` — provider-specific (e.g. `{ external_id: "LIN-123", url: "..." }` for Linear; `{ briefing_id: string, generation_count: integer }` for `briefing`). Null for `manual`.

**PlanDescriptionRevised** — title and/or description edited.
- `title: string` — full new title
- `description: string` — full new description
- `reason: string | null`

**PlanPaused** — plan placed on hold; running tasks continue but no new work is suggested.
- `reason: string | null`

**PlanResumed** — plan returned to active state from paused.

**PlanCompleted** — auto-derived. Emitted after a `TaskMerged`, `TaskArchived`, or `TaskCancelled` lands and *all* the plan's tasks are now in a terminal state. Records the moment for display purposes; carries no payload fields.

**PlanCancelled** — plan abandoned. Does not cascade to tasks; the user is expected to cancel or archive tasks separately if desired.
- `reason: string`

**PlanArchived** — plan removed from the active list.

### Task events

**TaskCreated** — new task entered the system. **Version 3.** Version 1 never existed in the wild; v2 has no upcaster (the v3 applier tolerantly defaults the new field, so any v2 events that do exist replay against v3 without loss). The v3 applier also tolerantly defaults `relevant_files` (added with the briefing flow) to an empty array when the field is missing — additive-evolution rules apply, so no version bump is required.
- `plan_id: string` — the parent plan; the workspace is derived from the plan
- `title: string`
- `spec_markdown: string`
- `phase_config: PhaseConfig` — the phase config for this task. Resolved at task-creation time (events are immutable: the config at creation is the config that stuck). Inherits the workspace's `default_phase_config` if no per-task override was supplied.
- `relevant_files: RelevantFile[]` — files the plan author identified as likely targets for this task. Populated by the briefing flow; empty for tasks created via the quick-task shortcut or other paths without file awareness. Surfaced to the implementer prompt as a "Likely files to touch" section. `RelevantFile = { path: string, certainty: "Confirmed" | "Candidate", reason: string }`.

**TaskBaseCommitRecorded** — the commit the task's worktree was created from. This is the diff anchor for "the diff for this task" (used by the auditor and by UI-level diff views). Emitted when the worktree is provisioned for the task; conceptually a Task-level fact, kept on the Task aggregate so it survives worktree recreation.
- `commit_sha: string`

**TaskSpecRevised** — spec edited after creation.
- `spec_markdown: string` — full new spec
- `reason: string | null`

**TaskCancelled** — task abandoned before merge.
- `reason: string`

**TaskApproved** — user approved the task for merge.
- `by: string` — user identifier (local username for now)

**TaskMerged** — task's worktree merged into target branch. **Version 2.** v1 carried only `commit_sha` and `merge_strategy` (where `merge_strategy` could be `"fast_forward"`). v2 adds the fields below; the v2 applier defaults missing fields when replaying older events.
- `commit_sha: string` — the resulting commit SHA on the target branch
- `merge_strategy: "squash" | "merge"` — `"fast_forward"` is no longer emitted; squash subsumes that case
- `target_branch: string` — the branch we merged into (the main worktree's HEAD at merge time)
- `source_branch: string` — the worktree's branch (`orca/<task_id>`)
- `parent_commits: string[]` — the commits that existed on the source branch before merge, ordered oldest-to-newest. Lets the audit trail reconstruct what went into the merge.

**TaskMergeAttempted** — recorded automatically when the user opens the merge dialog and the dry-run reveals conflicts (so the merge couldn't proceed). Useful for the audit trail and for surfacing "you tried to merge this and it had conflicts" in the UI later. Fires *only* on conflict; closing the dialog without confirming emits nothing else.
- `target_branch: string`
- `source_branch: string`
- `conflicts: string[]` — file paths that conflicted
- `target_head_sha: string` — what HEAD pointed to at the moment of analysis (so you can tell whether the conflict was due to subsequent changes on the target)

**TaskArchived** — task removed from active view.

**WorktreeCreated** — a git worktree was provisioned for this task. Emitted lazily on the first phase run for the task; subsequent phase runs reuse it.
- `worktree_path: string` — absolute path on disk
- `branch_name: string` — branch the worktree is on (e.g. `yourapp/<task_id>`)
- `base_commit: string` — commit SHA the worktree was created from

**WorktreeRemoved** — the task's worktree was deleted.
- `worktree_path: string`
- `reason: "task_merged" | "task_cancelled" | "manual" | "cleanup_orphan"`

**WorktreeRemovalFailed** — removal was attempted but failed (files locked, permissions, etc). The worktree remains on disk; the user can retry from the UI.
- `worktree_path: string`
- `error: string`
- `reason: "task_merged" | "task_cancelled" | "manual" | "cleanup_orphan"`

**WorktreeInitialized** — dependency-install / setup finished successfully against the worktree. Emitted between `WorktreeCreated` and the first `PhaseRunStarted`. Phase runners check the projection's `worktree_init_status` and run init lazily on first use; subsequent phase runs reuse the result. Skipping via the UI also emits this event with `detection_kind = "user_skipped"`, `exit_code = 0`, and an explanatory `output` string.
- `command: string` — the actual shell command that ran (or `"<skipped by user>"` for a manual skip)
- `exit_code: i32` — typically `0`; non-zero values would never reach this event
- `duration_ms: u64`
- `output: string` — captured stdout+stderr, truncated to ~10KB with a marker if larger
- `detection_kind: "package_json_pnpm" | "package_json_npm" | "package_json_yarn" | "pyproject_uv" | "pyproject_poetry" | "requirements_txt" | "cargo_toml" | "go_mod" | "user_configured" | "user_skipped" | "none"` — what triggered (or replaced) the initialization

**WorktreeInitializationFailed** — init ran but exited non-zero (or was killed by timeout). When this fires, the pipeline does not auto-progress to the first phase. The user fixes the underlying issue and triggers `retry_worktree_init`, or marks it skipped via `skip_worktree_init` (which emits a `WorktreeInitialized` event with `detection_kind = "user_skipped"`).
- `command: string`
- `exit_code: i32` — non-zero (or `-1` if the process was killed)
- `duration_ms: u64`
- `output: string` — captured stdout+stderr, truncated as above
- `detection_kind: string` — same enum as `WorktreeInitialized`

### Briefing events

All Briefing events live in the per-workspace event store, keyed by `aggregate_type = "briefing"`. The aggregate id is the briefing's ULID.

**`BriefingStarted`** — user opened the briefing flow with an initial description. Always seq 1.
- `workspace_id: string`
- `initial_description: string` — what the user typed in the setup screen
- `provider: string` — provider id (e.g. `"claude"`)
- `model: string`

**`BriefingDraftProduced`** — a draft (initial or refined) came back from the model and was validated. The applier replaces the projection's `current_draft_json` with this draft.
- `draft: BriefingDraft` — full draft contents (see schema below)
- `generation_index: integer` — 1 for the initial draft, 2+ for refinements
- `prompt_template_hash: string` — content hash of the rendered prompt used (lets you correlate drafts with prompt versions later)
- `duration_ms: integer`
- `validation_results: { task_id: string, path: string, exists: bool }[]` — file-existence check results. Surfaced in the UI as warnings on non-existent paths.

**`BriefingDraftEdited`** — user's pending edits to the most recent draft. Recorded before refinement so the model sees what the user changed. Does not mutate `current_draft_json`; the projection's `pending_edits_json` field tracks the latest edits.
- `edits: BriefingEdits` — see schema

**`BriefingPushedBack`** — user explicitly pushed back on a single assumption. Modeled separately from generic edits because the model treats pushbacks as direction it must respond to.
- `assumption_id: string`
- `pushback: string` — freeform comment

**`BriefingRefineRequested`** — bookmarks the user's "refine again" click before the next CLI call. The result is a `BriefingDraftProduced` with `generation_index = previous + 1`.

**`BriefingCompleted`** — user accepted the draft. A Plan and its Tasks have been emitted on their own aggregate streams.
- `plan_id: string`
- `final_generation_index: integer`

**`BriefingCancelled`** — briefing abandoned.
- `reason: "user_cancelled" | "generation_failed_repeatedly"`

#### Briefing schema

```
BriefingDraft {
  title: string,
  description: string,                 // markdown
  tasks: DraftTask[],
  assumptions: DraftAssumption[],
}

DraftTask {
  id: string,                          // ULID, stable across refinements where possible
  title: string,
  spec_markdown: string,               // acceptance criteria
  relevant_files: RelevantFile[],
}

RelevantFile {
  path: string,
  certainty: "Confirmed" | "Candidate",
  reason: string,
}

DraftAssumption {
  id: string,                          // ULID, stable across refinements
  statement: string,
}

BriefingEdits {
  title: string | null,
  description: string | null,
  task_edits: TaskEdit[],
  task_additions: DraftTask[],
  task_removals: string[],             // task ids
  assumption_pushbacks: AssumptionPushback[],
}

TaskEdit {
  task_id: string,
  title: string | null,
  spec_markdown: string | null,
  file_additions: RelevantFile[],
  file_removals: string[],             // paths to remove
}

AssumptionPushback {
  assumption_id: string,
  pushback: string,
}
```

#### Typical event flow

```
BriefingStarted
BriefingDraftProduced (gen=1)
[user edits in UI]
BriefingDraftEdited
BriefingPushedBack (one per pushback)
BriefingRefineRequested
BriefingDraftProduced (gen=2)
[user accepts]
PlanCreated
TaskCreated (xN)
BriefingCompleted
```

### PhaseRun events

**PhaseRunStarted** — a phase began execution.
- `task_id: string`
- `phase: "test_author" | "implementer" | "auditor"`
- `provider: string` — e.g. `"claude_code"`, `"codex"`
- `model: string` — e.g. `"claude-sonnet-4-5"`
- `permission_mode: "plan" | "acceptEdits" | "bypassPermissions"` — the resolved permission mode for this run, captured at start time so retroactive settings changes don't rewrite history. The auditor is guaranteed to never carry `bypassPermissions` here even if the request asked for it (the resolution layer and the provider both clamp).
- `prompt_template_id: string` — legacy; carried for backwards compatibility. New code should rely on `prompt_template_hash`.
- `prompt_template_hash: string` — content hash of the rendered prompt at execution time. Lets us compare runs that nominally used the same template but resolved to different content (because variables differed, or because the user edited the template between runs).
- `worktree_path: string`
- `base_commit: string` — worktree HEAD at phase start, used for phase-level diffs
- `prior_phase_commits: { [phase_name]: string }` — map of phase type to `head_commit_after` for prior completed phases on this task. Lets a phase reference what an earlier phase produced (e.g. the implementer reads tests from the test-author's commit). Optional; populated by the phase runner.
- `is_retry_of: string | null` — the `phase_run_id` this is a retry of, when applicable. Forms an audit trail when the user passes a task back to the implementer after an auditor verdict.

**PhaseRunOutputAppended** — streamed output chunk from the agent. Highest-volume event by far. Chunk at sensible boundaries (not per-token).
- `chunk: string`
- `chunk_seq: integer` — sequence within this phase run

**PhaseRunToolCalled** — agent invoked a tool.
- `tool_name: string`
- `args: object`

**PhaseRunCompleted** — phase finished successfully. The runner auto-commits any worktree changes before this event is appended; the resulting SHA is `head_commit_after`.
- `exit_code: integer`
- `summary: string`
- `files_changed: string[]`
- `token_usage: { input: integer, output: integer }`
- `head_commit_after: string` — worktree HEAD after auto-commit (equal to `base_commit` from PhaseRunStarted if nothing changed)

**PhaseRunFailed** — phase ended in error.
- `error_kind: "timeout" | "subprocess_error" | "provider_error" | "user_cancelled" | "stalled_no_output" | "stalled_wall_clock" | "non_interactive_eof" | "worktree_creation_failed" | "auditor_parse_error"`
  - `stalled_no_output` — the silence timeout (`phase_timeouts.silence_timeout_seconds`) elapsed without any subprocess output
  - `stalled_wall_clock` — the wall-clock timeout (`phase_timeouts.wall_clock_timeout_seconds`) elapsed before the subprocess exited
  - `non_interactive_eof` — the subprocess closed stdin and exited; reserved for distinguishing benign EOFs from genuine crashes
- `error_message: string`

**AuditorVerdictRendered** — emitted by the auditor phase runner immediately after its `PhaseRunCompleted`. The two events are kept separate so that "the auditor finished" and "the auditor decided X" are independently observable: replaying events, an auditor run that crashed mid-render is still visible as a completed run with no verdict. The pipeline orchestrator reads the verdict to decide what to do next.
- `phase_run_id: string` — the auditor phase run that produced this verdict
- `task_id: string` — the task whose worktree was audited (denormalised so the verdict projection can be keyed and queried by task without joining back through the phase run)
- `verdict: "approve" | "revise" | "reject"`
- `confidence: number` — 0.0 to 1.0
- `summary: string`
- `concerns: Array<{ category: string, severity: "blocking" | "advisory", anchor: { path: string, line: integer } | null, rationale: string, reference_proposition_id: string | null }>`

**GateRan** — a quality gate executed against this phase run's output.
- `gate_name: string` — name of a gate defined in the workspace's `gates` settings (no longer a closed enum — gates are configurable commands)
- `passed: boolean`
- `output: string`
- `duration_ms: integer`
- `triggering_phase_run_id: string` — the phase run whose completion triggered this gate

> **Open question:** GateRan currently lives on PhaseRun. It might belong on Task — gates run against the task's worktree state, not the phase run per se. See open questions section.

## Storage schema

One `events` table per workspace db.

```sql
CREATE TABLE events (
    id              TEXT PRIMARY KEY,           -- ULID
    aggregate_type  TEXT NOT NULL,              -- 'workspace' | 'task' | 'phase_run'
    aggregate_id    TEXT NOT NULL,              -- ULID of the aggregate
    seq             INTEGER NOT NULL,           -- per-aggregate sequence (1-indexed)
    event_type      TEXT NOT NULL,              -- e.g. 'TaskCreated'
    version         INTEGER NOT NULL,           -- payload schema version, starts at 1
    payload         TEXT NOT NULL,              -- JSON
    metadata        TEXT NOT NULL,              -- JSON
    created_at      INTEGER NOT NULL,           -- unix millis
    UNIQUE (aggregate_type, aggregate_id, seq)
);

CREATE INDEX idx_events_aggregate
    ON events (aggregate_type, aggregate_id, seq);

CREATE INDEX idx_events_created_at
    ON events (created_at);
```

The `UNIQUE` constraint on `(aggregate_type, aggregate_id, seq)` is the optimistic concurrency primitive. Appends assert "the next seq for this aggregate is N" — if a concurrent writer beat us, the insert fails and the caller retries.

### Metadata fields

Every event's `metadata` JSON includes at minimum:

- `command_id: string` — UUID from the caller, used for idempotency
- `actor: string` — who or what triggered this (e.g. `"user:local"`, `"system:gate_runner"`)
- `correlation_id: string | null` — groups events across aggregates for one logical operation
- `causation_id: string | null` — id of the event that caused this one

## Projections

Stored projections. The frontend reads projections via simple SQL; the event applier updates projection tables in the same transaction as the event append.

### Tables

- **`workspace_projection`** — current state per workspace. One row per workspace. Lives in the global db.
- **`plan_projection`** — one row per plan. Columns: `id`, `workspace_id`, `title`, `description`, `source`, `source_metadata`, `status` (`active | paused | completed | cancelled | archived`), `task_count`, `running_task_count`, `done_task_count`, `failed_task_count`, `created_at`, `updated_at`. The four count columns are maintained by the **Task** applier (cross-aggregate projection update; same-transaction with the triggering task event).
- **`task_projection`** — one row per task. Includes `plan_id`, current status, latest phase run id, gate pass counts, last updated timestamp, the resolved `phase_config` JSON, and `task_base_commit` (the diff anchor from `TaskBaseCommitRecorded`).
- **`phase_run_projection`** — one row per phase run. Status, provider, model, summary, token usage, timing.
- **`phase_run_output`** — denormalized streaming text. Treated as a projection of `PhaseRunOutputAppended` events. The events remain source of truth; this table is for fast reads.
- **`auditor_verdict_projection`** — one row per `AuditorVerdictRendered` event, keyed by the auditor `phase_run_id`. Stores verdict, confidence, summary, and concerns JSON for fast UI reads.
- **`briefing_projection`** — one row per briefing. Columns: `id`, `workspace_id`, `status` (`active | completed | cancelled`), `current_draft_json`, `pending_edits_json`, `validation_results_json`, `generation_count`, `provider`, `model`, `initial_description`, `final_plan_id`, `cancel_reason`, `created_at`, `updated_at`. The current draft is updated on each `BriefingDraftProduced`; edits and pushbacks accumulate in `pending_edits_json` (cleared after the next `BriefingDraftProduced`).

Projections can be dropped and rebuilt from events at any time. A `rebuild_projections` Tauri command exists from day one — it's a development necessity, not a debugging tool.

### Snapshots

Not yet. Replay-from-zero is fast enough for the volumes this app will see for a long time. Add snapshots when measurement says we need them, not before.

## Conventions

- **Naming.** Past-tense event names (`TaskCreated`, not `CreateTask`). PascalCase. Aggregate name as prefix where it disambiguates (`PhaseRunStarted`, `TaskCancelled`).
- **IDs.** ULIDs everywhere. Sortable, no coordination, URL-safe.
- **Versioning.** Every event carries a `version` integer in its row. Starts at 1. Bumped only when payload shape changes. Old versions are read via upcasters that transform to the latest shape on load. New fields are always optional with sensible defaults; renames and removals are forbidden.
- **Idempotency.** Every command-handling code path requires a `command_id`. The append function checks whether an event with that `command_id` already exists for the target aggregate; if so, it returns the existing result and emits no new events.
- **Time.** All timestamps are unix millis (integer). UTC. No local time anywhere in the event store.

## Open questions

Things worth deciding but not blocking initial implementation. Resolve as the codebase forces the issue.

1. **GateRan placement.** Currently on PhaseRun. Should it be on Task? Gates run against the task worktree's final state, not the phase run's output specifically. Argument for keeping on PhaseRun: timing and causation are clearer. Argument for Task: a task can have multiple phase runs and the gates are a property of "is this task ready to merge."
2. **Out-of-band repo state.** What happens when the user manually deletes a worktree, force-pushes the branch, or rewrites history? Events still describe the world that *was*; projections may diverge from reality. Probably needs a `RepoStateReconciled` event class eventually.
3. **Settings: snapshot vs diff.** Currently snapshot. Diff is more compact but requires a base state to apply against. Snapshot wins for now; revisit if settings get large.
4. **Retention.** No retention policy yet. Events accumulate forever. Acceptable for v1; a `TaskArchived` event could trigger eventual compaction of that aggregate's stream.
5. **Cross-workspace correlation.** When the global db wants to learn from per-workspace event streams (e.g. "which model has worked best across all my repos"), how does it read them? Probably an aggregator process that reads each workspace db and writes summaries to the global db. Out of scope for v1.
6. **Multi-actor / collaboration.** Currently single-user, local. If this ever becomes multi-user, `actor` in metadata is the seam. Not designing for it now.
