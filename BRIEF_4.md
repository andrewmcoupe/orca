# Brief for Claude Code: Per-Task Phase Config Editing

## Context

A task's phase configuration (provider, model, permission mode per phase) is currently set at task creation time via the preview screen. Changing it after the fact requires editing workspace defaults — which affects all future tasks — or recreating the task. There's no way to say "this specific task should use Opus for the implementer" without either changing the workspace default or starting over.

This brief adds per-phase config editing on the task detail view. The user can change the provider, model, or permission mode for a specific phase of a specific task. The change applies to future phase runs of that phase; historical runs are unaffected.

The use case is real: "the implementer with Sonnet didn't quite work, let me try Opus for the retry" or "the auditor was too lenient, let me bump it to a smarter model and re-audit." This kind of per-task tuning is exactly what makes orca's per-phase model assignment valuable.

**Prerequisites already in place:**

- Phase config schema with workspace defaults and per-task overrides in `phase_config`
- Resolution function (task override > workspace default > hardcoded fallback)
- `list_providers`, `list_models(provider)` Tauri commands
- Phase cards on the task detail view showing model and permission mode
- Permission mode handling with auditor restricted to `plan` and `acceptEdits`
- `TaskCreated` event with `phase_config` snapshot at creation time
- `PhaseRunStarted` event capturing the resolved config used for that run

Read `docs/events.md` first.

## Goals

1. The user can edit a phase's config (provider, model, permission mode) directly from the task detail view.
2. Edits emit a new event that updates the task's effective config; the original `TaskCreated.phase_config` snapshot is preserved for audit.
3. New phase runs use the latest effective config; historical runs are unaffected.
4. Editing is disabled while any phase of the task is currently running.
5. Phase cards visibly indicate when a phase's config differs from the workspace default.
6. Auditor's permission mode dropdown still excludes `bypassPermissions`.

## Schema additions

Update `docs/events.md` and the implementation.

**`TaskPhaseConfigChanged`** — new event on the Task aggregate. Records a user-initiated change to one phase's config.
- `phase: "test_author" | "implementer" | "auditor"`
- `provider: string | null` — null means "revert to workspace default"
- `model: string | null` — null means "revert to workspace default"
- `permission_mode: "plan" | "acceptEdits" | "bypassPermissions" | null` — null means revert

The event represents a delta to the named phase only. Other phases' configs are untouched.

**`task_projection`** changes:
- Existing `phase_config` column captures the *original* snapshot from `TaskCreated`. Don't change this.
- Add a new `current_phase_config` column holding the *latest effective* config after applying all `TaskPhaseConfigChanged` events.
- The applier for `TaskPhaseConfigChanged` updates `current_phase_config` for the named phase. The applier for `TaskCreated` initialises `current_phase_config = phase_config`.

### Resolution

When a phase run starts, the phase runner resolves config in this order:

1. `current_phase_config[phase]` — the latest user-set value, if present
2. Workspace `default_phase_settings[phase]` — workspace default
3. Hardcoded fallback (`acceptEdits` for write phases, `plan` for auditor)

This is the same resolution function used today, with the source updated from "original snapshot" to "current". Update the function once; everything downstream uses it.

`PhaseRunStarted` continues to capture the resolved values at the moment of the run, so the event log accurately records "this run used Opus" regardless of whether config changes happen later.

### Schema versioning

`TaskCreated` doesn't change. No version bump needed. The new event is additive.

## Milestones

### Milestone 1: Event and projection plumbing

- Update `docs/events.md` with the new event and projection column.
- Implement Rust event type and serde derivations.
- Update the task projection schema to add `current_phase_config`.
- Implement the applier for `TaskPhaseConfigChanged` — finds the phase entry in `current_phase_config`, replaces the named field(s), emits a `projection_updated` after commit.
- Update the `TaskCreated` applier to initialise `current_phase_config` from the original `phase_config` snapshot.
- Run a one-time backfill on existing task projections: copy `phase_config` to `current_phase_config` for any task that doesn't have it. This is a `rebuild_projections` concern — running rebuild should populate the new column correctly because the appliers do the right thing.

### Milestone 2: Phase runner config resolution

The phase runner currently reads from the task's original `phase_config` to resolve what provider/model/mode to use. Update it to read from `current_phase_config` instead.

