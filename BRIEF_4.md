# Brief for Claude Code: Density Pass and Status Bar

## Context

The app's structure and functionality are solid. This brief is purely about visual register — making orca feel denser, more developer-toolish, more like a tool you live in all day rather than one you visit. No behavioural changes; no new features.

There are two passes:

1. **Density pass.** Tighten spacing, reduce padding, shrink chrome text, compress phase cards. Same information, less visual real estate.
2. **Status bar.** Extend the bottom strip from "event log only" to a denser horizontal bar with breadcrumb, latest event, provider chips, in-flight count, and git branch.

Read no other docs for this brief — it's UI-only. No event schema changes.

**Reference mockup**: a proportional SVG mockup at the conversation level shows the target visual register. Match the proportions there approximately; don't pixel-match.

## Design principles

- **Compression, not addition.** Most changes are reducing padding, shrinking text, removing visual weight. If a change adds new visual elements, double-check it's necessary.
- **Information density without crowding.** Smaller spacing is fine; cramped is not. Use breathing room within compressed sections.
- **Mono font for metadata, sans for content.** Already the convention; reinforce it. Small metadata lines (timestamps, IDs, technical labels) are mono. Task titles, descriptions, body content are sans.
- **Two text sizes for chrome, one for content.** Chrome (sidebar, status bar, metadata) uses 10-11px. Content (titles, body) uses 13-16px. Avoid in-between sizes.
- **Muted is the default.** Most text is muted-foreground. Primary-foreground is reserved for content the user is reading right now.

## Milestones

### Milestone 1: Sidebar density

Current sidebar items have generous vertical padding and large text. Tighten:

- Workspace accordion header: 22px tall row (down from current ~40px). 12px text. The active-workspace left-border accent stays — that's working. The "▾"/"▸" disclosure caret is 10px, muted.
- Nav items inside an expanded workspace: 18-20px tall row. 11px text. Indented 12-14px from the workspace header.
- Section headers (`WORKSPACES`, etc.) are 10px, muted, letter-spacing 0.5, uppercase. Already muted; just shrink the text.
- The "+" button at the top of the WORKSPACES section is 14×14px, sits inline with the section header rather than as a separate row.
- Bottom-of-sidebar items (`Settings`, `About`) follow the same density as nav items — 18-20px rows, 11px text.
- Active nav item: subtle background tint (`var(--color-background-secondary)` or similar — ~3% lighter than sidebar background), no extra padding. The active state shouldn't make the row taller than inactive rows.

Sidebar overall width stays ~220px. Don't widen it to "fit" the new tighter elements; the breathing room is part of the change.

### Milestone 2: Phase card density

Phase cards in the task detail view currently take significant vertical space. Compress:

- Card padding: 12px (down from ~16-20px).
- Header row: phase name (13px sans, primary), status badge right-aligned (9-10px mono uppercase, muted), inline.
- Three dense metadata lines, each 11px mono, muted:
  - `claude · sonnet-4.5` (provider · model)
  - `mode: acceptEdits` (permission mode, with small lock icon if mode is `plan`)
  - `5m 12s · 12k tok` (duration · token usage if available)
- Between each line: 4px gap. Card overall height ends up around 80-90px.
- Inactive (queued) phase cards: same shape, but text muted further (tertiary), no status badge. Still shows model and mode — the user wants to see what *will* run.
- Arrow between cards: 14px text arrow, muted, vertically centred between cards.

Phase card grid: still horizontal flex with arrows. If 3+ phases get crowded, allow horizontal scroll on the phase row rather than wrapping. Wrapping breaks the read of "left to right is the pipeline order."

### Milestone 3: Auditor verdict density

The auditor verdict card is currently a generously-padded block. Tighten:

- Card padding: 14px.
- Verdict badge row: badge (`APPROVE`/`REVISE`/`REJECT`, 11px mono, padding 4px 8px), confidence text (11px, muted) inline next to it. 8px gap between.
- Summary: 12-13px primary text, 1.5 line-height. No oversized treatment — it's the content of the card, not a hero.
- Concerns: each concern is a tighter row — severity badge (10px mono), category, then the rationale text (12px). 6-8px gap between concerns.
- Anchor links (file:line) are inline mono, accent colour, clickable.

The verdict card should feel scannable in one glance. Currently it reads like a feature; after this it should read like reference info that's important but not loud.

### Milestone 4: Section labels and breadcrumb

Throughout the main content area:

- Section labels (`SPEC`, `AUDITOR VERDICT`, `PIPELINE`, `AUDIT TRAIL`) are 10px mono, uppercase, letter-spacing 0.5, muted-tertiary.
- Spacing between sections: 24-28px (down from typical 40px+).
- Breadcrumb at the top of the task view: 11px mono, muted. Each segment clickable. Use `›` (single right-pointing) as the separator, not `/`. Sits on its own row above the title with 8-10px gap.
- Task title: 20px, weight 500, primary. Status badge (`MERGED` etc.) inline next to the title at 10px mono.
- Subtitle line below title (e.g. "Merged into X as Y · 14m ago"): 11px mono, muted.

### Milestone 5: Status bar

Replace the current bottom event log with a single-line status bar. The full event history moves *into the main content area* as a new "AUDIT TRAIL" section on relevant views (task detail). The bottom bar is for ambient state, not for browsing.

**Status bar structure**, left to right, single line, ~20-22px tall:

- **Left section** (latest event): a small status dot (3px, colour by event type — green for success-ish, amber for running, red for failure, grey for neutral) followed by a one-line summary of the most recent event in 10px mono. Format: `HH:MM:SS  EventType  short_id…  summary`. Max width ~480px, ellipsis if longer.
- **Middle section** (provider chips): for each configured provider, a 3px dot (green = healthy, amber = degraded, red = offline) and the provider name in 10px mono. Compact spacing, ~12-14px between providers.
- **Right section** (workspace state): current branch of the main worktree (`⎇ main`, 10px mono), in-flight phase count (`2 in flight`, 10px mono), `events` link (10px mono, muted, opens an event drawer — placeholder for now if drawer doesn't exist), `⌘K` hint (10px mono, muted, opens command palette — placeholder).

**Behaviour:**

- The latest-event section updates live as new events arrive. Use the existing `projection_updated` invalidation pattern, with a query that returns just the most recent event for the active workspace.
- Provider chips are global (across all workspaces, not just active) — they reflect actual provider availability.
- The branch and in-flight count are scoped to the active workspace (the URL determines this).

**The full event browser:**

The current bottom panel (which shows the scrollable event log) becomes the "AUDIT TRAIL" section *within the task detail view*, scoped to that task's events. It's no longer a global panel. If the user wants to see all events for the workspace, they go to a new "Activity" view (deferred — out of scope for this brief; just make sure the move from global panel to per-task section doesn't break anything).

If your existing implementation has the event log as a global app-shell-level component, this is the change: it becomes a section of the task detail page, scoped to that task's events, queried via `list_events_for_aggregate(task_id)` or equivalent.

### Milestone 6: Misc tightening

Small things that round out the density pass:

- Page-level padding: the main content area's outer padding is currently generous. Reduce to ~16-20px.
- Buttons in headers ("Restart", "Run task" etc.): smaller — 22-24px tall, 11px text, padding 4px 10px. Mono font for the button label is fine for command-style actions.
- Tooltips, when used, are 11px sans, muted.
- Modal/dialog padding: 20px (down from typical 32px). Dense but not cramped.

## What not to change

- **Colour palette.** The dark theme with green accents and the muted-everything register is working. Don't shift to a different aesthetic.
- **Typography choices.** Mono for chrome and metadata, sans for content. Don't introduce a third font.
- **Layout structure.** Sidebar on the left, main content on the right. Same as today. (The right-side diff panel is a separate brief.)
- **Functionality.** No behavioural changes. Every action that worked before works the same way after.
- **Accessibility.** Smaller text is fine for chrome but ensure colour contrast still passes for muted text on dark backgrounds. Test the muted-on-dark combinations against WCAG AA at minimum.

## Out of scope

- Tabs (separate brief, only if dogfooding shows we want them)
- Right-side diff panel (separate brief, real behaviour change)
- Command palette (referenced in status bar as `⌘K` placeholder; implementation is later)
- Activity view (referenced as the eventual home for cross-task event browsing)
- New theme variants
- Animation/transitions
- Restructuring routes

## Deliverable

A working app where:

1. The sidebar feels noticeably denser — workspace accordion items are ~22px tall, nav items ~20px, with appropriate text sizes.
2. Phase cards are ~80-90px tall, showing model, permission mode, and timing in three dense mono lines.
3. The auditor verdict card is compact and scannable in one glance.
4. Section labels, breadcrumb, and titles use the typographic hierarchy described.
5. The bottom of the app is a single-line status bar with latest event (left), provider chips (middle), branch + in-flight count + ⌘K hint (right).
6. The full event log is no longer a global bottom panel; per-task events appear in the task detail view's "AUDIT TRAIL" section.
7. Padding and spacing throughout are tightened without making anything feel cramped.

No tests required for this brief — visual changes only. Visually verify against the mockup proportions.

Commit after each milestone (sidebar, phase cards, verdict, section labels, status bar, misc). Six small commits is the right granularity here.
