# Brief for Claude Code: Diff Panel and Modal with Auditor Anchors

## Context

The app's task detail view shows the auditor's verdict and concerns abstractly — the user reads "the fix is mechanically correct" and a concerns list with file:line anchors, but has no way to see the actual code changes without leaving the app or opening the worktree externally.

This brief adds two surfaces for viewing the task's diff with auditor concerns rendered as inline anchors:

- **A right-side panel**, always visible on the task detail view, showing the unified diff with anchor markers in the gutter. Ambient awareness while reading the verdict.
- **A modal**, on-demand, side-by-side diff view (with unified toggle) for focused review. Wider, with file navigation and full-size code reading.

The connection between auditor concerns and concrete code changes is the distinctive feature. No editor or diff viewer makes this connection today.

**Prerequisites already in place:**

- `AuditorVerdictRendered` events with structured concerns (`{ category, severity, anchor: { path, line }, rationale, ... }`)
- Per-task git worktrees with auto-commit per phase, branch `yourapp/<task_id>`
- `Task.base_commit` recorded at worktree creation
- `git2` for git operations
- TanStack Query for data layer with `projection_updated` invalidation
- TanStack Router with `/workspace/:workspaceId/plan/:planId/task/:taskId` route
- shadcn/ui with Tailwind v4

Read no event schema docs — this brief doesn't change events. UI and data layer only.

## Goals

1. The task detail view has a resizable right panel (default 320px, draggable divider) showing the diff between the task's base commit and the worktree's current HEAD.
2. Auditor concerns from the latest auditor verdict render as inline anchors at their referenced lines.
3. A "Review diff" button on the panel opens a modal with side-by-side view, file navigation, and toggle to unified.
4. The diff updates live during active phase runs; freezes at phase completion.
5. Syntax highlighting via `syntect` (Rust-side) for both panel and modal.
6. Diff source handles three task states: live (worktree exists), merged (worktree gone, reconstruct from git), cancelled with branch (derive from branch), cancelled without branch (empty state).

## Design notes

**The diff is task-scoped, not phase-scoped.** Always `git diff <task_base_commit>..HEAD` from the worktree (or equivalent for merged tasks). Per-phase diffs are an interesting future feature; not in this brief.

**Auditor anchors come from the most recent `AuditorVerdictRendered` event for this task.** If the auditor has been re-run (after pass-back-to-implementer), use the latest verdict's concerns. Older verdicts' concerns are not displayed; the audit trail shows them for history.

**Anchor line numbers refer to the post-change file**, not the diff. Mapping anchor `{ path: "src/foo.ts", line: 42 }` to "the right place in the diff" requires translating to the new-file line numbers in the unified or side-by-side view. The diff data layer should pre-compute this mapping.

**Anchors might fall on context lines.** The auditor can reference a line that wasn't changed by the implementer (it's flagging context). Display the anchor at the line it references regardless of whether that line was a change.

**Anchors might reference files not in the diff.** Show these in the file list as "unchanged · 1 concern" with the marker, expandable to show the file content (read from worktree) with the anchor in place.

## Architecture

A clear separation of concerns:

- **Data layer (Rust):** produces structured diff data plus syntax-highlighted HTML, cached per task per commit-pair.
- **Anchor mapping (Rust):** takes the latest auditor verdict's concerns and maps them onto diff line numbers.
- **Right panel (React):** consumes the structured diff, renders the unified view with anchor gutters.
- **Modal (React):** consumes the same structured diff, renders side-by-side or unified based on user toggle.

The Rust side does the work; the frontend renders. Don't compute diffs in JS, don't highlight in JS.

## Milestones

### Milestone 1: Diff data layer

Build the Rust module that produces structured diff data. This is the foundation; everything else consumes it.

Add a new module `src-tauri/src/diff.rs`.

```rust
pub struct TaskDiff {
    pub task_id: String,
    pub base_commit: String,
    pub head_commit: String,
    pub source: DiffSource,
    pub files: Vec<DiffFile>,
    pub computed_at: i64,  // unix millis, for cache invalidation
}

pub enum DiffSource {
    Worktree,                  // live worktree exists, diffed against base
    MergedFromHistory,         // worktree gone, diff reconstructed from merge commit
    BranchOnly,                // branch exists but worktree gone (cancelled task)
    Unavailable { reason: String },  // can't produce a diff
}

pub struct DiffFile {
    pub path: String,
    pub old_path: Option<String>,  // for renames
    pub status: FileStatus,        // added, modified, deleted, renamed
    pub hunks: Vec<DiffHunk>,
    pub old_content: Option<String>,  // full old file (for side-by-side)
    pub new_content: Option<String>,  // full new file (for side-by-side)
    pub language: Option<String>,    // detected from extension; used for syntax highlighting
}

pub enum FileStatus { Added, Modified, Deleted, Renamed }

pub struct DiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<DiffLine>,
}

pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_lineno: Option<usize>,
    pub new_lineno: Option<usize>,
    pub content: String,
}

pub enum DiffLineKind { Context, Added, Removed }
```

