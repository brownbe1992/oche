'use strict';
// Committed tests for backend/db.js's Just Chuckin' It stat formulas
// (docs/archive/game-modes-roadmap.md "Just Chuckin' It", REFERENCE.md §3) against a
// scratch SQLite database. Mirrors db.doubles-practice-stats.test.js's
// structure and its X01/Cricket-isolation regression-check pattern, extended
// to the fourth game_type. Not exhaustive; see db.x01-stats.test.js's header
// comment for the same "focused, not 100% coverage" framing.
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

function chuckinGame(playerName) {
  return db.createGame({
    category: `Just Chuckin' It`,
    legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'chuckin', config: {},
    players: [{ name: playerName }],
  });
}
// Every dart is its own 1-dart turn, matching throwDartChuckin()'s shape — a
// whole session shares set_no=1/leg_no=1 (no round/leg concept in this mode).
function chuckinDart(gameId, player, [sector, mult]) {
  db.addTurn(gameId, {
    player, set: 1, leg: 1, scored: 0, bust: false, checkout: false, checkoutPoints: null, legWon: false,
    darts: [{ dartNo: 1, sector, multiplier: mult }],
  });
}

describe('getChuckinStatBubbles', () => {
  test('dartsThrown, trebles/bulls/doubles counts and their percentages', () => {
    const name = 'Chuckin_Bubbles_A';
    db.addPlayer(name);
    const g = chuckinGame(name);
    chuckinDart(g.gameId, name, [20, 3]); // treble
    chuckinDart(g.gameId, name, [20, 3]); // treble
    chuckinDart(g.gameId, name, [5, 1]);  // single
    chuckinDart(g.gameId, name, [25, 2]); // double bull
    chuckinDart(g.gameId, name, [19, 2]); // double 19

    const bubbles = db.getChuckinStatBubbles(name, 'practice');
    assert.equal(bubbles.dartsThrown, 5);
    assert.equal(bubbles.trebles, 2);
    assert.equal(bubbles.treblePct, 40, '2/5 * 100');
    assert.equal(bubbles.bulls, 1, 'sector 25 at any multiplier counts as a bull dart');
    assert.equal(bubbles.bullPct, 20, '1/5 * 100');
    assert.equal(bubbles.doubles, 2, 'double bull + double 19');
    assert.equal(bubbles.doublePct, 40, '2/5 * 100');
  });

  test('sessionsPlayed counts distinct games, avgDartsPerSession averages across them', () => {
    const name = 'Chuckin_Sessions_A';
    db.addPlayer(name);
    const g1 = chuckinGame(name);
    chuckinDart(g1.gameId, name, [1, 1]);
    chuckinDart(g1.gameId, name, [1, 1]);
    chuckinDart(g1.gameId, name, [1, 1]); // session 1: 3 darts
    const g2 = chuckinGame(name);
    chuckinDart(g2.gameId, name, [1, 1]); // session 2: 1 dart

    const bubbles = db.getChuckinStatBubbles(name, 'practice');
    assert.equal(bubbles.sessionsPlayed, 2);
    assert.equal(bubbles.dartsThrown, 4);
    assert.equal(bubbles.avgDartsPerSession, 2, '(3+1)/2 sessions');
  });

  test('no darts thrown yet returns zero counts and null percentages/averages, not NaN/errors', () => {
    const name = 'Chuckin_Empty';
    db.addPlayer(name);
    const bubbles = db.getChuckinStatBubbles(name, 'practice');
    assert.equal(bubbles.dartsThrown, 0);
    assert.equal(bubbles.trebles, 0);
    assert.equal(bubbles.treblePct, null);
    assert.equal(bubbles.bullPct, null);
    assert.equal(bubbles.doublePct, null);
    assert.equal(bubbles.sessionsPlayed, 0);
    assert.equal(bubbles.avgDartsPerSession, null);
    assert.equal(bubbles.avg, null);
    assert.equal(bubbles.oneEighties, 0);
  });

  test('avg is the standard 3-dart average (total score / darts * 3), including a trailing partial group', () => {
    const name = 'Chuckin_Avg';
    db.addPlayer(name);
    const g = chuckinGame(name);
    chuckinDart(g.gameId, name, [20, 3]); // 60
    chuckinDart(g.gameId, name, [20, 3]); // 60
    chuckinDart(g.gameId, name, [20, 3]); // 60
    chuckinDart(g.gameId, name, [5, 1]);  // 5 -- a trailing 4th dart, no full group of 3
    chuckinDart(g.gameId, name, [5, 1]);  // 5

    const bubbles = db.getChuckinStatBubbles(name, 'practice');
    assert.equal(bubbles.avg, (60 * 3 + 5 + 5) / 5 * 3, 'total score / darts thrown * 3, same formula as X01');
  });

  test('oneEighties counts only complete, in-order 3-dart groups summing to exactly 180', () => {
    const name = 'Chuckin_180';
    db.addPlayer(name);
    const g = chuckinGame(name);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 3]); // group 1: 180 -- counts
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 1]); // group 2: 60+60+20=140 -- does not count
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 3]); // trailing partial group of 2 -- not evaluated yet

    const bubbles = db.getChuckinStatBubbles(name, 'practice');
    assert.equal(bubbles.oneEighties, 1);
  });

  test('a 180 group never spans two different sessions, even if darts land at the boundary', () => {
    const name = 'Chuckin_180_SessionBoundary';
    db.addPlayer(name);
    const g1 = chuckinGame(name);
    chuckinDart(g1.gameId, name, [20, 3]);
    chuckinDart(g1.gameId, name, [20, 3]); // session 1 ends with a partial 2-dart group
    const g2 = chuckinGame(name);
    chuckinDart(g2.gameId, name, [20, 3]); // if this wrongly completed session 1's group, oneEighties would be 1

    const bubbles = db.getChuckinStatBubbles(name, 'practice');
    assert.equal(bubbles.oneEighties, 0, 'session 1 has only 2 darts, session 2 has only 1 -- no session has a complete 180');

    chuckinDart(g2.gameId, name, [20, 3]);
    chuckinDart(g2.gameId, name, [20, 3]); // completes session 2's own group of 3
    const bubbles2 = db.getChuckinStatBubbles(name, 'practice');
    assert.equal(bubbles2.oneEighties, 1, 'session 2 now has its own complete 180, entirely within itself');
  });
});

