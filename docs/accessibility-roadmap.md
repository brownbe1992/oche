# Accessibility — Roadmap & Standing Checklist

> Status: **in progress** (items 1 and 3 of 5 done — colorblind-friendly palette, and
> `aria-live` announcements for turn results + achievement flashes). Unlike the
> other docs in this folder, this isn't a single future feature — it's a cross-cutting
> standard the app should hold itself to as new features (including everything else in
> `docs/*.md`) get built. See `CLAUDE.md` for the binding convention that points here.

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

1. ~~**Colorblind-friendly palette**~~ ✅ **Done** (`docs/archive/colorblind-mode-roadmap.md`) —
   very low complexity, CSS-only, shipped with the Pad-button expansion from gap 2
   above folded in.
2. **Contrast audit** — no code risk, just measurement; produces a concrete punch
   list if anything fails.
3. ~~**`aria-live` announcements**~~ ✅ **Done** for `frontend/index.html` — see gap 1
   above. `display.html` intentionally not yet covered.
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
