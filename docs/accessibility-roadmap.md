# Accessibility — Roadmap & Standing Checklist

> Status: **in progress planning**. Unlike the other docs in this folder, this isn't a
> single future feature — it's a cross-cutting standard the app should hold itself to
> as new features (including everything else in `docs/*.md`) get built. See
> `CLAUDE.md` for the binding convention that points here.

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

1. **No `aria-live` regions anywhere in the app.** Oche is fundamentally a
   live-updating scoring interface — the status line, current score, bust/win state,
   and achievement flashes (`showAchievement()`) all update via JS with nothing
   announced to a screen reader. A screen-reader user gets no non-visual signal that a
   turn was entered, a leg was busted, or a checkout was hit. This is likely the
   single biggest gap in the app today — bigger in impact than the dartboard color
   issue, though more work to do well (need to decide *what* gets announced without
   being overwhelming — e.g. announce the result of `enterTurn()` and achievement
   flashes, not every intermediate dart tap).
2. **Color-only signals extend beyond the dartboard.** `docs/colorblind-mode-roadmap.md`
   scopes its fix to the interactive dartboard SVG and the live scoreboard's bust/win
   flashes and dart-class styling. The same red/green pairing also drives the
   **Pad-mode Double/Treble buttons** (`.multi button.m-d` / `.multi button.m-t` in
   `frontend/index.html`), which isn't in that doc's stated scope today. When
   colorblind mode is implemented, its palette swap should cover the Pad buttons too,
   not just the SVG board and scoreboard — one consistent palette, not two fixes.
3. **No contrast audit has been performed.** The palette (`--muted`, `--gold`,
   `--danger`, etc. against `--board`/`--surface`/`--surface-2`) hasn't been checked
   against WCAG AA contrast ratios (4.5:1 normal text, 3:1 large text/UI components).
   Needs an actual audit (e.g. against the rendered computed colors), not an
   assumption that a dark theme with gold/cream accents is fine by default.
4. **`default_scoring_input` is framed as an aesthetic choice today, not an
   accessibility one.** Worth explicitly deciding that Pad mode *is* the app's
   accessible input path (vs. the dartboard SVG), and considering whether the
   Settings copy/documentation should say so directly, so an admin setting up the app
   for a low-vision or motor-impaired player knows which mode to pick.
5. **Small type sizes on secondary UI text** (11-12px field labels, chips, stat
   captions throughout `index.html`) haven't been checked against a minimum
   readable-size guideline. Likely acceptable since none of it is essential
   content and zoom isn't disabled (see baseline above), but worth a deliberate
   look rather than an assumption once the higher-priority items above are done.

## Suggested priority order

1. **Colorblind-friendly palette** (`docs/colorblind-mode-roadmap.md`) — very low
   complexity, CSS-only, already scoped (with the Pad-button expansion from gap 2
   above folded in). Good first item.
2. **Contrast audit** — no code risk, just measurement; produces a concrete punch
   list if anything fails.
3. **`aria-live` announcements** for turn results, bust/win, and achievement flashes —
   real but contained JS work, no data model changes.
4. **Accessible-input-path framing for `default_scoring_input`** — likely just a
   documentation/UI-copy change once decided, no new mechanism needed.
5. **Type-size pass** — lowest priority; revisit after the above, since none of the
   small text is essential/blocking content today.

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
