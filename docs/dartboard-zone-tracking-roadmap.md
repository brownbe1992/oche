# Dartboard Zone & Miss-Area Tracking — Design Roadmap

> Status: **designed, not started.** Tracked as its own item on
> `docs/open-roadmap-items.md`. No scoring behavior changes — this is purely a
> data-granularity and heatmap-visualization enhancement. Expanded (2026-07) to
> also generalize the dartboard-shaped heatmap itself — today exclusive to Just
> Chuckin' It — to X01, Cricket, and Doubles Practice, since the `darts` table
> and the SVG geometry are already shared across every game type (see "Beyond
> Just Chuckin' It" below), and expanded again (2026-07) to replace the flat
> "Miss" button in Dartboard mode with a two-band (near/far) positional miss
> ring outside the double, so misses land on the heatmap too, not just hits
> (see "Miss-area tracking" below), plus a "Bounce Out" toggle (available in
> both input modes) for darts that struck the board but didn't stay, tracked
> separately from both hits and misses so they don't distort either (see
> "Bounce-out tracking" below).

## Goal (as requested)

> "For the dartboard score entry, specifically where it relates to the dartboard
> heatmap - can we treat hitting above the treble differently than hitting it
> below the treble? For example, if I hit a 20 in either area, they're both 20s,
> but I'd want the heat map to treat them as two different areas of the 20. Same
> goes for the rest of the numbers."

A real dartboard number wedge has **two physically distinct single-scoring
regions**: the outer single (between the treble ring and the double ring — the
region right below the double, often the harder "safety" area to aim for
deliberately) and the inner single (between the bullseye and the treble ring —
the much larger region closer to the center). Both score identically (the
sector's face value, `multiplier=1`), so the game's scoring logic has never
needed to tell them apart. But a heatmap is about *where the darts are actually
landing*, and today the app can't answer "does this player tend to miss the
treble long (outer single) or short (inner single)?" — both collapse into one
undifferentiated "single" bucket per number.

## Why this is buildable: the geometry already exists

`frontend/index.html`'s `buildDartboard()` (the real "👻 Dartboard" tap-to-score
input mode, `dartboardMode`) already draws these as two separate SVG paths per
number — an inner annulus (`R.bullOut` → `R.trebleIn`) and an outer annulus
(`R.trebleOut` → `R.doubleIn`) — because the board has to *look* like a real
dartboard. Both paths currently call the exact same handler with the exact same
arguments: `onclick="throwDartBoard(${num},1)"`. The tap position already tells
the app which region was hit; that information is just discarded today. This is
a genuinely low-risk feature precisely because the hard part (correct dartboard
geometry, one annulus per zone) already shipped for the Chuckin heatmap
(`buildChuckinHeatmap()`, which reuses the exact same radii) — this only adds a
label to data that's already being distinguished visually.

## Scope: Dartboard tap-mode only, not Pad mode

**Pad mode has no zone concept and never will** — it's a Multiplier button
(Single/Double/Treble) plus a Number button, with no geometric tap position at
all. Only `dartboardMode` taps can know which physical single region was hit.
This is a deliberate, permanent scope boundary, not a v1/v2 split:
- Darts entered via Pad mode always record zone as unknown (`NULL`).
- Darts entered via Dartboard mode for a single hit always record a real zone
  (`'inner'` or `'outer'`).
- Double and treble hits never have a zone at all (there's only one region
  each) — the column stays `NULL` for those regardless of input mode.

This also means precision arrives gradually: a player who always uses Dartboard
mode gets a fully zone-resolved heatmap from day one; a Pad-mode player's
heatmap stays exactly as coarse as it is today, with no regression either way
(see "Handling unknown zone" below).

## Schema

Per `CLAUDE.md`'s "new contexts get their own table" convention — this is
**not** that situation. A dart's zone is an intrinsic attribute of the dart
itself (like `sector`/`multiplier`/`thrownAt`), not a new cross-cutting context
that tags onto `games`. It belongs as a new nullable column directly on the
existing `darts` table, the same way `thrownAt` already does:

```sql
ALTER TABLE darts ADD COLUMN zone TEXT;   -- 'inner' | 'outer' | NULL
```

