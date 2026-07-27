'use strict';
// Committed tests for every game mode's leg/game-complete panel spec
// (/frontend-design direction D, "Trophy Cabinet", extended from X01 practice to
// the rest of the modes, 2026-07).
//
// A panel spec is a CALCULATION, not markup: an MPR, a count of 9-mark rounds, a
// count of full houses, how many stations came back clean. That is exactly the
// class of thing the project convention says must ship with a re-runnable test
// in the same change, so this file evaluates the real spec functions — lifted
// out of index.html by brace-matching, since that file has no module boundary —
// against hand-built game states and checks the numbers.
//
// The recurring bug shape these are here to catch is an index/filter mismatch:
// a tally computed over a FILTERED array while its index is still being read as
// a round number. Bob's 27's full-house count is written that way on purpose in
// the test below, and Baseball's/Shanghai's shelves have the same hazard.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const scoring = require('../../frontend/scoring.js');
const INDEX = path.join(__dirname, '..', '..', 'frontend', 'index.html');
const src = fs.readFileSync(INDEX, 'utf8');

// Brace-match one top-level `function name(...){ … }` out of index.html.
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

const SPECS = ['panelLeadPlayer', 'panelPlayerTitle', 'panelHeroesByPlayer', 'panelBestVisitCells',
  'panelResultCell', 'x01H2hPanelSpec', 'cricketPanelSpec', 'baseballPanelSpec', 'shanghaiPanelSpec',
  'halveItPanelSpec', 'pressureChamberPanelSpec', 'killerPanelSpec', 'bobs27PanelSpec',
  'gauntletPanelSpec', 'deadManWalkingPanelSpec', 'aroundTheClockPanelSpec', 'aroundTheWorldPanelSpec'];

// The presentational helpers the specs lean on. Only the three that live in
// index.html rather than scoring.js are stubbed; everything else below is the
// real shared implementation, so a formula change in scoring.js fails here too.
const SANDBOX_PRELUDE = `
  let game = null;
  const avgStr = (points, darts) => darts ? (points / darts * 3).toFixed(2) : '—';
  const cricketNumberLabel = n => n === 25 ? 'Bull' : String(n);
  const halveItTargetLabel = t => String(t && t.label != null ? t.label : t);
  const statRow = (label, value) => ({ label, value });
  const dmwDifficultyLabel = () => 'Hard';
  // h2hPanelColumns() is exercised through the real thing in the browser suite;
  // here it is stubbed so a spec's OWN numbers (heroes, shelf, tallies) are what
  // these assertions are reading.
  const h2hPanelColumns = (winner, scope) => game.players.map(p => ({ title: p.name, rowsHtml: [] }));
`;

function buildSandbox() {
  const deps = {
    pracAggregate: scoring.pracAggregate,
    CRICKET_STANDARD_NUMBERS: scoring.CRICKET_STANDARD_NUMBERS,
    HALVE_IT_DEFAULT_TARGETS: scoring.HALVE_IT_DEFAULT_TARGETS,
    halveItRoundTarget: scoring.halveItRoundTarget,
    PRESSURE_ROUNDS: scoring.PRESSURE_ROUNDS,
    pressureComposureRating: scoring.pressureComposureRating,
    gauntletTotalScars: scoring.gauntletTotalScars,
    gauntletResultTier: scoring.gauntletResultTier,
    GAUNTLET_STATION_ORDER: scoring.GAUNTLET_STATION_ORDER,
    deadManWalkingResultTier: scoring.deadManWalkingResultTier,
  };
  const names = Object.keys(deps);
  const body = SANDBOX_PRELUDE + SPECS.map(extract).join('\n')
    + `\nreturn { setGame: g => { game = g; }, ${SPECS.join(', ')} };`;
  return new Function(...names, body)(...names.map(n => deps[n]));
}

const S = buildSandbox();
// Every spec reads the module-level `game`; the ones that also take it as a
// parameter get the same object, exactly as the real registry dispatch does.
const withGame = (g, fn) => { S.setGame(g); return fn(g); };

describe('the shelf never lies about which cells were played', () => {
  test('an unreached cell is dim and says so in words, not by colour', () => {
    // Colour alone is never allowed to carry a state on this panel
    // (docs/accessibility-roadmap.md), so every cell carries a caption too.
    const cell = S.panelResultCell('D7', false, false, 'not reached');
    assert.equal(cell.state, 'dim');
    assert.equal(cell.caption, 'not reached');
  });

  test('a settled cell is ok or no, never dim', () => {
    assert.equal(S.panelResultCell(1, true, true, 'clean').state, 'ok');
    assert.equal(S.panelResultCell(1, true, false, '2 scars').state, 'no');
  });
});

