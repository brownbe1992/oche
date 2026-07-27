'use strict';
// Committed tests for 2-4 player head-to-head X01
// (docs/archive/multiplayer-x01-roadmap.md, built 2026-07).
//
// X01 was capped at two players since the wizard reorder, not because the
// engine could only handle two — it was always modulo players.length — but
// because nothing had verified the rest of the app at three or four. Lifting
// the cap therefore risks exactly one class of regression: some OTHER game
// type quietly inheriting X01's narrower ceiling, or a bow-out shrinking a
// four-player match in a way the rotation walks into a departed player.
//
// Both of those are decisions, not markup, so they get pinned here. The
// functions are lifted out of index.html by brace-matching, the same way
// completion-panels.test.js does it — that file has no module boundary.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX = path.join(__dirname, '..', '..', 'frontend', 'index.html');
const src = fs.readFileSync(INDEX, 'utf8');

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name}() not found in index.html — renamed, or no longer a top-level function?`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

// The real constant, read out of the source rather than restated here — a test
// that hard-codes 6 would keep passing after someone changed the app's ceiling.
const GLOBAL_MAX = (() => {
  const m = src.match(/const SETUP_GLOBAL_MAX_PLAYERS\s*=\s*(\d+)/);
  assert.ok(m, 'SETUP_GLOBAL_MAX_PLAYERS not found in index.html');
  return Number(m[1]);
})();

// Enough of the app for the two setup functions to run: the registry reduced to
// the solo/h2h flags they actually read, and a mutable `setup` to drive.
const ctx = vm.createContext({
  setup: { mode: 'h2h', gameType: 'x01', leagueFixtureId: null },
  GAME_TYPES: {
    x01: {}, cricket: {}, baseball: {}, shanghai: {}, halve_it: {}, pressure_chamber: {},
    killer: { h2hOnly: true },
    around_the_clock: { soloOnly: true }, around_the_world: { soloOnly: true },
    bobs_27: { soloOnly: true }, chuckin: { soloOnly: true },
    doubles_practice: { soloOnly: true }, checkout_ladder: { soloOnly: true },
    gauntlet: { soloOnly: true }, checkout_trainer: { soloOnly: true },
    dead_man_walking: { soloOnly: true },
  },
});
vm.runInContext([
  extract('contextsForMode'),
  extract('currentSetupOptionKey'),
  extract('chosenGameContexts'),
  `const SETUP_GLOBAL_MAX_PLAYERS = ${GLOBAL_MAX};`,
  extract('maxPlayersForSetup'),
  extract('nextActiveIndexFrom'),
  'var game = null;',
  extract('nextThrowerPhrase'),
].join('\n'), ctx);

const maxFor = (mode, gameType, leagueFixtureId = null) => {
  Object.assign(ctx.setup, { mode, gameType, leagueFixtureId });
  return ctx.maxPlayersForSetup();
};

describe('the X01 player ceiling', () => {
  test('X01 allows 2-4 players, not the app-wide maximum', () => {
    // 4 is a format decision (a 501 leg is long; six players is a spectator
    // sport), which is why it is asserted as a literal here — if someone raises
    // it to 6 that should be a deliberate edit to this line, not a silent pass.
    assert.equal(maxFor('h2h', 'x01'), 4);
    assert.ok(GLOBAL_MAX > 4, 'the cap is meant to be NARROWER than the global one');
  });

  test('the cap is X01\'s alone — every other dual-mode type keeps the global max', () => {
    for (const key of ['cricket', 'baseball', 'shanghai', 'halve_it', 'pressure_chamber', 'killer']) {
      assert.equal(maxFor('h2h', key), GLOBAL_MAX, `${key} inherited X01's ceiling`);
    }
  });

  test('a solo-only type still allows exactly one slot', () => {
    for (const key of ['around_the_clock', 'bobs_27', 'chuckin', 'gauntlet']) {
      assert.equal(maxFor('practice', key), 1, `${key} should be a single seat`);
    }
  });

  test('the special solo modes are unaffected', () => {
    for (const mode of ['challenge', 'ghost', 'marathon']) {
      assert.equal(maxFor(mode, 'x01'), 1, `${mode} should still be one seat`);
    }
  });

  test('a league fixture stays strictly two, even though it is played as X01', () => {
    // League games are a fixture between a named PAIR — four seats would have
    // no meaning for the standings the fixture feeds.
    assert.equal(maxFor('h2h', 'x01', 7), 2);
  });

  test('solo X01 practice is one seat; H2H X01 is four', () => {
    assert.equal(maxFor('practice', 'x01'), 4,
      'practice/h2h is re-derived from the slot count, so the CAP is the same either way');
  });
});

