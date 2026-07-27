# UI Overhaul — Design Roadmap

> Status (2026-07): **the audit is done; the design plan is not.** The measurements
> and screenshots below replace this doc's original "what pain points are motivating
> this?" open question with evidence. The three findings that were *accessibility*
> rather than layout have already been fixed and shipped separately — see
> `docs/accessibility-roadmap.md`, "Applied: the Player Profile's heading outline and
> scope announcements". What remains open is the layout/hierarchy redesign itself.

## Goal

Reorganize and modernize the player pages to improve navigation, information hierarchy,
and user experience. This work will address structural concerns in the current page
layout and establish a foundation for scalable UI patterns going forward.

## Current scope

This roadmap is focused on **player page reorganization** — the primary surface where
players review their stats, achievements, and game history. Secondary surfaces and the
overall navigation model are secondary to this work.

## What the audit actually found (2026-07)

Measured rather than assumed, on a seeded database (5 players, 80 games, 164 legs)
at two real viewports — a 390x844 phone and a 1180x820 tablet in landscape. This is
the evidence the design plan should be built on, and it answers this doc's own first
open question below.

| | phone (390) | tablet (1180) |
|---|---|---|
| Scroll height | 2704px | 2482px |
| Screens of scroll | **3.2** | **3.0** |
| DOM nodes | 1117 | 1117 |
| Visible buttons | 34 | 34 |

**1. The layout does not use width at all.** The profile renders as a fixed ~740px
column, centred. At 1180px that leaves ~37% of the viewport as empty black on either
side, and the tablet saves 0.2 screens of scroll over the phone — three times the
width buys essentially nothing. The tablet screenshot is the phone screenshot with
margins. This is the single biggest structural finding, and it is the same shape of
problem the live-scoreboard redesign found on `/display`: measure the real screen
first, and the wasted space is obvious.

**2. Four stacked scoping controls before any content.** Header stat strip → Stats /
Player Settings tabs → Overall / H2H / Practice tabs → a "choose a game mode" select
→ (then, inside the stats) Today/Week/Month/Year/All time/Custom buttons. Five
levels, in four different widget idioms. A reader has to hold all of them to know
what any number on the page is actually scoped to.

**3. The same statistics appear twice, at different scopes, adjacent.** The header
strip shows "68.0 X01 AVERAGE" and "1,807 TOTAL DARTS THROWN"; the bubble grid
immediately below it shows "68.0 THREE-DART AVERAGE" and "931 DARTS THROWN". The
1,807/931 split is correct and documented (lifetime vs mode-scoped — the one
deliberate non-equality in `backend/test/db.metric-history-parity.test.js`), but
presented like this it reads as one of them being wrong.

**4. Nine visually identical collapsed accordions, with no priority order.** Badge
Case, Around the World Progress, Gauntlet Scar Map, Top Checkouts, Dart Analytics,
Household Rating, Tournaments, Leagues, Practice — Legs Thrown, all closed, all the
same weight, with one *expanded* section (X01 — Games & H2H) interleaved among them
for no stated reason. Meanwhile the heatmap (~350px) and the coaching insights are
fixed open above them. There is no principle governing what is open, what is closed,
or what order any of it comes in — which is the "information hierarchy" problem in
one screenshot.

**5. Empty states carry full weight.** "0 Big Fish" and "0 9-Darters" occupy the same
prominence as the two real numbers beside them.

### Already fixed (the accessibility findings)

Three defects from the same audit were not layout questions and did not wait for
this design phase — a page having no headings is broken regardless of how it is
eventually laid out. Shipped and pinned by the verify-ui `profile-a11y` check:

- 21 section titles were styled `<div>`s, so the page had **no heading outline** —
  no jump-by-heading on the app's longest screen. Now an `<h2>` name plus `<h3>`
  sections, verified to change the rendered layout by zero pixels.
- The three scope controls **announced nothing** when they replaced the page's
  entire contents. They now use the app's existing `#sr-announcer`.
- Ten 🎯 Drill buttons all shared **one accessible name**. Each now names its score.

### What the audit did NOT find

Worth recording, so the redesign does not go looking for problems that are not
there: keyboard support on the tab strips is already correct (a roving-tabindex
WAI-ARIA tablist with Arrow/Home/End, `playerTabKeydown()`), the page carries 80
elements with explicit roles, and no button on it is unnamed. The profile is not
neglected — it is dense and flat.

## Design phase (step 1)

Before any implementation begins, complete a comprehensive design document that covers:

- Information hierarchy and layout principles for player pages
- Section organization (stats, achievements, game history, etc.)
- Navigation and tab/section structure
- Responsive design considerations
- Accessibility implications (keyboard nav, color signals, ARIA labels)
- Proposed component/pattern changes
- Sequencing of implementation phases (what ships first, what depends on what)

This design document will inform all subsequent implementation steps and be cross-referenced
by `docs/open-roadmap-items.md` for tracking.

## Accessibility, security, and testing considerations

Per `CLAUDE.md`'s standing conventions:

- **Accessibility**: The player page redesign is an ideal time to audit the current
  design against `docs/accessibility-roadmap.md`'s checklist and bake accessibility
  into the new layout from the start — keyboard navigation, focus order, color-only
  signals, and screen-reader announcements all need front-and-center review as the
  new structure is designed.
- **Security**: No new credential/token surface — reuses existing player-auth model.
  No security implications anticipated.
- **Testing**: UI changes themselves aren't typically unit-testable, but the stats
  and data underlying the player page should continue to have committed test coverage
  per `docs/testing-and-observability-roadmap.md`.

## Open questions for whoever picks this up

- ~~What specific pain points or limitations in the current player pages are
  motivating this overhaul?~~ **Answered by the audit above** — the width is unused,
  the scoping stack is four deep, the stats are duplicated at two scopes, and nine
  collapsed sections carry no priority order. Confirm these are the right ones to
  design against before the plan is written.
- Should the redesign accommodate new features not yet shipped, or is it purely
  a structural reorganization of existing information?
- How do game-type toggles (X01, Cricket, Doubles, etc.) and per-type stats fit into
  the reorganized layout?
- Does the redesign need to maintain backward-compatibility with existing URLs/bookmarks,
  or is it acceptable to change player page URLs as part of the restructuring?
