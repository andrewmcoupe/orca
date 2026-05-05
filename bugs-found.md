# Bugs found during manual UAT

- Clicking merge doesn't show any loading state and leaves the user confused as to what is going on
- Re-run auditor phase on task detail view should be disabled if the task is in an immutable state e.g. merged, approved etc.
- We shouldnt be able to delete a worktree whilst task is in progress
- We shouldnt be able to press start on a task whilst it is being initialised
- I had a gate set to run on implementor, gate failed after implementer, i removed the gate from the workspace config, reran the task, iplementer completed but auditor didnt start
- Review modal should scroll full code block, not lines

## Ideas

- For briefing we could give the user the option of providing details of the feature and allowing the LLM to use it's own recomendations or allow the user to have an interactive briefing session whereby the user does a back-and-forth chat with the briefing LLM to allow tighter decision making.
- Update models for claude and codex
- Allow editing gates per task on the task detail page
