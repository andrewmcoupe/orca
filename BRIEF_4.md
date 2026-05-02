# Brief for Claude Code: Plan Aggregate and Hierarchy Refactor

## Progress so far (resume here)

**Done — backend half (M1–M5), committed on `main`:**

- `de54f49` M1: dev data wiped (per-workspace `.orca/events.sqlite` files removed; workspace registrations preserved). `docs/events.md` updated with the Plan aggregate, the full Plan event catalog, the projection table description, and the TaskCreated v2 changes.
- `2e4b3d4` M2-M3: Plan event types, `plan_projection` table (in `events/projections.rs`), applier for all 7 Plan events, Tauri commands `create_plan` / `revise_plan` / `pause_plan` / `resume_plan` / `cancel_plan` / `archive_plan` / `list_plans` / `get_plan`. `recent_events::summarize` extended with Plan event summaries. `rebuild_projections` includes `plan` aggregate. Commands registered in `lib.rs`.
- `4b2f461` M4: `TaskCreated` bumped to **version 2**, payload now `{ plan_id, title, spec_markdown }` (lost `workspace_id`, `source`, `prd_id` — `workspace_id` is derived from the parent plan in the applier). `task_projection` gains `plan_id NOT NULL` and drops `source` / `prd_id`. `create_task(plan_id, title, spec_markdown)` and `list_tasks(plan_id)` signatures updated. Cross-aggregate counter updates implemented in the Task and PhaseRun appliers (TaskCreated → `task_count++`, TaskMerged → `done_task_count++`, PhaseRunStarted → `running_task_count++`, PhaseRunCompleted → `running--`, PhaseRunFailed → `running--, failed++`). All counters live on `plan_projection`.
- `1a02f1d` M5: `maybe_complete_plan` helper called after `mark_task_merged` and `cancel_task` commit; emits `PlanCompleted` as a separate `append_events` call when all sibling tasks are terminal and the plan is still active/paused. Concurrency conflicts and missing rows are logged and ignored. Tests in `commands::tests` cover the predicate (`plan_completion_eligible`).

**Known state to be aware of when starting M6:**

- The old `src/App.tsx` will throw at runtime once a workspace is re-added — it still calls the v1 task command shapes (`create_task({ title, specMarkdown })`, `list_tasks()` with no args). That's expected; M6 replaces this file end-to-end with the routed UI.
- `src/router.tsx` exists but is the stock `@tanstack/react-router` Home/About template — treat M6 as building the route tree from scratch, not extending an existing one.
- Tailwind v4 + shadcn are wired (the only shadcn primitive currently installed is `Button`; add others via `pnpm dlx shadcn add ...` as needed).
- Per-workspace dbs are empty. The user will re-add workspaces fresh — no migration code needed for old data.
- Uncommitted at session boundary: `BRIEF_4.md` (this file), `package.json`, `pnpm-lock.yaml`, `vite.config.ts`, `src/router.tsx`. These are the prerequisite Tailwind/shadcn/router setup — leave them in place; commit them as part of M6 when you start touching the UI.
- 16 tests pass (`cd src-tauri && cargo test --lib`).

**Next up: M6** (route tree). Then M7 (sidebar), M8 (plan list), M9 (plan detail), M10 (task detail), M11 (quick-task ⌘N). Commit after each. The "Conventions, repeated" section at the bottom of this brief still applies verbatim.

## Context

The app currently has a flat hierarchy: workspaces contain tasks contain phase runs. We're introducing a new aggregate, **Plan**, that sits between workspace and task:

```
Workspace
  └── Plan
        └── Task
              └── PhaseRun
```

Reasons: tasks naturally come in groups (a PRD produces N tasks, a Linear ticket might produce a few), groups need shared context (description, source, lifecycle), and groups need shared actions (merge together, cancel together). "Plan" is the right level of granularity for sidebar navigation; tasks are too granular.