`NULL` covers three legitimate cases at once: doubles, trebles, and any single
(from either input mode) thrown before this feature existed or via Pad mode.
No `CHECK` constraint beyond what application code already validates on write
(mirroring how `sector`/`multiplier` aren't `CHECK`-constrained today either —
validated in `addTurn()`/`recordTurn()`, not the schema).

## Backend

- **`addTurn()`/the turn-recording write path** (`backend/db.js`): accepts an
  optional `zone` per dart alongside the existing `sector`/`multiplier`, stores
  it verbatim (no server-side inference — the client is the only party that
  ever knows which annulus was tapped).
- **`getChuckinHeatmap(playerName, mode)`**: change the `GROUP BY` to
  `d.sector, d.multiplier, d.zone` instead of `d.sector, d.multiplier`, so a
  single number's inner/outer counts arrive as separate rows.
- **`getDartAnalytics(name)`'s `topSectors`**: naturally inherits the split too
  once `zone` is included in its own grouping — "S20 (inner)" and "S20 (outer)"
  become distinct entries in the top-15 list, for players who want that
  precision in the flat Coaching Insights view as well as the geometric one.
- **Explicitly unaffected — do not touch**: `getGhostLegScript()`/ghost replay
  (a dart replays by its scored value, zone is irrelevant to outcome), Around
  the World's 63-outcome definition (inner single and outer single are still
  the same *scoring outcome* — "a single 20" — for completionist-tracker
  purposes; splitting that would be a genuine game-rule change, not a heatmap
  enhancement, and is explicitly out of scope here), any badge/achievement
  trigger condition (none of them care about zone), and `getFullDatabaseExport()`
  needs no new top-level key since `zone` just rides along as a new column on
  the existing `darts` rows already included there.

## Frontend

- **`buildDartboard()`**: the two `oc(num,1)` calls for the inner/outer single
  annuli become `oc(num,1,'inner')` and `oc(num,1,'outer')` respectively —
  `throwDartBoard(sector, mult, zone)` threads the third argument through to
  `throwDart()`, which stamps it onto the dart object pushed to `game.darts`
  (alongside the existing `sector`/`mult`/`thrownAt`). The double/treble/bull
  annuli pass no zone (stays `undefined`/`null` — there's nothing to
  distinguish).
- **`DB.recordTurn()`'s darts payload**: adds `zone: d.zone || null` per dart,
  same shape as the existing `dartNo`/`sector`/`multiplier`/`thrownAt` fields.
- **`buildChuckinHeatmap(cells)`**: today's `heat(num,1)` call feeds *both* the
  inner and outer single annuli identically (`frontend/index.html` ~7349,
  ~7351). Once the backend returns zone-scoped rows, this becomes
  `heat(num,1,'inner')` for the `R.bullOut`→`R.trebleIn` path and
  `heat(num,1,'outer')` for the `R.trebleOut`→`R.doubleIn` path — each shaded
  independently, exactly as requested. Tooltips split accordingly ("S20 (inner
  half): N hits" / "S20 (outer half): N hits").

### Handling unknown zone (Pad-mode / pre-migration darts)

The simplest, least-misleading default: **an unknown-zone single hit shades
neither the inner nor the outer path directly** — it's tracked as its own
"zone unspecified" bucket, shown as a **subtle third visual state** (e.g. a
faint diagonal hatch overlay across both single regions, distinct from both the
"never hit" dark state and the heat-scale gold) rather than silently splitting
it 50/50 into a number that was never actually observed at that precision. A
sector that's only ever been played in Pad mode still reads as "singles hit
here, precision unknown" rather than falsely implying an even inner/outer
split. This keeps the visualization honest as data quality improves gradually
per-player rather than requiring a backfill or a hard cutover.

## Beyond Just Chuckin' It: the same heatmap for X01, Cricket, and Doubles Practice

