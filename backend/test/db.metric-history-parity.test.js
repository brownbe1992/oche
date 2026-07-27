'use strict';
// getMetricHistory() must agree with the stat bubble it sits under
// (docs/open-roadmap-items.md item 73; `REFERENCE.md` §3 states the requirement
// and §22 names divergence between them as a bug signal).
//
// The Player Profile shows a number and, directly beneath it, a chart of the
// same number over time. They are computed by two entirely separate SQL
// queries. Nothing has ever enforced that they agree, and the pairing has now
// produced two real bugs in production code:
//
//   - `avgdartsperleg` was missing `X01_ONLY`, so Checkout Ladder and Dead Man
//     Walking legs (which also set `checkout=1`) leaked into the chart but not
//     the bubble;
//   - `pace` used `NOT_HYPOTHETICAL_DARTS` where the bubble used
//     `NOT_CONTINUOUS_STREAM`, so guided Around the World's rapid-fire rhythm
//     counted in the chart only — measured at 41 darts/min against the bubble's
//     3, on the same screen, with nothing to say which was right (BUG-31).
//
// Both were found by a person noticing two numbers disagree. This file is what
// replaces that. `db.pace-parity.test.js` did it for one metric; this does it
// for every metric that has both halves.
//
// **The pair list is derived from the app's own key maps, not written out
// here.** `frontend/index.html` already declares which chart metric belongs to
// which bubble field (`STAT_DEFS` + `BUBBLE_KEY_MAP`, and the per-mode
// equivalents), so a metric added there arrives with a parity assertion already
// pointing at it — the same registry-driven discipline the app uses internally
// instead of hand-maintained parallel lists. A list kept here would be a third
// copy, and the third copy is always the one that goes stale.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let db, scratchDir;

const INDEX = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
const DB_SRC = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');

/* ---------------------------------------------------------------------------
   Deriving the pairs from index.html
   --------------------------------------------------------------------------- */

