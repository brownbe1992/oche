#!/usr/bin/env node
'use strict';
/* =============================================================================
   seed-dev-db.js — build a realistic, DETERMINISTIC Oche database for testing.

   Why this exists
   ---------------
   Both of the repo's verification surfaces are blind against an empty database.
   backend/test/ seeds two or three hand-picked turns per case, which proves the
   formula and nothing about how it behaves over a season's worth of play; the
   verify-ui browser suite starts from a scratch DB, so every Home/Pulse/
   leaderboard/personal-best panel it renders is in its zero state. A whole
   class of real bug — a leaderboard sorted backwards, a query that only breaks
   with ties, a "best ever" that never updates, a rate that divides by the wrong
   denominator — is invisible until there is enough data for the wrong answer to
   look different from the right one.

   Two rules make its output trustworthy:

   1. It writes through db.js's own recordTurn()/createGame()/completeGame(), and
      recordTurn() specifically — the enforceConsistency:true path the HTTP layer
      uses (SEC-22). It therefore cannot manufacture a row the running app could
      not have produced. Raw INSERTs would be faster and would happily create
      impossible states, and every "bug" found against one of those would be a
      false positive costing an afternoon to disprove.

   2. Every visit is scored by frontend/scoring.js's real evaluators
      (evaluateVisit, evaluateVisitCricket). There is no second implementation of
      the rules here to drift out of step with the app's.

   Determinism is the other half: the PRNG is seeded, so the same --seed always
   produces the identical roster, fixtures and darts. A bug found on seed 1 is
   reproducible on seed 1 forever, which is the difference between a bug report
   and an anecdote. Only the timestamps differ between runs, and deliberately —
   they are anchored to "the last --days days" relative to when you run it, so a
   database seeded today still has something in Legs Today and Legs This Week.

   Usage
   -----
     npm run seed                        # -> backend/../data/seed-dev.db
     node seed-dev-db.js --db /tmp/x.db --seed 7 --days 120 --games 60
     node seed-dev-db.js --help

   It refuses to touch the app's real database (data/darts.db) outright, and
   refuses to write into any other existing file unless --force is passed.
   ============================================================================= */

const fs = require('fs');
const path = require('path');

// Pure rules module, no database of its own — safe to require before DARTS_DB is
// resolved below (db.js is not, and is required only after).
const S = require('../frontend/scoring');

/* ---------------------------------------------------------------------------
   Arguments
   --------------------------------------------------------------------------- */

const DEFAULTS = {
  db: path.join(__dirname, '..', 'data', 'seed-dev.db'),
  seed: 1,
  days: 90,
  games: 40,
  players: 'Ada,Bex,Cal,Dot,Eli',
};

function parseArgs(argv) {
  const out = { ...DEFAULTS, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') { out.force = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unrecognized argument: ${a}`);
    const key = m[1];
    if (!(key in DEFAULTS)) throw new Error(`unrecognized option: --${key}`);
    const value = m[2] != null ? m[2] : argv[++i];
    if (value == null) throw new Error(`--${key} needs a value`);
    out[key] = ['seed', 'days', 'games'].includes(key) ? Number(value) : value;
  }
  for (const key of ['seed', 'days', 'games']) {
    if (!Number.isInteger(out[key]) || out[key] < 1) throw new Error(`--${key} must be a positive integer`);
  }
  return out;
}

const HELP = `
seed-dev-db.js — deterministic realistic test data for Oche

  --db <path>       target database file        (default ${DEFAULTS.db})
  --seed <n>        PRNG seed; same seed => same data   (default ${DEFAULTS.seed})
  --days <n>        spread play over the last N days    (default ${DEFAULTS.days})
  --games <n>       number of matches to simulate       (default ${DEFAULTS.games})
  --players <a,b>   comma-separated player names        (default ${DEFAULTS.players})
  --force           overwrite an existing target file
  --help

Never writes to data/darts.db, with or without --force.
`.trimStart();

/* ---------------------------------------------------------------------------
   Deterministic PRNG (mulberry32)

   Math.random() would make every run a different dataset, so a bug found once
   could never be reproduced from the same command. Everything random below —
   who plays, what they throw, when — comes from this one stream.
   --------------------------------------------------------------------------- */

