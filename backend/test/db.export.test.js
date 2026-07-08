'use strict';
// Committed test for getFullDatabaseExport() (docs/data-export-roadmap.md, admin-only
// full-database export). Confirms the export contains real, correctly-counted game
// data, and — the security-sensitive part — that it never includes the admins/
// sessions/settings/server_errors tables or any player PIN/credential column, even
// though the players table itself is included.
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

describe('getFullDatabaseExport (docs/data-export-roadmap.md)', () => {
  test('includes real player/game/turn/dart data with correct shape and counts', async () => {
    db.addPlayer('export_alice');
    await db.setPlayerPin('export_alice', '1234');
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: 'export_alice' }] });
    db.addTurn(g.gameId, { player: 'export_alice', set: 1, leg: 1, scored: 60, darts: [
      { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 },
    ] });

    const dump = db.getFullDatabaseExport();

    assert.deepEqual(Object.keys(dump).sort(), [
      'dailyChallengeAttempts', 'darts', 'exportedAt', 'gamePlayers', 'games', 'players', 'playerBadges', 'timelineEvents', 'turns',
      // docs/bug-roadmap.md BUG-6: tournament tables must be exported too
      'tournaments', 'tournamentPlayers', 'tournamentRounds', 'tournamentMatches',
      // docs/archive/dart-builder-roadmap.md: same standing rule applied to loadout data
      'dartComponents', 'loadouts',
      // docs/archive/ghost-opponent-roadmap.md: same standing rule applied to ghost races
      'ghostRaces',
    ].sort());

    const alice = dump.players.find(p => p.name === 'export_alice');
    assert.ok(alice, 'exported player is present');
    assert.deepEqual(Object.keys(alice).sort(), ['created_at', 'dart_weight', 'id', 'name', 'out_mode'].sort());

    assert.equal(dump.games.length, 1);
    assert.equal(dump.turns.length, 1);
    assert.equal(dump.darts.length, 3);
  });

  test('includes tournament data (BUG-6) — a run tournament appears in the export', () => {
    db.addPlayer('export_t1'); db.addPlayer('export_t2');
    db.createTournament({ name: 'Export Cup', category: '501', players: ['export_t1', 'export_t2'],
      rounds: [{ legsPerSet: 3, setsPerGame: 1 }] });

    const dump = db.getFullDatabaseExport();
    const cup = dump.tournaments.find(t => t.name === 'Export Cup');
    assert.ok(cup, 'tournament row is exported');
    assert.equal(dump.tournamentPlayers.filter(tp => tp.tournament_id === cup.id).length, 2);
    assert.equal(dump.tournamentRounds.filter(r => r.tournament_id === cup.id).length, 1);
    assert.ok(dump.tournamentMatches.length >= 1, 'match rows exported');
  });

  test('includes dart components and loadouts (docs/archive/dart-builder-roadmap.md)', () => {
    db.addPlayer('export_loadout_owner');
    const barrel = db.createComponent('export_loadout_owner', 'barrel', { name: 'Export Barrel', weightG: 22 });
    const lo = db.createLoadout('export_loadout_owner', { name: 'Export Loadout', barrelId: barrel.id });

    const dump = db.getFullDatabaseExport();
    assert.ok(dump.dartComponents.find(c => c.id === barrel.id), 'component row is exported');
    assert.ok(dump.loadouts.find(l => l.id === lo.id), 'loadout row is exported');
  });

  test('never includes admin/session/settings/error tables or any PIN/credential column', async () => {
    await db.createAdmin('export_test_admin', 'password123');

    const dump = db.getFullDatabaseExport();
    assert.equal(dump.admins, undefined);
    assert.equal(dump.sessions, undefined);
    assert.equal(dump.settings, undefined);
    assert.equal(dump.serverErrors, undefined);

    const json = JSON.stringify(dump);
    for (const secret of ['pin_hash', 'pin_salt', 'pin_fail_count', 'pin_locked_until', 'password_hash', 'password_salt']) {
      assert.equal(json.includes(secret), false, `export must not contain "${secret}"`);
    }
  });
});