This is a small change but worth being explicit about: the resolution function's input shifts from "task's original config" to "task's current config." The function signature and behaviour are otherwise identical.

Audit every place in the codebase that reads phase config for execution purposes. They should all go through the resolution function; if any read `phase_config` directly, fix them to use the resolution function (which now reads from `current_phase_config` internally).

### Milestone 3: Tauri command

Add `update_task_phase_config`:

```rust
#[tauri::command]
async fn update_task_phase_config(
    task_id: String,
    phase: String,                          // "test_author" | "implementer" | "auditor"
    provider: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
) -> Result<Task, AppError>;
```

Behaviour:

1. Validate that no phase of this task is currently running. If a `PhaseRunStarted` exists without a corresponding `PhaseRunCompleted` or `PhaseRunFailed`, return `AppError::PhaseRunning`. The UI should never call this in a running state, but defence-in-depth.
2. Validate the permission mode against the phase. If `phase == "auditor"` and `permission_mode == "bypassPermissions"`, return `AppError::InvalidPermissionMode`. Defence-in-depth — the UI dropdown shouldn't expose this combination, but the command guards it too.
3. Emit `TaskPhaseConfigChanged` via `append_events` with the provided fields.
4. Return the updated task projection.

The command takes optional fields so partial updates work — e.g. just changing the model without touching provider or mode. Any field set to `None` in the call is left unchanged in the resulting event payload (the event only carries fields the user actually changed).

Wait — that conflicts with the "null means revert to default" semantics in the event. Resolve by using a different sentinel for "no change" vs "revert":

```rust
pub enum ConfigUpdate<T> {
    Unchanged,         // skip this field in the event
    SetTo(T),          // set to this value
    RevertToDefault,   // set to None in the event (use default)
}
```

Or simpler: have two commands, `update_task_phase_config` (sets fields) and `reset_task_phase_config` (reverts a phase to defaults). Pick the simpler split. I'd suggest the two-command approach — clearer, easier to reason about.

```rust
#[tauri::command]
async fn update_task_phase_config(
    task_id: String,
    phase: String,
    provider: String,
    model: String,
    permission_mode: String,
) -> Result<Task, AppError>;
// All three fields required; no field-level "unchanged" support. UI sends the full
// resolved config from the popover; user explicitly clicked Save.

#[tauri::command]
async fn reset_task_phase_config(
    task_id: String,
    phase: String,
) -> Result<Task, AppError>;
// Emits TaskPhaseConfigChanged with provider/model/permission_mode all null.
// Phase reverts to workspace default.
```

This is cleaner. Use this split.

### Milestone 4: Edit affordance on phase cards

Add a small edit affordance to each phase card on the task detail view.

**Visual treatment:**

- A small icon (`⋯` or a pencil/gear icon) in the top-right corner of each phase card. shadcn doesn't have one out of the box; use Lucide's `Settings2` or `Pencil` icon at 14px, muted-foreground colour.
- Click → opens a popover anchored to the card.
- The icon button has a tooltip: "Edit phase config" when enabled, "Cannot edit while a phase is running" when disabled.

**Disabled state:**

- The edit button is disabled when any phase of the task is currently running (any `PhaseRunStarted` without matching completion/failure).
- Disabled state is muted further (lower opacity) and not clickable. Tooltip explains why.

### Milestone 5: Edit popover

The popover, anchored to the phase card, contains the editor.

**Header:** "Edit {phase name} config" (e.g. "Edit implementer config").

**Body:** three dropdowns plus a footer.

- **Provider** dropdown. Options come from `list_providers()`, filtered to providers that are installed and authenticated. Shows the current value.
- **Model** dropdown. Options come from `list_models(provider)`. Refreshes when provider changes (clear the model selection on provider change; user must re-pick).
- **Permission mode** dropdown. Options depend on phase:
  - `test_author` and `implementer`: `acceptEdits`, `bypassPermissions`
  - `auditor`: `plan`, `acceptEdits`
- Display labels are user-friendly: "Plan (read-only)", "Accept edits", "Bypass permissions".
- A small help icon next to the permission mode dropdown opens a brief explanation on click — same content as the workspace settings help text.

**Footer:**

- "Reset to default" button (left-aligned). Calls `reset_task_phase_config`. Closes popover on success.
- "Cancel" and "Save" buttons (right-aligned). Save calls `update_task_phase_config` with the popover's current values. Closes on success.

