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

### PhaseRun

A single execution of one phase (test-author, implementer, auditor) against one task with a specific provider and model. Modeled as its own aggregate rather than as events on Task because phase runs are self-contained, retriable, and comparable across models. A task has many phase runs over its lifetime.

## Event catalog

All events carry standard fields (`id`, `aggregate_type`, `aggregate_id`, `seq`, `event_type`, `version`, `created_at`, `metadata`) plus an event-specific `payload`. Only payload fields are documented below.

### Workspace events

**WorkspaceRegistered** — workspace added by user.
- `path: string` — absolute path on disk
- `name: string` — display name (defaults to repo dir name)

**WorkspaceSettingsChanged** — settings updated.
- `settings: object` — full new settings snapshot (not a diff — simpler to reason about)

**WorkspaceArchived** — workspace removed from active list.
- `reason: "user_removed" | "path_missing"`

### Plan events

**PlanCreated** — new plan entered the system.
- `workspace_id: string`
- `title: string`
- `description: string` — markdown; the PRD content, Linear ticket body, or short manual description
- `source: "manual" | "prd_file" | "linear" | "github_issue"` — extensible; only `manual` and `prd_file` are used immediately
- `source_metadata: object | null` — provider-specific (e.g. `{ external_id: "LIN-123", url: "..." }` for Linear). Null for `manual`.

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

**TaskCreated** — new task entered the system. **Version 2.** Version 1 events do not exist in the wild (dev data wiped at the introduction of Plan); no upcaster needed.
- `plan_id: string` — the parent plan; the workspace is derived from the plan
- `title: string`
- `spec_markdown: string`

**TaskSpecRevised** — spec edited after creation.
- `spec_markdown: string` — full new spec
- `reason: string | null`

**TaskCancelled** — task abandoned before merge.
- `reason: string`

**TaskApproved** — user approved the task for merge.
- `by: string` — user identifier (local username for now)

**TaskMerged** — task's worktree merged into target branch.
- `commit_sha: string`
- `merge_strategy: "squash" | "merge" | "fast_forward"`

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

### PhaseRun events

**PhaseRunStarted** — a phase began execution.
- `task_id: string`
- `phase: "test_author" | "implementer" | "auditor"`
- `provider: string` — e.g. `"claude_code"`, `"codex"`
- `model: string` — e.g. `"claude-sonnet-4-5"`
- `prompt_template_id: string`
- `worktree_path: string`
- `base_commit: string` — worktree HEAD at phase start, used for phase-level diffs

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
- `error_kind: "timeout" | "subprocess_error" | "provider_error" | "user_cancelled"`
- `error_message: string`

**GateRan** — a quality gate executed against this phase run's output.
- `gate_name: "typecheck" | "test" | "lint"`
- `passed: boolean`
- `output: string`
- `duration_ms: integer`

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
- **`task_projection`** — one row per task. Includes `plan_id`, current status, latest phase run id, gate pass counts, last updated timestamp.
- **`phase_run_projection`** — one row per phase run. Status, provider, model, summary, token usage, timing.
- **`phase_run_output`** — denormalized streaming text. Treated as a projection of `PhaseRunOutputAppended` events. The events remain source of truth; this table is for fast reads.

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
