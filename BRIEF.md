# Brief: Task-centric review UI with domain language

## Context

The app currently exposes Git through traditional primitives (commits, branches, diffs against HEAD, merge buttons). This made sense when humans were the agents doing the work. In our model, humans are reviewers and approvers — agents produce the work, and the human's intents are narrower and clearer than Git's vocabulary suggests. This brief covers two interlocking changes:

1. **A task-centric review UI** that hides Git's primitives and reflects our domain model (tasks, plans, auditor verdicts, pipeline).
2. **A new domain vocabulary** that replaces Git terms in user-facing surfaces, so the language matches what the user is actually doing.

These two changes reinforce each other. New UI surfaces should ship with the new vocabulary from day one. Existing surfaces that aren't being rebuilt in v1 should still be retranslated as a copy pass.

---

## Part 1: Why a new vocabulary

### The problem with Git's terms

Git's vocabulary describes mechanisms, not intents. `Merge` describes how two histories combine, not the user's goal ("accept this work"). `Rebase` hides whether anything is destructive. `Pull` and `Fetch` overlap confusingly. `HEAD`, `index`, `stash`, `reflog` have no human-meaningful counterpart in our workflow. None of this language was designed for someone whose job is to review and approve work that an agent produced.

We can do better because our user's intents are narrower than Git's. There are six things a human does in our app:

1. Ask an agent to attempt some work
2. Look at what the agent produced
3. Accept the work into the parent line of development
4. Reject it or ask for changes
5. Bring in changes from the parent that happened in parallel
6. Recover from a stuck state

That's the whole verb surface. Every Git primitive in our app serves one of these. Naming them after the intent — rather than the mechanism — makes the app self-explanatory and lowers the cognitive load on people who don't think in Git.

### The principles behind the new terms

- **Name the intent, not the mechanism.** Users say "I want to land this," not "I want to fast-forward merge this."
- **Verb and state agree.** If the action is `Land`, the in-flight state is `Landing` and the result is `Landed`. No Git-style inconsistency.
- **One word per concept.** No synonyms drifting in from Git ("merge", "integrate", "combine" all surfacing for the same action).
- **Errors speak the new language.** The hardest place to keep vocabulary clean is error messages, which tend to leak underlying tooling terms. We hold the line there especially.
- **The terminal is the language boundary.** Inside the terminal, Git's terms live. In our GUI, our terms live. We do not wrap `git` with custom shell aliases; we let the two languages coexist with a clear boundary.

### The vocabulary

| New term | Replaces | Meaning |
|---|---|---|
| **Proposal** | (implicit "the task's changes") | The implementer agent's output: the body of work being reviewed |
| **Land** | Merge | Accept a proposal into its parent (squash under the hood) |
| **Catch up** | Rebase / merge-from-parent | Bring a task in line with parent changes that happened in parallel |
| **Collision** | Conflict | Two changes overlap and need resolution |
| **Changes** | Diff | The set of modifications a proposal contains |
| **Revision** | Commit | A single snapshot within a task (rarely surfaced, escape hatch only) |
| **Sync** | Pull / Fetch / Push | Bidirectional remote operations, if/when remotes are exposed |

State words follow the verbs:

| State | Used when |
|---|---|
| `Drafting` | The implementer is producing the proposal |
| `Under review` | Auditor or human is evaluating the proposal |
| `Approved` | Auditor has approved (already in use) |
| `Ready to land` | Approved and all pre-land checks pass |
| `Landing` | Land action is in flight |
| `Landed` | Successfully landed into parent |
| `Needs catch-up` | Parent has moved; task needs to catch up before it can land |
| `Catching up` | Catch-up is in flight |
| `Has collisions` | Catch-up has produced collisions that need resolution |
| `Rejected` | User chose not to land the proposal |

Terms that **do not exist** in the UI under any circumstance: branch, HEAD, ref, index, stash, reflog, worktree, fast-forward, cherry-pick, checkout, pull, fetch, push, origin. If any of these appear in user-facing strings, that's a bug.

### Translation guidance for copy passes

When retranslating existing UI strings:

- "Review diff" → "Review changes"
- "Merge" (button) → "Land"
- "Merge" (verb in audit log) → "Land"
- "Merged" (state) → "Landed"
- "Conflicts with parent" → "Has collisions with parent"
- "Branch" (anywhere it appears) → remove entirely, or replace with "task" if it referred to the task's branch
- "Commit" (in error messages) → "revision"
- "Worktree" (anywhere it appears) → remove or replace with "task files"

