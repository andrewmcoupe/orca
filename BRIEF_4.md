# Brief for Claude Code: Briefing — Iterative Plan Generation with File Awareness

## Context

Plans currently come from manual creation only — the user types a title and description, then adds tasks one by one. This brief introduces **Briefings**: a structured, iterative way to generate a complete plan (with tasks and file references) from a vague feature description, using one of the user's configured CLI providers.

A Briefing is *not* a chat. It's a draft-and-refine loop:

1. User describes a feature in plain language.
2. The chosen CLI provider reads the codebase, produces a draft plan with tasks (each with relevant files and assumptions made).
3. User reviews the draft, edits inline, optionally pushes back on assumptions.
4. User clicks "Refine again" (re-runs CLI with edits as context) or "Accept and create plan."
5. Loop until accepted or cancelled.

The model produces structured output; the user reviews and directs. Same pattern as the rest of orca's architecture. No conversation, no terminal, no chat UI.

The output produces real code-aware tasks: each task includes a list of files most likely to be touched, populated by the model after exploring the actual codebase. This file awareness flows downstream — the implementer phase's prompt surfaces the task's `relevant_files`, focusing attention on the right places.

**Prerequisites already in place:**

- Provider trait with claude/codex/gemini CLI providers and per-phase configuration
- Plan and Task aggregates with their projections
- Workspace settings with default providers per phase
- TanStack Router with `/workspace/:workspaceId/plans` route
- shadcn/ui with Tailwind v4
- Quick-task shortcut (⌘N) for one-off tasks — stays as-is, this is for multi-task plans

Read `docs/events.md` first.

## Goals

1. A new **Briefing** aggregate captures the iterative plan-generation flow with full event-sourced history.
2. A dedicated route `/workspace/:workspaceId/briefings/new` hosts the briefing flow: setup → generation → review → refine/accept.
3. The model produces structured drafts with `title`, `description`, `tasks[]`, and `assumptions[]`. Each task includes `relevant_files[]`.
4. Users can edit any field inline before accepting, push back on assumptions, and trigger refinement passes that incorporate their edits.
5. Generated file paths are validated against the filesystem; non-existent paths are flagged.
6. On acceptance, a Plan is created with N Tasks. Each `TaskCreated` includes `relevant_files`.
7. The implementer phase prompt template gains a section surfacing `relevant_files` to focus the agent's attention.

## Schema additions

Update `docs/events.md`.

### New aggregate: Briefing

A briefing is a long-lived aggregate that produces a Plan when accepted. Lives in the workspace's event store.

**`BriefingStarted`**
- `workspace_id: string`
- `initial_description: string` — what the user typed in the setup screen
- `provider: string` — e.g. `"claude_code"`, `"codex"`, `"gemini_cli"`
- `model: string`

**`BriefingDraftProduced`**
- `draft: BriefingDraft` — full draft contents (see schema below)
- `generation_index: integer` — 1 for the initial draft, 2+ for refinements
- `prompt_template_hash: string` — content hash of the prompt used (lets you correlate drafts with prompt versions later)
- `duration_ms: integer`
- `validation_results: { path: string, exists: bool }[]` — file-existence check results

**`BriefingDraftEdited`**
- `edits: BriefingEdits` — user's edits applied to the most recent draft (see schema)
- Emitted when the user makes edits in the review UI before clicking "Refine again." The edits become context for the next refinement.

**`BriefingPushedBack`**
- `assumption_id: string` — which assumption is being pushed back on
- `pushback: string` — user's freeform comment ("treat as required" / "actually not needed" / etc.)

**`BriefingRefineRequested`**
- Emitted when the user clicks "Refine again." Bookmarks the request before the next CLI call. The result is a `BriefingDraftProduced` with a higher `generation_index`.

**`BriefingCompleted`**
- `plan_id: string` — the Plan that was created from the accepted draft
- `final_generation_index: integer`

**`BriefingCancelled`**
- `reason: "user_cancelled" | "generation_failed_repeatedly"`

