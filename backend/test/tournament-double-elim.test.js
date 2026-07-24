'use strict';
// Committed tests for backend/db.js's DOUBLE-elimination tournament support
// (docs/archive/tournament-mode-roadmap.md §2, roadmap item 13). Single-elimination lives
// in tournament.test.js; this file covers only the losers-bracket + grand-final /
// bracket-reset machinery layered on top of the same schema. Everything is driven
// through recordWalkover() (no real games needed) exactly as the single-elim tests
// drive advancement — the bracket logic under test is identical whether a result
// comes from a played game or a walkover.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-test-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const db = require('../db.js');
const { doubleElimStructure } = require(path.join('..', '..', 'frontend', 'scoring.js'));

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

let counter = 0;
function makePlayers(prefix, n) {
  const names = Array.from({ length: n }, (_, i) => `${prefix}_${++counter}_${i}`);
  names.forEach(nm => db.addPlayer(nm, 'double', {}));
  return names;
}
// A double-elim tournament needs one format entry per round in doubleElimStructure(k).
function deRounds(n) { return doubleElimStructure(Math.log2(n)).map(() => ({ legsPerSet: 1, setsPerGame: 1 })); }
function createDE(players) {
  return db.createTournament({ name: `DE_${++counter}`, category: '501', players, rounds: deRounds(players.length), bracketType: 'double_elim' }).tournamentId;
}
function ready(tid) { return db.getTournament(tid).matches.filter(m => m.status === 'ready'); }
function playByLabel(tid, label, winnerName) {
  const m = ready(tid).find(x => x.label === label);
  assert.ok(m, `expected a ready match labeled "${label}" — ready: ${ready(tid).map(r => `${r.label}:${r.player1Name}v${r.player2Name}`).join(', ')}`);
  const winner = winnerName || m.player1Name;
  db.recordWalkover(m.id, winner);
  return m;
}

describe('doubleElimStructure — the shared round plan', () => {
  test('N=4 (k=2): winners semi/final, one LB round + LB final, grand final + reset', () => {
    const plan = doubleElimStructure(2);
    assert.deepEqual(plan.map(r => `${r.bracket}:${r.label}:${r.matches}`), [
      'winners:Winners Semifinal:2', 'winners:Winners Final:1',
      'losers:Losers Round 1:1', 'losers:Losers Final:1',
      'grand_final:Grand Final:1', 'grand_final:Grand Final (Reset):1',
    ]);
  });
  test('N=8 (k=3): 3 winners rounds, 4 losers rounds (alternating minor/drop), grand final + reset', () => {
    const plan = doubleElimStructure(3);
    assert.deepEqual(plan.map(r => `${r.bracket}:${r.matches}`), [
      'winners:4', 'winners:2', 'winners:1',           // WB R1, semi, final
      'losers:2', 'losers:2', 'losers:1', 'losers:1',  // LB R1..R3, LB final
      'grand_final:1', 'grand_final:1',                // GF, reset
    ]);
    // A double-elim bracket of N players always has exactly 2N-1 matches (2N-2 plus
    // the conditional reset) — proven here against the plan's own match total.
    const totalMatches = plan.reduce((s, r) => s + r.matches, 0);
    assert.equal(totalMatches, 2 * 8 - 1);
  });
});

describe('createTournament — double-elimination generation', () => {
  test('N=8 generates the right rounds, zero byes, and standard WB round-1 seeding', () => {
    const players = makePlayers('DE8gen', 8);
    const tid = createDE(players);
    const t = db.getTournament(tid);
    assert.equal(t.bracket_type, 'double_elim');
    assert.equal(t.matches.length, 15, '2N-1 matches for N=8');
    assert.equal(t.matches.filter(m => m.is_bye).length, 0, 'exact power of two — no byes');
    // Every round carries its bracket label.
    assert.ok(t.matches.some(m => m.bracket === 'winners'));
    assert.ok(t.matches.some(m => m.bracket === 'losers'));
    assert.equal(t.matches.filter(m => m.bracket === 'grand_final').length, 2);
    // WB round 1 uses the same standard seeding as single-elim: 1v8,4v5,2v7,3v6.
    const wbR1 = t.matches.filter(m => m.label === 'Winners Round 1').sort((a, b) => a.slot - b.slot);
    assert.deepEqual(wbR1.map(m => [m.player1Name, m.player2Name]), [
      [players[0], players[7]], [players[3], players[4]], [players[1], players[6]], [players[2], players[5]],
    ]);
    // Only the winners round 1 is immediately ready; the losers bracket and grand
    // final have no players yet.
    assert.deepEqual([...new Set(ready(tid).map(m => m.label))], ['Winners Round 1']);
  });

  test('rejects a non-power-of-two player count for double-elim (v1 restriction)', () => {
    const players = makePlayers('DEbad', 6);
    assert.throws(() => db.createTournament({ name: 'bad', category: '301', players, rounds: deRounds(8), bracketType: 'double_elim' }),
      /Double-elimination requires exactly 4, 8, 16, 32, 64, 128 players/);
  });

  test('rejects a rounds array whose length does not match the double-elim plan', () => {
    const players = makePlayers('DEwrongrounds', 4);
    assert.throws(() => db.createTournament({ name: 'bad', category: '301', players, rounds: [{ legsPerSet: 1, setsPerGame: 1 }], bracketType: 'double_elim' }),
      /rounds must have exactly 6 entries/);
  });
});

