# Shanghai — Design Roadmap

> Status: **shipped (2026-07).** See "Implementation notes" at the bottom of
> this doc for exactly how each open question was resolved, and
> `REFERENCE.md` §31 for the full write-up.

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
- **Saved games** (`docs/archive/saved-games-roadmap.md`): position must be a pure
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
  `docs/archive/culture-badges-roadmap.md` is deliberately separate (same feat,
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

## Implementation notes

- **Tie after the final round**: built exactly per this doc's own lean —
  extra rounds repeating the final round's own number, matching Baseball's
  extra-innings precedent. `shanghaiRoundTarget(round, maxRounds)` caps at
  `maxRounds` rather than cycling back to 1, so `round 9` of a 7-round game
  still targets 7.
- **Miss-every-round elimination variant**: not built, per this doc's own
  "out of v1" lean. `config` has only `{rounds}` — no elimination toggle.
- **Cross-mode physical stats**: built per this doc's own lean — Shanghai
  darts count toward the global darts-thrown/heatmap aggregates exactly like
  Baseball's/Cricket's, no exclusion.
- **Ceiling correction (6× → 9×)**: this doc's own "Data model" section says
  "max legit visit = 6× the round number, and a Shanghai visit is exactly
  6×." That undersells it — three trebles of the round's own number is a
  real, legal, non-Shanghai visit worth **9×** the round number, more than a
  Shanghai's 6×. The consistency guard actually shipped enforces 9× (derived
  naturally by summing each dart's own contribution, not a hardcoded
  constant), not the 6× the draft text describes. A correctness fix over the
  doc's literal wording, not a deviation from its actual intent — see
  `REFERENCE.md` §31's own note on this, and the same class of correction
  Dead Man Walking's own `docs/open-roadmap-items.md` entry independently
  made over its own pitch doc.
- **`turns.leg_won` — refined from the doc's own wording**: this doc's "Data
  model" section says `leg_won=1` goes "on the Shanghai (or on the
  final-round winner's closing visit)." The parenthetical half of that
  wasn't built as literally stated — the final-round winner's closing visit
  is NOT always the same turn as the round-ending visit (exactly Baseball's
  own situation, where the round-ending player and the actual point leader
  aren't always the same person), so flagging "the closing visit" would
  sometimes flag the WRONG player's turn. What shipped instead:
  `turns.leg_won=1` is set ONLY for a genuine instant Shanghai (truly
  self-referential to one visit); a final-round win decided by point totals
  is never flagged on any turn, and `getShanghaiWonLegs()` (`backend/db.js`)
  derives the winner for those legs at query time by comparing `SUM(scored)`
  totals per player, exactly `getBaseballWonLegs()`'s own derivation. This
  is a correctness fix over the doc's literal wording, same class as the
  6×/9× correction above — committed regression coverage in
  `backend/test/db.shanghai-stats.test.js` proves the "leader by points, not
  by whoever's turn ended the round" case explicitly.
- **Rounds default/long-form**: built exactly as specified — `config.rounds`
  defaults to 7, with a 20-round long-form toggle on the New Game setup
  screen (`setShanghaiRounds()`).
- Everything else matches this doc's design: `evaluateVisitShanghai()` in
  `frontend/scoring.js`, unit-tested first (scoring per multiplier, off-number
  darts scoring zero, Shanghai detection including the "two singles and a
  treble is NOT a Shanghai" negative case, instant win mid-game, final-round
  tie behavior, extra-round capping); the SEC-25-style consistency guard in
  `addTurn()`; `rebuildShanghaiState()` for saved-game position, reused
  identically by the write-time guard and `resumeGame()`; a `renderers.shanghai`
  per-round score grid on the live scoreboard (row labels show the round's
  own TARGET NUMBER, not the round index, so the grid stays screen-reader-
  meaningful once extra rounds begin); the instant-Shanghai moment fires
  `announce()` plus an icon+text 🀄 banner, never color/confetti alone; stat
  bubbles (Points/Round, Shanghais Thrown, Win Rate, Games Played, Darts
  Thrown, Best Round), Personal Bests, a 3-board Home leaderboard set (Points
  Per Round, Shanghais Thrown, Most Shanghai Wins), and the 🀄 Shanghai!
  badge. No lifetime-points/Shanghais-thrown ladder was added — this doc's
  own "if play shows appetite" framing left it optional, and v1 shipped
  without it. Full write-up: `REFERENCE.md` §31; committed tests in
  `backend/test/scoring.test.js`, `backend/test/db.shanghai-stats.test.js`,
  and `backend/test/db.turn-consistency-guard.test.js`.