### Draft schema

```rust
pub struct BriefingDraft {
    pub title: String,
    pub description: String,            // markdown
    pub tasks: Vec<DraftTask>,
    pub assumptions: Vec<DraftAssumption>,
}

pub struct DraftTask {
    pub id: String,                     // ULID, stable across refinements where possible
    pub title: String,
    pub spec_markdown: String,          // acceptance criteria
    pub relevant_files: Vec<RelevantFile>,
}

pub struct RelevantFile {
    pub path: String,
    pub certainty: FileCertainty,        // Confirmed | Candidate
    pub reason: String,                  // short string explaining why this file is relevant
}

pub enum FileCertainty { Confirmed, Candidate }

pub struct DraftAssumption {
    pub id: String,                      // ULID, stable across refinements
    pub statement: String,               // "Assuming the rate limit is per-user, not per-IP"
}
```

### Edits schema

```rust
pub struct BriefingEdits {
    pub title: Option<String>,
    pub description: Option<String>,
    pub task_edits: Vec<TaskEdit>,
    pub task_additions: Vec<DraftTask>,
    pub task_removals: Vec<String>,      // task ids to remove
    pub assumption_pushbacks: Vec<AssumptionPushback>,
}

pub struct TaskEdit {
    pub task_id: String,
    pub title: Option<String>,
    pub spec_markdown: Option<String>,
    pub file_additions: Vec<RelevantFile>,
    pub file_removals: Vec<String>,      // paths to remove
}

pub struct AssumptionPushback {
    pub assumption_id: String,
    pub pushback: String,
}
```

### Task schema additions

**`TaskCreated`** — gains `relevant_files: Vec<RelevantFile>` (same shape as in the briefing draft). Empty array for tasks created via the quick-task shortcut or other paths that don't have file awareness. Bump `TaskCreated` to v3.

The `task_projection` table gains a `relevant_files` JSON column.

### Plan schema additions

**`PlanCreated`** — `source` enum gains `"briefing"`. `source_metadata` for briefing-sourced plans includes `{ briefing_id: string, generation_count: integer }`.

## Milestones

### Milestone 1: Briefing aggregate and projection

- Update `docs/events.md` with the new aggregate, events, and schema additions.
- Implement Rust event types and serde derivations.
- Implement `briefing_projection` table in the per-workspace db. Columns: `id`, `workspace_id`, `status` (`active | completed | cancelled`), `current_draft_json`, `generation_count`, `provider`, `model`, `initial_description`, `created_at`, `updated_at`.
- Implement appliers for all Briefing events. The current_draft is updated on each `BriefingDraftProduced`; edits and pushbacks are recorded but don't mutate `current_draft` directly (they become context for the next refinement).

### Milestone 2: Briefing prompt template and CLI invocation

The system prompt instructs the model to: explore the codebase, produce a draft plan as JSON, list assumptions made, populate `relevant_files` per task with file paths it has actually inspected.

Bundle a default prompt at `src-tauri/src/prompts/defaults/briefing.md`:

```
You are helping a developer plan a feature. Your job is to produce a structured plan with tasks ready to be executed by separate AI agents.

## Process

1. Read the codebase. Look at directory structure, package files, README, and any files relevant to the feature description. Spend real effort here — the quality of the plan depends on understanding the actual code.

2. Identify ambiguities in the user's description. For each ambiguity, decide a reasonable default *and* record the assumption you made.

3. Decompose the feature into tasks. Each task should be:
   - Independently executable (an agent can complete it without depending on parallel tasks)
   - Scoped to ~30 minutes of agent work
   - Verifiable (clear acceptance criteria)

4. For each task, identify the files most likely to be touched. Only include files you have actually read. Mark each file as "Confirmed" (you're sure it's relevant) or "Candidate" (you suspect but didn't fully verify). Include a short reason explaining why each file is in the list.

5. {{#if previous_draft}}You produced a previous draft. The user reviewed it and provided edits and pushbacks below. Refine your plan to incorporate their direction. Do not regress on points they accepted; focus changes on what they edited or pushed back on.{{/if}}

## Output

Respond with ONLY a JSON object matching this schema:

{
  "title": "Short feature title",
  "description": "Markdown description of the feature",
  "tasks": [
    {
      "id": "task-1",
      "title": "Task title",
      "spec_markdown": "Acceptance criteria as markdown, numbered list preferred",
      "relevant_files": [
        { "path": "src/foo.ts", "certainty": "Confirmed", "reason": "Contains the existing X logic" }
      ]
    }
  ],
  "assumptions": [
    { "id": "assumption-1", "statement": "Assuming X is per-user, not per-tenant" }
  ]
}

## User's feature description

{{user_description}}

{{#if previous_draft}}
## Previous draft

{{previous_draft_json}}

## User's edits and pushbacks

{{user_feedback_json}}
{{/if}}
```