describe("Bob's 27 — the tallies count rounds, not positions in a filtered list", () => {
  const bobs = roundResults => ({
    players: [{ name: 'Ben', running: 27, roundResults }],
  });

  test('a full house is three darts in that round\'s own double', () => {
    // D3 full house = 3 × 2 × 3 = 18; D5 full house = 30. The bug this pins is
    // counting over the array with the misses filtered OUT, where index 1 is no
    // longer round 2 and the arithmetic silently stops meaning anything.
    const spec = withGame(bobs({ 1: 0, 2: 0, 3: 18, 4: 8, 5: 30 }), S.bobs27PanelSpec);
    const fullHouses = spec.tallies.find(t => t.label === 'full houses');
    assert.equal(fullHouses.value, 2, 'D3 and D5, and not the 8 on D4');
  });

  test('a round not yet reached is neither a full house nor a missed double', () => {
    const spec = withGame(bobs({ 1: 4, 2: 0 }), S.bobs27PanelSpec);
    assert.equal(spec.tallies.find(t => t.label === 'missed doubles').value, 1);
    assert.equal(spec.tallies.find(t => t.label === 'best round').value, 4);
    assert.equal(spec.shelf.cells.length, 20, 'all twenty doubles are always shown');
    assert.equal(spec.shelf.cells[19].caption, 'not reached');
    assert.equal(spec.shelf.cells[1].caption, '−4', 'a missed D2 costs its own value');
  });

  test('the hero states survival by the final score, not by the round reached', () => {
    const alive = withGame(bobs({ 1: 4 }), S.bobs27PanelSpec);
    assert.match(alive.heroes[0].sub, /survived/);
    const dead = { players: [{ name: 'Ben', running: -6, roundResults: { 1: 0 } }] };
    assert.match(withGame(dead, S.bobs27PanelSpec).heroes[0].sub, /bust/);
  });
});

describe('The Gauntlet — scars, clean stations and the streak', () => {
  const run = (finalMisses, bestStreak = 0) => ({
    players: [{ name: 'Ben' }], gauntletFinalMisses: finalMisses, gauntletBestCleanStreak: bestStreak,
  });

  test('a part-finished run counts only the stations actually settled', () => {
    const spec = withGame(run([0, 0, 2, 0]), S.gauntletPanelSpec);
    assert.equal(spec.tallies.find(t => t.label === 'clean stations').value, 3);
    assert.equal(spec.tallies.find(t => t.label === 'scars').value, 2);
    assert.equal(spec.heroes[1].value, '3/4', 'clean out of SETTLED, not out of 20');
    assert.equal(spec.shelf.cells.length, 20);
    assert.equal(spec.shelf.cells[4].caption, 'not reached');
  });

  test('a flawless run is 0 scars and every cell clean', () => {
    const spec = withGame(run(new Array(20).fill(0), 20), S.gauntletPanelSpec);
    assert.equal(spec.heroes[0].value, 0);
    assert.equal(spec.heroes[1].value, '20/20');
    assert.ok(spec.shelf.cells.every(c => c.state === 'ok'));
  });
});

describe('Dead Man Walking — fifteen rounds, survived or not', () => {
  const runOf = results => ({
    players: [{ name: 'Ben' }], config: { difficulty: 'hard' },
    dmwRoundResults: results, dmwBestStreak: 2,
    dmwWalkedOutCount: results.filter(r => r.walkedOut).length,
  });

  test('walked out and executed always sum to the rounds actually settled', () => {
    const spec = withGame(runOf([
      { target: 61, walkedOut: true, darts: 4 },
      { target: 84, walkedOut: false, darts: 6 },
      { target: 110, walkedOut: true, darts: 5 },
    ]), S.deadManWalkingPanelSpec);
    assert.equal(spec.tallies.find(t => t.label === 'walked out').value, 2);
    assert.equal(spec.tallies.find(t => t.label === 'executed').value, 1);
    assert.equal(spec.heroes[0].value, '2/15');
  });

  test('highest cleared is the biggest target WALKED OUT, not merely attempted', () => {
    // 170 was attempted and lost; the panel must not claim it as cleared.
    const spec = withGame(runOf([
      { target: 110, walkedOut: true, darts: 5 },
      { target: 170, walkedOut: false, darts: 8 },
    ]), S.deadManWalkingPanelSpec);
    assert.equal(spec.tallies.find(t => t.label === 'highest cleared').value, 110);
  });

  test('a run with nothing cleared reports 0, not NaN from an empty Math.max', () => {
    const spec = withGame(runOf([{ target: 61, walkedOut: false, darts: 3 }]), S.deadManWalkingPanelSpec);
    assert.equal(spec.tallies.find(t => t.label === 'highest cleared').value, 0);
  });

  test('the shelf always shows fifteen cells, unreached ones dim', () => {
    const spec = withGame(runOf([{ target: 61, walkedOut: true, darts: 3 }]), S.deadManWalkingPanelSpec);
    assert.equal(spec.shelf.cells.length, 15);
    assert.equal(spec.shelf.cells[0].caption, 'out in 3');
    assert.equal(spec.shelf.cells[1].state, 'dim');
  });
});

