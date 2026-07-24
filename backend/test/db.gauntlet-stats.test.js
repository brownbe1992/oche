'use strict';
// Committed tests for backend/db.js's The Gauntlet stat formulas
// (docs/archive/gauntlet-roadmap.md, REFERENCE.md's The Gauntlet section) — against a
// scratch SQLite database. Not exhaustive; see db.x01-stats.test.js's header
// comment for the same "focused, not 100% coverage" framing.
//
// Turns here are inserted directly via db.addTurn() WITHOUT
// {enforceConsistency:true} (the established fixture convention across this
// whole test suite — see db.turn-consistency-guard.test.js's own header
// comment), so a full 20-station run can be built directly rather than
// re-deriving legitimate sequence/repeat-count guard compliance station by
// station.
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

const STATIONS = [20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5];

function gauntletGame(player) {
  return db.createGame({
    category: 'The Gauntlet', legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'gauntlet', players: [{ name: player }],
  });
}
function gt(gameId, player, station, scored) {
  db.addTurn(gameId, {
    player, set: 1, leg: 1, scored, bust: false, checkout: false, checkoutPoints: null, targetScore: station,
    darts: [{ dartNo: 1, sector: 1, multiplier: 1 }],
  });
}
// Plays a full, completed 20-station run from a per-station miss-count map
// (station -> final miss count; a value that needs a repeat to reach can be
// given as [firstAttempt, finalAttempt] instead of a bare number). A bare
// number of 2 is NOT a valid final result on its own -- a first (and only)
// attempt scoring 2 misses is "awaiting its one repeat," never settled -- so
// every bare value here must be 0, 1, or 3.
function playFullRun(gameId, player, missesByStation) {
  STATIONS.forEach(station => {
    const v = missesByStation[station] ?? 0;
    if (Array.isArray(v)) { gt(gameId, player, station, v[0]); gt(gameId, player, station, v[1]); }
    else gt(gameId, player, station, v);
  });
}

describe('getGauntletStatBubbles', () => {
  test('runsCompleted, avgTotalScars, cleanStationRate, deepScarRate, retryRate across a completed run and an abandoned one', () => {
    const a = 'Gauntlet_Bubbles_A';
    db.addPlayer(a);

    // A completed run: 18 clean stations, one Deep Scar (contributes 6), one
    // repeated station whose retry comes back clean (contributes 0).
    const g1 = gauntletGame(a);
    const misses1 = {};
    STATIONS.forEach(s => { misses1[s] = 0; });
    misses1[STATIONS[0]] = 3;          // Deep Scar
    misses1[STATIONS[1]] = [2, 0];     // repeated, retry clean
    playFullRun(g1.gameId, a, misses1);
    // total scars: 6 (deep scar) + 0 (repeat's final) + 18 zeros = 6

    // An abandoned run: only the first 3 stations ever attempted, never completed.
    const g2 = gauntletGame(a);
    gt(g2.gameId, a, STATIONS[0], 1);
    gt(g2.gameId, a, STATIONS[1], 0);
    gt(g2.gameId, a, STATIONS[2], 3);

    const bubbles = db.getGauntletStatBubbles(a, 'practice');
    assert.equal(bubbles.runsCompleted, 1, 'only g1 reached all 20 settled stations');
    assert.equal(bubbles.avgTotalScars, 6, 'g1: one Deep Scar (6) + everything else 0, averaged over 1 completed run');

    // Settled stations across BOTH runs: g1's 20 + g2's 3 = 23.
    // Clean (0-miss final) count: g1 has 18 clean + the repeated station's
    // clean retry = 19; g2 has 1 clean (station 2) -> 20 clean of 23.
    const totalSettled = 20 + 3;
    const cleanCount = 19 + 1;
    assert.equal(bubbles.cleanStationRate, (cleanCount / totalSettled) * 100);

    // Deep Scars: g1 has 1 (station[0]); g2 has 1 (station[2]) -> 2 of 23.
    assert.equal(bubbles.deepScarRate, (2 / totalSettled) * 100);

    // Retries: g1 has exactly 1 settled station that needed a repeat; g2 has none.
    assert.equal(bubbles.retryRate, (1 / totalSettled) * 100);
  });

  test('a player with no Gauntlet history gets a zeroed/null bubble set, not a crash', () => {
    const a = 'Gauntlet_Bubbles_None';
    db.addPlayer(a);
    const bubbles = db.getGauntletStatBubbles(a, 'practice');
    assert.equal(bubbles.runsCompleted, 0);
    assert.equal(bubbles.avgTotalScars, null);
    assert.equal(bubbles.cleanStationRate, null);
    assert.equal(bubbles.deepScarRate, null);
    assert.equal(bubbles.retryRate, null);
  });

  test('an unknown player name returns null', () => {
    assert.equal(db.getGauntletStatBubbles('NoSuchGauntletPlayer', 'practice'), null);
  });
});