Implement a `briefing` Rust module:

```rust
pub async fn run_briefing_generation(
    workspace_path: &Path,
    provider: &dyn Provider,
    model: &str,
    user_description: &str,
    previous_draft: Option<&BriefingDraft>,
    user_feedback: Option<&BriefingEdits>,
) -> Result<BriefingDraft, BriefingError>;
```

The function:

1. Loads the briefing prompt template (resolved from `<workspace>/.yourapp/prompts/briefing.md` or bundled default).
2. Renders the template with the user's description and (if refining) the previous draft + feedback.
3. Calls the provider's `invoke_structured` or equivalent with the rendered prompt and the JSON schema.
4. Parses the response. On parse failure, retries once with a stricter "respond with only JSON, no other text" suffix. After two failures, returns `BriefingError::ParseFailed`.
5. Returns the parsed draft.

The CLI invocation runs in the workspace root (not a worktree — briefings are pre-task), with the standard subprocess hardening (env vars, stdin closed, etc.).

### Milestone 3: File path validation

After each draft is produced, validate each `relevant_files.path`:

```rust
pub fn validate_draft_paths(
    workspace_path: &Path,
    draft: &BriefingDraft,
) -> Vec<PathValidationResult>;

pub struct PathValidationResult {
    pub task_id: String,
    pub path: String,
    pub exists: bool,
}
```

Simple `Path::exists` check on each file, prefixed with the workspace root. Results are stored on `BriefingDraftProduced` and surfaced in the UI as warnings on non-existent paths.

### Milestone 4: Tauri commands

```rust
#[tauri::command]
async fn start_briefing(
    workspace_id: String,
    initial_description: String,
    provider: String,
    model: String,
) -> Result<Briefing, AppError>;

#[tauri::command]
async fn generate_briefing_draft(
    briefing_id: String,
) -> Result<BriefingDraft, AppError>;
// Called immediately after start_briefing for the first draft, and after refine_briefing for subsequent drafts.

#[tauri::command]
async fn apply_briefing_edits(
    briefing_id: String,
    edits: BriefingEdits,
) -> Result<(), AppError>;
// Records the user's edits as a BriefingDraftEdited event. Updates a "pending edits" field on the projection so the UI can reflect them; doesn't mutate the draft itself.

#[tauri::command]
async fn refine_briefing(
    briefing_id: String,
) -> Result<BriefingDraft, AppError>;
// Emits BriefingRefineRequested, runs generation with the previous draft + applied edits, emits BriefingDraftProduced, returns the new draft.

#[tauri::command]
async fn accept_briefing(
    briefing_id: String,
) -> Result<Plan, AppError>;
// Creates a Plan from the latest draft. Emits PlanCreated and TaskCreated for each task. Emits BriefingCompleted. Returns the new plan.

#[tauri::command]
async fn cancel_briefing(
    briefing_id: String,
) -> Result<(), AppError>;
```

The full event flow for a typical briefing:

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

### Milestone 5: Briefing route and setup screen

Add route `/workspace/:workspaceId/briefings/new`.

**Setup screen** (initial state, before any draft exists):

