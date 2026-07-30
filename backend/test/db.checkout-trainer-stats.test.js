'use strict';
// Committed tests for backend/db.js's Checkout Trainer stat/leaderboard formulas
// (docs/archive/checkout-trainer-roadmap.md, REFERENCE.md) against a scratch SQLite
// database. Mirrors db.doubles-practice-stats.test.js's structure and its
// physical-dart-stat isolation regression-check pattern, extended to the fifth
// game_type. Not exhaustive; see db.x01-stats.test.js's header comment for the
// same "focused, not 100% coverage" framing.
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

function checkoutTrainerGame(playerName, mode) {
  return db.createGame({
    category: mode === 'blitz' ? 'Checkout Blitz' : 'Checkout Trainer (Freeform)',
    legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'checkout_trainer', config: { mode, durationSec: mode === 'blitz' ? 60 : undefined },
    players: [{ name: playerName }],
  });
}
// Every dart-count attempt is its own turn — bust/checkout/legWon mirror the
// three-way outcome throwDartCheckoutTrainer() writes: bust=1 "not legal",
// checkout=1,legWon=0 "legal but not optimal", checkout=1,legWon=1 "optimal".
function ctTurn(gameId, player, set, leg, targetScore, outcome) {
  const bust = outcome === 'illegal';
  const checkout = outcome !== 'illegal';
  const legWon = outcome === 'optimal';
  db.addTurn(gameId, {
    player, set, leg, scored: 0, bust, checkout, checkoutPoints: null, legWon, targetScore,
    darts: [{ dartNo: 1, sector: 20, multiplier: 2 }],
  });
}

describe('getCheckoutTrainerStatBubbles', () => {
  test('totalAttempts, legalCount, optimalCount, accuracyPct, optimalPct', () => {
    const name = 'CT_Bubbles_A';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');
    ctTurn(g.gameId, name, 1, 2, 32, 'legal');
    ctTurn(g.gameId, name, 1, 3, 100, 'illegal');
    ctTurn(g.gameId, name, 1, 4, 170, 'illegal');

    const bubbles = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(bubbles.totalAttempts, 4);
    assert.equal(bubbles.legalCount, 2, '1 optimal + 1 legal-not-optimal');
    assert.equal(bubbles.optimalCount, 1);
    assert.equal(bubbles.accuracyPct, 50, '2 legal / 4 attempts * 100');
    assert.equal(bubbles.optimalPct, 25, '1 optimal / 4 attempts * 100');
  });

  test('no attempts recorded yet returns zero counts and null percentages, not NaN/errors', () => {
    const name = 'CT_Bubbles_Empty';
    db.addPlayer(name);
    const bubbles = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(bubbles.totalAttempts, 0);
    assert.equal(bubbles.legalCount, 0);
    assert.equal(bubbles.optimalCount, 0);
    assert.equal(bubbles.accuracyPct, null);
    assert.equal(bubbles.optimalPct, null);
  });

  test('Freeform and Checkout Blitz rounds both count toward the same lifetime bubbles', () => {
    const name = 'CT_Bubbles_BothModes';
    db.addPlayer(name);
    const gf = checkoutTrainerGame(name, 'freeform');
    ctTurn(gf.gameId, name, 1, 1, 40, 'optimal');
    const gb = checkoutTrainerGame(name, 'blitz');
    ctTurn(gb.gameId, name, 1, 1, 32, 'optimal');
    const bubbles = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(bubbles.totalAttempts, 2, 'a round is a round regardless of which sub-mode served it');
    assert.equal(bubbles.optimalCount, 2);
  });
});

