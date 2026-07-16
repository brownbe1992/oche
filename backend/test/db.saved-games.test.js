'use strict';
// Committed tests for saved games / pause & resume (docs/archive/saved-games-roadmap.md).
// The replay-rebuild math itself is proven in backend/test/scoring.test.js
// (rebuildX01State/rebuildCricketState/rebuildBaseballState/rebuildAroundTheClockState/
// rebuildAroundTheWorldState) -- this file covers the schema/endpoint layer around
// it: save/list/resume-state/abandon, the one-saved-game-per-matchup constraint,
// server-side eligibility checks, the two-device divergence guard, tournament-match
// linkage restore, the player-deletion guard, and the merge-collision block.
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

function startX01(names) {
  return db.createGame({ category: '501', legsPerSet: 3, setsPerGame: 1, practice: 0,
    players: names.map(name => ({ name })), gameType: 'x01' }).gameId;
}
function throwVisit(gameId, player, set, leg, darts, scored) {
  db.addTurn(gameId, { player, set, leg, scored, darts: darts.map(([sector, multiplier], i) => ({ dartNo: i + 1, sector, multiplier })) });
}

describe('saveGame — eligibility and the one-per-matchup constraint', () => {
  test('saves an eligible, incomplete X01 game', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    const r = db.saveGame(gameId);
    assert.equal(r.ok, true);
    assert.equal(r.alreadySaved, false);
    const saved = db.getSavedGames();
    assert.ok(saved.some(s => s.gameId === gameId));
  });

  test('saving an already-saved game is an idempotent no-op, not an error', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    db.saveGame(gameId);
    const before = db.getSavedGames().length;
    const r = db.saveGame(gameId);
    assert.equal(r.ok, true);
    assert.equal(r.alreadySaved, true);
    assert.equal(db.getSavedGames().length, before, 'no duplicate row');
  });

  test('rejects a completed game', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    db.completeGame(gameId, a);
    assert.throws(() => db.saveGame(gameId), /already complete/);
  });

  test('rejects an ineligible game type (Doubles Practice)', () => {
    const a = uniqueName('sg_dp');
    db.addPlayer(a);
    const gameId = db.createGame({ category: 'Doubles Practice (D20)', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name: a }], gameType: 'doubles_practice', config: { doubles: [20] } }).gameId;
    assert.throws(() => db.saveGame(gameId), /can't be saved/);
  });

  test('one saved game per (participant set, game type) -- a second save for the same slot is rejected', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const game1 = startX01([a, b]);
    db.saveGame(game1);
    const game2 = startX01([a, b]); // a second, independent X01 game for the exact same pair
    assert.throws(() => db.saveGame(game2), /already exists/);
  });

  test('a different game type for the same players is a different slot -- allowed', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const x01Game = startX01([a, b]);
    db.saveGame(x01Game);
    const cricketGame = db.createGame({ category: 'Cricket (15-20, Bull)', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: a }, { name: b }], gameType: 'cricket', config: { numbers: [15,16,17,18,19,20,25] } }).gameId;
    const r = db.saveGame(cricketGame);
    assert.equal(r.ok, true);
  });

  test('participant-set matching is order-independent (findSavedGameForParticipants)', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    db.saveGame(gameId);
    assert.equal(db.findSavedGameForParticipants([a, b], 'x01'), gameId);
    assert.equal(db.findSavedGameForParticipants([b, a], 'x01'), gameId, 'reversed order still matches');
    assert.equal(db.findSavedGameForParticipants([a, b], 'cricket'), null, 'different game type does not match');
  });
});

describe('getSavedGames — position summaries reuse the pure rebuild functions', () => {
  test('an X01 game\'s summary reflects real recorded turns (legsWon/score), not a stale snapshot', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    throwVisit(gameId, a, 1, 1, [[20,1],[20,1],[20,1]], 60); // a: 501-60=441
    db.saveGame(gameId);
    const row = db.getSavedGames().find(s => s.gameId === gameId);
    assert.ok(row);
    assert.equal(row.position.setNo, 1);
    assert.equal(row.position.legNo, 1);
    const aPos = row.position.players.find(p => p.name === a);
    assert.equal(aPos.score, 441);
    assert.equal(aPos.legsWon, 0);
  });
});