function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const rng = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));     // inclusive
  rng.pick = arr => arr[rng.int(0, arr.length - 1)];
  // Fisher-Yates, not `sort(() => rng() - 0.5)`. The comparator trick is not a
  // uniform shuffle — it biases toward the input order, which here would mean
  // the same two players drawn into most matches and the rest of the roster
  // barely appearing on any leaderboard.
  rng.shuffle = arr => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return rng;
}

/* ---------------------------------------------------------------------------
   Throwing model

   A player has a `skill` in 0..1, scaled per ring (see ringFactor below), and a
   miss degrades realistically rather than uniformly — most misses land on the
   right number in the wrong ring, then on a board neighbour, and only rarely off
   the board entirely. That distribution is what makes the derived stats look
   like darts: trebleless visits, ton-plus rates, checkout percentages and miss
   heatmaps all fall out of it instead of being invented separately.
   --------------------------------------------------------------------------- */

// Clockwise board order, used so a stray dart lands somewhere a real stray dart
// could land rather than on an arbitrary unrelated number.
const BOARD = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

function neighbour(rng, sector) {
  const i = BOARD.indexOf(sector);
  if (i < 0) return rng.pick(BOARD);
  return BOARD[(i + (rng() < 0.5 ? -1 : 1) + BOARD.length) % BOARD.length];
}

// A player's `skill` is their chance of hitting a plain single they aimed at;
// the smaller beds are scaled down from it. Without this, aiming at T20 would be
// as reliable as aiming at 20 and every seeded player would average well over a
// hundred — the fine structure that stats like ton-plus rate, trebleless visits
// and checkout percentage actually measure only exists because the rings differ.
function ringFactor(sector, mult) {
  if (sector === 25) return mult === 2 ? 0.30 : 0.55;
  if (mult === 3) return 0.34;
  if (mult === 2) return 0.44;
  return 1;
}

function throwAt(rng, aim, skill) {
  const [sector, mult] = aim;
  const hit = Math.min(0.97, skill * ringFactor(sector, mult));
  const r = rng();
  if (r < hit) return S.makeDartCore(sector, mult);
  const slack = 1 - hit;
  // A miss is usually still on the number aimed at, just through the wrong ring
  // — the single beside the treble, the single below the double. That is what
  // makes a missed checkout leave an awkward odd remainder, and awkward
  // remainders are what give the checkout stats anything to say.
  if (r < hit + slack * 0.55 && !(sector === 25 && mult === 1)) {
    return S.makeDartCore(sector === 25 ? 25 : sector, 1);
  }
  if (r < hit + slack * 0.90) return S.makeDartCore(neighbour(rng, sector === 25 ? 20 : sector), 1);
  return S.makeDartCore(0, 1);                                  // off the board
}

// Route labels come back from checkoutHint() in the app's own display form
// ('T20', 'D16', 'Bull', '25', '18'). Reading them back into (sector, mult) is
// what lets the seeder aim exactly where the app tells a real player to aim.
function parseRouteLabel(label) {
  if (label === 'Bull') return [25, 2];
  if (label === '25') return [25, 1];
  const m = /^([TD]?)(\d+)$/.exec(label);
  if (!m) return null;
  const n = Number(m[2]);
  if (!(n >= 1 && n <= 20)) return null;
  return [n, m[1] === 'T' ? 3 : m[1] === 'D' ? 2 : 1];
}

// Where to aim the next dart in an X01 leg.
//
// Once a finish is live this follows checkoutHint() — the app's OWN checkout
// advice — rather than a second opinion invented here. That matters beyond
// realism: a hand-rolled "set up 32, then take the double" policy never aims at
// the bull, so it can never throw a 170 Big Fish or a nine-darter, and the
// panels for those two would sit permanently in their empty state no matter how
// much data was generated. Deferring to the real route table makes both
// reachable exactly as often as the throwing model says they should be.
function aimX01(remaining, doubleOut) {
  if (remaining <= 170) {
    const route = S.checkoutHint(remaining, doubleOut, 3);
    if (route) {
      const aim = parseRouteLabel(route.split(' ')[0]);
      if (aim) return aim;
    }
  }
  // No finish available (too high, or a bogey number): score, and prefer leaving
  // a number a checkout exists for.
  const setup = remaining - 32;
  if (setup >= 1 && setup <= 20 && remaining <= 60) return [setup, 1];
  return [20, 3];
}

/* ---------------------------------------------------------------------------
   X01
   --------------------------------------------------------------------------- */

