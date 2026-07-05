# Accessibility — Roadmap & Standing Checklist

> Status: **✅ All 5 identified gaps done** (2026-07) — colorblind-friendly palette,
> the contrast audit, `aria-live` announcements for turn results + achievement
> flashes (controller only — see the open question about `display.html`), the
> accessible-input-path framing for `default_scoring_input`, and the type-size pass.
> Unlike the other docs in this folder, this isn't a single future feature that's now
> "finished" — it's a cross-cutting standard the app should hold itself to as new
> features (including everything else in `docs/*.md`) get built, so this doc stays in
> `docs/` rather than moving to `docs/archive/` even with every identified gap
> closed — see the "Standing practice going forward" section below and `CLAUDE.md`
> for the binding convention that points here.
>
> **Accessible-input-path framing (2026-07)**: explicitly decided and documented (not
> just left as an implicit baseline fact) that Pad mode is the app's accessible input
> path — ordinary focusable buttons, no dartboard shape to perceive, no precise
> tap-target aiming required, unlike the SVG Dartboard's sector/ring hit-testing.
> Updated the Settings copy in both the Scoring section (which owns
> `default_scoring_input`) and the Accessibility section (which now cross-references
> it, so an admin looking there for accessibility guidance finds it too), the
> dropdown's own "Pad" option label, README.md's Input modes and Default input
> descriptions, and REFERENCE.md's Input paths section. Pure documentation/UI-copy —
> no new mechanism, since Pad mode already existed and already worked this way.
>
> **Type-size pass (2026-07)**: catalogued every sub-13px `font-size` in
> `frontend/index.html` (about a dozen distinct values from 9px to 12px, ~120 uses
> total) rather than assuming the existing scale was fine. Verdict: the compact tier
> (10-12px: field labels, chips, secondary metadata) is a deliberate, working design
> choice — zoom isn't disabled (confirmed baseline), and none of it is essential
> content that would block a task if briefly hard to read. Two genuine outliers at
> 9px, both non-decorative primary labels rather than secondary chrome, were bumped
> to the existing 10.5px tier already used elsewhere (`.out-tag`, `.pscore .nm-out`)
> for consistency: `.bubble-label` (the sole visible label naming each Player Profile
> stat bubble's number — without it the number is meaningless) and `.cs-throw-chip`
> (the Cricket scorecard's sole textual "whose turn" indicator, previously redundant
> with only a subtle background-tint highlight). Verified visually via Playwright
> screenshots (Player Profile stat bubbles, the Cricket scorecard header) — no
> overflow, clipping, or layout regression at either size. `display.html`'s type
> scale (`vmin`-based, scaling with the physical display's size) is a fundamentally
> different concern and was explicitly left out of this pass, matching how the
> `aria-live` pass also scoped itself to the controller only.
>
> **Contrast audit (2026-07)**: computed real WCAG 2.1 contrast ratios (relative
> luminance formula) for every text-color/background pairing in the palette, rather
> than assuming a dark theme with gold/cream accents was fine by default. Found and
> fixed 4 real AA failures (4.5:1 normal text):
> - `--green` (`#1b8a3a`) as text (the "leg won" status line, Cricket's closed-number
>   marks) was 3.88:1-4.34:1 against `--surface`/`--board`. Brightened to `#2fa050`
>   (5.12:1-5.73:1) — the dartboard SVG's own treble-ring green is a hardcoded hex,
>   unaffected, so the physical board's look is unchanged.
> - `--bust` (`#e2473d`) as text (bust status, settings/wizard error banners) was
>   4.25:1 against `--surface` (passed `--board` at 4.76:1, just not both). Brightened
>   to `#ea6058` (4.72:1-5.78:1 everywhere it's used).
> - `--red` (`#c8102e`) as text — its only such use, the Pad's "Bull" button label —
>   was 2.92:1, a real failure (its border/background uses elsewhere are fine, since
>   those only need the UI-component 3:1 bar). Added a dedicated `--red-text`
>   (`#ff8a93`, reusing the exact shade already used for red-on-tinted-background
>   text elsewhere) rather than changing `--red` itself, which stays as-is for
>   borders/backgrounds.
> - The dartboard SVG's own "Bull" center-circle text (hardcoded `#efe7d2`, not a CSS
>   variable) passes against the default red bull (4.77:1) but was a genuine
>   colorblind-mode regression: 2.58:1 against the lighter orange substitute
>   (`#e2711d`) that mode swaps in. Now conditionally dark (`#151613`, 6.10:1) only
>   in colorblind mode, cream everywhere else — colorblind mode no longer makes this
>   specific label harder to read while fixing the red/green distinction it exists for.
>
> Everything else audited passed with real margin: `--ink`/`--muted`/`--gold`/`--cream`
> against every surface (5.16:1-16.73:1), the colorblind-mode overrides themselves
> (4.95:1-6.05:1), and every border/background (UI-component) use of `--red`/`--green`
> (≥3:1). Verified both numerically (a relative-luminance contrast calculator run
> against the exact hex pairs) and visually (Playwright screenshots of the Pad, the
> dartboard in both palettes, and forced status-text states) against a scratch
> database. No behavior change, no new dependency, no test added (a color-contrast
> fix isn't a "calculation" per CLAUDE.md's testing convention — verified live instead).

## Goal

Make Oche as accessible as possible to players and admins with visual, motor, or
assistive-technology needs, and keep it that way as new features land — rather than
treating accessibility as a one-time pass or a single feature (colorblind mode) done
in isolation.

## What the app already does right (baseline, confirmed in code)

- Toggle/segmented controls consistently use `aria-pressed` and `role="group"` with
  `aria-label` (multiplier buttons, format pickers, out-mode segments, nav bar's
  `aria-current`) — `frontend/index.html`.
- `@media (prefers-reduced-motion:reduce){*{animation:none!important}}` is already
  respected (`frontend/index.html:347`) — confetti/pulse/flash animations are disabled
  for users who've asked for that at the OS level.
- The viewport meta tag does **not** disable pinch-zoom (no `user-scalable=no` /
  `maximum-scale=1`) in either `index.html` or `display.html` — zooming for low-vision
  users already works.
- **Pad mode already exists as a non-visual-board input path** — scoring doesn't
  strictly require tapping the SVG dartboard's sector shapes; the number-pad + Single/
  Double/Treble buttons work the same way and are ordinary focusable `<button>`
  elements.

## Identified gaps (this session's audit)

1. ~~**No `aria-live` regions anywhere in the app.**~~ ✅ **Done, for `frontend/index.html`.**
   A visually-hidden `#sr-announcer` (`aria-live="polite"`, `aria-atomic="true"`) now
   announces exactly what this gap called for and nothing more: the committed result
   of `enterTurn()` ("Alice scores 60, 201 remaining." / "Alice busts, stays on
   140." / "Alice checks out with 40. Leg won.") and every achievement flash as it's
   shown (`pumpAchievementQueue()`, reusing `ACH_LABELS`/`achDescFor()` — no new
   copy). Deliberately *not* wired into `throwDart()`'s per-dart live preview, per
   this gap's own scoping note. `announce()` clears the region before setting new
   text so two identical announcements in a row (e.g. "Bust" twice) both actually
   get spoken, since most screen readers don't re-announce unchanged live-region
   content. **`display.html` was deliberately left out of this pass** — see the open
   question below about whether the shared/ambient scoreboard display warrants the
   same investment as the primary controller.
2. ~~**Color-only signals extend beyond the dartboard.**~~ ✅ **Done** — the shipped
   colorblind-mode palette (see `docs/archive/colorblind-mode-roadmap.md`) covers the
   Pad-mode Double/Treble buttons, entered-dart slot borders, win/bust status text,
   and the dart-analytics chart alongside the dartboard SVG and live scoreboard, not
   just the SVG board in isolation.
3. ~~**No contrast audit has been performed.**~~ ✅ **Done** (2026-07) — see the status
   header above for the full punch list and fixes (`--green`/`--bust` brightened,
   a new `--red-text` for the one place `--red` was used as text, and a
   colorblind-mode-specific fix to the dartboard's own "Bull" label).
4. ~~**`default_scoring_input` is framed as an aesthetic choice today, not an
   accessibility one.**~~ ✅ **Done** (2026-07) — see the status header above.
5. ~~**Small type sizes on secondary UI text**~~ ✅ **Done** (2026-07) — see the status
   header above for the catalog, the verdict (the compact tier stays, deliberately),
   and the two genuine outliers that were bumped.

## Suggested priority order

1. ~~**Colorblind-friendly palette**~~ ✅ **Done** (`docs/archive/colorblind-mode-roadmap.md`) —
   very low complexity, CSS-only, shipped with the Pad-button expansion from gap 2
   above folded in.
2. ~~**Contrast audit**~~ ✅ **Done** (2026-07) — see gap 3 above and the status
   header for the punch list and fixes.
3. ~~**`aria-live` announcements**~~ ✅ **Done** for `frontend/index.html` — see gap 1
   above. `display.html` intentionally not yet covered.
4. ~~**Accessible-input-path framing for `default_scoring_input`**~~ ✅ **Done**
   (2026-07) — see gap 4 above and the status header.
5. ~~**Type-size pass**~~ ✅ **Done** (2026-07) — see gap 5 above and the status header.

## Standing practice going forward

Every future roadmap item in this folder (Cricket/game modes, tournament mode, the
mobile app, etc.) should consider keyboard/focus order, color-only signals, and
screen-reader announcements as part of its own design — not as a follow-up pass after
the fact. See `CLAUDE.md` for the binding version of this statement.

## Open questions for whoever picks this up

- How much should `aria-live="polite"` vs. `aria-live="assertive"` be used for
  different event types (a routine turn result vs. a bust vs. a game-winning
  checkout) — needs real screen-reader testing (VoiceOver/NVDA), not just markup
  review.
- Whether the live scoreboard (`display.html`) — a shared TV/monitor display, not a
  primary interaction surface — warrants the same level of investment as the
  controller app, given its role is ambient/glanceable rather than the sole way to
  interact with the game.
