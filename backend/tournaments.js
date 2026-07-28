// @ts-check
'use strict';
/* Tournament mode (docs/archive/tournament-mode-roadmap.md) — single- and double-
 * elimination brackets.
 *
 * The first section lifted out of backend/db.js, which was 10,100 lines. Chosen to go
 * first because it is a true leaf: nothing in db.js calls into it (the only mentions
 * are in comments), so cutting it moves code without moving behaviour.
 *
 * HOW A LEAF MODULE GETS ITS DEPENDENCIES. It is a factory, not a module with
 * top-level state: db.js calls it once, at the bottom of that file, passing exactly
 * what this section needs. That shape was chosen over the two obvious alternatives
 * for concrete reasons:
 *
 *   - `require('./db.js')` from here would be a CIRCULAR require. Node tolerates it
 *     as long as nothing is read at load time, which makes it work by accident and
 *     break the day someone adds a top-level read. Not a foundation to build ten
 *     more modules on.
 *   - Re-deriving the handle here (a second `new DatabaseSync(...)`) would open a
 *     second connection to a WAL database. Two writers, one of them invisible.
 *
 * The injected list below is also the honest documentation of this section's coupling
 * — ten names, all of them core. Anything a future tournament feature needs must be
 * added there deliberately, which is the point: a global scope lets coupling grow
 * silently, an argument list does not.
 *
 * @param {{
 *   db: any, httpError: (status: number, message: string) => Error,
 *   getPlayer: (name: string) => any, ensurePlayer: (name: string) => any,
 *   createGame: (opts: any) => any, completeGame: (...args: any[]) => any,
 *   awardBadge: (...args: any[]) => any, onGameCompleted: (fn: Function) => void,
 *   registerDeletePlayerGuard: (fn: Function) => void, MAX_LEGS_OR_SETS: number,
 * }} deps
 */