describe('getResumeState — the full replay payload, and the two-device divergence guard', () => {
  test('returns ordered turns with playerIndex/darts, and consumes the pause (deletes the saved_games row)', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    throwVisit(gameId, a, 1, 1, [[20,1],[20,1],[20,1]], 60);
    throwVisit(gameId, b, 1, 1, [[19,1],[19,1],[19,1]], 57);
    db.saveGame(gameId);
    assert.ok(db.getSavedGames().some(s => s.gameId === gameId));

    const state = db.getResumeState(gameId);
    assert.equal(state.gameType, 'x01');
    assert.equal(state.legsPerSet, 3);
    assert.equal(state.players.length, 2);
    assert.equal(state.turns.length, 2);
    assert.equal(state.turns[0].playerIndex, 0);
    assert.equal(state.turns[1].playerIndex, 1);
    assert.deepEqual(state.turns[0].darts, [{ sector: 20, mult: 1 }, { sector: 20, mult: 1 }, { sector: 20, mult: 1 }]);

    assert.ok(!db.getSavedGames().some(s => s.gameId === gameId), 'saved_games row consumed by the resume itself');
  });

  test('resuming never re-inserts turns/darts, and never inflates stats built from them — the replay is read-only, client and server alike', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    throwVisit(gameId, a, 1, 1, [[20,1],[20,1],[20,1]], 60);
    throwVisit(gameId, b, 1, 1, [[19,1],[19,1],[19,1]], 57);
    db.saveGame(gameId);

    const turnCount = () => db._db.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id = ?').get(gameId).n;
    const dartCount = () => db._db.prepare(`
      SELECT COUNT(*) AS n FROM darts d JOIN turns t ON t.id = d.turn_id WHERE t.game_id = ?
    `).get(gameId).n;
    const turnsBefore = turnCount(), dartsBefore = dartCount();
    const aDartsThrownBefore = db.getPlayerStatBubbles(a).dartsThrown;
    const bDartsThrownBefore = db.getPlayerStatBubbles(b).dartsThrown;
    assert.equal(turnsBefore, 2);
    assert.equal(dartsBefore, 6);

    // getResumeState() is the whole replay payload -- everything the client's
    // pure rebuildX01State() etc. (frontend/scoring.js) then replays through
    // in memory only, with zero network calls of its own (grep the file: no
    // Backend./DB./fetch( anywhere in it). Fetching it must never change a
    // single turns/darts row -- it's a read (plus the one documented
    // saved_games delete), never a write to turns/darts.
    db.getResumeState(gameId);

    assert.equal(turnCount(), turnsBefore, 'no new turn rows from resuming');
    assert.equal(dartCount(), dartsBefore, 'no new dart rows from resuming');
    assert.equal(db.getPlayerStatBubbles(a).dartsThrown, aDartsThrownBefore, "resuming must not inflate darts-thrown stats");
    assert.equal(db.getPlayerStatBubbles(b).dartsThrown, bDartsThrownBefore);

    // A genuinely NEW turn recorded after resume (exactly what the live client
    // does when the resumed player actually throws again) is the only thing
    // that should ever move these numbers, and by exactly one turn/3 darts --
    // proving the earlier replay contributed nothing of its own to add to.
    throwVisit(gameId, a, 1, 1, [[18,1],[18,1],[18,1]], 54);
    assert.equal(turnCount(), turnsBefore + 1);
    assert.equal(dartCount(), dartsBefore + 3);
    assert.equal(db.getPlayerStatBubbles(a).dartsThrown, aDartsThrownBefore + 3);
  });

  test('a second resume-state call on the same game (two devices racing) gets a clean 409, not a silent double-drive', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    db.saveGame(gameId);
    db.getResumeState(gameId); // first device resumes successfully
    assert.throws(() => db.getResumeState(gameId), /not currently saved/);
  });

  test('rejects resume-state for a game that was never saved', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    assert.throws(() => db.getResumeState(gameId), /not currently saved/);
  });

  test('rejects resume-state for a completed game', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    db.saveGame(gameId);
    db.completeGame(gameId, a);
    assert.throws(() => db.getResumeState(gameId), /already complete/);
  });

  test('restores tournament-match linkage, and a normal completion still advances the bracket afterward', () => {
    const [a, b] = [uniqueName('sg_ta'), uniqueName('sg_tb')];
    db.addPlayer(a); db.addPlayer(b);
    const { tournamentId } = db.createTournament({ name: 'Saved Cup', category: '501',
      players: [a, b], rounds: [{ legsPerSet: 1, setsPerGame: 1 }] });
    const t = db.getTournament(tournamentId);
    const matchId = t.matches[0].id;
    const { gameId } = db.startTournamentMatch(matchId);
    db.saveGame(gameId);

    // getSavedGames() surfaces the linkage too -- the client needs it BEFORE
    // resuming, to route Abandon to the bracket/walkover control instead of a
    // plain delete (docs/archive/saved-games-roadmap.md "Abandoning").
    const listRow = db.getSavedGames().find(s => s.gameId === gameId);
    assert.equal(listRow.tournamentMatchId, matchId);

    const state = db.getResumeState(gameId);
    assert.equal(state.tournamentMatchId, matchId);

    // The resumed game plays out and completes exactly like any other game --
    // the onGameCompleted hook advances the bracket regardless of the pause.
    db.completeGame(gameId, a);
    const after2 = db.getTournament(tournamentId);
    assert.equal(after2.matches[0].winnerName, a, 'the bracket recorded the resumed match\'s real winner');
    assert.equal(after2.matches[0].status, 'complete');
  });
});