Functions:

```rust
pub fn compute_task_diff(
    repo_root: &Path,
    task_id: &str,
    task_base_commit: &str,
    task_status: TaskStatus,
    merge_commit: Option<&str>,  // populated for merged tasks
) -> Result<TaskDiff, DiffError>;
```

The function picks the right source based on task status:

- **Worktree exists**: diff `base_commit..HEAD` from worktree.
- **Merged**: diff `base_commit..merge_commit` from main repo. For squash merges, this is one commit; for merge commits, span the merge.
- **Cancelled, branch exists**: diff `base_commit..branch_head`.
- **Cancelled, branch gone**: return `DiffSource::Unavailable`.

Implementation:

- Use `git2::Repository::diff_tree_to_tree` with appropriate trees resolved from the source/target commits.
- Set diff options: include context lines (default 3 is fine), detect renames (`find_renames(true)`), don't ignore whitespace (the user wants to see exactly what changed).
- Iterate hunks via `Diff::foreach`. Build the structured form.
- For each file, also read the full old and new content (for side-by-side rendering). For added files, old content is empty; for deleted, new content is empty.
- Detect language from file extension (`.ts`, `.tsx`, `.rs`, `.py`, etc.). Map to a string (`"typescript"`, `"rust"`, `"python"`). The frontend doesn't need to know the language; the backend uses it for syntax highlighting in milestone 5.

Tests: a temp repo, a base commit, a few changes, assert the diff structure. Test the rename case. Test added/deleted files. Don't test every git edge case — just the core paths.

### Milestone 2: Anchor mapping

A function that takes a list of auditor concerns and maps them to specific lines in the diff structure.

```rust
pub struct MappedConcern {
    pub concern: AuditorConcern,  // the original from the verdict event
    pub mapping: AnchorMapping,
}

pub enum AnchorMapping {
    OnDiffLine { file_index: usize, hunk_index: usize, line_index: usize },
    OnUnchangedLine { file_index: usize, line_in_file: usize, content: String },
    FileNotInDiff { path: String, line: usize, content: Option<String> },
    Unmapped,  // anchor missing or invalid
}

pub fn map_concerns_to_diff(
    diff: &TaskDiff,
    concerns: &[AuditorConcern],
    repo_root: &Path,
) -> Vec<MappedConcern>;
```

Logic:

- For each concern:
  - If `anchor` is None: `Unmapped`.
  - Find the file in `diff.files` matching `anchor.path` (handle renames — old_path and new_path).
  - If file is in diff and `anchor.line` falls within a hunk's new-file lines: `OnDiffLine`.
  - If file is in diff but `anchor.line` is outside any hunk: `OnUnchangedLine` (file changed elsewhere; this line is unchanged context). Read the line content from the new file.
  - If file isn't in diff at all: `FileNotInDiff`. Optionally read the file from the worktree (or repo) at the head commit to get the line content.
  - If the path doesn't exist: `Unmapped`.

The frontend uses these mappings to render anchor markers in the right place.

### Milestone 3: Syntax highlighting via syntect

Add `syntect` to `Cargo.toml`. Use the bundled syntax and theme sets (avoids loading external files).

```rust
pub fn highlight_diff_file(file: &DiffFile) -> HighlightedDiffFile;

pub struct HighlightedDiffFile {
    // Same shape as DiffFile, but with content fields containing
    // pre-highlighted HTML strings instead of raw text.
    pub path: String,
    pub status: FileStatus,
    pub hunks: Vec<HighlightedDiffHunk>,
    pub old_content_html: Option<String>,
    pub new_content_html: Option<String>,
    pub language: Option<String>,
}

pub struct HighlightedDiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<HighlightedDiffLine>,
}

pub struct HighlightedDiffLine {
    pub kind: DiffLineKind,
    pub old_lineno: Option<usize>,
    pub new_lineno: Option<usize>,
    pub html: String,  // pre-highlighted span sequence, no <pre> wrapper
}
```

Use one of `syntect`'s dark themes (e.g. `base16-ocean.dark` from the bundled set) — the app is dark-themed.

