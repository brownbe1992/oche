# UI Overhaul — Design Roadmap

> Status: **design phase pending**. This roadmap covers a comprehensive reorganization
> of the player pages and overall UI architecture. The first step is to complete a
> detailed design plan before implementation work begins.

## Goal

Reorganize and modernize the player pages to improve navigation, information hierarchy,
and user experience. This work will address structural concerns in the current page
layout and establish a foundation for scalable UI patterns going forward.

## Current scope

This roadmap is focused on **player page reorganization** — the primary surface where
players review their stats, achievements, and game history. Secondary surfaces and the
overall navigation model are secondary to this work.

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

- What specific pain points or limitations in the current player pages are motivating
  this overhaul (information overload, poor mobile experience, navigation friction)?
- Should the redesign accommodate new features not yet shipped, or is it purely
  a structural reorganization of existing information?
- How do game-type toggles (X01, Cricket, Doubles, etc.) and per-type stats fit into
  the reorganized layout?
- Does the redesign need to maintain backward-compatibility with existing URLs/bookmarks,
  or is it acceptable to change player page URLs as part of the restructuring?
