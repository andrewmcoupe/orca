# Git is an implementation detail

This document explains why this app deliberately hides Git from its users and how to think about the relationship between our domain vocabulary and the Git operations underneath. Read this before adding user-facing copy, designing new flows, or extending the data model.

## The premise

In a traditional development tool, the human is the agent doing the work. Git's vocabulary — commits, branches, merges, rebases, refs, HEAD — exists to give that human fine-grained control over their history. Every Git primitive is a tool for someone whose hands are on the keyboard.

In this app, agents do the work. Humans brief, review, and approve. Their hands are mostly *not* on the keyboard. The fine-grained controls Git offers aren't tools they need; they're a vocabulary of mechanisms describing how the system happens to be built underneath. Surfacing them forces the user to translate between what they want ("accept this work") and what the system does ("squash merge this branch into its parent"). That translation is friction with no upside.

So we hide Git. Not as a beginner-friendly veneer that power users peel back, but as a deliberate architectural choice: Git is plumbing. Our domain model is porcelain. The two languages coexist with a clear boundary, and most users never cross it.

## What the user actually does

Strip the workflow back and there are six things a human does in this app:

1. Ask an agent to attempt some work
2. Look at what the agent produced
3. Accept the work into the parent line of development
4. Pass it back to the agent with notes
5. Bring work in line with parent changes that happened in parallel
6. Recover from a stuck state, or abandon a task entirely

That's the entire verb surface. Every feature and term in the UI should serve one of these intents. If a feature exists to expose a Git mechanism that doesn't map to a human intent (cherry-pick, stash, reflog), it doesn't belong in the UI.

## The vocabulary

Our terms are named for the user's intent, not the underlying mechanism. The mapping:

| Our term | Git equivalent | What the user means |
|---|---|---|
| **Proposal** | The branch's diff against its merge base | The body of work being reviewed |
| **Land** | Squash merge | Accept this proposal |
| **Catch up** | Rebase onto current parent | Bring this proposal in line with parent changes |
| **Collision** | Merge conflict | Two changes overlap and need resolution |
| **Changes** | Diff | The set of modifications a proposal contains |
| **Revision** | Commit | A snapshot within a proposal (rarely surfaced) |
| **Sync** | Pull / fetch / push | Bidirectional remote operations |
| **Task** | A branch + worktree + spec + audit trail | A discrete unit of work |
| **Plan** | A set of related branches with dependency ordering | A coherent piece of work composed of tasks |

State words follow their verbs to avoid Git-style inconsistency (Git: you "merge" but the result is "merged"; you "checkout" and the result is "on branch X"):

| State | Meaning |
|---|---|
| `Drafting` | The implementer is producing the proposal |
| `Under review` | Auditor or human is evaluating |
| `Approved` | Auditor has approved |
| `Ready to land` | Approved and all pre-land checks pass |
| `Landing` | Land action is in flight |
| `Landed` | Successfully landed into parent |
| `Needs catch-up` | Parent has moved; proposal needs to catch up before landing |
| `Catching up` | Catch-up is in flight |
| `Has collisions` | Catch-up produced collisions that need resolution |

## Terms that do not exist in the UI

Under any circumstance, these terms must not appear in user-facing strings — labels, buttons, tooltips, error messages, audit log entries, settings descriptions, empty states, anywhere:

`branch`, `HEAD`, `ref`, `index`, `stash`, `reflog`, `worktree`, `fast-forward`, `cherry-pick`, `checkout`, `pull`, `fetch`, `push`, `origin`, `merge`, `rebase`, `conflict`, `diff`, `commit` (as a noun in user-facing copy)

If one of these would be the natural word to use, you're describing a mechanism rather than an intent. Find the intent and name that instead. If the intent has no name yet, that's a vocabulary gap to discuss before adding new copy, not a license to fall back on Git terms.

This rule has one exception: the terminal. See the boundary section below.

## Why each principle exists

