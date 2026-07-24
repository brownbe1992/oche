# The Gauntlet — Design Roadmap

> Status: **shipped 2026-07.** See "Implementation notes" near the end of
> this doc for what matched the design below exactly and what was decided
> along the way. Full write-up: `REFERENCE.md` §27.

## Goal

A solo endurance drill that removes choice entirely. **20 stations**, one
per board number, played in a **fixed clock-adjacency order** —
20 → 1 → 18 → 4 → 13 → 6 → 10 → 15 → 2 → 17 → 3 → 19 → 7 → 16 → 8 → 11 →
14 → 9 → 12 → 5 — so no two consecutive stations sit anywhere near each
other on the board. At each station, 3 darts must each complete a specific
task **in order**: dart 1 the single, dart 2 the triple, dart 3 the
double. Missed tasks earn **Scars**; a station with 2 gets one repeat
attempt, a station with all 3 missed becomes a **Deep Scar** (counts
double). Total Scars across all 20 stations lands on a result tier
(Unmarked through The Gauntlet Wins). Runs ~15 minutes — meant as a
pre-session warm-up whose real value is the **Scar Map**: a per-station
weakness log that accumulates across sessions.

## How this differs from every existing mode (don't conflate)

- **Doubles Practice** is the closest structural precedent (solo,
  per-dart evaluation against a fixed sequence of ring/sector targets),
  but its sequence is a simple ascending walk through the doubles and it
  has no scoring/tally beyond a hit rate — Gauntlet's fixed non-adjacent
  order, three-different-rings-per-station structure, retry rule, and
  Scar tally are all new on top of that shared shape.
- **The Pressure Chamber** (`docs/archive/pressure-chamber-roadmap.md`) is also a
  fixed-round solo/H2H drill with a scored outcome per round, but its
  round sequence is **seeded and variable** (a different card each run)
  and its modifiers are the whole point. Gauntlet's station order is a
  **single hardcoded constant**, identical on every run, forever — there
  is no seed-generation machinery to build here at all, which is worth
  stating plainly given how central that machinery was to the Pressure
  Chamber doc.
- **Bob's 27** (`docs/archive/practice-ladders-roadmap.md`, Part A) is the closest
  precedent for "one bad round can end/scar the run and a repeat-adjacent
  concept exists," but Bob's 27 has no retry mechanic at all (a missed
  double just costs you) and only one target type (doubles), not three
  per station.
- This is **not** a new way to play out a leg of X01/Cricket — a
  standalone drill, same footing as Halve-It/Shanghai/Pressure Chamber,
  and gets its own doc.

## Design

### Station order — a hardcoded constant, no generation needed

```
GAUNTLET_STATION_ORDER = [20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5]
```

Fixed, identical every run — unlike Pressure Chamber's per-game seeded
card sequence, there is nothing here to derive from `game.id`; every
Gauntlet run in the app plays literally the same 20-station path. This
also means the Scar Map (below) can compare station 7 in session 1
against station 7 in session 40 with zero ambiguity about what "station
7" means — the sequence never varies to begin with.

### At each station — three positional tasks, no partial credit

Unlike Pressure Chamber's "best of 3 darts" sector grading, a Gauntlet
station is graded **per dart position**, strictly in throw order — a new
pure `evaluateGauntletStation(stationNumber, darts)` in
`frontend/scoring.js`:

- **Dart 1** must be the station's **single** — hit iff
  `sector === stationNumber && multiplier === 1` (either inner or outer
  single band both count, same as every other "single" concept in this
  app — the zone/miss-band distinction from
  `docs/archive/dartboard-zone-tracking-roadmap.md` is a finer-grained
  concern this doesn't need).
- **Dart 2** must be the station's **treble** — hit iff `is_treble` and
  `sector === stationNumber` (the `darts` table's own generated column,
  reused directly, no reimplementation).
- **Dart 3** must be the station's **double** — hit iff `is_double` and
  `sector === stationNumber`.
- **No re-matching across positions.** If dart 1 happens to land the
  treble instead of the single, that doesn't "count early" for dart 2's
  task — the pitch's own language ("one dart per target," tasks listed
  "in order") reads as strictly positional, and softening it into a
  best-fit match across all 3 darts regardless of throw order would blunt
  the exact re-targeting pressure the design is built around. Flagged
  again in Open questions since it's an inference, not stated outright.
- **Misses this attempt** = however many of the 3 positional tasks failed
  (0–3) — this raw count is what gets stored (see Data model).

### The Scar / repeat rule

