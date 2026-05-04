# Brief for Claude Code: Visual Refinement Pass

## Context

The app's structure and density are good after the previous passes. This brief is three small visual refinements that together substantially improve the read of the app:

1. **Content width constraint** — long prose currently stretches across the full page; reading is harder than it should be.
2. **Typography audit** — apply mono-vs-sans consistently based on whether content is code-related.
3. **Optional font swap** — try Inter or Geist as the sans if Roboto Condensed feels neutral after the above.

No structural changes. No new features. No event schema changes. Pure visual refinement.

Match the existing design language: dark, dense, calm, developer-toolish. Don't add shadows, gradients, animations, or anything that pushes toward "polished web app" register.

## Pass 1: Content width

### Problem

Prose-bearing sections (auditor verdict text, plan descriptions, spec items, task titles when long) currently fill the available main-content width. On wide displays this produces line lengths of 200+ characters, which is genuinely hard to read. Typographic best practice is 50-75 characters per line; we'll target ~80-90 to match the dev-tool aesthetic.

### Rule

Inside the main content area of any workspace-scoped view, prose content should max-width to roughly **760px**, left-aligned to the content area's left edge. Non-prose content (cards, structured data rows, status indicators) stays at its natural sizing.

The page chrome (sidebar, top breadcrumb area, bottom status bar) is unchanged — it still uses full width. Only the content inside the main area is constrained.

### Apply to

These elements get max-width 760px:

- Task title and subtitle line ("Merged into X as Y · 13h ago")
- Spec section content
- Auditor verdict card (the card itself, not just the text inside)
- Plan description (markdown-rendered)
- Audit trail rows
- Briefing setup textarea and review-screen prose elements

### Don't apply to

These stay at full available width:

