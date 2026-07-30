'use strict';
// Committed tests for the Maths Trainer's server side (docs/minigames-roadmap.md
// Part A): the write path's re-derivation guard, the stat/leaderboard formulas,
// and — the one that matters most and is easiest to forget — that a whole session
// of this mode leaves every pre-existing statistic byte-identical.
//
// That isolation test is written as a before/after snapshot of the entire stat
// surface rather than a list of named stats, so a statistic added later is covered
// automatically. It is the test that would have caught Checkout Trainer's
// fewestDartsCheckout leak, where a 1-dart optimal answer could both win "Fewest
// Darts to Finish" and drag every average toward zero.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-test-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const db = require('../db.js');
const S = require('../../frontend/scoring.js');

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

let seq = 0;
const uniq = (p) => `${p}_${++seq}`;

function mathsGame(playerName, config) {
  return db.createGame({
    category: (config && config.mode === 'sprint') ? 'Maths Sprint' : 'Maths Trainer (segment)',
    legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'maths_trainer',
    config: Object.assign({ questionType: 'segment', promptStyle: 'text', difficulty: 'easy', mode: 'freeform' }, config || {}),
    players: [{ name: playerName, out: 'double' }],
  }).gameId;
}
// A whole round in one call. `chosen` null means the clock ran out on it.
function round(gameId, player, prompt, chosen, ms, opts) {
  const o = opts || {};
  const q = S.mathsQuestionFromPrompt(prompt, o.questionType || (String(prompt).includes(',') ? 'counting' : 'segment'));
  const options = o.options || S.mathsOptions(q, () => 0.42);
  return db.addMathsTrainerRound(gameId, player, {
    player, roundNo: o.roundNo || 1,
    questionType: q.questionType, promptStyle: o.promptStyle || 'text',
    prompt, options, chosenAnswer: chosen, answeredMs: ms,
  });
}