**The zone data is captured for every game type automatically, at no extra
cost** — `darts` is the one universal per-dart table every game type writes
into (X01, Cricket, Doubles Practice, and Chuckin all go through the same
`addTurn()`/dart-recording path), so the `zone` column change above already
captures inner/outer data from a Dartboard-mode X01 or Cricket turn the moment
it ships. Nothing in "Schema"/"Backend"/"Frontend" above needs to change for
this — the only gap is that **today, only Just Chuckin' It has anywhere to
*display* it as a geometric heatmap.** X01 and Cricket only get `topSectors`
(the flat top-15 list in Coaching Insights); there's no dartboard-shaped
picture for them at all. That's a real, separate gap worth closing in the same
pass, since the hard part — correct dartboard SVG geometry, one annulus per
zone — is already built and would otherwise just sit Chuckin-only for no
reason once it exists.

### Backend: generalize, don't duplicate

`getChuckinHeatmap(playerName, mode)` becomes `getDartHeatmap(playerName,
gameType, mode)`, scoped via the existing `_scope({mode, gameType})` helper —
the same helper every other per-game-type stat query in `backend/db.js`
already uses, including its `KNOWN_GAME_TYPES` validation, so this is a
one-function generalization, not new plumbing:

```js
function getDartHeatmap(playerName, gameType, mode) {
  const p = getPlayer(playerName);
  if (!p) return [];
  const scope = _scope({ mode, gameType });
  return db.prepare(`
    SELECT d.sector AS sector, d.multiplier AS multiplier, d.zone AS zone, COUNT(*) AS hits
    FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? ${scope}
    GROUP BY d.sector, d.multiplier, d.zone
  `).all(p.id);
}
// Chuckin's existing call sites keep working unchanged:
const getChuckinHeatmap = (playerName, mode) => getDartHeatmap(playerName, 'chuckin', mode);
```

**API surface**: add `GET /api/players/dart-heatmap?name=&gameType=&mode=`
alongside the existing `GET /api/players/chuckin-heatmap?name=&mode=` (kept
as-is, unchanged response shape, for backward compatibility — REFERENCE.md's
§12 API surface only ever grows here, nothing is removed or renamed out from
under existing callers).

### Frontend: one reusable renderer, four trigger points

`buildChuckinHeatmap(cells)` (`frontend/index.html` ~7316) is already
gameType-agnostic in its actual drawing logic — nothing in it reads
`game.gameType` or hardcodes "Chuckin" beyond the function name and the SVG's
`aria-label` string. It becomes `buildDartHeatmap(cells, {ariaLabel})`, with
the caller supplying the label ("Dartboard heatmap of every Just Chuckin' It
dart thrown" vs "...every X01 dart thrown" vs "...every Cricket dart thrown"
vs "...every Doubles Practice dart thrown"). The DOM ids
(`chuckin-heatmap-section`/`chuckin-heatmap-body`) become generic
(`dart-heatmap-section`/`dart-heatmap-body`), and `loadChuckinHeatmap()`'s
`if(playerGameType !== 'chuckin'){ section.hidden = true; return; }` early-out
(the only actual gameType-specific gate in the whole feature) is replaced by
`loadDartHeatmap()` firing for whichever game type's Player Profile tab is
currently active, calling `/api/players/dart-heatmap?...&gameType=${gt}`. The
section shows on all four game-type tabs (X01, Cricket, Doubles Practice,
Chuckin) instead of Chuckin exclusively — same "Dartboard Heatmap" section
title and placement in `chartSection`'s shared markup (~`frontend/index.html`
3877-3882), just no longer gated to one tab.

### Per-mode fit and caveats

- **X01**: identical value proposition to Chuckin's existing heatmap — no
  caveats, this is the most natural fit besides Chuckin itself.
- **Doubles Practice**: arguably the *single best* application of zone data of
  any mode. A player drilling one specific double target directly benefits
  from seeing exactly where their misses cluster — inner single (aimed too
  shallow), outer single (aimed too far), wrong number entirely, or the
  opposite side of the board — in a way Chuckin's freeform practice can't
  target as precisely, since Doubles Practice always has one declared goal.