describe('getChuckinPersonalBests', () => {
  test('bestSessionDarts and bestSessionTrebles track the single best session, not the average', () => {
    const name = 'Chuckin_PB_A';
    db.addPlayer(name);
    const g1 = chuckinGame(name);
    chuckinDart(g1.gameId, name, [20, 3]);
    chuckinDart(g1.gameId, name, [20, 3]); // session 1: 2 darts, 2 trebles
    const g2 = chuckinGame(name);
    chuckinDart(g2.gameId, name, [20, 3]);
    chuckinDart(g2.gameId, name, [1, 1]);
    chuckinDart(g2.gameId, name, [1, 1]);
    chuckinDart(g2.gameId, name, [1, 1]); // session 2: 4 darts (the best), 1 treble

    const pb = db.getChuckinPersonalBests(name, 'practice');
    assert.equal(pb.bestSessionDarts, 4, 'session 2 (4 darts) beats session 1 (2 darts)');
    assert.equal(pb.bestSessionTrebles, 2, 'session 1\'s 2 trebles beats session 2\'s 1');
  });

  test('no sessions recorded yet returns nulls', () => {
    const name = 'Chuckin_PB_Empty';
    db.addPlayer(name);
    const pb = db.getChuckinPersonalBests(name, 'practice');
    assert.equal(pb.bestSessionDarts, null);
    assert.equal(pb.bestSessionTrebles, null);
  });
});