Highlight per line: each diff line becomes a span with classes/inline styles. The frontend just sets `dangerouslySetInnerHTML` on a styled container.

Use `syntect::html::ClassedHTMLGenerator` if you want CSS-class output (more flexible for theming) or inline-style output (simpler, larger payload). Inline styles are fine for this app — the diff isn't huge.

Cache the highlighted result per `(task_id, head_commit)` in app state — recomputing syntax highlighting on every diff fetch is wasteful. Invalidate when the task's HEAD changes.

### Milestone 4: Tauri commands

Three commands:

```rust
#[tauri::command]
async fn get_task_diff(task_id: String) -> Result<TaskDiffWithMappings, AppError>;

#[tauri::command]
async fn get_unchanged_file_content(task_id: String, path: String) -> Result<String, AppError>;

#[tauri::command]
async fn refresh_task_diff(task_id: String) -> Result<TaskDiffWithMappings, AppError>;
```

`TaskDiffWithMappings` combines the highlighted diff with the mapped concerns:

```rust
pub struct TaskDiffWithMappings {
    pub diff: HighlightedTaskDiff,
    pub mapped_concerns: Vec<MappedConcern>,
    pub auditor_verdict: Option<AuditorVerdictSummary>,  // verdict, confidence, summary
    pub is_live: bool,  // true if a phase is currently running
}
```

`get_task_diff` is the primary read; cached when possible.

`get_unchanged_file_content` is for "anchors on files not in the diff" — read on demand from the worktree (or repo at HEAD) when the user clicks to expand.

`refresh_task_diff` invalidates the cache and recomputes. Used by the live-update polling and by manual user refresh.

### Milestone 5: Right panel UI

Add a third column to the task detail view layout. The main content shrinks to accommodate.

**Layout:**

- Resizable divider on the left edge of the panel. Drag to resize. Min width 240px, max width 600px. Default 320px. Persist user's chosen width per workspace in `localStorage`.
- Collapse button at the top of the panel header. When collapsed, panel becomes ~32px wide with just a vertical "Diff" label and an expand button.
- Header row: "DIFF" label (10px mono), file count badge ("3 files"), refresh button (manual refresh), modal-open button ("Review →" or expand icon).
- Subhead: `vs {short_base_sha}` (11px mono, muted) and `+{adds} -{removes}` summary (mono, coloured).

**Diff rendering:**

- Vertical scroll. Each file is a section with a sticky header showing the file path (mono) and a small file status badge (added / modified / deleted / renamed).
- Inside each file: the hunks, separated by `…` ellipsis lines for hunk gaps.
- Each line: gutter showing old and new line numbers (mono, 10px, muted), then the line content (mono, 11px, syntax-highlighted via the pre-rendered HTML from milestone 3). Background tint for added lines (subtle green) and removed lines (subtle red). Context lines have no tint.
- Anchor markers in the leftmost gutter, before line numbers. A small coloured bar (3px wide × line height) — red for `blocking`, amber for `advisory`. Hover shows the rationale in a popover.

**Files-not-in-diff section:**

After all changed files, if any concerns reference files not in the diff:

- Section header: "Unchanged with concerns (N)"
- Each file as a collapsed row. Click to expand and load the file content via `get_unchanged_file_content`.

**Empty states:**

- Task is too new (no commits yet, no auditor run): "Diff will appear once the implementer has run."
- Task is cancelled with no branch: "Diff unavailable — branch was removed."
- No changes (rare but possible): "No changes."

**Loading state:**

- Skeleton shimmer for the diff content while the initial query loads. Don't block the rest of the task detail view.

### Milestone 6: Modal UI

Triggered by the "Review →" button on the panel header. Opens a large modal taking ~90% of the window.

**Layout:**

- Modal header: task title, base→head commit info, view toggle (side-by-side / unified), close button.
- Left edge: file tree (~200px). Lists changed files with status icons and concern indicators (small dot if file has concerns). Click to focus a file.
- Right area: the diff for the focused file, in side-by-side or unified mode.

**Side-by-side mode:**

- Two panes, equal width. Left = old content, right = new content.
- Aligned line-by-line: corresponding lines on each side share the same vertical position. Changed lines have coloured backgrounds (red on left, green on right). Context lines on both sides.
- Anchor markers render in the right pane (the modified file) at their respective lines, in the gutter.
- Synchronised scrolling between the two panes.

**Unified mode:**

- Same as the right panel's rendering, but full-width and with larger text (12-13px instead of 11px).

**Keyboard navigation:**