describe('getGauntletPersonalBests', () => {
  test('lowestTotalScars is the MIN across completed runs only (ascending-is-better), ignoring an abandoned run', () => {
    const a = 'Gauntlet_PB_A';
    db.addPlayer(a);

    // Completed run #1: total Scars = 10 (spread across a few stations).
    const g1 = gauntletGame(a);
    const misses1 = {}; STATIONS.forEach(s => { misses1[s] = 0; });
    misses1[STATIONS[0]] = 3; misses1[STATIONS[1]] = 3; misses1[STATIONS[2]] = 1; // 6+6+1 = 13... adjust below
    playFullRun(g1.gameId, a, misses1);
    // recompute: 3+3=deep scars (6 each=12) + 1 = 13 total for g1

    // Completed run #2: a lower (better) total Scars = 1. (A bare miss count
    // of 2 would mean "awaiting its one repeat," not a final result -- see
    // playFullRun()'s own comment -- so 1 is used here instead to keep this a
    // genuinely SETTLED, single-attempt station.)
    const g2 = gauntletGame(a);
    const misses2 = {}; STATIONS.forEach(s => { misses2[s] = 0; });
    misses2[STATIONS[0]] = 1;
    playFullRun(g2.gameId, a, misses2);

    // An abandoned (incomplete) run with a much lower partial total -- must NOT
    // be picked as the personal best.
    const g3 = gauntletGame(a);
    gt(g3.gameId, a, STATIONS[0], 0);

    const pb = db.getGauntletPersonalBests(a, 'practice');
    assert.equal(pb.lowestTotalScars, 1, "g2's total (1) beats g1's (13); g3 is ignored (not completed)");
  });

  test('a player with no completed Gauntlet run gets a null field, not a crash', () => {
    const a = 'Gauntlet_PB_None';
    db.addPlayer(a);
    const pb = db.getGauntletPersonalBests(a, 'practice');
    assert.equal(pb.lowestTotalScars, null);
  });
});

describe('getGauntletLeaderboard', () => {
  test('one row per player, sorted ASCENDING by lowest-ever total Scars (lower is better)', () => {
    const a = 'Gauntlet_Board_A', b = 'Gauntlet_Board_B';
    db.addPlayer(a); db.addPlayer(b);

    const ga = gauntletGame(a);
    const missesA = {}; STATIONS.forEach(s => { missesA[s] = 0; });
    missesA[STATIONS[0]] = 3; // total 6
    playFullRun(ga.gameId, a, missesA);

    const gb = gauntletGame(b);
    const missesB = {}; STATIONS.forEach(s => { missesB[s] = 0; });
    missesB[STATIONS[0]] = 1; // total 1 -- better than a
    playFullRun(gb.gameId, b, missesB);

    const board = db.getGauntletLeaderboard();
    const rowA = board.find(r => r.name === a);
    const rowB = board.find(r => r.name === b);
    assert.equal(rowA.bestTotalScars, 6);
    assert.equal(rowB.bestTotalScars, 1);
    assert.ok(rowA.achievedAt && rowB.achievedAt, 'each row carries a real achievedAt timestamp');
    assert.ok(board.indexOf(rowB) < board.indexOf(rowA), 'the LOWER total-Scars row ranks first');
  });
});

describe('getGauntletScarMap', () => {
  test('averages each station\'s final miss count across every COMPLETED run only, per station number', () => {
    const a = 'Gauntlet_ScarMap_A';
    db.addPlayer(a);

    // Run 1: station STATIONS[0] finishes with 1 miss.
    const g1 = gauntletGame(a);
    const misses1 = {}; STATIONS.forEach(s => { misses1[s] = 0; });
    misses1[STATIONS[0]] = 1;
    playFullRun(g1.gameId, a, misses1);

    // Run 2: the same station finishes with 3 misses (a Deep Scar).
    const g2 = gauntletGame(a);
    const misses2 = {}; STATIONS.forEach(s => { misses2[s] = 0; });
    misses2[STATIONS[0]] = 3;
    playFullRun(g2.gameId, a, misses2);

    // An abandoned (incomplete) run touching the same station -- must be excluded.
    const g3 = gauntletGame(a);
    gt(g3.gameId, a, STATIONS[0], 0);

    const map = db.getGauntletScarMap(a);
    const row0 = map.stations.find(r => r.station === STATIONS[0]);
    assert.equal(row0.runs, 2, 'only the 2 completed runs count, not the abandoned one');
    assert.equal(row0.avgScars, (1 + 3) / 2);

    const otherRow = map.stations.find(r => r.station === STATIONS[1]);
    assert.equal(otherRow.avgScars, 0, 'every completed run scored 0 misses here');
  });

  test('an unknown player name returns null', () => {
    assert.equal(db.getGauntletScarMap('NoSuchGauntletScarMapPlayer'), null);
  });
});
