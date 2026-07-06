# Preparing the Existing App for Future Roadmaps

> Status: **in progress** (8 of 11 of this doc's own items done/adopted, 1 more
> confirmed-and-closed — see items 2, 3, 4, 7, 8, 9, 10, 11 (done/adopted) and item 5
> (confirmed protected through item 10's refactor)). Item 1 (the shared game-scope
> helper) is now partially done — see its own status note. Item 6
> (player-deletion-guard extensibility) remains deliberately not started — no
> feature needing it has landed yet.
>
> This doc reviews the other roadmap docs in `docs/` and recommends changes to the
> *existing* codebase now, specifically to reduce rework later. It intentionally does
> not recommend building any future feature early — only making the current code more
> hospitable to features that are still just plans.
>
> Its "Roadmap sequencing" table further down is also the **central completion
> tracker for every roadmap doc in the project** — every doc's done/partial/
> not-started status lives there, and fully-finished docs are archived to
> `docs/archive/` once every item in them is done. See `CLAUDE.md`'s "Roadmap docs"
> section for the standing convention that keeps this current.

## How to read this

Each recommendation below is backed by a concrete pattern found across multiple
roadmap docs, with the actual code location that would need to change. They're
ordered roughly by leverage (how much future rework each one avoids), not by how easy
they are. A prioritized "do now / keep in mind" summary is at the end.

---

## 1. Generalize the stats query layer beyond `practice`/H2H (highest leverage)

> **Status: Partially done.** The recommended shared helper now exists —
> `_scope({mode, gameType})` in `backend/db.js`, composing the existing `_mf(mode)`
> h2h/practice fragment with a whitelisted `game_type` dimension
> (`KNOWN_GAME_TYPES`). `X01_ONLY` is now `_scope({gameType:'x01'})` (byte-identical
> output, so its ~15 existing call sites needed zero changes), and **every one of
> Cricket's query functions** (`getCricketStatBubbles`, `getCricketNineMarksStats`,
> `getCricketMprLeaderboard`, `getCricketWinLeaderboard`, `getCricketPerfectLegStats`,
> `getCricketPersonalBests`, and 6 `getMetricHistory()` cases) routes through it
> instead of hand-rolling its own `AND g.game_type='cricket'` — this closes the gap
> Cricket's own build concretely re-created (it had temporarily reintroduced ~24
> ad-hoc inline `game_type='...'` literals before this retrofit). Verified
> byte-identical output via the existing scratch-DB regression suite (Cricket stats
> + X01 personal-bests/stat-bubbles unchanged).
>
> **Still open**: the ~15-20 pre-existing mode-only query sites (`computeStats`,
> `getSummary`, `getHomeExtra`, `getPersonalBests`, pace, etc.) still call `_mf(mode)`
> directly rather than `_scope({mode})` — they were left untouched as out of scope
> for this pass (higher regression risk on mature, already-shipped code, and no
> current feature needs it). A genuinely new *universal* dimension (e.g. excluding
> online matches from every stat, not just Cricket's) would still need to touch
> those sites individually to route them onto `_scope()` first. Cricket's own
> dimension is fully centralized; the older mode-only dimension is not yet.

**The evidence**: `backend/db.js` currently hardcodes the pattern
`g.practice = 0/1` (almost always paired with a `game_players` count check to
distinguish solo practice from multiplayer) in **over 20 separate queries** —
`getSummary`, `computeStats`, `getHomeExtra`, `getPersonalBests`, pace calculation,
nine-darter detection, and more. Every one of these treats "practice vs. H2H" as the
only scope a game can belong to.

**Why this matters for the roadmap**: at least four other roadmap docs need a
*different* scoping dimension on top of this:
- `game-modes-roadmap.md` needs to filter/aggregate by `game_type` (X01 vs. Cricket
  vs. Baseball each need their own stat vocabulary).
- `online-multiplayer-roadmap.md` needs online matches excluded from trusted H2H
  stats entirely.
- `league-mode-roadmap.md` needs standings scoped to games tagged with a specific
  league.
- `tournament-mode-roadmap.md` needs tournament matches to still count as normal H2H
  for overall stats, but potentially wants tournament-specific views later
  (best tournament finish, etc.).

If each of these is built by copy-pasting a new condition into the same 20+ query
sites `practice` already appears in, that's exactly the repeated rework the roadmap
process was meant to avoid.

**Recommendation**: extract a small, shared "game scope" filter-building helper in
`db.js` — something that produces the SQL fragment for a given combination of
dimensions (mode: h2h/practice, game_type, online/local, league membership) instead
of each stats function hand-rolling its own `WHERE` clause. This doesn't require
building the dimensions that don't exist yet (game_type, online, league) — it just
means the *next* dimension to land only touches the helper, not 20 call sites.

---

## 2. Add `games.game_type` and `games.config` now (cheap, additive, zero behavior change)

> **Status: ✅ Done** (see `backend/db.js` on `dev`). Added via the same additive
> `ALTER TABLE` pattern as `practice`. `createGame()` now writes `game_type='x01'`
> and `config='{"startingScore": ...}'` for every game — hardcoded, since no
> game-mode selection exists yet. Verified fresh installs and existing databases
> both migrate cleanly, and that every existing stats/summary endpoint is
> byte-for-byte unchanged.

**The evidence**: `game-modes-roadmap.md`'s entire schema design depends on this
split existing. `games.practice` itself was added exactly this way — an additive
`ALTER TABLE games ADD COLUMN practice INTEGER NOT NULL DEFAULT 0` (`backend/db.js`
line 132) — so there's already a proven, safe pattern for this in the codebase.

**Recommendation**: add `game_type TEXT NOT NULL DEFAULT 'x01'` and
`config TEXT` (JSON) to `games` now, with every existing code path continuing to
write `game_type='x01'` and leaving `config` null or populated with
`{startingScore: ...}`. This is a no-op for current behavior, but means the
game-modes roadmap's Phase 1 (the X01-to-plugin refactor) starts from a schema that
already exists, instead of bundling a migration into that same refactor. (That Phase
1 refactor is itself done now too — see item 10.)

---

## 3. Convention: link new game *contexts* into `games`, don't add a new boolean per feature

> **Status: ✅ Adopted** as a binding project convention in `CLAUDE.md`, so it
> persists across sessions rather than depending on this doc being re-read. No code
> change was needed — the next feature that needs a new context (online
> multiplayer, or anything not yet designed) just follows this pattern from the
> start.

**The evidence**: `tournament-mode-roadmap.md` already does this correctly —
`tournament_matches.game_id` points at a normal `games` row, rather than adding an
`is_tournament` column to `games` itself. `league-mode-roadmap.md` proposes the
same shape (`games.league_id` nullable FK). `online-multiplayer-roadmap.md` doesn't
fully spell this out, but should follow the identical pattern (a small
`online_matches` table with its own `game_id` FK) rather than adding an `is_online`
column directly to `games`.

**Recommendation**: no code change needed right now, but worth stating explicitly as
a house convention before three different future contributors independently decide
to bolt three different boolean columns onto `games`. `games` stays the universal
record of "a match was played"; anything context-specific (which tournament, which
league, which online session) lives in its own table pointing *at* `games`, never the
other way around.

---

## 4. A lightweight game-lifecycle hook point

> **Status: ✅ Done** (see `backend/db.js`). `onGameCreated(fn)`/`onGameCompleted(fn)`
> register listener callbacks against two small internal arrays; `createGame()`/
> `completeGame()` each fire theirs (`_fireGameLifecycleHooks(event, payload)`)
> synchronously, in registration order, right after their core DB write. A listener
> that throws is caught and logged (`console.error`), not rethrown — one broken
> future feature can't take down game creation/completion itself, and later
> listeners still run. Payloads: `created` gets `{gameId, gameType, practice,
> category, playerCount}`; `completed` gets `{gameId, winnerName}` (`null` for an
> unfinished/no-winner game). No listeners are registered yet — this is pure
> infrastructure ahead of the next feature that needs one (environmental logging,
> tournament bracket advancement, etc.), exactly as recommended below. Verified
> with a scratch-DB test: payload shape for both X01 and Cricket games, a
> deliberately-throwing listener not breaking `createGame()`'s return value or
> blocking a second listener registered after it, and a live-server smoke test
> confirming zero behavior change with no listeners registered (the common case
> today). This does **not** retrofit the existing client-side achievement checks
> (`frontend/index.html`'s `enterTurn()`/`onLegWon()`) — those are a different
> layer (client-side turn commit, not backend game create/complete) and were
> intentionally left alone.

**The evidence**: multiple roadmaps need to react to "a game started" or "a game
completed" beyond what happens today:
- `environmental-logging-roadmap.md` starts/stops HA polling on game start/end.
- `tournament-mode-roadmap.md` propagates the winner into the next bracket match on
  game completion.
- `achievements-badges-roadmap.md` (21 of 21 original candidate badges shipped,
  plus a 22nd, Staircase Finish, added afterward; see its own status for the
  one still-open notification-plumbing item) needed milestone badges to check
  conditions after a game completes — this item's recommendation (a generic hook
  mechanism) still wasn't built; achievement checks are inline in `enterTurn()`/
  `onLegWon()` instead, so this need is still real for the *next* feature that wants
  a post-completion hook.

Today, `createGame`/`completeGame` in `db.js` are plain functions called directly
from `server.js` — reasonable for one thing happening on completion (marking a
winner), but each new feature that also wants to react to that event would mean
editing the same function again, and stacking unrelated concerns (HA polling,
bracket advancement, badge checks) directly into the core game-completion path.

**Recommendation**: introduce a minimal internal hook/listener mechanism around
`createGame`/`completeGame` (e.g. a small array of callback functions invoked after
the core DB write, similar in spirit to how `fireHaWebhook` is already called
alongside the core turn/game logic rather than embedded inside it) so future features
register their own reaction without repeatedly modifying the same core functions.

---

## 5. Protect the `throwDart(sector, multiplier)` input primitive

> **Status: ✅ Confirmed protected.** Now that item 10's refactor has actually
> happened, this held: `throwDart(sector)` (`frontend/index.html`) is untouched by
> it — still just pushes a dart into `game.darts`, with zero awareness of
> `game.gameType`. Only `enterTurn()`'s call into
> `GAME_TYPES[game.gameType].evaluateVisit(...)` decides what a game type does with
> that dart. So "where did this dart event come from" and "what does this game type
> do with it" stayed cleanly separate through the refactor, as this item asked.

**The evidence**: this is the thing already working correctly across the roadmaps,
worth calling out so it's *protected* rather than accidentally broken during other
refactors. `camera-scoring-roadmap.md` and `archive/ghost-opponent-roadmap.md` (now
shipped) both depend on
being able to inject a `(sector, multiplier)` dart event from a non-tap source (a
vision service; a scripted historical replay) into the exact same pipeline a manual
tap uses today.

**Recommendation**: when the game-modes plugin refactor (item 2 above, and its own
roadmap's Phase 1) happens, make sure "where did this dart event come from"
(tap, camera, ghost script) stays a clean, separate concern from "what does this
game type do with a dart event" (X01 decrement, Cricket marks, Baseball runs). If
those two concerns get tangled together during that refactor, camera scoring and
ghost opponent both get harder later. No code change needed today — just a
constraint to keep in mind when that refactor happens.

---

## 6. Extend the player-deletion-guard pattern

**The evidence**: this session already added orphaned-game cleanup to
`deletePlayer()` in `db.js`. Both `tournament-mode-roadmap.md` and, implicitly,
`league-mode-roadmap.md` need to *block* deleting a player who's actively referenced
elsewhere (mid-tournament, mid-season), which is a different requirement (prevent
the action) rather than clean up after it.

**Recommendation**: no change needed until one of those features actually lands, but
worth designing `deletePlayer()`'s future guard as a small, growing list of "is this
player referenced by an active thing" checks rather than hardcoding tournament logic
directly into the function and then bolting league logic on top of that later.

---

## 7. Settings page is approaching flat-list overload

> **Status: ✅ Done.** Settings now has a `.player-tabs` row (reusing the same tab
> pattern already used 4 other places in this app — Home's H2H/Practice and
> X01/Cricket toggles, Player Profile's Overall/H2H/Practice and X01/Cricket
> toggles) with 4 groups, and every one of the 11 existing sections was placed into
> exactly one group with zero content changes: **Account & Access** (Admin
> Accounts, Player PINs), **Gameplay & Display** (Scoring, Accessibility, Voice
> Announcements, Shareable Moments, Data Collection, Live Scoreboard),
> **Integrations** (Smart Home Integration — sized to house
> `environmental-logging-roadmap.md`, `camera-scoring-roadmap.md`, and
> `online-multiplayer-roadmap.md`'s future sections), **Admin & Danger Zone**
> (Daily Challenge, Danger Zone). Implementation: a `settingsTab` state var + a
> `switchSettingsTab(tab)` function (mirrors `switchHomeGameType`) toggles the
> `hidden` attribute on 4 new `.settings-group` wrapper `<div>`s in
> `frontend/index.html`; each individual section's own markup, id, and
> independent `toggleSettingsSection` collapse/expand behavior is completely
> unchanged. Verified end-to-end with Playwright: every tab shows exactly its own
> group, every existing control (checkboxes, selects, buttons, webhook inputs,
> PIN/admin management, Daily Challenge reset, Danger Zone wipe) still works, and
> a section's own collapse toggle still works from within its group.
>
> Superseded history (kept for context): the prediction below already came true
> faster than expected — Settings grew from 7 to 11 flat collapsible sections
> before this grouping landed (Admin Accounts, Player PINs, Scoring Input,
> Accessibility, Voice, Sharecard, Data Collection, Scoreboard, Smart Home
> Integration, Daily Challenge, Danger Zone), none of it from the three roadmap
> features named below — all from shipped work this doc didn't anticipate
> (accessibility, voice announcements, shareable moments, Daily Challenge admin
> reset).

**The evidence**: Settings currently has 7 collapsible sections (Admin Accounts,
Player PINs, Scoring, Data Collection, Live Scoreboard, Smart Home Integration,
Danger Zone). At least three roadmap docs want their own new section:
`environmental-logging-roadmap.md`, `camera-scoring-roadmap.md`, and
`online-multiplayer-roadmap.md` (TURN credentials). That's 10+ flat sections before
counting anything else.

**Recommendation**: worth considering a grouped Settings navigation (e.g. General /
Integrations / Advanced-Danger) before adding the next few sections, rather than
continuing to append to one long flat list. Not urgent today, but cheaper to
restructure now with 7 sections than later with 12.

---

## 8. Phone-responsive CSS pass (already flagged in the mobile roadmap, worth elevating)

> **Status: ✅ Done** (see `frontend/index.html` on `dev`). Testing at 320-390px
> viewports found and fixed three real overflow bugs: the achievement overlay
> (180/Big Fish/nine-darter celebrations) used fixed 64px/88px fonts with no padding,
> overflowing off-screen on phones — now uses `clamp()`, unchanged at desktop width.
> The Scoreboard Layout and Default Scoring Input `<select>` elements sized
> themselves to their widest `<option>` text, forcing the whole Settings page wider
> than the viewport — fixed with `max-width:100%` on `.date-input`. The Home
> Assistant URL input + Test Connection button didn't wrap, clipping the button
> off-screen — now wraps. Also added a scroll-fade affordance to the nav bar, which
> already scrolled horizontally on narrow screens but gave no visual hint of it. New
> Game, both scoring input modes (Pad and Dartboard), Players, and Add Player were
> already responsive and needed no changes.

**The evidence**: `mobile-app-roadmap.md` already calls this out as "independently
valuable and shippable even before any native wrapper exists," since the current UI
is tablet-first (per the README's own description of the Scoring screen). It's worth
elevating here because it also benefits *every other* roadmap that adds a new screen
— a tournament bracket view, a camera-calibration wizard, a coaching-insights panel —
all of which are cheaper to build mobile-responsive from day one than to retrofit
after several more screens exist on top of the current tablet-only assumptions.

**Recommendation**: treat this as a near-term, standalone task, not something to wait
on the mobile-app project specifically to justify.

---

## 9. Deployment structure for optional future services

> **Status: ✅ Adopted.** Cross-referenced directly in `camera-scoring-roadmap.md`
> and `online-multiplayer-roadmap.md` (the two docs that will actually need it),
> rather than in `CLAUDE.md` — lower near-term violation risk than item 3 since it
> only applies once one of those two specific, clearly-flagged projects actually
> starts, so it doesn't need every-session visibility. Also verified
> `docker-compose.yml` has no pinned old `version:` field, so it's already
> compatible with the Compose `profiles:` key whenever a service needs one — no
> blocker waiting to be discovered later.

**The evidence**: `camera-scoring-roadmap.md` (a Python vision service) and
`online-multiplayer-roadmap.md` (a signaling relay) both introduce a second process
alongside the existing single Node container — a real departure from today's
one-service `docker-compose.yml`.

**Recommendation**: no change needed now, but when either of those lands, use Docker
Compose profiles (or separate compose files, matching the existing
`docker-compose.dev.yml` convention) so a user who wants neither camera scoring nor
online multiplayer never has those services running. Worth deciding this convention
once, deliberately, rather than each feature inventing its own approach to "optional
service."

---

## 10. Pull the X01-to-plugin refactor forward, decoupled from shipping Cricket

> **Status: ✅ Done** (see `frontend/index.html`/`backend/db.js` on
> `claude/dev-branch-commits-bvcxjj`; also recorded in `game-modes-roadmap.md`'s
> build-order step 1). A `GAME_TYPES` registry now holds X01's `newMatchPlayer`,
> `evaluateVisit`, `resetForNextLeg`, `playerSnapshot`, and `statDefs`; every call
> site dispatches through `GAME_TYPES[game.gameType]` instead of calling those
> functions directly, and `createGame()` accepts optional `gameType`/`config`
> instead of hardcoding them. Verified behavior-identical to pre-refactor X01 via
> Playwright and db.js unit tests. This was done as its own project, *before*
> ghost-opponent or camera-scoring exist, per the recommendation below — so both of
> those can build their "scripted/simulated dart source" on the same seam instead of
> each inventing its own. Achievements and the scoring-screen UI were deliberately
> left X01-specific (see item 5's note on that separation) since there's still no
> second game type to abstract them against yet.

**The evidence**: `game-modes-roadmap.md`'s own build order lists "extract the
existing X01 logic behind the plugin interface, no behavior change" as its Phase 1,
treating it as step one of *shipping Cricket*. But looking across the full roadmap
set, that same refactor is also exactly what `archive/ghost-opponent-roadmap.md` and
`camera-scoring-roadmap.md` need — both are, at their core, "a dart event from a
non-tap source" (a scripted historical replay; a vision service), which is precisely
the "where did this dart event come from" vs. "what does this game type do with it"
separation item 5 above already flags as worth protecting.

If ghost-opponent or camera-scoring get built before this refactor happens, each will
invent its own version of "inject a dart from somewhere other than a tap," and the
later game-modes refactor then has to reconcile two ad-hoc solutions instead of
establishing one clean one from the start.

**Recommendation**: treat the X01-to-plugin extraction as its own near-term prep
project — the same way `games.game_type`/`config` (item 2) was pulled forward — 
*without* committing to build Cricket's rules, UI, or stats parity yet. This is a
real, non-trivial chunk of work (unlike items 2/8/9, which were cheap), so it
shouldn't be understated, but doing it once, early, de-risks three separate future
features (Cricket, ghost-opponent, camera-scoring) instead of just one.

---

## 11. Orientation-aware live scoreboard (portrait vs. landscape) — needed before Cricket's dedicated scoreboard

> **Status: ✅ Done** (see `frontend/display.html` on `claude/dev-branch-commits-bvcxjj`).
> `window.matchMedia('(orientation: portrait)')` drives an `orientation-portrait`
> body class, with the live snapshot cached (`lastSnapshot`) so a rotation
> re-renders immediately from the matchMedia `change` listener alone — no separate
> `resize`/`orientationchange` handler needed, and no wait for the next server push.
> The player-card grid forces a single column in portrait (was previously always
> 1/2/3 columns by player count regardless of orientation); the top bar wraps
> instead of overflowing. Applies to both the live grid and the between-leg summary
> cards, since both render through the same `#grid` container. Verified with
> Playwright: resizing an already-open `/display` tab from 1280×800 to 800×1280
> (simulating a live rotation, no new server push) correctly collapsed a 2-player
> grid from 2 columns to 1, repopulated with the same live data, and reverted
> cleanly back to 2 columns on rotating back — for both the live per-player grid
> and a between-leg summary-card screenshot. `docs/game-modes-roadmap.md`'s Cricket
> scoreboard step (build-order step 2) can now build `renderers.cricket` on top of
> this instead of needing its own separate retrofit.

**The evidence**: `frontend/display.html` has zero orientation-handling today — no
`orientation` media query, no `matchMedia`, no `resize`/`orientationchange` listener
anywhere in the file (confirmed: no matches). Its only concept of "adapt to the
screen" is the admin-chosen Full/Compact/Minimal density setting (`LAYOUTS` in
`display.html`) — a manual content-density choice, not a response to the physical
orientation of whatever device is actually displaying it. A tablet or spare phone
mounted in portrait gets the same grid shape as one mounted in landscape, just
reflowed by the browser's own default wrapping rather than a deliberately designed
portrait layout.

`game-modes-roadmap.md`'s Cricket scoreboard (see its "Decisions made" and
"architecture" sections) is a brand-new screen with a genuinely different content
shape — a marks/closed grid per in-play number, not a single countdown number —
exactly the kind of screen where getting portrait vs. landscape right from day one
is far cheaper than retrofitting later, the same argument item 8 (phone-responsive
CSS) already made for screen *width*. Building Cricket's scoreboard without an
orientation concept first means X01 and Cricket end up with two different
half-finished answers to the same problem, the exact rework pattern item 10 avoided
for the turn-engine seam.

**Recommendation**: build this as its own prep project, *before* Cricket's
scoreboard work (`game-modes-roadmap.md` build-order step 2) starts — the same
build-order-dependency treatment item 10 got. Concretely:
- Retrofit the *existing* X01 renderer in `frontend/display.html` to detect
  orientation (`matchMedia('(orientation: portrait)')`, plus a listener for
  `orientationchange`/`resize` — not just a one-time check at load, since a mounted
  tablet or phone can be rotated mid-match) and ship a genuine portrait layout, not
  just the existing landscape-shaped grid narrowed down by the browser's default
  reflow.
- Verify on a real device or an emulated viewport in both orientations, for both the
  live per-player grid and the between-leg/game summary cards.
- Once this seam exists and X01 proves it out, a future `renderers.cricket` entry
  gets orientation support from the start instead of needing its own separate
  retrofit later.
- This doesn't block Cricket's *engine* work (turn engine, win condition, New Game
  config UI) — only the live-scoreboard-renderer piece of build-order step 2 needs
  it done first.

---

## What's already well-positioned (no prep needed)

Worth naming explicitly, since not everything needs a change:

- The `darts` table (sector, multiplier, dart number) is already fully game-agnostic
  — the game-modes and camera-scoring roadmaps both depend on this being true, and it
  already is.
- The live snapshot already carries a `gameType` field and `display.html` already has
  a `renderers` dispatch table keyed by it, built during the recent scoreboard
  redesign specifically so this wouldn't need revisiting later — confirmed during
  item 10's refactor, which needed zero changes to `display.html` as a result.
- The `practice` boolean's additive-migration history is itself the proof that
  schema changes like `game_type`/`config` (item 2) are low-risk in this codebase.

## Priority summary

**Worth doing soon, independent of any specific roadmap landing:**
1. ~~Phone-responsive CSS pass (item 8).~~ ✅ Done.
2. ~~Add `games.game_type`/`games.config` columns, defaulted to today's behavior
   (item 2).~~ ✅ Done.

**Worth adopting as a stated convention now, cheap to write down, expensive to
un-learn later:**
3. ~~Context tables link into `games` via FK, never a new boolean on `games`
   (item 3).~~ ✅ Adopted — see `CLAUDE.md`.
4. ~~Docker Compose profiles for future optional services (item 9).~~ ✅ Adopted.

**Worth pulling forward as its own project, ahead of committing to ship Cricket:**
5. ~~The X01-to-plugin refactor (item 10)~~ ✅ Done — de-risks Cricket,
   ghost-opponent, and camera-scoring at once rather than one at a time, and now
   sits in place *before* either of the other two starts. See the Roadmap
   Sequencing section below.
6. ~~Orientation-aware live scoreboard (item 11)~~ ✅ Done — retrofit the existing
   X01 scoreboard with portrait/landscape detection *before* Cricket's own
   scoreboard is built, so Cricket gets orientation support from day one instead
   of a second retrofit.

**Worth doing when the first feature that needs it actually starts:**
7. Stats query scope helper (item 1) — needed the moment game-modes, online
   multiplayer, or league mode starts real implementation, but not before.
8. Game-lifecycle hook point (item 4) — same timing.
9. Player-deletion-guard extensibility (item 6) — same timing.

**Already confirmed, no action needed:**
10. ~~Protecting the `throwDart` input-source separation during the eventual
    game-modes refactor (item 5)~~ ✅ Confirmed — item 10's refactor landed and the
    separation held.

**Done:**
11. ~~Settings page regrouping (item 7)~~ ✅ Done — 4-group `.player-tabs` navigation
    over the same 11 sections, see item 7's own status note.

---

## Roadmap sequencing: complexity vs. usefulness

**This table is the central completion tracker for every roadmap doc in `docs/`** —
the single place to check what's done and what's outstanding across the whole
project, so no individual doc's header has to be hunted down and re-read to answer
that question. It's kept current in the same change that finishes or advances any
roadmap (per the standing convention below), not as a periodic audit. Fully-finished
docs are moved to `docs/archive/` (see each row's path) but stay listed here so the
ledger itself never loses history.

Ranks each doc on build complexity and real usefulness, and calls out build-order
dependencies between them, in one pass across every roadmap doc in `docs/` —
including the cross-cutting engineering-health docs (accessibility, backups,
security, testing) alongside the feature roadmaps, since in practice they compete
for the same "what do we build next" attention.

| Roadmap doc | Status | Complexity | Usefulness | Notes |
|---|---|---|---|---|
| `docs/archive/colorblind-mode-roadmap.md` | ✅ Done | Very low | Medium (narrow, real) | CSS-only, genuine accessibility fix |
| `docs/ha-recipes-roadmap.md` | Not started | Trivial (docs only) | Medium | Zero code, unlocks power that already shipped — the promised recipe content was never written |
| `docs/security-hardening-roadmap.md` | ✅ Done | Very low | High | Admin login rate limiting (v0.6.2) + `OCHE_REQUIRE_AUTH` for all gameplay/roster writes. SEC-7 (webhook auth, 2026-07) closed the last open item — `POST /api/ha-webhook` now uses the same `requireWrite` gate as every other write endpoint. The standing checklist for future credentials/secrets remains ongoing practice, per CLAUDE.md |
| `docs/data-export-roadmap.md` | Not started | Very low | Medium | Reformats existing queries; reinforces the self-hosted trust story |
| `docs/archive/voice-announcements-roadmap.md` | ✅ Done | Very low | Medium-High | Browser API only, zero infra; i18n left to its own follow-on doc (next row) |
| `docs/voice-announcements-i18n-roadmap.md` | Not started | Low-Medium | Low-Medium | Follow-on to the shipped feature; every phrase is still hardcoded English |
| `docs/backups-roadmap.md` | Partial | Low | Very high | v1 (script + retention + restore docs) done (v0.6.2); v2 (compose sidecar, restore UI/endpoint) not started |
| `docs/shareable-moments-roadmap.md` | Partial | Low | Medium | Card generation, every trigger point, and the HA webhook are done; Profile "Moments" gallery and BYO-credentials X auto-post are not |
| `docs/achievements-badges-roadmap.md` | Partial | Low | Low | **21 of 21 original candidate badges shipped**, including **No Cigar** (2026-07, bust a visit that hit the exact score needed but not on a double), plus a 22nd badge, **Staircase Finish** (2026-07, user-requested, added after the original candidate list — check out in exactly 3 darts by halving the target twice), shipped on top; the doc stays out of `docs/archive/` because its own "notifications and shareable cards" section still has one open item — threading the award count into the live overlay itself (the shareable moment card already shows it) |
| `docs/archive/simultaneous-achievements-roadmap.md` | ✅ Done | Low | Medium | Fixed the single-slot achievement-overlay bug; built alongside achievements/badges |
| `docs/daily-challenge-roadmap.md` | Partial | Low | Medium | Built entirely on the existing Practice engine. **Un-archived (2026-07)**: 3 new Daily-Challenge-specific badges (Challenge Streak: Week/Month, Full Rotation) and a dedicated Player Profile tab (promoted from a collapsible section duplicated inside every other tab) were added per an explicit "stats, reporting, badges, and achievements for daily challenges" request |
| `docs/archive/ghost-opponent-roadmap.md` | ✅ Done (X01 only) | Low-Medium | Medium | A "👻 Ghost" New Game mode races a replay of one of your own past won X01 legs — backend leg-script/candidate-leg queries, a New Game leg picker, a Player Profile "Race this leg" entry point, opponent-badge suppression (Comeback Kid etc. can't fire against a ghost), and full Playwright verification (both a ghost-wins and a human-wins race). Cricket ghost support explicitly deferred. **Archived (2026-07)** — nothing outstanding |
| `docs/coaching-insights-roadmap.md` | Not started | Low-Medium | High | No new data collection; genuinely differentiating vs. competitors |
| `docs/testing-and-observability-roadmap.md` | ✅ Done (v1 scope) | Medium | High | Part A (server-side error logging, a persistent rotating log, a Settings "Server Errors" view) and Part B (a real, committed `node:test` suite — `frontend/scoring.js`'s extracted scoring logic, plus 10 `backend/db.js` suites covering X01/Cricket stats, leaderboards, checkout/dart-analytics, On This Day, H2H, Daily Challenge, badges, lifecycle hooks, `addTurn()` validation, auth, and player/settings CRUD — 161 assertions total, run via `npm test` and CI on every push) are both done for their stated scope. Writing the suite found and fixed 3 real bugs (`addTurn()` silently coercing invalid `0`/garbage input instead of rejecting it; `addPlayer()` missing an `await` on its PIN-hash write). Not exhaustive by design — e.g. genuine concurrent-request lockout races aren't exercised — extended per CLAUDE.md's standing convention whenever next touched |
| `docs/accessibility-roadmap.md` | ✅ Done (all 5 identified gaps) | Low-Medium | High | Colorblind mode, the WCAG contrast audit (found/fixed 4 real AA failures — `--green`/`--bust` brightened, a new `--red-text` for the Pad's "Bull" label, a colorblind-mode fix to the dartboard's own "Bull" center label), `aria-live` announcements on the controller, accessible-input-path framing for `default_scoring_input` (Settings copy + README + REFERENCE.md), and a type-size pass (2 genuine 9px outliers bumped, the rest of the compact tier deliberately kept). Stays in `docs/` (not archived) — it's a standing cross-cutting checklist per CLAUDE.md, not a completable one-off; two open design questions (display.html's `aria-live` investment, `polite` vs `assertive` tuning) remain for whoever picks them up |
| `docs/league-mode-roadmap.md` | Not started | Medium | Medium-High | New tables, no new infra; complements tournament mode |
| `docs/mobile-app-roadmap.md` | Partial | Medium | High | Its one prerequisite (responsive CSS pass) is done; the native app itself (Capacitor scaffold, packaging, distribution) is not started |
| `docs/tournament-mode-roadmap.md` | Not started | Medium-High | High | Bracket generation (especially double-elim) is genuinely fiddly, but fully self-contained — reuses the scoring engine unchanged |
| `docs/security-audit-roadmap.md` | ⏳ Partial (reopened) | Low | High | SEC-1..SEC-11 fixed. A 2026-07 second-pass audit (Part 4) opened **SEC-12 (stored XSS via a player name in Settings → PIN management, OPEN — fix first), SEC-13 (player-name bounds), SEC-14 (validate/bound write inputs)**. See that doc's Part 4 |
| `docs/bug-roadmap.md` | ⏳ Open | Low | Medium | New functional-defect tracker (2026-07), counterpart to the security-audit doc. Seeds: BUG-1 (Daily Challenge date/format not validated on write), BUG-2 (`createGame` accepts unknown `gameType` → cross-type stat skew), BUG-3 (admin-username onclick escaping, cross-ref SEC-12). All LOW/latent |
| `docs/environmental-logging-roadmap.md` | Not started | Medium | Low (self-admittedly niche) | New inbound HA auth model, but explicitly scoped as a niche, manually-enabled feature |
| `docs/game-modes-roadmap.md` | Partial | Very high | Very high | Steps 1-4 done: X01-to-plugin refactor, Cricket fully playable (turn engine, New Game classic/custom config, dedicated scoring screen, chalkboard scorecard live scoreboard), Cricket stats parity (MPR + 5 more stat bubbles, Personal Bests via new `turns.leg_won` column, 2 achievements), and Home/Player Profile game-type navigation (X01/Cricket toggles on both, Home's own MPR/Most-Wins/9-Marks/Perfect-Leg leaderboard set). Step 5 (Baseball) not started. **Step 7 done (2026-07): Doubles Practice** — the first Practice Drill Mode, per-dart evaluation (`evaluateDartDoublesPractice()`), "all simultaneously live" multi-doubles, its own 3 stat bubbles + Personal Bests, New Game target picker, dedicated scoring screen, and a `display.html` renderer. Its previously-deferred gaps are now closed too (2026-07): undo support (`undoLastTurnDoublesPractice()`, same snapshot convention as X01/Cricket) and a 2-board Home page leaderboard set (Doubles %, Best Round) — only achievements/badges for this mode remain unbuilt (none requested). **Step 8 done (2026-07): 101 as a fourth X01 starting score** — the picker is now a `<select>` (501/301/170/101) rather than 3 buttons; `OPENING_CATS` already scoped 101 from an earlier decision, so no backend follow-up was needed. **Step 6 done (2026-07): the Player Profile/Home page game-type toggle is now N-way** — `GAME_TYPES` gained `label`/`personalBestsRenderer`/`homeTabRenderer`/`bubbleKeyMap` fields, and both toggles render via a filtered `Object.values(GAME_TYPES)` map instead of hardcoded per-type buttons; the Home page's toggle row (previously static HTML) is now populated by `renderHomeGameTypeTabs()`. Only the *toggle mechanism* is generalized — each type's backend stat-fetch functions stay bespoke, a deliberately separate, still-open design problem (see the doc's own section). **Step 9 done (2026-07): Just Chuckin' It** — the second Practice Drill Mode, no round/leg concept at all (one continuous stream of 1-dart turns per session), heatmap-first Player Profile stats (`getChuckinStatBubbles`/`getChuckinPersonalBests`/`getChuckinHeatmap`, a non-interactive dartboard heatmap), a `NOT_CHUCKIN` SQL exclusion audit across 5 previously-unscoped queries with total-darts-thrown as the one deliberate exception, and 18 laddered milestone achievements generated from a single data-driven ladder array (`CHUCKIN_MILESTONE_LADDERS`) — checked entirely from local per-player state after a Playwright-caught bug showed a per-dart network check could trip the server's rate limiter and silently lose darts. `homeTabRenderer:false` opts it out of the Home page leaderboard toggle specifically (Player Profile toggle unaffected). **Still open**: Baseball (step 5) |
| `docs/online-multiplayer-roadmap.md` | Not started | Very high | High *but conditional* | Needs someone else running their own Oche instance too — a real adoption chicken-and-egg problem that caps near-term value regardless of build quality |
| `docs/camera-scoring-roadmap.md` | Not started | Extremely high | High *but narrow* | Genuinely novel CV engineering; only useful to whoever actually mounts the hardware |
| `docs/companion-website-roadmap.md` | Not started (new, 2026-07) | Extremely high | High *but conditional* | The one roadmap item requiring the project itself to operate persistent hosted infrastructure (accounts, matchmaking, a cloud database) indefinitely, not just a self-hostable relay — value is capped by someone actually running and paying for that long-term. Relates to but doesn't duplicate `online-multiplayer-roadmap.md` (live P2P transport), `tournament-mode-roadmap.md`/`league-mode-roadmap.md` (local-only bracket/standings logic this doc's cross-instance version would extend), and `daily-challenge-roadmap.md` (the one stat already deterministic/comparable across instances with zero drift risk, making it the suggested first global leaderboard) |

Also archived, not part of the complexity/usefulness ranking since it's a session
punch-list rather than a design doc: `docs/archive/next-session-plan.md` — ✅ Done,
all 3 items shipped, fully superseded by the achievements-badges and
simultaneous-achievements rows above.

### Build-order dependencies worth acting on

1. ~~**Game-modes' Phase 1 (the X01→plugin refactor) should happen before
   ghost-opponent and camera-scoring**~~ ✅ **Done** — see item 10 above. This was the
   single most important sequencing call in the whole set: all three features are
   variations of "a dart event from a non-tap source," and it's now solved once,
   ahead of any of the three being built, instead of needing two ad-hoc solutions
   reconciled later. Ghost-opponent and camera-scoring can now build on
   `GAME_TYPES`/`game.gameType` directly rather than each inventing their own hook.
2. **Tournament mode before league mode.** Not a hard dependency, but tournament
   mode is the more specifically-requested one, and building it first gives league
   mode's "games link into a context table" pattern (item 3) a real precedent to
   follow.
3. **Mobile app has no blockers at all**, and its only prerequisite (item 8) already
   shipped — it's the only big item genuinely ready to start today with nothing else
   required first.
4. **The ten smaller roadmaps are entirely order-independent** and can be
   interleaved anywhere, including between or ahead of the bigger lifts — good for
   sustaining momentum, and essentially zero risk of creating rework later.
5. ~~Server-side error logging, admin login rate limiting, backups, and colorblind
   mode should be done sooner rather than later~~ ✅ **All four done** (error
   logging/login lockout/backups in v0.6.2; colorblind mode shortly after) — all
   closed real gaps or shipped low-risk accessibility wins rather than needing new
   infra, with no dependency on anything else in this table. Item 10 (the
   X01-to-plugin refactor) has since shipped, and was in fact proven
   behavior-identical via real tests — Playwright end-to-end coverage plus db.js
   unit tests against scratch SQLite databases — rather than manual spot-checking.
   That said, the testing-strategy slice itself (a first real, committed-to-the-repo
   test runner, per `docs/testing-and-observability-roadmap.md`) was, until 2026-07,
   still not done — those verification scripts were one-off scratchpad scripts, not
   permanent test infrastructure the next contributor could just re-run. A real
   suite (`npm test` via `node:test`, plus CI) now exists and **does** cover item
   10's refactor retroactively — `backend/test/scoring.test.js` tests
   `GAME_TYPES.x01.evaluateVisit` (extracted to `frontend/scoring.js`) directly —
   and `db.js`'s core/Cricket/challenge/badge stat functions across several
   `backend/test/db.*.test.js` files. See
   `docs/testing-and-observability-roadmap.md` for the full breakdown.
6. **Achievements/badges and coaching insights are X01-only today.** If either is
   built before Cricket exists (likely, given Cricket's complexity), keep the
   stat/achievement definitions abstracted per game type from day one — cheap to do
   now, expensive to retrofit once real achievement data exists for X01 only.
7. ~~**Item 11 (orientation-aware live scoreboard) should happen before Cricket's
   scoreboard step**~~ ✅ **Done** — the same build-order treatment item 10 got for
   the turn engine. `game-modes-roadmap.md` build-order step 2's `renderers.cricket`
   sub-item can now build on the existing `matchMedia`/`orientation-portrait`
   seam directly instead of needing its own retrofit; the engine/config/
   scoring-screen parts of step 2 were never blocked by this either way.
