# Brief for Claude Code: Event Store Foundation

## Context

You're working on a Tauri 2 desktop app (React + TypeScript frontend, Rust backend). The app is event-sourced. The full event schema design is in `docs/events.md` — **read it before doing anything**. It is the source of truth for aggregates, event types, storage schema, and conventions.

The app currently has:

- A working Tauri scaffold with React frontend
- A global SQLite db at the OS app data dir (`directories` crate) for workspace registrations
- Three Tauri commands: `add_workspace`, `list_workspaces`, `remove_workspace`
- A minimal frontend that lists workspaces and lets the user add/remove them

## Goal of this phase

Build the event store foundation and prove it works end-to-end with a fake task flow. By the end, the user can create a task in the UI, watch fake phase events stream through the system into projections, and watch the UI react. No real AI providers yet — that comes later.

## Frontend state management

Install **TanStack Query** as the only state library:

```
pnpm add @tanstack/react-query
```

Wrap the app in `QueryClientProvider` with these defaults:

```tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
    },
  },
});
```

Those defaults matter. The backend pushes invalidation events explicitly; the cache should not refetch on its own.

Use plain React (`useState`, `useReducer`, `useContext`) for client UI state — active workspace ID, selected task, modal open/closed. Do **not** install Redux, Zustand, Jotai, or any other state library. Do **not** install a router yet — a `useState` discriminated union is sufficient for the few views in this phase. Do **not** install Tailwind, shadcn, or any UI library — plain unstyled HTML is fine while building plumbing.

Do not write a custom hook factory that wraps `invoke()`. Hand-write `useQuery({ queryFn: () => invoke('list_tasks') })` calls until a real pattern emerges.

## Reactivity model

The UI updates via this exact three-layer flow. Implement it precisely as described.

**Layer 1: `append_events` is synchronous and side-effect-free beyond the database.**

The function appends events and updates projections inside one SQLite transaction, returns the appended events to the caller, and emits nothing. Tauri event emission is **not** its responsibility.

**Layer 2: Command handlers emit Tauri events after the transaction commits.**

After `append_events` returns successfully, the command handler emits one `projection_updated` Tauri event per affected aggregate. The payload is invalidation-only — it describes what changed, not what the new state is:

```rust
#[derive(Serialize, Clone)]
struct ProjectionUpdated {
    workspace_id: String,
    aggregate_type: String,  // "task" | "phase_run" | "workspace"
    aggregate_id: String,
}
```

Do **not** include event payloads, projection rows, or streamed output in the Tauri event. The frontend's job is to re-read from projections, not to be pushed new state.

Emission must happen **after** transaction commit. If you emit before commit and the commit fails, the frontend invalidates and refetches, sees no change, and the resulting bug is confusing. Emit after, and the worst case is a successful write the UI doesn't immediately see — which self-corrects on the next invalidation.

**Layer 3: One global frontend listener invalidates TanStack Query keys.**

Set up a single listener at app root:

```tsx
import { listen } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';

function useProjectionInvalidation() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisten = listen<ProjectionUpdated>('projection_updated', (event) => {
      const { aggregate_type, aggregate_id, workspace_id } = event.payload;

      queryClient.invalidateQueries({
        queryKey: [aggregate_type, aggregate_id]
      });
      queryClient.invalidateQueries({
        queryKey: [aggregate_type, 'list', workspace_id]
      });
    });

    return () => { unlisten.then(fn => fn()); };
  }, [queryClient]);
}
```

Per-component listeners are an anti-pattern. One listener, all invalidations.

Use a consistent query key convention: `[aggregate_type, aggregate_id]` for single records, `[aggregate_type, 'list', workspace_id]` for lists. The invalidation logic depends on this convention.

## Scope

Implement these milestones in order. Stop after each and verify before moving on. Commit after each milestone with a clear message.

### Milestone 1: Per-workspace event store opens on workspace activation

- Add the concept of an "active workspace" to app state. Selecting a workspace in the sidebar sets it active.
- On activation, open (creating if needed) `<workspace_path>/.yourapp/events.sqlite`. Add `.yourapp/` to the repo's `.gitignore` automatically if not present.
- Apply the `events` table DDL exactly as specified in `docs/events.md`.
- Store the connection in Tauri managed state behind a `Mutex` (or `tokio::sync::Mutex` if async). One connection per active workspace; close the previous when switching.
- Add a Tauri command `get_active_workspace` that returns the current active workspace or null.

**Verify:** open the app, add a workspace, select it, confirm `.yourapp/events.sqlite` is created with the events table.

### Milestone 2: The append function

This is the foundation everything else calls. Implement carefully.

- Signature: `append_events(aggregate_type, aggregate_id, expected_seq, events: Vec<NewEvent>, metadata: EventMetadata) -> Result<Vec<AppendedEvent>, AppendError>`
- Atomic: wraps the inserts in a SQLite transaction. Either all events append or none.
- Optimistic concurrency: assert that the next seq for this aggregate equals `expected_seq + 1`. If `expected_seq` is `0`, this is the first event for the aggregate. If the assertion fails, return `AppendError::ConcurrencyConflict`.
- Idempotency: before appending, check if any existing event for this aggregate has the same `command_id` in metadata. If so, return the existing events with a flag indicating no-op.
- Each `NewEvent` carries `event_type`, `version`, and `payload` (already-serialized JSON). The function generates ULIDs, assigns sequential `seq` values, and stamps `created_at` (unix millis, UTC).
- Errors are typed: `ConcurrencyConflict`, `SerializationError`, `DatabaseError`. No string errors.