- **Cricket**: classic Cricket only plays 15-20 + Bull, so most of the board
  stays permanently dark/unlit on a Cricket-only heatmap — expected and fine
  (Chuckin's heatmap already shows the same natural sparsity for numbers a
  player rarely throws at; this isn't a bug to work around). Custom Cricket's
  in-play numbers vary per game and aren't fixed, so the heatmap doesn't try
  to know or highlight "which 7 were in play this time" — it just aggregates
  every dart ever thrown in Cricket games, in-play or not, the same
  unweighted way `topSectors` already does today.
- **Complexity impact**: this stays the same **Low-Medium** tier on
  `docs/open-roadmap-items.md` — it's a copy-and-parameterize of code that
  already works end-to-end for Chuckin, not new design or new geometry.

## Miss-area tracking: a positional miss ring outside the double

### Goal (as requested)

> "Add miss areas to the heatmap as well. Rather than hitting the miss button
> (which should remain on the pad scoring page but be removed from the
> dartboard scoring page), there should be what is essentially a miss grid
> outside of the dartboard and clicking/tapping in that spot should register
> the miss as so on the heatmap."

Today a miss is scored identically no matter where it actually landed: tap the
flat **Miss** button (`#board-miss-btn`, present in both Dartboard and Pad
mode) and the dart is recorded as `sector=0, multiplier=1` with no positional
information at all. That's the correct, and only possible, behavior in **Pad**
mode — a Multiplier + Number button grid has no geometric position to report,
a miss is just "not any of the numbers." But in **Dartboard** mode the player
is already tapping a specific point on/near a picture of a real board; forcing
them through the same generic button throws away exactly the kind of
positional detail the zone work above is built around. A player who
consistently misses low-and-right of the 20 wedge, or high past the top of the
board, should be able to see that on their heatmap the same way they can now
see inner-vs-outer single tendencies.

### Design: extend the existing wedge geometry outward, don't invent a new grid

`buildDartboard()` already tiles the board into 20 angular wedges via
`DB_SECTORS`/`DEG` — the natural, lowest-effort "miss grid" is simply **the
same 20 wedges, extended radially outward past the double ring**, into two new
outer annuli. This keeps the existing polar coordinate math (`xy(r, deg)`/
`annulus(r1, r2, s, e)`) doing all the work — no new grid system, no
rectangular overlay that would look bolted-on next to a circular board.
Tapping the outer-ring segment nearest the "20" wedge means "missed the board,
but was headed for roughly where 20 is" — exactly the kind of directional
information a real coach would note ("you keep missing 20 wide left").

**Two concentric bands, not one** (per follow-up request): a **near** ring
immediately outside the double (a close call — the dart grazed the double
wire or landed just past it) and a **far** ring beyond that (a proper miss,
nowhere close). These are meaningfully different misses to a player working
on their finishing: consistently near-missing a double is a precision problem;
consistently far-missing means something else went wrong with the throw
entirely. Concretely, `buildDartboard()` gains two more rings beyond `R.bg`
(today the board's outermost background circle, `r=248`, inside a
`viewBox="0 0 500 500"` that barely contains it): `R.missNear` (e.g. `270`)
and `R.missFar` (e.g. `310`), with the SVG's `viewBox` enlarged to fit both
(e.g. `"0 0 660 660"`, board recentered). Each of the 20 angular wedges gets
two more clickable paths — `annulus(R.bg, R.missNear, s0, e0)` and
`annulus(R.missNear, R.missFar, s0, e0)` — styled distinctly from the scoring
rings (a muted, clearly "off-board" texture/color, with the near ring visually
closer in tone to the board and the far ring more clearly "outside," so the
two read as different at a glance without needing to consult a legend) —
`onclick="throwDartBoard(0,1,null,${num},'near')"` and `...,'far'` respectively.
**The flat `#board-miss-btn` is removed from the Dartboard-mode markup
entirely** (both the static `screen-game` HTML and `renderGameShell()`'s
rebuilt copy) — every miss in Dartboard mode now has to land somewhere in one
of the two rings, no ungated fallback. **Pad mode's Miss button is
untouched** — `applyDartMode()` already only shows `#board-miss-btn` when
`dartboardMode` is true, so Pad mode's copy of the button (rendered by
`renderPad()`, a separate code path) is unaffected by removing the
Dartboard-mode one.

### Schema: two new, separate columns — not the same `zone` field

