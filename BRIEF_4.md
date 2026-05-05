# Brief for Claude Code: Task Dependencies and File-Overlap Warnings

## Context

The app currently has no concept of task ordering. If a user has a plan with 5 tasks and runs them in parallel, they all create worktrees from the same base commit and try to merge into the same branch. Where the tasks touch overlapping files, this produces merge conflicts on every merge after the first. There's also no way to express "Task B logically depends on Task A's output existing" — the user has to manually run them in order.

This brief adds task dependencies. Tasks can declare `depends_on` references to other tasks; running a task with unmet dependencies queues it; the queued task auto-starts when its last dependency merges. This is necessary infrastructure to make parallel multi-task execution actually testable — without it, dogfooding the parallel workflow devolves into merge conflict triage.

The brief also adds a soft file-overlap warning: when a task is about to start while another in-flight task is touching overlapping files, surface a warning so the user can choose to proceed or wait. This catches a class of conflicts that explicit dependencies miss (the implementer touched a file outside the declared `relevant_files`).

**Prerequisites already in place:**

- Task aggregate with the existing event lifecycle (`TaskCreated`, `TaskMerged`, etc.)
- `relevant_files` on `TaskCreated` from briefing-generated tasks
- Pipeline orchestrator with `on_phase_completed` hook
- Plan auto-completion logic (when last task is terminal, `PlanCompleted` fires)
- Briefing aggregate producing structured drafts with tasks
- Action toolbar on the task detail view with state-aware Run button
- TanStack Query with `projection_updated` invalidation

Read `docs/events.md` first.

## Goals

1. Tasks can declare dependencies on other tasks via a `depends_on` field.
2. The briefing model populates `depends_on` for generated drafts when it identifies dependencies between tasks.
3. The user can manually edit a task's dependencies after creation via a UI affordance on the task detail view.
4. Clicking Run on a task with unmet dependencies queues it; queued tasks auto-start when their last dependency merges.
5. The pipeline orchestrator gains a queue manager that handles unblocking.
6. A soft warning surfaces at task-start time when an in-flight task has overlapping `relevant_files`.
7. Cyclic dependencies are detected and rejected at the moment of declaration.

## Schema additions

Update `docs/events.md` and the implementation.

### Task aggregate changes

**`TaskCreated`** — gains:
- `depends_on: string[]` — array of task IDs this task depends on. Defaults to empty.

Bump `TaskCreated` to v4. No upcaster needed if you wipe dev data, or treat missing `depends_on` as `[]` on read.

**`TaskDependenciesChanged`** — new event. Fired when the user edits dependencies after task creation.
- `depends_on: string[]` — full new list. Replaces previous; not a delta.

**`TaskQueued`** — new event. Fired when the user clicks Run on a task with unmet dependencies and chooses to queue.
- `queued_at: int64` — timestamp; redundant with the event's own `created_at` but useful for the projection.

**`TaskUnblocked`** — new event. Fired automatically by the queue manager when a task's last unmet dependency reaches `merged` state.
- `unblocked_at: int64`
- `unblocking_task_id: string` — the dep whose merging caused this task to become unblocked. Useful audit info.

**`TaskUnqueued`** — new event. Fired when the user explicitly cancels a queued task's queued state (e.g. they decide they don't want to auto-start it after all).

### Briefing draft schema changes

**`DraftTask`** in the briefing draft — gains:
- `depends_on: string[]` — references to other task IDs *in the same draft* (not external task IDs). Empty for tasks with no dependencies.

The model populates this in the briefing system prompt (see Milestone 4 below).

The briefing's accept flow translates draft task IDs to actual task IDs at plan-creation time — the `depends_on` references in the draft refer to other draft tasks; on accept, those references resolve to the new ULIDs assigned to created tasks.

### Projection changes

`task_projection` gains:
- `depends_on: string[]` (JSON column)
- `is_blocked: bool` — computed: any dep not in a `merged` state?
- `is_queued: bool` — has the user clicked Run while blocked?
- `unblocked_at: int64 | null`