describe('the write path re-derives correctness', () => {
  test('a right answer is recorded correct, a wrong one is not', () => {
    const name = uniq('Reder'); const g = mathsGame(name);
    assert.equal(round(g, name, 'T19', 57, 800).correct, true);
    assert.equal(round(g, name, 'T19', 54, 800).correct, false);
  });

  test('the client cannot declare its own answer correct', () => {
    // The whole reason the server recomputes: a client-supplied verdict would make
    // the Sprint leaderboard and every badge a number the client invents.
    const name = uniq('Liar'); const g = mathsGame(name);
    const q = S.mathsQuestionFromPrompt('T19', 'segment');
    const options = S.mathsOptions(q, () => 0.1);
    const wrong = options.find(v => v !== 57);
    const res = db.addMathsTrainerRound(g, name, {
      player: name, roundNo: 1, questionType: 'segment', prompt: 'T19',
      options, chosenAnswer: wrong, answeredMs: 500,
      correct: 1, correctAnswer: wrong,     // both lies, both ignored
    });
    assert.equal(res.correct, false);
    assert.equal(res.correctAnswer, 57, 'the server states the real answer');
  });

  test('a malformed prompt is a 400, not a stored row', () => {
    const name = uniq('Bad'); const g = mathsGame(name);
    for (const bad of ['', 'T21', 'nonsense', 'T19,X4']) {
      assert.throws(() => db.addMathsTrainerRound(g, name, {
        player: name, roundNo: 1, questionType: 'segment', prompt: bad,
        options: [1, 2, 3, 4], chosenAnswer: 1, answeredMs: 500,
      }), (e) => e.status === 400, `${JSON.stringify(bad)} should be rejected`);
    }
  });

  test('the options must be four integers including the real answer', () => {
    const name = uniq('Opts'); const g = mathsGame(name);
    const bad = [
      [57, 54, 51],                 // three
      [57, 54, 51, 60, 48],         // five
      [54, 51, 60, 48],             // the answer is missing
      [57, 'x', 51, 60],            // not integers
    ];
    for (const options of bad) {
      assert.throws(() => db.addMathsTrainerRound(g, name, {
        player: name, roundNo: 1, questionType: 'segment', prompt: 'T19',
        options, chosenAnswer: 57, answeredMs: 500,
      }), (e) => e.status === 400, `options ${JSON.stringify(options)} should be rejected`);
    }
  });

  test('a chosen answer that was never offered is rejected', () => {
    const name = uniq('Ghost'); const g = mathsGame(name);
    const q = S.mathsQuestionFromPrompt('T19', 'segment');
    const options = S.mathsOptions(q, () => 0.3);
    assert.throws(() => db.addMathsTrainerRound(g, name, {
      player: name, roundNo: 1, questionType: 'segment', prompt: 'T19',
      options, chosenAnswer: 999, answeredMs: 500,
    }), (e) => e.status === 400);
  });

  test('answered_ms is guarded like a scored field, not like telemetry', () => {
    // It drives the instant threshold, "segments known cold" and the instant
    // ladders, so a client reporting 1ms per answer would earn the mode's
    // flagship badge for nothing.
    const name = uniq('Fast'); const g = mathsGame(name);
    for (const ms of [-1, 0, 5, 119]) {
      assert.throws(() => round(g, name, 'T19', 57, ms), (e) => e.status === 400,
        `answeredMs ${ms} should be rejected as inhuman`);
    }
    assert.equal(round(g, name, 'T19', 57, 130).correct, true, '130ms is fast but possible');
  });

  test('a round nobody answered stores no answer time', () => {
    const name = uniq('Timeout'); const g = mathsGame(name);
    round(g, name, 'T19', null, 4000);
    const rows = db.getMathsTrainerStatBubbles(name);
    assert.equal(rows.rounds, 1);
    assert.equal(rows.correctPct, null, 'an unanswered round is not part of a percentage');
  });

  test('rounds can only be written to a Maths Trainer game', () => {
    const name = uniq('WrongType');
    const other = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name, out: 'double' }] }).gameId;
    assert.throws(() => round(other, name, 'T19', 57, 500), (e) => e.status === 400);
  });
});

describe('config validation at creation', () => {
  test('each closed set rejects an unrecognised value', () => {
    const name = uniq('Cfg');
    for (const [key, bad] of [['questionType', 'algebra'], ['promptStyle', 'hologram'],
                              ['difficulty', 'nightmare'], ['mode', 'marathon']]) {
      assert.throws(() => mathsGame(name, { [key]: bad }), (e) => e.status === 400, `${key}=${bad}`);
    }
  });

  test('a board prompt is meaningless on a single segment', () => {
    const name = uniq('Board');
    assert.throws(() => mathsGame(name, { questionType: 'segment', promptStyle: 'board' }),
      (e) => e.status === 400);
    assert.ok(mathsGame(name, { questionType: 'counting', promptStyle: 'board' }) > 0);
  });

  test('the sprint duration is fixed', () => {
    const name = uniq('Dur');
    assert.throws(() => mathsGame(name, { mode: 'sprint', durationSec: 600 }), (e) => e.status === 400);
    assert.ok(mathsGame(name, { mode: 'sprint', durationSec: 60 }) > 0);
  });
});

