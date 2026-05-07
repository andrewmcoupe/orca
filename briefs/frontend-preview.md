# Frontend Preview Server

## Summary

Add a lightweight “Open dev server and check” workflow for UI review. Orca should be able to start a configured frontend dev server from a task worktree, wait until it is reachable, and open the configured route in the user’s external browser. This is intentionally a manual review aid, not automated screenshot/video capture yet.

This feature is the foundation for a later UAT phase that can reuse the same preview-server infrastructure to run e2e tests from the task worktree.

## Product Goals

- Let a user quickly inspect UI changes from the task worktree without leaving Orca to manually find the right directory and command.
- Keep the workflow simple: Orca controls start/stop/status/logs, the browser renders the app.
- Support live-reload workflows while implementation is still running.
- Avoid overbuilding automated capture/spec/planner machinery for the MVP.

## Non-Goals

- Do not implement screenshots or video capture.
- Do not implement Playwright/e2e/UAT execution yet.
- Do not embed the preview inside Orca WebView.
- Do not persist preview logs as task artifacts/events.
- Do not support multiple concurrent preview servers.

## UX Contract

- Workspace settings gets a new **Preview server** section.
- Task detail action toolbar gets an **Open dev server and check** action.
- Clicking the action opens a small dialog where the user can confirm/override the route path.
- If no preview server is running, the dialog starts the configured command from the task worktree, waits for readiness, then opens the external browser.
- If the preview server is already running for the same task, the dialog can reopen the browser and stop the server.
- If the preview server is running for a different task, the dialog explains that only one preview server can run at a time and offers a stop action.
- If worktree initialization is not `initialized`, show a warning but allow start.
- Logs/status are in-memory only and clear when the server stops or the app restarts.

## Workspace Settings

Add `preview_server` to workspace settings with defaults:

```ts
type PreviewServerSettings = {
  enabled: boolean;
  command: string | null;
  base_url: string;
  health_path: string;
  default_route_path: string;
  startup_timeout_seconds: number;
};
```

Default values:

```json
{
  "enabled": false,
  "command": null,
  "base_url": "http://127.0.0.1:5173",
  "health_path": "/",
  "default_route_path": "/",
  "startup_timeout_seconds": 60
}
```

The settings UI should explain that the command runs from the task worktree, not the main workspace path.

## Backend Behavior

Add a backend preview server manager owned by app state.

Rules:

- Only one preview server may run globally per Orca app session.
- The process runs from the task worktree path.
- stdout/stderr are captured into an in-memory rolling log buffer.
- Readiness polls `base_url + health_path`.
- HTTP status `200-499` means ready.
- Connection refused/timeout means keep polling until timeout.
- HTTP `500+` means the server responded but is unhealthy; surface failure and logs.
- Stop command kills the process and clears running state.
- App shutdown kills any running preview server.

Suggested Tauri commands:

```ts
start_preview_server(taskId: string, routePath: string): PreviewServerStatus
get_preview_server_status(): PreviewServerStatus
stop_preview_server(): void
```

Status shape:

```ts
type PreviewServerStatus = {
  state: "idle" | "starting" | "running" | "failed";
  task_id: string | null;
  worktree_path: string | null;
  base_url: string | null;
  route_path: string | null;
  open_url: string | null;
  started_at: number | null;
  last_error: string | null;
  logs: string[];
};
```

The frontend can open `open_url` with `@tauri-apps/plugin-opener` after `start_preview_server` returns `running`.

## Task Availability

The action should be available when the task has an active worktree path/status.

Do not require implementer completion. Users may want to launch the dev server while implementation is running to observe hot reload/live changes.

Disable or show setup guidance when:

- Preview server settings are disabled.
- Preview server command is empty.
- Task has no worktree.
- Another task owns the running preview server.

Warn but do not block when:

- `worktree_init_status !== "initialized"`.

## Tasks

### Task 1: Add Preview Server Settings Model

Add preview server settings to the shared workspace settings model on both Rust and TypeScript sides.

Acceptance criteria:

1. `WorkspaceSettings` has a defaulted `preview_server` field.
2. Existing workspace settings JSON parses successfully without the field.
3. Frontend `WorkspaceSettings` type exposes the same shape and defaults.
4. Unit tests cover default parsing/round-trip where appropriate.

