# Brief for Claude Code: Light Theme Support

## Context

The app currently ships dark theme only. Dogfooding revealed the desire for a light theme — the existing dark palette is good, but there are real workflows (pairing with someone on a light setup, daytime use on a sunny screen, theme parity with the rest of the user's tools) where light reads better.

This brief adds full light theme support with system-preference following. No layout changes — the structure of every screen stays exactly as it is today. Only the colour palette switches based on OS theme.

The layout restructure (moving pipeline to a right sidebar, etc.) is a separate brief. This one is theme-only so theme issues don't compound with layout regressions.

**Prerequisites already in place:**

- Tailwind v4 with CSS variables for theming (set up at the start of the project)
- shadcn/ui components using CSS-variable-based styling
- A `ThemeProvider` component that detects system preference and applies a `dark` class to `<html>`
- All component styling already references `var(--background)`, `var(--foreground)`, etc., rather than hardcoded colours
- The light theme palette already exists in `globals.css` (or wherever the theme tokens live) — this brief makes it actually work end-to-end and adds the missing semantic colours

## Goals

1. The app supports a light theme that follows the OS system preference automatically.
2. The dark theme stays exactly as it is today (no regressions).
3. The light theme palette uses the existing values defined in `:root` (neutral greyscale, no hue).
4. New semantic colour roles (`--success`, `--warning`) are added for verdict-status colours, applied consistently across both themes.
5. The status bar at the bottom of the app respects the theme (not stuck on dark in light mode).

## Existing palette

The light theme `:root` block already contains:

```css
--background: oklch(1 0 0);
--foreground: oklch(0.145 0 0);
--card: oklch(1 0 0);
--card-foreground: oklch(0.145 0 0);
--popover: oklch(1 0 0);
--popover-foreground: oklch(0.145 0 0);
--primary: oklch(0.205 0 0);
--primary-foreground: oklch(0.985 0 0);
--secondary: oklch(0.97 0 0);
--secondary-foreground: oklch(0.205 0 0);
--muted: oklch(0.97 0 0);
--muted-foreground: oklch(0.556 0 0);
--accent: oklch(0.97 0 0);
--accent-foreground: oklch(0.205 0 0);
--destructive: oklch(0.577 0.245 27.325);
--destructive-foreground: oklch(0.985 0 0);
--border: oklch(0.922 0 0);
--input: oklch(0.922 0 0);
--ring: oklch(0.708 0 0);
--radius: 0.625rem;
--chart-1: oklch(0.87 0 0);
--chart-2: oklch(0.556 0 0);
--chart-3: oklch(0.439 0 0);
--chart-4: oklch(0.371 0 0);
--chart-5: oklch(0.269 0 0);
--sidebar: oklch(0.985 0 0);
--sidebar-foreground: oklch(0.145 0 0);
--sidebar-primary: oklch(0.205 0 0);
--sidebar-primary-foreground: oklch(0.985 0 0);
--sidebar-accent: oklch(0.97 0 0);
--sidebar-accent-foreground: oklch(0.205 0 0);
--sidebar-border: oklch(0.922 0 0);
--sidebar-ring: oklch(0.708 0 0);
```

These values are the source of truth. Don't re-derive or replace them. The dark theme variant of these variables (in the `.dark` block) is also already correct — preserve as-is.

## What's missing

The existing palette is pure neutral. The only chromatic colour is `--destructive`. This is fine as a base palette, but the auditor verdict card needs status-aware colours that aren't in the variable set yet:

- `APPROVE` should render with a green-tinted background and green badge
- `REVISE` should render with an amber-tinted background and amber badge
- `REJECT` already has `--destructive` available; just needs a tinted-background variant

Two new semantic roles need to be added to both `:root` and `.dark`:

```css
/* :root (light) */
--success: oklch(0.55 0.12 145);          /* sage green */
--success-foreground: oklch(0.985 0 0);
--warning: oklch(0.7 0.13 80);            /* amber */
--warning-foreground: oklch(0.18 0.04 80);

/* .dark */
--success: oklch(0.65 0.13 145);          /* slightly brighter sage for dark backgrounds */
--success-foreground: oklch(0.145 0 0);
--warning: oklch(0.75 0.14 80);
--warning-foreground: oklch(0.145 0 0);
```

These are starting values; tune during visual verification. The exact hue and chroma may need adjustment to match the mockup's sage green and to read well against both backgrounds.

## What's in scope

- Verifying the existing `:root` and `.dark` blocks render correctly across every screen and component.
- Adding `--success` and `--warning` to both theme blocks.
- Applying status-aware colours to the verdict card, phase status indicators, dependency badges, and provider chips.
- Ensuring the status bar themes correctly.
- Ensuring syntax highlighting in the diff panel switches between light and dark variants.

## What's out of scope

- Modifying the existing `:root` or `.dark` palette values
- Adding any colours beyond `--success` and `--warning` to the semantic palette
- Layout changes (separate brief)
- A theme toggle button (system-preference following only for now)
- Custom theme creation by users
- Print stylesheet or high-contrast theme
- Animation on theme switch (instant transitions)

## Verdict colour mapping

The auditor verdict card uses theme-aware tinted backgrounds:

- `APPROVE`: tinted background derived from `--success`, badge in `--success`
- `REVISE`: tinted background derived from `--warning`, badge in `--warning`
- `REJECT`: tinted background derived from `--destructive`, badge in `--destructive`

The tint comes via `color-mix` against `--background`:

```css
.verdict-approve {
  background: color-mix(in oklch, var(--success) 12%, var(--background));
}
.verdict-revise {
  background: color-mix(in oklch, var(--warning) 12%, var(--background));
}
.verdict-reject {
  background: color-mix(in oklch, var(--destructive) 12%, var(--background));
}
```

This produces a barely-tinted background in light mode (e.g. very light sage for approve) and a similarly subtle tint in dark mode (where the same blend yields a dark sage hue). One implementation, both themes.

If `color-mix` produces values that don't read well in one theme, fall back to explicit `--success-bg-subtle` etc. variables defined per-theme. Try `color-mix` first; only escalate if it fails.

## Milestones

### Milestone 1: Theme infrastructure verification

Before changing anything visible, verify the existing infrastructure works:

1. Confirm the `ThemeProvider` correctly reads `prefers-color-scheme: dark` and applies/removes the `dark` class on `<html>`.
2. Confirm that toggling system theme on macOS (System Settings → Appearance) reflects within the app within ~1 second without restart.
3. Confirm there's no flash of dark theme on app start in light mode (or vice versa). The inline script in `index.html` should set the theme class before React mounts.
4. Grep the codebase for hardcoded colours: `bg-black`, `text-white`, hex values like `#000`, `#fff`, raw `rgb()` calls. Refactor any holdouts to use CSS variables.

If any of these fail, fix as part of Milestone 1 before proceeding.

### Milestone 2: Walk every screen in light mode

With the existing palette already defined, switch the OS to light mode and walk every major screen:

- Workspaces home
- Plan list
- Plan detail
- Task detail (in various states: not started, in progress, awaiting review, merged, cancelled)
- Briefing setup
- Briefing review
- Settings (workspace settings, app settings, providers)

For each, verify:

- Backgrounds, foregrounds, borders all render correctly
- Cards, popovers, dialogs, tooltips render with appropriate hierarchy
- Buttons (primary, secondary, ghost, outline) all theme correctly
- Sidebar (workspaces accordion) uses the `--sidebar-*` variables and reads cleanly
- Status bar at the bottom themes correctly
- Inline code chips have appropriate subtle background contrast against prose

Particular attention to:

**Muted text contrast.** `--muted-foreground` at `oklch(0.556)` against `--background` at `oklch(1)` produces a contrast ratio that's borderline for WCAG AA at small text sizes. Test with a contrast checker. If muted text reads as too light, the fix is to apply a darker effective colour for body-sized muted text — but don't change the variable itself (it's the existing source of truth). Use a more contrasted variant only at the component level if needed.

**Border visibility.** `--border` at `oklch(0.922)` against `oklch(1)` background is a low-contrast border. This is intentional shadcn-style "barely visible" border. Confirm it reads as intended; it should be subtle but visible.

**Inline code backgrounds.** Inline code chips need a subtle background that distinguishes them from prose. Use `--secondary` or `--muted` (both `oklch(0.97)`) as the chip background. Test that mono code on this background reads well in both themes.

### Milestone 3: Add success and warning variables

Add `--success`, `--success-foreground`, `--warning`, `--warning-foreground` to both `:root` and `.dark` blocks, using the values above as starting points.

Apply to:

- Auditor verdict card backgrounds and badges
- Phase status indicators (running spinner uses `--warning`, completed dot uses `--success`, failed uses `--destructive`)
- Dependency status badges (MERGED uses `--success`, BLOCKED uses `--warning`, CANCELLED uses `--muted-foreground`)
- Provider status chips in the status bar (healthy=`--success`, degraded=`--warning`, down=`--destructive`)
- File-overlap warning dialog accents

Use the `color-mix` approach for tinted backgrounds. Verify the tints read appropriately in both themes; tune the percentages (currently 12%) up or down if needed.

### Milestone 4: Syntax highlighting

The diff panel uses `syntect` for syntax highlighting, with one of `syntect`'s dark themes selected. For light mode, switch to a light syntect theme — `InspiredGitHub` or `Solarized (light)` from the bundled themes are reasonable starting points.

Detect the active theme on the frontend, request the appropriate highlighting variant from the Rust side. The Rust diff command takes a theme parameter and picks the right syntect theme.

If the current implementation pre-highlights once and caches, you'll need to either cache both light and dark highlighted versions, or invalidate and recompute on theme change. Recompute-on-theme-change is acceptable for v1 — theme changes are rare.

### Milestone 5: Visual verification

Walk through each major screen in both themes side-by-side. Verify:

- Information hierarchy reads correctly in both themes (headings stand out, body text is comfortable, muted text is muted but legible)
- All interactive elements have visible hover and focus states in both themes
- All icon colours work in both themes (icons that are stroke-only inherit colour; filled icons may need explicit theme handling)
- Loading skeletons, empty states, and error states all theme correctly
- The diff panel renders correctly in both themes with appropriate syntax highlighting

If any colour reads subtly wrong, the fix is at the component level (use a different variable, adjust the `color-mix` percentage). Don't modify the source palette values.

## Conventions

- All colour values via CSS variables. No hardcoded hex or rgb values in components.
- shadcn components inherit theme automatically; don't override their colours unless absolutely necessary.
- The existing `:root` and `.dark` palette values are the source of truth. Don't modify them.
- New semantic colours (`--success`, `--warning`) are added to both blocks together; keep them in sync.
- Use `color-mix(in oklch, ...)` for tinted backgrounds. Falls back to explicit per-theme variables only if `color-mix` produces unacceptable results.
- Component-level contrast adjustments are fine; palette-level changes are not.

## Deliverable

A working app where:

1. Setting the OS to light mode renders the app in light theme automatically using the existing palette values.
2. Setting the OS to dark mode renders the app in dark theme (existing behaviour preserved).
3. Switching the OS theme while the app is open updates within ~1 second without restart.
4. All major screens read cleanly in both themes.
5. The new `--success` and `--warning` variables are added to both theme blocks and applied to verdict cards, status indicators, and dependency badges.
6. Syntax highlighting in the diff panel switches between light and dark variants.
7. No layout or structural changes — only colour application.
8. The existing `:root` and `.dark` palette values are unmodified.

No automated tests required. Visual changes only. Verify by walking each screen in both themes.

Two commits is the right shape: infrastructure verification and walkthrough (Milestones 1-2), semantic colour additions and syntax highlighting (Milestones 3-5).