A miss's angular position is a genuinely different concept from a hit's
inner/outer zone (one describes *which ring of a number was hit*, the other
describes *which number's direction a total miss was closest to*), and they're
mutually exclusive per dart (a miss has `sector=0`, so it can never also carry
a meaningful `zone`). Reusing one column for both would make every query have
to know which meaning applies for a given row. Two new nullable columns keep
each concept unambiguous — one for direction, one for how close:

```sql
ALTER TABLE darts ADD COLUMN miss_zone INTEGER;    -- 1-20 (nearest wedge), NULL otherwise
ALTER TABLE darts ADD COLUMN miss_depth TEXT;       -- 'near' | 'far', NULL otherwise
```

`NULL` covers every non-miss dart, every Pad-mode miss (no positional data
possible, exactly like Pad-mode singles and `zone`), and every miss recorded
before this feature existed — the same "precision arrives gradually, never
retroactively guessed" posture as `zone` above. `miss_zone` and `miss_depth`
are always set or unset together (a Dartboard-mode miss always taps a specific
ring-and-wedge combination, never one without the other).

**`sector`/`multiplier` stay exactly `0`/`1` for every miss, board-mode or
not** — this is the load-bearing compatibility decision. Every place that
already means "a miss" by checking `sector===0` keeps working completely
unchanged: `evaluateVisit()`'s scoring math, the "Where'd It Go?" badge
(`_d.every(d=>d.sector===0)`, `frontend/index.html` ~5743), `getGhostLegScript()`
replay, `dartLabel()`/`dartValue()` in `scoring.js`, and `getFullDatabaseExport()`.
`miss_zone`/`miss_depth` are purely additive metadata riding alongside an
otherwise-identical miss row, the same relationship `zone` has to a hit row.

### Backend

- **`addTurn()`**: accepts optional `missZone`/`missDepth` per dart (only
  meaningful when `sector===0`), stores both verbatim — same "client is the
  only party that knows the tap position" reasoning as `zone`.
- **`getDartHeatmap(playerName, gameType, mode)`** (the generalized function
  from "Beyond Just Chuckin' It" above): `GROUP BY` extends once more to
  include `d.miss_zone, d.miss_depth`, so `SELECT ... FROM darts d WHERE
  d.sector=0` rows arrive pre-bucketed by wedge *and* how close they were.

### Frontend

- **`throwDartBoard(sector, mult, zone, missZone, missDepth)`**: the extra
  parameters thread through to `throwDart()`, stamped onto the dart object
  pushed to `game.darts` exactly like `zone` (only `zone` or
  `missZone`+`missDepth` is ever set on a given dart — a hit can't have a miss
  wedge, a miss can't have an inner/outer zone).
- **`DB.recordTurn()`'s darts payload**: adds `missZone: d.missZone || null`
  and `missDepth: d.missDepth || null` per dart, same shape as `zone`.
- **`buildDartHeatmap(cells)`**: gains the same two outer rings
  `buildDartboard()` now draws, each shaded independently by `heat(0, 1, null,
  wedgeNum, 'near')` / `heat(0, 1, null, wedgeNum, 'far')` (reusing the
  existing single-hue heat scale — brighter means more misses landed in that
  direction/depth) — so the *pattern* of a player's misses (which side of the
  board, which numbers, how close) becomes visible at a glance, not just a
  single aggregate "N misses" count sitting off to the side.

### Per-mode fit

No caveats beyond what "Beyond Just Chuckin' It" already covers — a miss is a
miss regardless of game type, so the miss ring appears on the same heatmap
section for X01, Cricket, Doubles Practice, and Chuckin uniformly, with no
mode-specific behavior.

## Bounce-out tracking: hit the board, didn't stick

### Goal (as requested)

> "There should also be a bounce out option/button. Something that hit the
> board, would have counted, but it either bounced out or fell out for one
> reason or another. Those should be counted as misses but for heatmap
> purposes be treated differently somehow."

This is a **third, distinct dart outcome**, not a variant of the miss-ring
work above: a genuine miss never touched a scoring area at all (the ring
tracks *where it went instead*); a bounce-out **did** strike a real number/
ring — the player saw exactly where — but didn't stay in the board long enough
to count, so it scores nothing, same as a miss, but its position is real board
geometry, not a guess at a direction. Conflating the two would make "close
misses near the double" (the miss ring's near band) indistinguishable from
"actually hit the double and fell back out," which are very different pieces
of coaching information — one is an aim problem, the other is often a dart
weight/grip/board-tension problem entirely unrelated to where it was aimed.

### Design: reuse every existing tap target, add one toggle

A bounce-out's position is captured exactly the same way a real hit's
position already is — sector, multiplier, and (in Dartboard mode) inner/outer
`zone` — because the player is tapping the same spot on the board they'd tap
for a hit that stuck. The only new interaction is a way to say "that one
didn't count": a **"Bounce Out" toggle**, placed alongside the existing
Single/Double/Treble multiplier row (`#multi-row`), the same interaction shape
players already know from that row. Unlike Single/Double/Treble it's not
mutually exclusive with them — a bounce-out can happen off *any* multiplier
ring (`Treble` + `Bounce Out` then tap 20 means "that looked like a T20 before
it bounced out") — so it behaves as an independent toggle (`bounceOutMode`, a
plain boolean global paralleling `mult`), auto-resetting to off after each
dart is committed (the same "one-shot, not sticky" behavior the multiplier row
itself does **not** have today, but a bounce-out toggle should, since forgetting
to turn it back off would silently zero out every real hit afterward — a much
worse failure mode than having to re-tap it occasionally). Available in
**both** Pad and Dartboard mode (this is not the miss-button's "board-only"
scope restriction — Pad mode already captures sector+multiplier for a normal
hit, so it can capture a bounce-out's position exactly as precisely as it
captures anything else; it just never gets `zone`, same as a Pad-mode hit).

### Schema: shadow columns, not a new outcome-type overhaul

The safest possible implementation, and the one this doc recommends: **a
bounced dart is stored in `sector`/`multiplier` (and `zone`, if applicable)
exactly as `0`/`1` — a completely ordinary miss row, indistinguishable from a
real miss to every existing consumer** — with the *intended* position captured
separately in shadow columns used only by the heatmap:

```sql
ALTER TABLE darts ADD COLUMN bounced INTEGER;         -- 1 = bounced/fell out, NULL otherwise
ALTER TABLE darts ADD COLUMN bounce_sector INTEGER;   -- where it actually struck, NULL otherwise
ALTER TABLE darts ADD COLUMN bounce_multiplier INTEGER;
ALTER TABLE darts ADD COLUMN bounce_zone TEXT;        -- 'inner' | 'outer' | NULL (board-mode only)
```

This is deliberately more conservative than it might need to be, and that's
the point: `dartValue(sector, mult)` already returns `0` for `sector===0`
(`frontend/scoring.js`), so storing a bounce-out as an ordinary `sector=0`
miss means **`evaluateVisit()`, every badge chain check (Hat Trick, Bullseye
Gauntlet, "Where'd It Go?", Busted Maximum, etc.), `getGhostLegScript()`
replay, and `getFullDatabaseExport()` all require zero code changes** — they
already handle this row correctly today, because it's shaped exactly like the
rows they already handle. A bounce-out flag living inside `sector`/`multiplier`
themselves (e.g. a special sentinel value, or an `outcome` enum column that
every scoring/badge check would need to learn about) would touch every one of
those call sites and reopen exactly the kind of scoring-correctness risk
`CLAUDE.md`'s testing discipline exists to prevent, for a feature that is, in
the end, purely a heatmap enhancement. Shadow columns get the same visual
payoff (the heatmap can plot a bounce-out at its true struck position) with
none of that risk.

### Backend

- **`addTurn()`**: accepts optional `bounced`/`bounceSector`/
  `bounceMultiplier`/`bounceZone` per dart, stores them verbatim alongside the
  real (`sector=0`) row — same pass-through-only reasoning as `zone`/
  `missZone`/`missDepth`.
- **`getDartHeatmap(playerName, gameType, mode)`**: a second, independent
  query (or a `UNION`) reading `bounce_sector`/`bounce_multiplier`/
  `bounce_zone` where `bounced=1`, returned as its own `bounces` array in the
  response rather than folded into the same `hits`/`misses` counts — the
  frontend needs to keep these visually and numerically separate (see below),
  so the API shape should make that separation obvious rather than requiring
  the caller to filter a mixed list.

### Frontend

- **New toggle button** in `#multi-row` (or immediately adjacent), wired to a
  `bounceOutMode` boolean exactly like `mult` — `throwDart()`/`throwDartBoard()`
  check it at the moment a dart is committed: if set, the dart is pushed with
  its real `sector`/`mult`/`zone` moved into `bounceSector`/`bounceMultiplier`/
  `bounceZone`, and the dart's *scoring* `sector`/`mult` forced to `0`/`1` (an
  ordinary miss) before it ever reaches `makeDartCore()`/`evaluateVisit()` —
  the substitution happens once, at the input layer, so nothing downstream
  needs to know bounce-outs exist as a concept at all.
