'use strict';
/* Proves backend/scan-secrets.js actually fires.
 *
 * A scanner that has never been seen to produce a finding is indistinguishable from one
 * whose regex has a typo in it — it reports "clean" either way, and the day it matters
 * is the day it silently lets a credential through. So every rule gets a crafted example
 * that MUST be caught, and every known-safe shape in this repo gets an example that must
 * NOT be. The second half is the more important one: the no-false-positives rule is what
 * keeps the pre-commit hook from being routinely bypassed with --no-verify.
 *
 * None of the values below are real. They are the right SHAPE and nothing more.
 */
const test = require('node:test');
const assert = require('node:assert');
const { scanBuffer, shannonEntropy, charClasses, longestAlnumRun, SQLITE_MAGIC } =
  require('../scan-secrets.js');

const scan = (text) => scanBuffer('example.js', Buffer.from(text, 'utf8'));
const rules = (text) => scan(text).map(f => f.rule);

// --- Rule 1: the realistic leak — a database or a backup of one ---------------

test('a SQLite file is caught by its magic bytes, whatever it is called', () => {
  // A real database's first 16 bytes, then arbitrary page data.
  const db = Buffer.concat([SQLITE_MAGIC, Buffer.alloc(64, 7)]);
  for (const name of ['data/darts.db', 'darts.db.bak', 'backup-2026-07', 'notes.txt']) {
    const found = scanBuffer(name, db);
    assert.deepStrictEqual(found.map(f => f.rule), ['database-file'],
      `${name} should be caught by content, not by its extension`);
  }
});

test('a non-SQLite binary is not reported', () => {
  // A PNG header. Binary, but it cannot hold a pasted credential worth reporting.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  assert.deepStrictEqual(scanBuffer('frontend/icon.png', png), []);
});

// --- Rule 2: vendor token formats --------------------------------------------