This is a structural refactor. It touches the event schema, the projections, the routes, and the sidebar layout. Take it carefully and in order.

**Prerequisites already in place** (do not redo):

- Use `Link` and `useNavigate` from `@tanstack/react-router` for all in-app navigation. Use Zod schemas via `validateSearch` for typed search params. Do not use route `loader` functions — data fetching stays in components via TanStack Query.
- shadcn/ui is installed with Tailwind v4. Use shadcn primitives for new components.
- TanStack Query is set up with `staleTime: Infinity` and global `projection_updated` invalidation.
- Existing dev data will be wiped — no migration needed. We start fresh with the new schema.

Read `docs/events.md` first. You'll be updating it as part of this work.

## Goals of this phase

1. Introduce the Plan aggregate with its own events, projection, and lifecycle.
2. Migrate Task to belong to a Plan (every task has a `plan_id`).
3. Extend the existing route tree to reflect the hierarchy.
4. Rebuild the sidebar as a workspaces accordion with plans as primary navigation under each workspace.
5. Build plan list and plan detail views; refactor task detail to live under plans.

## Milestones

### Milestone 1: Wipe dev data and update events.md

- Delete all per-workspace event stores. The user will re-add workspaces fresh.
- Delete the global db's task-related rows if any leak there (workspaces stay).
- Update `docs/events.md`:
  - Add a Plan aggregate section to the Aggregates list. Description: "A plan groups related tasks and carries shared context — a PRD, a Linear ticket, or an ad-hoc grouping. Has its own lifecycle independent of tasks: a plan can be paused or cancelled even while tasks are idle."
  - Add the Plan event catalog (see below).
  - Update the Task event catalog: `TaskCreated` gains `plan_id: string`. Remove `source` and `prd_id` from `TaskCreated` — these now live on the Plan and are not duplicated on Task.
  - Add the Plan projection table to the Projection Strategy section.

### Milestone 2: Plan event catalog

Add these events to the schema. All on the Plan aggregate.

**PlanCreated**
- `workspace_id: string`
- `title: string`
- `description: string` — markdown; the PRD content, Linear ticket body, or short manual description
- `source: "manual" | "prd_file" | "linear" | "github_issue"` — extensible; only `manual` and `prd_file` are used immediately
- `source_metadata: object | null` — provider-specific (e.g. `{ external_id: "LIN-123", url: "..." }` for Linear). Null for `manual`.

**PlanDescriptionRevised**
- `title: string` — full new title
- `description: string` — full new description
- `reason: string | null`

**PlanPaused**
- `reason: string | null`

**PlanResumed**

**PlanCompleted**
- Emitted when all tasks belonging to the plan are in a terminal state (merged or archived). Auto-derived: when a `TaskMerged` or `TaskArchived` lands and the plan's other tasks are also terminal, emit this. Records the moment for display purposes.

**PlanCancelled**
- `reason: string`

**PlanArchived**

Conventions: same as everything else — past tense, additive only, no field renames or removals.

### Milestone 3: Plan aggregate, projection, and command handlers

- Implement event types in Rust as a new `events::plan` module (or wherever your existing event modules live).
- Implement `plan_projection` table in the per-workspace db. Columns: `id`, `workspace_id`, `title`, `description`, `source`, `source_metadata`, `status` (`active | paused | completed | cancelled | archived`), `task_count`, `running_task_count`, `done_task_count`, `failed_task_count`, `created_at`, `updated_at`.
- Implement the applier for all Plan events.
- Implement Tauri commands:
  - `create_plan(workspace_id, title, description, source, source_metadata) -> Plan`
  - `revise_plan(plan_id, title, description, reason) -> Plan`
  - `pause_plan(plan_id, reason)`
  - `resume_plan(plan_id)`
  - `cancel_plan(plan_id, reason)`
  - `archive_plan(plan_id)`
  - `list_plans(workspace_id) -> Vec<Plan>`
  - `get_plan(plan_id) -> Plan`
