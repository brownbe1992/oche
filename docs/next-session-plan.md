# Schedule: Next Session

A short to-do list of what to tackle next, written up so a session can pick these up
directly without re-deriving context. Full design detail for each item lives in the
roadmap doc it's linked from — this file is just the punch list and the order to
work through it in.

## 1. Achievement notifications + shareable cards: explain what happened, show the count

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

## 2. Double Trouble badge

Full design: `docs/achievements-badges-roadmap.md` → Precision & Skill.

Check out on a visit where every dart thrown was a double (any numbers, not
necessarily matching each other or the finishing double) — e.g. a 2-dart D5/D12
finish or a 3-dart D16/D9/D10 finish. Same shape as Hat Trick (N-of-a-kind dart type
on the closing visit) applied to doubles instead of trebles.

- Detection: `_d.every(d=>d.isDouble)` on the winning visit, alongside the existing
  Hat Trick check in `enterTurn()`.
- Needs an icon/label/description added to `ACH_LABELS` (both `index.html` and
  `display.html`) and `BADGE_INFO` (Badge Case), plus an `awardRecurringBadge()` call
  — follow the exact same pattern as Hat Trick end to end.

## 3. Busted Maximum badge

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