describe('getChuckinHeatmap', () => {
  test('groups hit counts by (sector, multiplier)', () => {
    const name = 'Chuckin_Heatmap_A';
    db.addPlayer(name);
    const g = chuckinGame(name);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 1]);
    chuckinDart(g.gameId, name, [5, 1]);

    const cells = db.getChuckinHeatmap(name, 'practice');
    const t20 = cells.find(c => c.sector === 20 && c.multiplier === 3);
    const s20 = cells.find(c => c.sector === 20 && c.multiplier === 1);
    const s5  = cells.find(c => c.sector === 5 && c.multiplier === 1);
    assert.equal(t20.hits, 2);
    assert.equal(s20.hits, 1);
    assert.equal(s5.hits, 1);
  });

  test('no darts thrown yet returns an empty array', () => {
    const name = 'Chuckin_Heatmap_Empty';
    db.addPlayer(name);
    assert.deepEqual(db.getChuckinHeatmap(name, 'practice'), []);
  });
});

// docs/archive/dartboard-zone-tracking-roadmap.md "Beyond Just Chuckin' It": getChuckinHeatmap()
// generalized to getDartHeatmap(playerName, gameType, mode), plus zone/miss_zone/
// miss_depth grouping. Chuckin is still the game type exercised here (matching the
// rest of this file's fixtures) — X01/Cricket isolation is what genuinely needs its
// own scratch data, covered below.
describe('getDartHeatmap — zone-scoped grouping', () => {
  test('an inner-zone single and an outer-zone single for the same sector land in separate rows', () => {
    const name = 'Heatmap_Zone_A';
    db.addPlayer(name);
    const g = chuckinGame(name);
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 20, multiplier: 1, zone: 'inner' }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 20, multiplier: 1, zone: 'inner' }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 20, multiplier: 1, zone: 'outer' }] });

    const cells = db.getDartHeatmap(name, 'chuckin', 'practice');
    const inner = cells.find(c => c.sector === 20 && c.multiplier === 1 && c.zone === 'inner');
    const outer = cells.find(c => c.sector === 20 && c.multiplier === 1 && c.zone === 'outer');
    assert.equal(inner.hits, 2);
    assert.equal(outer.hits, 1);
  });

  test('a NULL-zone single (Pad mode) is counted separately from both inner and outer', () => {
    const name = 'Heatmap_Zone_B';
    db.addPlayer(name);
    const g = chuckinGame(name);
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 20, multiplier: 1, zone: 'inner' }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 20, multiplier: 1 }] }); // no zone at all
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 20, multiplier: 1 }] });

    const cells = db.getDartHeatmap(name, 'chuckin', 'practice');
    const inner = cells.find(c => c.sector === 20 && c.multiplier === 1 && c.zone === 'inner');
    const unspec = cells.find(c => c.sector === 20 && c.multiplier === 1 && c.zone == null);
    assert.equal(inner.hits, 1);
    assert.equal(unspec.hits, 2);
  });

  test('a treble/double/bull never carries a zone — grouped as a single (zone=null) row same as before', () => {
    const name = 'Heatmap_Zone_NoZoneShapes';
    db.addPlayer(name);
    const g = chuckinGame(name);
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 20, multiplier: 3 }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 20, multiplier: 2 }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 25, multiplier: 2 }] });

    const cells = db.getDartHeatmap(name, 'chuckin', 'practice');
    assert.equal(cells.find(c => c.sector === 20 && c.multiplier === 3).zone, null);
    assert.equal(cells.find(c => c.sector === 20 && c.multiplier === 2).zone, null);
    assert.equal(cells.find(c => c.sector === 25 && c.multiplier === 2).zone, null);
  });

  test('positioned misses bucket by (miss_zone, miss_depth); a near-miss and a far-miss near the same wedge are separate rows, distinct from a near-miss near a different wedge', () => {
    const name = 'Heatmap_MissZone';
    db.addPlayer(name);
    const g = chuckinGame(name);
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 0, multiplier: 1, missZone: 20, missDepth: 'near' }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 0, multiplier: 1, missZone: 20, missDepth: 'near' }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 0, multiplier: 1, missZone: 20, missDepth: 'far' }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 0, multiplier: 1, missZone: 5, missDepth: 'near' }] });
    // An unpositioned miss (Pad mode) — no missZone/missDepth at all.
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 0, multiplier: 1 }] });

    const cells = db.getDartHeatmap(name, 'chuckin', 'practice');
    const near20 = cells.find(c => c.sector === 0 && c.missZone === 20 && c.missDepth === 'near');
    const far20  = cells.find(c => c.sector === 0 && c.missZone === 20 && c.missDepth === 'far');
    const near5  = cells.find(c => c.sector === 0 && c.missZone === 5 && c.missDepth === 'near');
    const unpositioned = cells.find(c => c.sector === 0 && c.missZone == null);
    assert.equal(near20.hits, 2);
    assert.equal(far20.hits, 1);
    assert.equal(near5.hits, 1);
    assert.equal(unpositioned.hits, 1);
  });

  test('scoping by gameType isolates an X01 dart from a Cricket dart from the same player', () => {
    const name = 'Heatmap_GameTypeScope';
    db.addPlayer(name);
    const gx = db.createGame({ category: '501', legsPerSet: 3, setsPerGame: 1, practice: 1, gameType: 'x01', players: [{ name }] });
    const gc = db.createGame({ category: 'Cricket', legsPerSet: 3, setsPerGame: 1, practice: 1, gameType: 'cricket', config: { numbers: [15, 16, 17, 18, 19, 20, 25] }, players: [{ name }] });
    db.addTurn(gx.gameId, { player: name, set: 1, leg: 1, scored: 20, darts: [{ dartNo: 1, sector: 20, multiplier: 1, zone: 'inner' }] });
    db.addTurn(gc.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 20, multiplier: 1, zone: 'outer' }] });

    const x01Cells = db.getDartHeatmap(name, 'x01', null);
    const cricketCells = db.getDartHeatmap(name, 'cricket', null);
    assert.ok(x01Cells.some(c => c.zone === 'inner'), 'the X01 dart is visible under gameType=x01');
    assert.ok(!x01Cells.some(c => c.zone === 'outer'), 'the Cricket dart does not leak into gameType=x01');
    assert.ok(cricketCells.some(c => c.zone === 'outer'), 'the Cricket dart is visible under gameType=cricket');
    assert.ok(!cricketCells.some(c => c.zone === 'inner'), 'the X01 dart does not leak into gameType=cricket');
  });

  test('getChuckinHeatmap(name, mode) returns byte-identical results to getDartHeatmap(name, "chuckin", mode) — a regression guard through the generalization', () => {
    const name = 'Heatmap_Regression';
    db.addPlayer(name);
    const g = chuckinGame(name);
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 20, multiplier: 1, zone: 'inner' }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 20, multiplier: 3 }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 0, multiplier: 1, missZone: 5, missDepth: 'far' }] });

    assert.deepEqual(db.getChuckinHeatmap(name, 'practice'), db.getDartHeatmap(name, 'chuckin', 'practice'));
  });
});

