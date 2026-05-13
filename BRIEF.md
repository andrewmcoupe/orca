# Brief: Acceptance-criterion-driven proposal review

## Context

The current proposal view sits inline on the task page, alongside the auditor verdict, spec, audit trail, and pipeline rail. Code review is the highest-cognitive-load activity in the app and it's being asked to coexist with everything else in a column that's too narrow for it. This brief replaces the inline proposal view with a dedicated full-window review surface, organised around acceptance criteria rather than files, with a novel rendering treatment that uses opacity to distinguish changes from context.

This isn't a polish pass on the existing diff view. It's a rethink of what proposal review *is* in an app where the body of work has structured acceptance criteria and an auditor that maps changes to those criteria.

## Premise

Reviewing an agent-produced proposal is fundamentally a verification activity, not a forensic one. The reviewer is not trying to detect a sneaky change — they're trying to answer "did this work do what we asked for, and is it good?" Files are an implementation accident; acceptance criteria are the actual unit of verification.

The review UI should be organised around what the reviewer is verifying, not around the file system the changes happen to live in.

## Two interlocking ideas

This brief covers two changes that depend on each other:

1. **AC-driven organisation**: changes are grouped by which acceptance criterion they implement, not by file.
2. **Opacity rendering**: files are shown in full with unchanged code faded and changed code at full opacity, so reviewers read code-with-changes-highlighted rather than diffs-with-context-expanded.

Each of these would be valuable on its own. Together they reframe review from "read this diff" to "verify this criterion is satisfied by these lines."

## Precondition: auditor structured output

The auditor agent currently emits prose advisories. For this UI to work, the auditor must additionally emit a structured mapping of hunks to acceptance criteria. This is a precondition — the UI cannot be built without it, and the auditor pipeline must be extended first.

Required structured output, per proposal:

```
{
  "criterion_mappings": [
    {
      "criterion_id": "ac_1",
      "hunks": [
        { "file": "src/components/CountryCard.tsx", "hunk_index": 2 },
        { "file": "src/hooks/useFavourites.ts", "hunk_index": 0 }
      ],
      "satisfied": true,
      "notes": "Heart button correctly toggles state via useFavourites hook."
    },
    ...
  ],
  "unmapped_hunks": [
    { "file": "package.json", "hunk_index": 0, "category": "dependency" },
    ...
  ]
}
```

Notes:

- **Granularity**: hunk-level is the target. File-level is acceptable as a fallback when the auditor cannot reliably attribute at hunk granularity. The UI degrades gracefully (see "Degraded modes" below).
- **M:N relationships**: a single hunk may map to multiple criteria. The schema supports this by allowing the same hunk to appear under multiple `criterion_mappings`.
- **`satisfied` is the auditor's per-criterion verdict**: did the mapped hunks satisfactorily implement this criterion? This is distinct from the overall verdict.
- **`unmapped_hunks`**: hunks the auditor could not attribute to any criterion. Categorised loosely (`dependency`, `config`, `refactor`, `unknown`). Non-empty `unmapped_hunks` is itself a signal worth surfacing.

The implementer should build the structured-output extension to the auditor pipeline as the first step of this work, then build the UI against it.

## Activation

`Review changes` on the task page becomes a full-window takeover, not an inline expansion. Clicking it replaces the task page with the review surface. An exit affordance (button + `Esc` key) returns to the task page.

The full-window choice is deliberate: review is a *mode*, not a *section*. It deserves the whole window, and trying to fit it into the task page's column was the root cause of the current friction.

## Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│ [exit]  Verify no filename collision at repository root      [Land] […]│  ← top bar (~48px)
├──────────────────┬─────────────────────────────────────────────────────┤
│ CRITERIA         │  src/components/CountryCard.tsx       [claude] +12 -3│
│ ✓ 1 Heart button │  ────────────────────────────────────────────────── │
│   toggles state  │   45 │ import { useState } from 'react'              │
│ ✓ 2 Persists     │   46 │ import { useFavourites } from '../hooks/...   │  ← faded
│ ⚠ 3 Empty state  │   47 │                                                │
│ ✓ 4 Route lists  │   48 │ export function CountryCard({ country }) {     │
│ ◯ 5 Removable    │   49 │   const { isFavourite, toggle } = useFavou... │  ← full opacity (changed)
│                  │   50 │   return (                                     │
│ OTHER            │   ...│                                                │
│ ⚠ 3 hunks        │                                                       │
│                  │  src/hooks/useFavourites.ts          [claude] +28 -0 │
│ ──────────────── │  ────────────────────────────────────────────────── │
│ Spec        ▸    │   ... continues ...                                  │
│ Verdict     ▸    │                                                       │
└──────────────────┴─────────────────────────────────────────────────────┘
```

### Top bar

Persistent across the review surface. Contains:

- Exit button (left)
- Task title
- Reviewed-progress indicator: `Reviewed 2 of 5 criteria`
- Primary action (right): `Land` (if approved and Ready to land) or `Pass back with notes` or `Catch up` depending on state
- Overflow menu for secondary actions

### Left rail (~280px)

**Criteria list** (top section):

Each criterion is a row showing:

- An auditor verdict glyph: `✓` (satisfied), `⚠` (satisfied with notes), `⨯` (not satisfied), `◯` (no implementing hunks)
- The criterion title (truncated if needed; full title on hover)
- A small "reviewed" indicator that fills in when the user has viewed all the hunks within that criterion

Selected criterion is visually distinguished (background tint or left border). Clicking a criterion loads its mapped hunks in the main pane.

**Other changes** (middle section):

A bucket for unmapped hunks. Shows a count badge if non-empty (`Other ⚠ 3 hunks`). Clicking it shows unmapped hunks grouped by their auditor category (dependency, config, refactor, unknown). Empty section is hidden entirely.

**Reference panels** (bottom section):

Collapsed by default, expandable:

- `Spec` — the original task spec
- `Verdict` — the auditor's prose verdict and advisories

These are accessible during review without leaving the surface but don't eat space when not in use.

**View mode toggle** (very top of the left rail):

- `By criterion` (default)
- `By file`

`By file` switches the main pane to a traditional file-organised view, still using the opacity rendering. This is the escape valve for reviewers who want to read the code without the AC framing — to look for subtle bugs, scope creep, or stylistic issues the criteria don't capture. First-class affordance, not buried.

### Main pane

Files relevant to the selected criterion, stacked vertically. Each file has:

**File header**:

- Path (full, monospace, copyable)
- Status pill (added / modified / deleted / renamed)
- +/- line counts
- Author badges for the hunks within this file *that relate to the selected criterion*
- A "jump between changes" control: `↑ ↓` with a counter `3 of 12`

**File body**:

The full file content rendered with opacity treatment:

- **Unchanged lines**: ~35% opacity. Readable on hover or focus, but visually recedes.
- **Added lines**: full opacity. Subtle left-gutter colour (green tint) but not the dominant signal — opacity does the lifting.
- **Modified lines**: full opacity. Small `M` marker in the gutter; hovering reveals the previous version inline below the current line.
- **Removed lines**: shown inline as ghost lines (struck through, ~25% opacity) at their original position when the deletion is ≤5 lines. For larger deletions, a single collapsed indicator at the deletion site shows `−N lines removed` and expands inline on click.

**Default collapsing for long files**:

If a file is >100 lines and changes are sparse, unchanged regions between changes collapse to a `+125 lines` interstitial that expands on click. The reviewer sees changed regions with ~5 lines of context above and below by default. Each file has a `Show full file` toggle in its header to override this and render everything at once (still with opacity treatment).

**Hunks mapped to multiple criteria**:

When the current criterion includes a hunk that also belongs to other criteria, the hunk shows a small badge in its margin: `Also: Empty state when no favourites`. Clicking the badge jumps to that criterion's view, with the same hunk highlighted.

## Behaviour

### Reviewed tracking

A criterion is marked "reviewed" automatically when the user has scrolled through (or rapidly visited) all hunks within it. Stored per-user, per-proposal-revision. Resets when the proposal is updated (new revisions, catch-up, resolution).

Reviewers can also explicitly toggle reviewed state via keyboard (`r`) or a small affordance on the criterion row. This handles the case where the reviewer has read the changes but doesn't want them auto-marked as scrolling triggers.

### Audit trail integration

When the user lands the proposal, the audit event records review completion: which criteria were marked reviewed, which were not, total time in review surface, mode used (`by criterion` vs `by file`). This is internal data for now, not surfaced — but it builds the foundation for future signals like "this proposal was landed without reviewing 2 criteria" or "average review time for X-type tasks."

### Keyboard navigation

This is a reading-dense surface and must feel keyboard-native:

- `1`–`9`: jump to criterion N in the left rail
- `0`: jump to Other changes
- `j` / `k`: next / previous change within current criterion
- `f`: focus next file within current criterion
- `Shift-f`: focus previous file
- `r`: toggle reviewed on current criterion
- `v`: toggle view mode (by criterion / by file)
- `s`: expand/collapse Spec panel
- `Esc`: exit review surface, return to task page
- `Enter` when `Land` is the primary action: trigger the land confirmation dialog

Shortcuts are documented in a `?` overlay accessible from the top bar.

## Degraded modes

The UI must work when auditor structured output is incomplete or absent:

**File-level mapping only** (auditor attributed criteria to files, not hunks):

- Criterion view shows the full files mapped to it, with all changes highlighted regardless of which criterion they nominally serve.
- A small notice in the left rail: "Showing file-level mapping. Hunk-level mapping unavailable for this proposal."

**No mapping at all** (auditor failed to produce structured output):

- The left rail collapses; the surface falls back to `By file` mode only.
- A notice: "Acceptance-criterion view unavailable. The auditor did not produce a mapping for this proposal."
- The opacity rendering still applies. The full-window takeover still applies. Only the AC-driven organisation is lost.

These degraded modes are important: structured output from the auditor is a precondition for the *best* experience, not for *any* experience. Tasks reviewed before the auditor was upgraded, or tasks where the auditor errors out, should still be reviewable.

## Multi-proposal handling

When a task has multiple proposals (e.g., an implementation proposal and a resolution proposal), the review surface shows the **active proposal** (the one that would land). A small affordance in the top bar lists previous proposals and lets the reviewer switch — useful for comparing what the agent did originally vs. after a pass-back or catch-up.

Reviewed state is per-proposal-revision. Switching to a previous proposal shows its own reviewed state at the time it was the active one.

## Data model additions

- `auditor_verdicts.criterion_mappings` — JSON column holding the structured mapping described in the precondition section
- `auditor_verdicts.unmapped_hunks` — JSON column for the unmapped hunks bucket
- `proposal_reviews` — new table: `(user_id, proposal_revision_id, criterion_id, reviewed_at, mode)` to track per-criterion reviewed state
- `proposal_reviews.total_time_seconds` — aggregate review time per proposal-revision, for the audit trail

## Non-goals for this iteration

- **Per-criterion comment threads.** The natural next step (and a really compelling one) but out of scope for this brief. Mentioned in "Future directions" below.
- **Inline editing of files during review.** Read-only surface.
- **Cross-proposal diffing** (compare proposal A to proposal B side-by-side). Multi-proposal switching is supported; cross-proposal diff is a separate feature.
- **Customising the opacity threshold.** Default values for unchanged-line opacity, deletion-collapse threshold, context-line count, etc. are fixed for v1. Make them tweakable in settings later if there's demand.
- **AC-driven view for non-agent-produced changes.** Direct revisions to the parent branch (made via terminal) are not covered by this UI. They appear in the workspace history view only.

## Open questions for the implementer

1. **Auditor pipeline timing.** The structured mapping should be produced during the standard auditor pass, not as a separate stage. Confirm this fits the current pipeline architecture and doesn't significantly extend auditor latency.
2. **Rendering performance for large files.** The opacity treatment requires rendering full file content (not just changed hunks). For very large files (>2000 lines), this may be slow. Recommendation: virtual scrolling within each file pane, lazy-loading content beyond the viewport. Confirm approach.
3. **Auto-marking-as-reviewed thresholds.** What counts as "the user viewed this hunk"? Time-based (visible for >2s)? Scroll-based (entered viewport)? Click-based (focused)? Recommendation: scroll-based with a brief debounce (1s in viewport marks it reviewed). Worth pilot-testing.
4. **Auditor failure modes.** What does the auditor output look like when it cannot confidently map a hunk? Recommendation: a `confidence` score per mapping; mappings below threshold get demoted to "unmapped" rather than being shown with false certainty.
5. **Opacity values.** Specific values (35% for unchanged, 25% for removed-ghost) are starting points, not gospel. Worth design review with real proposals at various sizes before locking in.

## Acceptance criteria

- Auditor pipeline produces `criterion_mappings` and `unmapped_hunks` as structured output alongside the prose verdict, persisted with the verdict record.
- Clicking `Review changes` on a task opens a full-window review surface, replacing the task page.
- The review surface defaults to `By criterion` mode, with the criteria list in the left rail and the first criterion's mapped files in the main pane.
- Files render in full with unchanged lines faded (~35% opacity) and changed lines at full opacity. Deletions render as ghost lines (≤5) or collapsed indicators (>5).
- Long files default to collapsed-context view with `Show full file` toggle.
- Switching criteria in the left rail updates the main pane to show that criterion's mapped files and hunks.
- Hunks mapped to multiple criteria show cross-reference badges.
- Unmapped hunks appear in the "Other" section with category labels.
- View mode toggle switches between `By criterion` and `By file`, preserving the opacity rendering in both.
- Keyboard shortcuts work as specified; `?` overlay documents them.
- Reviewed state is tracked per criterion and surfaced in the top bar progress indicator.
- Degraded modes work: file-level mapping renders sensibly; no mapping falls back to `By file` only with a clear notice.
- Multi-proposal tasks expose proposal switching in the top bar; reviewed state is per-proposal-revision.
- Exiting (`Esc` or exit button) returns to the task page with no loss of context.
- All copy follows the domain vocabulary defined in the Git-as-implementation-detail doc. No `diff`, `merge`, `branch`, `conflict`, etc. appear in the UI.

## Future directions

Once this lands, the AC structure becomes the spine of richer review features:

- **Per-criterion comment threads.** Reviewer feedback gets structured the same way the work was structured. When passing back with notes, the notes attach to specific criteria, which makes the implementer's re-attempt much sharper.
- **Conversational review.** "Ask the implementer about this hunk" — a short scoped dialogue with the agent that produced the change, with the resulting context fed into a re-attempt if the reviewer chooses to pass back.
- **Cross-proposal diffing.** Compare two proposals for the same task side-by-side. Useful when the reviewer wants to understand "what did claude do differently this time" after a pass-back.
- **AC coverage analytics.** Over time, which criteria most often need pass-backs? Which auditor mappings most often disagree with human review? These signals tune both the briefing phase and the auditor.

None of these are in scope for this brief, but the data model and UI shape laid down here are the foundation they'll build on.