describe('Cricket — MPR is the hero, and it is marks over ROUNDS', () => {
  const cricket = (players, numbers) => ({
    players, config: { numbers }, legsPerSet: 1, setsPerGame: 1,
  });
  const player = (name, marks, legRoundMarks, points = 0) =>
    ({ name, marks, legRoundMarks, points, legsWon: 0, setsWon: 0, legDarts: 0 });

  test('MPR averages the per-visit marks log, including zero-mark visits', () => {
    // 5 + 0 + 4 over three visits = 3.00. Dropping the blank visit would report
    // 4.50 — a flattering number that no darts scoreboard anywhere would show.
    const g = cricket([player('Ben', { 20: 3, 19: 3 }, [5, 0, 4], 20)], [20, 19, 18, 17, 16, 15, 25]);
    const spec = withGame(g, (gg) => S.cricketPanelSpec(gg, 'Ben', 'leg'));
    assert.equal(spec.heroes[0].value, '3.00');
    assert.equal(spec.tallies.find(t => t.label === 'rounds thrown').value, 3);
    assert.equal(spec.tallies.find(t => t.label === 'best round (marks)').value, 5);
  });

  test('a 9-mark round needs nine marks, so eight is not one', () => {
    const g = cricket([player('Ben', {}, [9, 8, 9])], [20, 19, 18, 17, 16, 15, 25]);
    const spec = withGame(g, (gg) => S.cricketPanelSpec(gg, 'Ben', 'leg'));
    assert.equal(spec.tallies.find(t => t.label === '9-mark rounds').value, 2);
  });

  test('a leg with no visits yet reports an em dash, not NaN or 0.00', () => {
    const g = cricket([player('Ben', {}, [])], [20, 19, 18, 17, 16, 15, 25]);
    const spec = withGame(g, (gg) => S.cricketPanelSpec(gg, 'Ben', 'leg'));
    assert.equal(spec.heroes[0].value, '—');
  });

  test('the shelf names who closed each number, and says "open" when nobody has', () => {
    const g = cricket([
      player('Ben', { 20: 3, 19: 1, 18: 0, 17: 0, 16: 0, 15: 0, 25: 0 }, [3]),
      player('Sam', { 20: 3, 19: 3, 18: 0, 17: 0, 16: 0, 15: 0, 25: 0 }, [3]),
    ], [20, 19, 18, 17, 16, 15, 25]);
    const spec = withGame(g, (gg) => S.cricketPanelSpec(gg, 'Ben', 'leg'));
    const byLabel = Object.fromEntries(spec.shelf.cells.map(c => [String(c.label), c]));
    assert.equal(byLabel['20'].caption, 'all closed');
    assert.equal(byLabel['19'].caption, 'Sam');
    assert.equal(byLabel['18'].caption, 'open');
    assert.equal(byLabel['18'].state, 'dim');
    assert.equal(byLabel.Bull.caption, 'open', 'the bull is labelled by name, not as 25');
    assert.equal(spec.shelf.cells.length, 7, 'a Cricket shelf is always exactly seven numbers');
  });

  test('a custom seven is honoured instead of the standard set', () => {
    const nums = [10, 11, 12, 13, 14, 15, 25];
    const marks = Object.fromEntries(nums.map(n => [n, 0]));
    const spec = withGame(cricket([player('Ben', marks, [2])], nums), (gg) => S.cricketPanelSpec(gg, 'Ben', 'leg'));
    assert.deepEqual(spec.shelf.cells.map(c => String(c.label)), ['10', '11', '12', '13', '14', '15', 'Bull']);
  });
});