- Title at top: "New briefing"
- Big textarea: "Describe the feature you want to build. Be as vague or detailed as you like — the model will ask itself the right questions."
- Provider/model selector below the textarea (same dropdown components used elsewhere)
- "Start briefing" button (primary). "Cancel" button (returns to plans list).

On click, calls `start_briefing` then `generate_briefing_draft`. Shows a loading state ("Reading your codebase...") while the CLI works. Real-time elapsed timer ("12s elapsed") so the user knows it's still running. Loading can take 30-90 seconds for a real codebase; this is fine, but the user needs to see progress isn't frozen.

### Milestone 6: Draft review screen

Once the first draft is produced, the route renders the review screen.

**Layout:**

- Header: briefing title (editable, click to edit inline), generation count ("Draft 1 of N"), provider/model badge.
- **Description section:** the draft's markdown description, click to edit.
- **Assumptions section:** list of assumptions. Each row:
  - Assumption text
  - "Push back" button → opens an inline input for the pushback text
  - Existing pushbacks display below the assumption
- **Tasks section:** a list of task cards. Each card:
  - Editable title and spec markdown
  - "Relevant files" subsection: chips for each file. Each chip shows:
    - Path (mono)
    - Certainty marker (small dot — solid for Confirmed, outlined for Candidate)
    - Warning indicator if the path doesn't exist (small ⚠ with tooltip "File not found in workspace")
    - Reason on hover
    - X button to remove
  - "+ Add file" affordance to manually add a path
  - "Remove task" button on the card
- **+ Add task** button at the bottom of the task list.

**Action bar at the bottom:**

- "Accept and create plan" (primary, only enabled if at least one task exists)
- "Refine again" (visible if user has edits or pushbacks pending; runs `refine_briefing`)
- "Cancel briefing" (calls `cancel_briefing`, navigates back)

**Edit tracking:**

Edits are tracked in local component state until the user clicks "Refine again" or "Accept." On "Refine again," the local edits are sent via `apply_briefing_edits` (emitting `BriefingDraftEdited`) before `refine_briefing` is called. On "Accept," edits are merged into the final draft used to create the Plan.

This means: the canonical state of the draft is the latest `BriefingDraftProduced` event; the user's in-progress edits are component state. The two combine when refining or accepting.

### Milestone 7: Plan creation from accepted draft

When `accept_briefing` is called:

1. Take the latest draft + the user's pending edits.
2. Apply edits to produce the final draft.
3. Emit `PlanCreated` with `source: "briefing"`, `source_metadata: { briefing_id, generation_count }`.
4. For each task in the draft, emit `TaskCreated` with `plan_id`, `title`, `spec_markdown`, `relevant_files`.
5. Emit `BriefingCompleted` with the new `plan_id` and `final_generation_index`.
6. Return the Plan to the frontend, which navigates to `/workspace/:workspaceId/plan/:planId`.

All emissions in the same logical operation but each via separate `append_events` calls per aggregate (Plan, Task, Briefing are different aggregates with their own event streams).

### Milestone 8: Implementer prompt update

Update the bundled implementer prompt to include `relevant_files` when present:

Add this block after the existing `## Acceptance Criteria` section:

```
{{#if relevant_files}}
## Likely files to touch

The plan author identified these files as likely targets for this work. Use this as guidance — read them first. You may modify other files if needed; this is not an exhaustive list.

{{#each relevant_files}}
- `{{path}}` — {{reason}}{{#if (eq certainty "Candidate")}} *(candidate)*{{/if}}
{{/each}}
{{/if}}
```

The `PromptContext` for the implementer phase needs `relevant_files: Vec<RelevantFile>` populated from the task's `relevant_files`. This is task-level data, not phase-run-specific.

If a task has no `relevant_files` (e.g. created via quick-task shortcut), the section is omitted entirely from the prompt.

### Milestone 9: Briefing entry point in plans list

On the plans list view (`/workspace/:workspaceId/plans`):

