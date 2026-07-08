# Dartboard Zone & Miss-Area Tracking — Design Roadmap

> Status (2026-07): **Built end-to-end.** Zone tracking (inner/outer single
> splitting), the generalized dartboard heatmap (X01/Cricket/Doubles Practice/
> Chuckin, not just Chuckin), the two-band (near/far) positional miss ring
> replacing Dartboard mode's flat Miss button, and v1 Bounce Out tracking (a
> flat count, available in every game type and both input modes, including
> Cricket's own dedicated pad) are all shipped — schema (`darts.zone`/
> `miss_zone`/`miss_depth`/`bounced`), backend (`getDartHeatmap()`,
> `getBounceOutCount()`, `GET /api/players/dart-heatmap`, `GET
> /api/players/bounce-outs`), frontend (`buildDartboard()`'s enlarged SVG,
> `buildDartHeatmap()`, the "zone unspecified" hatch overlay), and committed
> tests. Verified end-to-end with a live Playwright pass (Dartboard-mode inner/
> outer/miss-ring taps, Bounce Out in both Pad and Dartboard mode, Cricket's own
> pad, and the resulting Player Profile heatmap). **v2 of Bounce Out (positional
> capture) remains explicitly deferred**, gated on `docs/camera-scoring-roadmap.md`
> — see "Bounce-out tracking" below for the v1/v2 split, which is unchanged from
> the original design. v2 was never split out as its own tracked item on
> `docs/open-roadmap-items.md` (it has no independent standing — it's contingent
> follow-on work absorbed into that tracker's existing Camera/ML scoring item, not
> a separately pickable task today), so per `CLAUDE.md`'s archiving convention this
> doc moves to `docs/archive/` in the same change that finishes v1. See
> `docs/open-roadmap-items.md` for the live completion tracker across all roadmaps.

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

**Built exactly as designed below.**

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

**Built** — a `url(#zoneHatch)` SVG pattern fill, drawn over both single paths on
top of their real heat-scale color, exactly as described below. Also resolved
the "should the flat text list mark it too?" open question (below): yes —
`dartLabelFromParts()` appends `" (zone unknown)"` for a zone-less single
(never for a double/treble/bull, which never had a zone concept at all), so
`topSectors` stays honest the same way the heatmap SVG is.

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

**Built.** The generalized heatmap section now shows on all four game-type
tabs, exactly as designed below.

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

**Built** — `getChuckinHeatmap(playerName, mode)` is now a thin wrapper around
`getDartHeatmap(playerName, gameType, mode)`, scoped via the existing
`_scope({mode, gameType})` helper (the same helper every other per-game-type
stat query in `backend/db.js` already uses, including its `KNOWN_GAME_TYPES`
validation) — a one-function generalization, not new plumbing. The shipped
version's `GROUP BY`/`SELECT` also folds in `miss_zone`/`miss_depth`
(see "Miss-area tracking" below — both landed in the same pass rather than as
a second migration to the same function):

```js
function getDartHeatmap(playerName, gameType, mode) {
  const p = getPlayer(playerName);
  if (!p) return [];
  const scope = _scope({ mode, gameType });
  return db.prepare(`
    SELECT d.sector AS sector, d.multiplier AS multiplier, d.zone AS zone,
           d.miss_zone AS missZone, d.miss_depth AS missDepth, COUNT(*) AS hits
    FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? ${scope}
    GROUP BY d.sector, d.multiplier, d.zone, d.miss_zone, d.miss_depth
  `).all(p.id);
}
// Chuckin's existing call sites keep working unchanged:
function getChuckinHeatmap(playerName, mode) { return getDartHeatmap(playerName, 'chuckin', mode); }
```

