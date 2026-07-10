# Open Roadmap Items — Central Tracker

> This is the **single centralized place to track every roadmap request across the
> project** — replacing `docs/archive/existing-app-prep-roadmap.md`'s old "Roadmap
> sequencing" table, which is now frozen/historical. See `CLAUDE.md`'s "Roadmap
> docs" section for the standing convention that keeps this file current.
>
> **No item on this tracker is ever "Partially Completed."** A roadmap doc that
> ships part of its design and defers the rest gets split into separate,
> independently-tracked items here — one line per shippable phase (a "v1"/"v2",
> a numbered build-order step, or any other genuinely separable piece of work) —
> each cleanly **Done** or **Not started**. When a roadmap doc's own status
> header would otherwise say "Partial," that's the signal to split it here
> instead of writing "Partial" as this tracker's status.
>
> A roadmap doc moves to `docs/archive/` only once **every** item split out from
> it below is Done — matching the existing archiving convention. A doc can have
> some items Done and others still open here without being archived; it archives
> once nothing about it remains on the open list.

---

## Open items (not yet started, ordered by complexity — lowest first)

| # | Item | Source doc | Complexity |
|---|---|---|---|
| 1 | Mobile: multiple saved server profiles (stretch goal, step 7) | `docs/mobile-app-roadmap.md` | Low |
| 2 | Mobile: "Scoreboard Mode" toggle (step 5) | `docs/mobile-app-roadmap.md` | Low |
| 3 | Mobile: native chrome — change-server access, haptics, biometric unlock (step 4) | `docs/mobile-app-roadmap.md` | Low-Medium |
| 4 | Mobile: distribution decision — App Store/Play Store listing vs. simpler sideload distribution (step 6) | `docs/mobile-app-roadmap.md` | Low-Medium |
| 5 | Localize voice announcements beyond hardcoded English phrases | `docs/voice-announcements-i18n-roadmap.md` | Low-Medium |
| 6 | UI Overhaul design phase: create comprehensive plan for player page reorganization (step 1) | `docs/ui-overhaul-roadmap.md` | Medium |
| 7 | Mobile: Capacitor scaffold (iOS + Android) with the native Server Setup screen (step 2) | `docs/mobile-app-roadmap.md` | Medium |
| 8 | Mobile: ATS/cleartext config + self-signed cert trust-prompt (step 3) | `docs/mobile-app-roadmap.md` | Medium |
| 9 | Environmental logging (new inbound HA auth model; explicitly scoped as a niche, manually-enabled feature) | `docs/environmental-logging-roadmap.md` | Medium |
| 10 | Guided Around the Clock / Around the World practice drill mode — turns the existing passive completion tracking into a fourth Practice Drill Mode with live progress feedback, reusing Around the World's existing heatmap/progress-view UI | `docs/game-modes-roadmap.md` | Medium |
| 11 | Per-player data export (CSV + JSON, PIN-gated) — re-opened with fresh product direction after being explicitly descoped when the admin full-database export shipped; design was already fully written, just shelved | `docs/data-export-roadmap.md` | Medium |
| 12 | League mode: Cricket support (second game type; standings math is already game-type-agnostic, needs a `game_type` column on `leagues` + a setup-screen selector) | `docs/league-mode-roadmap.md` | Medium |
| 13 | Checkout Trainer: difficulty tiers (under-40/under-100/full-range target selection, on top of the shipped single full-range pool) | `docs/checkout-trainer-roadmap.md` | Low |
| 14 | Checkout Trainer: trick-question/bogey-number difficulty variant ("declare unsolvable" affordance + grading branch) and its conditional 💣 Bogey Buster badge | `docs/checkout-trainer-roadmap.md` | Medium |
| 15 | Game Modes: Baseball — the second proof that the plugin shape generalizes beyond Cricket (step 5) | `docs/game-modes-roadmap.md` | High |
| 16 | Tournament mode: double-elimination bracket support (losers bracket + grand final/reset logic, the genuinely fiddly combinatorial piece — single-elimination already shipped, see the Done ledger) | `docs/tournament-mode-roadmap.md` | High |
| 17 | Online multiplayer (needs someone else running their own Oche instance too — a real adoption chicken-and-egg problem) | `docs/online-multiplayer-roadmap.md` | Very high |
| 18 | Camera/ML scoring (genuinely novel CV engineering; only useful to whoever mounts the hardware) | `docs/camera-scoring-roadmap.md` | Extremely high |
| 19 | Companion website (persistent hosted infrastructure — accounts, matchmaking, a cloud database — the one item requiring the project to operate long-term infra, not just be self-hostable) | `docs/companion-website-roadmap.md` | Extremely high |