// `const NAME_STAT_DEFS = [ … ]` → the list of chart-metric keys, in order.
function statDefKeys(constName) {
  const i = INDEX.indexOf(`const ${constName} = [`);
  assert.ok(i > -1, `${constName} not found in index.html — renamed?`);
  const body = INDEX.slice(i, INDEX.indexOf('\n];', i));
  return [...body.matchAll(/\{\s*key:\s*'([^']+)'/g)].map(m => m[1]);
}

// `const NAME_BUBBLE_KEY_MAP = { metric:'bubbleField', … }` → the translation.
// A metric absent from the map uses the same name on both sides.
function bubbleKeyMap(constName) {
  const i = INDEX.indexOf(`const ${constName} = {`);
  assert.ok(i > -1, `${constName} not found in index.html — renamed?`);
  const body = INDEX.slice(i, INDEX.indexOf('};', i));
  const out = {};
  for (const m of body.matchAll(/'?([A-Za-z0-9_]+)'?\s*:\s*'([A-Za-z0-9_]+)'/g)) out[m[1]] = m[2];
  return out;
}

// Only metrics getMetricHistory() actually implements have a chart at all. The
// rest (Shanghai, Halve-It, Pressure Chamber, Bob's 27, Checkout Ladder, the
// Gauntlet, Killer, Dead Man Walking, Checkout Trainer, Marathon) are
// bubble-only by design and have nothing to agree with.
const hasHistoryArm = metric => new RegExp(`case '${metric}':`).test(DB_SRC);

/* ---------------------------------------------------------------------------
   Fixture
   --------------------------------------------------------------------------- */

const NAME = 'Parity';
const OPP = 'ParityOpp';
const stamp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
const T0 = Date.parse('2026-07-01T10:00:00Z');

const darts = (n, sector = 20, mult = 1) =>
  Array.from({ length: n }, () => ({ sector, multiplier: mult }));

function game(opts) {
  const g = db.createGame(Object.assign({ legsPerSet: 1, setsPerGame: 1 }, opts));
  return g.gameId != null ? g.gameId : g.id;
}

function seed() {
  db.addPlayer(NAME);
  db.addPlayer(OPP);

  // --- X01, practice. A real 501 leg: an opening 180, a treble-less visit, a
  // bust, and a 170 checkout (so bigfish, ninedarters' shape, first3/first9,
  // 140/leg, 100+ AVG and darts/leg all have something to read).
  const x = game({ category: '501', practice: 1, gameType: 'x01',
    config: { startingScore: 501 }, players: [{ name: NAME, out: 'double' }] });
  db.addTurn(x, { player: NAME, set: 1, leg: 1, scored: 180, darts: darts(3, 20, 3) });
  db.addTurn(x, { player: NAME, set: 1, leg: 1, scored: 60, darts: darts(3, 20, 1) });
  db.addTurn(x, { player: NAME, set: 1, leg: 1, scored: 0, bust: true, darts: darts(2, 5, 1) });
  db.addTurn(x, { player: NAME, set: 1, leg: 1, scored: 170, checkout: true, checkoutPoints: 170,
    legWon: true, darts: [{ sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }, { sector: 25, multiplier: 2 }] });

  // A second, trebleless 501 leg, so trebleless % and 180s/leg are fractions
  // rather than 0 or 100 — a metric that reads 0 on both sides agrees for the
  // wrong reason.
  const x2 = game({ category: '501', practice: 1, gameType: 'x01',
    config: { startingScore: 501 }, players: [{ name: NAME, out: 'double' }] });
  db.addTurn(x2, { player: NAME, set: 1, leg: 1, scored: 41, darts: darts(3, 20, 1) });
  db.addTurn(x2, { player: NAME, set: 1, leg: 1, scored: 60, checkout: true, checkoutPoints: 60,
    legWon: true, darts: darts(3, 20, 1) });

  // Per-dart timing, for `pace`. 20s between darts — a match-like rhythm.
  const xp = game({ category: '501', practice: 1, gameType: 'x01',
    config: { startingScore: 501 }, players: [{ name: NAME, out: 'double' }] });
  db.recordTurn(xp, { player: NAME, set: 1, leg: 1, scored: 60, darts: [
    { sector: 20, multiplier: 1, thrownAt: stamp(T0) },
    { sector: 20, multiplier: 1, thrownAt: stamp(T0 + 20000) },
    { sector: 20, multiplier: 1, thrownAt: stamp(T0 + 40000) },
  ] });

  // --- X01, head-to-head. Present so the mode filter is exercised rather than
  // being a no-op: a metric that dropped `${modeWhere}` on one side only would
  // pass every assertion below against a practice-only fixture.
  const h = game({ category: '501', practice: 0, gameType: 'x01',
    config: { startingScore: 501 },
    players: [{ name: NAME, out: 'double' }, { name: OPP, out: 'double' }] });
  db.addTurn(h, { player: NAME, set: 1, leg: 1, scored: 100, darts: darts(3, 20, 1) });
  db.addTurn(h, { player: NAME, set: 1, leg: 1, scored: 40, checkout: true, checkoutPoints: 40,
    legWon: true, darts: darts(2, 20, 1) });
  db.addTurn(h, { player: OPP, set: 1, leg: 1, scored: 60, darts: darts(3, 20, 1) });

  // --- Cricket, Baseball: their own metric families.
  const c = game({ category: 'Cricket', practice: 1, gameType: 'cricket',
    config: { numbers: [15, 16, 17, 18, 19, 20, 25] }, players: [{ name: NAME }] });
  db.addTurn(c, { player: NAME, set: 1, leg: 1, scored: 60, legWon: true, darts: darts(3, 20, 3) });
  db.addTurn(c, { player: NAME, set: 1, leg: 1, scored: 20, darts: darts(3, 20, 1) });
  db.completeGame(c, NAME);   // so cricketgames/cricketwinpct read a real number

  const b = game({ category: 'Baseball', practice: 1, gameType: 'baseball',
    config: {}, players: [{ name: NAME }] });
  db.addTurn(b, { player: NAME, set: 1, leg: 1, scored: 9, darts: darts(3, 1, 3) });
  db.addTurn(b, { player: NAME, set: 1, leg: 1, scored: 4, darts: darts(3, 2, 2) });
  db.completeGame(b, NAME);

  // --- The three drills with chart metrics.
  const dp = game({ category: 'Doubles Practice', practice: 1, gameType: 'doubles_practice',
    config: { doubles: [20] }, players: [{ name: NAME }] });
  db.addTurn(dp, { player: NAME, set: 1, leg: 1, scored: 0, darts: [{ sector: 20, multiplier: 2 }] });
  db.addTurn(dp, { player: NAME, set: 1, leg: 1, scored: 0, darts: [{ sector: 20, multiplier: 1 }] });

  const ch = game({ category: "Just Chuckin' It", practice: 1, gameType: 'chuckin',
    config: {}, players: [{ name: NAME }] });
  for (let i = 0; i < 6; i++) {
    db.addTurn(ch, { player: NAME, set: 1, leg: 1, scored: 0,
      darts: [{ sector: 20, multiplier: i % 2 === 0 ? 3 : 1 }] });
  }

  const atc = game({ category: 'Guided Around the Clock', practice: 1, gameType: 'around_the_clock',
    config: {}, players: [{ name: NAME }] });
  for (let n = 1; n <= 20; n++) {
    db.addTurn(atc, { player: NAME, set: 1, leg: 1, scored: 0, bust: n === 20,
      darts: [{ sector: n, multiplier: 1 }] });
  }

  // Guided Around the World, thrown at ONE SECOND between darts and carrying
  // real timestamps. This is BUG-31's exact shape and it is load-bearing: the
  // `pace` bubble and chart only diverge if a rapid-fire drill has timing data
  // to leak. Without stamps here, both sides read the X01 rhythm and the parity
  // assertion passes no matter which exclusion constant either side uses.
  const atw = game({ category: 'Guided Around the World', practice: 1, gameType: 'around_the_world',
    config: {}, players: [{ name: NAME }] });
  for (let n = 0; n < 5; n++) {
    const base = T0 + 3600000 + n * 10000;
    db.recordTurn(atw, { player: NAME, set: 1, leg: 1, scored: 0, darts: [
      { sector: n + 1, multiplier: 1, thrownAt: stamp(base) },
      { sector: n + 1, multiplier: 2, thrownAt: stamp(base + 1000) },
      { sector: n + 1, multiplier: 3, thrownAt: stamp(base + 2000) },
    ] });
  }

  // A 121 Checkout Ladder attempt that CHECKS OUT. Also load-bearing: this mode
  // sets checkout=1 on a non-X01 turn, which is the only thing that makes
  // avgdartsperleg's X01_ONLY scoping observable at all. Without it, dropping
  // X01_ONLY from either side changes nothing and the parity holds falsely.
  const cl = game({ category: '121 Checkout Ladder', practice: 1, gameType: 'checkout_ladder',
    config: {}, players: [{ name: NAME, out: 'double' }] });
  db.addTurn(cl, { player: NAME, set: 1, leg: 1, scored: 61, darts: darts(3, 20, 1) });
  db.addTurn(cl, { player: NAME, set: 1, leg: 1, scored: 60, checkout: true, checkoutPoints: 60,
    legWon: true, darts: darts(3, 20, 1) });
}

before(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-parity-'));
  process.env.DARTS_DB = path.join(scratchDir, 'test.db');
  db = require('../db.js');
  seed();
});
after(() => { try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) {} });