- **`buildDartHeatmap(cells)`**: bounce-outs render as a **small distinct
  marker** (e.g. a bordered dot or a bounce icon) overlaid on the relevant
  hit region, **not** blended into that region's own heat-scale color — a
  wedge shouldn't look "hot" (implying lots of real scoring hits) just because
  bounce-outs cluster there, since by definition none of those actually
  counted. Tooltip text distinguishes them explicitly ("T20: 12 hits, 2
  bounce-outs").

### Per-mode fit

Available in every game type and both input modes, per "Design" above — no
mode-specific restrictions, unlike the miss ring (which is Dartboard-only
because only Dartboard mode has the geometry to place a *miss* directionally;
a bounce-out's position comes from the same sector/multiplier/zone tap targets
every hit already uses in both modes).

## Testing

Per `CLAUDE.md`'s "every new calculation gets a committed test" convention:
`getDartHeatmap()`'s zone-scoped grouping needs a `node:test` proving an
inner-zone single and an outer-zone single for the same sector land in separate
rows with correct counts, that a `NULL`-zone (Pad-mode) single is counted
separately from both, and that scoping by `gameType` correctly isolates an X01
dart from a Cricket dart from the same player (mirroring the existing
`_scope()` test pattern used elsewhere). A dedicated test confirms
`getChuckinHeatmap(name, mode)` still returns byte-identical results to
`getDartHeatmap(name, 'chuckin', mode)` — a regression guard for the existing,
already-shipped Chuckin behavior through the generalization. Verify end-to-end
with Playwright: tap the inner single region of a number several times, tap
the outer single region a different number of times, confirm the rendered
heatmap SVG's two paths for that number carry visibly different `heat()`
values (via their `<title>` tooltip text) in **both** an X01 game and a
Chuckin session, and that a Pad-mode-entered single elsewhere doesn't inflate
either path.

**Miss-zone/miss-depth tests**: a `node:test` proving `getDartHeatmap()`
buckets misses by `(miss_zone, miss_depth)` correctly (a near-miss and a
far-miss both near wedge 20 arrive as separate counted rows, distinct from a
near-miss near wedge 5), that a `NULL`-`miss_zone` (Pad-mode) miss is counted
separately, and — critically — a regression test confirming `sector===0`-based
logic elsewhere is completely unaffected by populated `miss_zone`/`miss_depth`:
the "Where'd It Go?" badge still fires correctly on three `sector=0` darts
regardless of what either column carries, and `evaluateVisit()`'s scored total
for a miss-containing visit is unchanged. Verify end-to-end with Playwright:
tap the near ring and the far ring at two different wedges, confirm
`#board-miss-btn` is absent from the Dartboard-mode DOM entirely (while still
present and functional switching to Pad mode), and confirm the resulting
`POST /api/games/:id/turns` payload carries `sector:0, multiplier:1` with the
expected `missZone`/`missDepth` per dart.

**Bounce-out tests**: a `node:test` proving a bounce-out dart is stored with
`sector:0, multiplier:1` (so it scores as a miss) while `bounce_sector`/
`bounce_multiplier`/`bounce_zone` correctly preserve the struck position, that
`getDartHeatmap()` returns bounce-outs in a separate `bounces` array rather
than folded into `hits`, and — the most important regression guard in this
whole doc — that a bounce-out dart does **not** trigger badges that check the
dart's *real* struck values (a bounce-out off what would have been a treble
must not count toward Hat Trick's "three trebles in a visit," since by the
time it reaches `evaluateVisit()`/the badge chain checks it's already an
ordinary `sector=0` row and genuinely can't). Verify end-to-end with
Playwright: toggle "Bounce Out" on, tap a treble, confirm the turn is recorded
as a miss (0 points, no Hat Trick/other treble-based badges fire) while the
Player Profile heatmap still shows a bounce-out marker at that treble's
position; confirm the toggle auto-resets after the dart commits so the very
next tap scores normally.

## Open questions for whoever picks this up

- Should the "zone unspecified" hatch treatment (above) also apply anywhere
  `topSectors`/Coaching Insights surfaces sector data as plain text, or is the
  hatch purely an SVG/heatmap concern (text lists could just as easily show an
  explicit "(zone unknown)" suffix instead)? Recommend deciding this once the
  heatmap's own hatch pattern is built and it's clear whether the same visual
  language reads well outside SVG.
- Whether to backfill historical `darts` rows is a non-decision, not an open
  question — there is no way to know which zone a `multiplier=1` dart recorded
  before this feature existed actually landed in (Pad mode doesn't know, and
  even historical Dartboard-mode darts were never asked); backfilling with a
  guess would fabricate data. Leave all pre-existing rows `NULL` permanently.
- Whether the generalized heatmap section's placement should differ per game
  type (e.g. Doubles Practice showing it more prominently than X01, given it's
  the best-fit mode per "Per-mode fit and caveats" above) is a nice-to-have,
  not a blocker — the straightforward default is identical placement and
  prominence across all four tabs, same as every other shared `chartSection`
  element already behaves today.
- **Whether a genuinely no-fallback miss ring is too strict for real play.**
  The request explicitly says remove the flat Miss button from Dartboard mode
  entirely, and this doc follows that — but a dart that flies off the board
  sideways, bounces off the surround, or lands somewhere the player genuinely
  can't localize to one of 20 wedges (e.g. it hit the wall well away from the
  board) has no honest wedge to tap. Recommend building it exactly as
  requested first (no fallback) and only reconsidering a rare-case "can't tell"
  option if real usage shows people hesitating on genuinely ambiguous misses —
  guessing a wedge under time pressure every single miss, forever, could get
  old fast for a mode that's meant to be quick.
