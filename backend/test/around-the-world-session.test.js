'use strict';
// Committed tests for "one world = one game" (2026-07 redesign, from a live
// report).
//
// The guided Around the World drill used to track LIFETIME progress: a run
// started at whatever your lifetime 63-outcome set already contained, and
// finishing it meant hitting only the handful you had never hit before. Two
// reported consequences, which are the same defect from both ends:
//
//   "the achievement fires despite having only hit the missing lifetime darts,
//    not them all during one session"
//   "then, when starting a new game, everything has already been hit"
//
// Once a household's lifetime set was complete the mode retired itself
// permanently — every subsequent game opened at 63/63 with nothing to do.
//
// The goal is now the SESSION's own 63 outcomes, matching the "one clock = one
// game" shape Around the Clock was already redesigned into. Lifetime progress is
// still tracked (the Player Profile grid, the Home leaderboard, the passive
// `around_the_world` badge) — it just isn't the win condition.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const S = require('../../frontend/scoring.js');
// The whole page scope — a per-game-type function can live in index.html or in
// any frontend/js/ file it loads. See frontend-source.js.
const { pageSource: src } = require('./frontend-source.js');

// One 1-dart turn, the shape rebuildAroundTheWorldState() replays.
const turn = (sector, mult) => ({ legNo: 1, darts: [{ sector, mult }] });

// All 63 outcomes: 20 numbers x single/double/treble, outer bull, double bull, miss.
function allSixtyThree() {
  const out = [];
  for (let n = 1; n <= 20; n++) for (const m of [1, 2, 3]) out.push(turn(n, m));
  out.push(turn(25, 1), turn(25, 2), turn(0, 1));
  return out;
}

describe('rebuildAroundTheWorldState replays the session, not just a dart count', () => {
  test('an empty session is 0 of 63', () => {
    const r = S.rebuildAroundTheWorldState({ turns: [] });
    assert.equal(r.sessionDarts, 0);
    assert.equal(r.hitSet.size, 0);
    assert.equal(r.roundOver, false);
  });

  test('it rebuilds the exact set of outcomes hit', () => {
    // This is what makes a SAVED game resumable. Returning only a dart count —
    // which is all it used to return — would drop every outcome collected so far
    // and restart the checklist at 0/63 on resume.
    const r = S.rebuildAroundTheWorldState({ turns: [turn(20, 3), turn(20, 1), turn(25, 2)] });
    assert.equal(r.sessionDarts, 3);
    assert.deepEqual([...r.hitSet].sort(), ['20:1', '20:3', '25:2']);
  });

  test('repeat outcomes count as darts but not as progress', () => {
    const r = S.rebuildAroundTheWorldState({ turns: [turn(20, 3), turn(20, 3), turn(20, 3)] });
    assert.equal(r.sessionDarts, 3, 'three real darts were thrown');
    assert.equal(r.hitSet.size, 1, 'but only one distinct outcome');
  });

  test('a miss and both bulls are real, distinct outcomes', () => {
    // The 63 is 20x3 + outer bull + double bull + miss. A miss being one of them
    // is easy to forget, and losing it would make the set unreachable at 62.
    const r = S.rebuildAroundTheWorldState({ turns: [turn(0, 1), turn(25, 1), turn(25, 2)] });
    assert.deepEqual([...r.hitSet].sort(), ['0:1', '25:1', '25:2']);
  });

  test('a treble bull is normalised to a single bull, not a 63rd-and-a-half outcome', () => {
    // makeDartCore() downgrades an attempted treble bull (there is no such ring).
    // Without going through it, '25:3' would be a phantom outcome that inflates
    // progress and could push a session past 63.
    const r = S.rebuildAroundTheWorldState({ turns: [turn(25, 3)] });
    assert.deepEqual([...r.hitSet], ['25:1']);
  });

  test('the complete set is exactly 63 and flags the round over', () => {
    const r = S.rebuildAroundTheWorldState({ turns: allSixtyThree() });
    assert.equal(r.hitSet.size, 63, 'the enumeration itself must cover the whole set');
    assert.equal(r.roundOver, true);
  });

  test('62 of 63 does NOT flag the round over', () => {
    const turns = allSixtyThree();
    turns.pop();   // drop the miss
    const r = S.rebuildAroundTheWorldState({ turns });
    assert.equal(r.hitSet.size, 62);
    assert.equal(r.roundOver, false);
  });
});

