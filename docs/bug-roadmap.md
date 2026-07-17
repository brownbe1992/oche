# Bug Roadmap (functional-defect tracker)

> **Purpose.** The counterpart to `docs/security-audit-roadmap.md`, for
> *functional* bugs — wrong behavior, data-integrity gaps, and correctness
> issues that aren't primarily a security exposure. Same discipline: each entry
> has a stable ID, a severity, the exact location (by function/file, not line
> number, so it survives edits), the concrete misbehavior, a **step-by-step
> fix**, and a **verification** step. Security issues live in the security doc;
> where a functional bug shares a root cause with a security finding, the two
> cross-reference each other rather than duplicating the fix.
>
> **Seeded by** the 2026-07 second-pass audit (the same read that produced
> `security-audit-roadmap.md` Part 4); **extended** by the 2026-07 third-pass audit
> (scoped to the single-elimination tournament feature — the same read that produced
> `security-audit-roadmap.md` Part 5 / SEC-15), which added **BUG-4** and **BUG-5**;
> and again by the 2026-07 **fourth-pass audit** (a breadth-first re-read of the whole
> codebase weighted evenly across every module — the same read that produced
> `security-audit-roadmap.md` Part 6 / SEC-16), which added **BUG-6** and **BUG-7**
> below. The stat/achievement *formulas* are not re-derived here — they're covered by
> the `node:test` suite under `backend/test/` (all green as of this writing). This doc
> tracks the correctness gaps that suite doesn't yet assert.
>
> **BUG-1 … BUG-8 fixed.** BUG-1/BUG-2/BUG-3 (second pass); BUG-4/BUG-5/BUG-6/BUG-7
> (fixed 2026-07 alongside `security-audit-roadmap.md` SEC-15/SEC-16), each with a
> committed regression test and the full backend suite green. BUG-8 (fixed 2026-07,
> from a live user bug report rather than an audit pass) is a UI/error-handling defect
> rather than a stats/data-integrity one, so its verification is a live Playwright check
> instead of a `node:test` case. **BUG-9** was opened by the 2026-07 **fifth-pass
> audit** (the same read that produced `security-audit-roadmap.md` Part 7 / SEC-17),
> now fixed. **BUG-10** through **BUG-15** were opened by a 2026-07 **sixth-pass
> audit** (a general code-review pass across the whole app, not scoped to one new
> feature — the same read that produced `security-audit-roadmap.md` Part 8 / SEC-18
> through SEC-24) — see the entries at the bottom. **BUG-16** was opened by a live
> user bug report (2026-07) against `importPlayerExport()`, now fixed. **BUG-17**
> was opened by a live user bug report (2026-07) against Ghost mode's past-leg
> picker showing "Invalid Date," now fixed. **BUG-18** was opened by a live user
> bug report (2026-07) against Ghost mode incorrectly offering a "Next leg"
> button instead of ending the race, now fixed. **BUG-19** was opened by a 2026-07
> **seventh-pass audit** (a re-read weighted toward the Baseball / per-player
> export-import / league-fixtures / New-Game-wizard code merged since the sixth pass —
> the same read that produced `security-audit-roadmap.md` Part 9 / SEC-25), against
> `getPlayerExport()`'s unbatched `IN (...)` id lists, now fixed. **BUG-20** was
> opened by a live user bug report (2026-07) against Just Chuckin' It's live scoreboard
> heatmap lighting up *both* single regions of a number for any single hit (the live
> session tally and its renderer were zone-blind, even though dart recording and the
> lifetime heatmap were already zone-aware), now fixed. **BUG-21** was opened by a
> live user bug report (2026-07) against a re-shared Badge Case card showing no
> explanation at all — `shareEarnedBadge()` never used the badge's own `desc` field,
> the only moment-card-building path in the app that didn't, now fixed (extended to
> every other card-building path for full coverage in the same change). **BUG-22**
> was opened by a live user bug report (2026-07) against practice-mode Baseball
> games never recording — Games Played, Win Rate, and every Personal Best stayed
> empty no matter how many practice games were played, because
> `onLegWonBaseball()`'s match-completion gate was copy-pasted from X01/Cricket's
> open-ended-practice-session template, which Baseball's own completed_at-dependent
> stat functions can't tolerate — now fixed. **BUG-23** was opened by a live user
> bug report (2026-07) against Cricket's scoring pad having no way to log a real
> off-target number hit (e.g. 1-14 in classic Cricket) — every one was forced
> through `Miss`, corrupting Dart Analytics' sector/treble-rate stats — now fixed
> with a "hit a different number" picker. **BUG-24** was found while verifying
> BUG-23's fix, when a follow-up "check the heatmap works for Cricket" request
> revealed every single hit (not just off-target ones) was silently invisible on
> Cricket's (and Baseball's) lifetime dartboard heatmap, because the two game
> types can never produce the "zone" data the heatmap's existing exclusion rule
> assumed was always a Pad-mode choice — now fixed. **BUG-25** was opened by a
> live user bug report (2026-07) against the New Game wizard forcing every
> mode through Step 3 ("More options") even when that mode had nothing to
> configure there — Chuckin, X01/Baseball practice, Around the Clock, Around
> the World, and Daily Challenge all landed on an effectively blank page
> requiring an extra click, now fixed by skipping straight to Start when Step
> 3 has no visible content. **BUG-26** (fixed 2026-07) closed a `display.html`
> ACH-labels parity gap. An **eighth-pass audit** (2026-07, weighted to the six
> game modes merged since the seventh pass — Session Recap, Marathon, Shanghai,
> Halve-It, The Pressure Chamber, Dead Man Walking) opened **BUG-27** through
> **BUG-29** (all **Open**), plus one coupled security finding
> (`security-audit-roadmap.md` **SEC-26**, Open) that rides on BUG-28's fix — see
> the "Eighth-pass audit" section at the bottom. **BUG-1 through BUG-26 are fixed;
> BUG-27 through BUG-29 are open.**

## Severity legend

- **HIGH** — wrong result a normal user will actually hit in ordinary use.
- **MED** — wrong result behind an uncommon-but-reachable path, or a silent
  data-integrity drift that accumulates.
- **LOW** — latent / only reachable by a malformed or hostile client today;
  defense-in-depth correctness.

---

## BUG-1 — Daily Challenge write path doesn't validate the date/format the read path requires  **(LOW, latent / data-integrity)**

**Status: ✅ Fixed.** `startChallengeAttempt()` now validates `challengeDate` against
`^\d{4}-\d{2}-\d{2}$` and `format` against `CHALLENGE_BETTER_DIRECTION`'s known keys
before writing (400 otherwise); `completeChallengeAttempt()` validates `challengeDate`
the same way. Same fix as `security-audit-roadmap.md` **SEC-14**. Tested in
`db.challenges.test.js` (malformed date on start/complete, unknown format on start,
every one of the 6 known formats accepted).

**Where:** `db.js` `startChallengeAttempt()` and `completeChallengeAttempt()` store
`challenge_date` and `format` via bare `String(...)` with no validation. The *read* side
is asymmetric: `getChallengeStatus()` and `resetChallengeAttempt()` both reject a
`challengeDate` that isn't `^\d{4}-\d{2}-\d{2}$` with a 400, and the streak/longest-streak
walks in `getChallengeStatus()`/`getChallengeHistory()` assume every stored date parses as
`new Date(date + 'T00:00:00Z')`.

**Misbehavior:** the current frontend always sends a valid `YYYY-MM-DD`, so this is latent.
But a malformed or hostile client can persist an attempt row whose date never matches the
regex-guarded reads — it then (a) still counts toward `played`/`completed` in
`getChallengeHistory()` (which does *not* validate), inflating the player's lifetime
"played" tally with a phantom day, and (b) parses to `Invalid Date` in the streak/
longest-streak loops, where the day-gap subtraction yields `NaN` and silently resets a run
to 1 instead of extending it — a quietly wrong "longest streak". A bogus `format` similarly
sits in the table but can never become a personal best (`CHALLENGE_BETTER_DIRECTION[format]`
is `undefined`), so it's dead weight rather than a crash.

**Fix (step by step):**
1. In `startChallengeAttempt()`, validate `challengeDate` with the same
   `^\d{4}-\d{2}-\d{2}$` regex used on the read side, and validate `format` against the six
   known formats (the keys of `CHALLENGE_BETTER_DIRECTION` already list them). Reject
   otherwise with a 400.
2. In `completeChallengeAttempt()`, validate `challengeDate` the same way (it's used in the
   `UPDATE ... WHERE challenge_date = ?`, so a bad value is a silent no-op today — a 400 is
   clearer).
3. This is the functional face of `security-audit-roadmap.md` **SEC-14**; doing SEC-14's
   challenge-validation step fixes this bug at the same time.

**Verify:** `startChallengeAttempt` with `challengeDate:'2026-7-1'` or `'garbage'`, or
`format:'nope'`, each return 400; a valid attempt still records and streaks compute
correctly.

---

## BUG-2 — `createGame` accepts an unknown `gameType`, which then silently skews cross-type stats  **(LOW, latent / data-integrity)**

**Status: ✅ Fixed.** `createGame()` now validates `gameType` (defaulted to `'x01'`
first) against the existing `KNOWN_GAME_TYPES` whitelist, rejecting an unknown value
with a 400 before any row is written — the same whitelist `_scope()` already enforced
on the read side. `category` is also now capped at 64 characters and the serialized
`config` at 4096 bytes (same change, since all three live at the same write
boundary — see `security-audit-roadmap.md` **SEC-14**). No self-heal migration was
needed since no pre-existing rows have an unknown `game_type` (confirmed: the
shipped UI only ever sends one of the four known types). Tested in
`db.turn-validation.test.js`; a live Playwright smoke test also confirmed ordinary
X01/Cricket/Chuckin game creation is unaffected.

**Where:** `db.js` `createGame()` sets `resolvedGameType = gameType || 'x01'` with **no**
whitelist, even though `KNOWN_GAME_TYPES` (`['x01','cricket','doubles_practice','chuckin']`)
is already defined in the same file and `_scope()` throws on any type outside it.

**Misbehavior:** the New Game UI only ever sends one of the four known types, so this is
latent. But a game persisted with an unknown `game_type` (e.g. via a direct API call) is
**counted in the unscoped aggregates** — total darts thrown, games played (the
`game_players`/turns joins that don't filter on type) — while being **excluded from every
typed stat query** (`X01_ONLY`, `_scope({gameType:...})`, the Cricket/Doubles/Chuckin
functions). The result is an internally inconsistent profile: the home "games played" /
"darts thrown" counters include a game that contributes to none of the per-type
leaderboards or averages. No crash (the server never *queries* with the unknown type, so
`_scope`'s throw isn't reached), just a quiet drift.

**Fix (step by step):**
1. In `createGame()`, validate `gameType` (when provided) against `KNOWN_GAME_TYPES` and
   reject an unknown value with a 400 — the same whitelist `_scope()` already enforces on
   the read side, applied at the write boundary so bad rows never enter the table.
2. Optionally, add a one-time migration/self-heal that flags or removes any pre-existing
   rows with an unknown `game_type` (there should be none from the shipped UI).
3. Shares a root cause with `security-audit-roadmap.md` **SEC-14** (createGame input
   validation) — fix together.

**Verify:** `createGame({ gameType:'evil', ... })` returns 400; the four known types still
create normally and appear in both the unscoped and typed stats.

---

## BUG-3 — Admin-username `onclick` handlers rely on a validator elsewhere instead of escaping at the sink  **(LOW, code-hygiene / latent-regression)**

**Status: ✅ Fixed.** (Cross-ref: `security-audit-roadmap.md` **SEC-12**.) Both
`askChangeAdminPassword(...)`/`askDeleteAdmin(...)` handlers in `renderAdminsList()`
now wrap `a.username` as `escapeHtml(escapeJs(a.username))`, matching every other
`onclick` site in the file. Purely defensive — usernames were never exploitable
(regex-restricted), and this removes the "safe only because of a validator
elsewhere" coupling. Verified: a grep for `escapeJs(` not preceded by `escapeHtml(`
across `frontend/index.html` now returns zero matches.

**Where:** `frontend/index.html` — the `askChangeAdminPassword(...)` / `askDeleteAdmin(...)`
`onclick` handlers in `renderAdminsList()` interpolate `a.username` with **`escapeJs`
only**, inside a double-quoted attribute.

**Misbehavior:** not exploitable today — usernames are validated to
`^[A-Za-z0-9_.-]{3,32}$`, which excludes the `"`/`<`/`>` needed to break out. But the sink
is only safe *because of* a validator two files away; if that regex is ever loosened, this
silently becomes an XSS. It's also inconsistent with the file's own established
`escapeHtml(escapeJs(...))` pattern.

**Fix:** wrap both in `escapeHtml(escapeJs(a.username))` (done as step 2 of SEC-12). Purely
defensive — no behavior change for valid usernames.

**Verify:** covered by the SEC-12 verification once the handlers are wrapped.

---

## BUG-4 — Tournament advancement (the `onGameCompleted` hook) doesn't validate the winner is a match participant, and can re-advance an already-decided match  **(MED, data-integrity)**

**Status: ✅ Fixed (2026-07).** `_advanceTournamentMatch()` now early-returns if
`match.winner_id != null` (no re-advancing a decided match) and if `winnerId` isn't
one of the match's two players (no injecting a non-participant) — a silent skip, since
the game itself still completes normally. Both generation-time bye advances still pass
(the bye match has `winner_id` null and its winner is its one real player). Committed
regression tests in `backend/test/tournament.test.js`: completing a tournament-linked
game with a non-participant winner leaves the bracket unchanged (no champion set, then
the legitimate winner still works); a second complete on an already-decided match with
a different winner does not overwrite the recorded winner/champion. `REFERENCE.md` §15
updated to note the guards. Full suite green.

**Original finding:** (Found in the 2026-07 third-pass audit; cross-ref
`security-audit-roadmap.md` Part 5.)

**Where:** `backend/db.js` — `_advanceTournamentMatch(matchId, winnerId)` and the
`onGameCompleted(...)` hook that calls it. The hook does:

```js
onGameCompleted(({ gameId, winnerName }) => {
  if (!winnerName) return;
  const m = db.prepare('SELECT id FROM tournament_matches WHERE game_id = ?').get(gameId);
  if (!m) return;
  const w = getPlayer(winnerName);
  if (!w) return;
  _advanceTournamentMatch(m.id, w.id);   // <-- w.id never checked against the match's two players
});
```

and `_advanceTournamentMatch` neither checks `winnerId` against `player1_id`/
`player2_id` nor early-returns when `match.winner_id` is already set:

```js
function _advanceTournamentMatch(matchId, winnerId) {
  const match = db.prepare('SELECT * FROM tournament_matches WHERE id = ?').get(matchId);
  if (!match) return;
  const loserId = winnerId === match.player1_id ? match.player2_id : match.player1_id; // else-branch = player1_id
  db.prepare('UPDATE tournament_matches SET winner_id = ? WHERE id = ?').run(winnerId, matchId);
  ...
}
```

**The asymmetry that proves it's a gap:** the sibling `recordWalkover()` path *does*
validate both — `if (m.winner_id != null) throw 409` and
`if (!w || (w.id !== m.player1_id && w.id !== m.player2_id)) throw 400`. The
game-completion hook path is missing the equivalent checks.

**Misbehavior:** a tournament match's underlying game is completed via
`POST /api/games/:id/complete { winner }`, where `winner` is a client-supplied name.
Two problems follow:

1. **Winner not validated as a participant.** If `winner` is a real player who is
   *not* one of the match's two competitors, `_advanceTournamentMatch` sets
   `winner_id` to that outsider, marks `player1` (the else-branch default) as
   eliminated, and **propagates the outsider into the next round's slot** — or, at the
   final, records the outsider as `champion_id`. A non-participant can be injected as a
   tournament's champion.
2. **No already-resolved guard.** A second `complete` on the same game with a
   *different* winner re-runs advancement: it overwrites `winner_id`, re-marks the
   loser, and re-writes the next slot — so a **completed** tournament's result (even
   the champion) can be overwritten by a replayed/forged complete. (A duplicate
   complete with the *same* winner is harmless/idempotent, so ordinary double-submits
   don't corrupt anything — only a different or non-participant winner does.)

In normal play the frontend always completes with the actual winner, so this is
latent — reachable by a malformed/hostile client, or as the follow-on payload of the
SEC-15 XSS running in an admin session. Under `OCHE_REQUIRE_AUTH=false` it's an
anonymous data-corruption path; under the default it requires an admin session (who
could record any walkover anyway), so the security dimension is small — this is
primarily a data-integrity defect, and the threat model's goal that "stats must stay
accurate" applies to bracket state too.

**Fix (step by step):**
1. In `_advanceTournamentMatch()`, early-return if the match is already decided:
   `if (match.winner_id != null) return;` (this must come *before* the winner
   UPDATE). Confirm this doesn't break the generation-time bye cascade — a round-1 bye
   match has `winner_id === null` when advanced, so the guard is a no-op there.
2. In `_advanceTournamentMatch()` (or in the hook, before calling it), validate the
   winner is a participant: `if (winnerId !== match.player1_id && winnerId !== match.player2_id) return;`
   — silently skip advancement rather than corrupting the bracket, since the game
   itself still completes and records stats normally; a mismatched winner just means
   "this completion doesn't correspond to a valid bracket result." (Returning is
   friendlier than throwing here: `completeGame()` fires the hook synchronously after
   its own DB write, and a throw would surface as a 500 on an otherwise-successful game
   completion. The hook wrapper already catches and logs listener throws, but a silent
   skip is the cleaner semantic.)
3. Add a committed `node:test` in `backend/test/tournament.test.js`: (a) completing a
   tournament-linked game with a non-participant winner leaves the bracket unchanged
   (no advancement, no champion set); (b) a second complete on an already-decided
   match with a different winner does not overwrite the recorded winner or the
   downstream slot.
4. `REFERENCE.md` §15 describes the advancement hook's behavior but doesn't currently
   state these guards; add a one-line note there in the same change (behavior for
   *legitimate* input is unchanged — the guards only reject input that never occurs in
   normal play).

**Verify:** the two new tests above pass; a full simulated tournament to champion
still completes normally; `recordWalkover` behavior is unchanged.

---

## BUG-5 — `legsPerSet` / `setsPerGame` are not magnitude-bounded (and `createGame` doesn't require integers)  **(LOW, data-integrity / cosmetic)**

**Status: ✅ Fixed (2026-07).** `createGame()` clamps both fields via a new
`clampMatchFormat()` helper to a whole number in `[1, MAX_LEGS_OR_SETS=99]` (lenient —
garbage floors to 1, matching the old `|| 1` style, just bounded and integer-floored).
`createTournament()`'s per-round validation now rejects a non-integer or out-of-range
(`> 99`) format with a 400 before the tournament is created. Committed tests: the
`createGame` clamp (`db.turn-validation.test.js` — `1e9→99`, `2.9→2`, `0/-5→1`) and
the tournament round rejection (`tournament.test.js` — `1e9` and `2.5` both 400, sane
format still creates). Full suite green.

**Original finding:** (Found in the 2026-07 third-pass audit.)

**Where:** `backend/db.js` `createGame()` stores `Number(legsPerSet) || 1` /
`Number(setsPerGame) || 1` with **no upper bound and no integer check** — a float like
`2.5` or a huge value like `1e9` is accepted and persisted. `createTournament()`'s
per-round validation is stricter on *type* (`Number.isInteger(...) && >= 1`) but still
has **no upper bound**, so a round with `legsPerSet: 1000000000` is accepted and, when
that match is started, flows straight into `createGame`.

**Misbehavior:** not a crash and not a security exposure — a "first to 1,000,000,000
legs" match is simply unwinnable-in-practice, and a non-integer `legsPerSet` (e.g.
`2.5`, only reachable through the generic `createGame` path) renders as "first to 2.5
legs" on the scoreboard and is compared as `legsWon >= 2.5` (effectively rounding up).
Both are nonsensical-but-harmless config values that a malformed client (or a
fat-fingered future API caller) can persist. The New Game and tournament-setup UIs
never produce them, so this is latent.

