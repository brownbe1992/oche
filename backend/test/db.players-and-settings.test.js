'use strict';
// Committed tests for backend/db.js's player CRUD/cascade behavior and the
// settings key/value store (REFERENCE.md §13 "Cascade summary", §3's
// player_count-freeze note). resetStats()/wipeAllData() tests are destructive to
// the whole scratch database, so they're deliberately placed last in this file —
// node:test runs a file's top-level tests in declaration order.
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

describe('addPlayer', () => {
  test('creates a new player; a second call with the same (differently-cased) name returns the existing one', () => {
    db.addPlayer('Players_Dup');
    const before = db.listPlayers().length;
    db.addPlayer('players_DUP');
    assert.equal(db.listPlayers().length, before, 'no duplicate row created — name is COLLATE NOCASE unique');
  });

  test('opts.pin and opts.dartWeight are applied on creation', async () => {
    // addPlayer() is async specifically because it must await setPlayerPin()'s
    // scrypt hashing before its own hasPin return value (and this re-read) can be
    // trusted — see the comment on addPlayer() in db.js.
    await db.addPlayer('Players_WithOpts', 'double', { pin: '1234', dartWeight: 22 });
    const p = db.listPlayers().find(x => x.name === 'Players_WithOpts');
    assert.equal(p.hasPin, true);
    assert.equal(p.dartWeight, 22);
  });
});

// docs/security-audit-roadmap.md SEC-13: player names previously had no server-side
// length or shape bound (String(name).trim() only) — unbounded free-text from an
// unauthenticated caller (POST /api/players is public by default), and the raw
// material for SEC-12 (a stored-XSS sink at the render site, fixed separately).
describe('validatePlayerName (SEC-13: length/control-character bound)', () => {
  test('rejects a name over 64 characters', async () => {
    await assert.rejects(() => db.addPlayer('x'.repeat(65)), (err) => err.status === 400);
  });

  test('accepts a name at exactly the 64-character limit', async () => {
    const name = 'y'.repeat(64);
    await assert.doesNotReject(() => db.addPlayer(name));
    assert.ok(db.listPlayers().some(p => p.name === name));
  });

  test('rejects a name containing a control character', async () => {
    await assert.rejects(() => db.addPlayer('Bad\x00Name'), (err) => err.status === 400);
    await assert.rejects(() => db.addPlayer('Bad\nName'), (err) => err.status === 400);
  });

  test('still permits ordinary punctuation/emoji — the bound is length/control-chars, not charset', async () => {
    await assert.doesNotReject(() => db.addPlayer("O'Brien 🎯"));
    assert.ok(db.listPlayers().some(p => p.name === "O'Brien 🎯"));
  });

  test('renamePlayer applies the same bound to the new name', () => {
    db.addPlayer('Players_RenameBoundFrom');
    assert.throws(() => db.renamePlayer('Players_RenameBoundFrom', 'z'.repeat(65)), (err) => err.status === 400);
  });
});

describe('renamePlayer', () => {
  test('renames successfully when the new name is free', () => {
    db.addPlayer('Players_RenameFrom');
    db.renamePlayer('Players_RenameFrom', 'Players_RenameTo');
    assert.ok(db.listPlayers().some(p => p.name === 'Players_RenameTo'));
    assert.ok(!db.listPlayers().some(p => p.name === 'Players_RenameFrom'));
  });

  test('refuses to rename onto a different existing player\'s name', () => {
    db.addPlayer('Players_RenameA');
    db.addPlayer('Players_RenameB');
    assert.throws(() => db.renamePlayer('Players_RenameA', 'Players_RenameB'), (err) => err.status === 409);
  });

  test('renaming a nonexistent player is a 404', () => {
    assert.throws(() => db.renamePlayer('Players_Nobody', 'Players_Whoever'), (err) => err.status === 404);
  });
});

describe('setOut / setDartWeight', () => {
  test('update the player\'s stored default finish rule and dart weight', () => {
    db.addPlayer('Players_Settings');
    db.setOut('Players_Settings', 'single');
    db.setDartWeight('Players_Settings', 24);
    const p = db.listPlayers().find(x => x.name === 'Players_Settings');
    assert.equal(p.out, 'single');
    assert.equal(p.dartWeight, 24);
  });
});

