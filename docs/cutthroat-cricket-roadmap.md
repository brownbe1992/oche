# Cut-throat Cricket — Design Roadmap

> Status: **design phase, not started.** Picks up the variant explicitly
> deferred when Cricket v1 shipped (`docs/game-modes-roadmap.md`, "Cricket
> variant scope for v1: standard cricket only — cut-throat deferred to
> later"). This doc exists so that deferral finally has a tracked home.

## Goal

Standard Cricket's evil twin: marks work identically (3 to close a number),
but once you've closed a number that an opponent hasn't, further hits score
points **onto every opponent who still has it open** — and the winner is
whoever closes everything with the **lowest** score. Same board, same
skills, opposite incentive: in standard Cricket you feed your own total; in
cut-throat you punish stragglers. With 3+ players it's a genuinely
different (and nastier) game, which is exactly why people ask for it.

## Design

- **Not a new `game_type`** — a `config.variant: 'standard' | 'cutthroat'`
  flag on `game_type='cricket'`, the same "one game, a mode flag, scoped
  queries" relationship Checkout Trainer's Freeform/Blitz split and X01's
  H2H/practice split already use. Marks, closing, custom target sets, the
  scoring pad, and the mark-tracking half of the engine are untouched.
- **Engine delta** (`evaluateVisitCricket()`, `frontend/scoring.js`): when
  the shooter has a number closed and at least one opponent doesn't, the
  points that standard Cricket credits to the shooter are instead added to
  **each opponent with the number still open** (classic rules: every open
  opponent gets the full points, not a split). Win check flips to "all
  numbers closed AND lowest score" — including the same known tie edge
  standard Cricket documents (a tie at close is not a win; the leg
  continues), kept consistent rather than solved differently in one
  variant.
- **Data model**: none of this is per-shooter-storable — a single visit can
  score onto several players at once, and `turns` rows belong to the
  shooter. Cut-throat therefore leans on what Cricket already does:
  `turns.scored` stays **the points this visit generated** (attributed to
  the shooter's row), and each player's *received* total is derived at read
  time by replaying visits — which the client already does live and the
  saved-games replay (`docs/archive/saved-games-roadmap.md`) will do on resume.
  Confirm during implementation that no existing Cricket stat silently
  assumes `SUM(scored)` = "points benefiting the shooter"; MPR and
  marks-based stats are unaffected either way, points-based ones need a
  variant scope.
- **UI**: a Standard/Cut-throat toggle in the Cricket options section (New
  Game step 3), config-stamped like every other session option; the live
  scoreboard and scoring screen already show per-player points — only the
  "lower is better" sort/highlight flips, driven off the config flag.
- **Stats/badges**: cut-throat games count toward Cricket's mark-based
  stats (MPR, 9 Marks) unchanged; points-based leaderboards stay scoped to
  standard (a low score meaning "good" would corrupt them). One flavor
  badge: 🔪 **Stone Cold** (win a 3+ player cut-throat game without
  receiving a single point).

## Accessibility, security, and testing considerations

- **Accessibility**: "points were scored ONTO you" is a new event class —
  announce it ("Ben puts 57 on Alaina and Cam.") and mark it icon+text on
  the scoreboard, not just a number ticking up.
- **Security**: no new endpoint or credential surface; the existing
  Cricket write path carries a config flag. Cricket's deliberate exemption
  from the SEC-22 scored/darts consistency check applies equally here (the
  points depend on whole-game mark state) — document, don't "fix".
- **Testing**: committed engine tests are the heart of it — points landing
  on every open opponent (2- and 3-player cases), no points once all
  opponents close, the lowest-score win check, the tie edge, and at least
  one full-game replay proving derived totals match live totals (the
  saved-games contract).

## Open questions for whoever picks this up

- 2-player cut-throat is legal but nearly equivalent to standard with
  inverted totals — allow it (simplest) or nudge toward 3+ in the setup
  blurb? Lean: allow, note in the blurb that it shines with 3+.
- Do cut-throat wins share Cricket's existing win-based badges (Whitewash,
  Comeback Kid (Cricket))? Whitewash's "opponent closed nothing" reads the
  same; Comeback Kid's points-deficit logic inverts — likely needs a
  variant-aware condition or a scope-out. Decide during implementation,
  with tests either way.
