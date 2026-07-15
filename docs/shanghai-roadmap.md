# Shanghai — Design Roadmap

> Status: **design phase, not started.**

## Goal

The classic pub game, playable H2H (2+) or solo practice. A game runs a
fixed sequence of rounds — round 1 targets the number 1, round 2 the number
2, and so on. Each visit's 3 darts only score on **that round's number**
(single = 1×, double = 2×, treble = 3× the number, same as Baseball's
run-counting shape). Highest total after the last round wins — **unless
someone throws a Shanghai**: single, double, AND treble of the round's
number in one visit (any order), which wins the game instantly, mid-round.
That sudden-death moment is the whole personality of the game and maps
perfectly onto the existing achievement/moment-card machinery.

## Design

- **Game type**: `shanghai` in `KNOWN_GAME_TYPES` + a `GAME_TYPES` client
  plugin — structurally a sibling of Baseball (fixed-round sequence, only
  the round's number scores, per-visit evaluation), which is the direct
  template for nearly everything here, including its New Game entry
  (`NEW_GAME_MODE_OPTIONS`, contexts `['practice','h2h']`).
- **Rounds**: `config.rounds` — default **1–7** (the common pub format;
  short, snappy), with a 1–20 long-form option on the setup screen. Stored
  in config so neither is hardcoded, same as Baseball's `innings: 9`.
- **Engine**: a pure `evaluateVisitShanghai(player, darts, game)` in
  `frontend/scoring.js` — points = Σ(multiplier × round number) over darts
  hitting the round's number; `shanghai` flag when the visit's three darts
  hit exactly {single, double, treble} of it. Committed unit tests per
  CLAUDE.md's every-new-calculation rule, mirroring Baseball's 16-case
  suite.
- **Data model**: nothing new — `turns.scored` = points this visit,
  `turns.leg_won=1` on the Shanghai (or on the final-round winner's closing
  visit), round derived from the player's own prior turn count exactly the
  way Baseball's inning already is. That derivation should get the same
  server-side `enforceConsistency` treatment Baseball earned in SEC-25 —
  a hostile `scored` that the round's number can't produce must be
  rejected, not trusted (max legit visit = 6× the round number, and a
  Shanghai visit is exactly 6×).
- **Saved games** (`docs/saved-games-roadmap.md`): position must be a pure
  function of recorded turns — it is (running totals + round number derive
  from the turn sequence). State that in the implementation, don't leave it
  implicit; savability is part of any new mode's definition of done now.
- **Live scoreboard**: a `renderers.shanghai` entry — a per-round score grid
  (players × rounds), the natural display shape.
- **Stats/badges**: stat bubbles (games, win rate, points/round, Shanghais
  thrown), Personal Bests (best game total, best single round), a Home
  leaderboard set, and the obvious badges: 🀄 **Shanghai!** (win by
  Shanghai — recurring), plus a lifetime-points or Shanghais-thrown ladder
  if play shows appetite. The X01 **Shanghai-visit** badge in
  `docs/culture-badges-roadmap.md` is deliberately separate (same feat,
  different game) — don't merge them.

## Accessibility, security, and testing considerations

- **Accessibility**: the instant-win moment needs an `announce()` call and
  an icon+text banner, never color/confetti alone; the round grid needs row/
  column headers a screen reader can navigate.
- **Security**: the SEC-25-style scored-vs-darts consistency check above;
  no new credential surface.
- **Testing**: committed engine tests (scoring per multiplier, off-number
  darts scoring zero, Shanghai detection incl. "two singles and a treble is
  NOT a Shanghai", instant win mid-game, final-round tie behavior), plus
  db-level stat-formula tests once the stat surface is defined.

## Open questions for whoever picks this up

- **Tie after the final round** with no Shanghai — sudden-death extra round
  (Baseball's extra-innings precedent) or shared loss? Lean: extra rounds
  repeating the final number, matching Baseball.
- Should a **miss-every-round elimination** variant ("hit the round's
  number at least once or you're out") ship as a config toggle, or stay
  out of v1? Lean: out of v1.
- Does Shanghai count toward any cross-mode physical stats (darts thrown,
  heatmap)? Lean: yes — real thrown darts, same as Baseball/Cricket, no
  hypothetical-dart exclusion needed.
