'use strict';
/* Tests for backend/seed-dev-db.js.
 *
 * The seeder's whole value rests on two properties, and both fail silently:
 *
 *  - It writes through db.js's real recordTurn()/createGame()/completeGame(),
 *    so a signature change over there breaks it. Nothing else in the repo calls
 *    those from outside the server, so nothing else would notice — the seeder
 *    would simply stop working, and would be discovered broken at the exact
 *    moment somebody needed it. The end-to-end case below runs the real script
 *    and asserts real rows come out.
 *
 *  - It is deterministic. A dataset that quietly stopped reproducing would turn
 *    every bug found against it into an anecdote nobody could re-derive, which
 *    is the one thing the seeded PRNG exists to prevent.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const seeder = require('../seed-dev-db');
const S = require('../../frontend/scoring');

const SCRIPT = path.join(__dirname, '..', 'seed-dev-db.js');

function tmpDb(tag) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `oche-seed-${tag}-`)), 'seed.db');
}

function run(dbPath, extra = []) {
  execFileSync(process.execPath, [SCRIPT, '--db', dbPath, ...extra], { stdio: 'pipe' });
}

// Every dart the seeded turns produced, in order. The comparison key for
// determinism, and deliberately excludes timestamps — those are anchored to
// wall-clock "the last N days" on purpose and are expected to differ.
function playFingerprint(dbPath) {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(`
    SELECT t.game_id, t.player_id, t.set_no, t.leg_no, t.scored, t.bust, t.checkout, t.leg_won,
           d.dart_no, d.sector, d.multiplier
    FROM turns t JOIN darts d ON d.turn_id = t.id
    ORDER BY t.id, d.dart_no
  `).all();
  db.close();
  return JSON.stringify(rows);
}

test('parseRouteLabel reads back every label checkoutHint can emit', () => {
  let checked = 0;
  for (const doubleOut of [true, false]) {
    for (let rem = 2; rem <= 170; rem++) {
      const hint = S.checkoutHint(rem, doubleOut, 3);
      if (!hint) continue;
      for (const label of hint.split(' ')) {
        const aim = seeder.parseRouteLabel(label);
        assert.ok(aim, `no aim parsed from route label "${label}" (rem=${rem})`);
        // The parse must round-trip to the same points the route intended,
        // otherwise the seeder aims at the right bed for the wrong reason and
        // its legs stop resembling the checkouts the app actually advises.
        assert.strictEqual(S.dartLabel(aim[0], aim[1]), label,
          `"${label}" parsed to ${JSON.stringify(aim)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 400, `expected to check hundreds of labels, checked ${checked}`);
});

test('aimX01 always proposes a dart the board actually has', () => {
  for (const doubleOut of [true, false]) {
    for (let rem = 2; rem <= 501; rem++) {
      const [sector, mult] = seeder.aimX01(rem, doubleOut);
      assert.ok(sector === 25 || (Number.isInteger(sector) && sector >= 1 && sector <= 20),
        `rem=${rem} aimed at sector ${sector}`);
      assert.ok(mult >= 1 && mult <= 3, `rem=${rem} aimed at multiplier ${mult}`);
      assert.ok(!(sector === 25 && mult === 3), `rem=${rem} aimed at a treble bull`);
    }
  }
});

test('aimCricket returns null only when nobody can score again', () => {
  const numbers = S.CRICKET_STANDARD_NUMBERS;
  const closed = Object.fromEntries(numbers.map(n => [n, 3]));

  // Own numbers still open -> aim at one of them.
  assert.deepStrictEqual(seeder.aimCricket({ marks: {} }, [{ marks: {} }], numbers),
    [numbers[0], numbers[0] === 25 ? 1 : 3]);

  // Closed out, but an opponent is still open on a number -> that number, so
  // points can still flow and the leg can still end.
  const oneOpen = { ...closed }; delete oneOpen[numbers[1]];
  const aim = seeder.aimCricket({ marks: closed }, [{ marks: oneOpen }], numbers);
  assert.deepStrictEqual(aim, [numbers[1], numbers[1] === 25 ? 1 : 3]);

  // Everyone closed everything: no point can ever be scored again.
  assert.strictEqual(seeder.aimCricket({ marks: closed }, [{ marks: closed }], numbers), null);
});

test('makeRng is reproducible and rng.shuffle is a permutation', () => {
  const a = seeder.makeRng(42), b = seeder.makeRng(42), c = seeder.makeRng(43);
  const draw = r => Array.from({ length: 20 }, () => r());
  assert.deepStrictEqual(draw(a), draw(b));
  assert.notDeepStrictEqual(draw(seeder.makeRng(42)), draw(c));

  const src = [1, 2, 3, 4, 5, 6, 7];
  const shuffled = seeder.makeRng(7).shuffle(src);
  assert.deepStrictEqual(src, [1, 2, 3, 4, 5, 6, 7], 'shuffle must not mutate its input');
  assert.deepStrictEqual([...shuffled].sort((x, y) => x - y), src);
});

test('sqliteTs emits SQLite datetime() format', () => {
  assert.strictEqual(seeder.sqliteTs(Date.UTC(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05');
});

test('parseArgs rejects unknown and non-positive options', () => {
  assert.deepStrictEqual(parseArgsKeys(seeder.parseArgs(['--seed', '3', '--force'])), { seed: 3, force: true });
  assert.throws(() => seeder.parseArgs(['--nope', '1']), /unrecognized option/);
  assert.throws(() => seeder.parseArgs(['--games', '0']), /positive integer/);
  assert.throws(() => seeder.parseArgs(['--seed']), /needs a value/);
});

function parseArgsKeys(parsed) {
  return { seed: parsed.seed, force: parsed.force };
}

test('seeding produces real, app-shaped rows and is reproducible', () => {
  const one = tmpDb('a'), two = tmpDb('b');
  const args = ['--seed', '9', '--games', '6', '--days', '30'];
  run(one, args);
  run(two, args);

  assert.strictEqual(playFingerprint(one), playFingerprint(two),
    'the same --seed must reproduce the same darts');

  const db = new DatabaseSync(one);
  const n = q => db.prepare(q).get().n;
  assert.ok(n('SELECT COUNT(*) n FROM players') >= 2);
  assert.strictEqual(n('SELECT COUNT(*) n FROM games'), 6);
  assert.ok(n('SELECT COUNT(*) n FROM turns') > 50);
  assert.ok(n('SELECT COUNT(*) n FROM darts') > 150);

  // Every game reaches a real ending, and never both endings at once — db.js
  // treats completed_at and dnf_at as mutually exclusive, so a seeder that set
  // both would be manufacturing a state the app cannot produce.
  assert.strictEqual(n('SELECT COUNT(*) n FROM games WHERE completed_at IS NULL AND dnf_at IS NULL'), 0);
  assert.strictEqual(n('SELECT COUNT(*) n FROM games WHERE completed_at IS NOT NULL AND dnf_at IS NOT NULL'), 0);

  // Backdated, not all stamped at the moment the script ran.
  assert.ok(n('SELECT COUNT(DISTINCT date(created_at)) n FROM games') > 1,
    'games should be spread across more than one day');

  // Every leg has exactly one winning turn. A leg with none silently zeroes
  // every won-leg-derived stat; a leg with two double-counts them.
  const legs = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT game_id, set_no, leg_no, SUM(checkout) + SUM(leg_won) AS wins
      FROM turns GROUP BY game_id, set_no, leg_no
    ) WHERE wins = 0
  `).get().n;
  assert.strictEqual(legs, 0, 'every seeded leg must have a winning turn');
  db.close();
});

// Called directly rather than by running the script, deliberately: if this
// guard ever regressed, a test that invoked the CLI against the real path would
// destroy the developer's actual database on the way to reporting the failure.
// resolveTarget() rejects the real path before touching the filesystem at all,
// so calling it in-process is safe even when it is broken.
test('seeding refuses to touch the app\'s real database', () => {
  const real = path.join(__dirname, '..', '..', 'data', 'darts.db');
  assert.throws(() => seeder.resolveTarget({ db: real, force: true }), /refusing to seed/);
  assert.throws(() => seeder.resolveTarget({ db: real, force: false }), /refusing to seed/);
});

test('seeding refuses to overwrite an existing file without --force', () => {
  const target = tmpDb('c');
  fs.writeFileSync(target, '');
  assert.throws(() => run(target, ['--games', '1']), /pass --force/);
  run(target, ['--games', '1', '--force']);          // and succeeds with it
});
