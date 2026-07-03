# Colorblind-Friendly Mode — Design Roadmap

> **Archived** — fully shipped, kept here for design-rationale history. See
> `docs/existing-app-prep-roadmap.md`'s Roadmap sequencing table for the live
> completion tracker across all roadmaps.

> Status: **✅ Done**. A single admin-toggled setting
> (`colorblind_mode`, Settings → Accessibility) switches the app to a blue/orange
> palette — verified across every spot identified below: the dartboard SVG rings and
> bull, the Pad-mode Double/Treble buttons, entered-dart slot borders, win/bust status
> text, the dart-analytics chart, and the live scoreboard's checkout flash overlays
> and dart-class colors. Confirmed end-to-end with a real running server and browser
> screenshots. Most elements were covered by overriding the shared `--red`/`--green`
> (and `--bust`) CSS variables in one place; a handful of hardcoded rgba/hex tints
> (not variable-based) needed individual overrides, called out inline in the code.
>
> This was the first concrete item under the broader `docs/accessibility-roadmap.md`
> checklist — see that doc for other accessibility gaps identified alongside this one.

## Goal

A genuine, currently-unaddressed accessibility gap: the interactive dartboard and its
SVG rendering (`buildDartboard()` in `frontend/index.html`) use red/green to
distinguish the double and treble rings from the single beds — a classic
colorblind-unfriendly color pairing (red-green color vision deficiency is the most
common form of colorblindness). A player with red-green colorblindness may struggle
to visually distinguish treble from double rings on the interactive board.

## Design

- **A Settings toggle** ("Accessibility" section, or folded into an existing
  visually-adjacent section) switching the ring/multiplier colors to a colorblind-safe
  palette — blue/orange is the standard accessible substitute for red/green, and
  should extend consistently to every place the app currently uses red/green
  semantically: the interactive dartboard SVG, the **Pad-mode Double/Treble buttons**
  (`.multi button.m-d`/`.multi button.m-t` in `frontend/index.html` — identified during
  the accessibility audit as in-scope too, not just the SVG board), the live
  scoreboard's bust/win flash overlays (`.flash.bust`/`.flash.shot` in `display.html`),
  and the dart-class styling on the live scoreboard's thrown-dart display
  (`.dart.t`/`.dart.d` in `display.html`). One consistent palette swap across all of
  these, not a fix scoped to the SVG board alone.
- Since the multiplier is also conveyed via other means already (single/double/treble
  buttons, the "T"/"D" prefix on dart labels), color isn't the *only* signal today —
  but it's the primary one on the interactive dartboard specifically, where sector
  color is currently the main visual cue for which ring was tapped.
- This is a purely additive CSS/palette change — no data model or backend involvement
  at all, and low risk of regressing the existing default look.

## Open questions for whoever picks this up

- Should this be a single alternate palette, or should it follow the existing
  scoreboard-layout pattern of being a small named set of options (e.g. supporting
  more than one type of color vision deficiency, like deuteranopia vs. protanopia vs.
  tritanopia) — likely overkill for v1; one well-chosen alternate palette is probably
  sufficient.
- Worth auditing the rest of the app (Home page leaderboards, achievement colors) for
  other red/green-as-the-only-signal instances while this is being built, rather than
  scoping it to just the dartboard.