// Plays one leg to a finish and records every visit. Returns the winner's name.
//
// `desperation` exists only as a termination guarantee: two low-skill players
// can in principle trade missed doubles for a very long time, and a seeder that
// occasionally never returns is worse than one that occasionally plays a
// slightly-too-good leg. Skill is nudged upward only once a leg has run far past
// any realistic length.
function playX01Leg(ctx, { gameId, players, startScore, setNo, legNo }) {
  const { rng, db } = ctx;
  const state = players.map(p => ({ ...p, score: startScore, doubleOut: true }));
  let turn = rng.int(0, state.length - 1);

  for (let visit = 0; visit < 400; visit++) {
    const me = state[turn];
    const desperation = Math.min(0.35, Math.max(0, (visit - 120) / 400));
    const skill = Math.min(0.95, me.skill + desperation);

    const darts = [];
    let ev = null;
    for (let d = 0; d < 3; d++) {
      darts.push(throwAt(rng, aimX01(me.score - darts.reduce((s, x) => s + x.value, 0), true), skill));
      ev = S.evaluateVisit(me, darts, null);
      if (ev.bust || ev.win) break;
    }

    db.recordTurn(gameId, {
      player: me.name,
      darts: darts.map(d => ({ sector: d.sector, multiplier: d.mult })),
      scored: ev.scored,
      bust: ev.bust,
      checkout: ev.win,
      checkoutPoints: ev.win ? ev.scored : undefined,
      legWon: ev.win,
      set: setNo,
      leg: legNo,
    });

    me.score = ev.newScore;
    if (ev.win) return me.name;
    turn = (turn + 1) % state.length;
  }
  // Unreachable in practice — 400 visits is ~10x a bad leg. Surfacing it loudly
  // beats silently emitting a leg with no winner, which would quietly corrupt
  // every won-leg-derived stat downstream.
  throw new Error(`X01 leg did not finish (game ${gameId}, leg ${legNo})`);
}

/* ---------------------------------------------------------------------------
   Cricket

   Cricket's turns.scored is NOT arithmetically derivable from the darts (see
   addTurn()'s SEC-22 comment), which is exactly why it must come from
   evaluateVisitCricket() here rather than any local sum.
   --------------------------------------------------------------------------- */

// Close your own numbers first; once you have closed everything, pile points on
// whichever number an opponent still has open.
//
// The second half is not a refinement — it is what stops the leg deadlocking.
// Piling onto a number every player has already closed scores nothing
// (evaluateVisitCricket only awards points while an opponent is still open), so
// a shooter who has closed the board and is behind on points would throw
// forever without the score ever moving. Returns null when nobody can score
// again, which is a genuine stalemate rather than a simulation failure.
function aimCricket(me, opponents, numbers) {
  const mine = numbers.filter(n => (me.marks[n] || 0) < 3);
  if (mine.length) return [mine[0], mine[0] === 25 ? 1 : 3];
  const scorable = numbers.filter(n => opponents.some(o => (o.marks[n] || 0) < 3));
  if (!scorable.length) return null;
  const best = scorable.reduce((a, b) => (b === 25 ? 25 : b) > (a === 25 ? 25 : a) ? b : a);
  return [best, best === 25 ? 1 : 3];
}

// Returns the winner's name, or null when the leg stalemates (every player has
// closed every number and no further point can be scored — under standard
// Cricket's rules nobody has then won, and the caller abandons the match, which
// is a real app state the DNF paths need to see anyway).
function playCricketLeg(ctx, { gameId, players, numbers, setNo, legNo }) {
  const { rng, db } = ctx;
  const state = players.map(p => ({ ...p, marks: {}, points: 0, dnf: false }));
  const game = { players: state, config: { numbers, variant: 'standard' } };
  let turn = rng.int(0, state.length - 1);

  for (let visit = 0; visit < 300; visit++) {
    const me = state[turn];
    // One aim for the whole visit: marks only update once the visit is
    // evaluated, so re-deriving it per dart would give the same answer.
    const aim = aimCricket(me, state.filter(p => p !== me), numbers);
    if (!aim) return null;                          // stalemate — see the header above
    const darts = [];
    for (let d = 0; d < 3; d++) darts.push(throwAt(rng, aim, me.skill));
    const ev = S.evaluateVisitCricket(me, darts, game);

    db.recordTurn(gameId, {
      player: me.name,
      darts: darts.map(d => ({ sector: d.sector, multiplier: d.mult })),
      scored: ev.scored,
      bust: false,
      checkout: false,
      legWon: ev.win,
      set: setNo,
      leg: legNo,
    });

    me.marks = ev.marks;
    me.points = ev.points;
    if (ev.win) return me.name;
    turn = (turn + 1) % state.length;
  }
  throw new Error(`Cricket leg did not finish (game ${gameId}, leg ${legNo})`);
}

