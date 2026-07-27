'use strict';
// Committed tests for the live scoreboard's per-player lane figures
// (/frontend-design direction A, "Lower Third", chosen by the owner 2026-07).
//
// The redesign moved real statistics out of 11px text at the bottom of a card
// and into the lane itself, which means the live board now REPORTS numbers
// rather than just mirroring a score. Those numbers go through the same
// pracAggregate() the leg-complete panel uses, so a figure on the TV and the
// same figure on the results screen can never disagree — that shared-derivation
// property is what these tests exist to hold.
//
// The other thing pinned here is turnsForPlayer()'s unattributed-list rule.
// Getting it backwards (filtering an unattributed list by name, finding
// nothing) blanks the history line on every solo drill, which is exactly the
// class of silent-empty bug that is invisible until someone glances at the TV
// mid-session and sees nothing there.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { turnsForPlayer, liveLaneStats, pracAggregate, pracFirst9Average } =
  require('../../frontend/scoring.js');

const turn = (scored, opts = {}) => ({
  scored,
  darts: opts.darts != null ? opts.darts : 3,
  bust: !!opts.bust,
  trebleLess: !!opts.trebleLess,
  checkout: !!opts.checkout,
  checkoutPoints: opts.checkout ? scored : null,
  ...(opts.player != null ? { player: opts.player } : {}),
});

describe('turnsForPlayer — who threw what', () => {
  test('an attributed list is filtered by name', () => {
    const turns = [turn(60, { player: 'Ben' }), turn(45, { player: 'Sam' }), turn(140, { player: 'Ben' })];
    assert.deepEqual(turnsForPlayer(turns, 'Ben').map(t => t.scored), [60, 140]);
    assert.deepEqual(turnsForPlayer(turns, 'Sam').map(t => t.scored), [45]);
  });

  test('an UNATTRIBUTED list belongs entirely to whoever asks', () => {
    // The solo case, and the shape older records had. Filtering by name here
    // would return [] and silently blank the lane's history line — the whole
    // reason this rule is explicit rather than a plain .filter().
    const turns = [turn(60), turn(100), turn(41)];
    assert.deepEqual(turnsForPlayer(turns, 'Ben').map(t => t.scored), [60, 100, 41]);
    assert.deepEqual(turnsForPlayer(turns, 'anybody at all').length, 3);
  });

  test('a PARTIALLY attributed list is treated as attributed', () => {
    // If any record names a thrower, the unnamed ones are somebody else's and
    // must not be handed to the asker. The alternative — "mostly unattributed
    // means unattributed" — would credit an opponent's visits to this player.
    const turns = [turn(60, { player: 'Ben' }), turn(45), turn(140)];
    assert.deepEqual(turnsForPlayer(turns, 'Ben').map(t => t.scored), [60]);
  });

  test('an empty or missing list is empty, not a crash', () => {
    for(const input of [[], null, undefined]) assert.deepEqual(turnsForPlayer(input, 'Ben'), []);
  });

  test('it never mutates or aliases the list it was given', () => {
    const turns = [turn(60), turn(100)];
    const out = turnsForPlayer(turns, 'Ben');
    out.push(turn(180));
    assert.equal(turns.length, 2, 'the caller\'s array must be untouched');
  });
});

describe('a turn record whose darts are OBJECTS, not a count', () => {
  // X01's record carries `darts: 3`; Checkout Ladder's and Dead Man Walking's
  // carry `darts: game.darts.slice()` — the dart objects themselves. Summing
  // those produced a "0[object Object]…" string in the live payload and a NaN
  // first-9 the moment liveLaneState() was wired into those two modes.
  const objTurn = (scored, n) => ({ scored, darts: new Array(n).fill({ sector: 20, mult: 1 }),
    bust: false, trebleLess: false, checkout: false, checkoutPoints: null });

  test('the dart count is the array length, not a concatenated string', () => {
    const lane = liveLaneStats([objTurn(60, 3), objTurn(45, 2)], 'Ben');
    assert.equal(lane.darts, 5);
    assert.equal(typeof lane.darts, 'number');
  });

  test('the first-9 average is a real number, not NaN', () => {
    const lane = liveLaneStats([objTurn(60, 3), objTurn(60, 3), objTurn(60, 3)], 'Ben');
    assert.ok(Number.isFinite(lane.first9), `first9 was ${lane.first9}`);
    assert.equal(lane.first9.toFixed(1), '60.0');
  });

  test('a mixed list (count-shaped and array-shaped) still totals correctly', () => {
    const lane = liveLaneStats([turn(60), objTurn(45, 2)], 'Ben');
    assert.equal(lane.darts, 5);
  });

  test('the caller\'s turn objects are never mutated', () => {
    const t0 = objTurn(60, 3);
    liveLaneStats([t0], 'Ben');
    assert.ok(Array.isArray(t0.darts), 'the original record must keep its dart objects');
  });
});

