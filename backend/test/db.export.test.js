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
      // docs/league-mode-roadmap.md: same standing rule applied to league data
      'leagues', 'leaguePlayers',
    ].sort());

    const alice = dump.players.find(p => p.name === 'export_alice');
    assert.ok(alice, 'exported player is present');
    assert.deepEqual(Object.keys(alice).sort(), ['created_at', 'dart_weight', 'id', 'name', 'out_mode', 'uuid'].sort());

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

  test('includes league data (docs/league-mode-roadmap.md) — an enrolled league appears in the export', () => {
    db.addPlayer('export_l1'); db.addPlayer('export_l2');
    const { leagueId } = db.createLeague({ name: 'Export League', category: '501', players: ['export_l1', 'export_l2'] });

    const dump = db.getFullDatabaseExport();
    const league = dump.leagues.find(l => l.id === leagueId);
    assert.ok(league, 'league row is exported');
    assert.equal(league.name, 'Export League');
    assert.equal(dump.leaguePlayers.filter(lp => lp.league_id === leagueId).length, 2);
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

describe('players.uuid (docs/data-export-roadmap.md — portable per-player identity)', () => {
  test('every player gets a well-formed, unique uuid at creation', () => {
    db.addPlayer('export_uuid_a');
    db.addPlayer('export_uuid_b');
    const dump = db.getFullDatabaseExport();
    const a = dump.players.find(p => p.name === 'export_uuid_a');
    const b = dump.players.find(p => p.name === 'export_uuid_b');
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.match(a.uuid, uuidRe);
    assert.match(b.uuid, uuidRe);
    assert.notEqual(a.uuid, b.uuid);
  });
});

describe('getPlayerExport (docs/data-export-roadmap.md — per-player export)', () => {
  test('scopes games/turns/darts to the requested player, includes a minimal opponent stub, and excludes the opponent\'s unrelated games', () => {
    db.addPlayer('export_ben');
    db.addPlayer('export_alaina');

    // H2H game: Ben vs Alaina, Ben wins.
    const h2h = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'export_ben' }, { name: 'export_alaina' }] });
    db.addTurn(h2h.gameId, { player: 'export_ben', set: 1, leg: 1, scored: 60, darts: [
      { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 },
    ] });
    db.addTurn(h2h.gameId, { player: 'export_alaina', set: 1, leg: 1, scored: 45, darts: [
      { sector: 15, multiplier: 1 }, { sector: 15, multiplier: 1 }, { sector: 15, multiplier: 1 },
    ] });
    db.completeGame(h2h.gameId, 'export_ben');

    // Ben's own solo practice game -- should also be included.
    const solo = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name: 'export_ben' }] });
    db.addTurn(solo.gameId, { player: 'export_ben', set: 1, leg: 1, scored: 100, darts: [
      { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 },
    ] });

    // Alaina's unrelated solo game -- must NOT leak into Ben's export.
    const alainaSolo = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name: 'export_alaina' }] });
    db.addTurn(alainaSolo.gameId, { player: 'export_alaina', set: 1, leg: 1, scored: 26, darts: [
      { sector: 20, multiplier: 1 }, { sector: 3, multiplier: 1 }, { sector: 3, multiplier: 1 },
    ] });

    const dump = db.getPlayerExport('export_ben');

    assert.equal(dump.schemaVersion, 1);
    assert.equal(dump.player.name, 'export_ben');
    assert.ok(dump.player.uuid);
    assert.equal(dump.player.dartWeight, null);

    assert.deepEqual(dump.games.map(g => g.id).sort((a, b) => a - b), [h2h.gameId, solo.gameId].sort((a, b) => a - b));
    assert.equal(dump.games.some(g => g.id === alainaSolo.gameId), false, "Alaina's unrelated solo game must not appear");

    // Opponent stub: minimal shape only (uuid+name), never Alaina's own id/out_mode/etc.
    assert.equal(dump.opponents.length, 1);
    assert.deepEqual(Object.keys(dump.opponents[0]).sort(), ['name', 'uuid']);
    assert.equal(dump.opponents[0].name, 'export_alaina');

    // turns: Ben's turn in both games (2) + Alaina's turn in the shared H2H game (1) = 3.
    // Alaina's solo-game turn must not appear.
    assert.equal(dump.turns.length, 3);
    assert.equal(dump.turns.filter(t => t.game_id === alainaSolo.gameId).length, 0);

    // darts follow turns 1:1 here (3 darts per turn) -> 9.
    assert.equal(dump.darts.length, 9);

    // gamePlayers: 2 rows for the H2H game (both players) + 1 for Ben's solo game = 3.
    assert.equal(dump.gamePlayers.length, 3);
  });

  test('throws a 404 for an unknown player name', () => {
    assert.throws(() => db.getPlayerExport('export_does_not_exist_xyz'), /Player not found/);
  });

  test('scopes badges to the requested player only', () => {
    db.addPlayer('export_badge_owner');
    db.addPlayer('export_badge_other');
    db._db.prepare("INSERT INTO player_badges (player_id, badge_id) VALUES ((SELECT id FROM players WHERE name=?), ?)").run('export_badge_owner', 'oneEighty');
    db._db.prepare("INSERT INTO player_badges (player_id, badge_id) VALUES ((SELECT id FROM players WHERE name=?), ?)").run('export_badge_other', 'oneEighty');

    const dump = db.getPlayerExport('export_badge_owner');
    assert.equal(dump.playerBadges.length, 1);
    assert.equal(dump.playerBadges[0].badge_id, 'oneEighty');
  });

  test('a player with no games exports empty arrays, not an error', () => {
    db.addPlayer('export_no_games');
    const dump = db.getPlayerExport('export_no_games');
    assert.deepEqual(dump.games, []);
    assert.deepEqual(dump.gamePlayers, []);
    assert.deepEqual(dump.turns, []);
    assert.deepEqual(dump.darts, []);
    assert.deepEqual(dump.opponents, []);
  });
});