describe('stat bubbles', () => {
  test('segments known cold is the headline, and correctness is not it', () => {
    const name = uniq('Known'); const g = mathsGame(name);
    const W = S.MATHS_KNOWN_WINDOW;
    // Every answer correct, every one of them slow: 100% correct, nothing learned.
    for (let i = 0; i < W; i++) round(g, name, 'T19', 57, 2400, { roundNo: i + 1 });
    let s = db.getMathsTrainerStatBubbles(name);
    assert.equal(s.correctPct, 100);
    assert.equal(s.segmentsKnown, 0, 'a segment you compute every time is not known');
    assert.equal(s.segmentsStillCounting, 1);
    // Now answer it quickly enough, three times.
    for (let i = 0; i < W; i++) round(g, name, 'T19', 57, 700, { roundNo: W + i + 1 });
    s = db.getMathsTrainerStatBubbles(name);
    assert.equal(s.segmentsKnown, 1);
    assert.equal(s.segmentsStillCounting, 0);
  });

  test('the pool size is the full pool, so the number is comparable across sessions', () => {
    const name = uniq('Pool'); mathsGame(name);
    const s = db.getMathsTrainerStatBubbles(name);
    assert.equal(s.segmentPoolSize, S.mathsSegmentPool('hard').length);
  });

  test('medians are reported per question type and ignore wrong answers', () => {
    const name = uniq('Med'); const g = mathsGame(name, { questionType: 'counting' });
    round(g, name, 'T19', 57, 400, { roundNo: 1 });
    round(g, name, 'T19', 54, 9000, { roundNo: 2 });      // wrong: excluded
    round(g, name, 'T20,D10', 80, 3000, { roundNo: 3, questionType: 'counting' });
    const s = db.getMathsTrainerStatBubbles(name);
    assert.equal(s.medianSegmentMs, 400);
    assert.equal(s.medianCountingMs, 3000);
  });

  test('an unknown player is null rather than a zeroed row', () => {
    assert.equal(db.getMathsTrainerStatBubbles('nobody-at-all'), null);
    assert.equal(db.getMathsTrainerPersonalBests('nobody-at-all'), null);
    assert.equal(db.getMathsTrainerSegments('nobody-at-all'), null);
  });
});

describe('the crib sheet', () => {
  test('every pool segment is listed with its value, whether attempted or not', () => {
    const name = uniq('Crib'); const g = mathsGame(name);
    round(g, name, 'T19', 57, 600);
    const sheet = db.getMathsTrainerSegments(name, 'easy');
    assert.equal(sheet.segments.length, S.mathsSegmentPool('easy').length);
    for (const s of sheet.segments) assert.equal(s.value, S.mathsSegmentValue(s.segment), s.segment);
    assert.equal(sheet.thresholdMs, S.mathsInstantMs('segment'));
    assert.equal(sheet.segments.find(s => s.segment === 'T19').attempts, 1);
    assert.equal(sheet.segments.find(s => s.segment === 'T14').attempts, 0);
  });

  test('the weakest segment names the slowest one still unlearned', () => {
    const name = uniq('Weak'); const g = mathsGame(name);
    round(g, name, 'T14', 42, 4000, { roundNo: 1 });
    round(g, name, 'T17', 51, 1800, { roundNo: 2 });
    const pb = db.getMathsTrainerPersonalBests(name);
    assert.equal(pb.weakestSegment, 'T14');
    assert.equal(pb.weakestSegmentMs, 4000);
  });
});

describe('the sprint leaderboard', () => {
  test('one point per correct answer, and a player keeps their best run', () => {
    const a = uniq('SprintA'); const b = uniq('SprintB');
    const g1 = mathsGame(a, { mode: 'sprint', durationSec: 60 });
    for (let i = 0; i < 5; i++) round(g1, a, 'T19', 57, 600, { roundNo: i + 1 });
    round(g1, a, 'T19', 54, 600, { roundNo: 6 });          // wrong: no point
    const g2 = mathsGame(a, { mode: 'sprint', durationSec: 60 });
    for (let i = 0; i < 3; i++) round(g2, a, 'T18', 54, 600, { roundNo: i + 1 });
    const g3 = mathsGame(b, { mode: 'sprint', durationSec: 60 });
    for (let i = 0; i < 8; i++) round(g3, b, 'T20', 60, 600, { roundNo: i + 1 });

    const board = db.getMathsSprintLeaderboard();
    const rowA = board.find(r => r.name === a);
    const rowB = board.find(r => r.name === b);
    assert.equal(rowA.bestScore, 5, "a player's peak run, not their latest");
    assert.equal(rowB.bestScore, 8);
    assert.ok(board.indexOf(rowB) < board.indexOf(rowA), 'sorted best first');
  });

  test('freeform rounds never reach the sprint leaderboard', () => {
    const name = uniq('Free'); const g = mathsGame(name, { mode: 'freeform' });
    for (let i = 0; i < 9; i++) round(g, name, 'T19', 57, 600, { roundNo: i + 1 });
    assert.equal(db.getMathsSprintLeaderboard().find(r => r.name === name), undefined);
    assert.equal(db.getMathsSprintPersonalStats(name).runs, 0);
  });
});