/* ---------------------------------------------------------------------------
   Backdating

   createGame()/completeGame()/recordTurn() all stamp datetime('now') — every
   seeded game would otherwise land in the same second. That collapses precisely
   the stats worth testing: Legs Today, Legs This Week, On This Day, form trends,
   the recap, streaks and every date-bucketed history query would all see one
   single day of play. Rewriting the timestamps afterwards is the only way to get
   a real spread without bypassing the validated write path on the way in.

   Turn timestamps are spread across the match's own duration so that per-visit
   pace/duration derivations see a plausible gap between visits rather than
   dozens of turns sharing one second.
   --------------------------------------------------------------------------- */

const pad = n => String(n).padStart(2, '0');

// SQLite's own datetime('now') format ('YYYY-MM-DD HH:MM:SS', UTC), so seeded
// rows are indistinguishable in shape from live ones.
function sqliteTs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
       + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// `endColumn` is completed_at for a finished match and dnf_at for an abandoned
// one. db.js is explicit that a game never carries both (abandonGame()'s own
// comment), so writing completed_at unconditionally would produce a row shape
// the app cannot create — exactly the kind of impossible state this seeder is
// built to avoid.
function backdate(raw, gameId, startMs, endMs, endColumn = 'completed_at') {
  raw.prepare(`UPDATE games SET created_at=?, ${endColumn}=? WHERE id=?`)
    .run(sqliteTs(startMs), sqliteTs(endMs), gameId);
  const ids = raw.prepare('SELECT id FROM turns WHERE game_id=? ORDER BY id').all(gameId).map(r => r.id);
  if (!ids.length) return;
  const step = (endMs - startMs) / ids.length;
  const setTurn = raw.prepare('UPDATE turns SET created_at=? WHERE id=?');
  ids.forEach((id, i) => setTurn.run(sqliteTs(startMs + step * (i + 1)), id));
}

/* ---------------------------------------------------------------------------
   Main
   --------------------------------------------------------------------------- */