describe('double-elimination advancement — losers bracket + grand final / reset', () => {
  test('a player who loses in the winners bracket can still win it all through the losers bracket, forcing a bracket reset', () => {
    const players = makePlayers('DErun', 4); // seeds: [0]=1 [1]=2 [2]=3 [3]=4
    const tid = createDE(players);
    // WB semis (seed order 1,4,2,3): match1 = P0 v P3, match2 = P1 v P2.
    // Upset: P3 beats top seed P0; P1 beats P2.
    playByLabel(tid, 'Winners Semifinal', players[3]);
    playByLabel(tid, 'Winners Semifinal', players[1]);
    // WB final: P1 beats P3 → P1 to grand final slot 1; P3 drops to the losers final.
    playByLabel(tid, 'Winners Final', players[1]);
    // Losers round 1 is the two WB-semi losers (P0 v P2). P0 wins, advances to LB final.
    playByLabel(tid, 'Losers Round 1', players[0]);
    // LB final: P0 (LB survivor) v P3 (WB-final loser) → P0 wins → LB champ to GF slot 2.
    playByLabel(tid, 'Losers Final', players[0]);
    // Grand final: P1 (WB champ, slot 1) v P0 (LB champ, slot 2).
    const gf = ready(tid).find(m => m.label === 'Grand Final');
    assert.deepEqual([gf.player1Name, gf.player2Name], [players[1], players[0]], 'WB champ in slot 1, LB champ in slot 2');
    // LB champ wins game 1 → both have one loss → bracket reset, tournament NOT over yet.
    db.recordWalkover(gf.id, players[0]);
    let t = db.getTournament(tid);
    assert.equal(t.status, 'in_progress', 'LB champ winning game 1 forces a decider, not an instant win');
    const reset = ready(tid).find(m => m.label === 'Grand Final (Reset)');
    assert.ok(reset, 'the reset match is now ready');
    assert.deepEqual([reset.player1Name, reset.player2Name], [players[1], players[0]]);
    // Reset decider: LB champ wins again → champion.
    db.recordWalkover(reset.id, players[0]);
    t = db.getTournament(tid);
    assert.equal(t.status, 'completed');
    assert.equal(t.champion_name, players[0]);
    assert.equal(t.runner_up_name, players[1]);
    assert.equal(t.players.filter(x => x.status === 'champion').length, 1);
    assert.equal(t.players.filter(x => x.status === 'eliminated').length, 3);
  });

  test('the winners-bracket champion winning grand-final game one ends the tournament with no reset', () => {
    const players = makePlayers('DEnoreset', 4);
    const tid = createDE(players);
    // Favorites hold: P0 and P1 reach the WB final, P0 wins it (→ GF slot 1).
    playByLabel(tid, 'Winners Semifinal', players[0]);
    playByLabel(tid, 'Winners Semifinal', players[1]);
    playByLabel(tid, 'Winners Final', players[0]);
    // Fill the losers bracket to produce an LB champion for GF slot 2.
    playByLabel(tid, 'Losers Round 1', ready(tid).find(m => m.label === 'Losers Round 1').player1Name);
    playByLabel(tid, 'Losers Final', ready(tid).find(m => m.label === 'Losers Final').player1Name);
    const gf = ready(tid).find(m => m.label === 'Grand Final');
    assert.equal(gf.player1Name, players[0], 'WB champ is slot 1');
    // WB champ wins game one → immediate completion, reset never played.
    db.recordWalkover(gf.id, players[0]);
    const t = db.getTournament(tid);
    assert.equal(t.status, 'completed');
    assert.equal(t.champion_name, players[0]);
    assert.equal(t.matches.find(m => m.label === 'Grand Final (Reset)').status, 'pending', 'the reset match is never activated');
  });

  test('an 8-player bracket always plays to a single champion with every match reachable (no dead-end pointers)', () => {
    const players = makePlayers('DE8full', 8);
    const tid = createDE(players);
    let guard = 0, played = 0;
    while (db.getTournament(tid).status !== 'completed') {
      assert.ok(++guard <= 40, 'bracket should resolve well within 2N matches');
      const r = ready(tid);
      assert.ok(r.length > 0, 'an unfinished double-elim bracket always has at least one ready match');
      // Bias toward the losers/slot-2 side so the grand-final reset path is exercised.
      db.recordWalkover(r[0].id, r[0].player2Name || r[0].player1Name);
      played++;
    }
    const t = db.getTournament(tid);
    assert.equal(t.players.filter(x => x.status === 'champion').length, 1);
    assert.equal(t.players.filter(x => x.status === 'eliminated').length, 7);
    assert.ok(played >= 14 && played <= 15, `an 8-player double-elim is 14 matches, or 15 with a reset (got ${played})`);
  });
});

describe('getTournamentStats — double-elimination best-finish labels', () => {
  test('a double-elim champion reads a grand-final best finish, and a losers-bracket run reads its own label', () => {
    const players = makePlayers('DEstats', 4);
    const tid = createDE(players);
    playByLabel(tid, 'Winners Semifinal', players[3]); // P0 loses early → drops to LB
    playByLabel(tid, 'Winners Semifinal', players[1]);
    playByLabel(tid, 'Winners Final', players[1]);
    playByLabel(tid, 'Losers Round 1', players[0]);    // P0 survives LB round 1
    playByLabel(tid, 'Losers Final', players[3]);       // P0 loses the losers final → eliminated at "Losers Final"
    // Grand final: P1 (WB champ) v P3 (LB champ). P1 wins game one → champion, no reset.
    const gf = ready(tid).find(m => m.label === 'Grand Final');
    db.recordWalkover(gf.id, players[1]);

    // Champion's furthest round is the grand final.
    const champStats = db.getTournamentStats(players[1]);
    assert.equal(champStats.wins, 1);
    assert.equal(champStats.bestFinish, 'Grand Final');
    // P0 was eliminated in the losers final — its stored label, not a single-elim name.
    const p0Stats = db.getTournamentStats(players[0]);
    assert.equal(p0Stats.wins, 0);
    assert.equal(p0Stats.bestFinish, 'Losers Final');
  });
});