| Misses this attempt | Outcome |
|---|---|
| 0 | Clean pass — advance |
| 1 | 1 Scar — carry it, advance |
| 2 | **Must repeat the station once** — a fresh 3-dart attempt at the same station, graded the same way; whatever that retry's own miss count is (0–3) becomes the **final, authoritative** result for that station. No second repeat regardless of the retry's own outcome, even if the retry also comes back as 2 or 3 misses — "once only" per the pitch. |
| 3 | **Deep Scar** directly, no repeat offered — mark it, move on |

A repeat is a genuinely fresh attempt (a new `turns` row, 3 new darts),
not an edit to the original — the original attempt's darts stay recorded
for real physical-stat purposes (heatmap, treble/double rate — see Data
model), only its *Scar contribution to the run's tally* gets superseded.

### Composure... no — Scar tally, and the result tiers

Total Scars = `Σ` over the 20 stations of the **final** (post-any-repeat)
miss count, **doubled for any station whose final result is 3 misses**
(a Deep Scar) — derived at read time from raw per-station miss counts,
never pre-multiplied and stored, the same "store the raw number, derive
the special-case scaling" shape Halve-It's halving rule already
established for the same reason (an unmodified `scored` column can't
hold a doubled value that isn't really what happened dart-for-dart).

| Scars | Result |
|---|---|
| 0–5 | Unmarked |
| 6–12 | Scarred but Standing |
| 13–20 | Bloodied |
| 21–30 | Broken Down |
| 31+ | The Gauntlet Wins |

Computed at read time from the derived total, never stored — same
precedent as Pressure Chamber's Composure Rating and every other tiered
result in this app.

### Data model

Reuses the existing per-dart-turn shape; only **existing** additive
columns are needed, nothing new:

- `gauntlet` added to `KNOWN_GAME_TYPES`, `contexts: ['practice']` only —
  this is explicitly solo (no H2H framing in the pitch, unlike Pressure
  Chamber), one leg per run, station order fixed program-wide so
  `games.config` needs no field for it at all (contrast Pressure
  Chamber's `config.seed`/`config.rounds` — Gauntlet needs neither).
- **`turns.target_score`** (already exists, already range-checked,
  1–170 comfortably covers 1–20) stores **which station number** this
  attempt was for. This is the one place Gauntlet can't fully copy
  Pressure Chamber's "derive the round from prior-turn-count" trick —
  because a repeat attempt adds an *extra* turn row without advancing to
  the next station, turn-count-since-game-start no longer maps 1:1 to
  position in `GAUNTLET_STATION_ORDER`. Storing the station explicitly
  sidesteps needing that derivation at all, and is exactly what the Scar
  Map's `GROUP BY target_score` needs regardless.
- **`turns.scored`** stores the raw miss count for *that specific attempt*
  (0–3) — always non-negative, well inside the existing 0–180
  validation, same "store the plain number" reuse Bob's 27 and the
  Checkout Ladder already lean on for their own per-round numbers.
- **No new column for "was this a repeat."** Whether a station was
  repeated is derivable from row count: more than one `turns` row sharing
  the same `(game_id, target_score)` means a repeat happened, and the
  **later** row (by `id`/`created_at`) is the final, authoritative one —
  the earlier (2-miss) attempt's darts stay in the table for physical
  stats but its `scored` value is excluded from the Scar tally once a
  later attempt for the same station exists.
- **These are real physical throws** — full participation in heatmaps,
  treble rate, double rate, dart-pace, everything — the same conclusion
  Bob's 27 and the Checkout Ladder both reached (contrast Checkout
  Trainer's hypothetical, never-actually-thrown darts, which are
  deliberately excluded from those same aggregates). No
  `NOT_HYPOTHETICAL_DARTS`-style exclusion needed here.

### Consistency guards (server-side)

Two, both in the SEC-25 spirit of "the server re-derives the expected
shape and rejects a submission that couldn't have produced it":

1. **Sequence guard** — the server tracks how many *distinct* stations
   this game has reached a final result for (count of distinct
   `target_score` groups with a settled outcome) and only accepts a new
   attempt's `target_score` if it matches the next entry in
   `GAUNTLET_STATION_ORDER` — a client can't skip ahead or submit
   stations out of order.
2. **Repeat-count guard** — at most **2** `turns` rows may ever exist for
   a given `(game_id, target_score)` pair, and a second row is only
   accepted if the first row's `scored` was exactly 2. Without this, a
   client could keep resubmitting a bad station indefinitely until it got
   lucky, defeating "once only" entirely — this is the one place in this
   design where the honor-system framing Pressure Chamber flagged for its
   own honesty mechanic doesn't apply; the repeat rule *is* fully
   server-enforceable, unlike a physical honesty declaration, so it
   should be.
3. **Scored-range guard** — `scored` for this game type must be 0–3;
   reject anything else (the existing 0–180 X01-shaped range check is far
   too permissive for this game type on its own, same reasoning that
   drove SEC-25's Baseball-specific tightening).

### The Scar Map — the actual point of the game

A `getGauntletScarMap(playerName)` query: for every completed Gauntlet
game, take each station's **final** miss count (post-repeat, per the Data
model rule above) and aggregate **per station number** across every run
that player has ever done — average Scars at station 7, average at
station 20, etc. Rendered as a 20-cell visualization keyed by board
number, the direct structural sibling of the existing dartboard heatmap
(`getDartHeatmap()`, `docs/archive/dartboard-zone-tracking-roadmap.md`)
but colored by **average Scar severity** rather than hit frequency — same
"a map of the board, shaded by a per-number metric" visual language the
Player Profile already uses elsewhere, reused rather than invented fresh.
This is the feature the whole pitch is really selling ("after a month,
the map of your weaknesses will be impossible to ignore") — worth
building early, not as an afterthought stat bubble.

### Stats, Personal Bests, leaderboard

- **Stat bubbles**: runs completed, average total Scars per run, clean-
  station rate (% of stations finished with 0 misses on their final
  attempt), Deep Scar rate, retry-rate (% of stations that needed the
  repeat).
- **Personal Best**: **lowest** total Scars in a run — an ascending-is-
  better metric, same shape X01's `fewestDartsCheckout` and Baseball's
  `fewestDartsToWin` already use (`MIN()`, not `MAX()`), just applied to a
  brand-new metric rather than darts. Worth calling out explicitly since
  most of this app's "best run" Personal Bests (Checkout Blitz's score,
  Bob's 27's final total) are *higher-is-better* — Gauntlet is the
  opposite direction, and the leaderboard query needs to sort ascending
  accordingly, not be copy-pasted from a descending one.
- **Home leaderboard**: lowest-ever total Scars, one row per player, their
  single best run — a peak (trough) value, no minimum-attempts floor,
  same reasoning as every other single-best-run board in this app.

### Achievements

Data-driven ladders off the existing `CHUCKIN_MILESTONE_LADDERS` engine —
lifetime runs completed, lifetime clean stations (0-miss final results),
longest streak of consecutive clean stations within one run. One-off
flavor badges: 💎 **Flawless Gauntlet** (an entire 20-station run with
zero Scars anywhere — the hardest single-session feat this mode has),
🥋 **Unmarked** (finish a run in the 0–5 tier), and 🩹 **Second Wind**
(pass a repeat attempt clean — 0 misses on the retry — after failing the
original with 2).

### No live-scoreboard sync needed

Same conclusion Checkout Trainer reached for the same reason: single-
device, solo, no second-screen `/display` broadcast required. There is a
live **in-progress display** during the run itself (current station
number, which of the 3 tasks is next, running Scar tally, the repeat
prompt when triggered) — that's ordinary single-page UI state, not a
`liveState`/`ALLOWED_LIVE_KEYS` cross-device sync concern.

### Saved games

A resumed run is fully reconstructable: current station = the first entry
in `GAUNTLET_STATION_ORDER` with no settled final result yet for that
`game_id`, running Scar tally = the derived sum described above — pure
functions of recorded turns, per `docs/archive/saved-games-roadmap.md`,
same as every other drill in this doc set.

## Accessibility, security, and testing considerations

- **Accessibility**: the current station number and which of the 3 tasks
  (single/treble/double) is next must be a persistent, always-visible
  text label, not just implied by a highlighted board region — a screen-
  reader user has no way to infer "task 2 of 3" from a highlighted sector
  alone. A Scar earned, a Deep Scar, and the repeat prompt are all state
  changes needing their own `announce()` call, icon + text, not a red
  flash alone (same standing rule every other new surface follows). The
  Scar Map visualization needs a text-table fallback/equivalent alongside
  the colored board graphic, matching the existing heatmap's own
  accessibility treatment.
- **Security**: the three consistency guards above (sequence, repeat-count,
  scored-range) are the real surface here — this game type is unusually
  exploitable without them, since "once only" and "in fixed order" are
  both rules a hostile client could otherwise trivially bypass by just
  submitting favorable turns directly. No new credential/token surface.
- **Testing**: `evaluateGauntletStation()`'s per-position grading (incl.
  the "no re-matching across positions" rule, and inner/outer single both
  counting), the repeat-supersedes-original derivation, the Deep-Scar-
  doubles-at-tally-time math, the full 20-station replay/read, and the
  result-tier thresholds — every one of these is new calculation, squarely
  under CLAUDE.md's "every new calculation gets a committed test" rule.
  The sequence/repeat-count server guards need their own tests too (reject
  an out-of-order station, reject a third attempt at one station).

