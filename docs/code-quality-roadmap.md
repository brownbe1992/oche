# Code-Quality Refactors — deferred review findings

> **Status: Phases 1-2 of the completion order done (items 59, 58, 56, 52, 38,
> 39, 43 — see each item's own note below); the rest is open.** Every item below is
> tracked individually on `docs/open-roadmap-items.md` (items 35–45 from the
> branch review, items 46–52 from the first whole-file `/simplify
> frontend/index.html` pass, items 53–59 from the second). This doc is the
> design context for them, in one place, so each can be picked up (or
> explicitly rejected) on its own.
>
> **Origin:** the 2026-07-20 max-effort code review of the `dev` branch
> (fix commits `878bf52` and `eba350f`). Every *correctness* finding from that
> review was fixed on the spot; these are the **verified-but-deferred**
> maintainability/architecture findings — each was judged too large or too
> behavior-risky to refactor untested in the same pass. None is a bug: the
> current code is correct, just fragile or duplicated in the ways described.
> Items are independent unless a row says otherwise; there is no required
> order.

---

## Item 35 — Consolidate the 16 `undoLastTurn*` trailers — ✅ Done

All 16 `undoLastTurn*()` functions in `frontend/index.html` now end with a
call to one shared `_finishUndo(snap, renderFn, {msg, restoreCurrent,
resetDarts, push})`, which holds the trailer every copy pasted: mark
`snap.voided`, revoke `snap.badgeReverts`, call
`cancelQueuedAchievementsForSnapshot(snap)`, drop `game.lastTurnSnapshot`,
`DB.deleteLastTurn()`, set the status message, and re-render. Each mode's
function keeps only its own field restores and passes the narrow, now-explicit
set of options it genuinely differs on:

- `restoreCurrent`/`resetDarts` — `true` for the 6 multi-visit turn-order
  modes (X01, Cricket, Baseball, Shanghai, Halve-It, Pressure Chamber), which
  restore whose turn it is and the shared darts/busted/won scratch state;
  `resetDarts`-only for the 5 single-player visit-based modes (Bob's 27,
  Checkout Ladder, Gauntlet, Dead Man Walking, Checkout Trainer); both `false`
  for the 5 single-dart-at-a-time modes (Killer, Doubles Practice, Chuckin,
  Around the Clock, Around the World), which don't have a `game.darts` buffer
  concept to reset.
- `push` — opt-in, since `renderGame()` (X01's own renderer) already calls
  `pushLive()` itself; Bob's 27's renderer doesn't, so it's the one mode that
  asks for it explicitly (previously the only one to call `pushLive()` at all
  — the others' omission was incidental, not deliberate, until this pass made
  every mode's choice explicit).
- `msg` — the 3 distinct status strings this drifted into: `'Last turn
  undone.'` (turn-based multi-visit modes), `'Last attempt undone.'`
  (Gauntlet, Checkout Trainer), `'Last dart undone.'` (the single-dart modes,
  including Killer).

Doubles Practice's snapshot has no `badgeReverts` field at all (its one
badge, Ring Master, is deliberately permanent/non-revocable) — folded into
the same helper anyway since the badge-revert loop and `voided` flag are
verified no-ops on that shape, so a future snapshot-based Doubles Practice
badge gets undo protection for free instead of needing this function
special-cased again.

Verified live in a browser: played a real X01 game end-to-end (threw a 180,
committed the turn, undid it) and confirmed the score/turn ownership
restored exactly (`501 → 441 → 501`, turn correctly reverting to the
original player) with the right status message; directly exercised Killer's
undo (custom thrower/affected-player field restore, `'Last dart undone.'`)
and Doubles Practice's now-shared trailer (no-op badge path doesn't throw).
Backend suite unaffected (1244 tests, same 6 pre-existing unrelated
failures).

## Item 36 — One `winSectionHtml()` for the five "Most X Wins" Home templates

Five `renderHomeTabBody*` functions (`frontend/index.html` ≈ 2745, 2791,
2838, 2881, 2923) embed the identical hof-list HTML template, differing only
in the section title and `homeData` key. A markup/escaping/format change must
be found five times; five copies of interpolated HTML is five XSS-audit
surfaces.

**Shape:** `winSectionHtml(title, rows)` called with
(`"Most Cricket Wins"`, `homeData.cricket.wins`) etc. Pure extraction, no
behavior change — the smallest item on this list.

## Item 37 — Registry-driven resume dispatch (savable ⇒ resumable, structurally)

`resumeGame()` (`frontend/index.html` ≈ 10083) is a hardcoded 13-branch
else-if chain (per-type rebuild call + field overlay + status message), and
`_savedGamePosition()` (`backend/db.js` ≈ 1773) is a second parallel
12-branch copy of the same dispatch with the per-type config-default parsing
duplicated in both. The failure mode is concrete: a future savable mode that
misses the frontend branch hits the else-alert **after**
`getResumeState()` has already consumed the `saved_games` row — the user's
paused game is destroyed. A missed backend branch renders a blank position
label.

**Shape:** a `resume`/`rebuildState` member on each `GAME_TYPES` entry (and a
`position` member on the backend `GAME_TYPE_REGISTRY`), so registering a
savable type without resume support is impossible by construction. This is
the largest single item here; do it with the app runnable for end-to-end
verification of every savable type.

## Item 38 — `savedGamePositionLabel()`: dispatch on `sg.gameType`, not field presence — ✅ Done

`savedGamePositionLabel()` (`frontend/index.html` ≈ 10279) picks its label
format by probing which fields exist on the position object (`pos.players`,
`pos.hit`, `pos.round`, `pos.target`, `pos.dmwRound`, …). The backend already
had to invent `dmw`-prefixed field names purely to dodge a collision
(`backend/db.js` ≈ 1830 comment). The next mode's position shape must avoid
seven reserved names or it silently renders another mode's label with
nonsense values — a constraint visible only in a backend comment.

**Shape:** branch on `sg.gameType` (already on the same object and already
used three lines earlier), or a `positionLabel` registry member. Small,
self-contained.

## Item 39 — Derive `NON_SAVABLE_GAME_TYPES` from the backend registry — ✅ Done

`NON_SAVABLE_GAME_TYPES = ['doubles_practice','chuckin','checkout_trainer','killer']`
(`frontend/index.html` ≈ 14577) hand-mirrors the backend
`GAME_TYPE_REGISTRY` savable flags (`backend/db.js` ≈ 1638–1659). Nothing
ties them together — a drifted entry either shows a Save button the server
400s, or hides pause/resume for a mode the server supports.

**Shape:** serve the savable list with existing game-type data (or assert
the two lists match in a committed test — the cheap 80% version).

## Item 40 — Declare `newMatchPlayer`'s second-arg shape on the registry

`startGame()` (`frontend/index.html` ≈ 5140) and `resumeGame()` (≈ 10074)
each hardcode their own list of which types' `newMatchPlayer` takes `config`
vs a start score — and the lists already differ (startGame:
cricket|doubles_practice|checkout_trainer; resume: cricket only, plus the
x01 per-player handicap case). They only agree today because the extra types
happen to be non-savable. The next savable config-constructed mode silently
builds resumed players from a number where the constructor expects an
object.

**Shape:** a per-entry declaration (e.g. `ctorArg: 'config' | 'startScore'`)
consumed by both call sites. Folds naturally into item 37 if done together.

## Item 41 — `games.category` as a registry member — ✅ Done

Every `GAME_TYPES` entry (including x01, which relied on the old ternary's
fallthrough) now declares its own `category(setup, config, startScore)`.
`startGame()`'s call site collapses to
`GAME_TYPES[gameType].category(setup, config, startScore)` — a future type
that forgets to add one throws immediately at game creation (calling
`undefined(...)`), instead of the old ternary's fallthrough silently writing
`category: String(startScore)` — a nonsense label for a non-scored game
type — into `games.category` permanently. Verified live in a browser: called
every type's `category()` directly with representative setup/config
combinations (Cricket classic/custom, Halve-It classic/custom, Checkout
Trainer Blitz/Freeform, Doubles Practice's dynamic target list, and every
static-label type), then played a real Cricket game end-to-end through the
actual New Game UI and confirmed the server-persisted `games.category` row
matches.

The stored `games.category` string comes from a 14-branch gameType ternary
(`frontend/index.html` ≈ 5085) falling through to `String(startScore)`. A
new mode that misses the chain writes category `'501'` **permanently into
its games rows** — polluting X01's category-keyed stats
(`h2hLegsWonByCat`, leaderboard groupings) and league-fixture category
matching, discovered only after bad rows exist.

**Shape:** a `category(config, setup)` member on each `GAME_TYPES` entry
(static label for most, computed for Cricket preset / Halve-It preset /
Doubles targets / Blitz-vs-Freeform), making the fallthrough impossible.

## Item 42 — Live-state keys: per-mode container (or registry-derived allowlist)

`ALLOWED_LIVE_KEYS` (`backend/server.js` ≈ 465) is a ~58-entry hand-kept
flat list; every new mode adds top-level keys in three unlinked places
(`liveSnapshot()` producer, the allowlist, the `display.html` reader). The
silent-strip failure has now shipped **twice** (BUG-28's 7 keys, then
`killerLives`/`checkoutLadder*` — the `/display` fallbacks made both
invisible: plausible-looking wrong defaults, no error).

**Shape:** either one allowlisted per-mode container key (`modeState`,
unrestricted-shape the way `players[]` already is) with per-mode fields
inside it, or derive the allowlist from a shared registry the producer and
reader both consume. Reduces three sync points to zero. Touches the SEC-2
sanitization layer — keep the size cap and the top-level shape validation.

## Item 43 — Id-keyed killer configs (end the name-rewrite class) — ✅ Done

`config.numbers` is now keyed by `players.id`, migrated by a one-time boot
function (`migrateKillerConfigsToIdKeys()`) that also heals any config a
pre-fix rename/merge had already orphaned (same unambiguous one-orphan/one-
unclaimed heuristic the old reconciler used) before converting it. Of the
three compensating mechanisms, two are fully gone: `renamePlayer()` no
longer touches `config.numbers` at all (a rename can't change a row's id,
so there's nothing left to orphan), and the boot reconciler is replaced
outright by the migration above (which folds its healing logic in rather
than running it forever). The other two turned out not to be eliminable —
not because the item's premise was wrong, but because they're not actually
"bug compensators": `mergePlayers()` still moves a key from source.id to
target.id (renamed `_rewriteKillerConfigIds()`), because a merge
*intentionally* changes which id owns a participation — that's not drift,
it's the merge's whole point, the same reason every other FK-into-players
table gets an `UPDATE ... SET player_id = target.id` in that same
transaction. `importPlayerExport()`'s re-key similarly survives (now
reusing `idMap`, the existing source-id → local-id map — the separate
`nameMap` it used to need is gone entirely) because translating any
embedded id reference across two independent databases' autoincrement
histories is an unavoidable structural need for import, unrelated to the
old name-drift bug class. `rebuildKillerState()` (`frontend/scoring.js`)
now takes `participants` ({id, name} rows) instead of bare `names`, looking
up `numbers[id]`; its own internal replay (and `evaluateDartKiller()`)
stays entirely name-based, matching the live game object's own shape — only
the number *lookup* moved from name to id. The wire format `createGame()`
returns to the client is unchanged (`{name: number}`), so `frontend/
index.html` needed zero changes at all. Verified live in a browser: a
Killer game's client-side numbers still resolve correctly by name, while
the server-persisted `games.config` is confirmed id-keyed by direct query.
Committed tests: `backend/test/db.killer-config-migration.test.js` (new —
legacy name-keyed migration, orphan-healing, idempotence), plus updated
assertions in `db.killer-stats.test.js`, `db.merge.test.js`,
`db.export.test.js`, and `scoring.test.js`.

Killer's `games.config.numbers` is keyed by player **name** while every
replay path looks up by current name. Three compensating mechanisms now
exist (`_rewriteKillerConfigNames()` on rename and merge, the import-time
re-key in `importPlayerExport()`, and the `reconcileKillerConfigNames()`
boot self-heal) — each added after a real orphaned-assignment bug. Any
future name-mutating path starts broken until someone remembers the rewrite.

**Shape:** migrate `config.numbers` to be keyed by `players.id` (one boot
migration translating existing configs via `game_players`, then delete all
three compensators and re-point `rebuildKillerState()`'s lookup). The
frontend replay uses names; the id→name join already exists at every call
site. Medium effort, permanently removes a whole bug class the hard way the
current fixes only patch.

## Item 44 — Whole-darts-table scan pass over the hot stat queries

Several hot-path queries aggregate the entire `darts` table (the largest
table) or replay entire game-type histories per player, when an indexed
correlated count (`idx_darts_turn` exists) or a single grouped pass would
bound the work:

- `getHomeExtra()`'s `_first9` and `_trebleLess` — four full
  `GROUP BY turn_id` scans per Home load (`backend/db.js` ≈ 2583, 2548).
- `getSessionRecap()`'s `bestLegStmt`/`preLegAvgStmt` — the same subquery
  per active player, plus a lifetime-history grouping per player.
- `getPersonalBests()` — the full-table subquery twice per Player Profile
  view (`legAvgSql`, `bestFirst9`).
- `_h2hWonLegs()`'s shanghai/halve-it loop — `getShanghaiWonLegs()`/
  `getHalveItWonLegs()` once per participant, each internally replaying
  ALL of that type's turns for ALL players before filtering to one
  (O(players × history) per `/api/stats`). Derive each leg's winner once
  and emit all winners (the killer branch's `_replayKillerLegs()` shape).

All grow linearly (or × players) with lifetime history on a synchronous
single-threaded server that also handles live scoring. Item 34 (the
per-game-type stat generalization decision) overlaps the last bullet —
decide them together.

## Item 45 — Home page: lazy per-combo fetches

`renderHome()` fires ~47 aggregate fetches per Home navigation though only
the selected tab+game-type combo renders. Two mitigations already shipped
(stale-while-revalidate paint + the keep-cache-on-error catch); the burst
itself remains and grows with every mode. A real fix fetches per visible
combo in `switchHomeTab()`/`switchHomeGameType()` (with `homeData` caching
per group), or adds one combined endpoint. Touches every `homeTabRenderer` —
needs the app runnable to verify each tab.

---

# Batch 2 — deferred findings from the whole-file `/simplify frontend/index.html` pass (2026-07-20)

Same origin discipline as above: verified findings, none a live bug (the one
real drift the pass found — `setupStep3HasContent()`'s stale id list hiding
Shanghai/Halve-It's Step 3 options — was fixed on the spot, along with the
helper-bypass, dead-code, and fetch-waste items). These are the remaining
larger refactors, tracked as items 46–52.

## Item 46 — Per-mode option-section wiring as a registry member — ✅ Done

`optionsSectionId` on the four gameType-keyed `GAME_TYPES` entries (Cricket/
Killer/Shanghai/Halve-It) plus one `updateGameTypeOptionSections(gameType)`
loop collapses the exact byte-for-byte 4-line block `setMode()` and
`setGameType()` each hand-maintained separately. `setupStep3HasContent()`'s
own id list had already been fixed (a live `.setup-section` DOM query, no
hand-kept list left) before this pass — nothing to do there.

Of the "related mirrors": `NEW_GAME_MODE_OPTIONS[].contexts` now derives from
`GAME_TYPES`' own `soloOnly`/`h2hOnly` flags via `contextsForMode()`, called
at `setupVisibleOptions()`'s own runtime (not at `NEW_GAME_MODE_OPTIONS`'s
module-load time, since that array is defined earlier in the file than
`GAME_TYPES` is) — only `challenge`/`ghost` keep an explicit `contexts` array,
since both play as plain x01 underneath with no `GAME_TYPES` entry of their
own to derive from (chuckin's entry gained a `soloOnly: true` it was
factually missing, needed for its own derivation). `isSpecialMode`'s 12-mode
OR-chain and the start-button-label ternary — confirmed by inspection to be
the exact same 12-mode set — collapse into one `SPECIAL_MODE_START_LABELS`
map (Checkout Trainer's Blitz-vs-Freeform label stays a function, the one
genuinely dynamic entry).

**Deliberately NOT unified:** `drillGameTypes` (`setMode()`, 9 modes) and
`drillModes` (`startGame()`, 10 modes) look like the same list at a glance
but aren't — each excludes a different subset (`marathon`/`dead_man_walking`/
`challenge`/`ghost` in various combinations) for real, documented reasons
(Dead Man Walking's own 15-round/1-game leg shape vs. every other drill's
generic 1/1; Marathon diverting before either list is even built). Forcing
these into one shared field risked silently changing which modes get which
treatment for no simplification benefit — left as two separate, correct
lists rather than one incorrect merged one.

Verified live in a browser: every mode's option-section visibility and
start-button label (including Checkout Trainer's dynamic Blitz/Freeform
switch), every gameType-driven section toggle via both `setMode()` and
`setGameType()`, and `setupVisibleOptions()`'s practice/h2h key lists all
match the pre-refactor behavior exactly.

The Step 3 option-section mapping lives in four places: the markup
(`#setup-step-3 .setup-section` ids), `setMode()`'s toggles (~3313-3335),
`setGameType()`'s repeat of four of them (~4328-4331), and (until fixed) the
`setupStep3HasContent()` id list — the fourth copy is what drifted. An
`optionsSectionId` member on `GAME_TYPES`/`NEW_GAME_MODE_OPTIONS` would
collapse both toggle sites into loops. Related mirrors worth folding in:
`NEW_GAME_MODE_OPTIONS[].contexts` duplicating the registry's
`soloOnly`/`h2hOnly` flags, and `setMode()`'s three near-identical mode lists
(`isSpecialMode`, `drillGameTypes`, the start-button-label ternary) plus
`startGame()`'s separate `drillModes` — candidates for `isDrill`/`isSpecial`/
`startLabel` fields on the mode entries.

## Item 47 — One `h2hStatsHtml(winner, scope)` with per-type rows — ✅ Done

The five near-identical `h2hStatsHtml`/`...Baseball`/`...Shanghai`/
`...HalveIt`/`...PressureChamber` functions (differing only in 2-3
`statRow()` metrics per player) are now one `h2hStatsHtml(winner, scope)`
that dispatches each player's stat rows through a new `h2hRows(p, scope)`
member on `GAME_TYPES` — the same `legSummary` precedent this roadmap already
established, X01 shape as the default (`h2hRowsX01`) since its entry
declares no `h2hRows` of its own. Baseball/Shanghai/Halve-It/Pressure
Chamber each declare their own `h2hRows`, carrying forward their exact
original per-mode comments (Baseball's non-cumulative "Runs (final leg)"
rationale, Pressure Chamber's extra Composure Rating row). The shared
`showStanding`/winner-marker-title/`prac-stats` wrapper logic — previously
pasted five times — is now written once.

`finishUnit()`'s two parallel 5-way ternary chains collapse to direct
`h2hStatsHtml(...)` calls: the game-scope call site keeps its existing
`isCricket || isBobs27 || isGauntlet || isKiller || isDeadManWalking`
exclusion (those 5 modes still build their own small custom summary block
instead, since their player shapes don't match `h2hRowsX01`'s fields), and
the leg-scope call site's per-mode chain becomes a single
`GAME_TYPES[game.gameType].h2hRows ? h2hStatsHtml(winner) : game.practice ?
<dual panel> : h2hStatsHtml(winner)` — preserving the exact original
behavior that the practice-mode dual-column panel is X01-exclusive (every
`h2hRows`-having mode always shows the H2H panel, in or out of practice).

Verified live in a browser: called `h2hStatsHtml` directly for all 5 modes
(X01, Baseball, Shanghai, Halve-It, Pressure Chamber) at both `'game'` and
leg scope with representative player state, confirming every label/value
matches the original functions exactly (Baseball's "Runs (final leg)",
Pressure Chamber's 3-row Composure Points/Rating/Darts, X01's Leg/Game Avg),
plus the multi-leg "Standing" row appearing correctly. Backend suite
unaffected (1244 tests, same 6 pre-existing unrelated failures).

## Item 48 — Declarative personal-bests renderers — ✅ Done

16 of the 17 near-identical `renderXxxPersonalBests()` functions (every one
except X01's own `renderPersonalBests`) are replaced by a per-type spec —
`{emptyMsg, stats:[{key,label,fmt,guard,always,truthy}], form:{recentKey,
lifetimeKey}}` — consumed by one generic `renderPersonalBestsFromSpec(data,
spec)`, itself built on a shared `statBlockHtml(val, label)` (the
byte-identical `stat-block`/`stat-val`/`stat-label` template every one of
the 17 hand-wrote inline). `GAME_TYPES` entries now carry
`personalBestsSpec: X_PB_SPEC` in place of `personalBestsRenderer:
renderXPersonalBests`; the dispatcher (`renderPersonalBests()`, still X01's
own function) checks `gt.personalBestsSpec` before falling back to a
`personalBestsRenderer` custom function (kept only as a mechanism, though no
entry uses it anymore) and finally its own inline X01 body.

The per-stat spec flags exist because the 16 originals' guard conditions and
row-presence checks genuinely weren't uniform, and the spec makes each
divergence an explicit, named option instead of a bespoke ternary:
- `guard` (default `true`): whether a stat counts toward "is this whole panel
  empty" — `winStreak`-style secondary stats set `guard:false` so their own
  presence never flips the empty message, matching each original's narrower
  compound guard exactly (e.g. Checkout Trainer's `lifetimeAvgScore` was
  never part of its own empty-check either).
- `truthy` (default `false`): Checkout Trainer's `bestStreak` is
  absence-tested by falsiness (`0` counts as absent), not `== null` —
  preserved via this flag rather than silently switching it to `!= null`.
- `always` (default `false`): Around the World's "progress / total" row has
  no independent null check in the original (always shown once
  `sessionsPlayed` is present) — `always:true` plus a `fmt(v, data)` closure
  over the whole record handles its two-field composed string.
- `fmt(value, data)`: Bob's 27's literal `D` prefix, Dead Man Walking's `/15`
  suffix, and every `.toFixed(1)` call are now named format functions instead
  of ad hoc template-literal concatenation.

X01's `renderPersonalBests` itself is kept hand-written and unchanged — it
holds the dispatch shim (`gt.personalBestsSpec`/`gt.personalBestsRenderer`
check) plus per-stat share buttons and a Ghost Opponent "race this leg"
button + `#ghost-race-record` span that no other mode has; forcing those
into the declarative spec would need an `extra` hook used by exactly one
mode, the same "don't force an abstraction over a real difference" call this
roadmap already made for X01's `onLegWon()`/drill-mode lists.

Verified live in a browser: navigated to a real Player Profile page (so the
dynamically-built `#player-personal-bests` container exists) and called
`renderPersonalBestsFromSpec` directly for a representative sample —
Cricket (full + empty, confirming the `winStreak` guard exclusion),
Pressure Chamber (confirming `escapeHtml()` still runs on `bestRating`),
Bob's 27 and Dead Man Walking (confirming the `D`-prefix/`/15`-suffix `fmt`
functions), Checkout Trainer (confirming its non-uniform guard, including
the edge case where `lifetimeAvgScore` alone present still shows the empty
message, matching the original bug-for-bug), Around the World (confirming
the composed "progress / total" row and its empty case), Marathon, and The
Gauntlet — every one produced exactly the original HTML. Backend suite
unaffected (1244 tests, same 6 pre-existing unrelated failures).

## Item 49 — One leaderboard-row template helper (~20 sites; supersedes item 36's five)

The hof-list row template (`rank/score/player/dates`) is re-implemented
inline in ~20 Home tab boards beyond item 36's five "Most X Wins" copies
(Elo, win-rate, trebleless, ton+, first-9, MPR, RPI, PPR, Halve-It, PC,
Doubles ×2, Blitz, Bob's 27, Ladder, Gauntlet, DMW, Killer, ATC ×2, ATW,
Marathon). One `leaderboardSectionHtml(rows, {score, meta, emptyMsg})`
subsumes item 36 entirely — implement them together. The copies already lag
`hofSection()`'s accessibility upgrades (role=button/aria-expanded).

## Item 50 — One-shot badge award helper

The award block (POST `/api/badges/award` `{once:true}` → `newlyEarned` →
`queueBadge` + `fireMomentCard`) is hand-rolled ~10 times (~6805, 10770,
10787, 10808, 11119, 12116, 12123, 14683, 15474, 15621) and has ALREADY
drifted: only two sites maintain `earnedBadgeCache` (the rest re-fire the
POST every re-trigger), one site skips `queueBadge`, and the undo-snapshot
capture uses three naming conventions. Generalize
`awardCheckoutTrainerBadge()` (which already encapsulates the pattern) into
`awardOnceBadge(player, badgeId, achType, snap, momentOpts)`.

## Item 51 — Per-dart/per-visit badge-progress fetches and profile refetch waste

Three efficiency items sharing one shape (fetch-baseline-once + client-side
tracking, the in-file precedent at ~15572): (a) every X01 visit fetches
`/api/players/around-the-world` per unbadged player (a lifetime-darts
DISTINCT scan per visit); (b) Doubles Practice fetches
`/api/players/doubles-hit-sectors` on every hit dart until Ring Master;
(c) profile navigation re-awaits the full `/api/stats` refresh
unconditionally (`show('player')`) and tab/game-type switches refetch all
~17 profile loads when only the mode-parameterized ones changed; plus
tournament average-seeding fires one heavy personal-bests call per player
when the in-memory stats blob (or one batch endpoint) would do.

## Item 52 — Small shared-pattern helpers (batch) — ✅ Done

Low-risk, multi-site idioms worth one helper each, batched: `jsArg()` naming
the `escapeHtml(escapeJs(...))` onclick-argument composition (~24 sites, an
unnamed safety invariant); `openModal(html, focusId)` beside the existing
`closeModal()` (12 builders repeat the innerHTML+unhide+focus tail);
a `registerMilestoneLadders(ladders, flags)` helper for the ~12
BADGE_INFO/ACH_LABELS/ACH_DURATION registration loops (bodies vary slightly —
merge carefully); a countdown-timer factory for the Blitz and No-Warmup
start/stop/tick trios; and a `setPressed(group, chosen)` helper for the ~10
hand-enumerated aria-pressed segmented controls.

---

# Batch 3 — deferred findings from the second `/simplify frontend/index.html` pass (2026-07-20)

Second full-file sweep with batches 1-2 excluded. Fixed on the spot: the three
culture badges missing from every overlay map (blank live headlines — the
BUG-26 class), the un-gated tournament create/walkover writes, ~19 duplicate
`pushLive()` calls (renderers already push; commit sites double-posted every
turn), the undo double-render, `uiAlertErr()` + 25 conversions, the shared
`BOARD_GEOM` dartboard kernel, `X01_CATEGORIES`, the `_seededIndex` →
`_pcSeededIndex` alias, settings collapsible CSS classes (~47 inline styles),
checkout-trainer one-off durations + stale comments, and two dead remnants.
The rest, tracked as items 53–59:

## Item 53 — Game-start construction factory (4 drifted copies) — ✅ Done

All four construction sites (`startGame()`, `_reallyBeginTournamentMatch()`,
`beginMarathonLeg()`, `resumeGame()`) now spread a shared
`baseGameRuntimeState()` factory for the ~20-key runtime-state trailer
(darts/busted/won/done, counters, turn logs, one-shot fields including
`atcLastDart`/`atwLastDart`/`dpLastDart`/`chuckinLastDart`), call a shared
`prefetchEarnedBadges(names)` for the badge-cache prefetch loop, and (three of
them — `resumeGame()` has no start-event to record) call a shared
`beginGameSession(webhooks)` for the `recordEvent` game/set/leg-start triple +
optional HA webhooks + render/show tail. `beginGameSession` takes a mode
(`'h2h-gated'` / `'always'` / `'none'`) instead of inferring webhook behavior
from game state, since the three call sites genuinely differ on whether/how
webhooks fire.

This closes the exact drift the item was written to catch: the tournament and
marathon literals were missing `atcLastDart`/`atwLastDart` before this
change, silently breaking the Around the Clock/World throwbox for any game
started via those two paths. Verified live in a browser: started a solo X01
game, an H2H X01 game, and a resumed game, and separately drove
`_reallyBeginTournamentMatch()` and `beginMarathonLeg()` directly (via the
real `/api/tournaments` and `/api/marathon/sessions` endpoints) — all five
constructed `game` objects now have zero missing trailer keys, including
`atcLastDart`/`atwLastDart` on the two previously-drifted sites. Backend
suite unaffected (1244 tests, same 6 pre-existing unrelated failures).

## Item 54 — One leg/set/game progression helper (8 pasted cascades) — ✅ Done

7 of the 8 `onLegWon*` handlers (Cricket, Baseball, Shanghai, Halve-It,
Pressure Chamber, Bob's 27, Killer) now delegate their `legsWon++ → set →
match` decision tree (webhooks, recordEvent trio, `completeGame`, Elo check,
`matchResult`, moment card, `finishUnit`) to a single `advanceLegSetGame(w,
opts)`. Each mode keeps only its own before/after badge checks and passes
whatever narrow set of options it genuinely differs on: `gate` (Cricket's
`!game.practice && ...`), `checkElo` (`false` for Bob's 27 and Killer, which
never call it), `opp`, `legsAtWin`, `extraGameWonBadge` (Cricket's Stone
Cold, Killer's Untouchable — both fire right before `matchResult` is set),
and `momentCard` (a function for a fully custom card — Bob's 27's
survived/died headline, Killer's own icon — or `false` for Cricket, which
has no moment card built yet; omitted for the 4 modes using the generic
`matchWinStatLine()` card).

X01's `onLegWon()` deliberately keeps its own copy, per this same roadmap's
standing convention against forcing an abstraction over a real behavioral
difference: its badge logic (Nerves of Steel, Giant Slayer, The Rematch,
Grudge Match, Ghost Slayer) is interleaved *inside* the set/match-won
branches themselves (not cleanly before/after), its practice/ghost-race/
marathon gate is its own three-way condition, `matchResult.bigFish` is a
real computed value instead of every other mode's hardcoded `false`, and its
leg-won tail handles Daily Challenge completion — folding all of that into
`advanceLegSetGame`'s options would need as many hooks as the function it
replaced, for zero simplification.

Verified live in a browser: constructed a minimal game object per mode and
called each `onLegWon*`/`onKillerLegWon` function directly (stubbing
`finishUnit` to capture its calls without needing full DOM rendering),
covering all three branches (leg-only, set-only, match-won) and confirming
the per-mode extras still fire — Cricket's Stone Cold, Killer's Untouchable,
Bob's 27's custom moment card — with `game.matchResult.kind` and the
`finishUnit` call correct in every case. Backend suite unaffected (1244
tests, same 6 pre-existing unrelated failures).

## Item 55 — Scoreboard/pad renderer scaffolding — ✅ Done

The five chalkboard renderers (Cricket/Baseball/Shanghai/Halve-It/Pressure
Chamber) now share `csHeadCellsHtml()` (the per-player head-cell column:
name, throw-chip, standing), `csTableInto(sb, headCells, bodyRowsHtml,
footLabel, footCells)` (the `.cs-table` head/body/foot assembly), and
`roundBannerInto(sb, text)` (the `.pp-meta` round banner Baseball/Shanghai/
Halve-It/Pressure Chamber all show — Cricket has none, Pressure Chamber
keeps its own extra custom card banner alongside this one). Each renderer
keeps only its own body-row loop (the genuinely different data: marks vs.
runs vs. points vs. totals vs. cp) and foot label/banner text.

The four single-target pads (Baseball/Shanghai/Halve-It/Bob's 27 — Cricket's
and Pressure Chamber's pads are structurally different, a multi-target grid
and a full 1-20+Bull grid respectively, so they're excluded from this
generalization) now share `renderSingleTargetPad(full, sector, label,
ariaLabel)` for the identical preamble (hide the dartboard, reveal the
multi-row, reset the pad) and Miss-button trailer; each mode keeps only its
own target/label computation (Halve-It's ring-prefixed D7/T10 label, Bob's
27's hardcoded `D${n}`).

`renderPad()`'s dispatch — 6 near-identical `if(gameType===...)` branches,
each repeating the same 2-line "sync the Undo button" snippet under a
different local variable name — collapses to a `MODE_PAD_RENDERERS`
`{gameType: renderer}` lookup plus a single undo-button sync at the end,
run regardless of which branch (or the default dartboard/pad path) fired.

Verified live in a browser: rendered all 5 chalkboard tables directly
(Cricket/Baseball/Shanghai/Halve-It/Pressure Chamber) with representative
player state and confirmed head-cell count, foot row, body-row count, and
banner text all match the original per-mode output (e.g. Baseball's "Inning
1 of 9 — target 1", Pressure Chamber's two stacked banners); rendered all 4
single-target pads and confirmed the button label matches exactly (plain
numbers for Baseball/Shanghai, "20" for an unrestricted Halve-It round,
"D5" for Bob's 27). Backend suite unaffected (1244 tests, same 6
pre-existing unrelated failures).

## Item 56 — Dart input/record helpers on the hottest path — ✅ Done

The dart-construction block (miss-fill vs `makeDart` + zone/miss/bounce
stamping + `mult=1; updateMultUI()`) is copied in `throwDart`,
`throwDartPressureChamber`, `throwDartCheckoutTrainer` (+ the stamping in
`throwDartKiller`); the single-dart `DB.recordTurn` payload is cloned in five
per-dart modes. **Shape:** `pushThrownDarts(...)` and
`recordSingleDartTurn(...)` helpers — zone-metadata encoding rules then live
once.

## Item 57 — Frontend efficiency batch

(a) `fireMomentCard()` unconditionally paints + JPEG-encodes an 800×800
canvas (~10-30ms main-thread jank + ~250KB POST) and `sendHaWebhook()` fires
a no-op POST per bust/180/leg even when no webhook is configured — expose a
"webhook configured" flag in the boot settings fetch and skip client-side;
(b) `renderPad()` recreates all 22 pad buttons + closures on every dart tap —
build once, toggle `.disabled` (the dartboard branch's own pattern);
(c) `playerSnapshotChuckin()` re-serializes the entire session heatmap into
every per-dart live push — cache and invalidate on change.

## Item 58 — Declarative settings field table — ✅ Done

`renderSettings()`'s loader and `saveSettings()` hand-maintain parallel
per-field lists (13 HA webhook fields, 7 voice checkboxes, 8 numerics/toggles
— the loader even already has a `voiceMap` table shape). **Shape:** one
`SETTINGS_FIELDS` array `{key, id, kind, default}` driving both directions;
a new setting then can't be added to save but not load.

## Item 59 — Conventions: badge predicates + DB wrapper boundary — ✅ Done

Ten pure badge predicates (hattrick, triplebull, nocigar, …) live inline in
`CHAIN_CHECKS` against the file's own stated convention (culture predicates
moved to scoring.js "so they're covered by a committed test"); move them and
add tests. And the `DB.*` wrapper boundary is unprincipled — three do-nothing
pass-through GET wrappers vs ~122 direct `Backend.get` calls and split
player-mutation homes; either drop the dead wrappers or write the rule down.
