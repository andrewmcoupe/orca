# Bugs found during manual UAT

- Clicking merge doesn't show any loading state and leaves the user confused as to what is going on
- Re-run auditor phase on task detail view should be disabled if the task is in an immutable state e.g. merged, approved etc.
- audit trail uopdates in a strange way

## Ideas

- For briefing we could give the user the option of providing details of the feature and allowing the LLM to use it's own recomendations or allow the user to have an interactive briefing session whereby the user does a back-and-forth chat with the briefing LLM to allow tighter decision making.
- Update models for claude and codex