## Suggested build order

1. `GAUNTLET_STATION_ORDER` constant + `evaluateGauntletStation()`,
   proven with unit tests before any UI exists.
2. Core loop: 20 stations, 3 darts each, no repeat rule yet — a bare
   playable run producing a raw per-station miss count.
3. The repeat rule (2 misses → one retry) + the sequence/repeat-count
   server guards.
4. Scar tally + Deep Scar doubling + the 5 result tiers.
5. Personal Best (lowest total Scars, ascending) + Home leaderboard.
6. **The Scar Map** — `getGauntletScarMap()`, reusing the existing
   dartboard-heatmap visual pattern with Scar severity as the shaded
   metric.
7. Stat bubbles (clean-station rate, Deep Scar rate, retry rate).
8. Achievement ladders + the 3 one-off badges.

## Open questions for whoever picks this up

- **Strictly positional grading vs. best-fit matching** — this doc
  defaults to strict throw-order (dart 1 can only ever satisfy the single
  task, even if it accidentally lands the double) since that's the
  plainest reading of "one dart per target," but a best-fit alternative
  (credit whichever dart actually landed each required ring, regardless
  of order thrown) is a real, gentler alternative worth explicit sign-off
  before building, since it changes the difficulty curve substantially.
- **Does a repeat's darts count toward the run's *physical* stats
  twice** (both the failed original and the retry), given both are real
  thrown darts? This doc assumes yes for heatmap/treble-rate purposes
  (every dart thrown is a real dart) while only the Scar *tally* uses the
  final attempt only — worth confirming that split reads as intuitive
  once it's actually played, not just on paper.