The `is_blocked` flag is recomputed when:
- `TaskCreated` lands (initial computation based on initial deps)
- `TaskDependenciesChanged` lands (deps changed)
- `TaskMerged` lands for any task in the same workspace (a dep might have merged)

The `is_queued` flag toggles on `TaskQueued` and `TaskUnqueued`, and clears on the task's first phase actually starting.

## Cyclic dependency rejection

A task cannot depend (transitively) on itself. The system rejects:

- Direct cycles (Task A depends on B, B depends on A)
- Indirect cycles (A → B → C → A)
- Self-loops (A depends on A)

Validation happens at the moment of declaration:

- `create_task` rejects if the new task's `depends_on` would create a cycle (impossible at creation since the new task doesn't exist yet, but check defensively for invalid IDs).
- `update_task_dependencies` rejects if the change would create a cycle.

Implement a small graph cycle detection function: build the dependency graph from `task_projection` rows in the workspace, add the proposed edge, run a DFS to detect cycles. Reject with `AppError::CyclicDependency` and an explanatory message identifying the cycle path.

## Milestones

### Milestone 1: Schema and projection plumbing

- Update `docs/events.md` with the new events and field changes.
- Implement Rust event types and serde derivations.
- Update `task_projection` schema for new columns.
- Implement appliers:
  - `TaskCreated` initialises `depends_on`, computes initial `is_blocked`.
  - `TaskDependenciesChanged` updates `depends_on`, recomputes `is_blocked`.
  - `TaskQueued` / `TaskUnqueued` toggle `is_queued`.
  - `TaskUnblocked` updates `is_blocked = false` and `unblocked_at`.
  - `TaskMerged` (existing applier) gains a side effect: scan `task_projection` for tasks whose `depends_on` includes this task's ID, recompute their `is_blocked` state.
- The `TaskMerged` cross-task projection update is in the same transaction as the merge applier (cheap; same workspace db).

### Milestone 2: Cycle detection

Implement `validate_no_cycle(workspace_id, task_id, proposed_depends_on) -> Result<(), CyclicDependencyError>`:

- Read all task projections for the workspace
- Build a graph: nodes are task IDs, edges are dependency relationships
- Add the proposed edges (task_id → each ID in proposed_depends_on)
- Run DFS from task_id; if we reach task_id again, return the cycle path
- Return Ok if no cycle

Used by `create_task` and `update_task_dependencies` commands. Tests on this function are mandatory — cycle detection is the kind of logic where subtle bugs allow data corruption.

### Milestone 3: Tauri commands

```rust
#[tauri::command]
async fn update_task_dependencies(
    task_id: String,
    depends_on: Vec<String>,
) -> Result<Task, AppError>;
// Validates cycle-free, validates all referenced task IDs exist in the same plan,
// emits TaskDependenciesChanged.

#[tauri::command]
async fn unqueue_task(task_id: String) -> Result<Task, AppError>;
// Emits TaskUnqueued. The task is no longer queued; user clicks Run again to resume.
```

The existing `start_real_phase` (or whatever your "run a phase" command is) gains pre-execution logic:

- Look up the task. If `is_blocked`:
  - If the user explicitly invoked Run via the toolbar (the common case), emit `TaskQueued` and return early. Don't start the phase. Return a result indicating the task was queued, not started — so the UI can show appropriate feedback.
  - If the call came from the queue manager (auto-start after unblocking), the unblocking should have already updated `is_blocked` to false; if it's still true, log a warning and don't start.
- If not blocked, proceed as today.

### Milestone 4: Queue manager

Add a queue manager component to the orchestrator. It hooks into `TaskMerged` events:

When `TaskMerged` lands:

1. Find all tasks in the same workspace where:
   - `depends_on` includes the merged task's ID
   - `is_queued` is true
   - All *other* dependencies are also in `merged` state (this task is now fully unblocked)