describe('getCheckoutTrainerPersonalBests', () => {
  test('toughestCheckout tracks the highest target ever solved optimally, not just attempted', () => {
    const name = 'CT_PB_Toughest';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 170, 'illegal'); // attempted but never solved -- must not count
    ctTurn(g.gameId, name, 1, 2, 40, 'optimal');
    ctTurn(g.gameId, name, 1, 3, 121, 'optimal');
    ctTurn(g.gameId, name, 1, 4, 96, 'legal'); // legal but not optimal -- must not count

    const pb = db.getCheckoutTrainerPersonalBests(name, 'practice');
    assert.equal(pb.toughestCheckout, 121);
  });

  test('bestStreak walks ordered attempts and resets on any non-optimal result', () => {
    const name = 'CT_PB_Streak';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');
    ctTurn(g.gameId, name, 1, 2, 32, 'optimal');
    ctTurn(g.gameId, name, 1, 3, 100, 'legal'); // breaks the streak
    ctTurn(g.gameId, name, 1, 4, 60, 'optimal');
    ctTurn(g.gameId, name, 1, 5, 80, 'optimal');
    ctTurn(g.gameId, name, 1, 6, 20, 'optimal');

    const pb = db.getCheckoutTrainerPersonalBests(name, 'practice');
    assert.equal(pb.bestStreak, 3, 'the trailing run of 3 optimal answers beats the earlier run of 2');
  });

  test('no attempts recorded yet returns nulls/zero, not errors', () => {
    const name = 'CT_PB_Empty';
    db.addPlayer(name);
    const pb = db.getCheckoutTrainerPersonalBests(name, 'practice');
    assert.equal(pb.toughestCheckout, null);
    assert.equal(pb.bestStreak, 0);
  });

  // docs/archive/checkout-drill-link-roadmap.md "Drill this checkout": a pinned round
  // grinding one known-good number repeatedly shouldn't set a "toughest ever"
  // record the random target pool didn't actually produce.
  test('toughestCheckout excludes optimal solves from a pinned-target game, even when higher than any unpinned solve', () => {
    const name = 'CT_PB_PinExcluded';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 121, 'optimal'); // ordinary roll, must count

    const pinned = db.createGame({
      category: 'Checkout Trainer (Freeform)', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'checkout_trainer', config: { mode: 'freeform', pinnedTarget: 170 },
      players: [{ name }],
    });
    ctTurn(pinned.gameId, name, 1, 1, 170, 'optimal'); // pinned, higher than 121 -- must NOT count

    const pb = db.getCheckoutTrainerPersonalBests(name, 'practice');
    assert.equal(pb.toughestCheckout, 121, 'the pinned 170 solve must not override the genuine 121 record');
  });

  test('toughestCheckout is null when every optimal solve came from a pinned-target game', () => {
    const name = 'CT_PB_OnlyPinned';
    db.addPlayer(name);
    const pinned = db.createGame({
      category: 'Checkout Trainer (Freeform)', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'checkout_trainer', config: { mode: 'freeform', pinnedTarget: 121 },
      players: [{ name }],
    });
    ctTurn(pinned.gameId, name, 1, 1, 121, 'optimal');

    const pb = db.getCheckoutTrainerPersonalBests(name, 'practice');
    assert.equal(pb.toughestCheckout, null);
  });
});

describe('getCheckoutBlitzLeaderboard', () => {
  test('one row per player, their single best-ever run score, no minimum-attempts floor', () => {
    const a = 'CT_Blitz_A', b = 'CT_Blitz_B';
    db.addPlayer(a); db.addPlayer(b);
    // Player A: two Blitz runs -- a weak one (1 legal-not-optimal = 1pt) and a
    // strong one (2 optimal = 4pts) -- the leaderboard must take the peak, not the sum.
    const ga1 = checkoutTrainerGame(a, 'blitz');
    ctTurn(ga1.gameId, a, 1, 1, 40, 'legal');
    const ga2 = checkoutTrainerGame(a, 'blitz');
    ctTurn(ga2.gameId, a, 1, 1, 40, 'optimal');
    ctTurn(ga2.gameId, a, 1, 2, 32, 'optimal');
    // Player B: a single run with just one optimal attempt (2pts) -- still ranks,
    // proving there's no minimum-attempts floor (unlike the accuracy leaderboards).
    const gb = checkoutTrainerGame(b, 'blitz');
    ctTurn(gb.gameId, b, 1, 1, 40, 'optimal');

    const rows = db.getCheckoutBlitzLeaderboard();
    const rowA = rows.find(r => r.name === a), rowB = rows.find(r => r.name === b);
    assert.equal(rowA.bestScore, 4, 'peak run (2 optimal x 2pts), not the sum across both runs');
    assert.equal(rowB.bestScore, 2);
    assert.ok(rows.indexOf(rowA) < rows.indexOf(rowB), 'higher best score ranks first');
  });

  test('Freeform runs never appear on the Blitz leaderboard', () => {
    const name = 'CT_Blitz_FreeformExcluded';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');
    const rows = db.getCheckoutBlitzLeaderboard();
    assert.ok(!rows.some(r => r.name === name), 'a Freeform-only player has no Blitz score at all');
  });

  test('an illegal-only run scores 0 and still appears (no floor to exclude it)', () => {
    const name = 'CT_Blitz_Zero';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'blitz');
    ctTurn(g.gameId, name, 1, 1, 100, 'illegal');
    const rows = db.getCheckoutBlitzLeaderboard();
    const row = rows.find(r => r.name === name);
    assert.equal(row.bestScore, 0);
  });
});

