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
> **All fixed.** BUG-1/BUG-2/BUG-3 (second pass); BUG-4/BUG-5/BUG-6/BUG-7 (fixed
> 2026-07 alongside `security-audit-roadmap.md` SEC-15/SEC-16), each with a committed
> regression test and the full backend suite green. BUG-8 (fixed 2026-07, from a live
> user bug report rather than an audit pass) is a UI/error-handling defect rather than
> a stats/data-integrity one, so its verification is a live Playwright check instead of
> a `node:test` case.

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

## Standing practice

When a functional bug is found: add it here with a repro and a fix outline before fixing,
the same discipline the security doc uses. When it's fixed, flip its Status line to ✅ with
a note on what shipped (and add a `node:test` that would have caught it, per the CLAUDE.md
"every new calculation gets a committed test" convention — a regression guard is what keeps
a fixed bug fixed). A bug whose root cause is shared with a security finding is fixed once,
in whichever doc's step list is more specific, with the other cross-referencing it.