### Build-order notes that still apply

- **Tournament mode (single-elimination) AND League mode are both done**, and
  each is the real, shipped precedent for the "games link into a context
  table" pattern (see `CLAUDE.md`) any future context (online multiplayer, or
  anything not yet designed) can now follow directly — a separate
  `context_matches.game_id` junction table for a context with its own
  match-level lifecycle state (tournament's shape), or a direct nullable
  `games.<context>_id` column for a context with none (league's shape).
- **Mobile app's steps are sequential as listed** (step 2 → 3 → 4 → 5 → 6 → 7) per `docs/mobile-app-roadmap.md`'s own suggested build order; its one prerequisite (the responsive CSS pass) is already done.
- **Row 5** (voice announcement i18n) is the one remaining order-independent Low-Medium item — it can be interleaved anywhere, including ahead of the bigger lifts.

---

## Done (completion ledger — kept for history, not re-verified here)

Every item below is fully shipped. This section exists so nothing's completion
history is lost when a doc still has open items elsewhere on this tracker (and
therefore hasn't been archived yet) — see each source doc for full detail.

| Item | Source doc |
|---|---|
| Tournament mode: single-elimination (schema, bracket generation with cascading byes, match lifecycle/walkover, setup screen, bracket tree + Up Next view, live-scoreboard round label, player-deletion guard, committed tests) — double-elimination remains a separate open item above | `docs/tournament-mode-roadmap.md` |
| Tournament: two new badges — 🏆 Champion (win a bracket) and ⚔️ Giant Slayer (Tournament) (beat an opponent seeded 3+ slots better), both awarded inline from `_advanceTournamentMatch()`, live-celebration detected via an `earnedBadgeCache` diff since neither the award nor the completion hook has a response channel back to the frontend; committed tests | `docs/tournament-mode-roadmap.md` |
| Tournament: "Tournaments" stat block on the Player Profile (wins, runner-up count, best finish reached) — `getTournamentStats()`, `GET /api/players/tournament-stats`, committed tests | `docs/tournament-mode-roadmap.md` |
| League mode, X01 only (schema — `leagues`/`league_players` plus a nullable `games.league_id`; live-computed standings with no maintained tally; an `onGameCreated` auto-tag hook with a New Game "log to league?" picker for genuine multi-league ambiguity; season lifecycle (active/ended, reversible); a Leagues nav tab (list/setup/detail); a Home page teaser; a Player Profile "Leagues" stat block; committed tests) — Cricket support remains a separate open item above | `docs/league-mode-roadmap.md` |
| Dartboard zone/miss/bounce-out tracking — `darts.zone`/`miss_zone`/`miss_depth`/`bounced` columns; the generalized dartboard heatmap (`getDartHeatmap()`, `GET /api/players/dart-heatmap`) now shown on all four game-type Player Profile tabs instead of Just Chuckin' It only, with a "zone unspecified" hatch overlay for Pad-mode/pre-feature singles; Dartboard mode's flat Miss button replaced by a two-band (near/far) positional miss ring; a v1 flat-count "Bounce Out" button in every game type and both input modes (`getBounceOutCount()`, `GET /api/players/bounce-outs`) — v2 positional bounce-out capture remains gated on `docs/camera-scoring-roadmap.md`; committed tests, verified end-to-end with Playwright | `docs/archive/dartboard-zone-tracking-roadmap.md` |
| Coaching Insights — weak-number, checkout-route, bust-parity, and form-trend insights (`getCoachingInsights`, Player Profile X01 tab, committed tests) | `docs/archive/coaching-insights-roadmap.md` |
| Home Assistant automation recipe book (`docs/home-assistant-recipes.md`, linked from README) | `docs/archive/ha-recipes-roadmap.md` |
| Colorblind-friendly palette | `docs/archive/colorblind-mode-roadmap.md` |
| Admin login rate limiting + `OCHE_REQUIRE_AUTH` zero-trust default; SEC-7 webhook auth | `docs/security-hardening-roadmap.md` |
| Full-database admin JSON export (Settings → Data Export); per-player export re-opened as a separate open item above | `docs/data-export-roadmap.md` |
| Standalone `backend/admin-recovery.js` CLI (`list`/`reset-password`/`clear-lockout`) for a forgotten admin password or a stuck lockout via direct filesystem/container access; `changeAdminPassword()` now also clears lockout | `docs/archive/admin-account-recovery-roadmap.md` |
| Progressive admin-login lockout delay — replaces the flat 5-minute lockout with a doubling-per-failure backoff past a grace window, never fully blocking a correct password | `docs/archive/admin-login-backoff-roadmap.md` |
| Voice announcements (browser speech synthesis call-outs) | `docs/archive/voice-announcements-roadmap.md` |
| Backups v1: `backend/backup.js` script, retention pruning, documented restore procedure | `docs/backups-roadmap.md` |
| Backups v2: Settings → Backups (download/retention/on-demand backup/restore-from-existing/upload-restore) | `docs/backups-roadmap.md` |
| Backups: opt-in Docker Compose-profile sidecar (`docker-compose.yml`'s `backups` service, `profiles: ["backups"]`) | `docs/backups-roadmap.md` |
| Shareable Moments: card generation, every trigger point (achievements, match win, Personal Bests), HA webhook | `docs/archive/shareable-moments-roadmap.md` |
| Shareable Moments: Player Profile "Moments" gallery (found already built, 2026-07 — every earned Badge Case tile has a Share button, `shareEarnedBadge()`) | `docs/archive/shareable-moments-roadmap.md` |
| Shareable Moments — every item, now archived (card generation + Moments gallery above; X auto-post explicitly rejected, not a gap) | `docs/archive/shareable-moments-roadmap.md` |
| 22 of 22 achievements/badges shipped (21 original candidates + Staircase Finish) | `docs/archive/achievements-badges-roadmap.md` |
| Badge award count threaded into the live achievement overlay (`patchAchievementCount()`, both `index.html` and `display.html`), not just the shareable moment card | `docs/archive/achievements-badges-roadmap.md` |
| Expanded Achievements & Badges — every item, now archived (all 22 badges + the notifications/count work above) | `docs/archive/achievements-badges-roadmap.md` |
| Simultaneous-achievements overlay fix (multi-badge queue) | `docs/archive/simultaneous-achievements-roadmap.md` |
| Daily/Weekly Challenge — all 6 formats, streak tracking, shareable card, Player Profile history tab, 3 challenge-specific badges | `docs/daily-challenge-roadmap.md` |
| Ghost Opponent (X01 only) — leg-script replay, New Game leg picker, opponent-badge suppression (win/loss tracking is a separate, not-yet-built open item above) | `docs/archive/ghost-opponent-roadmap.md` |
| Server-side error logging + persistent rotating log + Settings "Server Errors" view (Part A); committed `node:test` suite + CI (Part B) | `docs/testing-and-observability-roadmap.md` |
| Colorblind mode, WCAG contrast audit fixes, `aria-live` announcements, accessible-input-path framing, type-size pass (standing checklist, not archived — ongoing per CLAUDE.md) | `docs/accessibility-roadmap.md` |
| Mobile: phone-responsive CSS pass (step 1) | `docs/mobile-app-roadmap.md` |
| All 14 security-audit findings (SEC-1 through SEC-14) fixed | `docs/security-audit-roadmap.md` |
| All 3 functional-defect findings (BUG-1 through BUG-3) fixed | `docs/bug-roadmap.md` |
| BUG-8: static frontend files served with no `Cache-Control` header, plus an unguarded `await DB.loadAll()` in the boot sequence — together could make a live server with intact data look fully broken to a user on a stale-cached device (found via a live bug report, not an audit pass) | `docs/bug-roadmap.md` |
| Game Modes step 1: X01-to-plugin refactor, no behavior change | `docs/game-modes-roadmap.md` |
| Game Modes step 2: Cricket engine + customizable numbers, dedicated scoring screen, live scoreboard | `docs/game-modes-roadmap.md` |
| Game Modes step 3: Cricket stats parity (MPR, 9-Marks, Personal Bests, metric history, 2 achievements) | `docs/game-modes-roadmap.md` |
| Game Modes step 4: Home/Player Profile game-type navigation (X01/Cricket toggles + Cricket leaderboard set) | `docs/game-modes-roadmap.md` |
| Game Modes step 6: generalized N-way Player Profile/Home page game-type toggle mechanism | `docs/game-modes-roadmap.md` |
| Game Modes step 7: Doubles Practice (per-dart evaluation, stats, Personal Bests, undo, Home leaderboard set) | `docs/game-modes-roadmap.md` |
| Game Modes step 8: 101 as a fourth X01 starting score | `docs/game-modes-roadmap.md` |
| Game Modes step 9: Just Chuckin' It (heatmap-first stats, 18 laddered milestone achievements) | `docs/game-modes-roadmap.md` |
| Orientation-aware live scoreboard (portrait vs. landscape), built ahead of Cricket's scoreboard | `docs/archive/existing-app-prep-roadmap.md` item 11 |
| Stats query scope helper (`_scope()` in `backend/db.js`), now used by every stat query in the file | `docs/archive/existing-app-prep-roadmap.md` item 1 |
| Player-deletion-guard extensibility (`registerDeletePlayerGuard`) | `docs/archive/existing-app-prep-roadmap.md` item 6 |
| Game-lifecycle hook mechanism (`onGameCreated`/`onGameCompleted`) | `docs/archive/existing-app-prep-roadmap.md` item 4 |
| Settings page regrouping into 4 tabs (Account & Access, Gameplay & Display, Integrations, Admin & Danger Zone) | `docs/archive/existing-app-prep-roadmap.md` item 7 |
| `games.game_type`/`games.config` columns | `docs/archive/existing-app-prep-roadmap.md` item 2 |
| Context tables link into `games` via FK, never a new boolean on `games` (adopted convention) | `docs/archive/existing-app-prep-roadmap.md` item 3, see `CLAUDE.md` |
| Docker Compose profiles for future optional services (adopted convention) | `docs/archive/existing-app-prep-roadmap.md` item 9 |
| `throwDart(sector, multiplier)` input-source separation, confirmed protected through the plugin refactor | `docs/archive/existing-app-prep-roadmap.md` item 5 |
| Preparing the Existing App for Future Roadmaps — all 11 of its own items | `docs/archive/existing-app-prep-roadmap.md` |
| Dart Builder — every item, now archived: v1 (`dart_components`/`loadouts` schema, component/loadout CRUD, `game_players.loadout_id` game-creation integration, PIN-gated default-loadout + loadout-customization actions, per-loadout stats, Dart Builder screen, Player Profile "Default Loadout" selector, New Game "Change Loadout" picker), the loadout comparison view ("⚖️ Compare Loadouts", side-by-side stats via the existing `getLoadoutStats()`, no new backend query), the accessibility icon set (barrel shape/grip + flight shape as an accessible icon-button group, closing the "torpedo"/"knurled"/"kite" self-explanatory-name gap), and "⚡ Quick Add Full Set" (name + every barrel/shaft/flight field on one screen, one save). Optional photo upload per component was considered and explicitly dropped, not built — it was framed as an alternative to the icon set, not additive to one | `docs/archive/dart-builder-roadmap.md` |
| Cricket badge parity: Night Owl/Early Bird now fire from Cricket turns too, via a shared `awardTimeOfDayBadges(p)` helper called from both `enterTurn()` and `enterTurnCricket()` — previously X01-only by accident of code structure, not design | `docs/game-modes-roadmap.md` |
| Cricket-native badges: 🧹 Whitewash (won without the opponent closing a single number) and 🔥 Comeback Kid (Cricket) (won after trailing on points by 20+, `p.legWorstPointsDeficit` tracked per-visit in `enterTurnCricket()`) — both 2-player only, both checked in `onLegWonCricket()`, both with pure trigger-condition functions (`isCricketWhitewash()`/`cricketComebackAchieved()`) unit-tested in `backend/test/scoring.test.js` | `docs/game-modes-roadmap.md` |
| Ghost Opponent — every item, now archived: the original race feature, race win/loss tracking (`ghost_races` table, `recordGhostRace()`/`getGhostRaceRecord()` server-side re-validating the source leg so a client can't fabricate a fake win history, `POST /api/ghost-races` + `GET /api/players/ghost-race-record`, a "👻 Ghost races: W–L" line on the Player Profile), and the 👻 Ghost Slayer first-win badge (awarded inline from `recordGhostRace()`, idempotent via `awardBadge()`'s existing `once` mode) | `docs/archive/ghost-opponent-roadmap.md` |
| Checkout Trainer, both sub-modes (schema — `turns.target_score`, `games.config.mode`/`durationSec`, the generalized `NOT_HYPOTHETICAL_DARTS` physical-stat exclusion; `pickCheckoutTarget()`/`gradeCheckoutAttempt()` pure grading logic; untimed Freeform plus the 60-second Checkout Blitz sprint with its wall-clock countdown and server-derived scoring; `getCheckoutBlitzLeaderboard()`; 4 Freeform + 1 Blitz milestone ladders (28 tiers) plus 5 one-off badges, all reusing the existing Chuckin milestone engine; New Game screen integration; Home page teaser + Player Profile stat bubbles/Personal Bests; committed tests) — difficulty tiers and the trick-question/Bogey Buster variant remain separate open items above | `docs/checkout-trainer-roadmap.md` |