2. For each, emit `TaskUnblocked` with the unblocking task ID, then emit a synthetic invocation that starts the task's first phase (same code path as user-clicked Run, but flagged as auto-started).

The queue manager runs as part of the existing event-handling flow — when `TaskMerged`'s `projection_updated` fires, the queue manager is one of the handlers that responds. Async; doesn't block the merge completion.

Edge case: if multiple queued tasks unblock simultaneously (the merged task was their last common dependency), they all start. This is correct — the user queued them precisely to run as soon as possible.

Cross-plan note: the queue manager only operates within the same workspace, but dependencies are theoretically cross-plan. For v1, restrict dependencies to same-plan only (validate this in `update_task_dependencies` and `create_task`). Cross-plan dependencies are a complexity multiplier; defer.

### Milestone 5: Briefing-generated dependencies

Update the briefing prompt to instruct the model to identify task dependencies:

Add to the briefing system prompt:

```
After identifying tasks, identify dependencies between them. Task B depends on Task A if:
- B's tests would exercise functionality that A creates
- B modifies code that A introduces
- B logically requires A's completion to be meaningful

Express dependencies via the `depends_on` field on each task, referencing the IDs of tasks within this same draft. Tasks with no dependencies have an empty array.

Be conservative: only declare dependencies that are necessary. Tasks that could plausibly run in parallel should not have dependencies just to make the order more "obvious."
```

Update the briefing draft JSON schema to include `depends_on: string[]` on each task. Update the briefing draft Rust types accordingly.

On briefing accept, when translating draft task IDs to actual task ULIDs, propagate the `depends_on` references — if draft task `task-3` had `depends_on: ["task-1"]`, the created Task corresponding to `task-3` has `depends_on: [<actual_ULID_of_task-1>]`.

### Milestone 6: Toolbar Run button changes

The Run button on the task detail toolbar gains nuance:

- **When task is not blocked**: Run is enabled, primary if appropriate. Same as today.
- **When task is blocked and not yet queued**: Run is enabled, label remains "Run", tooltip says "Will queue — task is blocked by N tasks". On click, emits `TaskQueued`. The button immediately reflects the queued state.
- **When task is queued**: Button label changes to "Cancel queue". Tooltip: "Cancel — task is waiting for N dependencies to merge." On click, emits `TaskUnqueued`. The button reverts to "Run".
- **When task is blocked but user wants to override** (run anyway, ignore deps): the overflow menu has "Run anyway (ignore dependencies)" with a strong warning tooltip about likely conflicts. This is an escape hatch, not the recommended path.

The "blocked by N tasks" indicator also appears on the task title area — a small badge showing the count, expandable to a list of the blocking tasks (each a link to that task's detail).

### Milestone 7: Manual dependency editing UI

On the task detail view, add a "Dependencies" section (small, near the spec). Shows:

- Current dependencies as a list of links to those tasks (with their current status — merged, in-flight, blocked, etc.)
- An "Edit dependencies" button → opens a popover or dialog
- Editor: a multi-select of other tasks in the same plan, currently dependencies marked. User adds/removes, clicks Save. Calls `update_task_dependencies`.
- Cycle detection failure surfaces inline: "This dependency would create a cycle: A → B → A. Remove one of these dependencies first."

The Dependencies section is hidden when the task has no dependencies AND isn't blocked. (Don't show empty sections by default; the "Edit dependencies" button is accessible via the overflow menu instead.)

When dependencies exist, the section shows them prominently. When the task is blocked, the section header includes the blocked badge.

### Milestone 8: File-overlap warnings

When a task is about to start (via Run, or via queue manager auto-start), check for file overlaps:

```rust
fn detect_file_overlap(
    starting_task: &Task,
    workspace_id: &str,
) -> Vec<FileOverlap>;

struct FileOverlap {
    other_task_id: String,
    other_task_title: String,
    overlapping_files: Vec<String>,
}
```

The function:

1. Query `task_projection` for in-flight tasks (tasks with at least one phase run started but not all phases completed) in the same workspace.
2. For each, compute intersection of their `relevant_files` paths with the starting task's `relevant_files`.
3. Return `FileOverlap` for each in-flight task with non-empty intersection.

If overlaps exist, the UI surfaces a warning dialog before the task actually starts:

- Title: "File overlap detected"
- Body: "This task touches files that another in-flight task is also working on. Conflicts may arise when both tasks merge."
- For each overlap: "Task '{other_title}' is touching {overlapping_files joined}"
- Buttons: "Proceed anyway" (continues to start the task) and "Cancel" (don't start).

**Suppression policy:** within the current session, don't show the warning twice for the same `(starting_task, other_task)` combination. If the user dismissed the warning when starting Task A while Task B was in flight, don't show it again when Task A's auto-retry hits the same overlap. Use a simple in-memory set keyed by ordered pair.

Persistence: don't persist suppression across app restarts. Sessions are short enough that re-prompting on restart is fine.

This warning runs *after* the dependency check. If a task is blocked by dependencies, it queues; the warning doesn't fire until the queue manager actually starts it (and at that point, the dependent tasks have merged, so the in-flight tasks set is different). The warning is for "what's running right now" — it's race-time information, not plan-time.

## Conventions

- Read and update `docs/events.md` before implementing.
- Tauri events emitted **after** transaction commit. One `projection_updated` per affected aggregate.
- Cross-aggregate projection updates (TaskMerged updating other tasks' `is_blocked`) happen in the same transaction.
- Auto-derived events (`TaskUnblocked` from queue manager) are emitted after the triggering event's transaction commits, not inside it.
- TanStack Query for all reads. The task detail view's query refetches on `projection_updated` for the task or its dependencies.
- Typed errors with `thiserror`. New variants: `AppError::CyclicDependency`, `AppError::DependencyNotFound`, `AppError::CrossPlanDependency`.
- shadcn primitives for the UI: Dialog for the warning, Select (multi-select if available; otherwise checkbox list) for the dependency editor.

## Out of scope

- Cross-plan dependencies (same-plan only for v1)
- Visual dependency graph display (could be useful but separate design problem)
- Dependency-based task ordering in the plan list view (sort by dep order rather than insertion order) — interesting future feature
- Auto-rebase or auto-conflict-resolution at merge time (still requires human resolution)
- Soft warnings beyond file overlap (e.g. "you're about to run 5 tasks; that's a lot")
- Per-task dependency overrides ("ignore this one dependency just for this run") — overflow's "Run anyway" is the only escape hatch
- Dependency-aware briefing refinement ("the model should refine the dependency graph if I push back") — out of scope; user manually edits if needed
- Notification when a queued task auto-starts (could be nice; defer)

## Deliverable

A working app where:

1. Briefing-generated draft tasks include `depends_on` references where the model identifies dependencies.
2. The user can manually edit a task's dependencies via the task detail view.
3. Cyclic dependencies are detected and rejected with a clear error message.
4. Clicking Run on a blocked task queues it; the toolbar reflects queued state; the user can cancel the queue.
5. When a task's last dependency merges, the queue manager auto-starts it.
6. The blocked-by indicator appears prominently on blocked tasks.
7. A file-overlap warning surfaces when a task is about to start while another in-flight task is touching overlapping files. Dismissable; suppression within session.
8. Cross-plan dependencies are rejected at the validation layer.
9. `docs/events.md` reflects the new events and schema changes.

Plus tests on:
- Cycle detection (direct cycles, indirect cycles, self-loops, valid graphs).
- Queue manager (a task with two deps; merge one, task remains queued; merge the other, task auto-starts).
- File-overlap detection (overlap correctly identified; suppression within session works).
- Briefing draft → task creation correctly translates `depends_on` from draft IDs to created task IDs.

Three commits is right: schema and projection (Milestones 1-2-3), queue manager and briefing integration (Milestones 4-5), UI surfaces and warnings (Milestones 6-7-8).