test('each vendor credential format is caught', () => {
  const cases = [
    ['GitHub PAT',       'const t = "ghp_' + 'A'.repeat(36) + '";'],
    ['GitHub OAuth',     'const t = "gho_' + 'b'.repeat(36) + '";'],
    ['GitHub server',    'const t = "ghs_' + 'c'.repeat(36) + '";'],
    ['fine-grained PAT', 'const t = "github_pat_' + 'd'.repeat(62) + '";'],
    ['AWS key id',       'AKIAIOSFODNN7EXAMPLE'],
    ['Slack token',      'xoxb-2914837465-abcdefGHIJKL'],
    ['private key',      '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['OpenAI-style',     'sk-' + 'X'.repeat(40)],
    ['JWT',              'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'],
  ];
  for (const [label, text] of cases) {
    assert.ok(rules(text).includes('credential'), `${label} was not caught`);
  }
});

test('prose that merely mentions these vendors is not reported', () => {
  const doc = 'Set a GitHub token (ghp_...) in the environment. AWS keys start with AKIA. ' +
              'Slack bot tokens look like xoxb-<numbers>-<letters>. Never commit a PRIVATE KEY.';
  assert.deepStrictEqual(rules(doc), []);
});

// --- Rule 3: a secret-named thing assigned a high-entropy literal -------------

test('a real-looking key assigned to a secret-named thing is caught', () => {
  const cases = [
    ['base62 token', 'const apiKey = "kQ7vZp2LmXt9RbN4wYs1Ff8GjH3cAe6D";'],
    ['hex token',    'password: "9f2a41c7be0d3856af71e2c4d90b6537",'],
    ['snake case',   'const api_key = "h3Kq9vZpL2mXt9RbN4wYs1Ff8GjH3cAe6D";'],
    ['credential',   'CREDENTIAL = "Zk4Lq81PmWx7TbR3vYs9Ff2GjH6cAe0D"'],
  ];
  for (const [label, text] of cases) {
    assert.ok(rules(text).includes('high-entropy-secret'), `${label} was not caught`);
  }
});

test('keys are caught even when an ordinary identifier scores HIGHER on entropy', () => {
  // The reason the rule gates on structure and not on entropy: these ranges overlap
  // completely, so no entropy threshold could separate them. Any future attempt to
  // silence a false positive by "just raising the threshold" breaks this test, which
  // is the point of it. See the FAILED DESIGN notes in backend/scan-secrets.js.
  const keys = ['9f2a41c7be0d3856af71e2c4d90b6537', 'd41d8cd98f00b204e9800998ecf8427e'];
  const safe = ['game-type-around-the-clock-1', 'oche-v2-default-settings-key'];

  assert.ok(shannonEntropy(safe[0]) > shannonEntropy(keys[1]),
    'premise of this test: a safe identifier really does out-score a real key');

  for (const k of keys) {
    assert.ok(rules(`const secret = "${k}";`).includes('high-entropy-secret'), `missed ${k}`);
  }
  for (const s of safe) {
    assert.deepStrictEqual(rules(`const secret = "${s}";`), [], `false positive on ${s}`);
  }
});

test('readable fixtures and descriptive strings are not reported', () => {
  const safe = [
    "const password = 'correcthorsebatterystaple';",           // a test fixture
    "auth.hashSecret('dummy-password-for-constant-time-login')", // the real one in db.js
    "const tokenDescription = 'the-home-assistant-webhook-identifier';",
    "// the api key is stored in the settings table, never in source",
    "const secret = 'aaaaaaaaaaaaaaaaaaaaaaaa';",   // one long run, but no entropy
    "const token = 'ABCDEFGHIJKLMNOPQRSTUVWX';",    // one long run, but one char class
  ];
  for (const text of safe) {
    assert.deepStrictEqual(rules(text), [], `false positive on: ${text}`);
  }
});

test('longestAlnumRun measures what the rule claims it measures', () => {
  assert.strictEqual(longestAlnumRun('game-type-around-the-clock-1'), 6);  // 'around'
  assert.strictEqual(longestAlnumRun('9f2a41c7be0d3856af71e2c4d90b6537'), 32);
  assert.strictEqual(longestAlnumRun('http://localhost:8123/api'), 9);     // 'localhost'
});

test('a high-entropy literal NOT named like a credential is not reported', () => {
  // Long opaque strings are ordinary — hashes in fixtures, base64 icons, ids.
  assert.deepStrictEqual(rules('const sha = "kQ7vZp2LmXt9RbN4wYs1Ff8GjH3cAe6D";'), []);
});

test('charClasses counts what the rule claims it counts', () => {
  assert.strictEqual(charClasses('all-lower-case-words'), 1);
  assert.strictEqual(charClasses('9f2a41c7be0d3856'), 2);   // lower + digits
  assert.strictEqual(charClasses('kQ7vZp2LmXt9RbN4'), 3);
});

// --- Rule 4: a configured Home Assistant webhook ------------------------------

test('a configured Home Assistant webhook id is caught', () => {
  assert.ok(rules('POST http://homeassistant.local:8123/api/webhook/aBcD1234567890eFgH1234567890')
    .includes('ha-webhook'));
});

test("the codebase's own references to the webhook path are not reported", () => {
  const safe = [
    "const url = base + '/api/webhook/' + webhookId;",
    'Paste the full URL, which looks like http://homeassistant.local:8123/api/webhook/<id>',
  ];
  for (const text of safe) {
    assert.deepStrictEqual(rules(text), [], `false positive on: ${text}`);
  }
});

// --- The whole point: this repo is clean --------------------------------------

test('every tracked file in this repository is clean', () => {
  // Runs the scanner exactly as CI does. If this ever fails, the commit that made it
  // fail must not be pushed — see the header of backend/scan-secrets.js.
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, [require.resolve('../scan-secrets.js')],
    { encoding: 'utf8' });
  assert.match(out, /^scan-secrets: clean/);
});
