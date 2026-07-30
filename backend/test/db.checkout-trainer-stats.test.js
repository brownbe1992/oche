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
const S = require('../../frontend/scoring.js');

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
/* A round, recorded the way live play records one — and NOT told what its outcome
   was. That is the change from the turns-based version of these fixtures, which
   asserted `bust`/`checkout`/`legWon` values they had themselves just supplied and
   so could never have caught a grading bug. addCheckoutTrainerRound() re-grades the
   submitted route with the same scoring.js functions the screen uses, so the fixture
   now has to hand it a route that genuinely IS optimal / legal-but-not / illegal,
   and the stat under test is computed from a verdict nobody in this file chose.

   The three outcomes are built from allCheckoutRoutes(), the objective source of
   truth for what a target's routes are:
     optimal  the first (shortest) route that exists.
     legal    a route strictly longer than the shortest — a real finish, not the
              best one. Not every target has one; those that don't throw here rather
              than silently recording something else.
     illegal  T20 T20 T20 = 180, which overshoots every legal target (max 170). */
const LABEL_RE = /^(T|D)?(\d+)$/;
function dartsFromLabels(labels) {
  return labels.map((l, i) => {
    if (l === 'Bull') return { dartNo: i + 1, sector: 25, multiplier: 2 };
    if (l === '25') return { dartNo: i + 1, sector: 25, multiplier: 1 };
    const m = LABEL_RE.exec(l);
    if (!m) throw new Error(`fixture cannot parse segment label "${l}"`);
    return { dartNo: i + 1, sector: Number(m[2]), multiplier: m[1] === 'T' ? 3 : m[1] === 'D' ? 2 : 1 };
  });
}
function routeFor(targetScore, outcome) {
  if (outcome === 'illegal') return dartsFromLabels(['T20', 'T20', 'T20']);
  const routes = S.allCheckoutRoutes(targetScore, true, 3);
  if (!routes.length) throw new Error(`fixture asked for a ${outcome} route to ${targetScore}, which has none`);
  if (outcome === 'optimal') return dartsFromLabels(routes[0].darts);
  const longer = routes.find(r => r.darts.length > routes[0].darts.length);
  if (!longer) throw new Error(`fixture asked for a non-optimal route to ${targetScore}, which has only optimal ones`);
  return dartsFromLabels(longer.darts);
}
function ctTurn(gameId, player, set, leg, targetScore, outcome) {
  return db.addCheckoutTrainerRound(gameId, player,
    { player, huntNo: set, roundNo: leg, targetScore, darts: routeFor(targetScore, outcome) });
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

  test('a Checkout Trainer game cannot hold a turn or a dart at all', () => {
    // The structural claim the whole rewrite rests on, asserted directly. Every
    // isolation case above passes BECAUSE of this one: with no turns and no darts
    // rows there is nothing for any query — present or future, remembering an
    // exclusion or not — to pick up.
    const name = 'CT_Isolation_NoTurns';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'freeform');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');
    ctTurn(g.gameId, name, 1, 2, 100, 'illegal');

    const counts = db._db.prepare(`
      SELECT (SELECT COUNT(*) FROM turns WHERE game_id = ?) AS turns,
             (SELECT COUNT(*) FROM darts d JOIN turns t ON t.id = d.turn_id WHERE t.game_id = ?) AS darts,
             (SELECT COUNT(*) FROM checkout_trainer_rounds WHERE game_id = ?) AS rounds
    `).get(g.gameId, g.gameId, g.gameId);
    assert.equal(counts.turns, 0, 'a played session leaves no turns rows');
    assert.equal(counts.darts, 0, 'and no darts rows');
    assert.equal(counts.rounds, 2, 'the rounds are all in its own table');

    // And the door is shut, not merely unused: a stale client or a hand-made POST
    // is refused rather than quietly reopening every exclusion this rewrite deleted.
    assert.throws(() => db.addTurn(g.gameId, {
      player: name, set: 1, leg: 1, scored: 0, bust: false, checkout: true, legWon: true,
      targetScore: 40, darts: [{ dartNo: 1, sector: 20, multiplier: 2 }],
    }), /records rounds, not turns/);
  });
});

/* Trick-question variant (docs/archive/checkout-trainer-roadmap.md "Trick-question
   difficulty variant"): a round answered by declaring "no possible checkout"
   instead of tapping out a route. It carries no route at all — the one round shape
   with nothing to grade for legality — so it gets its own column
   (checkout_trainer_rounds.declared_unsolvable) and is graded by whether the target
   really is a bogey number. A correct call is that round's OPTIMAL answer and scores
   accordingly; the one deliberate exception is the toughest-checkout Personal Best,
   which must not treat a correctly-called bogey as a checkout the player solved.

   Note what the fixture no longer passes: whether the declaration was right. The
   server decides, from the target, via gradeCheckoutDeclaration(). */
function ctDeclaration(gameId, player, set, leg, targetScore) {
  return db.addCheckoutTrainerRound(gameId, player,
    { player, huntNo: set, roundNo: leg, targetScore, declaredUnsolvable: true, darts: [] });
}