describe('Baseball / Shanghai — the winner\'s own card, round by round', () => {
  test('a perfect inning is 9 runs, and an unplayed inning is neither perfect nor scoreless', () => {
    const g = { players: [{ name: 'Ben', totalRuns: 15, inningRuns: { 1: 9, 2: 0, 3: 6 }, legDarts: 9 }],
      baseballInning: 4, legsPerSet: 1, setsPerGame: 1 };
    const spec = withGame(g, (gg) => S.baseballPanelSpec(gg, 'Ben', 'leg'));
    assert.equal(spec.tallies.find(t => t.label === 'perfect innings').value, 1);
    assert.equal(spec.tallies.find(t => t.label === 'scoreless innings').value, 1);
    assert.equal(spec.tallies.find(t => t.label === 'best inning').value, 9);
    assert.equal(spec.shelf.cells.length, 9, 'a nine-inning card, always');
    assert.equal(spec.shelf.cells[3].caption, 'not played');
    assert.equal(spec.shelf.cells[1].caption, '0 runs', 'a scoreless inning WAS played');
    assert.equal(spec.shelf.cells[1].state, 'no');
  });

  test('Shanghai reports its best round over the rounds actually thrown', () => {
    const g = { players: [{ name: 'Ben', totalPoints: 80, roundPoints: { 1: 20, 2: 0, 3: 60 }, legDarts: 9 }],
      config: { rounds: 7 }, legsPerSet: 1, setsPerGame: 1 };
    const spec = withGame(g, (gg) => S.shanghaiPanelSpec(gg, 'Ben', 'leg'));
    assert.equal(spec.tallies.find(t => t.label === 'best round').value, 60);
    assert.equal(spec.tallies.find(t => t.label === 'blank rounds').value, 1);
    assert.equal(spec.shelf.cells.length, 7);
    assert.equal(spec.shelf.cells[6].caption, 'not played');
  });
});

describe('Halve-It — a halved round is stated in words, not implied by a drop', () => {
  test('the tally counts halved rounds and the clean-card flag is all-or-nothing', () => {
    const g = { players: [{ name: 'Ben', total: 120, everHalved: true,
      roundTotals: { 1: 60, 2: 30, 3: 120 }, roundHalved: { 2: true } }],
      config: { targets: [15, 16, 'D'] }, legsPerSet: 1, setsPerGame: 1 };
    const spec = withGame(g, (gg) => S.halveItPanelSpec(gg, 'Ben', 'leg'));
    assert.equal(spec.tallies.find(t => t.label === 'rounds halved').value, 1);
    assert.equal(spec.tallies.find(t => t.label === 'clean cards').value, 0);
    assert.match(spec.shelf.cells[1].caption, /^halved/);
    assert.equal(spec.shelf.cells[1].state, 'no');
    assert.equal(spec.shelf.cells[0].caption, '60', 'an unhalved round shows its running total');
  });

  test('a card that was never halved scores the clean-card tally', () => {
    const g = { players: [{ name: 'Ben', total: 200, everHalved: false, roundTotals: { 1: 200 }, roundHalved: {} }],
      config: { targets: [15] }, legsPerSet: 1, setsPerGame: 1 };
    const spec = withGame(g, (gg) => S.halveItPanelSpec(gg, 'Ben', 'leg'));
    assert.equal(spec.tallies.find(t => t.label === 'clean cards').value, 1);
    assert.match(spec.heroes[0].sub, /never halved/);
  });
});

describe('The Pressure Chamber — full hits, misses and the streak', () => {
  test('partials count as neither a full hit nor a miss', () => {
    const g = { players: [{ name: 'Ben', totalCp: 40, bestFullHitStreak: 2,
      roundResults: { 1: 'full', 2: 'partial', 3: 'miss', 4: 'full' } }],
      config: { rounds: 15 }, legsPerSet: 1, setsPerGame: 1 };
    const spec = withGame(g, (gg) => S.pressureChamberPanelSpec(gg, 'Ben', 'leg'));
    assert.equal(spec.tallies.find(t => t.label === 'full hits').value, 2);
    assert.equal(spec.tallies.find(t => t.label === 'misses').value, 1);
    assert.equal(spec.shelf.cells.length, 15);
    assert.equal(spec.shelf.cells[1].caption, 'partial');
    assert.equal(spec.shelf.cells[1].state, 'no', 'a partial is not a full hit');
    assert.equal(spec.shelf.cells[4].caption, 'not played');
  });
});