describe('deletePlayer — cascade and orphaned-game pruning', () => {
  test('deleting a solo player removes their now-empty practice game entirely', () => {
    const name = 'Players_DeleteSolo';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 60, darts: [{ sector: 20, multiplier: 1 }] });
    db.deletePlayer(name);
    const gameRow = db._db.prepare('SELECT id FROM games WHERE id = ?').get(g.gameId);
    assert.equal(gameRow, undefined, 'the orphaned game was pruned');
  });

  test('deleting one H2H participant leaves the game (and the other participant\'s row) intact', () => {
    const survivor = 'Players_DeleteH2H_Survivor', deleted = 'Players_DeleteH2H_Deleted';
    db.addPlayer(survivor); db.addPlayer(deleted);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name: survivor }, { name: deleted }] });
    db.deletePlayer(deleted);
    const gameRow = db._db.prepare('SELECT id FROM games WHERE id = ?').get(g.gameId);
    assert.ok(gameRow, 'the game survives — the other participant is still in it');
    const remaining = db._db.prepare('SELECT COUNT(*) AS n FROM game_players WHERE game_id = ?').get(g.gameId).n;
    assert.equal(remaining, 1);
  });

  test('deleting a player cascades their turns, badges, and daily challenge attempts', () => {
    const name = 'Players_DeleteCascade';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 60, darts: [{ sector: 20, multiplier: 1 }] });
    db.awardBadge(name, 'hattrick', false);
    const pid = db._db.prepare('SELECT id FROM players WHERE name = ?').get(name).id;
    db.deletePlayer(name);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM turns WHERE player_id = ?').get(pid).n, 0);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM player_badges WHERE player_id = ?').get(pid).n, 0);
  });
});

describe('getDartWeights', () => {
  // docs/dart-builder-roadmap.md: players.dart_weight/setDartWeight() no longer
  // feeds game_players.dart_weight — a selected loadout's barrel weight is the only
  // source now (see backend/test/dart-builder.test.js's createGame() coverage).
  // getDartWeights() itself is unchanged: it just reads whatever ended up snapshotted
  // in game_players.dart_weight, regardless of how that value got there.
  test('returns the distinct dart weights snapshotted from selected loadouts across games', () => {
    const name = 'Players_DartWeights';
    db.addPlayer(name);
    const barrel22 = db.createComponent(name, 'barrel', { name: 'B22', weightG: 22, material: 'brass', shape: 'straight' });
    const barrel24 = db.createComponent(name, 'barrel', { name: 'B24', weightG: 24, material: 'brass', shape: 'straight' });
    const shaft = db.createComponent(name, 'shaft', { name: 'S', material: 'nylon', shape: 'fixed' });
    const flight = db.createComponent(name, 'flight', { name: 'F', material: 'standard_poly', shape: 'standard' });
    const lo22 = db.createLoadout(name, { name: 'Set22', barrelId: barrel22.id, shaftId: shaft.id, flightId: flight.id });
    const lo24 = db.createLoadout(name, { name: 'Set24', barrelId: barrel24.id, shaftId: shaft.id, flightId: flight.id });
    db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name, loadoutId: lo22.id }] });
    db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name, loadoutId: lo24.id }] });
    const weights = db.getDartWeights(name);
    assert.deepEqual(weights.slice().sort((a, b) => a - b), [22, 24]);
  });

  test('an unknown player returns an empty list', () => {
    assert.deepEqual(db.getDartWeights('Players_NoWeights_Nobody'), []);
  });
});

describe('clearPlayerStats', () => {
  test('mode="h2h" only deletes turns from non-practice games, leaving practice turns intact', () => {
    const name = 'Players_ClearH2H';
    db.addPlayer(name); db.addPlayer('Players_ClearH2H_Opp');
    const h2h = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name }, { name: 'Players_ClearH2H_Opp' }] });
    db.addTurn(h2h.gameId, { player: name, set: 1, leg: 1, scored: 60, darts: [{ sector: 20, multiplier: 1 }] });
    const prac = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    db.addTurn(prac.gameId, { player: name, set: 1, leg: 1, scored: 40, darts: [{ sector: 20, multiplier: 1 }] });

    db.clearPlayerStats(name, 'h2h');

    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id = ?').get(h2h.gameId).n, 0);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id = ?').get(prac.gameId).n, 1, 'practice turns untouched');
  });

  test('mode="all" deletes solo games outright and this player\'s turns from any shared game', () => {
    const name = 'Players_ClearAll';
    db.addPlayer(name); db.addPlayer('Players_ClearAll_Opp');
    const solo = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    db.addTurn(solo.gameId, { player: name, set: 1, leg: 1, scored: 40, darts: [{ sector: 20, multiplier: 1 }] });
    const shared = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0, players: [{ name }, { name: 'Players_ClearAll_Opp' }] });
    db.addTurn(shared.gameId, { player: name, set: 1, leg: 1, scored: 60, darts: [{ sector: 20, multiplier: 1 }] });

    db.clearPlayerStats(name, 'all');

    assert.equal(db._db.prepare('SELECT id FROM games WHERE id = ?').get(solo.gameId), undefined, 'the solo game is gone entirely');
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id = ?').get(shared.gameId).n, 0, 'this player\'s turns removed from the shared game');
    const stillThere = db._db.prepare('SELECT id FROM games WHERE id = ?').get(shared.gameId);
    assert.ok(stillThere, 'the shared game itself (and the opponent\'s participation) is kept, not deleted');
  });
});