- Each command goes through `append_events`, applier updates projection, command handler emits `projection_updated`.
- The `plan_projection` row's `task_count` / `running_task_count` / `done_task_count` / `failed_task_count` are maintained by the **Task** applier, not the Plan applier. When `TaskCreated` lands, increment `task_count` for that plan. When `PhaseRunStarted` lands, look up the task's plan and update running counts. And so on. This is cross-aggregate projection update — fine, since it's all in the same workspace db.

### Milestone 4: Update Task aggregate

- `TaskCreated` event payload changes: gains `plan_id: string`, loses `source` and `prd_id`. Update the event versioning — bump `TaskCreated` to version 2. Old version 1 events: there are none (data wiped), so no upcaster needed. Document this in events.md.
- `task_projection` table gains a `plan_id` column. Foreign-key relationship is logical, not enforced at SQLite level.
- `create_task` command signature changes: `create_task(plan_id, title, spec_markdown) -> Task`. Removed `workspace_id` parameter — it's derived from `plan_id`.
- `list_tasks` command signature changes: `list_tasks(plan_id) -> Vec<Task>`. The "all tasks in a workspace" query is no longer the primary access pattern. If you need it for something, add `list_tasks_in_workspace(workspace_id)` separately, but I don't think you'll need it.

### Milestone 5: Auto-completion logic

When a `TaskMerged`, `TaskArchived`, or `TaskCancelled` event lands, the Task applier runs a check:

- Look up the task's `plan_id`.
- Query: are all tasks in this plan in a terminal state (merged, archived, or cancelled)?
- If yes, and the plan is not already completed/cancelled/archived, emit a `PlanCompleted` event.

This is the only "automatic" event in the system so far. Implement it carefully:

- The check happens *after* the triggering event's transaction commits.
- The `PlanCompleted` emission is a separate `append_events` call. If it fails (e.g. concurrency conflict because the user paused the plan in the same instant), log and move on. Don't retry aggressively.
- The applier for `PlanCompleted` updates `plan_projection.status` to `completed` and stamps `updated_at`.

### Milestone 6: Extend the route tree

The router and existing routes are in place. This milestone extends the tree to introduce Plan as a level in the hierarchy.

**Final route tree after this milestone:**

```
/                                                   → workspaces home
/workspace/:workspaceId                             → redirect to /workspace/:workspaceId/plans
/workspace/:workspaceId/plans                       → plans list (this workspace)
/workspace/:workspaceId/plan/:planId                → plan detail (shows tasks list within the plan)
/workspace/:workspaceId/plan/:planId/task/:taskId   → task detail (phase runs, output)
/workspace/:workspaceId/providers                   → providers config (unchanged)
/workspace/:workspaceId/settings                    → workspace settings (unchanged)
/settings                                           → global app settings (unchanged)
```

**Specific changes to make:**

- Add `/workspace/:workspaceId/plans` route. This becomes the workspace's primary view..
- Make `/workspace/:workspaceId` a redirect to `/workspace/:workspaceId/plans`. Use TanStack Router's `redirect` in a `beforeLoad` or a wrapper component — your call, but a simple `<Navigate>` from a stub component is fine.
- Add `/workspace/:workspaceId/plan/:planId` route for plan detail.
- Create `/workspace/:workspaceId/plan/:planId/task/:taskId`. The component itself doesn't change much (see Milestone 10), but its location in the tree does.
- Update every `Link` and `useNavigate` call in the codebase to use the new routes. Sidebar links, breadcrumb links, "view task" buttons — all of them.

**Conventions** (already in use in the existing routes — keep applying them):

- Lowercase hyphenated paths.
- Singular nouns for parameterised segments (`/plan/:planId`), plural for collection routes (`/plans`).
- camelCase param names matching the aggregate (`workspaceId`, `planId`, `taskId`).
- `useParams({ from: routeId })` to read params (with the `from` for typing).
- Typed search params via Zod schemas in `validateSearch`.

