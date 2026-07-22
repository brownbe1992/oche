'use strict';
// Committed regression test for backend/db.js's forfeitPlayer()/abandonGame()
// (docs/open-roadmap-items.md "Forfeiting a multiplayer game" / "abandoned
// games count as a DNF"). Two related behaviors:
//   - forfeitPlayer(): one participant of a still-live multiplayer match bows
//     out. If 2+ others are still active, the match keeps going (dnf flagged
//     on just that one participant). If bowing out leaves exactly one other
//     active participant, the match completes normally with that survivor as
//     the winner (a walkover, same shape as recordWalkover()). If NO active
//     participant remains, the match ends with no winner, marked dnf_at.
//   - abandonGame(): the whole match ends early (before anyone reached a real
//     finish) — every still-active participant is marked DNF and the game
//     gets dnf_at, never completed_at.
// Both dnf_at/dnf are deliberately separate from completed_at/winner_id (see
// the migration comment in db.js) — this suite also checks that an abandoned
// game's partial turns don't get counted by completed_at-scoped stat queries.
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

function gameRow(gameId) {
  return db._db.prepare('SELECT completed_at, dnf_at, winner_id FROM games WHERE id = ?').get(gameId);
}
function participantDnf(gameId, playerName) {
  const p = db._db.prepare('SELECT id FROM players WHERE name = ?').get(playerName);
  return db._db.prepare('SELECT dnf FROM game_players WHERE game_id = ? AND player_id = ?').get(gameId, p.id).dnf;
}

describe('forfeitPlayer — bowing out of a still-live multiplayer game', () => {
  test('4-player game: one bows out, the other three keep playing unaffected', async () => {
    for (const n of ['FP_A', 'FP_B', 'FP_C', 'FP_D']) await db.addPlayer(n);
    const { gameId } = db.createGame({
      category: 'Cricket', legsPerSet: 1, setsPerGame: 1, practice: 0, gameType: 'cricket',
      config: { numbers: [20, 19, 18, 17, 16, 15, 25] },
      players: [{ name: 'FP_A' }, { name: 'FP_B' }, { name: 'FP_C' }, { name: 'FP_D' }],
    });
    const res = db.forfeitPlayer(gameId, 'FP_B');
    assert.equal(res.ended, false, 'the match must not end — 3 active players remain');
    assert.equal(participantDnf(gameId, 'FP_B'), 1);
    assert.equal(participantDnf(gameId, 'FP_A'), 0);
    const g = gameRow(gameId);
    assert.equal(g.completed_at, null, 'the match keeps going, so it is not complete');
    assert.equal(g.dnf_at, null, 'the whole match is not a DNF — only FP_B is');
  });

  test('leaves exactly one active player: the match completes as a walkover win for the survivor', async () => {
    await db.addPlayer('FP_E'); await db.addPlayer('FP_F');
    const { gameId } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'FP_E' }, { name: 'FP_F' }],
    });
    const res = db.forfeitPlayer(gameId, 'FP_E');
    assert.equal(res.ended, true);
    assert.equal(res.winnerName, 'FP_F');
    const g = gameRow(gameId);
    assert.ok(g.completed_at, 'a walkover is a real completion');
    assert.equal(g.dnf_at, null, 'the game itself is not a DNF — FP_F actually won it');
    const winner = db._db.prepare("SELECT id FROM players WHERE name = 'FP_F'").get();
    assert.equal(g.winner_id, winner.id);
    assert.equal(participantDnf(gameId, 'FP_E'), 1);
    assert.equal(participantDnf(gameId, 'FP_F'), 0, 'the survivor is not a DNF, they won');
  });

  // A 2+-player match auto-completes (as a walkover) the instant it drops to exactly
  // one active participant — see the test above — so the only way to reach "zero
  // active participants left" is a solo (1-player) game's own sole participant
  // bowing out, with nobody left to inherit a walkover win.
  test('a solo game\'s only participant bows out: the match ends with no winner, marked dnf_at', async () => {
    await db.addPlayer('FP_Solo');
    const { gameId } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name: 'FP_Solo' }],
    });
    const res = db.forfeitPlayer(gameId, 'FP_Solo');
    assert.equal(res.ended, true);
    assert.equal(res.winnerName, null);
    const g = gameRow(gameId);
    assert.equal(g.completed_at, null, 'nobody actually finished it');
    assert.ok(g.dnf_at, 'the match is a DNF once its only participant has left');
    assert.equal(g.winner_id, null);
  });

  test('rejects forfeiting a non-participant, an already-departed player, or an already-ended game', async () => {
    await db.addPlayer('FP_I'); await db.addPlayer('FP_J'); await db.addPlayer('FP_K');
    const { gameId } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'FP_I' }, { name: 'FP_J' }],
    });
    assert.throws(() => db.forfeitPlayer(gameId, 'FP_K'), (err) => err.status === 400);
    db.forfeitPlayer(gameId, 'FP_I'); // leaves FP_J as sole survivor -> match completes
    assert.throws(() => db.forfeitPlayer(gameId, 'FP_J'), (err) => err.status === 409, 'game already completed');

    const { gameId: gameId2 } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'FP_I' }, { name: 'FP_J' }],
    });
    db.forfeitPlayer(gameId2, 'FP_I');
    assert.throws(() => db.forfeitPlayer(gameId2, 'FP_I'), (err) => err.status === 409, 'already departed');
  });
});

