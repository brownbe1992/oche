'use strict';
/* A player who bowed out mid-match must STAY out across a save/resume.
 *
 * `game_players.dnf` was always persisted, but nothing ever read it back: the resume
 * payload didn't return it, resumeGame() didn't apply it, and the rebuild*State()
 * replays constructed players from names alone and advanced with a plain
 * `(index + 1) % length`. Two things went wrong, and only one of them was visible:
 *
 *   1. the bowed-out player silently rejoined the match;
 *   2. worse and completely silent — the four fixed-round modes (Baseball, Shanghai,
 *      Halve-It, Pressure Chamber) resumed on the WRONG ROUND, because
 *      isRoundComplete() decides the round boundary by walking to the next ACTIVE
 *      player. With the departed player still counted as active, the replay's round
 *      only ticked over on their (never-thrown) turn, so a 3-player Baseball whose
 *      last-in-rotation player bowed out came back an inning behind with no error
 *      anywhere.
 *
 * These tests pin both halves at the replay layer, which is where the rule lives —
 * `dnfs` in, `dnf` on the rebuilt players, and every turn-advance skipping them.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const S = require('../../frontend/scoring.js');

// One visit of three darts at `sector`, in the shape the rebuilds consume.
const visit = (playerIndex, sector) => ({
  setNo: 1, legNo: 1, playerIndex,
  darts: [{ sector, mult: 1 }, { sector, mult: 1 }, { sector, mult: 1 }],
});

describe('resume replays bowed-out (dnf) players', () => {
  /* Three players; C (index 2, last in rotation) bows out after inning 1.
   * Inning 1: A, B, C all throw.  Inning 2: A, B throw — and because C is out,
   * B is the last active thrower, so the inning completes on B's visit. Three
   * innings' worth of play, so the resumed game must be on inning 3. */
  const turns = [
    visit(0, 1), visit(1, 1), visit(2, 1),   // inning 1, everyone
    visit(0, 2), visit(1, 2),                // inning 2, C already gone
  ];

  test('Baseball resumes on the inning the live game was actually on', () => {
    const r = S.rebuildBaseballState({
      names: ['A', 'B', 'C'], legsPerSet: 1, turns, dnfs: [false, false, true],
    });
    assert.equal(r.baseballInning, 3,
      'inning 2 completes on B (the last ACTIVE player), not on the departed C');
  });

  test('without the dnf flag the same turns land an inning short — the original bug', () => {
    const r = S.rebuildBaseballState({ names: ['A', 'B', 'C'], legsPerSet: 1, turns });
    assert.equal(r.baseballInning, 2,
      'guard for this test itself: the pre-fix behaviour is exactly one inning behind, ' +
      'so the assertion above is testing something real');
  });

  /* The other direction, and the reason _dnfTracker() exists at all. `dnf` is a
   * terminal flag with no timestamp, so the obvious fix — mark them out from turn 1 —
   * back-dates the departure over rounds they genuinely played, and lands the replay
   * an inning AHEAD (4) instead of behind (2). Only "out after their last recorded
   * turn" reproduces the live game. */
  test('a player who bowed out mid-match still counts for the rounds they played', () => {
    const backDated = ['A', 'B', 'C'].map((name, i) => ({ name, dnf: i === 2 }));
    // Hand-walk the round boundary the back-dated way, to pin the number this
    // test is guarding against rather than asserting a bare "not 4".
    let round = 1;
    for (const t of turns) {
      const game = { players: backDated, current: t.playerIndex, starter: 0 };
      if (S.isRoundComplete(game)) round += 1;
    }
    assert.equal(round, 4, 'back-dating the bow-out over-counts the rounds');
    assert.equal(
      S.rebuildBaseballState({ names: ['A', 'B', 'C'], legsPerSet: 1, turns, dnfs: [false, false, true] }).baseballInning,
      3, 'the replay must sit between the two wrong answers, on the live one');
  });

  test('the bowed-out player comes back bowed out', () => {
    const r = S.rebuildBaseballState({
      names: ['A', 'B', 'C'], legsPerSet: 1, turns, dnfs: [false, false, true],
    });
    assert.deepEqual(r.players.map(p => !!p.dnf), [false, false, true]);
  });

  test('the next thrower skips the bowed-out player rather than handing them the turn', () => {
    // Stop one visit earlier, so the last recorded turn is B's in inning 1 and the
    // "next" seat is C's — the seat that must be skipped.
    const r = S.rebuildBaseballState({
      names: ['A', 'B', 'C'], legsPerSet: 1, turns: turns.slice(0, 2), dnfs: [false, false, true],
    });
    assert.equal(r.current, 0, 'after B, the turn wraps past the departed C back to A');
  });

  test('X01 skips a bowed-out player when advancing', () => {
    const r = S.rebuildX01State({
      names: ['A', 'B', 'C'], outModes: ['double', 'double', 'double'],
      startScore: 501, practice: false, legsPerSet: 1,
      turns: [visit(0, 5), visit(1, 5)], dnfs: [false, false, true],
    });
    assert.equal(r.current, 0);
    assert.deepEqual(r.players.map(p => !!p.dnf), [false, false, true]);
  });

  test('every multi-player rebuild accepts dnfs and marks the player', () => {
    // The registry discipline in miniature: each of these threads `dnfs` through to
    // the shared replay, so adding a mode without it is a visible omission here.
    const names = ['A', 'B', 'C'];
    const dnfs = [false, false, true];
    const cases = [
      ['Cricket', () => S.rebuildCricketState({ names, config: null, practice: false, legsPerSet: 1, turns: [], dnfs })],
      ['Baseball', () => S.rebuildBaseballState({ names, legsPerSet: 1, turns: [], dnfs })],
      ['Shanghai', () => S.rebuildShanghaiState({ names, legsPerSet: 1, maxRounds: 7, turns: [], dnfs })],
      ['Halve-It', () => S.rebuildHalveItState({ names, legsPerSet: 1, targets: [20, 19, 18], turns: [], dnfs })],
      ['Pressure Chamber', () => S.rebuildPressureChamberState({ gameId: 1, names, legsPerSet: 1, maxRounds: 7, turns: [], dnfs })],
      ['ATC Race', () => S.rebuildAroundTheClockRaceState({ names, legsPerSet: 1, turns: [], dnfs })],
    ];
    for (const [label, build] of cases) {
      assert.deepEqual(build().players.map(p => !!p.dnf), dnfs, `${label} lost the dnf flags`);
    }
  });
});
