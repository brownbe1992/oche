# Schedule: Next Session

> **Archived** — all 3 items below are done (each already marked "— done" in its own
> heading). This was a session punch list, not a design roadmap; its content is fully
> covered by `docs/achievements-badges-roadmap.md` and
> `docs/archive/simultaneous-achievements-roadmap.md`. Kept here only for the
> historical to-do framing. See `docs/existing-app-prep-roadmap.md`'s Roadmap
> sequencing table for the live completion tracker across all roadmaps.

A short to-do list of what to tackle next, written up so a session can pick these up
directly without re-deriving context. Full design detail for each item lives in the
roadmap doc it's linked from — this file is just the punch list and the order to
work through it in.

## 1. Achievement notifications + shareable cards: explain what happened, show the count — done

Full design: `docs/achievements-badges-roadmap.md` → "Planned: notifications and
shareable cards should explain the badge and show the count."

- Add a plain-language explanation line to the live achievement overlay (both
  `frontend/index.html` and `frontend/display.html`), reusing `BADGE_INFO[type].desc`
  — no new copy to write, it already exists for the Badge Case tooltips.
- Add the same explanation, plus a "how many times" count, to the shareable moment
  card (`buildMomentCard()`).
- The award API response already returns `{ newlyEarned, count }` — this is
  frontend-only plumbing to actually use that field instead of discarding it.
- Watch for the timing issue called out in the roadmap doc: the celebration fires
  before the network round-trip resolves today, on purpose (no delay) — the count
  needs to patch in a moment later, not block the initial celebration.

## 2. Double Trouble badge — done

Full design: `docs/achievements-badges-roadmap.md` → Precision & Skill.

Check out on a visit where the **last two darts thrown were both doubles** (any
numbers, not necessarily matching each other) — e.g. a 2-dart D5/D12 finish or a
3-dart miss/D9/D10 finish. Dart 1 of a 3-dart visit is irrelevant and doesn't need to
be a double — a total miss, a single, or a treble on dart 1 all still qualify as long
as darts 2 and 3 are both doubles; only the last two darts are checked. A single-dart
double-out checkout does **not** qualify — "consecutive" requires at least two.

- Detection: `_d.length>=2 && _d[_d.length-2].isDouble && _d[_d.length-1].isDouble` on
  the winning visit, alongside the existing Hat Trick check in `enterTurn()`.
- Needs an icon/label/description added to `ACH_LABELS` (both `index.html` and
  `display.html`) and `BADGE_INFO` (Badge Case), plus an `awardRecurringBadge()` call
  — follow the exact same pattern as Hat Trick end to end.

## 3. Busted Maximum badge — done

Full design: `docs/achievements-badges-roadmap.md` → Novelty & Humor.

Throw three treble 20s (a genuine 180) but the visit still busts — a real maximum
that didn't count. More specific than the existing Ton-titled to Nothing (which
catches any 100+ bust generically), so this check needs to run *before* that one in
`enterTurn()`'s if/else chain so the more specific case wins.

- Detection: `_d.length===3 && _d.every(d=>d.sector===20 && d.mult===3) && ev.bust`.
- Same integration checklist as Double Trouble: `ACH_LABELS` in both frontend files,
  `BADGE_INFO`, `awardRecurringBadge()` call.

## Suggested order

Items 2 and 3 are small, self-contained, and follow an identical pattern to badges
already built — good warm-up work. Item 1 touches more surfaces (both achievement
overlays, the moment-card builder, and the async plumbing) and is worth doing once
per session rather than piecemeal, so building 2 and 3 first, then wiring their new
badges into item 1's improved notification format as part of the same pass, avoids
building the old plain notification for them and then immediately upgrading it.
