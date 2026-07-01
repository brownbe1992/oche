# Ghost Opponent — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

## Goal

Practice against a replay of one of your own past legs — racing your prior self
dart-by-dart — using data the app already has in full fidelity. Solo practice today
just tracks a score; this turns it into a head-to-head experience without needing a
second live person.

## Why this is achievable without simulation

The `darts` table already records every individual dart (sector, multiplier, order)
for every turn ever played. A "ghost" doesn't need any statistical modeling or AI —
it can simply be an **exact historical leg replayed dart-by-dart** on a virtual second
player's turn, interleaved with the live player's own throws. This is dramatically
simpler than generating a plausible simulated opponent, and it's honest about what
it's showing: literally "can you beat your best leg average from last month," not an
approximation of one.

## Design

- **Ghost selection**: pick a past leg to race against — likely surfaced from
  existing data already computed for Personal Bests (best leg average) or simply a
  browsable list of past legs by date/score. The chosen leg's turns become the
  ghost's fixed script.
- **Gameplay integration**: functionally a two-player Practice-mode-style match where
  one "player" is the live human and the other is driven by iterating through the
  ghost leg's pre-recorded turns automatically (no input needed, just advancing on a
  timer or immediately after the live player's turn) — reuses the existing
  turn-advancement and scoreboard rendering with minimal change, since the ghost is
  just another `game.players[]` entry whose "throws" are read from a script instead of
  tapped in.
- **Live scoreboard integration**: the ghost's card on `/display` could show
  something like "Ghost (Jan 12 leg)" instead of a real player name, so it's clearly
  distinguishable from a real opponent.
- **Recording semantics**: should a ghost match record real stats for the live
  player (it's still real darts, thrown by a real person) — the recommendation is
  yes, since the human's own darts are exactly as real as any practice-mode leg, tag
  the game itself as practice, and simply don't record anything for the "ghost" side
  (no `game_players` row for a non-existent player, or a special sentinel that's
  excluded from stats entirely).

## Open questions for whoever picks this up

- Should the ghost play at exactly the historical pace (real time between throws,
  for a more authentic "racing" feel) or advance as fast as the live player throws
  (simpler, avoids an awkward waiting period if the historical leg had slow visits)?
- Is there value later in a non-exact "statistical ghost" (a simulated opponent whose
  throws are drawn from a player's average/variance rather than one specific
  historical leg) — more flexible, but a genuinely different and harder feature than
  the literal-replay version described here; worth keeping as a distinct future
  enhancement rather than conflating the two.