describe('liveLaneStats — the lane agrees with the leg-complete panel', () => {
  const legTurns = [
    turn(140, { player: 'Ben' }),
    turn(60,  { player: 'Sam' }),
    turn(0,   { player: 'Ben', bust: true }),
    turn(100, { player: 'Ben' }),
    turn(85,  { player: 'Sam' }),
    turn(41,  { player: 'Ben' }),
  ];

  test('every shared figure matches pracAggregate on the same player\'s turns', () => {
    // The property worth protecting: the TV and the results screen derive from
    // one implementation. If someone re-implements a count inline in
    // display.html, this fails.
    const ben = legTurns.filter(t => t.player === 'Ben');
    const lane = liveLaneStats(legTurns, 'Ben');
    const agg = pracAggregate(ben);
    for(const key of ['visits', 'darts', 'busts', 'bestVisit', 'tonPlus', 'oneEighties', 'treblelessPct']){
      assert.equal(lane[key], agg[key], `${key} disagrees with pracAggregate`);
    }
    assert.deepEqual(lane.checkouts, agg.checkouts);
    assert.equal(lane.first9, pracFirst9Average(ben));
  });

  test('it counts only the asking player\'s visits, not the whole leg', () => {
    const lane = liveLaneStats(legTurns, 'Ben');
    assert.equal(lane.visits, 4, "Ben's four visits, not the leg's six");
    assert.equal(lane.darts, 12);
    assert.equal(lane.busts, 1);
    assert.equal(lane.bestVisit, 140);
  });

  test('recent visits read oldest-first — a sequence, not a ranking', () => {
    // The panel's lists sort descending because they rank; this one is a
    // chalked column, so it must stay in thrown order or it stops meaning
    // "what just happened".
    const lane = liveLaneStats(legTurns, 'Ben');
    assert.deepEqual(lane.recent.map(r => r.scored), [140, 0, 100, 41]);
    assert.deepEqual(lane.recent.map(r => r.bust), [false, true, false, false]);
  });

  test('a recentCount of 0 means NO recent list, not the whole list', () => {
    // slice(-0) returns the whole array. liveLaneState() passes 0 for the
    // session aggregate, where a recent list is neither wanted nor bounded.
    const many = [10, 20, 30].map(v => turn(v, { player: 'Ben' }));
    assert.deepEqual(liveLaneStats(many, 'Ben', 0).recent, []);
  });

  test('recent is capped at the requested tail length, keeping the LATEST visits', () => {
    const many = [10, 20, 30, 40, 50, 60].map(v => turn(v, { player: 'Ben' }));
    assert.deepEqual(liveLaneStats(many, 'Ben', 3).recent.map(r => r.scored), [40, 50, 60]);
    assert.deepEqual(liveLaneStats(many, 'Ben', 99).recent.map(r => r.scored), [10, 20, 30, 40, 50, 60]);
    assert.equal(liveLaneStats(many, 'Ben').recent.length, 4, 'four by default');
  });

  test('a checkout is flagged so the lane can mark the visit that won the leg', () => {
    const turns = [turn(100, { player: 'Ben' }), turn(40, { player: 'Ben', checkout: true, darts: 2 })];
    const lane = liveLaneStats(turns, 'Ben');
    assert.deepEqual(lane.recent.map(r => r.checkout), [false, true]);
    assert.deepEqual(lane.checkouts, [40]);
  });

  test('a leg with no darts yet reports zeroes and a null first-9, never NaN', () => {
    // Leg 1, visit 1: the board paints before anything is thrown.
    const lane = liveLaneStats([], 'Ben');
    assert.equal(lane.visits, 0);
    assert.equal(lane.darts, 0);
    assert.equal(lane.bestVisit, 0);
    assert.equal(lane.first9, null, 'rendered as an em dash, never 0.0');
    assert.equal(lane.treblelessPct, null);
    assert.deepEqual(lane.recent, []);
    assert.deepEqual(lane.checkouts, []);
  });

  test('a solo session\'s unattributed turns all count toward the only player', () => {
    const solo = [turn(140), turn(100), turn(41)];
    const lane = liveLaneStats(solo, 'Ben');
    assert.equal(lane.visits, 3);
    assert.equal(lane.bestVisit, 140);
    assert.deepEqual(lane.recent.map(r => r.scored), [140, 100, 41]);
  });
});