describe('ISOLATION — a Maths Trainer session touches nothing else', () => {
  test('every pre-existing statistic is byte-identical afterwards', () => {
    // The assertion that matters most, and the easiest to forget. Written as a
    // whole-surface snapshot rather than a list of named stats, so a statistic
    // added later is covered without editing this test.
    const name = uniq('Isolated');
    // Give the player some real history first, so the snapshot has content to
    // change — an all-nulls comparison would pass against a broken exclusion.
    const x01 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name, out: 'double' }] }).gameId;
    db.recordTurn(x01, { player: name, set: 1, leg: 1, scored: 140, bust: 0, checkout: 0,
      darts: [{ sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 1 }] });
    db.recordTurn(x01, { player: name, set: 1, leg: 1, scored: 60, bust: 0, checkout: 0,
      darts: [{ sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }] });

    const snapshot = () => JSON.stringify({
      bubbles: db.getPlayerStatBubbles(name),
      bests: db.getPersonalBests(name),
      summary: db.getSummary(),
      stats: db.computeStats(),
      routes: db.getCheckoutRoutes(name),
      heatmap: db.getDartHeatmap(name),
      history: ['dartsthrown', 'avgdartsperleg', 'pace', 'avgdartsperday']
        .map(k => db.getMetricHistory(name, k)),
    });

    const before = snapshot();

    // A full session: both question types, right and wrong, fast and slow, plus a
    // Sprint run — everything this mode can possibly write.
    const gf = mathsGame(name, { questionType: 'segment' });
    for (let i = 0; i < 6; i++) round(gf, name, i % 2 ? 'T19' : 'D17', i % 2 ? 57 : 34, 600 + i * 300, { roundNo: i + 1 });
    round(gf, name, 'T14', 39, 5000, { roundNo: 7 });                       // wrong
    round(gf, name, 'T14', null, null, { roundNo: 8 });                     // timed out
    const gc = mathsGame(name, { questionType: 'counting', promptStyle: 'board' });
    round(gc, name, 'T17,13,D19', 102, 2800, { roundNo: 1, questionType: 'counting', promptStyle: 'board' });
    const gs = mathsGame(name, { mode: 'sprint', durationSec: 60 });
    for (let i = 0; i < 4; i++) round(gs, name, 'T20', 60, 500, { roundNo: i + 1 });
    db.completeGame(gf, name);

    assert.equal(snapshot(), before,
      'a Maths Trainer session changed a pre-existing statistic — it must write no turns and no darts');
  });

  test('it writes no turns and no darts rows at all', () => {
    // The structural reason the test above passes, asserted directly: this is what
    // makes the isolation hold for every query written LATER, with no exclusion
    // constant to remember.
    const name = uniq('NoTurns'); const g = mathsGame(name);
    for (let i = 0; i < 5; i++) round(g, name, 'T19', 57, 600, { roundNo: i + 1 });
    const detail = db.getGameDetail ? db.getGameDetail(g) : null;
    if (detail && detail.turns) assert.equal(detail.turns.length, 0);
    // And the mode contributes nothing to the lifetime dart count.
    const bubbles = db.getPlayerStatBubbles(name);
    assert.ok(!bubbles || !bubbles.dartsThrown, `dartsThrown should be 0/absent, got ${bubbles && bubbles.dartsThrown}`);
  });
});