describe('Killer — survival, not a score', () => {
  test('an eliminated player reads OUT and the survivors are counted', () => {
    const g = { players: [
      { name: 'Ben', number: 20, lives: 2, kills: 3, eliminated: false, legsWon: 0, setsWon: 0 },
      { name: 'Sam', number: 5, lives: 0, kills: 1, eliminated: true, legsWon: 0, setsWon: 0 },
    ], legsPerSet: 1, setsPerGame: 1 };
    const spec = withGame(g, (gg) => S.killerPanelSpec(gg, 'Ben'));
    assert.equal(spec.heroes[0].value, 2, 'the winner leads');
    assert.equal(spec.heroes[1].value, 'OUT');
    assert.equal(spec.tallies.find(t => t.label === 'survivors').value, 1);
    assert.equal(spec.tallies.find(t => t.label === 'kills').value, 4, 'kills are the whole table\'s');
    assert.equal(spec.shelf.cells[1].state, 'no');
  });
});

describe('Around the Clock / Around the World — the two guided drills', () => {
  test('the Clock has no shelf at all, by design', () => {
    // Twenty cells that are "hit" by definition would say nothing — the reason
    // completionPanelHtml() makes the shelf optional in the first place.
    const g = { players: [{ name: 'Ben', roundDarts: 60, roundTrebles: 4, roundDoubles: 6,
      roundMisses: 12, roundStartedAt: Date.now() - 120000 }] };
    const spec = withGame(g, S.aroundTheClockPanelSpec);
    assert.equal(spec.shelf, undefined);
    assert.equal(spec.heroes[0].value, 60);
    assert.equal(spec.tallies.find(t => t.label === 'darts per number').value, '3.0');
  });

  test('the World counts each number out of its three outcomes', () => {
    const hit = new Set(['1:1', '1:2', '1:3', '2:1', '25:1', '25:2', '0:1']);
    const g = { players: [{ name: 'Ben', sessionDarts: 90, sessionHitSet: hit }] };
    const spec = withGame(g, S.aroundTheWorldPanelSpec);
    assert.equal(spec.shelf.cells[0].caption, '3/3');
    assert.equal(spec.shelf.cells[0].state, 'ok');
    assert.equal(spec.shelf.cells[1].caption, '1/3');
    assert.equal(spec.shelf.cells[1].state, 'no', 'started is not finished');
    assert.equal(spec.shelf.cells[2].state, 'dim', 'untouched');
    assert.equal(spec.tallies.find(t => t.label === 'bulls hit').value, 2);
    assert.equal(spec.tallies.find(t => t.label === 'miss logged').value, 1);
    assert.equal(spec.heroes[1].value, '7/63');
  });

  test('the World\'s special-outcome keys match the progress grid\'s exactly', () => {
    // buildOutcomeGridHtml() reads the same sessionHitSet with 25:1 / 25:2 / 0:1;
    // a panel using different keys would silently report zero bulls forever.
    for (const key of ['25:1', '25:2', '0:1']) {
      assert.ok(src.includes(`\`${key}\``) || src.includes(`'${key}'`),
        `${key} is not spelled the same in index.html any more`);
    }
  });
});