- The "+ New plan" button now offers two options via a small dropdown or split button:
  - "New plan from briefing" → `/workspace/:workspaceId/briefings/new`
  - "New plan (manual)" → existing dialog for manual plan creation
- The briefing route is the recommended path for non-trivial plans; the manual path stays for quick one-off plans the user already has clearly in mind.

If a briefing was started but never completed, it shows in the plans list as a separate section ("In-progress briefings") with a status indicator and a "Continue" link. Cancelled briefings don't show.

### Milestone 10: Briefing history (optional, light)

A small affordance: from a plan that was created via briefing, a link "Created from briefing" → opens a read-only view of the briefing's transcript (initial description, all drafts in sequence with edits and pushbacks visible).

This is the audit trail. It's read from the briefing's event history. Useful for "why does this plan look the way it does" — a user can see what they pushed back on and what assumptions the model made.

Light v1: just render the events as a chronological list with a clear visual hierarchy. Doesn't need to be pretty. The data is there in events; presenting it is straightforward.

## Conventions

- Read and update `docs/events.md` before implementing.
- Tauri events emitted **after** transaction commit. One `projection_updated` per affected aggregate.
- Cross-aggregate emissions in `accept_briefing` (Plan, Tasks, Briefing) are sequential; if any fails mid-way, log and surface the error to the user. The user can retry; partial state in the projections will be reconciled by `rebuild_projections` if needed.
- TanStack Query for all reads. The briefing route's queries refetch on `projection_updated` for the briefing aggregate.
- Typed errors with `thiserror`. New variants: `BriefingError::ParseFailed`, `BriefingError::CliInvocationFailed`, `BriefingError::WorkspaceNotFound`, etc.
- shadcn primitives for UI: Card, Badge, Input, Textarea, Button, Select.
- Markdown rendering for descriptions and specs uses `react-markdown` (already in the project from earlier phases).

## Out of scope

- Conversational chat-style briefings (deliberate — Option C only)
- Briefing templates ("plan from a starter template")
- Importing existing PRDs as a separate flow (paste it into the initial description; same path)
- Linear / GitHub / external integrations as briefing sources (next phase, slots into the same flow as initial description seeding)
- Mid-briefing CLI provider switching (start a new briefing if you want to change provider)
- Embedding-based or grep-based file relevance scoring (mitigation 3 from the design discussion — defer)
- Showing the model's exploration trace (mitigation 2 — defer until a CLI exposes it)
- Briefing collaboration (multi-user editing of a draft) — single-user only
- Auto-save of edits (edits are component state; explicitly applied via Refine or Accept)
- Animation or transitions in the review screen
- Per-task model selection during briefing (whole briefing uses one provider+model)

## Deliverable

A working app where:

1. Clicking "New plan from briefing" on the plans list opens the briefing setup screen.
2. After describing a feature and selecting a provider, the model produces a draft with title, description, tasks (each with relevant_files and reasons), and assumptions.
3. The review screen shows all parts of the draft, editable inline.
4. Files that don't exist on disk are flagged with a warning indicator.
5. The user can push back on assumptions, edit anything, and refine the draft (re-runs the CLI with the edits as context).
6. On accept, a Plan is created with N Tasks, each carrying its `relevant_files`.
7. The implementer phase prompt now includes the `Likely files to touch` section when `relevant_files` is present.
8. Briefings in progress appear in the plans list and can be resumed.
9. A completed plan links back to its briefing transcript for audit.
10. `docs/events.md` reflects the new Briefing aggregate, the schema additions to TaskCreated/PlanCreated, and the new event types.

Plus tests on:
- Briefing event flow (start → generate → edit → refine → accept) producing the expected events
- File path validation correctly identifying existent vs non-existent paths
- Plan creation from accepted draft producing correct Task events with `relevant_files`
- The briefing prompt template rendering with and without `previous_draft` context

Commit after each milestone. Milestones 1-4 are backend (one logical chunk); 5-7 are core UI (another); 8-10 are polish and integration. Three to four commits is reasonable.