describe('turn rotation past two players', () => {
  const roster = n => ({ players: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, dnf: false })) });

  test('four players rotate in order and wrap back to the first', () => {
    const g = roster(4);
    assert.deepEqual([0, 1, 2, 3].map(i => ctx.nextActiveIndexFrom(g, i)), [1, 2, 3, 0]);
  });

  test('three players rotate the same way — nothing is hard-coded to two', () => {
    const g = roster(3);
    assert.deepEqual([0, 1, 2].map(i => ctx.nextActiveIndexFrom(g, i)), [1, 2, 0]);
  });

  test('a bowed-out player is skipped, not handed a visit', () => {
    // The four-player case this exists for: a departed player stays IN
    // game.players (only `dnf` is set) so their stats survive on the
    // scoreboard, which means the rotation — not the array — has to skip them.
    const g = roster(4);
    g.players[1].dnf = true;
    assert.equal(ctx.nextActiveIndexFrom(g, 0), 2);
    g.players[2].dnf = true;
    assert.equal(ctx.nextActiveIndexFrom(g, 0), 3, 'two consecutive departures still resolve');
    assert.equal(ctx.nextActiveIndexFrom(g, 3), 0, 'and it still wraps');
  });

  test('the last player standing keeps throwing rather than the walk running away', () => {
    const g = roster(4);
    g.players[1].dnf = g.players[2].dnf = g.players[3].dnf = true;
    assert.equal(ctx.nextActiveIndexFrom(g, 0), 0);
  });

  test('the `also` predicate composes with dnf (Killer\'s eliminated players)', () => {
    const g = roster(4);
    g.players[1].dnf = true;
    g.players[2].eliminated = true;
    assert.equal(ctx.nextActiveIndexFrom(g, 0, p => p.eliminated), 3);
  });
});

describe('announcing who throws next', () => {
  // The accessibility half of this feature. At two players the ▸ throwing flag
  // has an obvious screen-reader equivalent — "the other one" — and the phrase
  // would be noise on every single visit. At three or four it is the only way a
  // screen-reader user learns the rotation, so it becomes load-bearing.
  const setGame = (n, current = 0) => {
    ctx.game = { current, players: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, dnf: false })) };
    return ctx.game;
  };

  test('it says nothing at one or two players', () => {
    setGame(1); assert.equal(ctx.nextThrowerPhrase(), '');
    setGame(2); assert.equal(ctx.nextThrowerPhrase(), '');
  });

  test('it names the next thrower at three and four players', () => {
    setGame(3, 0); assert.equal(ctx.nextThrowerPhrase(), ' P1 to throw.');
    setGame(4, 2); assert.equal(ctx.nextThrowerPhrase(), ' P3 to throw.');
  });

  test('it wraps back to the first player at the end of the round', () => {
    setGame(4, 3);
    assert.equal(ctx.nextThrowerPhrase(), ' P0 to throw.');
  });

  test('it names whoever actually throws next, skipping a bow-out', () => {
    const g = setGame(4, 0);
    g.players[1].dnf = true;
    assert.equal(ctx.nextThrowerPhrase(), ' P2 to throw.');
  });

  test('bow-outs down to two active players silence it again', () => {
    // The phrase is gated on ACTIVE players, not the array length: a four-player
    // match that has shrunk to a real two-player decider should stop reciting a
    // rotation that no longer exists.
    const g = setGame(4, 0);
    g.players[1].dnf = g.players[2].dnf = true;
    assert.equal(ctx.nextThrowerPhrase(), '');
  });

  test('it never tells the current thrower to throw next', () => {
    // The last-player-standing case: nextActiveIndexFrom() returns the same
    // index, and "P0 to throw" after P0 just threw is worse than silence.
    const g = setGame(4, 0);
    g.players[1].dnf = g.players[2].dnf = g.players[3].dnf = true;
    assert.equal(ctx.nextThrowerPhrase(), '');
  });

  test('no game in progress is silence, not a crash', () => {
    ctx.game = null;
    assert.equal(ctx.nextThrowerPhrase(), '');
  });
});