- **Miss-ring width/size on a touch device.** Splitting the ring into near/far
  bands means each individual band (`R.bg`→`R.missNear` and
  `R.missNear`→`R.missFar`) gets *half* the radial room a single ring would
  have had, across 18° of arc each — a real risk of mis-taps between near and
  far, or between adjacent wedges, on a phone or small tablet. Worth a real
  on-device pass (not just a desktop mouse check) before considering this
  done, the same "test on the actual hardware" discipline the rest of the
  scoring UI already follows; if two bands prove too cramped in practice, the
  fallback is a taller overall miss zone (bigger `R.missFar`) rather than
  dropping back to one band.
- **Bounce-out toggle discoverability and placement.** A new button in
  `#multi-row` competes for space with Single/Double/Treble on an already
  compact scoring screen, especially on a phone. Whether it reads clearly as
  "off by default, tap before your next dart, then it resets" without
  onboarding/a tooltip is worth a real playtest — a mislabeled or
  easily-missed toggle risks the opposite failure from the one being solved:
  someone forgets to toggle it and a bounce-out silently records as a genuine
  miss with the wrong intended position, or forgets to toggle it *off* and
  loses a real scoring dart. The auto-reset behavior (see "Design" above)
  mitigates the second case but not the first.
- **Whether the bounce-out marker should be visible on the live scoreboard
  too** (not just the Player Profile heatmap, which is inherently a
  post-hoc/session-summary view) — e.g. a small notation next to a dart in the
  live "darts thrown this visit" display. Not required by the request as
  stated, but a natural follow-on once the data exists; recommend treating it
  as a separate, smaller item rather than bundling it into this one.
