# Code-Quality Refactors — deferred review findings

> **Status: OPEN — nothing here is started.** Every item below is tracked
> individually on `docs/open-roadmap-items.md` (items 35–45). This doc is the
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

## Item 35 — Consolidate the 16 `undoLastTurn*` trailers

Every per-game-type `undoLastTurn*()` in `frontend/index.html` ends with the
same ~14-line trailer: mark `snap.voided`, revoke `snap.badgeReverts`, call
`cancelQueuedAchievementsForSnapshot(snap)`, reset `game.darts`/`busted`/
`won`, `DB.deleteLastTurn()`, set a status message, re-render, `pushLive()`.
Sixteen copies exist (≈ index.html 10471, 11037, 11263, 11356, 11458, 11768,
11925, 13419, 13622, 13857, 14203, 14886, 15176, 15477, 15618) and they have
**already drifted**: some copies skip `pushLive()` (Gauntlet, Chuckin,
Checkout Trainer, ATC/ATW — partly deliberate, partly incidental) and some
skip the `game.current` restore.

**Shape:** one `_finishUndo(snap, renderFn, {msg, restoreCurrent, push})`
helper; each mode's function keeps only its game-specific field restores.
The deliberate per-mode differences become explicit options instead of
silent omissions. A fix to the undo protocol (a second badge-revert kind, a
webhook cancel) then lands once instead of 16 times.

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

## Item 38 — `savedGamePositionLabel()`: dispatch on `sg.gameType`, not field presence

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

## Item 39 — Derive `NON_SAVABLE_GAME_TYPES` from the backend registry

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

## Item 41 — `games.category` as a registry member

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

## Item 43 — Id-keyed killer configs (end the name-rewrite class)

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