describe('trick-question declarations (declared_unsolvable)', () => {
  test('a declaration is stored with no route, and graded against whether the target really is a bogey', () => {
    const name = 'CT_Trick_Accept';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'freeform');
    const right = ctDeclaration(g.gameId, name, 1, 1, 169);   // 169 IS a bogey number
    const wrong = ctDeclaration(g.gameId, name, 1, 2, 170);   // 170 is T20 T20 Bull

    assert.equal(right.correct, true);
    assert.equal(right.optimal, true, 'a correct call is that round\'s best possible answer');
    assert.equal(wrong.correct, false);
    assert.equal(wrong.legal, false);

    const rows = db._db.prepare(
      `SELECT declared_unsolvable AS du, route, legal, optimal, used_darts AS usedDarts
       FROM checkout_trainer_rounds WHERE game_id = ? ORDER BY id`).all(g.gameId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].du, 1);
    assert.equal(rows[0].route, '', 'a declaration carries no route');
    assert.equal(rows[0].usedDarts, 0);
    assert.equal(rows[0].legal, 1);
    assert.equal(rows[0].optimal, 1);
    assert.equal(rows[1].optimal, 0);
  });

  test('a declaration may not carry a route, and a non-declaration must carry 1-3 darts', () => {
    const name = 'CT_Trick_Reject';
    db.addPlayer(name);
    const ct = checkoutTrainerGame(name, 'freeform');
    assert.throws(() => db.addCheckoutTrainerRound(ct.gameId, name, { player: name, targetScore: 169,
      declaredUnsolvable: true, darts: [{ sector: 20, multiplier: 2 }] }), /must not carry a route/);
    assert.throws(() => db.addCheckoutTrainerRound(ct.gameId, name, { player: name, targetScore: 40, darts: [] }),
      /1 to 3 darts/);
    assert.throws(() => db.addCheckoutTrainerRound(ct.gameId, name, { player: name, targetScore: 999,
      darts: [{ sector: 20, multiplier: 2 }] }), /targetScore must be an integer between 1 and 170/);
  });

  test('declarations count toward attempts/optimal bubbles and Blitz scoring, but never toughestCheckout', () => {
    const name = 'CT_Trick_Stats';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'blitz');
    ctTurn(g.gameId, name, 1, 1, 40, 'optimal');    // a real solved checkout: 2 pts
    ctDeclaration(g.gameId, name, 1, 2, 169);       // 169 is a bogey — correct call: 2 pts
    ctDeclaration(g.gameId, name, 1, 3, 170);       // 170 is finishable — wrong call: 0 pts

    const bubbles = db.getCheckoutTrainerStatBubbles(name, 'practice');
    assert.equal(bubbles.totalAttempts, 3);
    assert.equal(bubbles.optimalCount, 2, 'the correct declaration counts as an optimal answer');

    const pb = db.getCheckoutTrainerPersonalBests(name, 'practice');
    assert.equal(pb.toughestCheckout, 40,
      'the correctly-called 169 bogey must NOT register as a mastered checkout');

    const blitz = db.getCheckoutBlitzPersonalStats(name);
    assert.equal(blitz.bestScore, 4, '2 (optimal) + 2 (correct declaration) + 0 (wrong declaration)');
  });

  test('rounds — declarations included — survive a per-player export/import round trip', () => {
    // A per-player export used to carry this mode's history for free, because its
    // history was turns. It no longer is, so the export has to carry the rounds
    // explicitly — and without that, exporting a player who plays this mode would
    // export their games and none of what they did in them.
    const name = 'CT_Trick_Export';
    db.addPlayer(name);
    const g = checkoutTrainerGame(name, 'freeform');
    ctDeclaration(g.gameId, name, 1, 1, 169);
    ctTurn(g.gameId, name, 1, 2, 40, 'optimal');

    const exported = db.getPlayerExport(name);
    assert.equal(exported.turns.length, 0, 'nothing of this mode is in turns to export');
    assert.equal(exported.checkoutTrainerRounds.length, 2);
    assert.equal(exported.checkoutTrainerRounds[0].declared_unsolvable, 1, 'flag present in the export');

    // Re-key as a "different server's" player so the import creates a fresh row.
    exported.player.uuid = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    exported.player.name = 'CT_Trick_Import_Target';
    const result = db.importPlayerExport(exported);
    assert.equal(result.checkoutRoundsImported, 2);

    // The imported player's stats are the same stats, which is the point of a
    // round trip — not merely that some rows arrived.
    const bubbles = db.getCheckoutTrainerStatBubbles('CT_Trick_Import_Target', 'practice');
    assert.equal(bubbles.totalAttempts, 2);
    assert.equal(bubbles.optimalCount, 2, 'the correct bogey call and the optimal solve both survive');
    assert.equal(db.getCheckoutTrainerPersonalBests('CT_Trick_Import_Target', 'practice').toughestCheckout, 40,
      'and the declaration still does not count as a solved checkout on the far side');
  });
});