**Workspace activation hook** (probably already in your `WorkspacePage` or equivalent route component): make sure it still fires on workspace change. The route param is the source of truth for which workspace's event store is open.

**Breadcrumb component:** add or update a breadcrumb component shown at the top of the workspace-scoped main content area. Format: `Workspace name / Plan title / Task title`. Each segment is a Link to the corresponding route. The component reads the current route's params and fetches projection rows for the names. Hide the segments that don't apply (no plan in scope → no plan segment).

### Milestone 7: Sidebar accordion

Replace the current sidebar with a workspaces accordion.

**Top section: workspaces**

- A "+" button at the very top to add a new workspace (opens the existing folder picker flow).
- Each registered workspace is an accordion item. Header shows: workspace name, and a small live indicator if any tasks in this workspace have running phase runs (e.g. ` · 2 running` in muted text, or a pulsing dot).
- Expanded state shows the workspace's nav items as Links:
  - **Plans** → `/workspace/:workspaceId/plans` — count badge showing total plans (e.g. `8`)
  - **Providers** → `/workspace/:workspaceId/providers` — count showing healthy/total (e.g. `4/5`)
  - **Settings** → `/workspace/:workspaceId/settings`
- Clicking a workspace header expands/collapses. Clicking a nav item navigates *and* ensures the workspace is expanded.
- Expansion state persists per workspace in app state (so toggling between workspaces doesn't lose it). Use `localStorage` for now — fine for this scope.
- Active state on nav items: use TanStack Router's `Link` with `activeProps` for styling. The currently-active workspace's header gets a subtle highlight (e.g. accent-coloured left border).

**Bottom section: global**

- Divider.
- **Settings** → `/settings`
- **About**

**Visual tone**

- Dense and quiet. No icons next to every workspace name. Nav items inside workspaces can have small icons (Plans, Providers, Settings have natural Lucide icons).
- Counts and "running" indicators should be muted-foreground colour, not primary — they're ambient info, not call-outs.

### Milestone 8: Plan list view

Route: `/workspace/:workspaceId/plans`.

A list of plans for the workspace. Each row shows:

- Title
- Source icon (small icon for `manual`, `prd_file`, `linear`, etc.)
- Status badge (active, paused, completed, cancelled, archived)
- Task summary: "5 done · 2 running · 1 failed" — coloured counts
- Updated timestamp (relative: "2 hours ago")

**Search/filter as typed search params.** Define the schema on the route:

```tsx
validateSearch: z.object({
  status: z.enum(["active", "paused", "completed", "archived", "all"]).default("active"),
  q: z.string().default(""),
}),
```

Above the list:

- Search input bound to the `q` search param (debounce ~150ms before pushing the URL update).
- Status filter (segmented control or select) bound to `status`.
- "+ New plan" button (opens a dialog: title, optional description, source defaults to `manual`).

Sort: most-recently-updated first.

The reason for typed search params: filter state survives navigation away and back, can be deep-linked, and is fully typed at the call site.

### Milestone 9: Plan detail view

Route: `/workspace/:workspaceId/plan/:planId`.

Layout:

- Top: plan title, status, source icon. Action buttons: Edit, Pause/Resume, Cancel, Archive.
- Below title: rendered markdown of the plan's description. Use a markdown renderer (e.g. `react-markdown` with sensible defaults — no GFM tables required for v1, just basic markdown).
- Below description: the plan's tasks as a list. Same shape as the old workspace task list, but scoped to this plan.
- "+ New task" button creates a task within this plan.

Edit action opens a dialog with title and description fields, calls `revise_plan`.

Each task row links to `/workspace/:workspaceId/plan/:planId/task/:taskId`.

### Milestone 10: Task detail view

Route: `/workspace/:workspaceId/plan/:planId/task/:taskId`.

Mostly unchanged from the current task detail view — but the route is now nested under a plan. Update:

- Breadcrumb shows workspace → plan → task. The plan segment is clickable.
- Add a "Back to plan" link that navigates to `/workspace/:workspaceId/plan/:planId`.
- Remove anything that currently shows workspace context inline — the breadcrumb covers it.

If the route currently has typed search params (e.g. for which phase tab is selected), preserve them.

### Milestone 11: Quick-task UX shortcut

The "manual one-off task" case shouldn't require explicitly creating a plan first.

- A global keyboard shortcut (`⌘N` or similar) opens a "Quick task" dialog from anywhere.
- The dialog asks: title (required), spec (optional, multiline).
- On submit: creates a plan with `source: "manual"`, title = task title, description = "" (empty), then creates one task inside that plan with the given title and spec. Navigates via `useNavigate` to `/workspace/:workspaceId/plan/:planId/task/:taskId` for the new task.
- The user thinks "I made a task." The system has a plan with one task. Consistent under the hood, frictionless on the surface.

The shortcut needs the current workspace context. Read the `:workspaceId` from the active route via `useParams`. If the user isn't in a workspace context (on `/settings` or `/`), either disable the shortcut or prompt for which workspace to add to.

## Conventions, repeated

- Read and update `docs/events.md` before implementing the events.
- Tauri events emitted **after** transaction commit. One `projection_updated` per affected aggregate.
- Cross-aggregate projection updates (Task applier updating Plan projection counts) happen in the same transaction as the event append.
- TanStack Query for all reads. Standard invalidation pattern. Plan projection invalidation should also invalidate the workspace's plan list query.
- TanStack Router for all navigation. `Link`, `useNavigate`, `useParams`, `useSearch` — typed against the route tree. No `<a href>` for internal links. **Do not use route `loader` functions** — data fetching stays in components via `useQuery`.
- Typed errors with `thiserror`. No `anyhow` in library code.
- Auto-derived events (`PlanCompleted` from terminal task states) are emitted after the triggering event's transaction commits, not inside it. Failures are logged and ignored.
- shadcn primitives for all new UI. No bespoke components unless there's a clear reason.

## Out of scope for this phase

- PRD file ingestion (the producer of `source: "prd_file"` plans). Comes next.
- Linear / GitHub / external integrations (the producers of `source: "linear"` etc.). Later.
- Plan-level merge (merging all tasks in a plan as one PR). Comes with the merge phase.
- Plan templates / copying plans.
- Drag-and-drop reordering of tasks within a plan.
- Multi-select operations on plans (bulk archive, etc.).
- Plan-level notes/comments separate from description.
- Sidebar resize, sidebar collapse-to-icons.
- File-based routing (stay with code-based).

## Deliverable

A working app where:

1. The sidebar is an accordion of workspaces, each expanding to show Plans / Providers / Settings as Links.
2. Adding a workspace from the "+" button at the top works.
3. Clicking "Plans" under a workspace navigates to `/workspace/:workspaceId/plans` and shows the plan list view.
4. Creating a plan, opening it, creating tasks inside it, running phases all work via the new routing.
5. The breadcrumb at the top of every workspace-scoped view reflects the hierarchy correctly and is navigable.
6. The plan list view's search and status filter use typed search params and survive navigation.
7. The quick-task shortcut (⌘N) works from anywhere within a workspace context and produces a single-task plan, then navigates to the new task.
8. When a task transitions to a terminal state and it's the last non-terminal task in its plan, a `PlanCompleted` event lands and the plan's status updates.
9. `docs/events.md` is updated to reflect the new aggregate, the new events, and the changes to `TaskCreated`.

Plus tests on the auto-completion logic — this is the one bit of cross-aggregate event flow that's worth covering with a test.

Commit after each milestone. Milestones 1-5 are backend/schema; milestones 6-11 are routing + UI. There's a natural commit boundary between the two halves.
