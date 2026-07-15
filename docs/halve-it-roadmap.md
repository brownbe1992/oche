# Halve-It — Design Roadmap

> Status: **design phase, not started.**

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
- **Saved games** (`docs/saved-games-roadmap.md`): running totals replay
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