describe('getBounceOutCount', () => {
  test('isolates bounced=1 rows per player/gameType/mode', () => {
    const name = 'BounceOut_A';
    db.addPlayer(name);
    const g = chuckinGame(name);
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 0, multiplier: 1, bounced: true }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 0, multiplier: 1, bounced: true }] });
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 0, multiplier: 1 }] }); // plain miss, not bounced
    db.addTurn(g.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 20, multiplier: 1, zone: 'inner' }] }); // a hit, irrelevant

    assert.equal(db.getBounceOutCount(name, 'chuckin', 'practice'), 2);
  });

  test('a bounce-out in one game type does not count toward another', () => {
    const name = 'BounceOut_GameTypeScope';
    db.addPlayer(name);
    const gx = db.createGame({ category: '501', legsPerSet: 3, setsPerGame: 1, practice: 1, gameType: 'x01', players: [{ name }] });
    db.addTurn(gx.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [{ dartNo: 1, sector: 0, multiplier: 1, bounced: true }] });
    assert.equal(db.getBounceOutCount(name, 'x01', null), 1);
    assert.equal(db.getBounceOutCount(name, 'cricket', null), 0);
  });

  test('no bounce-outs yet returns 0', () => {
    const name = 'BounceOut_Empty';
    db.addPlayer(name);
    assert.equal(db.getBounceOutCount(name, 'chuckin', 'practice'), 0);
  });
});

