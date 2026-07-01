# Preparing the Existing App for Future Roadmaps

> Status: **in progress** (4 of 10 items done/adopted — see items 2, 3, 8, and 9). This doc reviews all 16
> other roadmap docs in `docs/` and recommends changes to the *existing* codebase now,
> specifically to reduce rework later. It intentionally does not recommend building
> any future feature early — only making the current code more hospitable to features
> that are still just plans. It also now includes a cross-roadmap sequencing analysis
> (complexity vs. usefulness, and build-order dependencies) at the end.

## How to read this

Each recommendation below is backed by a concrete pattern found across multiple
roadmap docs, with the actual code location that would need to change. They're
ordered roughly by leverage (how much future rework each one avoids), not by how easy
they are. A prioritized "do now / keep in mind" summary is at the end.

---

## 1. Generalize the stats query layer beyond `practice`/H2H (highest leverage)

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
already exists, instead of bundling a migration into that same refactor.

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

**The evidence**: multiple roadmaps need to react to "a game started" or "a game
completed" beyond what happens today:
- `environmental-logging-roadmap.md` starts/stops HA polling on game start/end.
- `tournament-mode-roadmap.md` propagates the winner into the next bracket match on
  game completion.
- `achievements-badges-roadmap.md`'s milestone badges need to check conditions after
  a game completes.

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

**The evidence**: this is the thing already working correctly across the roadmaps,
worth calling out so it's *protected* rather than accidentally broken during other
refactors. `camera-scoring-roadmap.md` and `ghost-opponent-roadmap.md` both depend on
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

**The evidence**: `game-modes-roadmap.md`'s own build order lists "extract the
existing X01 logic behind the plugin interface, no behavior change" as its Phase 1,
treating it as step one of *shipping Cricket*. But looking across the full roadmap
set, that same refactor is also exactly what `ghost-opponent-roadmap.md` and
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

## What's already well-positioned (no prep needed)

Worth naming explicitly, since not everything needs a change:

- The `darts` table (sector, multiplier, dart number) is already fully game-agnostic
  — the game-modes and camera-scoring roadmaps both depend on this being true, and it
  already is.
- The live snapshot already carries a `gameType` field and `display.html` already has
  a `renderers` dispatch table keyed by it, built during the recent scoreboard
  redesign specifically so this wouldn't need revisiting later.
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
5. The X01-to-plugin refactor (item 10) — real work, but de-risks Cricket,
   ghost-opponent, and camera-scoring at once rather than one at a time. See the
   Roadmap Sequencing section below for why this should happen before either of the
   other two.

**Worth doing when the first feature that needs it actually starts:**
6. Stats query scope helper (item 1) — needed the moment game-modes, online
   multiplayer, or league mode starts real implementation, but not before.
7. Game-lifecycle hook point (item 4) — same timing.
8. Player-deletion-guard extensibility (item 6) — same timing.

**Worth keeping in mind, no action item today:**
9. Protecting the `throwDart` input-source separation during the eventual game-modes
   refactor (item 5) — largely superseded by item 10 above once that's done.
10. Settings page regrouping (item 7) — not urgent at 7 sections, worth revisiting
    before the next 2-3 land.

---

## Roadmap sequencing: complexity vs. usefulness

A separate pass across all 16 feature roadmap docs (not this consolidation doc
itself), ranking each on build complexity and real usefulness, and calling out
build-order dependencies between them.

| Roadmap | Complexity | Usefulness | Why |
|---|---|---|---|
| HA recipes | Trivial (docs only) | Medium | Zero code, unlocks power that already shipped |
| Colorblind mode | Very low | Medium (narrow, real) | CSS-only, genuine accessibility fix; first item under `docs/accessibility-roadmap.md` |
| Data export | Very low | Medium | Reformats existing queries; reinforces the self-hosted trust story |
| Voice announcements | Very low | Medium-High | Browser API only, zero infra, extends the celebration culture already core to the app |
| Shareable moments | Low | Medium | Client-side only; fun/virality, not core utility |
| Achievements/badges | Low | Medium | Mostly content on top of infra that already works |
| Daily challenge | Low | Medium | Built entirely on the existing Practice engine |
| Ghost opponent | Low-Medium | Medium | Needs a "scripted input source" concept — see dependency note below |
| Coaching insights | Low-Medium | High | No new data collection; genuinely differentiating vs. competitors |
| League mode | Medium | Medium-High | New tables, no new infra; complements tournament mode |
| Mobile app | Medium | High | Real packaging/TLS work, but zero new backend infra, and its one prerequisite (responsive CSS) is already done |
| Tournament mode | Medium-High | High | Bracket generation (especially double-elim) is genuinely fiddly, but fully self-contained — reuses the scoring engine unchanged |
| Environmental logging | Medium | Low (self-admittedly niche) | New inbound HA auth model, but explicitly scoped as a niche, manually-enabled feature |
| Game modes (Cricket/Baseball) | Very high | Very high | Full scoring-engine + stats-pipeline generalization, not just "add Cricket" |
| Online multiplayer | Very high | High *but conditional* | Needs someone else running their own Oche instance too — a real adoption chicken-and-egg problem that caps near-term value regardless of build quality |
| Camera/ML scoring | Extremely high | High *but narrow* | Genuinely novel CV engineering; only useful to whoever actually mounts the hardware |

### Build-order dependencies worth acting on

1. **Game-modes' Phase 1 (the X01→plugin refactor) should happen before
   ghost-opponent and camera-scoring** — see item 10 above. This is the single most
   important sequencing call in the whole set: all three features are variations of
   "a dart event from a non-tap source," and solving it once, early, avoids two
   ad-hoc solutions that later need reconciling.
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
5. **Achievements/badges and coaching insights are X01-only today.** If either is
   built before Cricket exists (likely, given Cricket's complexity), keep the
   stat/achievement definitions abstracted per game type from day one — cheap to do
   now, expensive to retrofit once real achievement data exists for X01 only.
