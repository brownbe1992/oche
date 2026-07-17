# Halve-It — Design Roadmap

> Status: **core game shipped (2026-07); the custom target editor is a
> separate, still-open item.** See "Implementation notes" at the bottom of
> this doc for exactly how each open question was resolved, and
> `REFERENCE.md` §32 for the full write-up of what shipped. This doc stays
> in `docs/` (not archived) because `docs/open-roadmap-items.md` tracks the
> custom target editor mentioned in "Design" below as its own,
> independently-scoped, Not-started item sourced from this same doc — per
> CLAUDE.md's archiving rule, a doc only moves to `docs/archive/` once every
> item split out from it is Done.

## Goal

The classic pressure game, H2H (2+) or solo. A fixed sequence of targets is
announced up front (a common set: 20, 16, double 7, 14, treble 10, 17,
Bull). Each round, every player throws 3 darts at that round's target:
every dart that hits it adds its value to your score — but if **all three
miss, your score is halved**. Highest total after the last round wins. The
halving rule is what makes it dramatic: a leader can lose half their game
in one bad visit, which keeps every player in it until the end.

## Design

- **Game type**: `halve_it` in `KNOWN_GAME_TYPES` + a `GAME_TYPES` plugin —
  same fixed-round, per-visit shape as Baseball/Shanghai; those are the
  structural templates (New Game entry, round derivation from the player's
  own prior turn count, live-scoreboard round grid).
- **Targets**: `config.targets` — an ordered array where each entry is a
  sector plus an optional required ring (e.g. `{sector:20}`, `{sector:7,
  ring:'double'}`, `{sector:10, ring:'treble'}`, `{sector:25}`). Ships with
  the classic 7-round set as the default plus a "customize targets" editor
  reusing the Cricket custom-numbers picker pattern. Ring-restricted rounds
  count only that ring; unrestricted rounds count any ring of the sector at
  its face value.
- **The halving rule and the data model** — the one genuinely interesting
  wrinkle: `turns.scored` is validated 0–180 and can't go negative, so a
  halving is **not stored as a score value; it's derived**. A visit stores
  `scored` = points gained (0 when everything missed), and the running
  total replays as `running = ceil(running / 2)` whenever a round's visit
  scored 0 — hitting the target always scores > 0, so `scored === 0` is
  unambiguous. Reuse `turns.bust = 1` to mark the halved visit for cheap
  querying, the same column-repurposing precedent Doubles Practice and
  guided Around the Clock already set (documented in REFERENCE.md's `bust`
  row). Halves round **up** (odd 25 → 13), flagged below as tunable.
- **Saved games** (`docs/archive/saved-games-roadmap.md`): running totals replay
  deterministically from `scored`/`bust` per the rule above — position is a
  pure function of turns; state it explicitly in the implementation.
- **Consistency guard**: like Baseball/Shanghai (SEC-25 precedent), the
  server derives the round's target from the player's prior turn count and
  rejects a `scored` the target can't produce (max = 3 × treble of the
  sector, or 150 for Bull rounds).
- **Stats/badges**: bubbles (games, win rate, avg final total, times
  halved), Personal Bests (best final total, best single round), a Home
  leaderboard, and flavor badges: 🪓 **Halved at the Death** (get halved on
  the final round and still win), 🛡️ **No Half Measures** (win without ever
  being halved).

## Accessibility, security, and testing considerations

- **Accessibility**: a halving is a major state change — `announce()` it
  ("Halved — Ben drops to 47.") and show icon + text, not a red flash
  alone; the target sequence needs a visible "this round: Treble 10" label,
  not just position in a grid.
- **Security**: the consistency guard above; no new credential surface.
- **Testing**: committed engine tests (ring-restricted vs open rounds, the
  scored-0-means-halve derivation incl. the rounding rule, replay of a
  full game's running totals, tie handling) — the halving math is exactly
  what CLAUDE.md's every-new-calculation rule exists for.

## Open questions for whoever picks this up

- **Rounding**: halve rounds up (25 → 13) or down (25 → 12)? House rules
  vary; up is friendlier and recommended, but it's one constant either way.
- **Reaching 0**: halving can never reach 0 with round-up (1 → 1), but with
  round-down a 1 → 0 death spiral exists — one more reason for round-up.
- The classic target set varies by pub — is one good default plus the
  custom editor enough, or are 2–3 named presets ("Classic", "All
  trebles", …) worth shipping? Lean: default + custom editor only for v1.

## Implementation notes

- **Rounding**: built exactly per this doc's own recommendation — halves
  round **up** (`Math.ceil(total/2)`). Committed tests prove both the 1→1
  floor and a 0→0 no-op (an early-round miss with nothing built up yet).
- **Reaching 0**: confirmed by test — round-up never produces a permanent
  0 the way round-down could.
- **Custom target editor**: **not built in v1**. The classic 7-round default
  (`HALVE_IT_DEFAULT_TARGETS` in `frontend/scoring.js`) ships; the "customize
  targets" editor this doc's own Design section describes (reusing Cricket's
  custom-numbers picker pattern) is deliberately deferred and tracked as its
  own separate, independently-scoped item on `docs/open-roadmap-items.md` —
  per CLAUDE.md's discipline for a v1/v2 split, rather than silently dropped
  or claimed done. This is why this doc stays in `docs/` instead of moving to
  `docs/archive/` — see the status line at the top.
- **Tie-breaking after the final round**: this doc's own Design/Open-questions
  sections never explicitly addressed what happens on a tie — filled using
  the established Baseball/Shanghai precedent instead: extra rounds, repeating
  the final round's own target, rather than a shared loss or any other outcome.
  `halveItRoundTarget()` caps at the target list's own length for exactly this.
- Everything else matches this doc's design: `evaluateVisitHalveIt()` in
  `frontend/scoring.js`, unit-tested first (unrestricted/ring-restricted
  targets, the halving derivation, final-round/tie/extra-round behavior);
  `turns.bust` repurposed as the halving flag and `turns.scored` as the gain
  only, exactly as specified; the SEC-25-style consistency guard (checking
  `bust` for consistency with the derived gain rather than rejecting it, since
  it's a legitimate flag here, not an X01/Shanghai-style illegal state);
  `rebuildHalveItState()` for saved-game position, reused identically by the
  write-time guard and `resumeGame()`; a per-round chalkboard grid on the live
  scoreboard (row labels show the round's own target label, cells show the
  running total with a ½ marker on a halved round, per the accessibility
  note above); stat bubbles (games, win rate, avg final total, times halved,
  darts thrown, best round), Personal Bests (best final total, fewest darts
  to win, win streak, recent/lifetime form — the standard 5-field shape every
  other fixed-round game type in this app uses, "best single round" living in
  the stat bubbles instead per Baseball's own Best Inning precedent), a
  2-board Home leaderboard set (Highest Final Total, Most Halve-It Wins), and
  the two flavor badges (🪓 Halved at the Death, 🛡️ No Half Measures). One
  genuine technical wrinkle beyond this doc's own anticipation: the running
  total's order-dependence (halving interspersed with additions) means it
  can't be read back with a single `SUM(scored)` aggregate the way every
  other fixed-round game type's stats can — `_replayHalveItLegTotals()`
  (`backend/db.js`) replays the raw turns once instead, the same
  "nothing pre-aggregated" philosophy applied to a case where a straight SQL
  aggregate genuinely can't do the job. Full write-up: `REFERENCE.md` §32;
  committed tests in `backend/test/scoring.test.js`,
  `backend/test/db.halve-it-stats.test.js`, and
  `backend/test/db.turn-consistency-guard.test.js`.
