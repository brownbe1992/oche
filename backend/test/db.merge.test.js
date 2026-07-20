'use strict';
// Committed tests for getMergePreview()/mergePlayers() (docs/archive/player-merge-roadmap.md,
// admin-only duplicate-player merge) — the roadmap doc itself flags this as exactly
// the kind of change CLAUDE.md's every-new-calculation rule was written for: a merge
// touches every table with a FK into players.id, several of them guarded by real
// uniqueness constraints, so every conflict-free reassignment AND every conflict
// policy (block vs auto-resolve) gets proven here, plus the player_uuid_aliases
// fallback importPlayerExport()'s resolveStub() must actually consult afterward.
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

const pid = name => db._db.prepare('SELECT id FROM players WHERE name = ?').get(name).id;
function soloGame(name, opts = {}) {
  const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }], ...opts });
  db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 60, darts: [
    { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 },
  ] });
  return g.gameId;
}
// A raw same-date Daily Challenge attempt (the real startChallengeAttempt() flow
// needs today's generated challenge; the merge logic only reads
// player_id/challenge_date/completed, so a direct insert against a real game row
// keeps the fixture honest where it matters).
function challengeAttempt(name, date, completed) {
  const gameId = soloGame(name);
  db._db.prepare(`INSERT INTO daily_challenge_attempts (game_id, player_id, challenge_date, format, completed)
                  VALUES (?, ?, ?, 'speed_to_zero', ?)`).run(gameId, pid(name), date, completed ? 1 : 0);
}

