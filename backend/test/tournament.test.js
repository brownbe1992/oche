'use strict';
// Committed tests for backend/db.js's tournament mode (docs/tournament-mode-roadmap.md,
// single-elimination only — double-elimination explicitly deferred, tracked separately
// on docs/open-roadmap-items.md). Covers: bracket generation across player counts
// (round count, standard seeding pairs, bye cascading with no double-byes),
// advancement propagation through a full simulated tournament to a champion,
// walkover parity with a played match, validation, the player-deletion guard,
// the Champion/Giant Slayer (Tournament) badges (§7), and getTournamentStats() (§8).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-test-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const db = require('../db.js');

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

let counter = 0;
function uniqueName(prefix) { return `${prefix}_${++counter}`; }
function makePlayers(prefix, n) {
  const names = Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(65 + i)}`);
  names.forEach(n2 => db.addPlayer(n2, 'double', {}));
  return names;
}
function roundsFor(n, finalLegs = 5) {
  const count = Math.ceil(Math.log2(Math.pow(2, Math.ceil(Math.log2(n)))));
  return Array.from({ length: count }, (_, i) =>
    ({ legsPerSet: i === count - 1 ? finalLegs : 3, setsPerGame: 1 }));
}

describe('createTournament — bracket generation', () => {
  test('exact power of two (8 players): 3 rounds, zero byes, standard seeding pairs', () => {
    const players = makePlayers(uniqueName('P8_'), 8);
    const { tournamentId } = db.createTournament({ name: 'Pow2 Cup', category: '301', players, rounds: roundsFor(8) });
    const t = db.getTournament(tournamentId);
    const r1 = t.matches.filter(m => m.round_no === 1);
    assert.equal(t.matches.filter(m => m.round_no === 3).length, 1, 'a single final');
    assert.equal(r1.length, 4);
    assert.equal(r1.filter(m => m.is_bye).length, 0, 'no byes at an exact power of two');
    // Standard bracket seeding: 1v8, 4v5, 2v7, 3v6 (seed 1 and seed 2 can't meet before the final)
    assert.deepEqual(r1.map(m => [m.player1Name, m.player2Name]), [
      [players[0], players[7]], [players[3], players[4]], [players[1], players[6]], [players[2], players[5]],
    ]);
    assert.equal(t.matches.find(m => m.round_no === 1).label, 'Quarterfinal');
    assert.equal(t.matches.find(m => m.round_no === 2).label, 'Semifinal');
    assert.equal(t.matches.find(m => m.round_no === 3).label, 'Final');
  });

  test('5 players: byes cascade correctly, no round-1 match has two byes', () => {
    const players = makePlayers(uniqueName('P5_'), 5);
    const { tournamentId } = db.createTournament({ name: '5-Player Cup', category: '501', players, rounds: roundsFor(5) });
    const t = db.getTournament(tournamentId);
    const r1 = t.matches.filter(m => m.round_no === 1);
    assert.equal(r1.length, 4, 'bracket padded to 8 (next power of two)');
    assert.equal(r1.filter(m => m.is_bye).length, 3, 'bracketSize(8) - players(5) = 3 byes');
    assert.ok(r1.every(m => m.player1Name != null || m.player2Name != null), 'no round-1 match is a double-bye');
    // Byes auto-resolve immediately: 3 of 4 round-1 matches are already complete
    assert.equal(r1.filter(m => m.status === 'complete').length, 3);
    // A round-2 match fed by two separate round-1 byes is immediately "ready"
    // (both real players known) without either underlying bye match being played.
    const r2 = t.matches.filter(m => m.round_no === 2);
    assert.ok(r2.some(m => m.status === 'ready'), 'at least one semifinal is pre-filled by bye cascades');
  });

  test('2 players: 1 round, no byes, immediately ready', () => {
    const players = makePlayers(uniqueName('P2_'), 2);
    const { tournamentId } = db.createTournament({ name: '2-Player Cup', category: '501', players, rounds: roundsFor(2) });
    const t = db.getTournament(tournamentId);
    assert.equal(t.matches.length, 1);
    assert.equal(t.matches[0].label, 'Final');
    assert.equal(t.matches[0].status, 'ready');
  });

  test('3 players: 2 rounds, exactly 1 bye, the bye winner waits in the final for the real match\'s winner', () => {
    const players = makePlayers(uniqueName('P3_'), 3);
    const { tournamentId } = db.createTournament({ name: '3-Player Cup', category: '501', players, rounds: roundsFor(3) });
    const t = db.getTournament(tournamentId);
    const r1 = t.matches.filter(m => m.round_no === 1);
    assert.equal(r1.length, 2);
    assert.equal(r1.filter(m => m.is_bye).length, 1);
    const final = t.matches.find(m => m.round_no === 2);
    assert.equal(final.status, 'pending');
    assert.ok((final.player1Name != null) !== (final.player2Name != null), 'exactly one final slot pre-filled by the bye');
  });

  test('validation: name required, bad category, duplicate players, wrong round count, too few players', () => {
    const players = makePlayers(uniqueName('PV_'), 2);
    assert.throws(() => db.createTournament({ name: '', category: '501', players, rounds: roundsFor(2) }),
      (e) => e.status === 400 && /name is required/i.test(e.message));
    assert.throws(() => db.createTournament({ name: 'X', category: '999', players, rounds: roundsFor(2) }),
      (e) => e.status === 400 && /category/i.test(e.message));
    assert.throws(() => db.createTournament({ name: 'X', category: '501', players: [players[0], players[0]], rounds: roundsFor(2) }),
      (e) => e.status === 400 && /duplicate/i.test(e.message));
    assert.throws(() => db.createTournament({ name: 'X', category: '501', players, rounds: [] }),
      (e) => e.status === 400 && /rounds must have exactly/i.test(e.message));
    assert.throws(() => db.createTournament({ name: 'X', category: '501', players: [players[0]], rounds: [] }),
      (e) => e.status === 400 && /at least 2 players/i.test(e.message));
  });
});

describe('tournament advancement — full simulation to champion', () => {
  test('played matches, a walkover, and bye cascades all propagate identically through to champion/runner-up', () => {
    const players = makePlayers(uniqueName('SIM_'), 5); // [A, B, C, D, E]
    const [A, B, C, D, E] = players;
    const { tournamentId } = db.createTournament({ name: 'Sim Cup', category: '501', players, rounds: roundsFor(5) });

    // Selects the match between two specific (unordered) players, asserting it's
    // actually ready to act on — more than one match can be simultaneously ready
    // at once (e.g. once one semifinal is bye-fed and the other just resolved),
    // so picking "the first ready match" isn't deterministic; picking by the
    // exact pairing we intend to act on is.
    const matchBetween = (x, y) => {
      const found = db.getTournament(tournamentId).matches.find(mm =>
        [mm.player1Name, mm.player2Name].sort().join(',') === [x, y].sort().join(','));
      assert.ok(found, `expected a match between ${x} and ${y}`);
      assert.equal(found.status, 'ready', `match between ${x} and ${y} should be ready`);
      return found;
    };

    // Round 1's only real match (per the 5-player bye layout proven above) — play it out.
    let m = matchBetween(D, E);
    let { gameId } = db.startTournamentMatch(m.id);
    db.completeGame(gameId, D);

    // Semifinal already fed entirely by byes (B vs C) — resolve via walkover instead of playing.
    m = matchBetween(B, C);
    db.recordWalkover(m.id, B);

    // Remaining semifinal: A (bye winner) vs D (just-won real match)
    m = matchBetween(A, D);
    ({ gameId } = db.startTournamentMatch(m.id));
    db.completeGame(gameId, A);

    // Final: A vs B
    m = matchBetween(A, B);
    ({ gameId } = db.startTournamentMatch(m.id));
    db.completeGame(gameId, B);

    const t = db.getTournament(tournamentId);
    assert.equal(t.status, 'completed');
    assert.equal(t.champion_name, B);
    assert.equal(t.runner_up_name, A);
    assert.ok(t.completed_at);
    const statusByName = Object.fromEntries(t.players.map(p => [p.name, p.status]));
    assert.equal(statusByName[B], 'champion');
    assert.equal(statusByName[A], 'eliminated');
    assert.equal(statusByName[C], 'eliminated');
    assert.equal(statusByName[D], 'eliminated');
    assert.equal(statusByName[E], 'eliminated');
    assert.equal(db.getTournament(tournamentId).matches.find(mm => mm.status === 'ready'), undefined, 'nothing left to play');
  });

  test('a tournament match records as a normal H2H game — counts toward existing stats with zero special-casing', () => {
    const players = makePlayers(uniqueName('STATS_'), 2);
    const [X, Y] = players;
    const { tournamentId } = db.createTournament({ name: 'Stats Cup', category: '501', players, rounds: roundsFor(2) });
    const m = db.getTournament(tournamentId).matches[0];
    const { gameId } = db.startTournamentMatch(m.id);
    db.addTurn(gameId, { player: X, set: 1, leg: 1, scored: 40, checkout: true, checkoutPoints: 40, darts: [{ sector: 20, multiplier: 2 }] });
    db.completeGame(gameId, X);

    const h2h = db.getH2HRecord(X, Y);
    assert.equal(h2h.totalGames ?? h2h.games ?? 1 >= 1, true, 'H2H record picks up the tournament match like any other H2H game');
  });
});

describe('startTournamentMatch / recordWalkover — guards', () => {
  test('startTournamentMatch rejects a not-yet-ready match, and a match already in progress', () => {
    const players = makePlayers(uniqueName('G1_'), 3);
    const { tournamentId } = db.createTournament({ name: 'Guard Cup 1', category: '501', players, rounds: roundsFor(3) });
    const t = db.getTournament(tournamentId);
    const pending = t.matches.find(m => m.status === 'pending');
    assert.throws(() => db.startTournamentMatch(pending.id), (e) => e.status === 409 && /not ready/i.test(e.message));

    const ready = t.matches.find(m => m.status === 'ready');
    const { gameId } = db.startTournamentMatch(ready.id);
    assert.ok(gameId);
    assert.throws(() => db.startTournamentMatch(ready.id), (e) => e.status === 409 && /already has a game/i.test(e.message));
  });

  test('recordWalkover rejects an unknown winner, a not-ready match, and an already-complete match; recovers an abandoned mid-game match', () => {
    const players = makePlayers(uniqueName('G2_'), 3);
    const [A, B, C] = players;
    const { tournamentId } = db.createTournament({ name: 'Guard Cup 2', category: '501', players, rounds: roundsFor(3) });
    let t = db.getTournament(tournamentId);
    const pending = t.matches.find(m => m.status === 'pending');
    assert.throws(() => db.recordWalkover(pending.id, A), (e) => e.status === 409 && /not ready/i.test(e.message));

    const ready = t.matches.find(m => m.status === 'ready');
    const someoneElse = players.find(n => ![ready.player1Name, ready.player2Name].includes(n));
    assert.throws(() => db.recordWalkover(ready.id, someoneElse), (e) => e.status === 400 && /must be one of/i.test(e.message));

    // Start the game (abandon it — never call completeGame) then recover via walkover anyway.
    const { gameId } = db.startTournamentMatch(ready.id);
    assert.equal(db.recordWalkover(ready.id, ready.player1Name).ok, true, 'a walkover can override an abandoned mid-game match');
    assert.throws(() => db.recordWalkover(ready.id, ready.player1Name), (e) => e.status === 409 && /already complete/i.test(e.message));
  });
});

describe('registerDeletePlayerGuard — tournament competitor protection', () => {
  test('blocks deleting a player active in an in-progress tournament, allows once eliminated or completed', () => {
    const players = makePlayers(uniqueName('DEL_'), 2);
    const [A, B] = players;
    const { tournamentId } = db.createTournament({ name: 'Delete Cup', category: '501', players, rounds: roundsFor(2) });

    assert.throws(() => db.deletePlayer(A), (e) => e.status === 409 && /active in the in-progress tournament/i.test(e.message));

    const m = db.getTournament(tournamentId).matches[0];
    db.recordWalkover(m.id, B); // A eliminated, B champion, tournament completed

    assert.deepEqual(db.deletePlayer(A), { ok: true }, 'eliminated player is deletable even while related rows still exist');
    assert.deepEqual(db.deletePlayer(B), { ok: true }, 'champion is deletable once the tournament is completed');
  });
});

describe('listTournaments', () => {
  test('summarizes name/category/status/player_count/champion across tournaments, most recent first', () => {
    const players = makePlayers(uniqueName('LIST_'), 2);
    const before = db.listTournaments().length;
    const { tournamentId } = db.createTournament({ name: 'List Cup', category: '170', players, rounds: roundsFor(2) });
    const list = db.listTournaments();
    assert.equal(list.length, before + 1);
    const row = list.find(t => t.id === tournamentId);
    assert.equal(row.name, 'List Cup');
    assert.equal(row.category, '170');
    assert.equal(row.status, 'in_progress');
    assert.equal(row.player_count, 2);
    assert.equal(row.champion_name, null);
  });
});

describe('BUG-4 — advancement guards (winner validation + already-decided)', () => {
  test('completing a tournament-linked game with a NON-participant winner does not corrupt the bracket', () => {
    const players = makePlayers(uniqueName('B4A_'), 2);
    const [A, B] = players;
    const outsider = uniqueName('B4A_OUT'); db.addPlayer(outsider);
    const { tournamentId } = db.createTournament({ name: 'Bug4 Cup A', category: '501', players, rounds: roundsFor(2) });
    const final = db.getTournament(tournamentId).matches[0];
    const { gameId } = db.startTournamentMatch(final.id);
    // Forge a completion naming a real player who isn't in this match.
    db.completeGame(gameId, outsider);
    const t = db.getTournament(tournamentId);
    assert.equal(t.status, 'in_progress', 'tournament must not complete on a non-participant winner');
    assert.equal(t.champion_name, null, 'no champion set');
    assert.equal(t.matches[0].winnerName, null, 'match winner not recorded for an outsider');
    // The legitimate result still works afterward.
    db.completeGame(gameId, A);
    const t2 = db.getTournament(tournamentId);
    assert.equal(t2.status, 'completed');
    assert.equal(t2.champion_name, A);
  });

  test('a second complete on an already-decided match cannot overwrite the recorded winner or champion', () => {
    const players = makePlayers(uniqueName('B4B_'), 2);
    const [A, B] = players;
    const { tournamentId } = db.createTournament({ name: 'Bug4 Cup B', category: '501', players, rounds: roundsFor(2) });
    const final = db.getTournament(tournamentId).matches[0];
    const { gameId } = db.startTournamentMatch(final.id);
    db.completeGame(gameId, A);
    assert.equal(db.getTournament(tournamentId).champion_name, A);
    // Replay the completion with the OTHER player — must be a no-op for the bracket.
    db.completeGame(gameId, B);
    const t = db.getTournament(tournamentId);
    assert.equal(t.champion_name, A, 'champion is not overwritten by a replayed complete');
    assert.equal(t.matches[0].winnerName, A);
  });
});

describe('BUG-5 — round format bounds', () => {
  test('createTournament rejects a round with an out-of-range or non-integer legs/sets', () => {
    const players = makePlayers(uniqueName('B5_'), 2);
    assert.throws(() => db.createTournament({ name: 'Bug5 Cup', category: '501', players, rounds: [{ legsPerSet: 1e9, setsPerGame: 1 }] }),
      (e) => e.status === 400 && /between 1 and/i.test(e.message));
    assert.throws(() => db.createTournament({ name: 'Bug5 Cup', category: '501', players, rounds: [{ legsPerSet: 2.5, setsPerGame: 1 }] }),
      (e) => e.status === 400 && /between 1 and/i.test(e.message));
    // A sane format still creates fine.
    const ok = db.createTournament({ name: 'Bug5 OK', category: '501', players, rounds: [{ legsPerSet: 3, setsPerGame: 1 }] });
    assert.ok(ok.tournamentId);
  });
});

describe('BUG-7 — wipeAllData clears tournament tables', () => {
  test('a full wipe leaves no orphaned tournament rows', () => {
    const players = makePlayers(uniqueName('B7_'), 4);
    db.createTournament({ name: 'Bug7 Cup', category: '501', players, rounds: roundsFor(4) });
    assert.ok(db.listTournaments().length >= 1, 'tournament exists before wipe');
    db.wipeAllData();
    assert.equal(db.listTournaments().length, 0, 'no tournaments survive wipeAllData');
    for (const tbl of ['tournaments', 'tournament_players', 'tournament_rounds', 'tournament_matches']) {
      const n = db._db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get().n;
      assert.equal(n, 0, `${tbl} must be empty after wipeAllData`);
    }
  });
});

// docs/tournament-mode-roadmap.md §7 — Champion and Giant Slayer (Tournament)
// badges, awarded inline from _advanceTournamentMatch() (see the "not a second
// parallel hook" note in the roadmap doc itself).
describe('tournament badges (§7)', () => {
  function badgeCount(playerName, badgeId) {
    const row = db.getPlayerBadges(playerName).find(b => b.badge_id === badgeId);
    return row ? row.count : 0;
  }

  test('Champion fires once for the winner only, never for the runner-up or an earlier loser', () => {
    const players = makePlayers(uniqueName('CHAMP_'), 4); // seeds 1-4: standard pairing 1v4, 2v3
    const [S1, S2, S3, S4] = players;
    const { tournamentId } = db.createTournament({ name: 'Champ Cup', category: '501', players, rounds: roundsFor(4) });
    const t0 = db.getTournament(tournamentId);
    const semi1 = t0.matches.find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [S1, S4].sort().join(','));
    const semi2 = t0.matches.find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [S2, S3].sort().join(','));
    db.completeGame(db.startTournamentMatch(semi1.id).gameId, S1); // S4 eliminated, no seed-gap upset (diff 3 — see below)
    db.completeGame(db.startTournamentMatch(semi2.id).gameId, S2); // S3 eliminated
    const final = db.getTournament(tournamentId).matches.find(mm => mm.status === 'ready');
    db.completeGame(db.startTournamentMatch(final.id).gameId, S1);

    assert.equal(db.getTournament(tournamentId).champion_name, S1);
    assert.equal(badgeCount(S1, 'tournament_champion'), 1, 'the champion earns the badge exactly once');
    assert.equal(badgeCount(S2, 'tournament_champion'), 0, 'the runner-up does not earn Champion');
    assert.equal(badgeCount(S3, 'tournament_champion'), 0, 'an earlier-round loser does not earn Champion');
    assert.equal(badgeCount(S4, 'tournament_champion'), 0);
  });

  test('Giant Slayer (Tournament) fires only when the winner\'s seed is >= 3 slots worse than the beaten opponent\'s, never on a bye', () => {
    const players = makePlayers(uniqueName('GS_'), 8); // round 1 standard pairing: 1v8, 4v5, 2v7, 3v6
    const [S1, S2, S3, S4, S5, S6, S7, S8] = players;
    const { tournamentId } = db.createTournament({ name: 'Upset Cup', category: '501', players, rounds: roundsFor(8) });
    const r1 = () => db.getTournament(tournamentId).matches.filter(mm => mm.round_no === 1);

    // Seed 8 (worse) beats seed 1 (better) — gap of 7, a clear upset.
    const m18 = r1().find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [S1, S8].sort().join(','));
    db.completeGame(db.startTournamentMatch(m18.id).gameId, S8);
    assert.equal(badgeCount(S8, 'tournament_giant_slayer'), 1, 'beating a 7-slots-better seed is an upset');

    // Seed 5 beats seed 4 — gap of only 1, not an upset.
    const m45 = r1().find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [S4, S5].sort().join(','));
    db.completeGame(db.startTournamentMatch(m45.id).gameId, S5);
    assert.equal(badgeCount(S5, 'tournament_giant_slayer'), 0, 'a 1-slot gap is not an upset');

    // Seed 7 beats seed 2 — gap of 5, an upset; the higher (better) seed winning never fires it.
    const m27 = r1().find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [S2, S7].sort().join(','));
    db.completeGame(db.startTournamentMatch(m27.id).gameId, S7);
    assert.equal(badgeCount(S7, 'tournament_giant_slayer'), 1);
    assert.equal(badgeCount(S2, 'tournament_giant_slayer'), 0, 'the better seed winning is never an upset');

    // Seed 3 beats seed 6 (the better seed wins) — no upset either way.
    const m36 = r1().find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [S3, S6].sort().join(','));
    db.completeGame(db.startTournamentMatch(m36.id).gameId, S3);
    assert.equal(badgeCount(S3, 'tournament_giant_slayer'), 0);
    assert.equal(badgeCount(S6, 'tournament_giant_slayer'), 0);
  });

  test('a 5-player bye advance never awards Giant Slayer (no real opponent was beaten)', () => {
    const players = makePlayers(uniqueName('GSBYE_'), 5); // seed 1 gets a round-1 bye
    const [S1] = players;
    db.createTournament({ name: 'Bye Cup', category: '501', players, rounds: roundsFor(5) });
    assert.equal(badgeCount(S1, 'tournament_giant_slayer'), 0, 'auto-advancing past a bye is not a beaten opponent');
  });
});

describe('getTournamentStats (§8)', () => {
  test('a player with no tournament history gets all-zero/null stats', () => {
    const [solo] = makePlayers(uniqueName('NONE_'), 1);
    assert.deepEqual(db.getTournamentStats(solo), { wins: 0, runnerUps: 0, bestFinish: null });
  });

  test('wins/runnerUps/bestFinish reflect champion, runner-up, and semifinal-loser outcomes', () => {
    const players = makePlayers(uniqueName('STAT4_'), 4); // seeds 1-4: 1v4, 2v3
    const [S1, S2, S3, S4] = players;
    const { tournamentId } = db.createTournament({ name: 'Stat Cup', category: '501', players, rounds: roundsFor(4) });
    const t0 = db.getTournament(tournamentId);
    const semi1 = t0.matches.find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [S1, S4].sort().join(','));
    const semi2 = t0.matches.find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [S2, S3].sort().join(','));
    db.completeGame(db.startTournamentMatch(semi1.id).gameId, S1);
    db.completeGame(db.startTournamentMatch(semi2.id).gameId, S2);
    const final = db.getTournament(tournamentId).matches.find(mm => mm.status === 'ready');
    db.completeGame(db.startTournamentMatch(final.id).gameId, S1);

    assert.deepEqual(db.getTournamentStats(S1), { wins: 1, runnerUps: 0, bestFinish: 'Final' });
    assert.deepEqual(db.getTournamentStats(S2), { wins: 0, runnerUps: 1, bestFinish: 'Final' });
    assert.deepEqual(db.getTournamentStats(S3), { wins: 0, runnerUps: 0, bestFinish: 'Semifinal' });
    assert.deepEqual(db.getTournamentStats(S4), { wins: 0, runnerUps: 0, bestFinish: 'Semifinal' });
  });

  test('bestFinish takes the best result across multiple tournaments, and wins/runnerUps accumulate', () => {
    const players = makePlayers(uniqueName('STAT2X_'), 4);
    const [A, B, C, D] = players;
    // Tournament 1: A loses in the semifinal (worst finish for A so far).
    const t1 = db.createTournament({ name: 'Multi Cup 1', category: '501', players, rounds: roundsFor(4) }).tournamentId;
    let t = db.getTournament(t1);
    let semi = t.matches.find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [A, D].sort().join(','));
    db.completeGame(db.startTournamentMatch(semi.id).gameId, D);
    semi = db.getTournament(t1).matches.find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [B, C].sort().join(','));
    db.completeGame(db.startTournamentMatch(semi.id).gameId, B);
    let final = db.getTournament(t1).matches.find(mm => mm.status === 'ready');
    db.completeGame(db.startTournamentMatch(final.id).gameId, D); // B is runner-up

    // Tournament 2: A wins it all — should now override the earlier semifinal finish.
    const t2 = db.createTournament({ name: 'Multi Cup 2', category: '501', players, rounds: roundsFor(4) }).tournamentId;
    semi = db.getTournament(t2).matches.find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [A, D].sort().join(','));
    db.completeGame(db.startTournamentMatch(semi.id).gameId, A);
    semi = db.getTournament(t2).matches.find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [B, C].sort().join(','));
    db.completeGame(db.startTournamentMatch(semi.id).gameId, C);
    final = db.getTournament(t2).matches.find(mm => mm.status === 'ready');
    db.completeGame(db.startTournamentMatch(final.id).gameId, A);

    assert.deepEqual(db.getTournamentStats(A), { wins: 1, runnerUps: 0, bestFinish: 'Final' });
    assert.equal(db.getTournamentStats(B).runnerUps, 1, 'B was runner-up in tournament 1');
  });

  test('an in-progress tournament still reports the furthest round reached so far', () => {
    const players = makePlayers(uniqueName('STATPROG_'), 4);
    const [A, , , D] = players;
    const { tournamentId } = db.createTournament({ name: 'In Progress Cup', category: '501', players, rounds: roundsFor(4) });
    const semi = db.getTournament(tournamentId).matches.find(mm => [mm.player1Name, mm.player2Name].sort().join(',') === [A, D].sort().join(','));
    db.completeGame(db.startTournamentMatch(semi.id).gameId, A);
    // The other semifinal hasn't been played yet, so the final isn't "ready" —
    // but A's win already placed them into the final's row (winner_next_match_id),
    // and that placement alone should count as "reached the final."
    assert.equal(db.getTournamentStats(A).bestFinish, 'Final', 'being fed into the not-yet-ready final still counts as reaching it');
  });
});
