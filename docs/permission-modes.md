# Permission Modes

Each phase of a task runs the underlying agent CLI (Claude Code, etc.) with a
specific *permission mode*. The mode controls how much trust the CLI extends to
the agent before prompting the user — and because Orca runs the CLI
non-interactively (no TTY, closed stdin), prompts are not actually answerable;
the relevant choice is how much the agent is *allowed to do* without one.

There are three modes:

- **Plan (read-only)** — `plan`. The agent can analyse the worktree but cannot
  modify files or run shell commands. Used for the auditor by default: it only
  needs to review the diff and render a verdict.
- **Accept edits** — `acceptEdits`. The agent auto-accepts file edits within
  the working directory but still gates shell commands. Default for the
  test-author and implementer phases. Safe for typical write work; a misbehaving
  agent can edit files but cannot run arbitrary shells.
- **Bypass permissions** — `bypassPermissions`. The agent runs anything without
  prompting. Selectable for the test-author and implementer when you've decided
  to trust the agent for this task. Translates to the CLI's
  `--dangerously-skip-permissions`. The auditor *never* accepts this mode — the
  resolution layer and the provider both clamp it down to `acceptEdits` if
  somehow set.

## Where the mode is set

There are three layers, with the most-specific winning:

1. **Per-task override** — picked from the preview screen before starting a
   task, or via the task creation Advanced panel. Stored on the task's
   `phase_config.permission_modes`.
2. **Workspace default** — set in *Workspace settings → Default phase
   settings*. New tasks inherit these on creation.
3. **Bundled fallback** — `acceptEdits` for write phases, `plan` for the
   auditor. Used when neither of the above is set.

The resolved mode is captured on `PhaseRunStarted` so retroactive setting
changes don't rewrite history; phase cards in the task detail view show what
each run actually used.

## See also

- Claude Code's own permission docs for the meaning of each CLI flag.
- `docs/events.md` for the event schema (`PhaseRunStarted.permission_mode`,
  `default_phase_settings`, `phase_config.permission_modes`).