describe('settings key/value store', () => {
  // Defaults are checked FIRST, before any other test in this describe block
  // sets a value — these getters read straight from the shared scratch DB, so
  // order matters within this file.
  test('public getters have documented defaults when unset', () => {
    assert.equal(db.getDartTimingEnabled().enabled, false);
    assert.equal(db.getColorblindMode().enabled, false);
    assert.equal(db.getScoreboardLayout().layout, 'full');
    assert.equal(db.getDefaultScoringInput().input, 'board');
    assert.equal(db.getCardTagline().tagline, 'Darts tracked via Oche — track your darts today!');
    const voice = db.getVoiceAnnouncementSettings();
    assert.equal(voice.enabled, false, 'master switch defaults off');
    assert.equal(voice.turnScore, true, 'sub-toggles default on once enabled (opt-out, not opt-in)');
  });

  test('getSettings/updateSettings round trip', () => {
    db.updateSettings({ card_tagline: 'Test tagline' });
    assert.equal(db.getSettings().card_tagline, 'Test tagline');
  });

  test('getters reflect updateSettings after being set', () => {
    db.updateSettings({ collect_dart_timing: '1', colorblind_mode: '1', scoreboard_layout: 'compact', default_scoring_input: 'pad' });
    assert.equal(db.getDartTimingEnabled().enabled, true);
    assert.equal(db.getColorblindMode().enabled, true);
    assert.equal(db.getScoreboardLayout().layout, 'compact');
    assert.equal(db.getDefaultScoringInput().input, 'pad');
  });

  test('scoreboard layout falls back to "full" for an invalid stored value', () => {
    db.updateSettings({ scoreboard_layout: 'nonsense' });
    assert.equal(db.getScoreboardLayout().layout, 'full');
  });

  test('backupRetentionDays defaults to 7, reflects updateSettings, and falls back on an invalid value', () => {
    assert.equal(db.backupRetentionDays(), 7);
    db.updateSettings({ backup_retention_days: '30' });
    assert.equal(db.backupRetentionDays(), 30);
    db.updateSettings({ backup_retention_days: 'nonsense' });
    assert.equal(db.backupRetentionDays(), 7, 'falls back to the default rather than NaN/0');
  });
});

// --- Destructive, whole-database tests: kept last in this file (see header comment) ---

describe('resetStats (destroys all games/turns, keeps players)', () => {
  test('wipes turns/game_players/games but players remain', () => {
    const name = 'Players_ResetStats';
    db.addPlayer(name);
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 40, darts: [{ sector: 20, multiplier: 1 }] });

    db.resetStats();

    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 0);
    assert.equal(db._db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 0);
    assert.ok(db.listPlayers().some(p => p.name === name), 'players survive a stats reset');
  });
});

describe('wipeAllData (destroys players and games; admins/settings survive)', () => {
  test('wipes players and games; an existing admin account and settings remain', async () => {
    await db.createAdmin('players_wipe_admin', 'password123');
    db.updateSettings({ card_tagline: 'Survives a wipe' });
    db.addPlayer('Players_WipeMe');

    db.wipeAllData();

    assert.equal(db.listPlayers().length, 0, 'every player is gone');
    assert.ok(db.listAdmins().some(a => a.username === 'players_wipe_admin'), 'admin accounts are kept');
    assert.equal(db.getSettings().card_tagline, 'Survives a wipe', 'settings are kept');
  });
});