/* ---------------------------------------------------------------------------
   The families
   --------------------------------------------------------------------------- */

// Every metric family that has BOTH a chart arm and a stat-bubble function.
// `bubbles` is called with (playerName, mode); `mode` is the tab the fixture's
// data for that family lives under.
const FAMILIES = [
  { label: 'X01', defs: 'STAT_DEFS', map: 'BUBBLE_KEY_MAP',
    bubbles: (n, m) => db.getPlayerStatBubbles(n, m), mode: 'practice',
    // dartsthrown/avgdartsperday are the documented exception: the BUBBLE is
    // lifetime and all-modes (Player Profile header, REFERENCE.md's
    // "Physical-dart stats"), while the CHART is mode-scoped like every other
    // arm. They are asserted separately below, as a sum rather than an equality.
    skip: ['dartsthrown', 'avgdartsperday'] },
  { label: 'Cricket', defs: 'CRICKET_STAT_DEFS', map: 'CRICKET_BUBBLE_KEY_MAP',
    bubbles: (n, m) => db.getCricketStatBubbles(n, m), mode: 'practice' },
  { label: 'Baseball', defs: 'BASEBALL_STAT_DEFS', map: 'BASEBALL_BUBBLE_KEY_MAP',
    bubbles: (n, m) => db.getBaseballStatBubbles(n, m), mode: 'practice' },
  { label: 'Doubles Practice', defs: 'DOUBLES_PRACTICE_STAT_DEFS', map: 'DOUBLES_PRACTICE_BUBBLE_KEY_MAP',
    bubbles: (n, m) => db.getDoublesPracticeStatBubbles(n, m), mode: 'practice' },
  { label: "Just Chuckin' It", defs: 'CHUCKIN_STAT_DEFS', map: 'CHUCKIN_BUBBLE_KEY_MAP',
    bubbles: (n, m) => db.getChuckinStatBubbles(n, m), mode: 'practice' },
  { label: 'Around the Clock', defs: 'AROUND_THE_CLOCK_STAT_DEFS', map: 'AROUND_THE_CLOCK_BUBBLE_KEY_MAP',
    bubbles: (n, m) => db.getAroundTheClockStatBubbles(n, m), mode: 'practice' },
  { label: 'Around the World', defs: 'AROUND_THE_WORLD_STAT_DEFS', map: 'AROUND_THE_WORLD_BUBBLE_KEY_MAP',
    bubbles: (n, m) => db.getAroundTheWorldDrillStatBubbles(n, m), mode: 'practice' },
];