**Fix (step by step):**
1. In `createGame()`, clamp both fields to a sane integer range at the write boundary,
   e.g. `const legs = Math.min(99, Math.max(1, Math.floor(Number(legsPerSet) || 1)));`
   (same for `setsPerGame`) — or reject out-of-range values with a 400, matching how
   `category`/`config` are bounded right above. Pick one style and apply to both
   fields.
2. In `createTournament()`'s round validation, add the same upper bound (e.g. `<= 99`)
   alongside the existing `Number.isInteger && >= 1` check, so a bogus round format is
   rejected with a 400 before the tournament is created rather than surfacing only when
   a match is started.
3. Add a committed `node:test` asserting an out-of-range `legsPerSet`/`setsPerGame`
   (both a float and a huge value) is clamped or rejected on `createGame`, and that a
   round with an out-of-range format is rejected by `createTournament`.

**Verify:** `createGame({ legsPerSet: 2.5, ... })` and `createGame({ legsPerSet: 1e9, ... })`
each clamp/reject; `createTournament` with a round of `{ legsPerSet: 1e9, setsPerGame: 1 }`
returns 400; ordinary 1–5 leg/set games and tournaments still create normally.

---

## BUG-6 — The full-database JSON export silently omits the four tournament tables  **(LOW, data-completeness)**

**Status: ✅ Fixed (2026-07).** `getFullDatabaseExport()` now includes `tournaments`,
`tournamentPlayers`, `tournamentRounds`, and `tournamentMatches` (`SELECT *` — they
carry no credential columns). A standing-rule comment next to the function records
that any new user-data table must be added here and to `wipeAllData()`/`resetStats()`
(BUG-7) in the same change. `REFERENCE.md`'s data-export section and `README.md`'s Data
Export bullet updated to list the tournament tables. Committed test in
`db.export.test.js`: the exported-keys assertion now includes the four tournament keys,
and a new test confirms a run tournament (rows in all four tables) appears in the
export. Full suite green.

**Original finding:** (Found in the 2026-07 fourth-pass audit.)

**Where:** `backend/db.js` `getFullDatabaseExport()` (the `GET /api/export-all` payload,
Settings → Admin & Danger Zone → Data Export). It dumps `players`, `games`,
`game_players`, `turns`, `darts`, `timeline_events`, `player_badges`, and
`daily_challenge_attempts` — but **not** `tournaments`, `tournament_players`,
`tournament_rounds`, or `tournament_matches`, which were added by the tournament
feature after the export was written.

**Misbehavior:** the export is documented (in the function's own comment,
`REFERENCE.md`, and `README.md`) as "a complete JSON export of every player, game, and
stat" / "it's your data, and you can always take it with you." A user who exports
their data believing it's complete gets a JSON file with **no record of any tournament
they ran** — champions, brackets, seeds, per-round formats are all missing. Unlike the
deliberate exclusions (`admins`/`sessions`/`settings`/`server_errors` and the players'
`pin_*` columns, which are intentionally withheld as credential/internal data), the
tournament tables contain ordinary user data and carry no secrets, so their omission is
an oversight, not a policy choice. (No true data loss — the `.db` backup path still
captures everything — but the JSON export's completeness contract is violated.) This is
the exact "a new table wasn't wired into an existing whole-system operation" gap the
fourth pass was hunting; it shares a root cause with **BUG-7** (bulk wipe) and the fix
should be paired.

**Fix (step by step):**
1. In `getFullDatabaseExport()`, add the four tables:
   `tournaments: db.prepare('SELECT * FROM tournaments').all()`, and likewise
   `tournamentPlayers`, `tournamentRounds`, `tournamentMatches`. They hold no
   credential columns, so `SELECT *` is fine (unlike `players`, which must keep
   excluding `pin_*`).
2. Update `REFERENCE.md`'s data-export section and `README.md`'s Data Export bullet to
   list the tournament tables among what's exported.
3. **Standing checklist item** (the real fix for the class): add a note next to
   `getFullDatabaseExport()` and in `REFERENCE.md` that *any new user-data table must
   be added here and to `wipeAllData()` (BUG-7) in the same change that creates it* —
   the same discipline `CLAUDE.md` already applies to REFERENCE/roadmap updates. A
   cheap guard: a `node:test` that reads `sqlite_master` for all non-internal tables
   and asserts each appears in the export keys, so a future new table fails the test
   until it's added.

**Verify:** run a tournament to completion, hit `GET /api/export-all`, and confirm the
JSON contains the tournament rows (tournament, players/seeds, rounds, matches with the
champion).

---

## BUG-7 — "Wipe all data" (and "Reset all stats") leave orphaned tournament rows behind  **(MED, data-integrity)**

**Status: ✅ Fixed (2026-07).** `wipeAllData()` and `resetStats()` now both include
`DELETE FROM tournaments;`, which cascades to `tournament_players`/`tournament_rounds`/
`tournament_matches` — so a full wipe leaves no orphaned tournament shells, and a stat
reset (which deletes every game the matches link to) clears the brackets rather than
stranding them. Committed test in `tournament.test.js`: after `wipeAllData()`,
`listTournaments()` is empty and all four tournament tables have zero rows. Full suite
green.

**Original finding:** (Found in the 2026-07 fourth-pass audit; cross-ref
`security-audit-roadmap.md` Part 6.)

**Where:** `backend/db.js` `wipeAllData()` (`DELETE FROM players; DELETE FROM games;`)
and, to a lesser degree, `resetStats()` (`DELETE FROM turns; DELETE FROM game_players;
DELETE FROM games;`).

**Misbehavior:** the four tournament tables reference `players`/`games` only via
`ON DELETE CASCADE` (from `players` → `tournament_players`) and `ON DELETE SET NULL`
(from `players`/`games` → `tournament_matches.player1_id`/`player2_id`/`winner_id`,
`tournaments.champion_id`/`runner_up_id`, `tournament_matches.game_id`). Nothing
references the **`tournaments` parent row**, so deleting all players and games leaves
every `tournaments` / `tournament_rounds` / `tournament_matches` row intact —
now pointing at nothing.

- After **`wipeAllData()`** ("permanently deletes every player, game, and stat"), the
  Tournaments list still shows every past tournament, now with blank player names, a
  blank champion, and dead bracket cards. The operation's own contract ("Wipes every
  player, game, and stat") is violated — the tournament shells survive a total wipe.
- After **`resetStats()`** ("wipe all games/turns, players kept"), each tournament
  match's `game_id` is NULLed, so a match that was `in_progress` silently reverts to
  `ready` (or a completed match keeps its `winner_id` but loses its linked game),
  leaving in-progress tournaments in an inconsistent half-state.

Both are reachable only by an admin (the routes are `requireAdmin`), so this is a
data-integrity/correctness defect, not a privilege issue — but it's *visible*
incorrectness right after an operation whose entire purpose is to leave a clean slate,
which is worse than a latent drift.

**Fix (step by step):**
1. In `wipeAllData()`, add `DELETE FROM tournaments;` — because `tournament_players`,
   `tournament_rounds` (and transitively `tournament_matches`) all cascade from
   `tournaments`, this one statement clears all four tables cleanly. Order doesn't
   matter with the cascades, but doing it alongside the existing
   `DELETE FROM players; DELETE FROM games;` is clearest.
2. For `resetStats()`, decide the intended semantics and make it consistent: since it
   deletes all games (which is what tournament matches link to), the least-surprising
   behavior is to also `DELETE FROM tournaments;` there — a stat reset that guts every
   game shouldn't leave dangling brackets. (If instead tournaments are meant to survive
   a stat reset, that's a deliberate product call to document in `REFERENCE.md`; the
   current behavior — silently NULLing `game_id` and reverting match state — is neither
   choice made on purpose.)
3. Add a committed `node:test`: create a tournament, run `wipeAllData()`, and assert
   `SELECT COUNT(*)` on all four tournament tables is 0; a second test for the chosen
   `resetStats()` semantics.
4. Pair with **BUG-6** and add the standing "new user-data table must be wired into
   both the export and the wipe" checklist note, so the next feature table doesn't
   reopen this.

**Verify:** create a tournament, run "Wipe all player & game data" from Settings,
reload the Tournaments tab, and confirm it's empty (no orphaned shells); the four
tournament tables are empty in the DB.

---

## BUG-8 — A stale cached page (mobile Safari) plus an unguarded boot-time `await` made a live server look like it had lost all its data  **(MED, user-facing / error-handling)**

**Status: ✅ Fixed (2026-07).** Two independent gaps compounded into this. Fix:
(1) `serveStatic()` (`backend/server.js`) now sends `Cache-Control: no-store` on
every static response (`index.html`, `display.html`, `scoring.js`, and the
SPA 404 fallback) via a new shared `NO_CACHE` header constant, so a browser can
no longer keep serving a pre-upgrade cached copy of the frontend indefinitely.
(2) The boot sequence's `await DB.loadAll()` (bottom of `frontend/index.html`)
is now wrapped in the same try/catch that already guards `DB.detect()`,
falling back to the existing `showBackendErrorScreen()` "Can't reach the
database" retry screen instead of leaving every section of the page frozen on
its static "Loading…" placeholder with no indication anything went wrong.
`REFERENCE.md`'s "Response headers" section (§9) documents both. Verified live
with Playwright: forcing `/api/stats` to fail now shows the retry screen
instead of a silent freeze; the normal path still renders fully with zero
console errors. Full 419-test backend suite green (neither change touches
scoring/stats logic, so no new `node:test` case — the Playwright checks above
are the closest thing to a regression guard for a boot-sequence/UI behavior
like this).

**Original report:** a user upgraded their self-hosted instance to the latest
`main` and reported "all data in the database is inaccessible in the UI" —
every Home-page section (Today's Challenge, Overview, the weekly pulse)
stuck permanently on its static "Loading…" placeholder, even though a data
export confirmed the database itself was intact. Reproducing the exact
upgrade path (seeding a database on the pre-merge server, then pointing the
new code at that same file) found no server-side error at all — every
Home-page endpoint returned correct data, the full test suite passed, and a
headless-browser load rendered the page fine. The decisive clue: the bug
reproduced only on the user's iPhone (mobile Safari), never on their laptop,
against the identical server — and a Private Browsing tab on the same iPhone
(which forces a fully uncached load) fixed it immediately. That isolates the
cause to a cached copy of the frontend running on that device, not the data
or the server.

**Where:**
- `backend/server.js` `serveStatic()` sent every static file with no
  `Cache-Control` header at all, leaving cache lifetime entirely up to browser
  heuristics — which mobile Safari applies more aggressively than desktop
  browsers typically do, with nothing forcing a revalidation after a server
  upgrade changes the served files.
- `frontend/index.html`'s boot IIFE wrapped `DB.detect()` (an explicit
  reachability probe) in try/catch but left the very next line,
  `await DB.loadAll()` (which actually fetches `/api/players` then
  `/api/stats`), unguarded. `DB.detect()` passing only proves the backend
  process is reachable — it says nothing about whether the specific requests
  `DB.loadAll()` makes will succeed. Any rejection there — this incident, or
  any future transient failure (a request dropped mid-restart, etc.) — was an
  unhandled promise rejection that silently aborted the rest of `init()`,
  which is also where `renderHome()` and `renderHomeChallengeTeaser()` are
  called. Nothing downstream of the failure point ever ran, so every
  "Loading…" placeholder in the static HTML was never replaced — including
  Today's Challenge, which needs no network call at all and is purely
  synchronous, making its continued "Loading…" state the tell that the whole
  boot sequence had aborted rather than any one fetch merely being slow.

**Misbehavior:** a user on a device with a stale cached copy of the frontend
sees every section of the Home page frozen on "Loading…" forever, with no
error message, no console entry the app itself surfaces, and no server-side
log entry (since nothing ever 500'd) — despite the database being completely
intact. This is very easy to mistake for real data loss, exactly as reported.

**Fix (step by step):**
1. Add a `NO_CACHE = { 'Cache-Control': 'no-store' }` constant in
   `backend/server.js` and spread it into every response `serveStatic()`
   sends (the success path and the SPA-fallback 404 path), so a client always
   fetches the current version of the frontend.
2. Wrap `await DB.loadAll()` in the boot IIFE in its own try/catch, calling
   `showBackendErrorScreen()` on failure — the same remedy `DB.detect()`'s
   failure path already uses, since the fix (reload/retry) is identical
   either way.
3. Document both in `REFERENCE.md` §9 ("Response headers") so a future reader
   debugging a similar "looks like data loss but isn't" report finds the
   mechanism immediately instead of re-deriving it.

**Verify:** with a Playwright-driven headless browser, intercepting `/api/stats`
to return a 500 now shows the "Can't reach the database" retry screen instead
of a silent freeze; an unmodified request path still renders the full Home
page with zero console errors; `curl -I` against `/`, `/display`, and
`/scoring.js` each show `Cache-Control: no-store`; full backend test suite
(419 tests) still green.

---

## BUG-9 — `completeGame()` records any player as the winner without checking they played in the game  **(MED, data-integrity)**

**Status: ✅ Fixed (2026-07).** `completeGame()` now rejects a `winner` who isn't in the
game's `game_players` with a `400` (mirroring `recordWalkover()`'s own check), while
still allowing a `null` winner (an abandoned game). Committed regression test
`backend/test/db.complete-game-guard.test.js`: a non-participant winner returns 400,
leaves `winner_id` NULL, and produces no phantom `h2hGamesWonByCat` entry; a real
participant still records normally; a null winner still completes. `REFERENCE.md`'s
`games.winner_id` schema note documents the participant requirement. Full backend suite
green. (Found in the 2026-07 fifth-pass audit; cross-ref `security-audit-roadmap.md`
Part 7 / SEC-17.)