describe('getMetricHistory matches getChuckinStatBubbles (docs/archive/game-modes-roadmap.md)', () => {
  test('"chuckindartsthrown" over "all" time sums to the stat-bubble dartsThrown', () => {
    const name = 'Chuckin_Metric_Darts';
    db.addPlayer(name);
    const g = chuckinGame(name);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [5, 1]);

    const bubbles = db.getChuckinStatBubbles(name, 'practice');
    const history = db.getMetricHistory(name, 'chuckindartsthrown', 'all', { mode: 'practice' });
    const total = history.reduce((s, row) => s + row.value, 0);
    assert.equal(total, bubbles.dartsThrown);
  });

  test('"chuckintreblepct" and "chuckindoublepct" over "all" time equal the stat-bubble percentages', () => {
    const name = 'Chuckin_Metric_Pct';
    db.addPlayer(name);
    const g = chuckinGame(name);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [19, 2]);
    chuckinDart(g.gameId, name, [5, 1]);
    chuckinDart(g.gameId, name, [5, 1]);

    const bubbles = db.getChuckinStatBubbles(name, 'practice');
    const treblePctHistory = db.getMetricHistory(name, 'chuckintreblepct', 'all', { mode: 'practice' });
    const doublePctHistory = db.getMetricHistory(name, 'chuckindoublepct', 'all', { mode: 'practice' });
    assert.equal(treblePctHistory.length, 1, 'one bucket for one calendar month of activity');
    assert.equal(treblePctHistory[0].value, bubbles.treblePct);
    assert.equal(doublePctHistory[0].value, bubbles.doublePct);
  });

  test('"chuckinsessions" and "chuckinavgdartspersession" are consistent with sessionsPlayed/avgDartsPerSession', () => {
    const name = 'Chuckin_Metric_Sessions';
    db.addPlayer(name);
    const g1 = chuckinGame(name);
    chuckinDart(g1.gameId, name, [1, 1]);
    chuckinDart(g1.gameId, name, [1, 1]);
    const g2 = chuckinGame(name);
    chuckinDart(g2.gameId, name, [1, 1]);
    chuckinDart(g2.gameId, name, [1, 1]);
    chuckinDart(g2.gameId, name, [1, 1]);
    chuckinDart(g2.gameId, name, [1, 1]); // 2 sessions: 2 darts, 4 darts

    const bubbles = db.getChuckinStatBubbles(name, 'practice');
    const sessionsHistory = db.getMetricHistory(name, 'chuckinsessions', 'all', { mode: 'practice' });
    const avgHistory = db.getMetricHistory(name, 'chuckinavgdartspersession', 'all', { mode: 'practice' });
    const totalSessions = sessionsHistory.reduce((s, row) => s + row.value, 0);
    assert.equal(totalSessions, bubbles.sessionsPlayed);
    assert.equal(avgHistory[0].value, bubbles.avgDartsPerSession);
  });

  test('"chuckinavg" over "all" time equals the stat-bubble 3-dart average', () => {
    const name = 'Chuckin_Metric_Avg';
    db.addPlayer(name);
    const g = chuckinGame(name);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [5, 1]);

    const bubbles = db.getChuckinStatBubbles(name, 'practice');
    const history = db.getMetricHistory(name, 'chuckinavg', 'all', { mode: 'practice' });
    assert.equal(history.length, 1);
    assert.equal(history[0].value, bubbles.avg);
  });

  test('"chuckin180s" over "all" time sums to the stat-bubble oneEighties count', () => {
    const name = 'Chuckin_Metric_180';
    db.addPlayer(name);
    const g = chuckinGame(name);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 3]); // a complete 180
    chuckinDart(g.gameId, name, [5, 1]); // trailing, no full group

    const bubbles = db.getChuckinStatBubbles(name, 'practice');
    const history = db.getMetricHistory(name, 'chuckin180s', 'all', { mode: 'practice' });
    const total = history.reduce((s, row) => s + row.value, 0);
    assert.equal(total, bubbles.oneEighties);
    assert.equal(total, 1);
  });
});