// The whole fixture lands in one calendar month, so period 'all' (which buckets
// by month) yields exactly one bucket per metric — which is what makes the
// chart's per-bucket value directly comparable to the bubble's whole-history
// one, with no re-aggregation to get wrong.
const chart = (metric, mode) => db.getMetricHistory(NAME, metric, 'all', { mode });

// Parity compares two SQL expressions that should be identical, so the default
// epsilon is tight. `pace` is the exception: it derives from julianday()
// subtraction, which loses enough precision that 3 darts/min comes back as
// 2.999998 — real for the value check below, irrelevant for parity.
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) < eps;

describe('every charted metric agrees with the bubble above it', () => {
  for (const fam of FAMILIES) {
    test(`${fam.label}`, () => {
      const keys = statDefKeys(fam.defs);
      const map = bubbleKeyMap(fam.map);
      const bubbles = fam.bubbles(NAME, fam.mode);
      assert.ok(bubbles, `${fam.label}: no stat bubbles returned for the fixture`);

      let compared = 0;
      for (const metric of keys) {
        if ((fam.skip || []).includes(metric)) continue;
        if (!hasHistoryArm(metric)) continue;   // bubble-only by design
        const field = map[metric] || metric;
        assert.ok(field in bubbles,
          `${fam.label}.${metric} maps to bubble field "${field}", which ${fam.bubbles.name || 'the bubble function'} does not return`);

        const rows = chart(metric, fam.mode);
        const bubble = bubbles[field];

        // An EMPTY chart is agreement with a null or zero bubble, not a
        // mismatch: a COUNT grouped by month has no row at all for a month
        // with no hits. The converse does not hold — a rate metric returns a
        // bucket containing 0, so "bubble is 0" alone says nothing about
        // whether a bucket should exist. Asserted in that direction only.
        if (rows.length === 0) {
          assert.ok(bubble == null || Number(bubble) === 0,
            `${fam.label}.${metric}: the chart is empty but the bubble reads ${bubble}`);
          continue;
        }
        assert.equal(rows.length, 1,
          `${fam.label}.${metric}: fixture should land in exactly one bucket, got ${rows.length}`);
        assert.ok(bubble != null,
          `${fam.label}.${metric}: the chart has a value (${rows[0].value}) but the bubble is null`);
        assert.ok(near(rows[0].value, bubble),
          `${fam.label}.${metric}: chart ${rows[0].value} vs bubble ${bubble} (field "${field}") — ` +
          'REFERENCE.md §3 requires these to be identical for the same metric');
        compared++;
      }
      assert.ok(compared > 0, `${fam.label}: no metric pairs were compared — did the fixture stop producing data?`);
    });
  }
});

describe('the mode filter is on both sides, not one', () => {
  // A metric that dropped `${modeWhere}` from the chart (or from the bubble)
  // still agrees when every game in the fixture is practice. These read the H2H
  // tab, where the fixture holds a different, smaller set of turns.
  test('X01 metrics agree on the H2H tab too, with different numbers', () => {
    const h2h = db.getPlayerStatBubbles(NAME, 'h2h');
    const practice = db.getPlayerStatBubbles(NAME, 'practice');
    assert.notEqual(h2h.avg, practice.avg, 'the fixture must differ between tabs or this proves nothing');

    for (const metric of ['avg', '180s', 'avgdartsperleg', 'first3avg', 'score140pct']) {
      const rows = chart(metric, 'h2h');
      const field = { '180s': 'one80s', avgdartsperleg: 'avgDartsPerLeg' }[metric] || metric;
      if (rows.length === 0) {
        assert.ok(h2h[field] == null || Number(h2h[field]) === 0,
          `${metric}: the h2h chart is empty but the bubble reads ${h2h[field]}`);
        continue;
      }
      assert.equal(rows.length, 1, `${metric}: expected one H2H bucket`);
      assert.ok(near(rows[0].value, h2h[field]),
        `${metric} (h2h): chart ${rows[0].value} vs bubble ${h2h[field]}`);
    }
  });

  test('the two lifetime bubbles are the sum of their two mode-scoped charts', () => {
    // dartsThrown/avgDartsPerDay are deliberately all-modes in the bubble and
    // mode-scoped in the chart (REFERENCE.md's "Physical-dart stats"). That is a
    // relationship, not an equality, and it is still worth pinning: a scope
    // change on either side breaks the arithmetic.
    const bubble = db.getPlayerStatBubbles(NAME, 'practice').dartsThrown;
    const p = chart('dartsthrown', 'practice');
    const h = chart('dartsthrown', 'h2h');
    const sum = (p[0] ? p[0].value : 0) + (h[0] ? h[0].value : 0);
    assert.equal(sum, bubble,
      `practice (${p[0] && p[0].value}) + h2h (${h[0] && h[0].value}) must equal the lifetime bubble (${bubble})`);
    assert.ok(bubble > 0 && p.length === 1 && h.length === 1, 'both tabs must actually have darts in this fixture');
  });
});