describe('the game is scored on the session, not on lifetime progress', () => {
  test('every dart adds to the session set, not only lifetime-new ones', () => {
    // The old code added to sessionHitSet ONLY when the outcome was new to
    // LIFETIME (`if(isNewLifetimeOutcome) p.sessionHitSet.add(...)`), which is
    // precisely why a player whose lifetime set was complete could never make
    // progress: nothing was ever new.
    const fn = src().match(/function throwDartAroundTheWorld\([^)]*\)\{[\s\S]*?\n\}/);
    assert.ok(fn, 'throwDartAroundTheWorld() not found');
    assert.match(fn[0], /\n  p\.sessionHitSet\.add\(outcomeKey\);/,
      'every dart must join the session set unconditionally');
    assert.doesNotMatch(fn[0], /if\(isNewLifetimeOutcome\) p\.sessionHitSet\.add/,
      'the lifetime-gated add is the bug');
  });

  test('completion is measured on the session set', () => {
    const fn = src().match(/function throwDartAroundTheWorld\([^)]*\)\{[\s\S]*?\n\}/)[0];
    assert.match(fn, /const progress = p\.sessionHitSet\.size;/);
    assert.match(fn, /const completed = progress === 63;/);
    assert.doesNotMatch(fn, /baselineHitSet\.size \+ p\.sessionHitSet\.size/,
      'the lifetime union must no longer decide the win condition');
  });

  test('completing it ends the game, the way the Clock does', () => {
    // Under the old design the run never ended at all, so game.done never became
    // true — the same defect the "one clock = one game" redesign fixed for Around
    // the Clock, including the hamburger still offering "Save for later" after a
    // completed run.
    const fn = src().match(/function throwDartAroundTheWorld\([^)]*\)\{[\s\S]*?\n\}/)[0];
    for (const marker of ['DB.completeGame(p.name)', "finishUnit('game', p.name",
                          "heading: 'WORLD COMPLETE'", "DB.recordEvent('game_end'", 'game.roundOver = true']) {
      assert.ok(fn.includes(marker), `the completion sequence is missing ${marker}`);
    }
  });

  test('a finished run refuses further darts', () => {
    const fn = src().match(/function throwDartAroundTheWorld\([^)]*\)\{[\s\S]*?\n\}/)[0];
    assert.match(fn, /^function throwDartAroundTheWorld\([^)]*\)\{\n  if\(game\.roundOver\) return;/,
      'a completed world must not keep accepting darts');
  });

  test('the badge says it was one session', () => {
    const fn = src().match(/function throwDartAroundTheWorld\([^)]*\)\{[\s\S]*?\n\}/)[0];
    assert.match(fn, /awardOnceBadge\(p\.name, 'guided_world'/);
    assert.match(fn, /All 63 outcomes in one session/,
      'the statLine should say what was actually achieved');
  });

  test('undo restores the completed flag too', () => {
    // Undoing the 63rd dart has to reopen the run, not leave it permanently
    // refusing darts — the guard added above makes that a real hazard.
    const s = src();
    const fn = s.match(/function throwDartAroundTheWorld\([^)]*\)\{[\s\S]*?\n\}/)[0];
    assert.match(fn, /pushTurnSnapshot\(\{[\s\S]*?roundOver:game\.roundOver/);
    const undo = s.match(/function undoLastTurnAroundTheWorld\(\)\{[\s\S]*?\n\}/);
    assert.ok(undo, 'undoLastTurnAroundTheWorld() not found');
    assert.match(undo[0], /game\.roundOver = snap\.roundOver;/);
  });

  test('lifetime progress is still tracked and still shown', () => {
    // The redesign demotes lifetime from "the goal" to "context". Losing it
    // entirely would be a different regression: the Player Profile grid, the Home
    // leaderboard and the passive `around_the_world` badge all still mean
    // lifetime.
    const s = src();
    const render = s.match(/function renderGameAroundTheWorld\(\)\{[\s\S]*?\n\}/);
    assert.ok(render, 'renderGameAroundTheWorld() not found');
    assert.match(render[0], /lifetime = new Set\(\[\.\.\.p\.baselineHitSet, \.\.\.p\.sessionHitSet\]\)\.size/);
    assert.match(render[0], /\$\{lifetime\} \/ 63 lifetime/);
    assert.match(render[0], /\$\{progress\} \/ 63 this session/);
  });

  test('the live grid shows the session checklist being filled', () => {
    const render = src().match(/function renderGameAroundTheWorld\(\)\{[\s\S]*?\n\}/)[0];
    assert.match(render, /buildOutcomeGridHtml\(p\.sessionHitSet, \{ cells: 'all', live: true \}\)/,
      'the grid must track the session, or it shows a checklist the player cannot change');
  });

  test('the resume path restores the session set, not just the dart count', () => {
    const s = src();
    const resume = s.match(/const r = rebuildAroundTheWorldState\(\{ turns: state\.turns \}\);[\s\S]{0,400}?\};/);
    assert.ok(resume, 'the around_the_world resume handler was not found');
    assert.match(resume[0], /players\[0\]\.sessionHitSet = r\.hitSet;/);
    assert.match(resume[0], /overlay: \{ roundOver: r\.roundOver \}/);
  });
});