When writing new copy, the rule is: if a word from the "do not exist" list would be the natural choice, you're describing a mechanism. Find the intent instead.

---

## Part 2: v1 UI scope

### Principle

Tasks are the unit. Plans are the structure. Revisions are an implementation detail the user should rarely see.

### 1. Proposal view (replaces "Review diff" modal)

Open from the existing action — now labelled `Review changes`. Replace the current modal with an inline view in the task detail area (same surface as Auditor verdict, Spec, Audit trail — a collapsible section).

**Default: changes against merge base, grouped by file, hunk-oriented.**

- Show the proposal's full set of changes against the merge base with the parent. Not revision-by-revision. One coherent view.
- Group hunks by file. Collapsible per file. File header shows path, +/- line counts, and a status pill (added / modified / deleted / renamed).
- Each hunk gets an **author badge** indicating who/what wrote it:
  - `claude` — implementer agent
  - `codex` — auditor agent (for auditor-requested fixes)
  - `you` — human via terminal or external editor
  - Resolve by walking revision authorship within the task's range. Map known agent identities via config. Unknown authors fall back to `human`.
- Standard syntax highlighting, unified default with a side-by-side toggle.

**"Since last review" mode:**

- Track per-user, per-task `last_reviewed_at`. Update when the user opens the proposal view.
- Toggle at the top: `All changes` / `Since last review`. The latter filters to hunks changed after `last_reviewed_at`.
- Persist in local DB keyed by (user, task_id).

**Show revisions (escape hatch):**

- Muted `Show revisions` toggle. When on, renders a thin list above the changes (short SHA, author, subject, timestamp). Clicking scopes the view to that revision's changes. Default off.

### 2. Plan detail page (keep current layout, sharpen the row signal)

The existing vertical list of tasks on the plan detail page is the right shape for this view. Plans are operational surfaces — scanning, clicking through, creating new tasks — not visualisations to be understood. A DAG would force diagonal eye movement and hide task titles inside nodes. The list scales better, dependencies are already expressed inline as "Blocked by …" labels, and most plans aren't shaped graphy enough to justify a graph view. Keep the list.

The current list does need three improvements, however:

**1. State pills on every row.** Each task row currently shows only `created · 10 hours ago`, which makes it impossible to scan plan progress at a glance. Add a state pill on each row using the vocabulary defined above (`Drafting`, `Under review`, `Approved`, `Ready to land`, `Landing`, `Landed`, `Needs catch-up`, `Catching up`, `Has collisions`, `Rejected`). Colour-code matching the pipeline status colours already in use. Position: right-aligned on the row, before the timestamp.

**2. Consistent blocked-by formatting.** Currently rows mix "Blocked by 3 tasks" (count) and "Blocked by Add favourites storage module a…" (truncated name). Standardise:

- 1 blocker: show the blocker's name (truncated if needed), clickable to jump to it
- 2+ blockers: show "Blocked by N tasks", clickable to expand a small inline list of the blockers
- 0 blockers: show nothing (no "Unblocked" label — absence is the signal)

**3. "Ready" affordance.** When a task is unblocked and not yet in progress, it should be visually distinguished from blocked tasks (slightly brighter row, or a small "ready" indicator). This lets the user identify what could be worked on next without reading every row.

No DAG. No graph view. The list is the view.

### 3. Land flow

The `Land` button is the only landing verb. No mode picker.

- **Default strategy: squash.** One task becomes one revision on the parent.
- Commit message format:
  - Subject: task title
  - Body: auto-generated, includes auditor verdict summary, link to task, and `Co-authored-by:` trailers for every distinct author within the task range (so claude/codex/human attribution is preserved in the underlying log).
- Strategy is configurable per-workspace in Settings (`squash` default, plus `merge-commit` and `fast-forward` as alternatives for power users). Not exposed per-land.

**Pre-land checks (Land button enabled only if all true):**

1. Auditor verdict is `approved`
2. All pipeline gates passed
3. No collisions with current parent (dry-run; cached, invalidated when parent moves)
4. Task is not already landed

If any check fails, the button is disabled with a tooltip explaining which. If (3) fails, surface `Has collisions with parent` as a first-class state on the task header (red badge). v1 stops at surfacing — collision resolution UI is deferred.

**On click:**