module.exports = function initTournaments(deps) {
  const { db, httpError, getPlayer, ensurePlayer, createGame, completeGame,
          awardBadge, onGameCompleted, registerDeletePlayerGuard, MAX_LEGS_OR_SETS } = deps;
  const { doubleElimStructure } = require('../frontend/scoring.js');

  /* ---------- tournament mode (docs/archive/tournament-mode-roadmap.md, single-elim only) ----------
     Seeding (random shuffle / manual reorder / by lifetime 3-dart average) all happens
     client-side — `players` here is already the final seed order (index 0 = seed 1),
     the same way createGame()'s `players` array order already determines throw order
     with no server-side reordering. */
  const TOURNAMENT_X01_CATEGORIES = ['501', '301', '170', '101'];
  const TOURNAMENT_MAX_PLAYERS = 128;
  // docs/archive/tournament-mode-roadmap.md §2: double-elimination is restricted to exact
  // powers of two for v1 (no cascading byes in the losers bracket).
  const TOURNAMENT_DOUBLE_ELIM_COUNTS = [4, 8, 16, 32, 64, 128];
  // docs/archive/tournament-mode-roadmap.md §7: how many seed slots worse the winner must be
  // than the opponent they beat to count as an upset — mirrors the spirit of the H2H
  // Giant Slayer's 15-average gap without reusing its exact (average-based) threshold,
  // which doesn't apply to a seed number.
  const TOURNAMENT_GIANT_SLAYER_SEED_THRESHOLD = 3;

  function _nextPowerOfTwo(n) { let p = 1; while (p < n) p *= 2; return p; }

  // Standard single-elimination bracket seeding order — recursively expands
  // [1,2] -> [1,4,2,3] -> [1,8,4,5,2,7,3,6] -> ..., pairing each existing seed s
  // against (size+1-s) at the next size up. Guarantees seed 1 and seed 2 can't meet
  // before the final, and (proven by induction on this construction) that byes —
  // which only ever occupy seed numbers > player count — never double up in a
  // single round-1 match as long as byes < bracketSize/2, which is always true
  // since bracketSize is the SMALLEST power of two >= player count.
  function _bracketSeedOrder(size) {
    let order = [1, 2];
    while (order.length < size) {
      const s = order.length * 2;
      const next = [];
      for (const seed of order) { next.push(seed); next.push(s + 1 - seed); }
      order = next;
    }
    return order;
  }

  function _roundLabel(roundsFromFinal, roundNo) {
    if (roundsFromFinal === 0) return 'Final';
    if (roundsFromFinal === 1) return 'Semifinal';
    if (roundsFromFinal === 2) return 'Quarterfinal';
    return `Round ${roundNo}`;
  }

  // Propagates a match's result: records the winner, marks the loser eliminated,
  // fills the winner into the next round's match/slot (or, if there is no next
  // match, completes the whole tournament). Called identically whether the result
  // came from a played game, an admin-recorded walkover, or a round-1 bye cascading
  // forward at generation time — advancement logic doesn't need to know which.
  // docs/archive/tournament-mode-roadmap.md §7: Giant Slayer (Tournament) — awarded per
  // match whenever the winner was seeded at least TOURNAMENT_GIANT_SLAYER_SEED_THRESHOLD
  // slots WORSE than the opponent they just beat. Called from every real (non-bye)
  // match result, single- or double-elimination alike, so a winners-bracket upset
  // still counts even though that loser only drops to the losers bracket rather than
  // being eliminated outright.
  function _maybeAwardTournamentGiantSlayer(tournamentId, winnerId, loserId) {
    if (loserId == null) return;
    const seedRows = db.prepare(
      `SELECT player_id, seed FROM tournament_players WHERE tournament_id = ? AND player_id IN (?, ?)`
    ).all(tournamentId, winnerId, loserId);
    const winnerSeed = seedRows.find(r => r.player_id === winnerId)?.seed;
    const loserSeed = seedRows.find(r => r.player_id === loserId)?.seed;
    if (winnerSeed != null && loserSeed != null && winnerSeed - loserSeed >= TOURNAMENT_GIANT_SLAYER_SEED_THRESHOLD) {
      const winnerName = db.prepare('SELECT name FROM players WHERE id = ?').get(winnerId)?.name;
      if (winnerName) awardBadge(winnerName, 'tournament_giant_slayer', true);
    }
  }

  // Settles the whole tournament on its deciding match: champion, runner-up, status,
  // and the Champion badge (docs/archive/tournament-mode-roadmap.md §7), all in one place.
  function _completeTournament(tournamentId, championId, runnerUpId) {
    db.prepare(`UPDATE tournaments SET status = 'completed', champion_id = ?, runner_up_id = ?, completed_at = datetime('now') WHERE id = ?`)
      .run(championId, runnerUpId, tournamentId);
    db.prepare(`UPDATE tournament_players SET status = 'champion' WHERE tournament_id = ? AND player_id = ?`)
      .run(tournamentId, championId);
    const championName = db.prepare('SELECT name FROM players WHERE id = ?').get(championId)?.name;
    if (championName) awardBadge(championName, 'tournament_champion', true);
  }

  // The grand final's conditional "bracket reset" (docs/archive/tournament-mode-roadmap.md §2).
  // By construction GF game 1's slot 1 is the winners-bracket champion and slot 2 is
  // the losers-bracket champion (they arrive from the WB/LB finals' winner_next
  // pointers). If the WB champion wins game 1, they have zero losses and the tournament
  // ends. If the LB champion (slot 2) wins game 1, BOTH players now hold exactly one
  // loss, so a single decider game (the pre-created reset match) is played — this just
  // populates that reset match's two slots and stops, without eliminating anyone or
  // completing the tournament. The reset match itself, once decided, always ends the
  // tournament.
  function _resolveGrandFinal(match, winnerId, loserId, tournamentId) {
    const gfRounds = db.prepare(
      `SELECT id, round_no FROM tournament_rounds WHERE tournament_id = ? AND bracket = 'grand_final' ORDER BY round_no`
    ).all(tournamentId);
    const resetRoundId = gfRounds.length > 1 ? gfRounds[gfRounds.length - 1].id : null;
    const isResetMatch = resetRoundId != null && match.round_id === resetRoundId;

    if (!isResetMatch && resetRoundId != null && winnerId === match.player2_id) {
      // LB champion took game 1 — force the decider. Seed the reset match with the same
      // two finalists (WB champ still in slot 1, LB champ in slot 2) and stop here.
      const resetMatch = db.prepare('SELECT id FROM tournament_matches WHERE round_id = ? ORDER BY slot LIMIT 1').get(resetRoundId);
      if (resetMatch) {
        db.prepare('UPDATE tournament_matches SET player1_id = ?, player2_id = ? WHERE id = ?')
          .run(match.player1_id, match.player2_id, resetMatch.id);
      }
      return;
    }
    // Decisive: WB champ won game 1, or the reset game just finished. Whoever won is champion.
    db.prepare(`UPDATE tournament_players SET status = 'eliminated' WHERE tournament_id = ? AND player_id = ?`)
      .run(tournamentId, loserId);
    _maybeAwardTournamentGiantSlayer(tournamentId, winnerId, loserId);
    _completeTournament(tournamentId, winnerId, loserId);
  }

  function _advanceTournamentMatch(matchId, winnerId) {
    const match = db.prepare('SELECT * FROM tournament_matches WHERE id = ?').get(matchId);
    if (!match) return;
    // docs/bug-roadmap.md BUG-4: two guards the walkover path already enforces but the
    // game-completion hook path was missing. (a) Never re-advance a match that's already
    // decided — a replayed/forged POST /api/games/:id/complete would otherwise overwrite
    // a settled bracket (even a finished tournament's champion). (b) Never advance a
    // winner who isn't one of this match's two players — a completion naming a
    // non-participant would inject an outsider into the next round or as champion. Skip
    // silently rather than throw: the game itself still completed and recorded stats
    // normally; this completion just doesn't correspond to a valid bracket result.
    // (Generation-time bye advances pass both guards: the bye match has winner_id null,
    // and its winnerId is its one real player.)
    if (match.winner_id != null) return;
    if (winnerId !== match.player1_id && winnerId !== match.player2_id) return;
    const loserId = winnerId === match.player1_id ? match.player2_id : match.player1_id;
    db.prepare('UPDATE tournament_matches SET winner_id = ? WHERE id = ?').run(winnerId, matchId);
    const round = db.prepare('SELECT tournament_id, bracket FROM tournament_rounds WHERE id = ?').get(match.round_id);
    const tournamentId = round.tournament_id;

    // The grand final (and its optional reset) has its own settle logic — a plain
    // "no winner_next => complete" rule can't express the conditional decider.
    if (round.bracket === 'grand_final') {
      return _resolveGrandFinal(match, winnerId, loserId, tournamentId);
    }

    if (loserId != null) {
      if (match.loser_next_match_id) {
        // Double-elimination: a winners-bracket loss drops the loser into the losers
        // bracket rather than eliminating them. (Losers-bracket matches leave
        // loser_next_match_id NULL, so a second loss there falls through to elimination.)
        const col = match.loser_next_slot === 1 ? 'player1_id' : 'player2_id';
        db.prepare(`UPDATE tournament_matches SET ${col} = ? WHERE id = ?`).run(loserId, match.loser_next_match_id);
      } else {
        db.prepare(`UPDATE tournament_players SET status = 'eliminated' WHERE tournament_id = ? AND player_id = ?`)
          .run(tournamentId, loserId);
      }
      // Awarded per match (see the helper) — never for a bye (loserId is null).
      _maybeAwardTournamentGiantSlayer(tournamentId, winnerId, loserId);
    }

    if (match.winner_next_match_id) {
      const col = match.winner_next_slot === 1 ? 'player1_id' : 'player2_id';
      db.prepare(`UPDATE tournament_matches SET ${col} = ? WHERE id = ?`).run(winnerId, match.winner_next_match_id);
    } else {
      // No next match and not a grand final — this is a single-elimination final, so
      // the whole tournament is decided. (Every double-elimination match except the
      // grand final has a winner_next pointer, so this branch is single-elim only.)
      _completeTournament(tournamentId, winnerId, loserId);
    }
  }

  // players: ordered array of names, index 0 = seed 1. rounds: [{legsPerSet,
  // setsPerGame}, ...], earliest round first — must have exactly as many entries as
  // the bracket has rounds (single-elim: ceil(log2(next power of two >= player
  // count)); double-elim: doubleElimStructure(k).length). bracketType:
  // 'single_elim' (default) | 'double_elim'.
  function createTournament({ name, category, players, rounds, bracketType }) {
    name = String(name || '').trim();
    if (!name) throw httpError(400, 'Tournament name is required');
    if (name.length > 64) throw httpError(400, 'Tournament name must be 64 characters or fewer');
    if (!TOURNAMENT_X01_CATEGORIES.includes(String(category))) throw httpError(400, 'category must be one of 501, 301, 170, or 101');
    if (!Array.isArray(players) || players.length < 2) throw httpError(400, 'A tournament needs at least 2 players');
    if (players.length > TOURNAMENT_MAX_PLAYERS) throw httpError(400, `A tournament supports at most ${TOURNAMENT_MAX_PLAYERS} players`);
    const uniqueNames = new Set(players.map(n => String(n).trim().toLowerCase()));
    if (uniqueNames.size !== players.length) throw httpError(400, 'Duplicate players are not allowed');

    const bracketTypeClean = bracketType === 'double_elim' ? 'double_elim' : 'single_elim';
    // docs/archive/tournament-mode-roadmap.md §2: double-elimination is v1-restricted to exact
    // powers of two (4/8/16/32/64/128), the deliberate de-risking that keeps the losers
    // bracket free of the cascading-bye problem entirely — single-elim still handles
    // arbitrary counts, since its bye propagation is simple.
    if (bracketTypeClean === 'double_elim' && !TOURNAMENT_DOUBLE_ELIM_COUNTS.includes(players.length)) {
      throw httpError(400, `Double-elimination requires exactly ${TOURNAMENT_DOUBLE_ELIM_COUNTS.join(', ')} players`);
    }

    const bracketSize = _nextPowerOfTwo(players.length);
    const k = Math.log2(bracketSize);
    const plan = bracketTypeClean === 'double_elim' ? doubleElimStructure(k) : null;
    const expectedRoundCount = plan ? plan.length : k;
    if (!Array.isArray(rounds) || rounds.length !== expectedRoundCount) {
      throw httpError(400, `rounds must have exactly ${expectedRoundCount} entries for a ${bracketTypeClean === 'double_elim' ? 'double' : 'single'}-elimination bracket of ${players.length} players`);
    }
    const cleanRounds = rounds.map((r, i) => {
      const legsPerSet = Number(r.legsPerSet), setsPerGame = Number(r.setsPerGame);
      // docs/bug-roadmap.md BUG-5: reject non-integer or out-of-range formats here (the
      // setup UI never sends one), so a bogus round can't be persisted and then flow into
      // createGame() when the match is started. Upper bound matches MAX_LEGS_OR_SETS.
      if (!Number.isInteger(legsPerSet) || legsPerSet < 1 || legsPerSet > MAX_LEGS_OR_SETS ||
          !Number.isInteger(setsPerGame) || setsPerGame < 1 || setsPerGame > MAX_LEGS_OR_SETS) {
        throw httpError(400, `Round ${i + 1}: legsPerSet/setsPerGame must be integers between 1 and ${MAX_LEGS_OR_SETS}`);
      }
      return { legsPerSet, setsPerGame };
    });

    const playerRows = players.map(n => ensurePlayer(n));

    const tournamentId = Number(db.prepare(
      'INSERT INTO tournaments (name, category, bracket_type, player_count) VALUES (?, ?, ?, ?)'
    ).run(name, String(category), bracketTypeClean, playerRows.length).lastInsertRowid);

    playerRows.forEach((p, i) => {
      db.prepare('INSERT INTO tournament_players (tournament_id, player_id, seed) VALUES (?, ?, ?)')
        .run(tournamentId, p.id, i + 1);
    });

    const seedToPlayerId = {};
    playerRows.forEach((p, i) => { seedToPlayerId[i + 1] = p.id; });

    if (bracketTypeClean === 'double_elim') {
      _generateDoubleElimBracket(tournamentId, k, cleanRounds, plan, seedToPlayerId);
    } else {
      _generateSingleElimBracket(tournamentId, bracketSize, k, cleanRounds, seedToPlayerId);
    }

    return { tournamentId };
  }

  // Single-elimination generation (extracted unchanged from the original
  // createTournament so double-elim could branch alongside it): one round per
  // halving, standard seeding placement, cascading byes.
  function _generateSingleElimBracket(tournamentId, bracketSize, roundCount, cleanRounds, seedToPlayerId) {
    const roundIds = cleanRounds.map((r, i) => {
      const roundNo = i + 1;
      const label = _roundLabel(roundCount - roundNo, roundNo);
      return Number(db.prepare(
        'INSERT INTO tournament_rounds (tournament_id, round_no, label, legs_per_set, sets_per_game) VALUES (?, ?, ?, ?, ?)'
      ).run(tournamentId, roundNo, label, r.legsPerSet, r.setsPerGame).lastInsertRowid);
    });

    // Build rounds LAST-to-FIRST so every match can point winner_next_match_id at
    // an already-created row in the next round — the final's matches (no next
    // match) are created first, round 1's matches (pointing at round 2) last.
    const matchIdsByRound = new Array(roundCount);
    for (let r = roundCount - 1; r >= 0; r--) {
      const matchesInRound = bracketSize / Math.pow(2, r + 1);
      const ids = [];
      for (let slot = 0; slot < matchesInRound; slot++) {
        let nextMatchId = null, nextSlot = null;
        if (r < roundCount - 1) {
          nextMatchId = matchIdsByRound[r + 1][Math.floor(slot / 2)];
          nextSlot = (slot % 2) + 1;
        }
        const id = Number(db.prepare(
          'INSERT INTO tournament_matches (round_id, slot, winner_next_match_id, winner_next_slot) VALUES (?, ?, ?, ?)'
        ).run(roundIds[r], slot + 1, nextMatchId, nextSlot).lastInsertRowid);
        ids.push(id);
      }
      matchIdsByRound[r] = ids;
    }

    // Fill round 1 from the seed order; a slot whose seed number exceeds the real
    // player count has no player (a bye) — the other side auto-advances immediately.
    const seedSlots = _bracketSeedOrder(bracketSize);
    const round1MatchIds = matchIdsByRound[0];
    const byeAdvances = [];
    for (let m = 0; m < round1MatchIds.length; m++) {
      const playerA = seedToPlayerId[seedSlots[m * 2]] ?? null;
      const playerB = seedToPlayerId[seedSlots[m * 2 + 1]] ?? null;
      const isBye = (playerA == null) !== (playerB == null);
      db.prepare('UPDATE tournament_matches SET player1_id = ?, player2_id = ?, is_bye = ? WHERE id = ?')
        .run(playerA, playerB, isBye ? 1 : 0, round1MatchIds[m]);
      if (isBye) byeAdvances.push([round1MatchIds[m], playerA ?? playerB]);
    }
    // Propagate byes after every round-1 row exists, so a round-2+ match fed by two
    // separate round-1 byes ends up immediately "ready" (both real players known)
    // without either bye needing to reference the other.
    byeAdvances.forEach(([matchId, winnerId]) => _advanceTournamentMatch(matchId, winnerId));
  }

  // Double-elimination generation (docs/archive/tournament-mode-roadmap.md §2). k = log2 of
  // the exact player count (guaranteed a power of two here, so zero byes). Creates
  // every round and match up-front, then wires the winner_next / loser_next pointer
  // pairs the schema was designed for. Match layout per round comes from
  // doubleElimStructure(k) (the shared plan). All rows are created first, so pointers
  // are set by a second UPDATE pass — no last-to-first ordering dance needed.
  function _generateDoubleElimBracket(tournamentId, k, cleanRounds, plan, seedToPlayerId) {
    const N = Math.pow(2, k);
    const roundIds = plan.map((r, i) => Number(db.prepare(
      'INSERT INTO tournament_rounds (tournament_id, bracket, round_no, label, legs_per_set, sets_per_game) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(tournamentId, r.bracket, i + 1, r.label, cleanRounds[i].legsPerSet, cleanRounds[i].setsPerGame).lastInsertRowid));

    // Create every match, grouped by plan-round index; matchIds[i] = array of match ids.
    const matchIds = plan.map((r, i) => Array.from({ length: r.matches }, (_, s) => Number(db.prepare(
      'INSERT INTO tournament_matches (round_id, slot) VALUES (?, ?)'
    ).run(roundIds[i], s + 1).lastInsertRowid)));

    // Convenience accessors into matchIds by bracket-relative round number.
    const WB = (i) => matchIds[i - 1];              // winners round i (1..k)
    const LB = (j) => matchIds[k + j - 1];          // losers round j (1..2k-2)
    const lbRounds = 2 * k - 2;
    const GF1 = matchIds[k + lbRounds][0];          // grand final game 1
    const GF2 = matchIds[k + lbRounds + 1][0];      // grand final reset (decider)
    const setWinnerNext = (id, nextId, slot) =>
      db.prepare('UPDATE tournament_matches SET winner_next_match_id = ?, winner_next_slot = ? WHERE id = ?').run(nextId, slot, id);
    const setLoserNext = (id, nextId, slot) =>
      db.prepare('UPDATE tournament_matches SET loser_next_match_id = ?, loser_next_slot = ? WHERE id = ?').run(nextId, slot, id);

    // Winners-bracket winner advancement (standard single-elim shape), the WB final
    // winner going on to grand-final slot 1.
    for (let i = 1; i <= k; i++) {
      WB(i).forEach((mid, s) => {
        if (i < k) setWinnerNext(mid, WB(i + 1)[Math.floor(s / 2)], (s % 2) + 1);
        else setWinnerNext(mid, GF1, 1);
      });
    }
    // Winners-bracket loser drops. WB round 1 losers pair up into losers round 1; each
    // later WB round i (>=2) drops its losers into losers round 2(i-1)'s slot 2.
    for (let i = 1; i <= k; i++) {
      WB(i).forEach((mid, s) => {
        if (i === 1) setLoserNext(mid, LB(1)[Math.floor(s / 2)], (s % 2) + 1);
        else setLoserNext(mid, LB(2 * (i - 1))[s], 2);
      });
    }
    // Losers-bracket winner advancement. Minor rounds (odd j) feed the next drop round
    // 1:1 into slot 1; drop rounds (even j) pair their winners into the next minor
    // round; the losers final (j = 2k-2) sends its winner to grand-final slot 2.
    for (let j = 1; j <= lbRounds; j++) {
      LB(j).forEach((mid, s) => {
        if (j === lbRounds) setWinnerNext(mid, GF1, 2);
        else if (j % 2 === 1) setWinnerNext(mid, LB(j + 1)[s], 1);
        else setWinnerNext(mid, LB(j + 1)[Math.floor(s / 2)], (s % 2) + 1);
      });
    }

    // Seed winners round 1 (no byes — exact power of two).
    const seedSlots = _bracketSeedOrder(N);
    WB(1).forEach((mid, s) => {
      const playerA = seedToPlayerId[seedSlots[s * 2]] ?? null;
      const playerB = seedToPlayerId[seedSlots[s * 2 + 1]] ?? null;
      db.prepare('UPDATE tournament_matches SET player1_id = ?, player2_id = ? WHERE id = ?').run(playerA, playerB, mid);
    });
  }

  function listTournaments() {
    return db.prepare(`
      SELECT t.id, t.name, t.category, t.status, t.player_count, t.created_at, t.completed_at,
             c.name AS champion_name
      FROM tournaments t LEFT JOIN players c ON c.id = t.champion_id
      ORDER BY t.created_at DESC
    `).all();
  }

  function getTournament(id) {
    const t = db.prepare(`
      SELECT t.*, c.name AS champion_name, r.name AS runner_up_name
      FROM tournaments t
      LEFT JOIN players c ON c.id = t.champion_id
      LEFT JOIN players r ON r.id = t.runner_up_id
      WHERE t.id = ?
    `).get(Number(id));
    if (!t) return null;

    const matches = db.prepare(`
      SELECT m.id, m.round_id, m.slot, m.is_bye, m.game_id, m.winner_id,
             m.winner_next_match_id, m.winner_next_slot,
             r.round_no, r.label, r.bracket, r.legs_per_set AS legsPerSet, r.sets_per_game AS setsPerGame,
             p1.name AS player1Name, p2.name AS player2Name, w.name AS winnerName
      FROM tournament_matches m
      JOIN tournament_rounds r ON r.id = m.round_id
      LEFT JOIN players p1 ON p1.id = m.player1_id
      LEFT JOIN players p2 ON p2.id = m.player2_id
      LEFT JOIN players w  ON w.id  = m.winner_id
      WHERE r.tournament_id = ?
      ORDER BY r.round_no, m.slot
    `).all(t.id).map(m => ({
      ...m,
      status: m.winner_id != null ? 'complete'
        : (m.game_id != null ? 'in_progress'
          : (m.player1Name != null && m.player2Name != null ? 'ready' : 'pending')),
    }));

    const players = db.prepare(`
      SELECT tp.seed, tp.status, p.name
      FROM tournament_players tp JOIN players p ON p.id = tp.player_id
      WHERE tp.tournament_id = ? ORDER BY tp.seed
    `).all(t.id);

    return { ...t, matches, players };
  }

  // docs/archive/tournament-mode-roadmap.md §8: Player Profile "Tournaments" stat block —
  // wins, runner-up count, and best finish reached, all simple COUNT/MAX-style
  // queries against the existing tournament tables, no new derived formula.
  function getTournamentStats(playerName) {
    const p = getPlayer(playerName);
    if (!p) return { wins: 0, runnerUps: 0, bestFinish: null };
    const wins = db.prepare('SELECT COUNT(*) AS n FROM tournaments WHERE champion_id = ?').get(p.id).n;
    const runnerUps = db.prepare('SELECT COUNT(*) AS n FROM tournaments WHERE runner_up_id = ?').get(p.id).n;
    // Best finish reached = the furthest round this player was ever placed into
    // (win or loss, including a bye placement) across every tournament they've
    // played, one row per tournament they appear in at all. A player's max
    // round_no within one tournament IS the furthest they reached there, since
    // round N+1 placement only ever happens after winning round N — and because a
    // double-elimination tournament numbers its rounds globally in play order
    // (winners, then losers, then the grand final), this stays true across both
    // bracket types. The reported LABEL is read from that furthest round itself
    // (`tournament_rounds.label`), not recomputed, so a double-elim "Losers Final"
    // or "Grand Final" reads correctly rather than being mislabeled by the
    // single-elim `_roundLabel()` naming.
    const rows = db.prepare(`
      SELECT tr.tournament_id AS tid, MAX(tr.round_no) AS maxRoundNo,
             (SELECT COUNT(*) FROM tournament_rounds WHERE tournament_id = tr.tournament_id) AS totalRounds
      FROM tournament_matches tm
      JOIN tournament_rounds tr ON tr.id = tm.round_id
      WHERE tm.player1_id = ? OR tm.player2_id = ?
      GROUP BY tr.tournament_id
    `).all(p.id, p.id);
    let bestRoundsFromFinal = Infinity, bestTid = null, bestRoundNo = null;
    for (const r of rows) {
      const roundsFromFinal = r.totalRounds - r.maxRoundNo;
      if (roundsFromFinal < bestRoundsFromFinal) {
        bestRoundsFromFinal = roundsFromFinal;
        bestTid = r.tid;
        bestRoundNo = r.maxRoundNo;
      }
    }
    const bestFinish = bestTid != null
      ? (db.prepare('SELECT label FROM tournament_rounds WHERE tournament_id = ? AND round_no = ?').get(bestTid, bestRoundNo)?.label ?? null)
      : null;
    return { wins, runnerUps, bestFinish };
  }

  // Starts the linked game for a "ready" match (both players known, not already
  // started or complete) — reuses createGame() exactly as a normal New Game H2H
  // match would, with the round's own configured category/legs/sets.
  function startTournamentMatch(matchId) {
    const m = db.prepare(`
      SELECT m.id, m.player1_id, m.player2_id, m.game_id, m.winner_id,
             r.legs_per_set AS legsPerSet, r.sets_per_game AS setsPerGame, t.category
      FROM tournament_matches m
      JOIN tournament_rounds r ON r.id = m.round_id
      JOIN tournaments t ON t.id = r.tournament_id
      WHERE m.id = ?
    `).get(Number(matchId));
    if (!m) throw httpError(404, 'Match not found');
    if (m.player1_id == null || m.player2_id == null) throw httpError(409, 'Match is not ready yet — both players are not yet known');
    if (m.winner_id != null) throw httpError(409, 'Match is already complete');
    if (m.game_id != null) throw httpError(409, 'This match already has a game in progress');
    const p1 = db.prepare('SELECT name, out_mode FROM players WHERE id = ?').get(m.player1_id);
    const p2 = db.prepare('SELECT name, out_mode FROM players WHERE id = ?').get(m.player2_id);
    const { gameId } = createGame({
      category: m.category, legsPerSet: m.legsPerSet, setsPerGame: m.setsPerGame, practice: 0,
      players: [{ name: p1.name, out: p1.out_mode }, { name: p2.name, out: p2.out_mode }],
    });
    db.prepare('UPDATE tournament_matches SET game_id = ? WHERE id = ?').run(gameId, m.id);
    return { gameId };
  }

  // Records a result without playing it out — covers both "this match was never
  // started" and "a game was started but abandoned mid-way" (the roadmap doc's
  // requirement that a tournament match can't just be left as a plain unfinished
  // game): allowed any time winner_id is still null, regardless of game_id.
  function recordWalkover(matchId, winnerName) {
    const m = db.prepare('SELECT * FROM tournament_matches WHERE id = ?').get(Number(matchId));
    if (!m) throw httpError(404, 'Match not found');
    if (m.player1_id == null || m.player2_id == null) throw httpError(409, 'Match is not ready yet — both players are not yet known');
    if (m.winner_id != null) throw httpError(409, 'Match is already complete');
    const w = getPlayer(winnerName);
    if (!w || (w.id !== m.player1_id && w.id !== m.player2_id)) throw httpError(400, "winner must be one of this match's two players");
    _advanceTournamentMatch(m.id, w.id);
    return { ok: true };
  }

  // Hook: when ANY game completes, check whether it's linked to a tournament match
  // and advance the bracket if so — this is the one piece of "tournament mode"
  // logic that lives outside this section, registered here rather than editing
  // completeGame() directly (docs/archive/existing-app-prep-roadmap.md item 4).
  onGameCompleted(({ gameId, winnerName }) => {
    if (!winnerName) return;
    const m = db.prepare('SELECT id FROM tournament_matches WHERE game_id = ?').get(gameId);
    if (!m) return;
    const w = getPlayer(winnerName);
    if (!w) return;
    _advanceTournamentMatch(m.id, w.id);
  });

  // Player-deletion guard (docs/archive/existing-app-prep-roadmap.md item 6): block
  // deleting a player who's still 'active' in an in-progress tournament — the
  // bracket depends on that player's future matches existing to advance correctly.
  // A player already eliminated, or a completed tournament, is safe to delete from
  // (loses only that historical name, same tradeoff already accepted elsewhere —
  // e.g. games.winner_id ON DELETE SET NULL).
  registerDeletePlayerGuard((player) => {
    const row = db.prepare(`
      SELECT t.name FROM tournament_players tp
      JOIN tournaments t ON t.id = tp.tournament_id
      WHERE tp.player_id = ? AND tp.status = 'active' AND t.status = 'in_progress'
    `).get(player.id);
    return row ? `${player.name} is still active in the in-progress tournament "${row.name}" — eliminate them or finish the tournament before deleting.` : null;
  });

  // docs/archive/saved-games-roadmap.md "Interactions with existing features": block
  // deleting a player who's in a currently-saved game — resuming it would try to
  // rebuild a match that includes a player who no longer exists. Cheaper and
  // louder than an auto-abandon side effect buried inside a delete; the admin
  // abandons the saved game first (its recorded stats are kept either way).
  registerDeletePlayerGuard((player) => {
    const row = db.prepare(`
      SELECT g.category AS category FROM saved_games sg
      JOIN games g ON g.id = sg.game_id
      WHERE EXISTS (SELECT 1 FROM game_players WHERE game_id = g.id AND player_id = ?)
    `).get(player.id);
    return row ? `${player.name} is in a saved ${row.category} game — abandon it (or resume and finish it) before deleting.` : null;
  });

  return {
    createTournament, listTournaments, getTournament, getTournamentStats,
    startTournamentMatch, recordWalkover,
  };
};