describe('abandonSavedGame — deletes the pause, keeps recorded stats', () => {
  test('the game stays a permanently incomplete row, and its already-recorded turns are untouched', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    throwVisit(gameId, a, 1, 1, [[20,1],[20,1],[20,1]], 60);
    db.saveGame(gameId);
    const r = db.abandonSavedGame(gameId);
    assert.equal(r.ok, true);
    assert.ok(!db.getSavedGames().some(s => s.gameId === gameId));
    const game = db._db.prepare('SELECT completed_at FROM games WHERE id = ?').get(gameId);
    assert.equal(game.completed_at, null, 'still incomplete, not silently finished');
    const turnCount = db._db.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id = ?').get(gameId).n;
    assert.equal(turnCount, 1, 'the recorded turn survives the abandon');
  });

  test('abandoning a game with no saved row 404s', () => {
    const [a, b] = [uniqueName('sg_a'), uniqueName('sg_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    assert.throws(() => db.abandonSavedGame(gameId), /No saved game/);
  });
});

describe('player-deletion guard', () => {
  test('blocks deleting a player who is in a currently-saved game', () => {
    const [a, b] = [uniqueName('sg_del_a'), uniqueName('sg_del_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    db.saveGame(gameId);
    assert.throws(() => db.deletePlayer(a), /saved.*game/i);
    db.abandonSavedGame(gameId);
    assert.doesNotThrow(() => db.deletePlayer(a), 'deletable again once the save is gone');
  });
});

describe('merge-collision guard', () => {
  test('blocks a merge that would leave the target with two saved games in the same (participants, game type) slot', () => {
    const [source, target, third] = [uniqueName('sg_merge_src'), uniqueName('sg_merge_tgt'), uniqueName('sg_merge_third')];
    db.addPlayer(source); db.addPlayer(target); db.addPlayer(third);
    const sourceGame = startX01([source, third]);
    db.saveGame(sourceGame);
    const targetGame = startX01([target, third]);
    db.saveGame(targetGame);

    const preview = db.getMergePreview(source, target);
    assert.equal(preview.blocked, true);
    assert.equal(preview.blockers.savedGameCollisions.length, 1);
    assert.throws(() => db.mergePlayers(source, target), /saved-game slot collision/);
  });

  test('does not block when the source has no saved games at all', () => {
    const [source, target] = [uniqueName('sg_merge_src2'), uniqueName('sg_merge_tgt2')];
    db.addPlayer(source); db.addPlayer(target);
    const preview = db.getMergePreview(source, target);
    assert.equal(preview.blockers.savedGameCollisions.length, 0);
  });
});

describe('getFullDatabaseExport includes saved_games', () => {
  test('a saved game appears in the export dump', () => {
    const [a, b] = [uniqueName('sg_export_a'), uniqueName('sg_export_b')];
    db.addPlayer(a); db.addPlayer(b);
    const gameId = startX01([a, b]);
    db.saveGame(gameId);
    const dump = db.getFullDatabaseExport();
    assert.ok(Array.isArray(dump.savedGames));
    assert.ok(dump.savedGames.some(r => r.game_id === gameId));
  });
});