**API surface**: `GET /api/players/dart-heatmap?name=&gameType=&mode=`
alongside the existing `GET /api/players/chuckin-heatmap?name=&mode=` (kept
as-is, unchanged response shape, for backward compatibility — REFERENCE.md's
§12 API surface only ever grows here, nothing is removed or renamed out from
under existing callers). Also added: `GET
/api/players/bounce-outs?name=&gameType=&mode=` → `{ count }` (see "Bounce-out
tracking" below).

### Frontend: one reusable renderer, four trigger points

**Built exactly as designed** — `loadChuckinHeatmap()`/`buildChuckinHeatmap()`
no longer exist as separate functions; `loadDartHeatmap()`/`buildDartHeatmap()`
are the only versions now, called for whichever game type's Player Profile tab
is active.

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

**Built** exactly as designed in this section, including the exact suggested
radii (`R.missNear=270`, `R.missFar=310`, `viewBox="0 0 660 660"`, board
recentered at `CX=CY=330`).

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

**Built exactly as designed** — `darts.miss_zone`/`darts.miss_depth`, both
nullable, added alongside `zone`/`bounced` in the same migration pass.

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

**Built as designed**, one refinement:

- **`addTurn()`**: accepts optional `missZone`/`missDepth` per dart (only
  meaningful when `sector===0`), stores both verbatim — same "client is the
  only party that knows the tap position" reasoning as `zone`.
- **`getDartHeatmap(playerName, gameType, mode)`** (the generalized function
  from "Beyond Just Chuckin' It" above): `GROUP BY` extends once more to
  include `d.miss_zone, d.miss_depth`, so `SELECT ... FROM darts d WHERE
  d.sector=0` rows arrive pre-bucketed by wedge *and* how close they were.

### Frontend

**Built**, with one deliberate deviation from the sketch above: the miss ring
uses its **own independent heat-scale normalization** (`missHeat(wedge,
depth)`, its own `maxMissHeat`), not the same `maxHitHeat` scale the scoring
regions use. Hits and misses are wildly different population sizes per
player, so sharing one max would make the miss ring read as permanently
"cold" (or, for a wild thrower, the scoring regions as permanently "cold") —
an independent scale is what actually makes "brighter means more misses
landed here, relative to this player's other misses" true.

- **`throwDartBoard(sector, mult, zone, missZone, missDepth)`**: the extra
  parameters thread through to `throwDart()`, stamped onto the dart object
  pushed to `game.darts` exactly like `zone` (only `zone` or
  `missZone`+`missDepth` is ever set on a given dart — a hit can't have a miss
  wedge, a miss can't have an inner/outer zone).
- **`DB.recordTurn()`'s darts payload**: adds `missZone: d.missZone || null`
  and `missDepth: d.missDepth || null` per dart, same shape as `zone`.
- **`buildDartHeatmap(cells)`**: gains the same two outer rings
  `buildDartboard()` now draws, each shaded independently via `missHeat(wedge,
  'near')` / `missHeat(wedge, 'far')` (reusing the same `heatFill()` color
  mapping function, just a separate normalization) — so the *pattern* of a
  player's misses (which side of the board, which numbers, how close) becomes
  visible at a glance, not just a single aggregate "N misses" count sitting
  off to the side.

### Per-mode fit

No caveats beyond what "Beyond Just Chuckin' It" already covers — a miss is a
miss regardless of game type, so the miss ring appears on the same heatmap
section for X01, Cricket, Doubles Practice, and Chuckin uniformly, with no
mode-specific behavior.

## Bounce-out tracking: hit the board, didn't stick

**v1 built exactly as designed below** (v2 remains deferred, see the status
header). One difference from the original sketch: Cricket's own dedicated pad
(`renderPadCricket()`) also gets the Bounce Out button — that pad has no
Pad/Dartboard toggle of its own to hang "available in both input modes" off
of, so it's treated as its own third home for the same button rather than
being left out.

### Goal (as requested)

> "There should also be a bounce out option/button. Something that hit the
> board, would have counted, but it either bounced out or fell out for one
> reason or another. Those should be counted as misses but for heatmap
> purposes be treated differently somehow."

This is a **third, distinct dart outcome**, not a variant of the miss-ring
work above: a genuine miss never touched a scoring area at all; a bounce-out
**did** strike a real number/ring but didn't stay in the board long enough to
count, so it scores nothing, same as a miss, but the *cause* is completely
different — one is an aim problem, the other is often a dart weight/grip/
board-tension problem entirely unrelated to where it was aimed. Conflating the
two into one "miss" count would hide that distinction.

### v1 (build now): a flat button, no position — deliberately deferred

> Follow-up decision (2026-07): the original design below this point captured a
> bounce-out's exact struck position (sector/multiplier/zone), reusing the same
> tap targets a real hit uses. **That positional capture is deliberately
> deferred to v2** — a human reconstructing exactly where a dart landed
> *after* it's already fallen off the board, under the time pressure of normal
> play, is not a reliable source of that data. `docs/camera-scoring-roadmap.md`
> is the actual reliable source once it exists (a camera has genuine ground
> truth at the moment of impact, before any bounce); until then, a rough manual
> guess isn't worth the extra UI complexity or the false precision of data that
> looks exact but isn't trustworthy.

v1 is a single **"Bounce Out" button** — no toggle, no board tap required
after pressing it, no position captured — available in **both** Pad and
Dartboard mode (this was never the miss-button's "board-only" restriction; a
bounce-out isn't directional in v1, so there's nothing mode-specific about it).
In Dartboard mode it sits where the old flat Miss button used to (now that
Miss itself moved to the two-band ring), giving Dartboard mode exactly one
non-positional button, symmetric with Pad mode's existing Miss button.
Pressing it records one dart as a bounce-out and immediately commits it — no
extra step, no multiplier/number selection needed, since v1 tracks *that* it
happened, not *where*.

### Schema (v1)

**Built exactly as designed.**

```sql
ALTER TABLE darts ADD COLUMN bounced INTEGER;   -- 1 = bounced/fell out, NULL otherwise
```

One column, one purpose: distinguish a bounce-out from a genuine miss in the
data, nothing more. **`sector`/`multiplier` stay exactly `0`/`1` — a bounced
dart is, to every existing consumer, a completely ordinary miss row.**
`dartValue(sector, mult)` already returns `0` for `sector===0`
(`frontend/scoring.js`), so this requires **zero changes** to `evaluateVisit()`,
any badge chain check (Hat Trick, Bullseye Gauntlet, "Where'd It Go?", Busted
Maximum, etc.), `getGhostLegScript()` replay, or `getFullDatabaseExport()` —
they already handle this row correctly today, because it's shaped exactly
like the rows they already handle. `bounced` is purely additive metadata, the
same posture as `zone`/`miss_zone`/`miss_depth` throughout this doc.

### Backend (v1)

**Built** — `getBounceOutCount(playerName, gameType, mode)`, exactly the
`_scope()`-based count query sketched below, plus `GET
/api/players/bounce-outs?name=&gameType=&mode=` → `{ count }`.

- **`addTurn()`**: accepts an optional `bounced` flag per dart, stores it
  verbatim — same pass-through-only reasoning as every other column in this
  doc.
- **A simple count, not a heatmap position**: since v1 has no position to
  plot, `getDartHeatmap()` doesn't need to change for this at all. Instead, a
  plain `SELECT COUNT(*) FROM darts d JOIN turns t ... WHERE t.player_id=?
  AND d.bounced=1 ${scope}` (mirroring the existing per-game-type `_scope()`
  pattern) is enough — surfaced as a stat, not a spatial overlay.

### Frontend (v1)

**Built** — `throwBounceOut()` calls `throwDart(0, undefined, undefined,
undefined, true)`, reusing the exact same per-game-type dispatch
(`throwDartDoublesPractice`/`throwDartChuckin`/the shared X01+Cricket path)
every other dart already goes through, rather than a parallel code path.

- **One new button**, not a toggle — no `bounceOutMode` global, no
  substitution logic in `throwDart()`/`throwDartBoard()` needed. The button's
  own handler commits a dart with `sector:0, multiplier:1, bounced:true`
  directly, the same shape `throwDartBoard(0,1)` already produces for a plain
  miss today, just with the one extra flag.
- **Surfaced as a count, not on the heatmap SVG** — e.g. a small "Bounce-outs:
  N" line near the Dartboard Heatmap section (or its own stat bubble,
  consistent with how other per-game-type counts are already shown), not a
  marker plotted on the board, since v1 genuinely has no position to plot.
  This is a real, deliberate scope reduction from the original design below —
  worth being upfront that "for heatmap purposes... treated differently"
  becomes "counted separately near the heatmap" in v1, not "shown spatially
  on the heatmap," until v2 exists.

### Per-mode fit (v1)

Available in every game type and both input modes — no mode-specific
restrictions, since v1 has no geometry-dependent behavior at all.

### v2 (future, gated on `docs/camera-scoring-roadmap.md`): positional capture

Once camera/ML scoring exists and can report where a dart actually struck
before it fell — genuine ground truth, not a manual reconstruction — the
original design upgrades cleanly to full positional capture, using the same
shadow-column approach already proven safe elsewhere in this doc (a
scoring-shape `sector=0` row plus separate columns nobody but the heatmap
reads):

```sql
ALTER TABLE darts ADD COLUMN bounce_sector INTEGER;     -- where it actually struck
ALTER TABLE darts ADD COLUMN bounce_multiplier INTEGER;
ALTER TABLE darts ADD COLUMN bounce_zone TEXT;           -- 'inner' | 'outer' | NULL
```

At that point `getDartHeatmap()` gains a `bounces` array (position-scoped, the
same way `hits`/`misses` are), and `buildDartHeatmap(cells)` renders bounce-outs
as a small distinct marker overlaid on the relevant hit region — **not**
blended into that region's own heat-scale color, so a wedge doesn't look "hot"
(implying real scoring hits) just because bounce-outs cluster there. Manual
entry (Pad/Dartboard-mode tapping, as originally designed) could still exist
as a fallback for anyone without camera hardware, but shouldn't be the primary
path once cameras can supply it directly — this whole v2 section is explicitly
a follow-on item, not part of what ships now.

## Testing

**Built.** Committed `node:test` coverage: `backend/test/db.chuckin-stats.test.js`'s
"getDartHeatmap — zone-scoped grouping" (inner/outer/unspecified separation,
gameType isolation, miss-zone/miss-depth bucketing, the `getChuckinHeatmap`
regression guard) and "getBounceOutCount" describe blocks;
`backend/test/db.turn-validation.test.js`'s "addTurn — zone/missZone/
missDepth/bounced validation" block (every rejection case, plus a raw-row
check that a bounce-out is stored identically to a plain miss apart from the
flag); `backend/test/scoring.test.js`'s regression proving `evaluateVisit()`'s
scored/bust/win outcome is byte-identical whether or not a dart carries this
metadata. Verified end-to-end with a live Playwright pass against a running
server (not committed as a test file, since this repo's Playwright checks are
ad hoc verification, not a committed suite): added a player, started a
practice X01 game, tapped the inner-single/outer-single/miss-ring regions
directly via their `onclick` attributes and confirmed the exact
`POST /api/games/:id/turns` payload carried the right `zone`/`missZone`/
`missDepth`; pressed Bounce Out mid-visit in Dartboard mode and confirmed it
committed as `sector:0,multiplier:1,bounced:true` without requiring a board
tap; confirmed Pad mode still shows its own inline Miss button plus Bounce
Out; confirmed Cricket's own pad shows Miss and Bounce Out with no zone data
attached; confirmed the Player Profile heatmap renders the inner/outer/miss
regions as visibly distinct shapes and the "Bounce-outs: N" line updates.

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