Write unit tests for: happy path, concurrency conflict, idempotent retry, multi-event atomic append.

### Milestone 3: One projection end-to-end (Workspace)

Use Workspace as the trial because it has the simplest events.

- Create `workspace_projection` table in the **global** db (workspaces are app-level, not workspace-scoped).
- Implement an applier: pure function `(current_projection, event) -> new_projection`. Dispatched on `event_type`.
- When `WorkspaceRegistered` is emitted, the applier inserts into `workspace_projection`. When `WorkspaceSettingsChanged` fires, it updates. When `WorkspaceArchived` fires, it marks archived.
- Wire it: refactor the existing `add_workspace` command to emit a `WorkspaceRegistered` event via `append_events`, then run the applier in the same transaction. The projection becomes the source of truth for reads; the events table is the source of truth for state.
- After the transaction commits, the command handler emits `projection_updated`.
- Frontend uses `useQuery(['workspace', 'list', null], () => invoke('list_workspaces'))` and is invalidated by the global listener.

**Verify:** adding a workspace creates both an event row and a projection row. Restarting the app still shows the workspace. The workspace list updates without manual refresh.

### Milestone 4: `rebuild_projections` command

A Tauri command that drops projection tables and rebuilds from events. Implement it now — it's a development necessity. Treat it as a first-class feature.

- Drops projection tables, recreates them, replays all events through the appliers in order.
- Accepts an optional `aggregate_type` filter to rebuild only one projection.
- Returns a summary: counts of events replayed and projections rebuilt.

**Verify:** manually corrupt a projection row, run `rebuild_projections`, confirm it's restored from events.

### Milestone 5: Task aggregate + fake phase flow

- Create `task_projection` and `phase_run_projection` tables in the per-workspace db (schema your call — driven by what the UI needs to show).
- Implement appliers for all Task and PhaseRun events from the event catalog in `docs/events.md`.
- Add Tauri commands: `create_task(title, spec_markdown)`, `list_tasks()`, `get_task(task_id)`, `start_fake_phase(task_id, phase)`.
- `start_fake_phase` spawns a background task (tokio) that:
  1. Emits `PhaseRunStarted` with hardcoded provider/model.
  2. Sleeps 500ms, emits a `PhaseRunOutputAppended` chunk. Repeats 5x.
  3. Emits `PhaseRunCompleted` with a fake summary.
- All events go through `append_events`. All projection updates happen in the applier. Each event append triggers a `projection_updated` Tauri event from the command handler.

### Milestone 6: Reactive UI

- Build a minimal task list view (titles + status) and task detail view (phase runs + their streamed output).
- "Create task" form: title + textarea. "Run fake implementer" button on a task.
- All data fetched via `useQuery`. The global `projection_updated` listener drives all updates.
- No optimistic updates yet. No streaming-specific channel. The uniform invalidation pattern is enough.

**Verify:** clicking "Run fake implementer" causes the detail view to update live as chunks arrive without any per-component event listeners or manual refetches.

## Conventions to follow

- **Read `docs/events.md` first.** All event names, payload shapes, metadata fields, and storage schema come from there. If anything is ambiguous, prefer the doc over your assumptions; if the doc is genuinely missing something, surface the gap rather than inventing.
- **No premature abstraction.** Don't build a generic event-sourcing framework. Build this app's event store. If a pattern emerges that obviously wants to be a trait or generic, extract it then — not before.
- **Serde for everything that crosses a boundary.** Event payloads, command args, projection rows returned to the frontend, Tauri event payloads.
- **Errors are typed.** Use `thiserror` for error enums. No `anyhow` in library code; `anyhow` is fine in Tauri command handlers as the outer layer.
- **Tests for the append function specifically.** It's the foundation; it deserves real coverage. Other code can be tested lightly for now.
- **No snapshots, no event versioning machinery yet.** The doc says we add these when measurement demands. Don't pre-build them.
- **No debouncing or batching of high-frequency events yet.** If `PhaseRunOutputAppended` causes performance issues, we'll address it then. Do not pre-build buffering.

## Out of scope for this phase

Do not build any of these, even if it seems natural:

- Real subprocess execution against `claude` or `codex` CLIs
- Worktree management
- Provider detection
- PRD ingestion
- Gates (typecheck/test/lint runners)
- Notifications, system tray, deep links
- UI polish — plain unstyled HTML is fine
- Optimistic mutations
- Streaming-specific Tauri event channels separate from `projection_updated`
- Routing, state libraries beyond TanStack Query

These are later phases. Staying focused on the event store spine is the whole point.

## Deliverable

When done: a working app where I can add a workspace, create a task, click "run fake implementer," and watch events stream into projections with the UI updating live via the uniform invalidation pattern. Plus the `rebuild_projections` command working. Plus tests on the append function.

Commit after each milestone with a clear message. Don't try to ship all six in one commit.