**Initial state:**

The popover pre-populates with the *currently effective* config for this phase — the resolved value (current task config > workspace default > hardcoded). Show that as the starting state. The user is editing "what would the next run use?" — so we show what it would use today.

### Milestone 6: Customisation indicator

When a phase's `current_phase_config` value differs from the workspace default for that phase, the phase card shows a small indicator.

**Visual:**

- A small dot (3-4px) next to the phase name on the card, or after the model name. Use accent colour (the same green used elsewhere for "configured" states) or a neutral muted-secondary colour — pick whichever reads as informational rather than warning.
- Tooltip on hover: "Phase config has been customised for this task."
- The indicator is per-phase: the implementer card might show the dot while the auditor card doesn't.

**Computation:**

For each phase on the card, compute `is_customised = current_phase_config[phase] != workspace_default_phase_settings[phase]`. This needs both values; the task projection should expose `current_phase_config`, and the workspace projection exposes defaults. The frontend can compare them to determine the indicator.

Edge case: if a phase has been customised and then reset, the `TaskPhaseConfigChanged` with all-null fields means "use defaults" — the projection should reflect this with `current_phase_config[phase]` matching workspace default, so the indicator correctly disappears.

### Milestone 7: Wiring with task toolbar

The task detail view's action toolbar (from the previous brief) interacts with this feature in one specific way: the **Re-run auditor only** action in the overflow menu, and the **Run / Restart** action, will pick up the latest `current_phase_config` automatically — they go through the resolution function, which now reads from the current config.

This is automatic; no extra work needed beyond confirming the resolution function behaves correctly. But worth verifying: change the auditor's model via the popover, click "Re-run auditor only," confirm the new auditor run uses the new model.

## Conventions

- Read and update `docs/events.md` before implementing.
- Tauri events emitted **after** transaction commit. One `projection_updated` per affected aggregate.
- TanStack Query for all reads. Phase config changes invalidate the task projection query, which re-renders the phase cards with new model/mode/indicator state.
- Typed errors with `thiserror`. New variants: `AppError::PhaseRunning`, `AppError::InvalidPermissionMode`.
- shadcn primitives for the popover (Popover), dropdowns (Select), and tooltips (Tooltip).
- Don't duplicate the dropdown components. Reuse the same model/permission-mode dropdowns from workspace settings if they exist as separate components; if they're inlined, factor them out as part of this work.

## Out of scope

- Per-task prompt overrides (large UX question; defer)
- Editing config on completed historical phase runs (immutable; the right pattern is "re-run with new config")
- Multi-phase batch editing (edit each phase individually)
- Saving customised task config back as workspace default (cute but premature)
- Diff display between current task config and workspace default in the popover (the dot indicator is enough)
- Per-phase prompt template hash override (use whatever the workspace-level prompt is; per-phase prompt editing is a separate concern)
- Auto-detecting which models a provider has access to (still hardcoded list per provider)
- Showing config history (when was this changed? by whom?) — the event log has it; no UI needed for v1
- Per-task gate config overrides (still workspace-level only)

## Deliverable

A working app where:

1. Each phase card on the task detail view has an edit affordance (icon button) opening a config popover.
2. The popover lets the user change provider, model, and permission mode for that phase.
3. Auditor's permission mode dropdown excludes `bypassPermissions`.
4. Saving emits `TaskPhaseConfigChanged`; the projection updates; the phase card re-renders with new values.
5. A reset button on the popover reverts the phase to workspace default.
6. The edit affordance is disabled (with explanatory tooltip) while any phase of the task is running.
7. Phase cards show a small dot indicator when the phase's config differs from workspace default.
8. New phase runs (Run, Restart, Re-run auditor only) use the updated config.
9. Historical phase runs are unaffected; their `PhaseRunStarted` events remain accurate.
10. `docs/events.md` reflects the new event and projection column.

Plus tests on:
- The resolution function correctly preferring current task config over workspace default and over hardcoded fallback.
- The applier for `TaskPhaseConfigChanged` updating only the named phase, not others.
- The `update_task_phase_config` command rejecting bypassPermissions for the auditor.

Three commits: schema and projection (Milestones 1-2), command and core UI (Milestones 3-5), customisation indicator and polish (Milestones 6-7).
