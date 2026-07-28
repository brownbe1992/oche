#!/usr/bin/env node
'use strict';
/* Refuses anything that must never enter git history.
 *
 * WHY THIS IS ITS OWN THING, AND NOT A RULE IN check.js. A bad commit is a
 * code-quality problem you fix in the next commit. A leaked credential is not: git
 * keeps history, so deleting the file afterwards changes nothing — the value is still
 * there for anyone who clones the repo, and the only real remedy is rewriting history
 * and rotating whatever leaked. That asymmetry is the whole reason this runs as its own
 * CI job and its own pre-commit hook: it is the one check whose job is to stop something
 * happening, rather than to notice that it happened.
 *
 * WHAT THIS REPO ACTUALLY RISKS. Oche has no API keys of its own. What it has is a
 * SQLite database holding admin password hashes, player PIN hashes, and the Home
 * Assistant webhook URL + id. So the realistic leak is not a pasted token — it is
 * **a database file or a backup being committed**. `.gitignore` covers `data/` and
 * `*.db`, which is most of the protection, but `git add -f` overrides it, a backup can
 * be written anywhere with any extension, and a copy made while debugging ("darts.db.bak")
 * is exactly the sort of thing that gets committed at 1am. Detecting those is what this
 * is mostly for, and it does it by CONTENT (the SQLite file-header magic) rather than by
 * filename, so an unusual extension changes nothing.
 *
 * The generic credential patterns below are the secondary net, for something pasted into
 * a doc or a test. They are deliberately narrow. For broad, always-current coverage of
 * every vendor's token format, GitHub's own free push protection is a repository setting
 * and is strictly better than anything hand-rolled here — this file is not a substitute
 * for turning that on, it is the part that can live in the repo and run before a push.
 *
 * NO FALSE POSITIVES, same rule backend/check.js holds to: a scanner that cries wolf
 * gets bypassed with --no-verify, and a bypassed scanner is worse than none because it
 * looks like protection. Every rule here is either exact (a file's magic bytes, a
 * vendor's fixed token prefix) or entropy-gated so ordinary English cannot trip it.
 *
 *   node backend/scan-secrets.js            # every tracked file (what CI runs)
 *   node backend/scan-secrets.js --staged   # only what is staged (the pre-commit hook)
 *
 * Exit 1 on any finding.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STAGED = process.argv.includes('--staged');
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function fileList() {
  const args = STAGED
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
    : ['ls-files'];
  return execFileSync('git', args, { encoding: 'utf8', cwd: ROOT })
    .split('\n').filter(Boolean);
}

// ---------------------------------------------------------------------------
// Rule 1 — a database or backup file, detected by CONTENT
//
// Every SQLite file on earth starts with these exact 16 bytes. Checking the magic
// rather than the extension means `darts.db.bak`, `copy-of-data`, or a file with no
// extension at all are all caught, and a `.db` that happens to be something else is
// not falsely accused.
// ---------------------------------------------------------------------------
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary');

// ---------------------------------------------------------------------------
// Rule 2 — credential formats with a fixed, unambiguous prefix
//
// Only vendor formats whose prefix cannot occur by accident. No generic "looks like a
// key" guessing: that is where false positives come from.
// ---------------------------------------------------------------------------
const TOKEN_PATTERNS = [
  [/\bghp_[A-Za-z0-9]{36}\b/,               'GitHub personal access token'],
  [/\bgho_[A-Za-z0-9]{36}\b/,               'GitHub OAuth token'],
  [/\bghs_[A-Za-z0-9]{36}\b/,               'GitHub server token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/,      'GitHub fine-grained PAT'],
  [/\bAKIA[0-9A-Z]{16}\b/,                  'AWS access key id'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,      'Slack token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key block'],
  [/\bsk-[A-Za-z0-9]{32,}\b/,               'OpenAI-style secret key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, 'JWT'],
];

// ---------------------------------------------------------------------------
// Rule 3 — a secret-named thing assigned a literal that is SHAPED like a key
//
// This is the catch-all for a vendor Rule 2 doesn't know about, and the only rule here
// that could in principle misfire — so it is gated four ways, and the gates were chosen
// by measurement rather than by intuition. Every number below was measured on this
// repository's own strings; the two failed designs are recorded because both sound
// obviously correct and both are wrong.
//
// FAILED DESIGN 1 — "high entropy means secret". Entropy does not separate these:
//
//   'game-type-around-the-clock-1'    3.94 bits/char   ordinary identifier, SAFE
//   'oche-v2-default-settings'        3.91 bits/char   ordinary identifier, SAFE
//   a random 32-char hex API key      3.98 bits/char   A REAL SECRET
//   an MD5-shaped 32-char key         3.39 bits/char   A REAL SECRET
//
// The ranges overlap completely, because hex has only 16 symbols and so caps at 4.0
// bits/char however random it is, while hyphenated English happily reaches 3.9. There
// is no threshold that admits the secrets and rejects the identifiers.
//
// FAILED DESIGN 2 — "entropy >= 4.0". This was the first version committed to this file
// and it scanned clean, which is exactly the trap: 4.0 sits ON hex's theoretical ceiling,
// so it could never catch a hex key at all. It reported "clean" for the same reason a
// scanner with a typo'd regex does. The test suite caught it, which is why every rule
// here has a test that feeds it a real-shaped example.
//
// WHAT ACTUALLY SEPARATES THEM is structure, not randomness. A key is one unbroken run
// of alphanumerics; a descriptive identifier is short words joined by separators. The
// longest unbroken run in every safe string above is 8-9 characters ('settings',
// 'localhost', 'challenge'), while a key's longest run is the whole key. So the primary
// gate is RUN_MIN, with entropy and character-class diversity kept only to reject the
// degenerate long runs a repository really does contain — 'aaaaaaaaaaaaaaaaaaaa1111'
// (0.65 bits/char) and '20260728T120000000Z' (one class short of the bar).
//
// What this knowingly gives up: a secret written with hyphens in it, and a secret of
// pure lowercase letters. Both are indistinguishable from the readable identifiers we
// must not report, and reporting those is what gets a pre-commit hook bypassed for good.
// ---------------------------------------------------------------------------
const SECRET_NAME = /(?:api[_-]?key|secret|token|passwd|password|credential|private[_-]?key)/i;
const ASSIGNED_LITERAL = /(['"])([A-Za-z0-9_\-+/=.:]{20,})\1/g;
const RUN_MIN = 20;        // longest unbroken [A-Za-z0-9] run
const ENTROPY_MIN = 3.0;
const CLASSES_MIN = 2;

function longestAlnumRun(s) {
  return (s.match(/[A-Za-z0-9]+/g) || []).reduce((n, r) => Math.max(n, r.length), 0);
}

function charClasses(s) {
  return [/[a-z]/, /[A-Z]/, /[0-9]/].filter(re => re.test(s)).length;
}

function shannonEntropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

// ---------------------------------------------------------------------------
// Rule 4 — a configured Home Assistant webhook
//
// Not a token, and worth being accurate about: a webhook id lets someone SEND events
// to that Home Assistant, not read from or control it. Still a household's private
// endpoint, still shouldn't be published. Only a real-looking configured value is
// reported — the literal path `/api/webhook/` appears throughout this codebase's own
// source and docs, which is why the id itself has to look substantial.
// ---------------------------------------------------------------------------
const HA_WEBHOOK = /\/api\/webhook\/[A-Za-z0-9_-]{24,}/;

// Files whose whole purpose is to describe these patterns. Without this, this scanner
// and the docs explaining it would report each other forever.
const SELF = new Set([
  'backend/scan-secrets.js',
  'backend/test/scan-secrets.test.js',
  'docs/security-audit-roadmap.md',
  'docs/security-hardening-roadmap.md',
]);

/* Every rule, applied to one file's bytes. Returns a list of findings.
 *
 * This is a plain function taking a buffer rather than a path so the test suite can
 * feed it a crafted example of each defect class and prove the rule actually fires.
 * A scanner nobody has ever seen produce a finding is indistinguishable from one
 * whose regex has a typo in it. */