**Bounce-out tests (v1)**: a `node:test` proving a bounce-out dart is stored
with `sector:0, multiplier:1, bounced:1` (so it scores as an ordinary miss),
that the bounce-out count query correctly isolates `bounced=1` rows per
player/`gameType`/mode, and — the most important regression guard in this
whole doc — that a bounce-out dart does not trigger any badge or scoring path
differently than a plain miss would (since it's stored identically apart from
the one flag, this should be trivially true, but it's exactly the kind of
"obviously true" claim `CLAUDE.md`'s testing discipline says to prove rather
than assume). Verify end-to-end with Playwright: press "Bounce Out" in both
Pad and Dartboard mode, confirm the turn commits immediately as a miss (0
points) with no board tap required, and confirm the Player Profile's
bounce-out count increments correctly. (v2's positional tests — confirming a
`bounces` array entry lands at the correct struck position on the heatmap —
apply once v2 is actually built, not before.)

## Open questions — resolved / still open

- **Resolved**: the "zone unspecified" hatch treatment also applies to
  `topSectors`/Coaching Insights' flat text list — `dartLabelFromParts()`
  appends `" (zone unknown)"` to a zone-less single there too, same "don't
  silently imply precision that isn't there" posture as the SVG hatch.
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
- **Still open**: whether a genuinely no-fallback miss ring is too strict for
  real play. Built exactly as requested (no fallback) — a dart that flies off
  the board sideways, bounces off the surround, or lands somewhere the player
  genuinely can't localize to one of 20 wedges has no honest wedge to tap.
  Only verified against headless taps so far, not real ambiguous-miss usage;
  reconsider a rare-case "can't tell" option if real play shows people
  hesitating.