- Confirm dialog: target, strategy, message preview, file count, +/- lines.
- On confirm: perform the underlying merge in the parent repo, show progress, mark the task `Landed`, close any open terminals for the task files (with confirmation if processes are running), remove the task files from disk.
- Emit a `TaskLanded` audit event with the resulting revision SHA.

### 4. Workspace history view

Accessible from the workspace root (clicking `country-playground-app` shows a workspace overview, not just expanding the tree).

- Render the parent's history as a **landed-task log**, not a revision log.
- Each row = one squashed landing = one task. Show: task title, author(s), landed-at timestamp, link to the task detail (which remains accessible read-only post-landing).
- Non-task revisions (direct pushes, manual commits) render as muted "direct revision" rows — present but de-emphasised.
- Filter/search by task title, author, date range.

### 5. Action bar consistency (cleanup)

The plan detail page currently uses labelled action buttons (`Edit`, `Pause`, `Cancel`, `Archive`), while the task detail page is moving to icon-only buttons with tooltips. This asymmetry is fine if intentional, but should be deliberate. Recommended approach:

- **Plan-level actions stay labelled.** Plans are accessed less frequently than tasks, and the actions are more consequential (`Cancel`, `Archive`). Labels reduce mis-click risk.
- **Task-level actions stay icon-only**, except for the primary action (`Land`), which retains its label. This preserves visual hierarchy — `Land` is the most consequential verb in the app and should be the most legible.

Document this pattern in the design system so future surfaces follow it: high-frequency surfaces favour icons; consequential or rarely-visited surfaces favour labels; primary actions always keep labels regardless of surface frequency.

---

## Data model additions

- `tasks.last_reviewed_at` — map of user_id → timestamp (or separate `task_reviews` table)
- `tasks.merge_base_sha` — cached merge base; invalidated when parent moves
- `tasks.collision_state` — `clean | colliding | unknown`, recomputed on parent change
- `workspace_settings.land_strategy` — enum, default `squash`
- Agent identity registry (config): map of author email/name → agent label

---

## Non-goals for v1

Intentionally deferred:

- **Collision resolution UI** (three-way changes view, agent-assisted resolution). v1 surfaces the colliding state only; resolution happens in the terminal.
- **Task blame** (per-line "which task introduced this"). Better built once the landed-task log is solid.
- **Cherry-pick / rebase / stash UI.** Stays in the terminal indefinitely — these are sharp tools that don't fit the domain language and don't need to.
- **Cross-task change comparison.**
- **Remote operations UI.** Stays in the terminal for v1; revisit when real users hit it.
- **DAG / graph visualisation of plans.** Considered and rejected: plans are operational surfaces, the list scales better, and the dependency information is already expressed inline. Revisit only if real users complain about not being able to see plan shape at a glance.

---

## Open questions for the implementer to flag

1. Large proposals (>5000 lines of changes) — virtual scrolling and per-file "load more"? Confirm approach before building.
2. Hunks touched by multiple authors — show most recent only, or all? Recommendation: most recent on the badge, tooltip lists all contributors.
3. Squash author when multiple contributors: use the landing user as author, all contributors as `Co-authored-by:`. Confirm.
4. Copy pass scope: should retranslation of existing surfaces (audit log entries, error messages, settings labels) ship with v1 or as a follow-up sweep? Recommendation: ship the new surfaces with new vocabulary; sweep the rest in a dedicated copy PR within the same release.
5. "Ready" affordance styling on the plan detail page — confirm visual treatment with design before implementing. A subtle row background tint is the safest default; a "ready" pill may compete with the state pill.

---

## Acceptance criteria

- `Review changes` opens an inline proposal view, grouped by file, with author badges on hunks.
- `Since last review` filters correctly; opening the view updates the timestamp.
- Plan detail page retains its list layout, with state pills on every task row, consistent blocked-by formatting, and a visual cue for unblocked-but-not-started tasks.
- `Land` button reflects pre-land state correctly; clicking performs a squash with the specified message format and cleans up the task files.
- Workspace history view lists landings as tasks, links back to task detail.
- New vocabulary is used consistently in all new surfaces and in retranslated existing surfaces. No `merge`, `branch`, `worktree`, `diff`, `conflict`, `HEAD`, etc. appear in user-facing strings.
- Error messages use the domain vocabulary.
- All existing functionality (terminals, pipeline, audit trail, auditor verdict) continues to work.
