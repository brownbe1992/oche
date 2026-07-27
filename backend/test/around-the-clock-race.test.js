'use strict';
// Committed tests for the Around the Clock RACE variant's resume rebuild
// (docs/game-modes-roadmap.md "Around the Clock — H2H variant", built 2026-07).
//
// rebuildAroundTheClockRaceState() is the one genuinely new calculation the race
// added: replay a match's per-dart turns and recover every player's clock, the
// leg/set standing, and whose visit is in progress. Getting it wrong is exactly
// the class of bug a resumed game hides — the board looks plausible, and the
// only symptom is somebody being handed a visit that isn't theirs, or a leg
// count that quietly disagrees with the one the players remember.
//
// The solo rebuild it sits beside cannot be reused per player and summed: the
// leg boundary resets EVERY clock, so who won which leg has to be known while
// walking the turns, not afterwards.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { rebuildAroundTheClockRaceState, rebuildAroundTheClockState } =
  require('../../frontend/scoring.js');

// One recorded dart, in the shape recordSingleDartTurn() writes.
const d = (playerIndex, sector, mult = 1, legNo = 1, setNo = 1) =>
  ({ playerIndex, setNo, legNo, darts: [{ sector, mult }] });

// n darts for one player, walking 1,2,3… so each is a fresh number.
const clear = (playerIndex, count, from = 1, legNo = 1, setNo = 1) =>
  Array.from({ length: count }, (_, i) => d(playerIndex, from + i, 1, legNo, setNo));

const NAMES = ['Ana', 'Bo'];
const race = (turns, legsPerSet = 3) =>
  rebuildAroundTheClockRaceState({ names: NAMES, legsPerSet, dartsPerVisit: 3, turns });

describe('rebuilding a race from its darts', () => {
  test('each player\'s clock is their own, not the leg\'s', () => {
    // Interleaved visits: Ana clears 1-3, Bo clears 4-6.
    const turns = [...clear(0, 3, 1), ...clear(1, 3, 4)];
    const r = race(turns);
    assert.deepEqual([...r.players[0].hitSet].sort((a,b)=>a-b), [1, 2, 3]);
    assert.deepEqual([...r.players[1].hitSet].sort((a,b)=>a-b), [4, 5, 6]);
    assert.equal(r.players[0].roundDarts, 3);
    assert.equal(r.players[1].roundDarts, 3);
  });

  test('a repeat of a number already hit costs a dart and nothing else', () => {
    const r = race([...clear(0, 2, 1), d(0, 1)]);
    assert.equal(r.players[0].hitSet.size, 2, 'the third dart hit 1 again');
    assert.equal(r.players[0].roundDarts, 3, 'but it was still a dart thrown');
  });

  test('trebles, doubles and misses are tallied per player', () => {
    // A treble or double on a number never advances the clock (singles only),
    // but it is a real dart and belongs in that player's tally.
    const r = race([d(0, 5, 3), d(0, 5, 2), d(0, 0, 1), d(1, 7, 1)]);
    assert.equal(r.players[0].roundTrebles, 1);
    assert.equal(r.players[0].roundDoubles, 1);
    assert.equal(r.players[0].roundMisses, 1);
    assert.equal(r.players[0].hitSet.size, 0, 'none of the three cleared a number');
    assert.equal(r.players[1].roundMisses, 0);
  });

  test('the turn passes every third dart and wraps', () => {
    assert.equal(race(clear(0, 1)).current, 0, 'one dart in, still the same visit');
    assert.equal(race(clear(0, 3)).current, 1, 'three darts hands over');
    assert.equal(race([...clear(0, 3, 1), ...clear(1, 3, 4)]).current, 0, 'and back again');
  });

  test('the in-progress visit\'s dart count survives the rebuild', () => {
    // Resuming mid-visit must not silently gift the thrower a fresh three.
    assert.equal(race(clear(0, 1)).visitDarts, 1);
    assert.equal(race(clear(0, 2)).visitDarts, 2);
    assert.equal(race(clear(0, 3)).visitDarts, 0, 'a completed visit starts the next at zero');
  });
});

describe('the leg and set tree', () => {
  // Ana clears all twenty in one long run of darts.
  const anaClears = (legNo = 1, setNo = 1) => clear(0, 20, 1, legNo, setNo);

  test('clearing twenty numbers wins the leg and resets both clocks', () => {
    const r = race([...clear(1, 3, 5), ...anaClears()]);
    assert.equal(r.players[0].legsWon, 1);
    assert.equal(r.players[1].legsWon, 0);
    assert.equal(r.players[0].hitSet.size, 0, 'the new leg starts empty');
    assert.equal(r.players[1].hitSet.size, 0);
    assert.equal(r.legNo, 2);
    assert.equal(r.visitDarts, 0);
  });

  test('the starter rotates into the next leg, so the loser throws first', () => {
    const r = race([...anaClears()]);
    assert.equal(r.starter, 1);
    assert.equal(r.current, 1);
  });

  test('reaching legsPerSet takes the set and zeroes everyone\'s legs', () => {
    const turns = [
      ...anaClears(1, 1),
      ...clear(0, 20, 1, 2, 1),
    ];
    const r = race(turns, 2);
    assert.equal(r.players[0].setsWon, 1);
    assert.equal(r.players[0].legsWon, 0, 'legs reset when the set is taken');
    assert.equal(r.setNo, 2);
    assert.equal(r.legNo, 1);
  });

  test('a leg won by each side leaves the match level', () => {
    const r = race([...anaClears(1, 1), ...clear(1, 20, 1, 2, 1)]);
    assert.equal(r.players[0].legsWon, 1);
    assert.equal(r.players[1].legsWon, 1);
    assert.equal(r.legNo, 3);
  });

  test('darts thrown in a finished leg do not leak into the next one', () => {
    const r = race([...clear(1, 6, 1), ...anaClears(), ...clear(1, 2, 1, 2, 1)]);
    assert.equal(r.players[1].roundDarts, 2, 'only the new leg\'s darts');
    assert.equal(r.players[0].roundDarts, 0);
  });

  test('an empty match is a valid starting position, not a crash', () => {
    const r = race([]);
    assert.equal(r.current, 0);
    assert.equal(r.legNo, 1);
    assert.equal(r.setNo, 1);
    assert.deepEqual(r.players.map(p => p.hitSet.size), [0, 0]);
  });
});

describe('the race rebuild agrees with the solo one', () => {
  test('a one-player race reproduces the solo drill\'s clock exactly', () => {
    // Not a supported game state — but it pins that the two implementations
    // read the same rules, so a change to one that diverges is caught here
    // rather than by a player noticing a resumed run lost a number.
    const turns = [d(0, 5, 1), d(0, 5, 3), d(0, 0, 1), d(0, 12, 1), d(0, 12, 2)];
    const solo = rebuildAroundTheClockState({ turns });
    const r = rebuildAroundTheClockRaceState({ names: ['Solo'], legsPerSet: 1, dartsPerVisit: 3, turns });
    const p = r.players[0];
    assert.deepEqual([...p.hitSet].sort((a,b)=>a-b), [...solo.hitSet].sort((a,b)=>a-b));
    assert.equal(p.roundDarts, solo.roundDarts);
    assert.equal(p.roundTrebles, solo.roundTrebles);
    assert.equal(p.roundDoubles, solo.roundDoubles);
    assert.equal(p.roundMisses, solo.roundMisses);
  });
});
