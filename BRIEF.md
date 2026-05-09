```text
Act as a senior product-minded engineer. Inspect this repo and implement the first shippable slice of a progressive “Requirements Distillation Lab” for the app’s feature briefing flow.

Important product constraint:
This app does NOT have a chat interface. Do not design this as a conversational back-and-forth. The user starts with a feature description in a form/workbench, then reviews structured outputs, edits fields, approves assumptions, resolves questions, and only then creates tasks.

Core idea:
When a user describes a feature, the app should classify the request, choose an appropriate briefing depth, gather only targeted codebase context, run specialist model personas, estimate token/cost tradeoffs, identify ambiguities, and produce a structured brief that can generate accurate agent tasks later.

Start by inspecting the repository. Find the existing briefing UI, backend briefing flow, task generation flow, provider/model selection, and any Linear import functionality. Do not assume the framework or architecture.

Implement the smallest coherent shippable version of the following.

Briefing depth modes:
- Quick
- Guided
- Thorough
- Adversarial

Depth behavior:
- Quick: use minimal processing for simple/low-risk requests.
- Guided: include ambiguity detection and implementation planning.
- Thorough: include targeted codebase context retrieval.
- Adversarial: include red-team review, preferably with a different provider or model family when configured.

Request classification:
Classify the feature description by:
- complexity
- ambiguity
- risk
- likely touched areas
- recommended briefing depth
- whether repo scanning is needed
- whether multi-model critique is justified

Briefing budget model:
Show or store an estimated cost/risk/confidence tradeoff before expensive steps run where practical.
Principle: spend tokens proportional to ambiguity and risk.
Simple requests should stay cheap. Expensive repo scanning and adversarial review should only trigger when complexity, risk, or ambiguity justify it, or when the user explicitly selects a deeper mode.

Non-chat clarification model:
Since there is no chat interface, generate a structured ambiguity ledger instead of asking conversational questions.

Each ambiguity item should include:
- question
- why it matters
- risk if unanswered
- recommended default assumption
- whether user input is required
- status: unresolved, assumed, user_resolved
- optional user answer/edit field

Reviewable brief workbench:
The generated brief should be shown as structured, editable/reviewable sections rather than a chat response.

The final brief should include:
- goal
- user value
- target users
- non-goals
- codebase context
- relevant files
- required behavior
- UX requirements
- data/API requirements
- permissions/security
- edge cases
- tests required
- risks
- approved assumptions
- open questions
- task graph
- acceptance criteria

User playback before task creation:
Before tasks are created, present a concise confirmation summary in the UI/workbench:
- “Here’s what I think you want…”
- recommended briefing depth
- approved assumptions
- unresolved questions
- task count
- notable risks
- estimated confidence

Task creation should be blocked if required ambiguity items are unresolved, unless the user explicitly chooses to accept recommended assumptions.

Multi-model / multi-persona review system:
The briefing pipeline should support multiple specialist personas. These can initially be implemented as prompt roles using the existing provider/model abstraction, and later mapped to Claude CLI, Codex CLI, OpenAI APIs, or Anthropic APIs.

Do not assume this requires a chat interface. Each persona should produce structured output that feeds the brief workbench.

Personas:

1. Intent Extractor
Purpose:
Turn the user’s raw feature description into clear product intent.

Outputs:
- goal
- user value
- target users
- core workflows
- explicit requirements
- implied requirements
- non-goals
- success criteria

2. Codebase Cartographer
Purpose:
Inspect the repository and identify implementation-relevant context.

Outputs:
- likely touched areas
- relevant files
- existing patterns to reuse
- APIs/hooks/components/services involved
- tests likely affected
- architectural constraints
- unknowns that require targeted retrieval

3. Ambiguity Hunter
Purpose:
Find what an implementation agent may misunderstand.

Outputs:
- ambiguity ledger entries
- missing decisions
- conflicting requirements
- vague terms
- risky assumptions
- recommended default assumptions
- whether user input is required

4. Implementation Planner
Purpose:
Convert the brief into a task graph that an execution agent can safely follow.

Outputs:
- task graph
- task dependencies
- suggested file ownership
- acceptance criteria per task
- required tests
- execution risks
- parallelizable vs sequential work

5. Skeptic / Red-Team Reviewer
Purpose:
Attack the brief before tasks are created.

Outputs:
- missing requirements
- overbuilding risks
- unsafe assumptions
- security/privacy concerns
- UX edge cases
- data migration risks
- test gaps
- reasons task creation should be blocked or allowed

6. Final Synthesizer
Purpose:
Reconcile persona outputs into the final structured brief.

Outputs:
- final human-readable brief
- machine-readable brief JSON
- approved assumptions
- unresolved required questions
- confidence score
- recommended briefing depth
- readiness status: ready_for_tasks, ready_with_assumptions, blocked_needs_user_input

Persona execution by depth:
- Quick mode may only use Intent Extractor and Final Synthesizer.
- Guided mode should use Intent Extractor, Ambiguity Hunter, Implementation Planner, and Final Synthesizer.
- Thorough mode should also use Codebase Cartographer with targeted repo retrieval.
- Adversarial mode should add Skeptic / Red-Team Reviewer, ideally using a different provider or model family where available.

User-configurable provider/model per persona:
The user should be able to configure which provider and model each persona uses.

Requirements:
- Add or extend UI/settings so each persona can have its own provider/model selection.
- Reuse the existing provider/model abstraction if one exists.
- Support sensible defaults so users do not have to configure every persona manually.
- Allow a global default provider/model, with per-persona overrides.
- Persist the configuration using the app’s existing settings/storage pattern.
- Validate unavailable provider/model selections.
- If a persona-specific provider/model is unavailable, fall back gracefully to the global default and surface a clear warning.
- For Adversarial mode, prefer using a different provider/model family for the Skeptic / Red-Team Reviewer when the user has configured one.
- Show the configured persona/provider/model mapping somewhere appropriate in the briefing workbench or settings UI.

Suggested defaults if the app supports these providers:
- Intent Extractor: fast/cheap capable model.
- Codebase Cartographer: code-strong model.
- Ambiguity Hunter: reasoning-strong model.
- Implementation Planner: code-strong model.
- Skeptic / Red-Team Reviewer: different provider/model family from the planner where possible.
- Final Synthesizer: strongest configured model or the selected main model.

Progressive codebase context:
Avoid dumping the whole repo into context. Prefer targeted retrieval:
- file tree summaries
- ripgrep/symbol search
- relevant file snippets
- cached repo understanding if the app has it or a natural place to add it

Product principles:
- The user should not have to chat with the model.
- The system should feel like a panel of specialist reviewers working quietly behind the workbench.
- The model personas should produce structured artifacts the user can review, edit, approve, or reject.
- Ask targeted, codebase-aware questions as fields/items in the workbench, not as conversational turns.
- Let users approve default assumptions in bulk.
- Do not create tasks until the brief is sufficiently clear or the user explicitly accepts assumptions.
- The downstream agent should receive machine-readable task context, not just prose.
- Spend tokens proportional to ambiguity and risk.

Implementation guidance:
- Follow existing app architecture and UI conventions.
- Keep the first implementation scoped and shippable.
- Prefer clear types/interfaces for briefing classification, ambiguity ledger entries, briefing depth, persona config, persona outputs, brief sections, and task graph nodes.
- If there is already a backend route/service for briefing, extend it rather than creating a parallel system.
- If the app already has provider/model abstraction, reuse it.
- If the app already has settings for provider/model selection, extend them for persona-specific overrides.
- If implementation is too large for one pass, create a phased plan and implement Phase 1.
- Add tests where appropriate.
- Run relevant typecheck/lint/test commands if available.

Deliverables:
- Code changes for the initial implementation, or a concrete phased plan if code changes require architectural decisions.
- A short summary of changed files.
- Any tests/checks run.
- Remaining gaps or follow-up work.

Important:
First inspect the repository. Do not assume the framework or structure. Do not invent new architecture until you understand the existing one.
```