describe('Just Chuckin\' It does not pollute X01/Cricket stats, except the darts-thrown exception (regression, mirrors the earlier X01_ONLY/CRICKET_ONLY/NOT_CHUCKIN audit)', () => {
  test('an X01 player\'s 3-dart average, personal bests, and X01-scoped stat bubbles are unaffected by a Chuckin session', () => {
    const name = 'Chuckin_Isolation';
    db.addPlayer(name);
    const x01Game = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'x01', config: { startingScore: 501 },
      players: [{ name }],
    });
    db.addTurn(x01Game.gameId, {
      player: name, set: 1, leg: 1, scored: 180, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 20, multiplier: 3 }],
    });
    const beforeX01 = db.getPlayerStatBubbles(name, 'practice');
    const beforePB = db.getPersonalBests(name, 'practice');

    const g = chuckinGame(name);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 3]); // 3 trebles, would look like a 180 if it leaked into X01 scoring

    const afterX01 = db.getPlayerStatBubbles(name, 'practice');
    const afterPB = db.getPersonalBests(name, 'practice');
    assert.equal(afterX01.avgDarts, beforeX01.avgDarts, 'X01 3-dart average sums must not shift after an unrelated Chuckin session');
    assert.equal(afterPB.bestLegAvg, beforePB.bestLegAvg, 'X01 personal bests must not shift after an unrelated Chuckin session');
    // dartsThrown IS a deliberately all-game-types aggregate (the one documented
    // exception the user asked for: "no stats ... except total darts thrown") — it
    // SHOULD grow by the 3 Chuckin darts, confirming they're real physical darts,
    // not silently dropped, while nothing else about X01 scoring shifted.
    assert.equal(afterX01.dartsThrown, beforeX01.dartsThrown + 3);
  });

  test('a Chuckin session does not inflate the global 180s/practice-legs style X01-only leaderboards', () => {
    const name = 'Chuckin_No180';
    db.addPlayer(name);
    const g = chuckinGame(name);
    // 3 treble-20 darts thrown back-to-back in Chuckin -- would be a 180 if this
    // leaked into getOneEightyStats() (which scores by turns.scored, not by summing
    // 1-dart-per-turn chuckin rows, but this guards the intent regardless).
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [20, 3]);

    const oneEighty = db.getOneEightyStats('practice');
    const row = oneEighty.leaderboard.find(r => r.name === name);
    assert.equal(row, undefined, 'a Chuckin session must never appear on the 180s leaderboard');
  });

  test('a Cricket player\'s MPR/marks are unaffected by a Chuckin session', () => {
    const name = 'Chuckin_CricketIsolation';
    db.addPlayer(name);
    const cricketGame = db.createGame({
      category: 'Cricket (15-20, Bull)', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'cricket', config: { numbers: [15, 16, 17, 18, 19, 20, 25] },
      players: [{ name }],
    });
    db.addTurn(cricketGame.gameId, {
      player: name, set: 1, leg: 1, scored: 0, bust: false, checkout: false, checkoutPoints: null, legWon: false,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 19, multiplier: 3 }, { dartNo: 3, sector: 18, multiplier: 3 }],
    });
    const beforeCricket = db.getCricketStatBubbles(name, 'practice');

    const g = chuckinGame(name);
    chuckinDart(g.gameId, name, [20, 3]);
    chuckinDart(g.gameId, name, [19, 3]);

    const afterCricket = db.getCricketStatBubbles(name, 'practice');
    assert.equal(afterCricket.mpr, beforeCricket.mpr, 'Cricket MPR must not shift after an unrelated Chuckin session');
  });
});
