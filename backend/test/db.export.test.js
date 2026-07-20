'use strict';
// Committed test for getFullDatabaseExport() (docs/archive/data-export-roadmap.md, admin-only
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

describe('getFullDatabaseExport (docs/archive/data-export-roadmap.md)', () => {
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
      // docs/archive/league-mode-roadmap.md: same standing rule applied to league data
      'leagues', 'leaguePlayers', 'leagueFixtures',
      // docs/archive/player-merge-roadmap.md: merged-away-uuid aliases
      'playerUuidAliases',
      // docs/archive/saved-games-roadmap.md: same standing rule applied to saved-game state
      'savedGames',
      // docs/archive/marathon-mode-roadmap.md: same standing rule — session groupings
      // (durations, leg order) can't be reconstructed from the raw leg games alone
      'marathonSessions', 'marathonSessionLegs',
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

  test('includes league data (docs/archive/league-mode-roadmap.md) — an enrolled league appears in the export', () => {
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

describe('players.uuid (docs/archive/data-export-roadmap.md — portable per-player identity)', () => {
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

describe('getPlayerExport (docs/archive/data-export-roadmap.md — per-player export)', () => {
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

    // Opponent stub: minimal shape only (id+uuid+name -- id is the SOURCE server's
    // local id, needed only to remap game_players/turns.player_id on import, never
    // a portable identity on its own), never Alaina's own out_mode/dart_weight/etc.
    assert.equal(dump.opponents.length, 1);
    assert.deepEqual(Object.keys(dump.opponents[0]).sort(), ['id', 'name', 'uuid']);
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

  // docs/bug-roadmap.md BUG-19: getPlayerExport() built one SQL bound variable per turn
  // (and per dart), so a player with more turns than SQLite's ~32k variable cap threw
  // "too many SQL variables" and 500'd. The fix batches the IN(...) reads. Rather than
  // seed 32k+ rows (slow), the export takes an injectable chunkSize so the test can
  // force the multi-batch path with a handful of rows — this fails against the pre-fix
  // single-IN code for any input that spans more than one batch.
  test('exports every game/turn/dart when the id lists span multiple query batches', () => {
    db.addPlayer('export_prolific');
    const gameIds = [];
    let expectedTurns = 0;
    for (let i = 0; i < 5; i++) {
      const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: 'export_prolific' }] });
      gameIds.push(g.gameId);
      for (let j = 0; j < 3; j++) {
        db.addTurn(g.gameId, { player: 'export_prolific', set: 1, leg: 1, scored: 20, darts: [{ sector: 20, multiplier: 1 }] });
        expectedTurns++;
      }
    }
    // chunkSize:2 forces games (5 ids), turns, and darts (15 ids) to each span several
    // batches — the exact condition the pre-fix single-IN code got right only by luck
    // of never having enough rows.
    const dump = db.getPlayerExport('export_prolific', 2);
    assert.equal(dump.games.length, gameIds.length);
    assert.equal(dump.turns.length, expectedTurns);
    assert.equal(dump.darts.length, expectedTurns); // one dart per turn above
    // And the default (no chunkSize) still returns the identical, complete set.
    const dflt = db.getPlayerExport('export_prolific');
    assert.equal(dflt.turns.length, expectedTurns);
    assert.equal(dflt.darts.length, expectedTurns);
  });
});

describe('importPlayerExport (docs/archive/data-export-roadmap.md — the export/import round trip)', () => {
  test('rejects a malformed or wrong-schemaVersion payload', () => {
    assert.throws(() => db.importPlayerExport(null), /Invalid import file/);
    assert.throws(() => db.importPlayerExport({ schemaVersion: 2, player: {}, games: [], gamePlayers: [], turns: [], darts: [], opponents: [] }), /Unsupported schemaVersion/);
    assert.throws(() => db.importPlayerExport({ schemaVersion: 1 }), /Malformed import file/);
  });

  test('imports a fresh player + opponent (simulating a different server) and reconstructs H2H correctly', () => {
    db.addPlayer('import_src_carl');
    db.addPlayer('import_src_dana');
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'import_src_carl' }, { name: 'import_src_dana' }] });
    db.addTurn(g.gameId, { player: 'import_src_carl', set: 1, leg: 1, scored: 100, darts: [
      { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 },
    ] });
    db.addTurn(g.gameId, { player: 'import_src_dana', set: 1, leg: 1, scored: 60, darts: [
      { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 },
    ] });
    db.completeGame(g.gameId, 'import_src_carl');

    // A real, structurally-valid export from local data -- then swap in uuids/names
    // no local player currently has, to simulate this payload having genuinely come
    // from a different, unconnected server (so the importer must create fresh rows,
    // not match anything that happens to already exist).
    const exported = db.getPlayerExport('import_src_carl');
    exported.player.uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    exported.player.name = 'import_fresh_carl';
    exported.opponents[0].uuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    exported.opponents[0].name = 'import_fresh_dana';

    const result = db.importPlayerExport(exported);
    assert.equal(result.player.created, true);
    assert.equal(result.player.renamed, false);
    assert.equal(result.player.name, 'import_fresh_carl');
    assert.equal(result.opponents[0].created, true);
    assert.equal(result.gamesImported, 1);
    assert.equal(result.gamesSkipped, 0);
    assert.equal(result.turnsImported, 2);
    assert.equal(result.dartsImported, 6);

    // H2H is reconstructable on the target using the app's normal live computation --
    // exactly the property this whole design exists to preserve.
    const rec = db.getH2HRecord('import_fresh_carl', 'import_fresh_dana');
    assert.equal(rec.total, 1);
    assert.equal(rec.p1Wins, 1); // carl (p1) won

    // Re-importing the SAME payload is a safe no-op: both players already resolve
    // by uuid, and the one game already exists locally (same fingerprint), so
    // nothing new is created and nothing is double-counted.
    const again = db.importPlayerExport(exported);
    assert.equal(again.player.created, false);
    assert.equal(again.opponents[0].created, false);
    assert.equal(again.gamesImported, 0);
    assert.equal(again.gamesSkipped, 1);
    assert.equal(again.turnsImported, 0, 'a skipped duplicate game must not re-insert its turns');
    assert.equal(again.dartsImported, 0, 'a skipped duplicate game must not re-insert its darts');
    const recAfterReimport = db.getH2HRecord('import_fresh_carl', 'import_fresh_dana');
    assert.equal(recAfterReimport.total, 1, 're-import must not double the H2H record');

    // H2H is derived from game count alone, so it can't catch doubled turns/darts
    // sitting underneath the one (correctly deduped) game row -- check row counts
    // directly against the local game.
    const localGameId = db._db.prepare(
      `SELECT gp.game_id AS id FROM game_players gp JOIN players p ON p.id = gp.player_id WHERE p.name = ? LIMIT 1`
    ).get('import_fresh_carl').id;
    const turnCount = db._db.prepare('SELECT COUNT(*) n FROM turns WHERE game_id = ?').get(localGameId).n;
    const dartCount = db._db.prepare(
      'SELECT COUNT(*) n FROM darts d JOIN turns t ON t.id = d.turn_id WHERE t.game_id = ?'
    ).get(localGameId).n;
    assert.equal(turnCount, 2, 're-import must not duplicate turns under the existing game');
    assert.equal(dartCount, 6, 're-import must not duplicate darts under the existing game');
  });

  test('a name collision with a different uuid is uniquified, not silently merged onto the unrelated local player', () => {
    db.addPlayer('import_collide_eve');

    const payload = {
      exportedAt: new Date().toISOString(), schemaVersion: 1,
      player: { id: 9001, uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'import_collide_eve', outMode: 'double', dartWeight: null, createdAt: new Date().toISOString() },
      games: [], gamePlayers: [], turns: [], darts: [], opponents: [], playerBadges: [],
    };
    const result = db.importPlayerExport(payload);
    assert.equal(result.player.created, true);
    assert.equal(result.player.renamed, true);
    assert.equal(result.player.name, 'import_collide_eve (2)');

    // The original local player is untouched -- still their own distinct row.
    const original = db._db.prepare('SELECT id FROM players WHERE name = ?').get('import_collide_eve');
    const imported = db._db.prepare('SELECT id FROM players WHERE name = ?').get('import_collide_eve (2)');
    assert.notEqual(original.id, imported.id);
  });

  test('an opponent stub is upgraded in place when their own full export is imported later, without duplicating the shared game', () => {
    db.addPlayer('import_src_frank');
    db.addPlayer('import_src_grace');
    const shared = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'import_src_frank' }, { name: 'import_src_grace' }] });
    db.addTurn(shared.gameId, { player: 'import_src_frank', set: 1, leg: 1, scored: 60, darts: [
      { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 },
    ] });
    db.addTurn(shared.gameId, { player: 'import_src_grace', set: 1, leg: 1, scored: 45, darts: [
      { sector: 15, multiplier: 1 }, { sector: 15, multiplier: 1 }, { sector: 15, multiplier: 1 },
    ] });
    db.completeGame(shared.gameId, 'import_src_frank');

    // Grace also has her own unrelated solo game on the source server -- not part
    // of Frank's export, since an opponent stub never carries their other games.
    const graceSolo = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name: 'import_src_grace' }] });
    db.addTurn(graceSolo.gameId, { player: 'import_src_grace', set: 1, leg: 1, scored: 26, darts: [
      { sector: 20, multiplier: 1 }, { sector: 3, multiplier: 1 }, { sector: 3, multiplier: 1 },
    ] });

    const frankUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const graceUuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

    const frankExport = db.getPlayerExport('import_src_frank');
    frankExport.player.uuid = frankUuid; frankExport.player.name = 'import_target_frank';
    frankExport.opponents[0].uuid = graceUuid; frankExport.opponents[0].name = 'import_target_grace';
    const r1 = db.importPlayerExport(frankExport);
    assert.equal(r1.gamesImported, 1); // just the shared game
    const graceStubId = db._db.prepare('SELECT id FROM players WHERE uuid = ?').get(graceUuid).id;

    const graceExport = db.getPlayerExport('import_src_grace');
    graceExport.player.uuid = graceUuid; graceExport.player.name = 'import_target_grace_full';
    graceExport.opponents[0].uuid = frankUuid; graceExport.opponents[0].name = 'import_target_frank';
    const r2 = db.importPlayerExport(graceExport);

    assert.equal(r2.player.created, false, "Grace's stub row is reused, not duplicated");
    const graceIdAfter = db._db.prepare('SELECT id FROM players WHERE uuid = ?').get(graceUuid).id;
    assert.equal(graceIdAfter, graceStubId, 'same row as the stub created during step 1');
    assert.equal(r2.gamesImported, 1, "only Grace's own solo game is new -- the shared game is a duplicate");
    assert.equal(r2.gamesSkipped, 1);

    const totalGraceGames = db._db.prepare('SELECT COUNT(*) n FROM game_players WHERE player_id = ?').get(graceIdAfter).n;
    assert.equal(totalGraceGames, 2, "Grace's single row now has both the shared game and her own solo game");
  });
});