describe('the values are real, not agreeing at zero', () => {
  // Parity alone cannot catch a change that breaks BOTH sides identically —
  // which is exactly how the two historical bugs would have looked if the
  // shared constant itself had been wrong. A handful of hand-checkable numbers
  // from the fixture guard that.
  test('the X01 fixture reads the figures it was built to read', () => {
    const b = db.getPlayerStatBubbles(NAME, 'practice');
    // Leg 1: 180 + 60 + bust(0) + 170 = 410 points over 3+3+3(bust rule)+3 = 12 darts.
    // Leg 2: 41 + 60 = 101 over 6.  Pace leg: 60 over 3.
    assert.equal(b.one80s, 1, 'exactly one 180 in the practice fixture');
    assert.equal(b.bigFish, 1, 'exactly one 170 checkout');
    assert.ok(near(b.avg, (410 + 101 + 60) / (12 + 6 + 3) * 3),
      `3-dart average should be ${(410 + 101 + 60) / (12 + 6 + 3) * 3}, got ${b.avg}`);
    // Two of the three practice legs finished on a checkout (12 and 6 darts);
    // the pace leg has no checkout, so it is not a "won leg".
    assert.ok(near(b.avgDartsPerLeg, (11 + 6) / 2),
      `darts/won leg should be ${(11 + 6) / 2}, got ${b.avgDartsPerLeg}`);
    // Leg 2 is the trebleless one; the pace leg is trebleless too. 2 of 3.
    assert.ok(near(b.treblelessPct, 2 / 3 * 100), `trebleless % should be 66.7, got ${b.treblelessPct}`);
  });

  test('pace reads the fixture\'s 20-second rhythm, not a drill\'s', () => {
    // The BUG-31 shape, re-pinned here against a fixture that also contains
    // Chuckin' and guided Around the World darts: if either leaked in, this
    // reads far higher than 3.
    const rows = chart('pace', 'practice');
    assert.equal(rows.length, 1);
    assert.ok(near(rows[0].value, 3, 1e-3), `expected 3 darts/min, got ${rows[0].value}`);
  });
});

describe('the pair list itself', () => {
  test('every charted metric has a bubble field, and every family was matched', () => {
    // The failure this catches: someone adds a chart arm and a STAT_DEFS entry
    // but no BUBBLE_KEY_MAP line, so the bubble reads `undefined` and renders
    // an em dash under a chart that works.
    const unmatched = [];
    for (const fam of FAMILIES) {
      const map = bubbleKeyMap(fam.map);
      const bubbles = fam.bubbles(NAME, fam.mode) || {};
      for (const metric of statDefKeys(fam.defs)) {
        if ((fam.skip || []).includes(metric)) continue;
        if (!hasHistoryArm(metric)) continue;
        const field = map[metric] || metric;
        if (!(field in bubbles)) unmatched.push(`${fam.label}.${metric} -> ${field}`);
      }
    }
    assert.deepEqual(unmatched, [], `charted metrics with no bubble field: ${unmatched.join(', ')}`);
  });

  test('a metric with no chart arm is bubble-only on purpose, not by omission', () => {
    // Recorded so the set is visible: these families have stat bubbles and no
    // history chart at all. If one of them gains a chart arm, it should also
    // gain a FAMILIES entry above — and this list shrinking is the prompt.
    const chartless = ['shanghaippr', 'halveitavgtotal', 'pcavgcp', 'bobs27avgscore',
      'checkoutladderattempts', 'gauntletrunscompleted', 'killerwinrate',
      'dmwrunscompleted', 'checkouttraineroptimalpct', 'marathonsessions'];
    for (const metric of chartless) {
      assert.equal(hasHistoryArm(metric), false,
        `${metric} now has a getMetricHistory() arm — add its family to FAMILIES so it gets a parity assertion`);
    }
  });
});