function scanBuffer(rel, buf) {
  const out = [];
  const add = (rule, detail) => out.push({ file: rel, rule, detail });

  if (buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    add('database-file',
      'this is a SQLite database — it holds admin password hashes, player PIN hashes and ' +
      'the Home Assistant webhook config, and git history is permanent');
    return out;   // no point scanning a binary for text patterns
  }
  // Binary files can't hold a pasted credential in any form worth reporting.
  if (buf.includes(0)) return out;

  const text = buf.toString('utf8');
  const lineOf = (idx) => text.slice(0, idx).split('\n').length;

  for (const [re, label] of TOKEN_PATTERNS) {
    const m = re.exec(text);
    if (m) add('credential', `${label} at line ${lineOf(m.index)}`);
  }

  const ha = HA_WEBHOOK.exec(text);
  if (ha) add('ha-webhook', `a configured Home Assistant webhook id at line ${lineOf(ha.index)}`);

  for (const m of text.matchAll(ASSIGNED_LITERAL)) {
    const value = m[2];
    // Look back a little for the name this literal is assigned to.
    const context = text.slice(Math.max(0, m.index - 60), m.index);
    if (!SECRET_NAME.test(context)) continue;
    if (longestAlnumRun(value) < RUN_MIN) continue;
    if (charClasses(value) < CLASSES_MIN) continue;
    const h = shannonEntropy(value);
    if (h < ENTROPY_MIN) continue;
    add('high-entropy-secret',
      `line ${lineOf(m.index)}: a ${value.length}-character value with ${h.toFixed(1)} bits/char ` +
      `of entropy assigned to something named like a credential`);
  }
  return out;
}

function main() {
  const files = fileList();
  const findings = [];
  for (const rel of files) {
    if (SELF.has(rel)) continue;
    let buf;
    try { buf = fs.readFileSync(path.join(ROOT, rel)); } catch { continue; }  // deleted, or a submodule
    findings.push(...scanBuffer(rel, buf));
  }

  if (!findings.length) {
    console.log(`scan-secrets: clean (${files.length} ${STAGED ? 'staged' : 'tracked'} files).`);
    return 0;
  }

  console.error(`\nscan-secrets: ${findings.length} finding${findings.length === 1 ? '' : 's'} — DO NOT COMMIT\n`);
  for (const f of findings) console.error(`  [${f.rule}] ${f.file}\n      ${f.detail}\n`);
  console.error('git history is permanent. If any of this has already been pushed, deleting the');
  console.error('file is not enough — the value has to be rotated and the history rewritten.\n');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { scanBuffer, shannonEntropy, charClasses, longestAlnumRun, SQLITE_MAGIC };
