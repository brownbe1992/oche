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
> `security-audit-roadmap.md` Part 5 / SEC-15), which added **BUG-4** and **BUG-5**
> below. The stat/achievement *formulas* are not re-derived here — they're covered by
> the `node:test` suite under `backend/test/` (all green as of this writing). This doc
> tracks the correctness gaps that suite doesn't yet assert.
>
> **Open:** BUG-4 (MED), BUG-5 (LOW). Fixed: BUG-1, BUG-2, BUG-3.

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

**Status: ⛔ OPEN.** (Found in the 2026-07 third-pass audit; cross-ref
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

**Status: ⛔ OPEN.** (Found in the 2026-07 third-pass audit.)

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

## Standing practice

When a functional bug is found: add it here with a repro and a fix outline before fixing,
the same discipline the security doc uses. When it's fixed, flip its Status line to ✅ with
a note on what shipped (and add a `node:test` that would have caught it, per the CLAUDE.md
"every new calculation gets a committed test" convention — a regression guard is what keeps
a fixed bug fixed). A bug whose root cause is shared with a security finding is fixed once,
in whichever doc's step list is more specific, with the other cross-referencing it.
