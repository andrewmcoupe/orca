# Brief: Persistent Live Terminal Sessions Across Navigation

We have a live terminal feature in the Orca desktop app. It currently works inside the task detail page, but terminal UI state is route-local. When a user navigates away from a task or workspace and later returns, the terminal tabs are lost because the task detail view unmounts.

Build production-grade persistence for terminal sessions so users can switch between tasks and workspaces, create terminals in different places, and return to each task with its terminal tabs, labels, output, active tab, and collapsed state intact.

## Current Context

- App: `apps/desktop`
- Frontend: React + TypeScript + TanStack Router + Tailwind
- Desktop runtime: Tauri 2
- Terminal frontend: `@xterm/xterm` + `@xterm/addon-fit`
- Terminal backend: Rust `portable-pty`
- Existing terminal files:
  - `apps/desktop/src/features/terminal/api.ts`
  - `apps/desktop/src/features/terminal/types.ts`
  - `apps/desktop/src/features/terminal/components/terminal-dock.tsx`
  - `apps/desktop/src-tauri/src/terminal.rs`
  - terminal commands are wired through `apps/desktop/src-tauri/src/commands.rs` and `apps/desktop/src-tauri/src/lib.rs`
- Existing placement:
  - terminal open button is an icon in the task action toolbar
  - terminal dock is a flex child at the bottom of the task detail middle pane
  - the right sidebar must not be affected by terminal layout

## Goal

Terminal sessions must survive route changes within the app.

Example behavior:

1. Open task A.
2. Open two terminals.
3. Run commands in each terminal.
4. Navigate to task B.
5. Open another terminal there.
6. Navigate to another workspace and open terminals there.
7. Return to task A.
8. The two original terminals are still present as tabs, with their labels, output, active tab, process state, and collapsed/expanded state preserved.

Navigating away should detach the terminal UI from the PTY session. It must not close the PTY session.

Only explicit close actions should close a terminal session.

## Required Behavior

- Persist terminal tab state by task/workspace scope.
- A task can have multiple terminal sessions.
- Different tasks can have independent terminal tab sets.
- Different workspaces can have independent terminal tab sets.
- Returning to a task should restore:
  - terminal tabs
  - active tab
  - collapsed/expanded state
  - backend terminal session IDs
  - frontend terminal labels
  - terminal output scrollback
- Closing a terminal tab must close the backend PTY session.
- Navigating away must not call `close_terminal`.
- App shutdown may still close all terminals.
- Terminal labels should continue to update from backend foreground process events.
- Terminal output should continue to be captured while the task page is not visible, so returning to the task shows what happened while away.

## Architecture Direction

Introduce a persistent terminal state layer instead of keeping terminal tabs in `TaskDetailView`.

Recommended frontend shape:

- Add a terminal store/provider under the workspace area, for example:
  - `apps/desktop/src/features/terminal/terminal-store.tsx`
  - or equivalent local pattern if the repo already has a preferred state location
- Key terminal groups by a stable scope key:
  - `workspaceId`
  - `taskId`
  - likely key format: `${workspaceId}:${taskId}`
- The store should own:
  - tabs per task
  - active tab ID per task
  - collapsed state per task
  - labels per terminal
  - scrollback buffers per terminal
  - lifecycle state such as connecting, open, exited, closed
- `TaskDetailView` should read/write terminal state through this store.
- `TerminalDock` should become a mostly presentational component plus xterm attach/detach behavior.

Recommended backend shape:

- Add an attach/list capability so the frontend can reattach to existing PTY sessions.
- Backend terminal manager should retain session metadata and scrollback.
- Add or extend commands as needed:
  - `list_terminals_for_task(workspace_id, task_id)` or equivalent
  - `attach_terminal(session_id)` returning current session metadata and recent scrollback
  - existing `create_terminal`, `write_terminal`, `resize_terminal`, `close_terminal` should continue to work
- Store a bounded scrollback buffer per backend terminal session.
  - Use a ring buffer or bounded `VecDeque`.
  - Keep enough output for useful restoration without unbounded memory growth.
  - Suggested default: last 10,000 chunks or a sane byte cap.
- When output is produced:
  - append it to backend scrollback
  - emit the existing `terminal_output` event
- When a frontend attaches:
  - return metadata and scrollback
  - then rely on live events for future output

## Important Lifecycle Rules

- Component unmount must dispose the xterm instance and event listeners only.
- Component unmount must not close the backend terminal.
- Close tab must:
  - update frontend store
  - call backend `close_terminal`
  - clean scrollback and metadata for that terminal
- If a backend terminal exits naturally:
  - mark it exited in the frontend
  - keep the tab visible unless the existing UX already removes exited terminals
  - show the exit status in the terminal output as currently implemented
- If reattach finds a terminal missing on the backend:
  - mark the frontend tab exited or remove it cleanly
  - do not crash the task detail page

## UI Requirements

- Keep the terminal dock anchored at the bottom of the task detail middle pane.
- Keep the main task content scrollable above it.
- The terminal must not span over the right sidebar.
- The right sidebar must not gain a scrollbar because of the terminal.
- Multiple terminals should remain tabs with close icons.
- Active tab should be restored when returning to a task.
- Collapsed/expanded state should be restored per task.
- Terminal text and chrome must remain theme-aware.
- Terminal content should use IBM Plex Mono.
- Do not introduce wide letter spacing in terminal output.

## Implementation Notes

- Preserve existing working behavior before refactoring.
- Keep changes scoped to terminal lifecycle/state and task detail integration.
- Avoid closing sessions in React cleanup handlers.
- Be careful with stale closures around terminal labels and output events.
- Avoid duplicate event subscriptions after repeated navigation.
- Resize the PTY after reattaching and after the dock becomes visible.
- If the backend stores scrollback, deduplicate replayed output and live output around attach time.
- Prefer explicit IDs from the backend over frontend-only generated IDs where possible.

## Acceptance Criteria

- User can open terminals on one task, navigate away, return, and see the same terminal tabs.
- Running processes continue while the user is on another route.
- Output produced while away is visible after returning.
- User can maintain terminals for multiple tasks at the same time.
- User can maintain terminals for tasks in different workspaces at the same time.
- Closing a tab closes only that terminal session.
- Navigating away from a task does not close its terminal sessions.
- The app does not hang when closing terminals.
- The right sidebar does not scroll because of terminal layout.
- Light and dark mode terminal text remains readable.
- `pnpm --filter orca build` passes.
- `cargo check` passes.
- Add focused tests where practical, especially around backend session listing/attach/scrollback behavior.

## Deliverable

Implement the persistent terminal session architecture end to end.

At completion, summarize:

- files changed
- lifecycle model
- how reattach/scrollback works
- verification commands run
- any residual limitations or follow-up work
