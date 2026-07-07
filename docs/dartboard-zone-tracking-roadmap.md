# Dartboard Inner/Outer Single Zone Tracking — Design Roadmap

> Status: **designed, not started.** Tracked as its own item on
> `docs/open-roadmap-items.md`. No scoring behavior changes — this is purely a
> data-granularity and heatmap-visualization enhancement. Expanded (2026-07) to
> also generalize the dartboard-shaped heatmap itself — today exclusive to Just
> Chuckin' It — to X01, Cricket, and Doubles Practice, since the `darts` table
> and the SVG geometry are already shared across every game type; see "Beyond
> Just Chuckin' It" below.

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