describe('getCheckoutBlitzPersonalStats', () => {
  test('bestScore and lifetimeAvgScore across every run', () => {
    const name = 'CT_BlitzPB_A';
    db.addPlayer(name);
    const g1 = checkoutTrainerGame(name, 'blitz');
    ctTurn(g1.gameId, name, 1, 1, 40, 'optimal'); // run 1: 2pts
    const g2 = checkoutTrainerGame(name, 'blitz');
    ctTurn(g2.gameId, name, 1, 1, 40, 'optimal');
    ctTurn(g2.gameId, name, 1, 2, 32, 'legal'); // run 2: 2+1=3pts

    const stats = db.getCheckoutBlitzPersonalStats(name);
    assert.equal(stats.bestScore, 3);
    assert.equal(stats.lifetimeAvgScore, 2.5, '(2+3)/2 runs');
    assert.equal(stats.runs, 2);
  });

  test('no Blitz runs yet returns nulls/zero, not errors', () => {
    const name = 'CT_BlitzPB_Empty';
    db.addPlayer(name);
    const stats = db.getCheckoutBlitzPersonalStats(name);
    assert.equal(stats.bestScore, null);
    assert.equal(stats.lifetimeAvgScore, null);
    assert.equal(stats.runs, 0);
  });
});

describe('Checkout Trainer does not pollute physical-throwing stats (regression, mirrors the Doubles Practice/Chuckin isolation audit)', () => {
  /* The whole-surface sweep, and the one that earns its keep here more than
     anywhere else. Maths Trainer gets its isolation for free — its own table, no
     `turns` and no `darts` rows, so a query written next year is safe without
     anyone remembering anything. Checkout Trainer gets it the hard way: it writes
     ordinary turns and darts, and roughly fifteen separate read queries each have
     to remember `NOT_CHECKOUT_TRAINER`. That is a coverage question, and coverage
     questions are answered by measuring, not by reading — which is exactly how
     BUG-60 turned up two queries that had never been told.

     Snapshot-shaped rather than a list of named assertions on purpose: a stat added
     later is covered by this without anyone editing the test, which is the only way
     the sixteenth query that forgets the exclusion gets caught. The named cases
     below stay as they are — they say WHICH stat and WHY in a way a diff cannot. */
  test('the whole read surface is byte-identical after a full Checkout Trainer session', () => {
    const name = 'CT_Isolation_Sweep';
    db.addPlayer(name);
    // Real history first: an all-nulls surface would compare equal no matter how
    // badly the exclusions were broken.
    const x01Game = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'x01', config: { startingScore: 501 },
      players: [{ name }],
    });
    db.addTurn(x01Game.gameId, {
      player: name, set: 1, leg: 1, scored: 140, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 20, multiplier: 1 }],
    });
    db.addTurn(x01Game.gameId, {
      player: name, set: 1, leg: 1, scored: 60, bust: false, checkout: true, checkoutPoints: 60,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }, { dartNo: 2, sector: 20, multiplier: 1 }, { dartNo: 3, sector: 20, multiplier: 2 }],
    });

    /* Three things are deliberately NOT in the snapshot below. Listing them
       explicitly, with the reason, is the point — a silent omission would make this
       test look broader than it is:

       `getPlayerCsvExport()`/`getPlayerExport()` — the raw per-player data dump.
       Trainer games and turns are real rows and belong in an export of "everything
       about this player"; the import round-trip test further down depends on them
       being there. An export is not a statistic.

       `getSessionRecap()`'s `soloActivity` — its "Also tonight" line reports
       Checkout Trainer by name with a dart count, which REFERENCE.md §29 specifies
       on purpose (`legs` omitted, darts kept). Note that the SAME recap's headline
       `perPlayer.dartsThrown` applies NOT_CHECKOUT_TRAINER, so one screen can read
       "Darts Thrown 6" above "Checkout Trainer: 14 darts". That tension is a
       product question (drop the line, or report attempts instead of darts), not
       something a test should quietly decide — flagged rather than asserted either
       way. Everything else the recap returns is covered by the surfaces below.

       `getHomeExtra().lastGame` — "the last completed game", with no game-type
       filter at all, so a finished trainer session becomes Home's "won by …" line.
       That is not a Checkout Trainer leak so much as a question about what
       `lastGame` is for: every solo/practice mode lands there the same way. Left
       alone and destructured out below; the rest of `getHomeExtra()` — including
       `todayDarts`/`weekDarts`/`todayLegs`, the counters that DO matter here — is
       asserted, and stays asserted for any key added to it later. */
    const metrics = ['dartsthrown', 'avgdartsperday', 'x01dartsthrown', 'avg', '180s',
      'treblelesspct', 'first3avg', 'first9avg', 'pace', 'avgdartsperleg'];
    const homeExtraMinusLastGame = () => {
      const { lastGame, ...rest } = db.getHomeExtra();
      return rest;
    };
    const snapshot = () => JSON.stringify({
      bubbles: db.getPlayerStatBubbles(name),
      bests: db.getPersonalBests(name),
      summary: db.getSummary(),
      roster: db.computeStats(),
      homeExtra: homeExtraMinusLastGame(),
      routes: db.getCheckoutRoutes(name),
      weakest: db.getWeakestCheckouts(name),
      finishes: db.getTopFinishes(name),
      heatmap: db.getDartHeatmap(name),
      bounceOuts: db.getBounceOutCount(name),
      analytics: db.getDartAnalytics(name),
      coaching: db.getCoachingInsights(name),
      atw: db.getAroundTheWorldProgress(name),
      ghostLegs: db.getGhostCandidateLegsCount(name),
      history: metrics.map(k => db.getMetricHistory(name, k)),
    });
    const before = snapshot();

    // Everything the mode can write: all three outcomes, a 1-dart optimal answer
    // (the shape that once won "Fewest Darts to Finish"), a trick-question
    // declaration, a Blitz run, and a Route Recall hunt.
    const gf = checkoutTrainerGame(name, 'freeform');
    ctTurn(gf.gameId, name, 1, 1, 40, 'optimal');
    ctTurn(gf.gameId, name, 1, 2, 100, 'legal');
    ctTurn(gf.gameId, name, 1, 3, 170, 'illegal');
    const gb = checkoutTrainerGame(name, 'blitz');
    ctTurn(gb.gameId, name, 1, 1, 32, 'optimal');
    db.completeGame(gf.gameId, name);

    assert.equal(snapshot(), before,
      'a Checkout Trainer session moved a pre-existing statistic — some query is missing NOT_CHECKOUT_TRAINER');
  });


  test('an X01 player\'s 3-dart average is unaffected by a Checkout Trainer game', () => {
    const name = 'CT_Isolation';
    db.addPlayer(name);
    const x01Game = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'x01', config: { startingScore: 501 },
      players: [{ name }],
    });
    db.addTurn(x01Game.gameId, {
      player: name, set: 1, leg: 1, scored: 180, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }, { dartNo: 2, sector: 20, multiplier: 3 }, { dartNo: 3, sector: 20, multiplier: 3 }],
    });
    const beforeX01 = db.getPlayerStatBubbles(name, 'practice');

    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');
    ctTurn(g.gameId, name, 1, 2, 32, 'legal');

    const afterX01 = db.getPlayerStatBubbles(name, 'practice');
    assert.equal(afterX01.avgDarts, beforeX01.avgDarts, 'X01 3-dart average sums must not shift after an unrelated Checkout Trainer game');
  });

  test('NOT_HYPOTHETICAL_DARTS: a Checkout Trainer round does not count toward today\'s "legs" activity total', () => {
    const name = 'CT_Isolation_Legs';
    db.addPlayer(name);
    const before = db.getHomeExtra().todayLegs;
    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');
    const after = db.getHomeExtra().todayLegs;
    assert.equal(after, before, 'a Checkout Trainer round is a proposed route, not a real leg, and must not inflate the physical-activity leg count');
  });

  test('NOT_CHECKOUT_TRAINER: getPersonalBests\' X01 fields are untouched by Checkout Trainer rounds', () => {
    const name = 'CT_Isolation_PersonalBests';
    db.addPlayer(name);
    // Real X01: a 3-dart leg win, average 60 (well below a 1-dart-checkout average).
    const x01Game = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'x01', config: { startingScore: 501 },
      players: [{ name }],
    });
    db.addTurn(x01Game.gameId, {
      player: name, set: 1, leg: 1, scored: 60, bust: false, checkout: true, checkoutPoints: 60,
      darts: [{ dartNo: 1, sector: 20, multiplier: 1 }, { dartNo: 2, sector: 20, multiplier: 1 }, { dartNo: 3, sector: 20, multiplier: 2 }],
    });
    const before = db.getPersonalBests(name, 'practice');
    assert.equal(before.fewestDartsCheckout, 3);

    // A 1-dart optimal Checkout Trainer "checkout" — without the fix this both
    // wins "Fewest Darts to Finish" (1 < 3) and, since its scored is always 0,
    // silently drags bestLegAvg/lifetimeAvg/recentFormAvg toward zero.
    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');

    const after = db.getPersonalBests(name, 'practice');
    assert.equal(after.fewestDartsCheckout, before.fewestDartsCheckout, 'a 1-dart Checkout Trainer round must not become the new "fewest darts to finish" record');
    assert.equal(after.bestLegAvg, before.bestLegAvg, 'bestLegAvg must not shift');
    assert.equal(after.lifetimeAvg, before.lifetimeAvg, 'lifetimeAvg must not be dragged toward zero by a scored=0 Checkout Trainer round');
    assert.equal(after.recentFormAvg, before.recentFormAvg, 'recentFormAvg must not be dragged toward zero by a scored=0 Checkout Trainer round');
  });

  test('NOT_CHECKOUT_TRAINER: getSummary().darts (global "darts thrown" total) is untouched', () => {
    const name = 'CT_Isolation_Summary';
    db.addPlayer(name);
    const before = db.getSummary().darts;
    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');
    ctTurn(g.gameId, name, 1, 2, 32, 'legal');
    const after = db.getSummary().darts;
    assert.equal(after, before, 'Checkout Trainer darts never touched a dartboard and must not inflate the global darts-thrown total');
  });

  test('NOT_CHECKOUT_TRAINER: getPlayerStatBubbles().dartsThrown (X01 profile bubble) is untouched', () => {
    const name = 'CT_Isolation_Bubbles';
    db.addPlayer(name);
    const before = db.getPlayerStatBubbles(name, 'practice').dartsThrown;
    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');
    ctTurn(g.gameId, name, 1, 2, 32, 'legal');
    const after = db.getPlayerStatBubbles(name, 'practice').dartsThrown;
    assert.equal(after, before, 'the X01 profile tab\'s own "Darts Thrown" bubble must not count Checkout Trainer darts');
  });

  test('NOT_CHECKOUT_TRAINER: computeStats() roster turns/dartsThrown are untouched', () => {
    const name = 'CT_Isolation_Roster';
    db.addPlayer(name);
    const before = db.computeStats()[name];
    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');
    const after = db.computeStats()[name];
    assert.equal(after.turns, before.turns, 'roster "turns" must not count a Checkout Trainer round');
    assert.equal(after.dartsThrown, before.dartsThrown, 'roster "darts thrown" must not count a Checkout Trainer dart');
  });

  /* docs/bug-roadmap.md BUG-60. These two were the ONLY holes the full-read-surface
     audit found: getDartHeatmap()/getBounceOutCount() take an optional gameType, and
     with it omitted ("every game type" — what the public
     `GET /api/players/dart-heatmap?name=` serves) nothing excluded the trainer's pad
     taps. The Player Profile happens never to ask that way, which is exactly why this
     sat unnoticed: the client hid the section, so no screen ever showed the wrong
     answer, and the query stayed wrong underneath. Asserted per game-type-argument
     shape rather than just the unscoped one — the bug was in the ARGUMENT the caller
     did not pass, so a test that only ever passes one shape cannot see it come back. */
  test('NOT_CHECKOUT_TRAINER: the dart heatmap never plots Checkout Trainer taps, scoped or unscoped', () => {
    const name = 'CT_Isolation_Heatmap';
    db.addPlayer(name);
    // One real X01 dart, so the heatmap has a row that legitimately belongs to it.
    const x01Game = db.createGame({
      category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      gameType: 'x01', config: { startingScore: 501 },
      players: [{ name }],
    });
    db.addTurn(x01Game.gameId, {
      player: name, set: 1, leg: 1, scored: 60, bust: false, checkout: false, checkoutPoints: null,
      darts: [{ dartNo: 1, sector: 20, multiplier: 3 }],
    });
    const before = db.getDartHeatmap(name);
    assert.equal(before.length, 1, 'the real X01 treble 20 is the only cell so far');

    // ctTurn() taps double 20 — a cell the X01 dart above does NOT occupy, so a leak
    // shows up as a brand-new row rather than a count nudged inside an existing one.
    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');
    ctTurn(g.gameId, name, 1, 2, 40, 'legal');

    assert.deepEqual(db.getDartHeatmap(name), before,
      'the unscoped "every game type" heatmap must not gain a cell from Checkout Trainer taps');
    assert.deepEqual(db.getDartHeatmap(name, 'x01'), before,
      'the X01-scoped heatmap must be unchanged too');
    assert.deepEqual(db.getDartHeatmap(name, 'checkout_trainer'), [],
      'asking for the trainer\'s own heatmap returns nothing — there is no such thing as where a pad tap landed');
  });

  test('NOT_CHECKOUT_TRAINER: a Checkout Trainer bounce-out does not reach the bounce-out count', () => {
    const name = 'CT_Isolation_BounceOut';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'freeform');
    // The Pad hides "Bounce Out" for this mode, so the shipped client cannot send
    // this — written straight to the DB because the query must be right on its own,
    // not only for as long as one client keeps choosing not to ask.
    db.addTurn(g.gameId, {
      player: name, set: 1, leg: 1, scored: 0, bust: true, checkout: false, checkoutPoints: null,
      legWon: false, targetScore: 40,
      darts: [{ dartNo: 1, sector: 0, multiplier: 1, bounced: true }],
    });
    assert.equal(db.getBounceOutCount(name), 0, 'nothing bounced off anything — there was no board');
    assert.equal(db.getBounceOutCount(name, 'checkout_trainer'), 0, 'and asking for it by name does not resurrect it');
  });
});