// Killer configs key number assignments by player NAME. resolveStub() can
// attach an imported game to a local player whose name differs from the
// export's (uuid match onto a renamed row, merge-survivor alias, collision
// uniquify) — the import must re-key config.numbers to the RESOLVED local
// name, the import-path twin of _rewriteKillerConfigNames(), or the whole
// game replays inert (no participant claims the assigned number).
describe('importPlayerExport — killer config keys follow resolved local names', () => {
  test('a uuid-matched player renamed locally gets their config key re-mapped', () => {
    db.addPlayer('exp_kcfg_a'); db.addPlayer('exp_kcfg_b');
    const kg = db.createGame({ category: 'Killer', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'killer', config: {}, players: [{ name: 'exp_kcfg_a' }, { name: 'exp_kcfg_b' }] });
    const before = JSON.parse(db._db.prepare('SELECT config FROM games WHERE id = ?').get(kg.gameId).config);
    const numA = before.numbers['exp_kcfg_a'];
    db.addTurn(kg.gameId, { player: 'exp_kcfg_a', set: 1, leg: 1, scored: 1, bust: false, checkout: false,
      checkoutPoints: null, affectedPlayer: 'exp_kcfg_a', darts: [{ dartNo: 1, sector: numA, multiplier: 1 }] });
    db.completeGame(kg.gameId, 'exp_kcfg_a');

    const exportPayload = db.getPlayerExport('exp_kcfg_a');
    // Simulate the divergence: the local player is renamed AFTER the export was
    // written, and the local copy of the game is gone (so the duplicate guard
    // doesn't skip the insert — e.g. restoring onto a partially-wiped server).
    db.renamePlayer('exp_kcfg_a', 'exp_kcfg_a2');
    db._db.prepare('DELETE FROM games WHERE id = ?').run(kg.gameId);

    const result = db.importPlayerExport(exportPayload);
    assert.equal(result.player.name, 'exp_kcfg_a2', 'resolved via uuid onto the renamed row');
    assert.equal(result.gamesImported, 1);

    const imported = db._db.prepare(
      `SELECT g.config FROM games g WHERE g.game_type='killer' ORDER BY g.id DESC LIMIT 1`).get();
    const cfg = JSON.parse(imported.config);
    assert.equal(cfg.numbers['exp_kcfg_a2'], numA, "the assignment now keys the RESOLVED local name");
    assert.ok(!('exp_kcfg_a' in cfg.numbers), 'the export-name key is gone');
  });
});