- `j` / `k` or `↓` / `↑`: scroll through concerns. Pressing `j` jumps to the next concern (in any file); scrolls into view and pulses the anchor briefly.
- `e`: expands the rationale popover for the focused concern.
- `Tab` / `Shift+Tab`: cycle through files in the file tree.
- `Esc`: close the modal.
- `cmd+shift+d`: toggle modal (open if closed, close if open). Optional but nice.

**Concerns panel inside the modal:**

A collapsible right rail (~280px, toggleable) showing the verdict and concerns list. Click a concern to scroll to its anchor. The list mirrors what's on the task detail view but reachable from inside the modal so users can review diff and concerns without dismissing.

Open by default. User can collapse for max diff space.

### Milestone 7: Live updates

While a phase is running for the task, the diff updates automatically.

**Mechanism:**

- The frontend listens for `projection_updated` events for the task aggregate (existing pattern).
- On each event during a running phase, debounce ~500ms and call `refresh_task_diff`.
- Additionally, while a phase is running, poll every 3 seconds as a safety net (in case events aren't firing for some reason).
- When no phase is running, no polling. Stable.

**Visual:**

- Subtle pulse or "live" indicator on the panel header while updates are flowing.
- The diff doesn't yank the user's scroll position when updates land — preserve scroll. Use a `requestAnimationFrame` to maintain position relative to the top of the visible content.

### Milestone 8: Modal toggle and polish

- The unified vs side-by-side toggle persists per workspace in `localStorage`. User picks once, sticks.
- The concerns rail toggle in the modal also persists.
- Concerns with anchors that are `Unmapped` show in a "General concerns" section at the bottom of the concerns rail (not anchored to anything, so can't render in the gutter — but still visible).
- Files in the file tree that have concerns show a small dot (severity-coloured) next to the file name.
- Clicking a concern's anchor in the verdict card on the task detail view *also* opens the modal at that concern. Same affordance from two surfaces.

## Conventions

- All diff computation in Rust. The frontend renders `dangerouslySetInnerHTML` for the syntax-highlighted lines but does no parsing or transformation of code.
- TanStack Query for `get_task_diff`. `staleTime: Infinity` because we control invalidation via `projection_updated` and live-update polling.
- shadcn primitives for the modal (Dialog), file tree (custom but using shadcn ScrollArea), buttons. The diff content itself is custom HTML/CSS — no library.
- Resize the right panel via a draggable divider component (custom; ~30 lines of React).
- All inter-component navigation (panel → modal, concern → anchor) goes through props/callbacks, not URL state. The modal is not a route.
- Typed errors with `thiserror`. `DiffError::WorktreeMissing`, `DiffError::CommitNotFound`, `DiffError::GitError`, etc.

## Out of scope

- Per-phase diffs (showing what each phase contributed individually)
- Diff search / filter
- Inline commenting on diff lines (separate feature, much bigger)
- Side-by-side mode in the right panel (constrained width makes it impractical; unified only)
- Copy-with-context buttons
- Permalinks to specific lines within a diff
- Whitespace toggle (always show whitespace changes for v1)
- Image diffs / binary files (skip them in the diff with a "binary file" placeholder)
- Diff against a reference other than `task_base_commit` (e.g. against main, against another phase) — task-base-to-head only
- Streaming the diff line-by-line as it computes (compute fully, then render)
- Animations on diff updates (just refresh the content; pulsing the live indicator is the only animation)

## Deliverable

A working app where:

1. Opening a task detail view shows a resizable right panel with the task's diff, syntax-highlighted, with auditor anchor markers.
2. Hovering an anchor shows the concern's rationale.
3. Clicking "Review" opens a modal with side-by-side diff, file tree, concerns rail.
4. Toggling between side-by-side and unified in the modal works and persists.
5. Keyboard navigation in the modal works as specified.
6. The diff updates live during running phases and freezes when idle.
7. Files referenced by concerns but not in the diff appear in a "Unchanged with concerns" section.
8. Merged tasks show the diff reconstructed from history; cancelled tasks with no branch show empty state.
9. Syntax highlighting is correct for at least TypeScript, Rust, Python, and JSON.

Plus tests on:
- The diff data layer (a few synthetic repos with known changes)
- Anchor mapping (test the four mapping cases — on-diff, on-context, file-not-in-diff, unmapped)
- The merged-task reconstruction path

Commit after each milestone. Milestones 1-4 are backend/data-layer (one logical chunk); 5-7 are UI (another); 8 is polish. Three or four commits total is a reasonable shape.