// Trick-question variant (docs/archive/checkout-trainer-roadmap.md "Trick-question
// difficulty variant"): a round answered by declaring "no possible checkout"
// is recorded as a turns row with declared_unsolvable=1 and ZERO dart rows —
// the grading verdict rides the same bust/checkout/leg_won three-way as a
// tapped-out answer (correct declaration -> checkout=1,leg_won=1; wrong ->
// bust=1), so every count/percentage/Blitz-score formula picks declarations
// up with no formula change. The one deliberate exception is the
// toughest-checkout Personal Best, which must NOT treat a correctly-called
// bogey target as a checkout the player solved.
function ctDeclaration(gameId, player, set, leg, targetScore, correct) {
  db.addTurn(gameId, {
    player, set, leg, scored: 0,
    bust: !correct, checkout: correct, checkoutPoints: null, legWon: correct,
    targetScore, declaredUnsolvable: true, darts: [],
  });
}

describe('trick-question declarations (declared_unsolvable)', () => {
  test('addTurn accepts a zero-dart declaration for a checkout_trainer game and stores the flag', () => {
    const name = 'CT_Trick_Accept';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'freeform');
    ctDeclaration(g.gameId, name, 1, 1, 169, true);

    const row = db._db.prepare(
      `SELECT t.declared_unsolvable AS du, t.bust, t.checkout, t.leg_won AS legWon,
              (SELECT COUNT(*) FROM darts d WHERE d.turn_id = t.id) AS dartCount
       FROM turns t WHERE t.game_id = ?`).get(g.gameId);
    assert.equal(row.du, 1);
    assert.equal(row.dartCount, 0, 'a declaration carries no dart rows');
    assert.equal(row.checkout, 1);
    assert.equal(row.legWon, 1);
  });

  test('addTurn rejects declaredUnsolvable outside checkout_trainer, with darts attached, or with points', () => {
    const name = 'CT_Trick_Reject';
    db.addPlayer(name);
    const x01 = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
    assert.throws(() => db.addTurn(x01.gameId, { player: name, set: 1, leg: 1, scored: 0, declaredUnsolvable: true, darts: [] }),
      /only valid in a Checkout Trainer game/);

    const ct = checkoutTrainerGame(name, 'freeform');
    assert.throws(() => db.addTurn(ct.gameId, { player: name, set: 1, leg: 1, scored: 0, declaredUnsolvable: true,
      darts: [{ dartNo: 1, sector: 20, multiplier: 2 }] }), /must not contain darts/);
    assert.throws(() => db.addTurn(ct.gameId, { player: name, set: 1, leg: 1, scored: 40, declaredUnsolvable: true, darts: [] }),
      /must have scored=0/);
    // And the 1-3-dart invariant is fully intact for every non-declaration turn.
    assert.throws(() => db.addTurn(ct.gameId, { player: name, set: 1, leg: 1, scored: 0, darts: [] }),
      /must contain 1 to 3 darts/);
  });

  test('declarations count toward attempts/optimal bubbles and Blitz scoring, but never toughestCheckout', () => {
    const name = 'CT_Trick_Stats';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'blitz');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');          // a real solved checkout: 2 pts
    ctDeclaration(g.gameId, name, 1, 2, 169, true);       // correct bogey call: 2 pts
    ctDeclaration(g.gameId, name, 1, 3, 170, false);      // wrong call on a finishable target: 0 pts

    const bubbles = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(bubbles.totalAttempts, 3);
    assert.equal(bubbles.optimalCount, 2, 'the correct declaration counts as an optimal answer');

    const pb = db.getCheckoutTrainerPersonalBests(name, 'practice');
    assert.equal(pb.toughestCheckout, 40,
      'the correctly-called 169 bogey must NOT register as a mastered checkout');

    const blitz = db.getCheckoutBlitzPersonalStats(name);
    assert.equal(blitz.bestScore, 4, '2 (optimal) + 2 (correct declaration) + 0 (wrong declaration)');
  });

  test('declaration turns survive a per-player export/import round trip', () => {
    const name = 'CT_Trick_Export';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'freeform');
    ctDeclaration(g.gameId, name, 1, 1, 169, true);

    const exported = db.getPlayerExport(name);
    assert.equal(exported.turns[0].declared_unsolvable, 1, 'flag present in the export');

    // Re-key as a "different server's" player so the import creates a fresh row.
    exported.player.uuid = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    exported.player.name = 'CT_Trick_Import_Target';
    const result = db.importPlayerExport(exported);
    assert.equal(result.turnsImported, 1);

    const imported = db._db.prepare(
      `SELECT t.declared_unsolvable AS du FROM turns t
       JOIN players p ON p.id = t.player_id WHERE p.name = ?`).get('CT_Trick_Import_Target');
    assert.equal(imported.du, 1, 'flag survives import');
  });
});
