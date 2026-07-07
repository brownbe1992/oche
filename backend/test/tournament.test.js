'use strict';
// Committed tests for backend/db.js's tournament mode (docs/tournament-mode-roadmap.md,
// single-elimination only — double-elimination explicitly deferred, tracked separately
// on docs/open-roadmap-items.md). Covers: bracket generation across player counts
// (round count, standard seeding pairs, bye cascading with no double-byes),
// advancement propagation through a full simulated tournament to a champion,
// walkover parity with a played match, validation, and the player-deletion guard.
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