describe('X01 head-to-head — the leg scope and the match scope', () => {
  const p = (name, o) => Object.assign({ name, legPoints: 0, legAvgDarts: 0, gamePoints: 0,
    gameAvgDarts: 0, legDarts: 0, gameDarts: 0, legsWon: 0, setsWon: 0 }, o);
  const turn = (scored, opts = {}) => Object.assign({ scored, darts: 3, bust: false, trebleLess: false,
    checkout: false, checkoutPoints: null }, opts);

  test('the leg panel reads the leg average and the match panel the match one', () => {
    const g = {
      players: [p('Ben', { legPoints: 501, legAvgDarts: 15, gamePoints: 1002, gameAvgDarts: 33 }),
                p('Sam', { legPoints: 400, legAvgDarts: 15, gamePoints: 800, gameAvgDarts: 33 })],
      currentLegTurns: [turn(140), turn(180), turn(100)],
      sessionTurns: [turn(140), turn(180), turn(100), turn(60), turn(40, { checkout: true, checkoutPoints: 40 })],
      legsPerSet: 1, setsPerGame: 1,
    };
    const leg = withGame(g, (gg) => S.x01H2hPanelSpec(gg, 'Ben', 'leg'));
    assert.equal(leg.heroes[0].title, 'Ben 🎯', 'the winner leads and is marked');
    assert.equal(leg.heroes[0].value, '100.20');
    // The 180 tally's LABEL is singular at one, so it is found by its emoji.
    assert.equal(leg.tallies.find(t => t.emoji === '🎯').value, 1);
    assert.equal(leg.tallies.find(t => t.emoji === '🎯').label, '180');
    assert.equal(leg.tallies.find(t => t.label === 'best checkout').value, 0, 'no finish in these three visits');

    const match = withGame(g, (gg) => S.x01H2hPanelSpec(gg, 'Ben', 'game'));
    assert.equal(match.heroes[0].value, '91.09');
    assert.equal(match.tallies.find(t => t.label === 'best checkout').value, 40);
    assert.match(match.shelf.title, /match/);
  });

  test('a solo drill\'s hero carries no winner marker — there was nobody to beat', () => {
    const g = { players: [p('Ben', { legPoints: 501, legAvgDarts: 15 })],
      currentLegTurns: [turn(60)], sessionTurns: [turn(60)], legsPerSet: 1, setsPerGame: 1 };
    const spec = withGame(g, (gg) => S.x01H2hPanelSpec(gg, 'Ben', 'leg'));
    assert.equal(spec.heroes[0].title, 'Ben');
  });

  test('three or more players all get a hero card, sized to fit', () => {
    const g = { players: ['Ben', 'Sam', 'Ali'].map(n => p(n, { legPoints: 300, legAvgDarts: 12 })),
      currentLegTurns: [], sessionTurns: [], legsPerSet: 1, setsPerGame: 1 };
    const spec = withGame(g, (gg) => S.x01H2hPanelSpec(gg, 'Sam', 'leg'));
    assert.equal(spec.heroes.length, 3);
    assert.equal(spec.heroes[0].title, 'Sam 🎯', 'winner first, whatever the seat order');
    assert.ok(spec.heroes.every(h => h.small), 'the numerals shrink past two players');
  });

  test('an empty leg shows a placeholder shelf rather than an empty strip', () => {
    const g = { players: [p('Ben')], currentLegTurns: [], sessionTurns: [], legsPerSet: 1, setsPerGame: 1 };
    const spec = withGame(g, (gg) => S.x01H2hPanelSpec(gg, 'Ben', 'leg'));
    assert.equal(spec.shelf.cells.length, 1);
    assert.equal(spec.shelf.cells[0].label, 'no visits yet');
  });
});

describe('the per-visit logs the panels read are undone with the visit', () => {
  // A tracking array that is pushed on commit but not truncated on undo leaves a
  // phantom visit behind — which is invisible during play and only shows up as a
  // wrong MPR or an extra "round thrown" on the completion screen, long after
  // the undo that caused it.
  test('Cricket\'s per-visit marks log is snapshotted and restored', () => {
    assert.ok(/roundMarksLen:\s*p\.legRoundMarks\.length/.test(src),
      'the Cricket snapshot no longer records legRoundMarks.length');
    assert.ok(/p\.legRoundMarks\.length\s*=\s*snap\.roundMarksLen;/.test(src),
      'undoLastTurnCricket() no longer truncates legRoundMarks — an undone visit would still count toward MPR');
    assert.ok(/p\.legRoundMarks\s*=\s*\[\];/.test(src),
      'resetPlayerForNextLegCricket() no longer clears legRoundMarks — MPR would span legs');
  });
});

describe('every real game type either declares a panel or says why not', () => {
  // The registry is the whole point of this design: a new game type that quietly
  // shows no completion screen — the exact state Cricket shipped in — is a
  // regression, not a default.
  test('no mode is left with neither a completionPanel nor noCompletionStats', () => {
    const registryStart = src.indexOf('const GAME_TYPES = {');
    assert.ok(registryStart > -1);
    const tail = src.slice(registryStart);
    const ids = [...tail.matchAll(/^  ([a-z_0-9]+): \{\n    id: '\1',/gm)].map(m => m[1]);
    assert.ok(ids.length >= 16, `expected the full registry, found ${ids.length}`);
    for (const id of ids) {
      const start = tail.indexOf(`  ${id}: {`);
      const end = tail.indexOf('\n  },', start);
      const entry = tail.slice(start, end);
      assert.ok(/completionPanel:|noCompletionStats:/.test(entry),
        `${id} declares neither completionPanel nor noCompletionStats — its completion screen would be blank`);
    }
  });
});