- **Still open**: miss-ring width/size on an actual touch device. Built with
  the doc's own suggested radii (`R.missNear=270`, `R.missFar=310`), each band
  getting half the radial room a single ring would across 18° of arc — verified
  correct via Playwright's programmatic taps (which don't exercise finger-size
  mis-tap risk at all), **not yet verified on real touch hardware**. If two
  bands prove too cramped in practice, the fallback is a taller overall miss
  zone (bigger `R.missFar`) rather than dropping back to one band.
- **Resolved**: Bounce Out button placement (v1) — it sits exactly where the
  old flat Miss button used to (`#bounce-out-btn`, same DOM slot in the shared
  `#screen-game` shell, same `.board-miss` CSS class for positioning), visible
  and enabled/disabled identically in Pad mode, Dartboard mode, and Cricket's
  own pad.
- **Whether v1's bounce-out count should be visible on the live scoreboard
  too** (not just the Player Profile, which is inherently a post-hoc/
  session-summary view) — e.g. a small running counter alongside the existing
  180/Big Fish/Bust counters. Not required by the request as stated, but a
  natural, low-effort follow-on once the count exists; recommend treating it
  as a separate, smaller item rather than bundling it into this one.
- **v2's actual trigger condition.** This doc gates positional bounce-out
  capture on `docs/camera-scoring-roadmap.md` existing, but that roadmap item
  is itself "Extremely high" complexity and has no committed timeline. Confirm
  whenever v2 is picked up that camera scoring is genuinely available by
  then — if it's still far off but manual positional tapping turns out to be
  wanted sooner after all, that's a legitimate reason to revisit the "not
  reliable enough" judgment above, not an automatic blocker on building it
  manually.