describe('abandonGame — ending the whole match early counts as a DNF', () => {
  test('marks every still-active participant DNF and sets dnf_at, never completed_at', async () => {
    await db.addPlayer('AB_A'); await db.addPlayer('AB_B');
    const { gameId } = db.createGame({
      category: '501', legsPerSet: 3, setsPerGame: 1, practice: 0,
      players: [{ name: 'AB_A' }, { name: 'AB_B' }],
    });
    db.addTurn(gameId, { player: 'AB_A', set: 1, leg: 1, scored: 140, darts: [
      { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 1 },
    ] });
    const res = db.abandonGame(gameId);
    assert.deepEqual(res, { ok: true });
    const g = gameRow(gameId);
    assert.ok(g.dnf_at);
    assert.equal(g.completed_at, null);
    assert.equal(g.winner_id, null);
    assert.equal(participantDnf(gameId, 'AB_A'), 1);
    assert.equal(participantDnf(gameId, 'AB_B'), 1);
  });

  test('a solo practice game left unfinished (no checkout) also counts as a DNF', async () => {
    await db.addPlayer('AB_Solo');
    const { gameId } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name: 'AB_Solo' }],
    });
    db.addTurn(gameId, { player: 'AB_Solo', set: 1, leg: 1, scored: 60, darts: [
      { sector: 20, multiplier: 3 },
    ] });
    db.abandonGame(gameId);
    const g = gameRow(gameId);
    assert.ok(g.dnf_at, 'never closing on a double and ending early must count as a DNF');
    assert.equal(g.completed_at, null);
    assert.equal(participantDnf(gameId, 'AB_Solo'), 1);
  });

  test('rejects abandoning an already-completed or already-abandoned game', async () => {
    await db.addPlayer('AB_C'); await db.addPlayer('AB_D');
    const { gameId } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'AB_C' }, { name: 'AB_D' }],
    });
    db.completeGame(gameId, 'AB_C');
    assert.throws(() => db.abandonGame(gameId), (err) => err.status === 409);

    const { gameId: gameId2 } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'AB_C' }, { name: 'AB_D' }],
    });
    db.abandonGame(gameId2);
    assert.throws(() => db.abandonGame(gameId2), (err) => err.status === 409);
  });

  test('dnf_at is not completed_at: an abandoned H2H match must not inflate "Games Played"', async () => {
    const before = db.getSummary().games;
    await db.addPlayer('AB_Scope1'); await db.addPlayer('AB_Scope2');
    const { gameId } = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'AB_Scope1' }, { name: 'AB_Scope2' }],
    });
    db.addTurn(gameId, { player: 'AB_Scope1', set: 1, leg: 1, scored: 180, darts: [
      { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 },
    ] });
    db.abandonGame(gameId);
    assert.equal(db.getSummary().games, before, '"Games Played" is completed_at-scoped and must stay unchanged by a DNF');
  });
});