describe('mergePlayers — conflict-free reassignment across every FK table', () => {
  test('moves games/turns/wins/badges/challenges/equipment/ghost races and deletes the source row', () => {
    db.addPlayer('merge_src_a');
    db.addPlayer('merge_tgt_a');
    db.addPlayer('merge_opp_a');

    // Source's own H2H win vs a third player — H2H must survive under the target.
    const h2h = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'merge_src_a' }, { name: 'merge_opp_a' }] });
    db.addTurn(h2h.gameId, { player: 'merge_src_a', set: 1, leg: 1, scored: 60, darts: [
      { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 },
    ] });
    db.addTurn(h2h.gameId, { player: 'merge_opp_a', set: 1, leg: 1, scored: 26, darts: [
      { sector: 20, multiplier: 1 }, { sector: 5, multiplier: 1 }, { sector: 1, multiplier: 1 },
    ] });
    db.completeGame(h2h.gameId, 'merge_src_a');

    soloGame('merge_src_a');
    db.awardBadge('merge_src_a', 'one_eighty', false);
    challengeAttempt('merge_src_a', '2026-07-01', true);
    const barrel = db.createComponent('merge_src_a', 'barrel', { name: 'Merge Barrel', weightG: 24 });
    const lo = db.createLoadout('merge_src_a', { name: 'Merge Loadout', barrelId: barrel.id });
    const ghostSrcGame = soloGame('merge_src_a');
    const ghostRaceGame = soloGame('merge_src_a');
    db._db.prepare(`INSERT INTO ghost_races (game_id, player_id, source_game_id, source_set_no, source_leg_no, result)
                    VALUES (?, ?, ?, 1, 1, 'win')`).run(ghostRaceGame, pid('merge_src_a'), ghostSrcGame);

    const sourceId = pid('merge_src_a');
    const preview = db.getMergePreview('merge_src_a', 'merge_tgt_a');
    assert.equal(preview.blocked, false);
    assert.equal(preview.moves.games, 5, 'H2H + 4 solo games (incl. challenge/ghost fixtures)');
    assert.equal(preview.moves.gameWins, 1);
    assert.equal(preview.moves.badges, 1);
    assert.equal(preview.moves.challengeAttempts, 1);
    assert.equal(preview.moves.dartComponents, 1);
    assert.equal(preview.moves.loadouts, 1);
    assert.equal(preview.moves.ghostRaces, 1);

    const result = db.mergePlayers('merge_src_a', 'merge_tgt_a');
    assert.equal(result.ok, true);

    // Source row is gone; nothing anywhere still references its old id.
    assert.equal(db._db.prepare('SELECT COUNT(*) n FROM players WHERE name = ?').get('merge_src_a').n, 0);
    for (const [table, cols] of [
      ['game_players', ['player_id']], ['turns', ['player_id']], ['games', ['winner_id']],
      ['player_badges', ['player_id']], ['daily_challenge_attempts', ['player_id']],
      ['tournament_players', ['player_id']], ['tournament_matches', ['player1_id', 'player2_id', 'winner_id']],
      ['tournaments', ['champion_id', 'runner_up_id']],
      ['league_players', ['player_id']], ['league_fixtures', ['player1_id', 'player2_id']],
      ['dart_components', ['player_id']], ['loadouts', ['player_id']], ['ghost_races', ['player_id']],
    ]) {
      for (const col of cols) {
        assert.equal(db._db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = ?`).get(sourceId).n, 0,
          `${table}.${col} must not still reference the deleted source`);
      }
    }

    // The absorbed history is live under the target through the app's own reads.
    const rec = db.getH2HRecord('merge_tgt_a', 'merge_opp_a');
    assert.equal(rec.total, 1);
    assert.equal(rec.p1Wins, 1, "the source's H2H win now belongs to the target");
    assert.equal(db.getPlayerBadges('merge_tgt_a').length, 1);
    assert.equal(lo.id != null, true);
    assert.equal(db._db.prepare('SELECT COUNT(*) n FROM loadouts WHERE player_id = ?').get(pid('merge_tgt_a')).n, 1);
  });

  test('a wrong merge direction is impossible to trigger implicitly — same player is rejected, unknown players 404', () => {
    db.addPlayer('merge_self');
    assert.throws(() => db.mergePlayers('merge_self', 'merge_self'), /two different players/);
    assert.throws(() => db.mergePlayers('merge_self', 'merge_nobody_xyz'), /Player not found/);
    assert.throws(() => db.getMergePreview('merge_nobody_xyz', 'merge_self'), /Player not found/);
  });
});

describe('mergePlayers — blocking conflicts refuse to run and change nothing', () => {
  test('a shared game blocks the merge atomically', () => {
    db.addPlayer('merge_blk_src');
    db.addPlayer('merge_blk_tgt');
    const shared = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'merge_blk_src' }, { name: 'merge_blk_tgt' }] });
    soloGame('merge_blk_src');

    const preview = db.getMergePreview('merge_blk_src', 'merge_blk_tgt');
    assert.equal(preview.blocked, true);
    assert.equal(preview.ok, false);
    assert.equal(preview.blockers.sharedGames.length, 1);
    assert.equal(preview.blockers.sharedGames[0].id, shared.gameId);

    assert.throws(() => db.mergePlayers('merge_blk_src', 'merge_blk_tgt'), /Merge blocked: 1 shared game/);
    // Nothing changed: source still exists with their solo game intact.
    assert.equal(db._db.prepare('SELECT COUNT(*) n FROM players WHERE name = ?').get('merge_blk_src').n, 1);
    assert.equal(db._db.prepare('SELECT COUNT(*) n FROM game_players WHERE player_id = ?').get(pid('merge_blk_src')).n, 2);
  });

  test('a shared tournament enrollment blocks', () => {
    db.addPlayer('merge_t_src'); db.addPlayer('merge_t_tgt');
    db.createTournament({ name: 'Merge Cup', category: '501', players: ['merge_t_src', 'merge_t_tgt'],
      rounds: [{ legsPerSet: 1, setsPerGame: 1 }] });
    const preview = db.getMergePreview('merge_t_src', 'merge_t_tgt');
    assert.equal(preview.blocked, true);
    assert.equal(preview.blockers.sharedTournaments[0].name, 'Merge Cup');
    assert.throws(() => db.mergePlayers('merge_t_src', 'merge_t_tgt'), /shared tournament/);
  });

  test('a shared league enrollment blocks', () => {
    db.addPlayer('merge_l_src'); db.addPlayer('merge_l_tgt');
    db.createLeague({ name: 'Merge League', category: '501', players: ['merge_l_src', 'merge_l_tgt'] });
    const preview = db.getMergePreview('merge_l_src', 'merge_l_tgt');
    assert.equal(preview.blocked, true);
    assert.equal(preview.blockers.sharedLeagues[0].name, 'Merge League');
    assert.throws(() => db.mergePlayers('merge_l_src', 'merge_l_tgt'), /shared league/);
  });

  test('a same-day Daily Challenge attempt where both (or neither) completed blocks', () => {
    db.addPlayer('merge_c_src'); db.addPlayer('merge_c_tgt');
    challengeAttempt('merge_c_src', '2026-07-02', true);
    challengeAttempt('merge_c_tgt', '2026-07-02', true);
    const preview = db.getMergePreview('merge_c_src', 'merge_c_tgt');
    assert.equal(preview.blocked, true);
    assert.deepEqual(preview.blockers.ambiguousChallengeDates, ['2026-07-02']);
    assert.throws(() => db.mergePlayers('merge_c_src', 'merge_c_tgt'), /same-day Daily Challenge/);
  });
});

describe('mergePlayers — auto-resolved conflicts', () => {
  test('a badge both earned keeps MAX(count) and MIN(earned_at), never a summed/inflated count', () => {
    db.addPlayer('merge_b_src'); db.addPlayer('merge_b_tgt');
    db._db.prepare(`INSERT INTO player_badges (player_id, badge_id, count, earned_at) VALUES (?, 'hat_trick', 5, '2024-01-01 10:00:00')`).run(pid('merge_b_src'));
    db._db.prepare(`INSERT INTO player_badges (player_id, badge_id, count, earned_at) VALUES (?, 'hat_trick', 2, '2025-06-01 10:00:00')`).run(pid('merge_b_tgt'));
    db._db.prepare(`INSERT INTO player_badges (player_id, badge_id, count, earned_at) VALUES (?, 'one_eighty', 1, '2024-02-01 10:00:00')`).run(pid('merge_b_src'));

    const preview = db.getMergePreview('merge_b_src', 'merge_b_tgt');
    assert.deepEqual(preview.resolutions.sharedBadges, ['hat_trick']);

    db.mergePlayers('merge_b_src', 'merge_b_tgt');
    const rows = db._db.prepare('SELECT badge_id, count, earned_at FROM player_badges WHERE player_id = ? ORDER BY badge_id').all(pid('merge_b_tgt'));
    assert.deepEqual(rows.map(r => [r.badge_id, r.count, r.earned_at]), [
      ['hat_trick', 5, '2024-01-01 10:00:00'],   // MAX(5,2), MIN of the two earned_at
      ['one_eighty', 1, '2024-02-01 10:00:00'],  // unshared: reassigned as-is
    ]);
  });

  test('a same-day challenge pair with exactly one completed keeps the completed one — from either side', () => {
    db.addPlayer('merge_cc_src'); db.addPlayer('merge_cc_tgt');
    // Source completed, target didn't:
    challengeAttempt('merge_cc_src', '2026-07-03', true);
    challengeAttempt('merge_cc_tgt', '2026-07-03', false);
    // Target completed, source didn't:
    challengeAttempt('merge_cc_src', '2026-07-04', false);
    challengeAttempt('merge_cc_tgt', '2026-07-04', true);

    const preview = db.getMergePreview('merge_cc_src', 'merge_cc_tgt');
    assert.equal(preview.blocked, false);
    assert.deepEqual(preview.resolutions.resolvableChallengeDates, ['2026-07-03', '2026-07-04']);

    db.mergePlayers('merge_cc_src', 'merge_cc_tgt');
    const rows = db._db.prepare(
      'SELECT challenge_date AS d, completed FROM daily_challenge_attempts WHERE player_id = ? ORDER BY challenge_date'
    ).all(pid('merge_cc_tgt'));
    assert.deepEqual(rows.map(r => [r.d, r.completed]), [['2026-07-03', 1], ['2026-07-04', 1]],
      'exactly one attempt per date survives, always the completed one');
  });

  test("the target's default loadout wins — the source's default flag is cleared, not duplicated", () => {
    db.addPlayer('merge_lo_src'); db.addPlayer('merge_lo_tgt');
    const sb = db.createComponent('merge_lo_src', 'barrel', { name: 'S Barrel' });
    const tb = db.createComponent('merge_lo_tgt', 'barrel', { name: 'T Barrel' });
    const slo = db.createLoadout('merge_lo_src', { name: 'S Loadout', barrelId: sb.id });
    const tlo = db.createLoadout('merge_lo_tgt', { name: 'T Loadout', barrelId: tb.id });
    db._db.prepare('UPDATE loadouts SET is_default = 1 WHERE id IN (?, ?)').run(slo.id, tlo.id);

    db.mergePlayers('merge_lo_src', 'merge_lo_tgt');
    const defaults = db._db.prepare('SELECT id FROM loadouts WHERE player_id = ? AND is_default = 1').all(pid('merge_lo_tgt'));
    assert.deepEqual(defaults.map(r => r.id), [tlo.id], "only the target's own default survives");
    assert.equal(db._db.prepare('SELECT COUNT(*) n FROM loadouts WHERE player_id = ?').get(pid('merge_lo_tgt')).n, 2);
  });
});

describe('mergePlayers — league fixtures keep their canonical player1 < player2 ordering', () => {
  test('fixtures reassigned by a merge are re-canonicalized', () => {
    // Give the pair-to-merge fixtures in DIFFERENT leagues (a shared league blocks).
    db.addPlayer('merge_fx_low');   // will get the LOWEST id of the three
    db.addPlayer('merge_fx_src');
    db.addPlayer('merge_fx_tgt');   // highest id — reassigning src->tgt flips ordering
    db.createLeague({ name: 'FX League', category: '501', players: ['merge_fx_low', 'merge_fx_src'] });

    const srcId = pid('merge_fx_src'), tgtId = pid('merge_fx_tgt'), lowId = pid('merge_fx_low');
    assert.ok(lowId < srcId && srcId < tgtId, 'fixture ordering premise');
    const before = db._db.prepare('SELECT player1_id, player2_id FROM league_fixtures WHERE player1_id = ? OR player2_id = ?').get(lowId, srcId);
    assert.deepEqual([before.player1_id, before.player2_id], [lowId, srcId]);

    db.mergePlayers('merge_fx_src', 'merge_fx_tgt');
    const after = db._db.prepare('SELECT player1_id, player2_id FROM league_fixtures WHERE player1_id = ? OR player2_id = ?').get(lowId, tgtId);
    assert.deepEqual([after.player1_id, after.player2_id], [lowId, tgtId],
      'the pair now references the target, still in canonical low-high order');
    assert.equal(db._db.prepare('SELECT COUNT(*) n FROM league_fixtures WHERE player1_id > player2_id').get().n, 0,
      'no fixture anywhere violates the canonical ordering');
  });
});

describe('player_uuid_aliases — the merge/import interaction (docs/archive/player-merge-roadmap.md)', () => {
  test("a merged-away uuid resolves onto the survivor when an old export is imported, instead of recreating a stub", () => {
    db.addPlayer('merge_al_src');
    db.addPlayer('merge_al_tgt');
    soloGame('merge_al_src');
    // Capture the "old export from another server" BEFORE the merge deletes the row.
    const oldExport = db.getPlayerExport('merge_al_src');

    db.mergePlayers('merge_al_src', 'merge_al_tgt');
    const alias = db._db.prepare('SELECT player_id FROM player_uuid_aliases WHERE uuid = ?').get(oldExport.player.uuid);
    assert.equal(alias.player_id, pid('merge_al_tgt'), "the source's uuid now aliases the target");

    const result = db.importPlayerExport(oldExport);
    assert.equal(result.player.created, false, 'resolved via the alias — no duplicate stub recreated');
    assert.equal(result.player.name, 'merge_al_tgt', 'resolved onto the surviving player');
    assert.equal(result.gamesImported, 0, 'the game already lives under the target (same fingerprint)');
    assert.equal(result.gamesSkipped, 1);
  });

  test('a chained merge (A→B, then B→C) repoints A\'s alias to C in one hop', () => {
    db.addPlayer('merge_ch_a'); db.addPlayer('merge_ch_b'); db.addPlayer('merge_ch_c');
    const uuidA = db._db.prepare('SELECT uuid FROM players WHERE name = ?').get('merge_ch_a').uuid;
    const uuidB = db._db.prepare('SELECT uuid FROM players WHERE name = ?').get('merge_ch_b').uuid;

    db.mergePlayers('merge_ch_a', 'merge_ch_b');
    db.mergePlayers('merge_ch_b', 'merge_ch_c');

    const cId = pid('merge_ch_c');
    assert.equal(db._db.prepare('SELECT player_id FROM player_uuid_aliases WHERE uuid = ?').get(uuidA).player_id, cId,
      "A's alias followed B into C rather than dangling on B's deleted row");
    assert.equal(db._db.prepare('SELECT player_id FROM player_uuid_aliases WHERE uuid = ?').get(uuidB).player_id, cId);
  });
});

describe('mergePlayers — marathon sessions and killer configs', () => {
  test('reassigns marathon_sessions instead of cascade-deleting them, and counts them in the preview', () => {
    db.addPlayer('merge_mar_src'); db.addPlayer('merge_mar_tgt');
    const legGame = soloGame('merge_mar_src');
    // marathon_sessions.player_id is ON DELETE CASCADE with no games link — the
    // one table where a missed reassignment silently DESTROYS history via the
    // final source-player DELETE rather than stranding a row.
    db._db.prepare(`INSERT INTO marathon_sessions (player_id, duration_minutes, ended_at)
                    VALUES (?, 45, datetime('now'))`).run(pid('merge_mar_src'));
    const sessionId = db._db.prepare('SELECT id FROM marathon_sessions WHERE player_id = ?').get(pid('merge_mar_src')).id;
    db._db.prepare('INSERT INTO marathon_session_legs (session_id, game_id, leg_order) VALUES (?, ?, 1)').run(sessionId, legGame);

    const preview = db.getMergePreview('merge_mar_src', 'merge_mar_tgt');
    assert.equal(preview.moves.marathonSessions, 1, 'the preview warns about the marathon history being moved');

    db.mergePlayers('merge_mar_src', 'merge_mar_tgt');
    const s = db._db.prepare('SELECT player_id FROM marathon_sessions WHERE id = ?').get(sessionId);
    assert.ok(s, 'the session row survived the source-player delete');
    assert.equal(s.player_id, pid('merge_mar_tgt'), 'and now belongs to the target');
    assert.equal(db._db.prepare('SELECT COUNT(*) n FROM marathon_session_legs WHERE session_id = ?').get(sessionId).n, 1,
      'the session legs survived too (no cascade fired)');
  });

  test("rewrites killer configs' name-keyed number assignment to the target's name", () => {
    db.addPlayer('merge_k_src'); db.addPlayer('merge_k_tgt'); db.addPlayer('merge_k_opp');
    // games.config.numbers is keyed by player NAME; every replay path looks up
    // by CURRENT name, so an unrewritten key would zero the whole game's
    // replay-derived stats for every participant after the merge.
    const kg = db.createGame({ category: 'Killer', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'killer', config: {}, players: [{ name: 'merge_k_src' }, { name: 'merge_k_opp' }] });
    const before = JSON.parse(db._db.prepare('SELECT config FROM games WHERE id = ?').get(kg.gameId).config);
    const srcNumber = before.numbers['merge_k_src'];
    assert.ok(srcNumber != null, 'fixture sanity: the source has an assigned number');

    db.mergePlayers('merge_k_src', 'merge_k_tgt');
    const after = JSON.parse(db._db.prepare('SELECT config FROM games WHERE id = ?').get(kg.gameId).config);
    assert.equal(after.numbers['merge_k_tgt'], srcNumber, "the source's assignment now lives under the target's name");
    assert.ok(!('merge_k_src' in after.numbers), 'the orphaned old-name key is gone');
    assert.equal(after.numbers['merge_k_opp'], before.numbers['merge_k_opp'], "the opponent's key is untouched");
  });
});

describe('mergePlayers — turns.affected_player_id follows the merge', () => {
  test("killer turns that affected the source point at the target after the merge", () => {
    db.addPlayer('merge_ap_src'); db.addPlayer('merge_ap_tgt'); db.addPlayer('merge_ap_opp');
    const kg = db.createGame({ category: 'Killer', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'killer', config: {}, players: [{ name: 'merge_ap_src' }, { name: 'merge_ap_opp' }] });
    const cfg = JSON.parse(db._db.prepare('SELECT config FROM games WHERE id = ?').get(kg.gameId).config);
    // The opponent attacks the source: the turn's affected_player_id records the source.
    db.addTurn(kg.gameId, { player: 'merge_ap_opp', set: 1, leg: 1, scored: 1, bust: false, checkout: false,
      checkoutPoints: null, affectedPlayer: 'merge_ap_src',
      darts: [{ dartNo: 1, sector: cfg.numbers['merge_ap_src'], multiplier: 1 }] });
    const srcId = pid('merge_ap_src');

    db.mergePlayers('merge_ap_src', 'merge_ap_tgt');
    // affected_player_id has no FK (bare ALTER column), so a missed reassignment
    // would dangle silently at the deleted source id rather than erroring.
    assert.equal(db._db.prepare('SELECT COUNT(*) n FROM turns WHERE affected_player_id = ?').get(srcId).n, 0,
      'no turn still points at the deleted source id');
    assert.equal(db._db.prepare('SELECT COUNT(*) n FROM turns WHERE affected_player_id = ?').get(pid('merge_ap_tgt')).n, 1,
      'the attack is now attributed to the target');
  });
});