**Name the intent, not the mechanism.** "Land" describes what the user wants (this work, on the main line). "Merge" describes how the system might achieve it (combining histories). Mechanism-names force users to learn the system; intent-names let the system serve the user.

**Verb and state must agree.** This sounds pedantic but it's the difference between a UI that feels coherent and one that feels like an assemblage of tools. If the action is `Land`, the in-flight state is `Landing` and the result is `Landed`. No drift.

**One word per concept.** Git uses "merge", "integrate", "combine", and "incorporate" interchangeably depending on context. We pick one word per concept and hold it. Synonyms drifting in from documentation, error messages, or third-party tooling are bugs.

**Errors speak the same language as happy paths.** This is where vocabulary discipline usually breaks down — error messages get written quickly, often by surfacing the underlying tool's error verbatim. Don't. An error message that says "merge conflict in src/foo.ts" undoes all the work the rest of the UI does. The correct version is "Collision in src/foo.ts while catching up."

**The terminal is the language boundary.** Users who want Git's full power have a terminal pinned in the task view. Inside that terminal, Git's terms apply — that's Git's world, not ours. We do not wrap `git` in shell aliases, we do not retranslate `git status` output, we do not try to extend our vocabulary into the shell. The two languages coexist with a clean boundary, and the user crosses it deliberately when they want to.

## What this means for implementation

**Git lives in the data layer.** Operations on revisions, branches, refs, and worktrees happen in dedicated Git-aware modules. Those modules speak Git internally. Their public APIs speak our vocabulary. A function called `land(task_id)` performs a squash merge internally; nothing outside that module needs to know.

**Domain models reflect our terms, not Git's.** `Task`, `Plan`, `Proposal`, `AuditorVerdict`, `Pipeline` are our nouns. `Branch`, `Commit`, `Ref` exist only inside the Git layer as implementation details. If a domain model needs to reference a Git object, it does so via an opaque handle (a SHA stored as a string) rather than by exposing the Git type.

**Database column names use our vocabulary.** `tasks.land_strategy`, not `tasks.merge_strategy`. `proposals.parent_collisions`, not `proposals.conflicts`. The schema is itself a kind of documentation; making it speak the right language pays compounding interest.

**Audit events are domain events.** `TaskLanded`, `CollisionsDetected`, `CatchUpStarted`. Never `BranchMerged` or `RebaseCompleted`. Even when the audit event is fundamentally about a Git operation, it's named for what it means to the user, not what the system did.

**Error messages are translated at the boundary.** When the Git layer raises an error (a `git merge-tree` failure, a rebase conflict), the boundary code that catches it translates it into a domain error before bubbling up. Domain errors use domain vocabulary. The original Git error is logged for debugging but not shown to users.

## What this means for design

When adding a new flow, the first question is "what is the user's intent?" — not "what Git operations does this require?" Start from the verb the user would type if they were describing what they want to do. Find or coin a domain term for it. Map that term to Git operations as the last step, not the first.

When reviewing copy, scan for the prohibited terms above. They tend to creep in via tooltips, error states, and form labels — the places copy gets written quickly. If you find one, the question isn't "is this Git term okay here?" but "what is the user actually trying to do, and what's the right word for that?"

When extending the vocabulary (adding new terms), apply the same principles: intent over mechanism, verb-state agreement, one word per concept. Coordinate with the rest of the vocabulary before adding — a new term should fit alongside existing ones, not overlap or conflict.

## What this means for the future

This philosophy gets stronger over time, not weaker. As we add features (collision resolution, multi-proposal review, cross-task comparison), they will all sit on top of Git operations underneath. The temptation to expose those operations directly — because it's faster, because users who know Git would understand them immediately — will be persistent.

Resist it. Every Git term we let into the UI is one our users have to learn, and one we're committed to maintaining the meaning of forever. Every domain term we add is a small bet that our model is clearer than Git's. So far that bet has paid off, and the reason it pays off is that we keep making it consistently.

The day a user opens this app and says "wait, this isn't really a Git tool, is it?" is the day we've succeeded.