function resolveTarget(opts) {
  const target = path.resolve(opts.db);
  const real = path.resolve(__dirname, '..', 'data', 'darts.db');
  // Hard stop, not a --force-able warning: this script's whole job is to
  // fabricate play, and there is no version of "seed the household's real
  // history with invented matches" that is what anybody wanted.
  if (target === real) throw new Error(`refusing to seed the app's real database (${real})`);
  if (fs.existsSync(target) && !opts.force) {
    throw new Error(`${target} already exists — pass --force to overwrite it`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(target + suffix); } catch { /* not there */ }
  }
  return target;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return; }

  const target = resolveTarget(opts);
  // Must be set before db.js is required — it reads DARTS_DB once at load and
  // opens the file immediately.
  process.env.DARTS_DB = target;
  const db = require('./db');
  const raw = db._db;
  // Seeding is tens of thousands of tiny writes and the durability guarantee is
  // worth nothing here: if the process dies the file is thrown away and the
  // command is re-run. Turning off the per-commit fsync is the difference
  // between a ~10x wait and a usable one, and it changes nothing about the rows
  // that end up in the file. Scoped to this script — the server never does it.
  raw.exec('PRAGMA synchronous=OFF');

  const rng = makeRng(opts.seed);
  const ctx = { rng, db };

  const names = opts.players.split(',').map(s => s.trim()).filter(Boolean);
  if (names.length < 2) throw new Error('--players needs at least two names');

  // Fixed per-player skill so leaderboards have a real, checkable ordering: the
  // strongest player should top the 3-dart-average table, and a leaderboard that
  // comes back the other way up is then a visible failure rather than plausible
  // noise. (That is the exact shape of the trebleless-leaderboard bug this
  // repo's testing convention was written in response to.)
  //
  // The gaps are wide on purpose. Adjacent skills a few points apart produce
  // averages whose ordering is swamped by sampling noise over a few hundred
  // visits, which would make "is this leaderboard the right way up?" unanswerable
  // — the property the ordering exists to make checkable.
  const roster = names.map((name, i) => ({
    name,
    skill: Math.max(0.20, 0.85 - i * 0.13),   // first name strongest, descending
  }));
  for (const p of roster) await db.addPlayer(p.name);

  const dayMs = 86400000;
  const now = Date.now();
  const counts = { x01: 0, cricket: 0, practice: 0, legs: 0, abandoned: 0 };

  for (let g = 0; g < opts.games; g++) {
    // Games are spread back over --days with a bias toward recent play, so the
    // "today"/"this week" panels have something in them while the long-range
    // history still has depth.
    const ago = Math.floor(Math.pow(rng(), 1.6) * opts.days);
    const startMs = now - ago * dayMs - rng.int(0, 6) * 3600000;

    const practice = rng() < 0.25;
    const cricket = !practice && rng() < 0.3;
    const seats = practice
      ? [rng.pick(roster)]
      : rng.shuffle(roster).slice(0, rng() < 0.8 ? 2 : rng.int(3, Math.min(4, roster.length)));

    const gameType = cricket ? 'cricket' : 'x01';
    const startScore = practice ? 301 : rng.pick([301, 501, 501, 501]);
    const legsPerSet = practice ? 1 : rng.pick([1, 3, 3, 5]);
    const config = cricket ? { numbers: S.CRICKET_STANDARD_NUMBERS, variant: 'standard' } : { startScore };

    const game = db.createGame({
      category: String(startScore),
      legsPerSet,
      setsPerGame: 1,
      players: seats.map(p => ({ name: p.name, out: 'double' })),
      practice,
      gameType,
      config,
    });
    const gameId = game.gameId != null ? game.gameId : game.id;

    const needed = Math.ceil(legsPerSet / 2);
    const wins = new Map(seats.map(p => [p.name, 0]));
    let legNo = 0, winner = null, stalemate = false;
    while (!winner && !stalemate && legNo < legsPerSet) {
      legNo++;
      const legWinner = cricket
        ? playCricketLeg(ctx, { gameId, players: seats, numbers: S.CRICKET_STANDARD_NUMBERS, setNo: 1, legNo })
        : playX01Leg(ctx, { gameId, players: seats, startScore, setNo: 1, legNo });
      counts.legs++;
      if (legWinner == null) { stalemate = true; break; }   // Cricket only, and rare
      wins.set(legWinner, wins.get(legWinner) + 1);
      if (wins.get(legWinner) >= needed) winner = legWinner;
    }
    if (stalemate) { db.abandonGame(gameId); counts.abandoned++; }
    else db.completeGame(gameId, winner);

    // ~4 minutes a leg, which is what makes the duration-derived stats (average
    // pace, marathon fatigue splits, session length) land in a believable range.
    backdate(raw, gameId, startMs, startMs + legNo * 4 * 60000 + rng.int(0, 300) * 1000,
      stalemate ? 'dnf_at' : 'completed_at');

    counts[practice ? 'practice' : cricket ? 'cricket' : 'x01']++;
  }

  const totals = raw.prepare(`
    SELECT (SELECT COUNT(*) FROM players) AS players,
           (SELECT COUNT(*) FROM games)   AS games,
           (SELECT COUNT(*) FROM turns)   AS turns,
           (SELECT COUNT(*) FROM darts)   AS darts
  `).get();

  process.stdout.write(
    `seeded ${target}\n`
    + `  seed=${opts.seed} days=${opts.days}\n`
    + `  ${totals.players} players, ${totals.games} games `
    + `(${counts.x01} X01 h2h, ${counts.cricket} cricket, ${counts.practice} practice), `
    + `${counts.legs} legs${counts.abandoned ? `, ${counts.abandoned} abandoned` : ''}\n`
    + `  ${totals.turns} turns, ${totals.darts} darts\n`
    + `\nRun the app against it:\n  DARTS_DB=${target} npm start\n`);
}

// Guarded so the pure helpers below can be require()'d from a test without the
// require itself seeding a database as a side effect.
if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`seed-dev-db: ${err.message}\n`);
    process.exit(1);
  });
}

// Exported for backend/test/seed-dev-db.test.js only — nothing else requires
// this file.
module.exports = { makeRng, parseArgs, parseRouteLabel, aimX01, aimCricket, ringFactor, sqliteTs, resolveTarget, BOARD };