- **Tie/comparison semantics for the Scar Map** once a player has dozens
  of runs — average per station (this doc's default), most recent run
  only, or worst-ever per station (the "impossible to hide from" framing
  in the pitch leans toward surfacing worst-case, not a softened average)?
  Worth deciding by looking at real data, not guessed here.
- **Extending to H2H** (same fixed path, compare total Scars) is a natural
  future variant given the pitch's own solo framing never rules it out,
  but is explicitly out of v1 scope per "a solo endurance game" — noted
  here so it isn't silently assumed later.
- Exact ladder thresholds and the 3 one-off badges above are a first pass
  for playtesting, same "not final" caveat every other doc's numbers
  carry.

## Implementation notes (2026-07, shipped)

Built essentially as designed, following this doc's own suggested build
order end to end. The open questions above were resolved as follows:

- **Strictly positional grading** (this doc's own stated default) was
  adopted — `evaluateGauntletStation()` never re-matches a dart against a
  task other than its own throw-order slot.
- **A repeat's darts DO count toward physical stats twice** (both the
  failed original attempt and the retry are real recorded turns/darts —
  heatmap, treble rate, dart-pace, everything), while only the Scar tally
  itself uses the final (retry's) result — exactly as this doc guessed.
- **The Scar Map averages per station across every COMPLETED run** (this
  doc's stated default) rather than most-recent-run or worst-ever. Worth
  revisiting once there's real multi-session data to look at, per this
  doc's own note.
- **Extending to H2H** stayed out of scope, as planned.
- Exact ladder thresholds (lifetime runs 5/25/100/250; lifetime clean
  stations 50/250/1,000/2,500; per-run streak 5/10/15) and the 3 one-off
  badges (💎 Flawless Gauntlet, 🥋 Unmarked, 🩹 Second Wind) shipped as a
  first pass, per this doc's own "not final" caveat — worth revisiting once
  real play data shows whether they're paced right.

Everything else matches this doc's design: `gauntlet` game type, solo-only,
`legsPerSet`/`setsPerGame` forced to 1 (a run IS the game — it always
completes after all 20 stations settle, unlike Checkout Ladder/Doubles
Practice's perpetual shape); the fixed `GAUNTLET_STATION_ORDER` constant, no
generation machinery; the Scar/repeat rule exactly as specified (2 misses →
one repeat, 3 → an immediate Deep Scar, no repeat); the Deep-Scar-doubles-
at-tally-time derivation; the 5 result tiers; the 3 consistency guards
(collapsed into one shared `rebuildGauntletState()`-based comparison for the
sequence + repeat-count guards, plus a separate scored-range check); the
5-bubble stat set, ascending-is-better Personal Best, ascending Home
leaderboard, and the Scar Map with its text-table accessibility fallback;
no live-scoreboard sync. One bug found and fixed along the way, unrelated to
this doc's own design: `docs/archive/practice-ladders-roadmap.md`'s
Checkout Ladder (item 22, shipped just before this one) had never actually
been wired into the Player Profile's stat-bubble-key-map list, silently
blanking its bubbles — see `REFERENCE.md` §27's own note. Full write-up:
`REFERENCE.md` §27; committed tests in `backend/test/scoring.test.js`,
`backend/test/db.turn-consistency-guard.test.js`, and
`backend/test/db.gauntlet-stats.test.js`.