**Where:** `backend/db.js` `completeGame(gameId, winnerName)`:

```js
function completeGame(gameId, winnerName) {
  const w = winnerName ? getPlayer(winnerName) : null;
  q.completeGame.run(w ? w.id : null, Number(gameId));   // <-- w.id never checked against this game's participants
  _fireGameLifecycleHooks('completed', { gameId: Number(gameId), winnerName: w ? w.name : null });
  return { ok: true };
}
```

`winnerName` is a client-supplied name (`POST /api/games/:id/complete { winner }`).
Any *existing* player is looked up and written straight into `games.winner_id` — with
no check that they were one of the game's participants (`game_players`).

**The asymmetry that proves it's a gap:** the sibling `recordWalkover()` path *does*
validate this — `if (!w || (w.id !== m.player1_id && w.id !== m.player2_id)) throw
400`. And BUG-4 added the same participant check to `_advanceTournamentMatch()` (the
tournament *consumer* of a completion). But the base `completeGame()` — which sets
`games.winner_id` **before** the hook fires — was never guarded, so the raw game record
can still name a non-participant winner even with BUG-4 in place. Same "hardened at one
consumer, not at the source" shape as `security-audit-roadmap.md` SEC-16.

**Misbehavior (verified):** completing a 2-player 501 game (Alice vs Bob) with
`winner: "Mallory"` (a real player who never played in it) sets `games.winner_id` to
Mallory's id, and `computeStats()` then reports `Mallory.h2hGamesWonByCat = {"501": 1}`
— a phantom H2H game win for a player who wasn't in the game. It also breaks the real
participants: `getPersonalBests()`'s `winStreak` walk sees `winner_id !== p.id` for
Alice/Bob on that game and **resets their win streaks**. `getH2HRecord()` counts the
game toward `total` while crediting neither side (the winner matches neither `p1` nor
`p2`), inflating "games played" with a winnerless-looking result. In normal play the
frontend always completes with an actual participant, so this is latent — reachable by
a malformed/hostile client, or by any anonymous caller under the
`OCHE_REQUIRE_AUTH=false` LAN opt-out; under the default it requires an admin session.
Primarily a data-integrity defect (the threat model's "stats must stay accurate" goal),
not a privilege issue.

**Fix (step by step):**
1. In `completeGame()`, when `winnerName` resolves to a player `w`, verify they took
   part in the game before writing `winner_id`:
   `if (w && !db.prepare('SELECT 1 FROM game_players WHERE game_id = ? AND player_id = ?').get(Number(gameId), w.id))
   throw httpError(400, 'winner must be a participant of this game');`
   Keep the `winnerName == null` path (a game completed with no winner — an abandoned
   game) working unchanged. This mirrors `recordWalkover()`'s existing 400 and completes
   the guard BUG-4 added only to the tournament-advancement consumer. (A 400 is safe:
   the frontend only ever completes with a real participant, so this never fires in
   normal play — same reasoning as BUG-4's own guards.)
2. Add a committed `node:test` in `backend/test/` (e.g. alongside the other
   `db.*`-completion tests): completing a game with a non-participant winner returns
   `400` and leaves `winner_id` NULL / the participants' stats intact; completing with a
   real participant still works; completing with no winner (abandoned) still works.
3. `REFERENCE.md` documents game completion (§ around `POST /api/games/:id/complete` /
   the `games.winner_id` column). Add a one-line note that the winner must be a
   participant (behavior for legitimate input is unchanged — the guard only rejects
   input that never occurs in normal play), in the same change.

**Verify:** the new test passes; a full normal game still completes and records its
winner; a completion naming a non-participant returns 400 and does not touch
`winner_id`.

---

## Sixth-pass audit (2026-07, whole-codebase general review)

The functional-defect counterparts to `security-audit-roadmap.md` Part 8, found in the
same general code-review pass. Two data-integrity/corruption risks (BUG-10, BUG-11),
one render-crash risk (BUG-12), and three lower-severity correctness gaps
(BUG-13 through BUG-15).

### BUG-10 — `readJson()` accumulates request-body chunks as strings, corrupting multi-byte characters split across a chunk boundary  **(MED)**

**Status: ✅ Fixed (2026-07).** `readJson()` now accumulates raw `Buffer` chunks in an
array and decodes to UTF-8 exactly once, via `Buffer.concat(chunks).toString('utf8')`,
at `end` — implemented together with `security-audit-roadmap.md` SEC-19/SEC-21 (same
function, same change). Committed regression test
`backend/test/server.request-body-hardening.test.js` ("BUG-10" describe block) opens a
raw `net.Socket` to a spawned server, writes a JSON body containing a 4-byte UTF-8
character (🎯) split into two separate socket writes with a real gap between them
(deliberately landing the split strictly inside the 4-byte sequence, which the old
per-chunk-decode would have corrupted into replacement characters), and confirms both
the HTTP response and the value actually persisted via `GET /api/players` contain the
character intact. Full backend suite green.

**Where:** `backend/server.js` `readJson()`:

```js
let raw = '';
req.on('data', c => {
  raw += c;
  if (raw.length > 1e6) { ... }
});
```

`c` is a `Buffer`; `raw += c` implicitly calls `c.toString()` (UTF-8) on *each chunk
independently* before concatenating. TCP/HTTP chunking has no obligation to split on a
character boundary — a multi-byte UTF-8 sequence (an emoji in a player name, an
accented character, any non-ASCII content sent from `index.html`'s `Backend` helper)
that happens to straddle two `data` events gets decoded as two separate malformed
fragments, each contributing a Unicode replacement character (`�`) or, in the worst
case, invalid bytes that break `JSON.parse` entirely — turning a perfectly valid
request into either silently-corrupted stored data (a name that displays as `Alic�`
forever after) or a spurious `400 Invalid JSON body` the client can't explain. Larger
bodies (a bigger `config` payload, a longer `card_tagline`) are more likely to be
chunked by Node's own internal buffering, so this gets more likely to fire as request
size grows, not less.

**Fix (step by step):**
1. Accumulate raw `Buffer` chunks in an array instead of decoding per-chunk:
   `const chunks = []; req.on('data', c => { chunks.push(c); ... size check on c.length ... });`
   then `JSON.parse(Buffer.concat(chunks).toString('utf8'))` once in the `end`
   handler. This also happens to fix `security-audit-roadmap.md` SEC-21 (the size cap
   currently counts decoded characters, not bytes) as the same change — implement once.
2. Add a committed `node:test`: construct a multi-byte character (e.g. an emoji) whose
   UTF-8 byte sequence is deliberately split across two writes to a mock/real request
   stream, and assert the resulting parsed JSON string is intact (not `�`-corrupted).
3. `REFERENCE.md`'s note (if any) on request-body handling gets a one-line mention that
   chunk boundaries are buffer-safe now.

**Verify:** the new test passes; existing ASCII-only request bodies are unaffected;
the SEC-21 byte-counting fix (same code path) is verified together.

### BUG-11 — Backup restore overwrites the live database file while the server still holds it open, risking corruption if any write lands before the required restart  **(MED)**

**Status: ✅ Fixed (2026-07).** `stageRestore()` now writes to a sidecar file
(`DB_PATH + '.restore-pending'`) instead of touching `DB_PATH` at all. A new
`applyPendingRestoreIfAny()` runs once at process startup, in `db.js`, **before** the
live `DatabaseSync` connection is ever opened — it removes any stale `-wal`/`-shm`
sidecars and atomically `fs.renameSync`s the pending file over `DB_PATH` (same
directory, so same filesystem — an atomic rename, not a copy). Since this runs before
anything has opened `DB_PATH` this process, there is no window for a concurrent write
to land on a half-swapped file — the class of risk is eliminated by construction, not
just made less likely. The "restart now" UX is unchanged (the admin still restarts the
container/process manually); the difference is entirely in what happens to the file
in the meantime. Committed regression coverage in two places: `backend/test/backup-
lib.test.js`'s `stageRestore`/`applyPendingRestoreIfAny` describe blocks assert at the
byte level that `stageRestore()` leaves `DB_PATH`'s bytes and `mtime` completely
unchanged (the only way to reliably prove this — reading through SQLite's own query
layer on a still-open connection can't distinguish old vs. new behavior, since WAL-
mode caching and Linux's "delete/overwrite while open" semantics mean a running
process can still see self-consistent query results even when the path-visible file
underneath it has silently changed), and that `applyPendingRestoreIfAny()` correctly
swaps the content in, clears stale WAL/SHM, and consumes the marker (idempotent on a
second call). `backend/test/backup-restore-two-phase.test.js` adds an end-to-end
integration check: stage a restore against a live, running server (confirming its own
on-disk file is byte-for-byte untouched and it keeps working normally afterward), then
start a fresh process against the same database path (simulating the real restart)
and confirm that process reflects the restored content, with the pending marker gone.
Full backend suite green (556/556).

**Where:** `backend/backup-lib.js` `stageRestore()`:

```js
function stageRestore(sourcePath) {
  for (const suffix of ['-wal', '-shm']) {
    const stale = DB_PATH + suffix;
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  }
  fs.copyFileSync(sourcePath, DB_PATH);
}
```

This deletes the live database's WAL/SHM sidecar files and overwrites `DB_PATH`
*in place* while the running server process still holds its own open `node:sqlite`
handle on the old inode (the file's own header comment already documents that Linux
keeps that handle pointing at the old inode's data until the process reopens the
file — which is exactly why a restart is required afterward). The gap: between
`stageRestore()` returning `200 { message: 'Restore staged...restart now' }` and the
admin actually restarting the process, the server is still fully live and will accept
normal gameplay writes (`addTurn`, `createGame`, etc.) — each of which now writes
through the *old* in-memory WAL state on top of a file that's been replaced out from
under it, since `fs.copyFileSync` doesn't coordinate with whatever the live connection
still thinks the file's current WAL/journal state is. A write landing in that window
risks either corrupting the just-restored file (defeating the whole point of the
restore) or corrupting the still-live old data before the restart discards it.

**Fix (step by step):**
1. Change `stageRestore()` to write the incoming file to a side path (e.g.
   `DB_PATH + '.restore-pending'`) instead of touching `DB_PATH` directly.
2. At process startup, before `db.js` opens `DB_PATH` (top of `db.js`, ahead of the
   `new DatabaseSync(DB_PATH)` call), check for `DB_PATH + '.restore-pending'`; if
   present, remove any stale `-wal`/`-shm` sidecars, atomically rename the pending file
   over `DB_PATH` (`fs.renameSync`, same-filesystem so it's atomic), delete the marker,
   and only then proceed to open the (now-restored) database. This guarantees the swap
   only ever happens while nothing holds the file open.
3. Update the "restart now" message and `docs/backups-roadmap.md` to describe the new
   two-phase behavior (staged now, applied automatically on next start) so it stays
   accurate — this is a behavior change, not just an implementation detail, per
   CLAUDE.md's "keep docs in sync" convention.
4. Add a committed `node:test`: stage a restore against a scratch `DB_PATH`, then
   invoke the startup-check function directly and assert the scratch DB's content now
   matches the staged file and the pending marker is gone.

**Verify:** the new test passes; a restore staged and then the process restarted (or
the startup check invoked directly in a test) ends up with the restored content live;
a normal boot with no pending restore is unaffected.

### BUG-12 — `display.html`'s Chuckin card crashes the whole render loop if `sessionAvg` isn't numeric  **(LOW)**

**Status: ✅ Fixed (2026-07).** `renderers.chuckin.card()` now computes `sessionAvgNum`
as `p.sessionAvg == null ? null : Number(p.sessionAvg)` and only calls `.toFixed(1)`
when `Number.isFinite(sessionAvgNum)`, falling back to `'—'` otherwise — the `== null`
branch is kept **separate** from the `Number.isFinite()` check because `Number(null)`
is `0`, not `NaN`, so folding them into one check would have silently broken the
legitimate "no darts thrown yet this session" case (an early-session `null`) by
rendering `0.0` instead of the placeholder; this was caught by the regression test
itself before being shipped. **Also fixed in the same sweep**:
`buildChuckinLiveHeatmap()`'s `cells||[]` guard let a non-array-but-truthy payload
value (e.g. a crafted string) through unchanged, crashing on `.forEach` — now
`Array.isArray(cells) ? cells : []`, matching every other live-payload array field in
this file. No other unguarded method-call-on-payload-value pattern was found in a
full sweep of `display.html`'s card renderers. Committed regression test
`backend/test/display.chuckin-card-hardening.test.js` extracts `renderers.chuckin.
card()` and its real dependencies directly out of `frontend/display.html`'s source
(via `vm`, same approach as the SEC-18 test) and confirms: a crafted non-numeric
`sessionAvg` renders `'—'` and never reaches the output unescaped; a legitimate
numeric value still renders correctly; a legitimate `null` (not-yet-started session)
still renders `'—'`, not `'0.0'`; a crafted non-array `heatmap` value doesn't crash.
Verified the test fails against the pre-fix code (2 of 4 cases) and passes against
the fix. Full backend suite green (560/560).

**Where:** `frontend/display.html` `renderers.chuckin.card()`:

```js
const avgText = p.sessionAvg!=null ? p.sessionAvg.toFixed(1) : '—';
```

`p.sessionAvg` comes from the `/api/live` broadcast payload's per-player array, which
`ALLOWED_LIVE_KEYS` deliberately leaves unrestricted in shape (documented at its
definition in `server.js`). The `!=null` guard only rules out `null`/`undefined` — any
other non-numeric truthy value (a string, an object) reaches `.toFixed(1)` directly and
throws inside `renderState()`'s `grid.innerHTML = s.players.map(...).join('')`, which
has no surrounding `try/catch` — the exception propagates out of the SSE `onmessage`
handler and the scoreboard stops updating on every subsequent live event until a
reload, with no visible error to the person watching the screen.

**Fix (step by step):**
1. Coerce before formatting: `const avgNum = Number(p.sessionAvg); const avgText =
   Number.isFinite(avgNum) ? avgNum.toFixed(1) : '—';` — same pattern this file's own
   `num()` helper already applies to every other live-payload numeric field, just not
   consistently to this one.
2. Sweep the other per-game-type card renderers in this file for the same
   direct-method-call-on-payload-value pattern (anywhere a `p.<field>` or `s.<field>`
   from the live payload has a method called on it — `.toFixed`, `.map`, `.join` —
   without a `Number()`/`Array.isArray()` guard first) and apply the same coercion.
3. Add a committed `node:test` or scratch script asserting the card-building function
   returns a fallback string (not a thrown error) when fed a non-numeric `sessionAvg`.

**Verify:** a crafted non-numeric `sessionAvg` in a live payload renders `'—'` instead
of crashing; the scoreboard keeps updating on the next legitimate event.

### BUG-13 — `deleteLastTurn()` deletes the newest turn for the *game*, not a specific turn, so undo is ambiguous with more than one scoring device  **(LOW)**

**Status: ✅ Fixed (2026-07).** `addTurn()` now returns `{ ok: true, turnId }` (purely
additive — nothing previously read beyond `.ok`). `deleteLastTurn(gameId, turnId)`
takes an optional second argument: omitted, behavior is unchanged (delete whatever's
newest); supplied, it must match the game's actual newest turn or the call is
rejected with `409` and nothing is deleted. `server.js`'s `DELETE
/api/games/:id/turns/last` route reads it from `?turnId=`. `frontend/index.html`'s
`DB` object threads it through transparently — `recordTurn()` stashes the id its own
last write actually created (`DB.lastTurnId`), and `deleteLastTurn()` sends it, then
**clears** it immediately (not guesses the next one) so a second undo pressed right
after the first, with no new `recordTurn()` in between, falls back to the original
unguarded behavior instead of being rejected for a turn id that's stale by design —
this only ever adds protection for the one case that's actually verifiable (undo
immediately following a turn this device itself recorded), never a new failure mode
for repeated-undo or a fresh page load (where `lastTurnId` resets to `null`). No
caller in `index.html` needed to change — `DB.recordTurn`/`DB.deleteLastTurn` are the
only two functions that needed to know about this, transparent to the 7 call sites
across every game type. Committed regression test
`backend/test/db.delete-last-turn-guard.test.js` confirms `addTurn()`'s new return
shape, the unchanged no-`turnId` behavior, a matching `turnId` deleting normally, a
stale `turnId` (simulating a second device having recorded a newer turn since)
rejecting with `409` and deleting nothing, and a `turnId` that never existed also
rejecting. Verified the test fails entirely against the pre-fix code. Full backend
suite green (565/565).

**Where:** `backend/db.js` `deleteLastTurn(gameId)`:

```js
function deleteLastTurn(gameId) {
  db.prepare('DELETE FROM turns WHERE id = (SELECT MAX(id) FROM turns WHERE game_id = ?)').run(Number(gameId));
  return { ok: true };
}
```

The app's designed usage (one controller device scoring a game) makes "the newest turn
in this game" and "the turn the person pressing Undo is looking at" identical. But
nothing in the API or the schema enforces single-device scoring, and if a game is ever
scored from two devices/tabs concurrently (a second browser tab left open, a phone and
a tablet both pointed at the same game), pressing Undo on one device deletes whichever
turn is newest *globally for the game* — which may be the other device's turn, not the
one the person pressing Undo can see on their own screen. Silent and confusing rather
than exploitable.

**Fix (step by step):**
1. Have the client send the id of the turn it believes is "last" (it already has this
   — `DB.deleteLastTurn()` in `index.html` is called right after recording a turn whose
   response includes enough to know its id, or a quick follow-up read) as
   `DELETE /api/games/:id/turns/last?turnId=...`.
2. In `deleteLastTurn()`, when `turnId` is supplied, verify it actually matches
   `MAX(id)` for the game before deleting; if it doesn't match, return a `409`-style
   response the client can use to prompt a refresh instead of silently deleting the
   wrong turn.
3. Keep the no-`turnId` call shape working (delete whatever is newest) for backward
   compatibility / the common single-device case, so this is additive, not breaking.
4. Add a committed `node:test`: with two turns recorded, calling with a stale
   `turnId` (not matching current `MAX(id)`) leaves both turns intact and returns the
   conflict response; calling with the correct `turnId` (or no `turnId`) deletes as
   before.

**Verify:** the new test passes; the existing single-device Undo flow in `index.html`
is unaffected (no `turnId` sent, or the id it sends always matches in the normal case).

### BUG-14 — Uploaded-backup stream ignores write-stream backpressure, buffering up to the full 500MB cap in memory on a slow disk  **(LOW)**

**Status: ✅ Fixed (2026-07).** `handleUploadRestore()`'s `'data'` handler now checks
`out.write(chunk) === false` and, when the write stream's internal buffer is full,
`req.pause()`s the readable side and `req.resume()`s it once `out` emits `'drain'` —
the standard Node backpressure handshake. Committed regression coverage in
`backend/test/server.upload-backpressure.test.js` extracts `handleUploadRestore()`
directly from `server.js`'s real source and asserts the pattern is present (checks
`write()`'s return value, pauses on backpressure, waits for `'drain'`, resumes) — a
deliberate choice over trying to force real backpressure end-to-end: whether
`write()` ever returns `false` depends on genuine OS/disk write timing, which isn't
reliably triggerable or observable from outside the process in a fast, deterministic
test, especially against this sandbox's typically fast overlay filesystem where a
test-sized payload wouldn't exercise the buffer-full path regardless of whether the
fix is present — a source-pattern assertion is what actually guards against this
specific handling being silently reverted later while everything else still appears
to work. The existing full upload-restore round trip in `server.backups.test.js` (9
tests) re-confirms the fix doesn't break normal uploads — unchanged, still green.
Verified the new test fails against the pre-fix code. Full backend suite green
(566/566).

**Where:** `backend/server.js` `handleUploadRestore()`:

```js
req.on('data', chunk => {
  ...
  out.write(chunk);
});
```

`fs.createWriteStream(...).write()`'s return value (`false` when the internal buffer
is full and the caller should pause upstream until `'drain'`) is never checked. If disk
write throughput is slower than the incoming network stream — plausible on
constrained self-hosted hardware (SD card, network-attached storage, a Pi) — Node
keeps buffering unwritten chunks in process memory rather than pausing `req`, so a
large upload (up to the documented `MAX_BACKUP_UPLOAD_BYTES` = 500MB) can transiently
hold most or all of itself in memory instead of the small streaming footprint the
design comment (`docs/backups-roadmap.md v2`, "streams straight to disk... rather than
buffering it as one string") intends. Admin-only route, so this needs a cooperating or
compromised admin session to trigger — low severity, but a straightforward fix.

**Fix (step by step):**
1. Respect backpressure: `if (out.write(chunk) === false) { req.pause();
   out.once('drain', () => req.resume()); }` inside the existing `'data'` handler, or
   more simply switch to `stream.pipeline(req, out)` (Node's built-in, backpressure-
   aware pipe) with a `Transform` stream in between that does the existing byte-count
   cap check per chunk instead of hand-rolling pause/resume.
2. Add a committed `node:test` (or a scratch integration test) simulating a slow
   `WriteStream` (e.g. one that never emits `'drain'` until manually triggered) and
   asserting the request's `'data'` events stop being consumed once the write buffer
   is full, rather than piling up.

**Verify:** the new test passes; a normal-speed upload (the common case, current CI
hardware) completes exactly as before with no behavior change.

### BUG-15 — Reverse-proxy deployment without `TRUST_PROXY=true` collapses every client onto one shared rate-limit bucket  **(LOW, deployment foot-gun)**

**Status: ✅ Fixed (2026-07).** `clientIp()` now warns once (via a module-level flag,
not per-request) the first time it observes an `X-Forwarded-For` header while
`TRUST_PROXY` is unset, explaining the shared-bucket consequence and pointing at the
env var. No behavior change to IP resolution itself — purely additive observability.
`README.md`'s "Exposing this to the internet — checklist" already pairs
`TRUST_PROXY=true` with `COOKIE_SECURE=true` as of the SEC-24 fix (both findings
pointed at the same checklist, closed together). Committed regression test
`backend/test/server.trust-proxy-warning.test.js` confirms: repeated requests
carrying `X-Forwarded-For` with `TRUST_PROXY` unset produce exactly one warning, not
one per request; no `X-Forwarded-For` ever sent produces no warning; `TRUST_PROXY=true`
produces no warning even with the header present. Verified the test fails against the
pre-fix code. Full backend suite green (569/569).

**Where:** `backend/server.js` `clientIp()` and the `rateLimit('global', ip, 300,
60000)` call ahead of all routing. Working as designed — `TRUST_PROXY` deliberately
defaults off so a client can't spoof `X-Forwarded-For` to evade or frame another IP
(the comment at `clientIp()`'s definition explains this). But if this app is later put
behind a reverse proxy (a real possibility given "may be exposed to the open internet")
and the operator doesn't also set `TRUST_PROXY=true`, every request appears to
originate from the proxy's single loopback/internal address — so the entire
household shares one 300-requests-per-minute global budget (and one 10/min login
budget, one 10/min PIN-verify budget, etc.), and ordinary multi-device gameplay can
trip `429 Too many requests` for everyone during a busy session, misread as the app
being broken rather than a config gap.

**Fix (step by step):**
1. At startup, if the server detects it's receiving requests with an
   `X-Forwarded-For` header while `TRUST_PROXY` is not set to `true`, log a one-time
   `console.warn` (e.g. the first time `clientIp()` observes `req.headers['x-forwarded-for']`
   truthy while `TRUST_PROXY` is false) explaining that all such clients are being
   rate-limited as one IP and pointing at the `TRUST_PROXY` env var.
2. Add a short paragraph to the reverse-proxy section of `README.md`/deployment docs
   pairing `TRUST_PROXY=true` with `COOKIE_SECURE=true` (see
   `security-audit-roadmap.md` SEC-24) as the two settings a proxied deployment needs
   together, so they're documented as a pair rather than two easy-to-miss independent
   flags.

**Verify:** the warning fires once (not per-request) when a proxied setup is detected
without `TRUST_PROXY`; no change to behavior or logging for the default direct-connect
deployment (no `X-Forwarded-For` header ever arrives).

---

## BUG-16 — `importPlayerExport()`'s duplicate-game guard skipped re-inserting the game row, but not its turns/darts underneath it  **(MED, data-integrity)**

**Status: ✅ Fixed (2026-07).** `backend/db.js` `importPlayerExport()` now tracks
skipped-as-duplicate games in a `skippedGameIds` set and checks it first in the turns
loop, so a duplicate game's turns (and, transitively, its darts) are no longer
re-inserted under the pre-existing local game. Committed regression test in
`backend/test/db.export.test.js` (the "imports a fresh player + opponent…" case):
re-importing the same export now asserts `turnsImported === 0` and `dartsImported ===
0`, and directly queries `turns`/`darts` row counts under the local game to confirm
they stay at 2 and 6 respectively rather than doubling. Full backend suite green.
(Found via a live user bug report: exporting a player and immediately re-importing
them duplicated all of that player's darts even though the player and the game itself
were correctly recognized as already existing.)

**Where:** `backend/db.js` `importPlayerExport()`, the per-game loop and the turns loop
right after it:

```js
for (const g of games) {
  ...
  const existingId = _findMatchingLocalGame(g, targetIds);
  if (existingId) { gameIdMap.set(g.id, existingId); gamesSkipped++; continue; }  // <-- gameIdMap still gets a non-null value
  ...
}
...
for (const t of turns) {
  const newGameId = gameIdMap.get(t.game_id);
  const tid = idMap.get(t.player_id);
  if (newGameId == null || tid == null) continue; // <-- comment says "skipped game", but newGameId is never null for one
  const info = insertTurn.run(newGameId, tid, ...);   // <-- inserts a second copy of the turn under the EXISTING game
  ...
}
```

**The gap that let it ship:** `_findMatchingLocalGame()` correctly recognizes a
duplicate game by fingerprint (`created_at`/`category`/`game_type`/`legs_per_set`/
`sets_per_game` + exact participant set) and skips creating a second `games` row —
`gamesImported`/`gamesSkipped` counts were correct, and the H2H record (which only
counts games) stayed correct too. But `gameIdMap.set(g.id, existingId)` maps the
source game id to the *existing* local game id rather than to nothing, so the turns
loop's `newGameId == null` check — meant to skip turns belonging to a duplicate-skipped
game — never actually fired for one. Every turn (and every dart under it, via the
same pattern one loop down) got inserted a second time, silently doubling that
player's turn/dart counts and every stat derived from them, while the higher-level
counts (`gamesImported`, `gamesSkipped`, H2H) looked completely correct. The existing
re-import-idempotency test only asserted `gamesImported`/`gamesSkipped`/H2H total —
never `turnsImported`/`dartsImported` or actual row counts — so nothing caught it.

**Misbehavior (verified):** exporting a player with 1 completed game (2 turns, 6
darts) and importing that same export twice reports `gamesImported: 0, gamesSkipped:
1` correctly on the second import, but before the fix also reported
`turnsImported: 2, dartsImported: 6` — a second, real set of turn/dart rows landing
under the one (correctly deduped) game — silently doubling every stat derived from
that game's darts (averages, checkout stats, badge-eligible throws, etc.) each time
the same file was re-imported.

**Fix (step by step):**
1. Track which source game ids were matched to an existing local game
   (`skippedGameIds`, a `Set`) separately from `gameIdMap` (which still needs the
   source→local mapping for other purposes, e.g. an opponent's own later import
   referencing the same shared game).
2. In the turns loop, check `skippedGameIds.has(t.game_id)` first and `continue`
   before touching `gameIdMap`/`idMap` at all, so a duplicate-skipped game's turns
   are never inserted (and its darts, which key off `turnIdMap`, follow automatically
   since no turn id is ever recorded for them to attach to).
3. Add a committed `node:test` (extending the existing re-import-idempotency case
   rather than a new one) that asserts `turnsImported === 0` and `dartsImported === 0`
   on re-import, plus direct `SELECT COUNT(*)` checks against `turns`/`darts` for the
   local game — not just the `gamesImported`/`gamesSkipped`/H2H counts that let this
   ship in the first place.

**Verify:** the new assertions fail on the pre-fix code (`turnsImported`/`dartsImported`
report 2/6 instead of 0 on re-import) and pass after the fix; the fresh-import and
opponent-stub-upgrade tests are unaffected; full backend suite green.

---

## BUG-17 — Ghost mode's past-leg picker (and race label) showed "Invalid Date" instead of the leg's date  **(LOW, cosmetic / cross-browser)**

**Status: ✅ Fixed (2026-07).** `renderGhostLegList()` and the Ghost race label
builder in `frontend/index.html` now call a new `parseSqliteTimestamp()`
(`frontend/scoring.js`) before handing a leg's date to `.toLocaleDateString()`,
instead of passing the raw SQLite string straight to `new Date()`. Committed
regression suite in `backend/test/scoring.test.js` (5 cases): the
space-separated no-timezone shape parses to the correct UTC instant; a string
that already carries `Z` or a `+/-HH:MM` offset isn't double-suffixed; `null`/
`undefined`/`''` return `null` rather than an Invalid Date object; and
`toLocaleDateString()` on the result is never the literal string "Invalid
Date". Verified end-to-end with Playwright against a live server: played and
won a real X01 leg, opened Ghost mode's New Game screen for that player, and
confirmed the picker shows a real formatted date ("Jul 14, 2026") rather than
"Invalid Date." Full backend suite green (605 tests). (Found via a live user
bug report: "for all the past legs, it is showing invalid date" in Ghost mode.)

**Where:** `frontend/index.html`, two call sites both reading
`getGhostCandidateLegs()`'s `MAX(t.created_at) AS date` column (`backend/db.js`)
straight into `new Date()`:

```js
// renderGhostLegList() — the leg picker itself, the exact screen from the bug report
const date = new Date(l.date).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});

// the Ghost race label, built once a leg is selected and the race starts
const ghostLabel = `👻 Ghost (${new Date(setup.ghostLeg.date).toLocaleDateString(undefined,{month:'short',day:'numeric'})})`;
```

**Root cause:** every `*_at` column in `backend/db.js`'s schema defaults to
SQLite's `datetime('now')`, which produces `"YYYY-MM-DD HH:MM:SS"` — a
space-separated, always-UTC string with no `T` separator and no timezone
suffix. That shape sits outside the one format `new Date(string)` is required
by the ECMAScript spec to parse consistently across engines (ISO 8601, `"...
THH:MM:SSZ"`). This exact gap had already bitten this codebase **three
separate times before** — `frontend/index.html` already has three other call
sites (a challenge-completion timestamp, a badge's `earned_at`, and
`fmtDate()`'s general-purpose formatter) that each independently learned to
sanitize the string first (`str.replace(' ','T') + 'Z'`) before handing it to
`new Date()`. Ghost mode's two call sites were written without that same
fix — either predating the pattern being established, or simply missed when
it was — so they inherited the exact same cross-browser "Invalid Date" defect
the other three call sites had already worked around.

**Misbehavior (verified):** on any JS engine that parses `new
Date("2024-01-15 10:30:00")` as `Invalid Date` (V8/Node happens to accept this
non-standard shape leniently, but that's not guaranteed by spec — the reporting
user's browser did not), every entry in Ghost mode's past-leg picker showed
"Invalid Date" instead of the leg's actual date, and the in-progress race label
did too once a leg was selected and the race started.

**Fix (step by step):**
1. Add `parseSqliteTimestamp(dt)` to `frontend/scoring.js` — the same
   `.replace(' ','T') + (hasTz ? '' : 'Z')` sanitization the three existing
   working call sites already use, centralized into one pure, unit-testable
   function rather than becoming a fourth (now fifth, counting both Ghost call
   sites) copy-pasted inline fix.
2. Call it at both of Ghost mode's broken call sites in place of the raw
   `new Date(...)`, keeping each site's own `.toLocaleDateString()` options
   (with year for the picker list, without for the compact race label)
   unchanged — this is a parsing fix, not a display-format change.
3. Add a committed `node:test` suite for `parseSqliteTimestamp()` covering the
   untagged shape, an already-`Z`-suffixed shape, an already-offset-suffixed
   shape, nullish input, and the literal "Invalid Date" symptom via
   `toLocaleDateString()` — the exact gap that let this ship unnoticed despite
   the identical bug already having a known fix pattern elsewhere in the same
   file.
4. Deliberately **not** touched: the three pre-existing, already-working
   inline occurrences of this same sanitization pattern — refactoring working
   code to call the new shared helper is out of scope for a bug fix; only the
   two genuinely broken call sites were changed.

**Verify:** the new test suite passes; a live server + Playwright check confirms
the Ghost mode leg picker renders a real date for a freshly-won leg instead of
"Invalid Date"; full backend suite green.

---

## BUG-18 — Ghost mode incorrectly offered a "Next leg" button instead of ending the race, and never marked its game complete server-side  **(MED, user-facing / data-integrity)**

**Status: ✅ Fixed (2026-07).** `onLegWon()`'s set/match-win gate in
`frontend/index.html` now reads `(!game.practice || game.hasGhost)` instead of
`!game.practice` alone. Ghost mode's win/loss recording
(`DB.recordGhostRace()`/Ghost Slayer badge check) was moved from the function's
unconditional "just a leg" tail into the "game (match) won" branch, since a
ghost race — always exactly 1 leg/1 set — now always resolves there instead,
making the tail permanently unreachable for ghost races. Verified end-to-end
against a live server: won a real leg, started and completed a ghost race
against it, and confirmed the end screen shows "GAME OVER"/"New game" (not
"LEG COMPLETE"/"Next leg"), and directly inspected the SQLite file afterward to
confirm the race's `games` row got `completed_at` and `winner_id` set — which
it never did before this fix, a second, previously undiscovered bug this same
change happens to resolve. Full backend suite unaffected (605 tests, this fix
is frontend-only). (Found via a live user bug report: clicking "Next leg"
after a ghost race started a new game where the ghost no longer auto-played
and the user could enter scores for it manually — a direct consequence of the
race never actually ending.)

**Where:** `frontend/index.html`, `onLegWon()` (the X01 leg/set/game
progression function; Ghost mode is X01-only — `setMode()` forces
`setup.gameType` back to `'x01'` whenever mode is `'ghost'` or `'challenge'`,
so Cricket's/Baseball's own `onLegWon*()` siblings were never affected):

```js
if(!game.practice && w.legsWon >= game.legsPerSet){      // set won (H2H only)
  ...
  if(w.setsWon >= game.setsPerGame){   // game (match) won
    ...
    DB.completeGame(w.name);
    ...
    finishUnit('game', w.name);
    return;
  }
  ...
}
...
// unconditional tail, always reached when the gate above is false
if(game.hasGhost && game.ghostSourceLeg && DB.gameId != null){
  DB.recordGhostRace(...);   // <-- only ever reached here, since game.practice was always true for ghost
}
game.matchResult = { ..., kind:'leg', ... };
finishUnit('leg', w.name);
```

**Root cause:** `setMode('ghost')` sets `setup.practice = (mode !== 'h2h')` —
true for every mode except `'h2h'`, with no special case for `'ghost'` — so
`game.practice` is always `true` for a ghost race, exactly like a genuine
open-ended practice session. `startGame()` separately forces
`legsPerSet`/`setsPerGame` to `1` for ghost mode (via its `drillModes` list),
which would be enough on its own to make `w.legsWon >= game.legsPerSet` true
after the very first leg — but the outer gate's `!game.practice` check blocked
entry into that branch regardless, since `game.practice` is unconditionally
true. The existing comment directly above this gate even asserted this was
fine ("The set/match-win tree below this is separately gated on
`!game.practice`, always true for a ghost race anyway") — describing the
actual (buggy) behavior without anyone verifying it was the *correct*
behavior. A ghost race therefore always fell through to the same
unconditional "just a leg" tail every genuine open-ended practice leg uses —
`kind:'leg'`, `finishUnit('leg', ...)` — rendering "LEG COMPLETE" with "Next
leg"/"End game" buttons, and never once reaching `DB.completeGame()`.

**Misbehavior (verified):** winning (or losing) a ghost race showed "LEG
COMPLETE" with a "Next leg" button. Clicking it called `startNextLeg()` on the
same `game` object — which resets scores/turn order for a fresh leg but has no
special handling to re-arm the ghost's scripted replay — leaving the ghost
player present as an ordinary, human-scoreable slot with no auto-play behind
it, exactly the "entering scores for the ghost" symptom reported. Separately,
because `DB.completeGame()` was never reached, every ghost race's `games` row
was left with `completed_at = NULL` and `winner_id = NULL` forever, regardless
of whether the human ever clicked "End game" — a data-integrity gap only
visible by inspecting the database directly, not from the UI.

**Fix (step by step):**
1. Change `onLegWon()`'s gate from `if(!game.practice && w.legsWon >=
   game.legsPerSet)` to `if((!game.practice || game.hasGhost) && w.legsWon >=
   game.legsPerSet)` — a ghost race now always enters the set/match-win tree,
   and since `legsPerSet`/`setsPerGame` are already forced to `1`, it always
   resolves straight to the innermost "game (match) won" branch.
2. Move the `game.hasGhost && game.ghostSourceLeg` win/loss-recording block
   (Ghost Slayer badge, `DB.recordGhostRace()`) from the function's
   unconditional tail into the "game (match) won" branch, immediately before
   its own `finishUnit('game', w.name); return;` — leaving it in the tail
   would have made it permanently unreachable for ghost races the moment step
   1 started routing them through the branch above instead.
3. No changes needed to `opp` (`game.players.length===2 && !game.hasGhost ?
   ... : null`) or anything gated on it (Comeback Kid, Giant Slayer, Rematch,
   Grudge Match, Nerves of Steel, the H2H-summary fetch) — a ghost is still
   never treated as a real H2H opponent for any of those, unaffected by this
   fix. `h2hStatsHtml(winner,'game')` and `matchWinStatLine()` (both already
   generic over `game.players`, not gated on `opp`) now render for a completed
   ghost race for the first time — verified safe, since both only read
   generic per-player stat fields every player object (including the ghost's)
   already carries.
4. No committed `node:test` case — this is a DOM/game-state control-flow
   defect with no pure-function calculation to extract, the same class of gap
   BUG-8 covered with a live Playwright check instead of a `node:test` case.

**Verify:** live server + Playwright: played and won a source leg, started and
completed a ghost race against it, confirmed "GAME OVER"/"New game" (not "LEG
COMPLETE"/"Next leg"); direct SQLite inspection confirmed the ghost race's
`games` row got `completed_at`/`winner_id` set. Full backend suite green (605
tests, unaffected — this fix touches no backend code).

---

## Seventh-pass audit (2026-07, weighted to code merged since the sixth pass)

The functional-defect counterparts to `security-audit-roadmap.md` Part 9, from the same
adversarial re-read weighted toward the Baseball / per-player export-import / league-
fixtures / New-Game-wizard code merged since the sixth pass. The Baseball stat formulas
(RPI, Perfect Innings/Game, won-leg derivation, Personal Bests) were cross-checked
against `REFERENCE.md` §3 and found correct, as were the Triple Bull / Bullseye Finish
achievement conditions (§ badges) including their suppression pair. One
data-availability bug found (BUG-19).

### BUG-19 — `getPlayerExport()` builds one SQL bound variable per turn (and per dart), so exporting a prolific player throws "too many SQL variables" and 500s  **(LOW, latent / data-availability)**

**Status: ✅ Fixed (2026-07).** A new `_selectByIdChunks(cols, table, column, ids,
chunkSize)` helper (default batch 900, well under SQLite's 32766 bound-variable cap)
replaces all four single-`IN (...)` reads in `getPlayerExport()` (games, gamePlayers,
turns, darts) and the opponents lookup, so the per-statement variable count is bounded
regardless of how much history a player has. `getPlayerExport(name, chunkSize)` takes an
optional chunk size (default 900) purely so the test can force the multi-batch path with
a handful of rows. `importPlayerExport()` already iterated row-by-row and needed no
change. Committed regression test in `backend/test/db.export.test.js`: exporting a
player across several games/turns with `chunkSize:2` returns every game/turn/dart, and
the default call returns the identical complete set. `REFERENCE.md`'s per-player export
section unchanged (the payload shape is byte-for-byte identical — this is an internal
query-batching fix with no behavior change). Full backend suite green.

**Where:** `backend/db.js` `getPlayerExport()` (the `GET /api/players/export` payload,
admin-only, Settings → Data Export → Export Player):

```js
const turnIds = turns.map(t => t.id);
const tph = turnIds.map(() => '?').join(',');
const darts = turnIds.length ? db.prepare(`SELECT * FROM darts WHERE turn_id IN (${tph})`).all(...turnIds) : [];
```

Every id is expanded into its own `?` placeholder in a single `IN (...)` list —
`games`/`gamePlayers`/`turns` keyed on `gameIds`, and `darts` keyed on `turnIds`. SQLite
(including `node:sqlite`) caps a statement at `SQLITE_MAX_VARIABLE_NUMBER` bound
parameters — **32766** in current builds (verified in this environment: a 32767-variable
`IN` list throws `too many SQL variables`, 32766 succeeds).

**Misbehavior:** `turnIds` is the first list to cross the cap — a player with more than
32766 recorded turns (a heavy multi-year user; every X01/Cricket/Baseball visit is one
turn) makes the `darts IN (${tph})` prepare throw `too many SQL variables`. That throw
isn't an `httpError`, so it falls through to the generic `500` handler: the export the UI
presents as "it's your data, you can always take it with you" simply fails with an opaque
server error for exactly the most active players, who have the most to lose. The
`games`/`gamePlayers`/`turns` lists hit the same wall once a player exceeds 32766 games
(rarer, but the same defect). Latent today only because no test fixture is that large.

**Fix (step by step):**
1. Add a small `_selectByIdChunks(table, column, ids, extraCols)` helper (or an inline
   loop) that splits `ids` into batches well under the limit (e.g. 900, matching the
   conservative SQLite default) and concatenates the `.all(...)` results — so the number
   of bound variables per prepared statement is bounded regardless of how many rows the
   player has. Use it for all four `IN (...)` reads in `getPlayerExport()` (games,
   gamePlayers, turns, darts) and the `opponents` lookup.
2. The import side (`importPlayerExport()`) already iterates row-by-row rather than
   building one giant `IN`, so it needs no change — this is export-only.
3. Add a committed `node:test` in `backend/test/db.export.test.js`: seed a player across
   several games/turns and export with a small injected `chunkSize` (2) so the
   `games`/`turns`/`darts` id lists each span multiple batches, then assert the export
   returns every game/turn/dart (and that the default no-`chunkSize` call returns the
   identical complete set). This guards the batching logic's own correctness — that
   multiple `IN (...)` batches concatenate without dropping or duplicating rows, the
   real risk introduced by the fix. Reproducing the *literal* pre-fix "too many SQL
   variables" throw would require seeding past the ~32k cap (slow), so the test targets
   the fix's correctness rather than the raw throw; the injectable `chunkSize` is what
   makes the multi-batch path exercisable with a handful of rows.

**Verify:** the new test passes; a normal small-history export is unchanged; the full
backend suite stays green.

---

### BUG-20 — Just Chuckin' It's live scoreboard heatmap shades both single regions of a number for any single hit, because the session tally and its renderer are zone-blind  **(LOW, user-facing / cosmetic; found via a live user bug report)**

**Status: OPEN.**

**Dart *tracking* is correct — this is a display-only defect.** Confirmed end to end:
the geometric dartboard input (`buildDartboard()` in `frontend/index.html`) stamps
`zone:'inner'` on the near-bull single region (`annulus(R.bullOut,R.trebleIn,...)`,
line ~1696) and `zone:'outer'` on the near-rim single region
(`annulus(R.trebleOut,R.doubleIn,...)`, line ~1698); `throwDartChuckin()` forwards that
zone into `DB.recordTurn({ darts:[{ ..., zone }] })`; `backend/db.js`'s
`getDartHeatmap()` stores it and groups by `d.zone`; and the **lifetime** Player Profile
heatmap (`buildDartHeatmap()`) already renders the two single regions independently
(`heat(num,1,'inner')` vs `heat(num,1,'outer')`). So which half a dart landed in is
recorded and reported correctly everywhere *except* the live scoreboard.

**Where:** the live, session-only path, which drops the zone at three points:
- `frontend/index.html` `throwDartChuckin()` tallies into `p.heatmap` keyed by
  `dart.sector+'_'+dart.mult` — **no zone**, so an inner 20 and an outer 20 both land in
  the same `20_1` bucket.
- `frontend/index.html` `playerSnapshotChuckin()` emits `{sector,multiplier,hits}` cells
  with **no zone** field.
- `frontend/display.html` `buildChuckinLiveHeatmap()` shades *both* single annuli — the
  inner one (`annulus(R.bullOut,R.trebleIn,...)`) and the outer one
  (`annulus(R.trebleOut,R.doubleIn,...)`) — from the same `heat(n,1)` value, and only
  the inner one even carries a `<title>`.

**Misbehavior (as reported):** in a Just Chuckin' It session, entering a single 20
(inner *or* outer) lights up **both** the top (inner) and bottom (outer) halves of the
20 wedge on the /display live heatmap equally, instead of only the half actually hit.
The lifetime heatmap on the Player Profile is unaffected (it was already zone-aware).
Purely visual — no stat, count, or stored dart is wrong.

**Fix (step by step):**
1. `throwDartChuckin()`: key the session tally by `dart.sector+'_'+dart.mult+'_'+(zone||'')`,
   mirroring `buildDartHeatmap()`'s own `sector_mult_zone` keying (`zone` is the param it
   already receives — only ever set for a Dartboard-mode single; Pad mode leaves it
   null, trebles/doubles/bull carry none).
2. `playerSnapshotChuckin()`: parse the zone segment out of the key and include it in
   each emitted cell (`{sector,multiplier,zone,hits}`).
3. `buildChuckinLiveHeatmap()`: key `hitMap` by `sector_mult_zone` (normalizing `zone`
   to only `'inner'`/`'outer'`/`''` at the boundary, same SEC-18 "coerce/constrain
   payload values" discipline the function already applies to `sector`/`mult`/`hits`);
   shade the inner single from `heat(n,1,'inner')` and the outer single from
   `heat(n,1,'outer')`, each with its own `<title>`; and — matching `buildDartHeatmap()`'s
   deliberate product decision — do **not** plot a zone-unspecified single (Pad-mode
   dart) on either region rather than lighting up both. Bull/treble/double keep their
   zone-less keys unchanged.
4. Update `REFERENCE.md`'s "Live Scoreboard" Chuckin heatmap section (it documents the
   `{sector_mult: count}` map and `{sector,multiplier,hits}` shape) to the new
   zone-aware shape, in the same change.
5. Committed regression test: extend `backend/test/display.heatmap-hardening.test.js`
   (which already `vm`-extracts `buildChuckinLiveHeatmap()` from the real source) to
   assert an inner-only single leaves the outer region at 0 hits and vice versa, and
   that a zone-unspecified single plots on neither — fails against the pre-fix
   both-regions-lit rendering.

**Verify:** the new test passes (and fails against the pre-fix renderer); a live session
throwing an inner 20 lights only the inner half of the 20 wedge on /display, an outer 20
only the outer half; the lifetime Player Profile heatmap is unchanged; full backend
suite green.

---

### BUG-21 — Re-sharing an already-earned badge from the Badge Case produced a moment card with no explanation at all — no statLine, no achievement description  **(LOW, user-facing / cosmetic; found via a live user bug report)**

**Status: ✅ Fixed (2026-07).** `buildMomentCard()` gained a new `desc` param — a
second, muted, wrapped line drawn beneath `statLine` (the actual **explanation of
the achievement**, e.g. "Throw 500 lifetime darts in Just Chuckin' It.", distinct
from `statLine`'s specific-occurrence recap, e.g. "500 lifetime darts") — chained
off whichever of player/statLine was drawn last so it never overlaps either.
`fireMomentCard(type, opts)`, the one choke point nearly every achievement/moment
card already goes through, now resolves `desc` automatically via the existing
`achDescFor(type)` helper (the same lookup the live achievement overlay and voice
announcements already use) whenever a caller doesn't supply its own — so every
card gets a real explanation without ~50 call sites each needing to pass one.
`ACH_DESC_FALLBACK` gained three new entries (`matchwin`, `dailychallenge`,
`checkout100`) so `achDescFor()` never resolves to an empty string for any moment-
card type in use. The three call sites that build a card directly, bypassing
`fireMomentCard()`, were each updated to pass their own `desc`:
`shareEarnedBadge(badgeId)` (the actual bug — see below) now passes `info.desc`,
already sitting right there on `BADGE_INFO[badgeId]`; the On This Day flashback
(`loadOnThisDay()`) now passes `achDescFor(data.type)`; `sharePersonalBest()`
(Best Leg Average / Fewest Darts to Finish, neither a real badge) now carries its
own short description per kind. `REFERENCE.md` §8 updated to describe the new
`desc` param, `fireMomentCard()`'s auto-resolution, and each direct-call
exception. Committed regression test `backend/test/moment-card-desc.test.js`
vm-extracts the real `BADGE_INFO`/`ACH_TYPE_TO_BADGE_ID`/`ACH_DESC_FALLBACK`/
`achDescFor` from `frontend/index.html` (using `frontend/scoring.js`'s real
`CRICKET_COMEBACK_THRESHOLD`, which one `BADGE_INFO` entry's description
interpolates) and asserts every moment-card type actually used in the app —
including the three new fallback entries — resolves to a non-empty explanation.
Verified end-to-end in a real Chromium browser: driving `shareEarnedBadge()` for
the exact "In the Groove" badge from the bug report now renders both the stat
recap and the explanation sentence on the generated card; a live in-game 180
card (which already had a `statLine`) now also shows its explanation beneath it.
Full backend suite green.

**Original report:** a user attached a shareable moment card — "IN THE GROOVE"
(the 500-lifetime-darts Just Chuckin' It milestone), player "Ben" — showing only
the headline and player name, with nothing else beneath it before the tagline.
The card in the report was generated by tapping the Badge Case's 📤 Share button
on an already-earned badge, not by the achievement firing live in a game.

**Where:** `frontend/index.html` `shareEarnedBadge(badgeId)` (the Badge Case's
re-share path, `onclick="shareEarnedBadge('${id}')"` on every *earned* badge
tile):

```js
async function shareEarnedBadge(badgeId){
  const info = BADGE_INFO[badgeId];
  if(!info) return;
  const canvas = await buildMomentCard({ icon:info.icon, headline:info.label.toUpperCase(), player:currentPlayer });
  // ...
}
```

`info` (i.e. `BADGE_INFO[badgeId]`) already carries a `desc` field — the exact
"how to earn this" sentence `showBadgeInfo()` shows in a tooltip/modal elsewhere
on the very same page, and the exact text the live achievement overlay shows
beneath the headline when the badge is first earned — but `shareEarnedBadge()`
never read it, and passed no `statLine` either. So a card built through THIS
path (as opposed to the live-firing path via `fireMomentCard()`, which always
carries a `statLine`) rendered with nothing at all beneath the player's name: a
genuinely blank card, matching the reported screenshot exactly.

**The asymmetry that proves it's a gap:** every card fired live, in-game, at the
moment an achievement is earned (`fireMomentCard()`, ~50 call sites) already
carried a `statLine`. `shareEarnedBadge()` is the *only* card-building path that
had access to a genuine achievement description (`info.desc`, sitting one
property away) and simply never used it — the three other direct-`buildMomentCard`
call sites (On This Day, Personal Bests, and every `fireMomentCard()` caller) all
supply *some* context text; this one alone supplied none.

**Fix (step by step):**
1. Add a `desc` param to `buildMomentCard()`, drawn as a second, smaller, muted,
   wrapped line beneath `statLine` (or beneath the player name if there's no
   `statLine`) — using a running Y cursor so the pre-existing icon/headline/
   player/statLine pixel positions are completely unchanged for any card that
   doesn't pass `desc`.
2. In `fireMomentCard(type, opts)`, resolve `desc = opts.desc || achDescFor(type)`
   before building the card — the single choke point fix that gives every
   live-firing achievement a real explanation with no per-call-site changes
   needed, since `achDescFor()` already existed and already covers every badge
   id via `BADGE_INFO`/`ACH_TYPE_TO_BADGE_ID`, plus the ladder-populated Chuckin/
   Checkout Trainer/Blitz milestone ids (added to `BADGE_INFO` dynamically at
   load time, so already covered without any per-tier change).
3. Add three missing entries to `ACH_DESC_FALLBACK` (`matchwin`, `dailychallenge`,
   `checkout100`) — the only moment-card types in use that resolved to `''` from
   `achDescFor()` today (harmless before this fix, since both `matchwin` and
   `dailychallenge` always carry a real `statLine`; `checkout100` is the flashback
   card's own label key, not a `badge_id`) — so no card type is left without a
   real explanation once `desc` is wired up everywhere.
4. Fix `shareEarnedBadge()` — the actual reported bug — to pass `desc:info.desc`.
5. Fix the two other direct-`buildMomentCard` callers for full coverage:
   `loadOnThisDay()` (`desc: achDescFor(data.type)`) and `sharePersonalBest()`
   (its own short `desc` per kind, since Personal Bests aren't badges).
6. `REFERENCE.md` §8 updated in the same change.
7. Committed `node:test`: vm-extract the real `BADGE_INFO`/`ACH_TYPE_TO_BADGE_ID`/
   `ACH_DESC_FALLBACK`/`achDescFor` and assert non-empty resolution for a
   representative set of moment-card types across every category (X01, Cricket,
   Baseball, Chuckin ladder ids, Daily Challenge, tournament, guided drills, the
   three new fallback entries, and the flashback-only `checkout100` key) — a
   regression guard against a future achievement/badge type shipping without a
   description, the same gap that let `matchwin`/`dailychallenge` go unnoticed
   (harmlessly) until now.

**Verify:** the new test passes; a live Chromium check confirms
`shareEarnedBadge()` now renders both a stat-free explanation line for a badge
with no natural "statLine" (e.g. a laddered milestone re-shared from the Badge
Case) and doesn't regress any card that already had a `statLine`; full backend
suite green.

---

### BUG-22 — Practice-mode Baseball games never called `DB.completeGame()`, so Games Played / Win Rate / every Personal Best stayed empty no matter how many practice games were played  **(MED, user-facing / data-integrity; found via a live user bug report)**

**Status: ✅ Fixed (2026-07).** Two changes, mirroring BUG-18's exact precedent
for the same class of bug (a `!game.practice` gate wrongly blocking a match
completion the scoring engine had already decided):
1. `startGame()`'s `drillModes`-derived `legsPerSet`/`setsPerGame` computation now
   also forces `1`/`1` when `setup.gameType === 'baseball' && setup.mode !== 'h2h'`
   (`isPracticeBaseball`) — a practice Baseball leg is a complete, standalone
   9-inning game (its outcome is decided unconditionally by
   `evaluateVisitBaseball()`, unlike X01/Cricket's open-ended countdown legs), so
   it's forced to exactly 1 leg/1 set, the same treatment every drill mode
   (Ghost, Chuckin, Doubles Practice, etc.) already gets. H2H Baseball is
   untouched — `setup.mode` stays `'h2h'` either way, so a genuine Bo3/Bo5
   multi-leg H2H match still requires the configured number of legs.
2. `onLegWonBaseball()`'s outer gate changed from `if(!game.practice &&
   w.legsWon >= game.legsPerSet)` to `if(w.legsWon >= game.legsPerSet)` — dropping
   the practice check entirely. This function is Baseball-exclusive, so with (1)
   in place, `legsWon >= legsPerSet` alone already correctly distinguishes "the
   single practice leg just finished" (`legsPerSet=1`, completes immediately)
   from "this leg finished but the H2H match isn't decided yet" (`legsPerSet`
   unchanged for H2H). `finishUnit('game', ...)` already renders correctly for a
   practice win with no changes needed (same "GAME OVER"/"New game" UI BUG-18
   already proved works for a practice-flagged match).

The now-unreachable `pracStatsHtmlBaseball()` dual-column "This Leg/This
Session" panel (`finishUnit()`'s `kind==='leg'` screen — Baseball can no longer
reach `kind==='leg'` in practice mode, since it always completes in exactly one
leg now) was removed in the same change, along with its two call sites;
`isBaseball` under `kind==='leg'` now always uses `h2hStatsHtmlBaseball()`,
matching what H2H already used. `docs/game-modes-roadmap.md` and
`docs/open-roadmap-items.md` updated to drop the stale function reference.

**No committed `node:test`** — this is a DOM/game-state control-flow defect
(the gating logic and its fix live entirely in `frontend/index.html`'s
`startGame()`/`onLegWonBaseball()`), the same class of gap BUG-8/BUG-18 covered
with a live Playwright check instead, not a pure calculation to extract. Verified
end-to-end with a real Chromium browser driving the actual scoring UI (not the
raw API):
- **Solo practice Baseball** (the exact reported scenario): played a full
  9-inning game via real pad-button/Enter-turn clicks. Before the fix,
  `GET /api/players/stat-bubbles?...&gameType=baseball` returned `gamesPlayed:
  0` and `GET /api/players/personal-bests?...` returned all-`null` fields
  despite 27 real darts thrown; after the fix, the same player/session shows
  `gamesPlayed: 1` and every Personal Best field populated
  (`bestLegRuns`/`fewestDartsToWin`/`recentFormRuns`/`lifetimeRuns` all `27`).
- **H2H Bo3 regression check**: a 2-player, `legsPerSet:2` match correctly does
  **not** complete after the first (decisively won) leg — `game.done` stays
  `false`, "Next leg" is offered — and correctly **does** complete after the
  second leg is also won, confirming multi-leg H2H behavior is unchanged.

**Original report:** "The baseball stats on the player pages aren't
populating. I played three games and it's not displaying any results."

**Where:** `frontend/index.html` `onLegWonBaseball(wi)` — copy-pasted its outer
gate wholesale from X01/Cricket's own `onLegWon()`:

```js
if(!game.practice && w.legsWon >= game.legsPerSet){      // set won (H2H only)
  ...
  if(w.setsWon >= game.setsPerGame){   // game (match) won
    ...
    DB.completeGame(w.name);
    ...
```

**The design mismatch that caused it:** for X01/Cricket, `!game.practice` here
is *correct* — practice mode is deliberately an open-ended session ("keep
playing legs until you manually end it"), and every leg-level stat (average,
checkout, etc.) is captured via `turns.leg_won`, entirely independent of
`games.completed_at`. Baseball's `onLegWonBaseball()` inherited the identical
gate from that template, but Baseball has **no equivalent per-turn "this won
the leg" flag** — its own code comment elsewhere explains why: a Baseball leg's
winner isn't self-referential to one visit the way a checkout or closing a
Cricket number is. Every one of Baseball's own stat functions
(`getBaseballWonLegs()`, and `gamesPlayed`/`winPct` in
`getBaseballStatBubbles()`) therefore has no choice but to gate on
`g.completed_at IS NOT NULL` as its only "is this a real, decided result, not
an abandoned mid-leg" signal. With the `!game.practice` gate blocking
`DB.completeGame()` unconditionally, that signal could never fire for a
practice game — so `gamesPlayed` stayed `0` and Personal Bests stayed entirely
empty forever, no matter how many practice games were played through to a real
result.

**Misbehavior (verified):** a player who plays Baseball only in practice mode
(a very natural way to try out a brand-new game type solo, no second player
needed) sees the RPI/Perfect Innings/Darts Thrown/Best Inning stat bubbles at
the top of their Player Profile populate correctly (those read straight from
`turns`, unaffected), but "Games Played" permanently reads `0`, "Win Rate"
permanently reads `—`, and the entire Personal Bests panel (Best Leg Runs,
Fewest Darts to Win, Win Streak, Recent Form, Lifetime Runs) stays empty —
exactly matching "not displaying any results," even after playing several full
games.

**Fix (step by step):**
1. In `startGame()`, add `isPracticeBaseball` (`setup.gameType === 'baseball'
   && setup.mode !== 'h2h'`) to the `legsPerSet`/`setsPerGame` forcing logic
   alongside `drillModes`.
2. In `onLegWonBaseball()`, drop `!game.practice` from the outer gate — safe
   because this function is Baseball-only and (1) already makes
   `legsWon >= legsPerSet` alone correctly distinguish the two cases.
3. Remove `pracStatsHtmlBaseball()` and its two call sites in `finishUnit()`
   (now genuinely unreachable), simplifying the `isBaseball` branch of
   `kind==='leg'` to always use `h2hStatsHtmlBaseball()`.
4. Update `docs/game-modes-roadmap.md`'s and `docs/open-roadmap-items.md`'s
   stale references to the removed function.

**Verify:** the two live-browser checks above (solo practice completes and
populates stats; H2H Bo3 still requires both legs) both pass against the fix
and fail against the pre-fix code (`gamesPlayed`/personal bests stayed empty
for the solo practice case); full backend suite green (unaffected — this is a
frontend-only fix, no backend code touched).

---

### BUG-23 — Cricket's scoring pad had no way to log a real off-target number hit, forcing it to be recorded as a genuine miss and corrupting Dart Analytics  **(LOW, data-integrity / user-facing; found via a live user bug report)**

**Status: ✅ Fixed (2026-07).** `renderPadCricket()` gains a collapsed-by-default
"Hit a different number ▾" picker beneath the existing 7 target buttons + Miss,
listing the 14 numbers (of the full 1-20 + Bull pool, a new `CRICKET_ALL_NUMBERS`
constant in `frontend/scoring.js`) not in play this match — always exactly 14,
whether classic (1-14) or a custom 7-of-21 selection. Tapping one calls the
exact same `throwDart(n)` the 7 real target buttons already use (respecting
the ambient single/double/treble selector, so a treble or double off-target
hit is captured accurately too, not just a bare single), so it needed **zero**
scoring-logic changes: `evaluateVisitCricket()` already no-ops any sector not
in `game.config.numbers` regardless of which specific number it is
(`if(!numbers.includes(d.sector)) return;`) — this is purely an input-
affordance fix, letting a real sector reach the database instead of being
forced through `sector:0`. `cricketOffTargetOpen` (new module-level state,
same pattern as `dartboardMode`) keeps the picker's expanded/collapsed state
stable across re-renders within a session. `REFERENCE.md`'s Cricket section
updated in the same change. Committed regression test in
`backend/test/scoring.test.js` (`CRICKET_ALL_NUMBERS` describe block): exactly
21 numbers with no duplicates; subtracting classic Cricket's 7 targets leaves
precisely `[1..14]`; subtracting an arbitrary valid custom 7-selection always
leaves exactly 14 with no overlap — the pure calculation the picker's number
list is built from. The picker itself (a DOM-rendering feature, same class of
gap as BUG-8/BUG-18/BUG-22) has no `node:test` — verified instead with a real
Chromium browser driving the actual scoring UI: the toggle is present and
collapsed by default; expanding it shows exactly `1-14` for classic Cricket;
tapping treble-7 records `{sector:7, multiplier:3}` (not `sector:0`)
server-side and appears correctly in `GET /api/players/dart-analytics` (a
100% treble rate for sector 7, one real miss still correctly counted as
`sector:0`) instead of being folded into the miss count; and three
off-target darts followed by "Enter turn" leave every mark and the leg's
points total at zero, exactly matching a genuine miss — confirming Cricket
scoring itself is completely unaffected. Full backend suite green.

**Original report:** "Make sure that misses in cricket don't actually count
as a miss in the dart analytics. Since there is no option for 1-14 when
playing a classic cricket game, I have to log all those numbers as misses."

**Where:** `frontend/index.html` `renderPadCricket()` built exactly 8 buttons —
the game's 7 in-play targets plus a single `Miss` (`sector:0`) — with no way
to specify any other number 1-20:

```js
numbers.forEach(n=>{ ... b.onclick = () => throwDart(n); pad.appendChild(b); });
const miss=document.createElement('button');
miss.className='miss'; miss.textContent='Miss'; miss.disabled=full;
miss.onclick=()=>throwDart(0); pad.appendChild(miss);
```

Classic Cricket plays 15/16/17/18/19/20/Bull — 7 of the 21 numbers a dart can
land on (1-20 plus Bull). A dart that genuinely lands on, say, 7 is a real
board hit, worth recording accurately (which sector, which multiplier), but
the pad offered no button for it — only `Miss`, identical to a dart that
missed the dartboard entirely.

**The gap that let it ship:** `getDartAnalytics()`'s "Most Hit Sectors" and
"Treble Rate by Number" queries read `darts.sector`/`darts.multiplier`
directly, with no game-type-specific interpretation — they trust whatever
sector was actually recorded. There was never a bug in the *analytics* query
itself; the data reaching it was already wrong, because Cricket's own input
UI was the only game type that had no way to record 13 of the 20 real
numbers (14 including Bull for a custom config that doesn't select it) at
all — X01, Baseball, and every other Pad-based mode's target set is either
"every number" or forced down to exactly one live target with its own
dedicated screen, so this specific gap only existed for Cricket.

**Misbehavior (verified):** a Cricket player whose darts frequently land
outside the 7 in-play numbers (a very normal occurrence — half the board
isn't live in a Cricket match) had every one of those hits recorded as
`sector:0`, identical to a genuine miss. Their Player Profile's Dart
Analytics "Most Hit Sectors" list showed an inflated, meaningless "Miss"
entry combining real off-board misses with real on-board hits that simply
weren't Cricket targets, while "Treble Rate by Number" silently excluded
every treble thrown at a non-target number (since those darts had no real
sector to group by) — an accuracy gap invisible from the Cricket scoring
screen itself, only surfacing once the player checked their stats.

**Fix (step by step):**
1. Add `CRICKET_ALL_NUMBERS` (`[1..20, 25]`) to `frontend/scoring.js`, exported
   alongside the existing `CRICKET_STANDARD_NUMBERS`.
2. In `renderPadCricket()`, after the existing 7 targets + Miss, add a
   collapsed-by-default toggle revealing a grid of
   `CRICKET_ALL_NUMBERS.filter(n => !numbers.includes(n))` — each button
   calling `throwDart(n)` exactly like a real target button (so multiplier
   selection and every existing dart-shape/undo/live-broadcast code path is
   reused unchanged).
3. No backend or scoring changes needed — `evaluateVisitCricket()` and
   `getDartAnalytics()` both already handle an arbitrary real sector
   correctly; only the *input* was ever missing a way to produce one.
4. `REFERENCE.md`'s Cricket rules section documents the new picker in the
   same change.
5. Committed `node:test` for `CRICKET_ALL_NUMBERS`'s pure pool/subtraction
   math (Status note above); the DOM picker itself verified live instead.

**Verify:** the new test passes; a live Chromium check confirms the picker
renders the correct 14 off-target numbers, records their real sector/
multiplier (visible in Dart Analytics, not folded into "Miss"), and scores
zero marks/points exactly like a genuine miss; a genuine `Miss` tap is
completely unaffected; full backend suite green.

---

### BUG-24 — Cricket's (and Baseball's) lifetime dartboard heatmap silently hid every single hit, including on real target numbers  **(MED, data-integrity / user-facing; found while verifying BUG-23's fix)**

**Status: ✅ Fixed (2026-07).** `buildDartHeatmap()` gains a `noZoneTracking`
option. `loadDartHeatmap()` sets it whenever the active Player Profile tab is
`cricket` or `baseball` — the two game types whose `renderPad*()` never has a
Dartboard-mode alternative, unlike X01/Chuckin/Doubles Practice. When set: the
existing "zone-unspecified single: not plotted at all" exclusion is skipped,
and both the inner and outer single sub-regions read the SAME merged bucket
(every single for that number, regardless of the always-`null` `zone` field)
instead of two separately-keyed, permanently-empty buckets — so the whole
single ring lights up honestly reflecting "this many singles, position
unknown" rather than showing nothing. Tooltips drop the false "(inner)"/
"(outer)" precision claim for these two game types, reading e.g. `"15: 3
hits"` instead of `"15 (inner): 0 hits"` / `"15 (outer): 0 hits"`. Trebles,
doubles, and bull were never affected by the exclusion (`multiplier !== 1`)
and needed no change. `REFERENCE.md`'s Cricket rules and generalized-heatmap
sections updated in the same change. Committed regression test
`backend/test/dart-heatmap.test.js` (vm-extracts the real `buildDartHeatmap()`
+ `DB_SECTORS` from `frontend/index.html`, the same technique
`display.heatmap-hardening.test.js` already established for its sibling
function — `buildDartHeatmap()` is pure string-building, unlike the moment
card's real-Canvas dependency, so unlike BUG-8/18/22/23 this one **is**
fully `node:test`-able): a zone-unspecified single stays excluded without
`noZoneTracking` (X01/Chuckin/Doubles Practice, unchanged); with
`noZoneTracking` the same single now renders on both sub-regions with the
real count and no false inner/outer label; trebles/doubles/bull are
unaffected either way; an unpositioned miss still plots nothing (unrelated to
this fix); ordinary zoned X01 data still renders exactly as before. Verified
the exclusion-still-applies-without-the-flag test fails against the pre-fix
code. Verified end-to-end in a real Chromium browser: a genuine Cricket
target (single-15) that showed **"0 hits" on the heatmap despite being
correctly stored server-side** before the fix now shows "1 hit"; a mixed real
game (singles, an off-target BUG-23 single, a treble, a double) all render
correctly together, confirmed both numerically (SVG tooltips) and visually
(screenshot: solid lit single wedges where the board was previously blank);
Baseball's heatmap confirmed fixed identically. Full backend suite green (663
tests, +6 new).

**How this was found:** while verifying BUG-23's fix (confirming Dart
Analytics correctly reflects a Cricket off-target hit), a broader "does the
heatmap work for Cricket" check was requested. Reproducing a plain, genuine
Cricket **target** hit (a single on one of the 7 in-play numbers — nothing to
do with BUG-23's off-target case) against the fixed BUG-23 code still showed
"0 hits" on the rendered heatmap despite the backend correctly storing it —
revealing this as a distinct, pre-existing defect, not a side effect of the
BUG-23 change.

**Where:** `frontend/index.html` `buildDartHeatmap()`:

```js
if(c.multiplier === 1 && c.sector >= 1 && c.sector <= 20 && !c.zone) return; // zone-unspecified single: not plotted at all
```

Per this function's own long-standing comment (and the commit that introduced
it, "Dartboard heatmap: don't display zone-unknown darts at all"), this
exclusion was a deliberate product decision **for game types where Pad mode
is the player's own choice over an available Dartboard mode** (X01, Chuckin,
Doubles Practice) — a real, meaningful signal is being *withheld*, not lost,
in that case, since the player could switch input modes to get zone
precision if they wanted it. `renderPadCricket()`/`renderPadBaseball()`,
however, are unconditionally used regardless of the `dartboardMode`
preference (`renderPad()`: `if(game.gameType === 'cricket'){
renderPadCricket(full); ... return; }`, no `dartboardMode` check at all) — so
for these two game types, `zone` is not withheld by choice, it is
**structurally impossible to ever capture**. The exact same exclusion rule,
applied to data that can never satisfy its own precondition, silently
discarded every single dart these two game types ever recorded.

**Misbehavior (verified):** a Cricket player's lifetime dartboard heatmap on
their Player Profile showed data for treble/double/bull hits but a
permanently blank, unlit single ring for every number — including the 7 real
in-play targets, the darts a Cricket player throws most often — with no
indication anything was missing (the heatmap simply looked "cold" there,
indistinguishable from a number genuinely never hit). Baseball's own
heatmap, sharing the same input shape and the same generalized
`buildDartHeatmap()`, had the identical defect.

**Fix (step by step):**
1. Add a `noZoneTracking` option to `buildDartHeatmap(cells, opts)`: when
   true, skip the zone-unspecified-single exclusion, and key every single for
   a number into one merged bucket (empty zone key) rather than the real
   `c.zone` value — so both the inner and outer render calls
   (`heat(num,1,singleInnerZone)` / `heat(num,1,singleOuterZone)`, with
   `singleInnerZone`/`singleOuterZone` both resolving to `''` when
   `noZoneTracking`) read the same total automatically, needing no separate
   SVG-building branch.
2. Drop the false "(inner)"/"(outer)" tooltip suffix for `noZoneTracking`
   game types — the position genuinely isn't known, so the label shouldn't
   claim otherwise.
3. `loadDartHeatmap()` passes `noZoneTracking: (gt === 'cricket' || gt ===
   'baseball')` based on the active Player Profile game-type tab.
4. `REFERENCE.md` updated in the same change.
5. Committed `node:test` per the Status note above.

**Verify:** the new tests pass (and the "still excluded without the flag"
case fails against pre-fix code); a live Chromium check confirms a genuine
Cricket single now lights its number's whole single ring instead of showing
0 hits, with trebles/doubles/bull/misses all unaffected; Baseball's heatmap
confirmed fixed the same way; X01/Chuckin/Doubles Practice's existing
zone-aware behavior is completely unchanged; full backend suite green.

---

### BUG-25 — New Game wizard's Step 3 ("More options") forced every mode through it, even modes with nothing to configure there  **(LOW, user-facing / UX; found via a live user bug report)**

**Status: ✅ Fixed (2026-07).** `setupGoToStep3()` — the Step 2 "Continue"
button's only handler — unconditionally called `showSetupStep(3)`. Step 3
only has real content for a subset of modes (Cricket's target picker,
Ghost's leg picker, Doubles Practice's target picker, Checkout Trainer's
sub-mode/difficulty, and H2H's legs/sets format); every other mode (X01
practice, Baseball practice, Chuckin, Around the Clock, Around the World,
Daily Challenge) landed on a page with nothing but the Start button itself —
an unnecessary extra tap the Daily Challenge blurb already anticipated
("Press Continue below to play") but never actually delivered on. Added
`setupStep3HasContent()`, which checks each of Step 3's five conditional
section elements' own DOM `hidden` state (already kept correct by
`setMode()`'s per-mode toggles, so this can never drift out of sync with
what `setMode()` decides to show) rather than re-deriving the mode→section
mapping a second time. `setupGoToStep3()` now calls `startGame()` directly
when none of the five sections are visible, skipping Step 3 entirely;
`startGame()` was already safe to call this way since it validates purely
from `setup.*` state, not from Step-3 DOM state requiring that step to have
rendered. Verified end-to-end in a real Chromium browser across all 13 mode
combinations (X01/Baseball practice, Chuckin, Around the Clock, Around the
World, Daily Challenge, Cricket practice, Ghost, Doubles Practice, Checkout
Trainer, and X01/Baseball/Cricket H2H): every contentless mode now starts
the game the moment Continue is clicked on Step 2, and every mode with real
Step 3 content still lands there uninterrupted. This is pure frontend
control flow (an `onclick` handler's branching, not a calculation), so per
`CLAUDE.md`'s standing rule it's verified with a live Playwright click-driven
test rather than a `node:test` case — the same category as BUG-8/18/22/23.
Full backend suite green (663 tests, unaffected since no backend or scoring
logic changed).

**Where:** `frontend/index.html` `setupGoToStep3()`:

```js
function setupGoToStep3(){ showSetupStep(3); }
```

**Misbehavior (verified):** choosing Chuckin (or X01 practice, Baseball
practice, Around the Clock, Around the World, or Daily Challenge) and
clicking Continue on Step 2 always advanced to Step 3, which for these
modes rendered with every conditional section (`cricket-options-section`,
`ghost-options-section`, `doubles-options-section`,
`checkout-trainer-options-section`, `h2h-options`) hidden — an
effectively-blank page whose only purpose was to require a second click on
its own Start button before the game actually began.

**Fix (step by step):**
1. Add `setupStep3HasContent()`: returns true if any of the five Step-3
   conditional sections is currently un-hidden.
2. Change `setupGoToStep3()` to call `startGame()` directly instead of
   `showSetupStep(3)` when `setupStep3HasContent()` is false.
3. No change needed to `startGame()`, `setMode()`, or any Step-3 section's
   own rendering — they were already correct; only the navigation decision
   was wrong.

**Verify:** live Chromium sweep across all 13 mode/player-count
combinations confirms contentless modes skip straight to a started game and
content-bearing modes still stop on Step 3; full backend suite green (no
regressions, no backend logic touched).

---

### BUG-26 — `display.html`'s ACH_LABELS/ACH_DURATION/ACH_DESC (the live overlay's
own hand-copied badge-text maps) had drifted 9 static entries behind
`index.html`'s, rendering a blank achievement headline on the /display second
screen  **(LOW, cosmetic; found while adding a new badge for docs/archive/cutthroat-cricket-roadmap.md)**

**Status: ✅ Fixed (2026-07).** `frontend/display.html` has no build step and no
shared module with `frontend/index.html` (documented in its own "mirror-copied"
comment above `ACH_DESC`), so every badge added to `index.html`'s
`ACH_LABELS`/`ACH_DURATION`/`BADGE_INFO[...].desc` needs a matching, by-hand
entry added here too. Nine static badges shipped across several earlier
features — `guided_clock`/`guided_world` (guided drills), `triplebull`/
`bullseyefinish` (X01 chain-check badges), `baseballperfectinning`/
`baseballperfectgame`/`baseballwalkoff`/`baseballcycle` (Baseball), and
`doublespracticeringmaster` (Doubles Practice's Ring Master) — never got that
second entry. `achText.textContent = ACH_LABELS[type] || ''` silently falls
back to an empty string, so the live overlay's full-screen headline rendered
**blank** on the /display screen for all nine, even though every one of them
awarded and persisted correctly server-side (Badge Case, stats, and the
moment card all read from a different, unaffected source) — exactly the same
gap class as Ring Master's own missing `index.html` `ACH_LABELS` entry
(`docs/archive/culture-badges-roadmap.md` Part B), just the mirror-file
version of it. Added all nine entries to `display.html`'s three maps, plus
its own `mega`-duration flag for the ones that belong in that list to match
`index.html`. Committed regression test `backend/test/display.ach-labels-parity.test.js`:
extracts both files' static `ACH_LABELS`/`ACH_DURATION`/`ACH_DESC` object-literal
key sets directly from source (no shared module to `require()`, so a
line-anchored regex reads the real current source rather than a hand-copied
duplicate that can drift again unnoticed) and asserts `index.html`'s key set
is a subset of `display.html`'s for each map — fails loudly the moment a
future badge is added to one file and not the other, instead of shipping a
silent blank headline. Ladder-generated ids (`CHUCKIN_MILESTONE_LADDERS` and
its siblings) are deliberately out of scope for this test: those are
populated via an already-mirrored `forEach` loop in both files, a different,
already-correct mechanism from the one that actually drifted here.

**How this was found:** while adding `cricketstonecold`
(`docs/archive/cutthroat-cricket-roadmap.md`'s 🔪 Stone Cold badge) and checking
`display.html` stayed in sync per the Ring Master precedent, a full key-set
diff between the two files' `ACH_LABELS` turned up eight *other*, pre-existing
gaps unrelated to the new badge.

**Where:** `frontend/display.html`'s `ACH_LABELS`/`ACH_DURATION`/`ACH_DESC`
declarations (missing entries; `frontend/index.html`'s own copies were
already correct and are the source of truth).

**Fix (step by step):**
1. Diff `index.html`'s `ACH_LABELS` key set against `display.html`'s to find
   every static badge id present in one but not the other.
2. Copy each missing id's label/duration/description text verbatim from
   `index.html`'s `ACH_LABELS`/`ACH_DURATION`/`BADGE_INFO[...].desc` into
   `display.html`'s three maps.
3. Add a committed parity test comparing the two files' key sets directly, so
   a future one-off addition to only one file fails CI instead of shipping
   silently.

**Verify:** `backend/test/display.ach-labels-parity.test.js` passes (and
would have failed against the pre-fix `display.html`, confirmed by re-running
it before the nine entries were added); full backend suite green.

---

## Eighth-pass audit (2026-07, weighted to the six game modes merged since the seventh pass)

The functional-defect counterparts to `security-audit-roadmap.md` Part 10, from an
adversarial re-read weighted toward the six game modes merged since the seventh pass:
End-of-Night Session Recap, Marathon Mode, Shanghai, Halve-It, The Pressure Chamber,
and Dead Man Walking. The write-time consistency guards for all six new/expanded types
(`addTurn()`'s per-game-type branches) were cross-checked against `REFERENCE.md` and
found sound, as were the CP/points/fatigue formulas (all have committed `node:test`
coverage). Three data-integrity bugs found — **BUG-27** (checkout-based stats leak
Checkout Ladder / Dead Man Walking checkouts), **BUG-28** (the live-state allowlist
strips the three newest game types' `/display` fields), and **BUG-29** (the won-leg
heuristic miscounts Pressure Chamber H2H and Shanghai/Halve-It). One coupled security
finding (`security-audit-roadmap.md` **SEC-26**) rides on BUG-28's fix — see the note in
BUG-28's own entry.

### BUG-27 — Checkout-based X01 stats (Ton+, Big Fish, Highest Checkout, Top Finishes, On This Day, Session Recap) silently count Checkout Ladder and Dead Man Walking checkouts, which are real `checkout=1` rows but not X01 legs  **(MED, silent data-integrity drift)**

**Status: Open.**

**What actually goes wrong (plain language):** `REFERENCE.md`'s Cricket-interaction
table (§3, the "Category → Cricket games…" grid) states that the checkout-based stats —
Big Fish, ton+ finishes, highest checkout, checkout routes/Top Finishes — are
"*Naturally excluded*" from non-X01 games because "*cricket never writes `checkout=1`,
and these are all scoped to won legs / checkout rows.*" That was true when only X01 and
Cricket existed. It is **no longer true**: the 121 Checkout Ladder and Dead Man Walking
both now write a genuine `checkout=1` **with a real `checkout_points`** on a won round
(`frontend/index.html`'s `recordTurn` for both — `checkoutPoints: ev.win ?
ev.pointsThisVisit : null`, where `pointsThisVisit` is the finishing visit's score, 61-170
for the Ladder and the personalized deficit for Dead Man Walking). Every checkout-based
aggregate that was written assuming "`checkout=1` ⟹ X01" now silently folds those drill
checkouts in. So a player who checks out 121 in a Checkout Ladder attempt, or clears a
personalized 140 in Dead Man Walking, has that finish counted as a household Ton+
checkout, a Top Finishes row, an "On This Day" flashback, and — if it's 170 — a **Big
Fish** (which is supposed to mean a 170 checkout in an X01 game). The same drill checkout
can top the "Highest Checkout" household record and inflate the Ton+ Finish Rate
leaderboard.

This is the *exact* leak that `getPersonalBests()` was already fixed for — it carries an
explicit `X01_ONLY` guard now, with a long comment ("*a Checkout Ladder/Dead Man Walking
checkout is real, but not an X01 leg*") and a committed isolation-regression test.
`getPlayerStatBubbles()` was fixed **only partially** in that same pass (its `avg`/`180s`/
`totalPts` got `X01_ONLY`, but its **Big Fish bubble** — `t.checkout=1 AND
t.checkout_points=170` — was missed and still leaks). Every other checkout-based read site
below was never brought along at all, so the leak persists across the Home page,
leaderboards, profile, recap, and On This Day.

**Where (all `backend/db.js`):**
- `getSummary()` — the global `tonPlus` (`WHERE checkout=1 AND checkout_points>=100`)
  and `bigFish` (`WHERE checkout=1 AND checkout_points=170`) counts shown on the Home
  page. Neither joins `games` or filters game type. (Note: `computeStats()`'s own
  `co100`/`bigFish` in its `_agg` *are* correctly `X01_ONLY` — the gap is `getSummary()`,
  not `computeStats()`.)
- `getPlayerStatBubbles()` — the per-player **Big Fish** stat bubble
  (`${J} ${mf} AND t.checkout=1 AND t.checkout_points=170`, no `X01_ONLY`), the one field
  the otherwise-applied `X01_ONLY` fix skipped in this function.
- `getHomeExtra()` — `_tonPlus` (the "Ton+ Finish Rate" leaderboard; has
  `NOT_CHECKOUT_TRAINER` but no `X01_ONLY`) and both `_highestCheckout(modeWhere)` and
  the `overall` highest-checkout (`WHERE t.checkout=1 AND t.checkout_points IS NOT NULL`,
  no game-type filter).
- `getBigFishStats(mode)` — the `/api/stats/big-fish` leaderboard + recent list
  (`WHERE t.checkout=1 AND t.checkout_points=170 ${mf}`, no `X01_ONLY`).
- `getTopFinishesAll(limit, mode)` — the `/api/top-finishes` Home + profile list
  (`WHERE t.checkout=1 AND t.checkout_points>0 ${mf}`, no `X01_ONLY`).
- `getTopFinishes(playerName, mode)` — the per-player Top Finishes list on the profile
  (`WHERE t.player_id=? AND t.checkout=1 AND t.checkout_points>0 ${mf}`, no `X01_ONLY`).
- `getCheckoutRoutes(playerName, score, mode)` — the checkout-route breakdown for a given
  score (`WHERE t.player_id=? AND t.checkout=1 AND t.checkout_points=? ${mf}`, no
  `X01_ONLY`), so a drill checkout of that value contributes phantom "routes" to an
  X01 analysis. (Contrast `getCoachingInsights()`'s own route insight, which *is*
  `X01_ONLY` — the correct precedent to copy.)
- `getOnThisDay(name, tz)` — the `checkout_points=170` (bigfish) and `>=100`
  (checkout100) ordering/return branches are unscoped (only the `scored=180` branch
  checks `game_type='x01'`).
- `getSessionRecap(date)` — `tonPlusStmt` (`checkout=1 AND checkout_points>=100`), the
  pre/tonight highest-checkout statements, and the `moments` timeline's tonplus/bigfish
  query are all unscoped, so a drill checkout appears in the nightly recap's Ton+ count,
  Personal-Bests-set-tonight highest-checkout, and moment cards.
- `getMetricHistory()` — the `'bigfish'` metric case (`AND t.checkout=1 AND
  t.checkout_points=170`) is unscoped, unlike the `'180s'` case immediately above it
  which correctly carries `${X01_ONLY}` — so a profile's Big-Fish-over-time chart plots
  drill 170s too.

(Confirmed **not** leaking, so leave them alone: `computeStats()`'s `_agg` co100/bigFish,
`getCoachingInsights()`'s route insight, and the Dead Man Walking target-builders
`getWeakestCheckouts()` / `_dmwHistoricalAverageDarts()` are all already `X01_ONLY` or
`game_type='x01'`-scoped.)

**Repro:** play one Dead Man Walking (or 121 Checkout Ladder) run and clear a round whose
target is ≥ 100 (a 170 target makes it a "Big Fish"). Then load the Home page and the
player's profile: the household Ton+/Big Fish counts, the Big Fish leaderboard, Top
Finishes, and Highest Checkout all now include that drill checkout, and the same evening's
Session Recap counts it as a ton+ checkout / moment — even though the player's own X01
Personal Bests (correctly `X01_ONLY`) do not.

**Fix (step by step):**
1. Add the `${X01_ONLY}` scope (joining `games g ON g.id=t.game_id` where a query doesn't
   already) to each of the read sites listed above, matching the guard already applied in
   `getPersonalBests()`/`getPlayerStatBubbles()`. Decide deliberately whether "highest
   checkout" and "Top Finishes" should be strictly X01 (the documented intent) or a new
   explicitly-labelled all-modes variant — the spec (§3 grid + `REFERENCE.md` §3 "Top
   Finishes / Checkout Routes") says X01, so default to `X01_ONLY` and update the spec
   only if the behavior is deliberately changed.
2. Add a committed regression test (extend `backend/test/db.dead-man-walking-stats.test.js`
   or a new `db.checkout-stat-isolation.test.js`) that plays a Dead Man Walking / Checkout
   Ladder ≥100 (and a 170) checkout and asserts `getSummary().tonPlus`/`bigFish`,
   `getPlayerStatBubbles()`'s Big Fish bubble, `getBigFishStats()`, `getTopFinishesAll()`,
   `getTopFinishes()`, `getCheckoutRoutes()`, `getHomeExtra()` highest-checkout/ton+,
   `getOnThisDay()`, `getSessionRecap()`, and `getMetricHistory('bigfish')` all stay
   unchanged from their X01-only baseline — the same isolation shape the existing Dead Man
   Walking test uses for Personal Bests.

**Verify:** the new test passes and fails against the pre-fix source; a real X01 170
checkout still counts everywhere; `REFERENCE.md` §3's "naturally excluded" wording is
corrected (the exclusion is now enforced by `X01_ONLY`, not by "cricket never writes
`checkout=1`") in the same change.

### BUG-28 — The live-scoreboard allowlist (`ALLOWED_LIVE_KEYS`) was never extended for Shanghai, Halve-It, or The Pressure Chamber, so the server strips their `/display` fields and the second-screen scoreboard renders broken for all three  **(MED, user-facing / feature-degraded)**

**Status: Open.**

**What actually goes wrong (plain language):** the `/display` second screen is driven by
the live-state payload the playing device POSTs to `/api/live`. For safety, the server's
`sanitizeLiveState()` (`backend/server.js`) keeps only the top-level keys named in the
`ALLOWED_LIVE_KEYS` allowlist and drops everything else. When Baseball and Bob's 27
shipped, their per-game-type fields (`baseballInning`, `bobs27Round`) were added to that
allowlist. The six modes merged in this batch were not: `frontend/index.html`'s
`buildLiveState()` sends `shanghaiRound`, `shanghaiMaxRounds`, `halveItRound`,
`halveItTargets`, `pressureChamberRound`, `pressureChamberDeadline`, and
`pressureChamberCards`, but **none of the seven is in `ALLOWED_LIVE_KEYS`**, so the server
strips all of them before broadcasting. The `/display` renderers then fall back to
defaults and render wrong:
- **Shanghai** (`renderers.shanghai`): `s.shanghaiRound`/`s.shanghaiMaxRounds` gone → the
  live-round highlight is stuck on round 1, and a non-default round count (e.g. a 5- or
  20-round Shanghai) renders the wrong number of grid rows (falls back to 7).
- **Halve-It** (`renderers.halve_it`): `s.halveItTargets` gone → falls back to
  `[{sector:20}]`, so `maxRounds` collapses to **1**; the scorecard shows a single row
  labelled "20" instead of the whole 7-round target ladder, and the round labels/highlight
  are wrong.
- **The Pressure Chamber** (`renderers.pressure_chamber`): `s.pressureChamberCards` gone →
  `cards=[]`, so the large **target/modifier banner never renders at all** and the **No
  Warmup countdown never appears**; the live-round highlight is stuck on round 1. (The
  per-round ✅/➗/❌ outcome icons still show — those ride inside the allowlisted `players[]`
  array — so the breakage is "the card/banner/countdown are simply missing," which is easy
  to miss in a quick glance but removes the whole point of the second-screen view for this
  mode.)

The primary playing device is unaffected (it renders from its own in-memory `game`
object, not the round-tripped payload), which is why this can slip through a single-device
test.

**Security note (coupling to `security-audit-roadmap.md` SEC-26):** the naïve fix — just
add the seven keys to `ALLOWED_LIVE_KEYS` — is correct for six of them, but `pressureChamberCards`
carries a nested `modifier.icon` that `renderers.pressure_chamber` inserts into `innerHTML`
**without** `escapeHtml` (`display.html`, the card banner: `${liveCard.modifier.icon}`).
`sanitizeLiveState()` does not recursively escape nested values, so allowlisting
`pressureChamberCards` without first escaping that sink turns a stripped-and-harmless
field into a **stored-XSS vector** on `/display` (a hostile `POST /api/live` under the
documented `OCHE_REQUIRE_AUTH=false` LAN default). Fix SEC-26 **in the same change** as
this bug — see its entry.

**Where:** `backend/server.js` `ALLOWED_LIVE_KEYS` (missing the seven keys);
`frontend/index.html` `buildLiveState()` (already sends them, source of truth);
`frontend/display.html` `renderers.shanghai` / `renderers.halve_it` /
`renderers.pressure_chamber` (the consumers that fall back to defaults).

**Repro:** start a Halve-It (or Shanghai, or Pressure Chamber) game on one device, open
`/display` on a second, and compare. Halve-It shows one "20" row instead of seven target
rows; Pressure Chamber shows no target/modifier banner and no countdown; Shanghai's active
round never advances past 1 on the second screen.

**Fix (step by step):**
1. Add `shanghaiRound`, `shanghaiMaxRounds`, `halveItRound`, `halveItTargets`,
   `pressureChamberRound`, `pressureChamberDeadline`, and `pressureChamberCards` to
   `ALLOWED_LIVE_KEYS` (with the same per-key "only read by renderers.X" comments the
   existing Baseball/Bob's 27 entries carry).
2. Apply SEC-26's fix (escape `modifier.icon` at the `display.html` sink, and/or validate
   the card shape server-side) in the same change, so allowlisting `pressureChamberCards`
   doesn't open the XSS.
3. Add a committed test asserting `sanitizeLiveState()` preserves each of the seven keys
   for a representative payload (mirrors the existing live-state key coverage), so a future
   game type that forgets to allowlist its fields fails loudly instead of shipping a silent
   `/display` regression.

**Verify:** with two browsers, all three modes' `/display` scorecards render correctly
(Halve-It shows the full target ladder, Pressure Chamber shows the banner + countdown,
Shanghai advances the active-round highlight); the SEC-26 escape is in place; full backend
suite green.

### BUG-29 — The `(checkout=1 OR leg_won=1)` won-leg heuristic in `computeStats()` assumes exactly one such signal per won leg, but Pressure Chamber writes it on every hit round — inflating its H2H per-category legs/sets — while Halve-It and Shanghai under-count  **(MED, silent data-integrity drift)**

**Status: Open.**

**What actually goes wrong (plain language):** `computeStats()` derives each player's
per-category H2H record (`h2hLegsWonByCat` / `h2hSetsWonByCat`, shown on the Player
Profile as "N games · M sets · K legs") by counting turns where `(t.checkout = 1 OR
t.leg_won = 1)`, grouped by category. `REFERENCE.md` §3 documents the intent: "*X01
signals a won leg with `checkout`, Cricket with `leg_won`*" — i.e. the heuristic assumes
**exactly one** such signal per won leg. That holds for X01 (one `checkout=1` on the
finishing visit), Cricket and Baseball (one `leg_won=1` on the leg win). It breaks for the
Pressure Chamber, which is **H2H-capable** (`contexts: ['practice','h2h']`) and writes
`checkout=1` on *every partial or full-hit round* and `leg_won=1` on *every full-hit
round* (reusing Checkout Trainer's per-round 3-way outcome — `frontend/index.html`'s
pressure-chamber `recordTurn`). A single 15-round Pressure Chamber run therefore emits up
to 15 `checkout=1` rows for one player in one leg, and `h2hLegs`/`h2hSets` count each as a
separate won leg. Checkout Trainer has the same per-round semantics but is solo-only, so
it's excluded by the `practice=0 AND player_count>1` filter; Pressure Chamber is the first
H2H-capable type to break the invariant.

The blast radius is bounded because Pressure Chamber games carry their own
`category='The Pressure Chamber'`, so the inflated counts land in that category's row of
the H2H record, not in X01's `501` row. But that row is simply wrong — a player who hit 12
of 15 rounds shows "12 legs" for a single run. `h2hSets` (`HAVING COUNT(*) >=
g.legs_per_set`) is inflated the same way, and `h2hAvgDarts` (`HAVING SUM(t.checkout)>0`,
no game-type scope) folds Pressure Chamber's ~45-dart runs into the H2H "average darts per
leg" figure.

The mirror-image defect: **Halve-It** never writes `checkout=1` **or** `leg_won=1` (its
`recordTurn` sends both false — the win is derived from final totals), so a Halve-It H2H
leg win contributes **0** to `h2hLegsWonByCat`; **Shanghai** sets `leg_won=1` only on an
instant Shanghai, not on a normal final-round points win, so points-decided Shanghai legs
are under-counted too. So the per-category H2H "legs won" is unreliable for all three
newest H2H-capable non-X01/Cricket/Baseball modes — over-counted for Pressure Chamber,
under-counted for Halve-It and Shanghai.

**Where:** `backend/db.js` `computeStats()` — `h2hLegs`, `h2hSets`, and (for the darts
skew) `h2hAvgDarts`. Root cause is the shape mismatch between the `(checkout=1 OR
leg_won=1)` heuristic and the per-round `checkout`/`leg_won` semantics of Pressure Chamber
(and the no-signal / instant-only semantics of Halve-It / Shanghai) — `frontend/index.html`'s
`recordTurn` for those three types.

**Repro:** play a Pressure Chamber **H2H** match (2 players) and finish a run hitting
several rounds; open either player's profile and read the "The Pressure Chamber" row of
their H2H record — legs (and, depending on `legs_per_set`, sets) are far higher than the
number of legs actually played. Separately, play a Halve-It H2H match and note its category
row shows 0 legs won for the winner.

**Fix (step by step):**
1. Make the won-leg count game-type-aware rather than relying on the raw `(checkout=1 OR
   leg_won=1)` signal for every type. The most robust approach is to count a won *leg* as
   one distinct `(game_id,set_no,leg_no)` whose winner is this player, deriving the winner
   the same way each game type already does elsewhere (X01/Ladder: the `checkout=1` turn;
   Cricket/Baseball: the `leg_won=1` turn; Shanghai: `getShanghaiWonLegs()`'s hybrid;
   Halve-It: `getHalveItWonLegs()`'s total comparison; Pressure Chamber: the per-leg CP
   winner via `pressureChamberDecideWinnerIndex()`), instead of counting raw signal rows.
   At minimum, scope `h2hLegs`/`h2hSets`/`h2hAvgDarts` so per-round-signal types
   (Pressure Chamber, and Checkout Trainer defensively) can't contribute more than one
   won-leg row per `(game,set,leg,player)`.
2. Add a committed regression test that plays a Pressure Chamber H2H run and asserts the
   winner's `h2hLegsWonByCat['The Pressure Chamber']` equals the real legs won (not the
   hit-round count), plus a Halve-It/Shanghai H2H case asserting their category rows
   reflect real leg wins.

**Verify:** the new test passes and fails against the pre-fix source; X01/Cricket/Baseball
per-category records are unchanged; full backend suite green.

---

## Standing practice

When a functional bug is found: add it here with a repro and a fix outline before fixing,
the same discipline the security doc uses. When it's fixed, flip its Status line to ✅ with
a note on what shipped (and add a `node:test` that would have caught it, per the CLAUDE.md
"every new calculation gets a committed test" convention — a regression guard is what keeps
a fixed bug fixed). A bug whose root cause is shared with a security finding is fixed once,
in whichever doc's step list is more specific, with the other cross-referencing it.