Likely files:

- `src-tauri/src/settings.rs`
- `src/features/workspaces/types.ts`

### Task 2: Add Preview Server Workspace Settings UI

Add a **Preview server** section to workspace settings.

Acceptance criteria:

1. User can enable/disable preview server support.
2. User can edit command, base URL, health path, default route path, and startup timeout.
3. Save writes through existing workspace settings update flow.
4. UI states match existing settings panel conventions.
5. Help text says the command runs from the task worktree.

Likely files:

- `src/routes/workspace/workspace-settings.tsx`
- `src/features/workspaces/components/preview-server-panel.tsx`
- `src/features/workspaces/hooks.ts`
- `src/features/workspaces/types.ts`

### Task 3: Implement Backend Preview Server Manager

Create backend infrastructure for one global long-running preview server.

Acceptance criteria:

1. App state owns a preview server manager.
2. Starting a server resolves the task worktree path and launches the configured command in that directory.
3. stdout/stderr are captured in a rolling in-memory log buffer.
4. Starting fails cleanly if another task already owns the running server.
5. Stop kills the child process and clears status.
6. App shutdown kills any running preview process.

Likely files:

- `src-tauri/src/lib.rs`
- `src-tauri/src/preview_server.rs`
- `src-tauri/src/commands.rs` or a new command module
- `src-tauri/Cargo.toml` if an HTTP client dependency is needed, though existing `reqwest` may already be available.

### Task 4: Add Preview Server Readiness Polling

Add readiness checking before returning a successful running status.

Acceptance criteria:

1. Backend polls `base_url + health_path` until ready or timeout.
2. HTTP `200-499` counts as ready.
3. HTTP `500+` fails with useful error and logs.
4. Connection failures retry until `startup_timeout_seconds`.
5. Returned status includes `open_url = base_url + route_path`.
6. Route path is normalized to start with `/`.

Likely files:

- `src-tauri/src/preview_server.rs`
- `src-tauri/src/settings.rs`

### Task 5: Add Frontend API And Hooks

Expose typed frontend API and hooks for preview server commands.

Acceptance criteria:

1. Frontend has typed `previewServerApi`.
2. Hooks support start, stop, and status fetch.
3. Query cache updates after start/stop.
4. Types match backend status shape.

Likely files:

- `src/features/preview-server/api.ts`
- `src/features/preview-server/hooks.ts`
- `src/features/preview-server/types.ts`

### Task 6: Add Task Action Dialog

Add **Open dev server and check** to the task action toolbar.

Acceptance criteria:

1. Action appears on task detail when a task has a worktree.
2. Clicking opens a dialog with route path input defaulted from workspace settings.
3. Dialog shows command/base URL from workspace settings.
4. Dialog warns if worktree init is not initialized but still allows start.
5. If settings are disabled/missing command, dialog shows setup guidance.
6. On successful start/running status, frontend opens `open_url` in external browser.
7. If already running for same task, action reopens browser and offers stop.
8. If running for another task, action explains conflict and offers stop.

Likely files:

- `src/features/tasks/components/task-action-toolbar.tsx`
- `src/features/preview-server/components/preview-server-dialog.tsx`
- `src/features/preview-server/hooks.ts`
- `src/routes/workspace/task-detail.tsx`

### Task 7: Manual QA And Failure States

Exercise the workflow against a Vite app.

Acceptance criteria:

1. Configure command `pnpm dev --host 127.0.0.1`.
2. Start preview from a task worktree and open `/`.
3. Override route path and reopen.
4. Stop server and verify process exits.
5. Attempt start while another task owns server and verify conflict handling.
6. Test bad command and verify logs/error display.
7. Test server returning non-2xx but below 500 and verify it still opens.

Likely files:

- No required code files unless QA reveals issues.

## Future Extension: UAT Phase

After this MVP lands, a UAT phase can reuse the preview server infrastructure:

- Start preview server from task worktree.
- Run configured e2e command.
- Capture test output, screenshots, video, and traces.
- Persist those as task artifacts/events.
- Gate merge readiness on UAT pass/fail when enabled.