- Pipeline phase cards row (the cards themselves are constrained, but the row containing them uses available width with cards left-aligned)
- "Initialized · pnpm install --frozen-lockfile · 3.6s" line (it's a single dense metadata row)
- Section labels (`SPEC`, `AUDITOR VERDICT`, etc.) — they sit above their content but don't need width constraint
- The eventual diff panel (right panel, separate concern)
- Any tabular data with multiple columns
- Long single-line items where wrapping would hurt scannability

### Implementation

Add a utility class or component (`<ContentColumn>` or similar) for constrained prose content. Apply it consistently. Don't sprinkle `max-w-[760px]` literals throughout the codebase — one place to change the value if it's wrong.

Left-aligned, not centred. Centring matches a marketing-page register, which is wrong for a developer tool. The left edge of constrained prose aligns with the left edge of the section labels above it.

### Pass 1 deliverable

Open the task detail view on a wide display. Prose sections wrap at a comfortable reading width. Phase cards and metadata rows remain at their current sizing. Page feels less "stretched" and more focused without anything visibly missing.

## Pass 2: Typography audit

### Rule

**Mono is for code-related content.** Sans is for everything else.

Code-related, use JetBrains Mono:

- File paths (`server/adapters/gemini.ts`, `src/middleware/index.ts`)
- Code identifiers when appearing inline in prose (`Spawner`, `makeProgram`, `acquireRelease`)
- Commit SHAs (`63e49ec9`, `902f4477`)
- Command output and command strings (`pnpm install --frozen-lockfile`)
- Event names and IDs (`AuditorVerdictRendered`, `pr_01KQQ…`)
- Code blocks in spec, description, and auditor rationale
- Phase card metadata (`mode: bypassPermissions`, `1m 22s`, `claude-opus-4-5`)
- Timestamps (`17:43:03`)
- Numeric data with fixed format (`95%`, `+12 -4`)
- Status bar latest-event line

Not code-related, use sans (Roboto Condensed for now, possibly swapped in Pass 3):

- Page titles, task titles, plan titles
- Body prose: auditor rationale, plan descriptions, briefing setup prose
- Button labels (`Restart`, `Run task`, `Review diff`)
- Sidebar nav items (`Plans`, `Providers`, `Settings`, `About`)
- Sidebar workspace names
- Section labels (`SPEC`, `AUDITOR VERDICT`, `PIPELINE`, `AUDIT TRAIL`)
- Status badges (`MERGED`, `APPROVE`, `ADVISORY`)
- Concern category labels (`style`, `tests`, `correctness`)

### Inline code in prose

Particular attention here. When a code identifier appears inline in sans-set prose, the visual weight of the mono needs to match the surrounding sans. Currently the mono is heavier than the surrounding text, which creates visual "lumps."

Two ways to balance:

- Use a slightly lighter weight of JetBrains Mono inline (e.g. weight 400 mono inside weight 400 sans, but bump sans to 450 or use a slightly heavier variant of the sans). Test which combination reads as visually equal-weight.
- Or: apply a subtle background tint to inline code (`bg-muted/30` or similar — very subtle). This visually groups the code without making it heavier. Works well in dev-tool contexts.

I'd lean toward the second approach (subtle background tint) — it's a known good pattern for inline code in prose, and it solves the weight problem without fiddling with font weights. The tint should be very subtle: just enough to register as "this is code" without becoming visually loud.

### Audit each existing text element

Walk through every page in the app. For each text element, decide: is this code-related or not? If the current treatment doesn't match the rule, change it.

Likely places where the current code uses mono but should use sans:

- Section labels (`SPEC`, `AUDITOR VERDICT`, etc.) — they're labels, not code. Currently mono with letter-spacing and uppercase; the same treatment in sans reads as a label without the code association.
- Status badges (`MERGED`, `APPROVE`) — these are categorical labels.

Likely places where the current code uses sans but should use mono:

- Any inline code identifiers in prose that aren't currently treated as code.
- Filenames or paths in titles or subtitles.

### Pass 2 deliverable

Every text element in the app uses mono or sans deliberately. Inline code in prose has appropriate visual weight balance. Section labels read as labels rather than as code. The typographic system is internally consistent and rule-driven.

## Pass 3: Optional font swap

After Pass 1 and Pass 2 are done, evaluate whether the sans font (Roboto Condensed) feels right. It's currently a competent neutral, but slightly characterless next to the more opinionated JetBrains Mono.

### Try, in order

If anything in this section requires more than ~30 minutes of fiddling, abandon it and stick with Roboto Condensed. The point of Pass 3 is a quick low-cost experiment, not a redesign.

**Option A: Inter.** The default modern UI sans. Pairs cleanly with JetBrains Mono. Less condensed than Roboto Condensed, so you may need to slightly tighten line-height and letter-spacing on titles to compensate. Self-host via `@fontsource/inter` to avoid Google Fonts.

**Option B: Geist.** Vercel's font. Modern, distinct, designed alongside Geist Mono. If you go this way, also try swapping JetBrains Mono for Geist Mono — the pair is designed to work together. Self-host via `@fontsource/geist-sans` and `@fontsource/geist-mono`.

**Option C: Stay with Roboto Condensed.** Perfectly fine. Don't swap for the sake of swapping.

### Decision criteria

Apply the candidate font, look at:

- Sidebar workspace names — do they read as cleanly as before?
- Page titles like "Document Effect patterns and add JSDoc" — do they have appropriate presence?
- Auditor verdict prose — easier or harder to read?
- The visual relationship between the sans and mono — more harmonious, or no different?

If after 15 minutes of looking at it the new font feels neutral or worse, revert. If it feels better, keep it.

### Pass 3 deliverable

Either: the sans font has been swapped to Inter or Geist, and the app reads more cohesively as a result. Or: confirmation that Roboto Condensed is the right choice, and we move on. Either outcome is fine.

## Conventions

- Self-host all fonts via `@fontsource/*` packages. No Google Fonts links — they slow down Tauri's webview load and the offline character of the app.
- Use Tailwind's font config in `tailwind.config.ts` (or the v4 CSS-vars equivalent in `globals.css`) so font usage is `font-sans` / `font-mono` throughout the codebase, not direct font-family strings.
- Don't change colour palette, spacing, or any non-typographic visual property in this brief.
- No animations on typography changes. Static is correct.

## Out of scope

- Any structural layout changes beyond width constraint
- Spacing/padding adjustments (already done in earlier passes)
- Colour changes
- Light theme support
- Custom OpenType features (ligatures, alternate glyphs) beyond defaults
- Variable font weight axes — use weight stops (400, 500, 600) explicitly
- Print stylesheet
- Right-side panel layout (separate brief)
- Any non-typography polish

## Deliverable

A working app where:

1. Prose content in workspace-scoped views wraps at ~760px max-width, left-aligned.
2. Phase cards, metadata rows, and full-width chrome remain at their current sizing.
3. Typography is consistent: mono for code-related content, sans for everything else.
4. Inline code in prose has balanced visual weight against surrounding sans.
5. Section labels read as sans labels rather than mono code.
6. Either Inter, Geist, or Roboto Condensed is the chosen sans, with explicit justification (or "kept current" is the answer).

No tests required for this brief — visual changes only. Verify by looking at each main view (plans list, plan detail, task detail with auditor verdict, briefing setup, briefing review).

Three commits is right: one for Pass 1 (width), one for Pass 2 (typography audit), one for Pass 3 (font swap or confirmed-current).
