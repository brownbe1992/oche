'use strict';
/* backend/auth.js's cookie helpers.
 *
 * WHY THESE NEEDED THEIR OWN TESTS. They were the least-covered code in the repo —
 * auth.js sat at 63% line coverage, worst of any file, and this block was the whole
 * gap. Not because nothing exercised it, but because the only things that did were
 * the server tests, which spawn() a real server as a child process; coverage
 * instruments the test process, so everything the child ran looked untested.
 *
 * That is a bad place for a blind spot. Every session cookie the app issues is built
 * here, and the attributes that make it safe — HttpOnly, SameSite=Strict, the
 * conditional Secure — are three unremarkable strings in an array. Dropping one
 * changes nothing visible: login still works, sessions still persist, no test that
 * checks behaviour would notice. The cookie would just be readable from JavaScript,
 * or sent on cross-site requests. These tests exist to make that silent edit loud.
 *
 * The parsing half has already produced one real vulnerability (SEC-17), and its
 * regression test is here rather than in a server test because the bug was in this
 * function, not in the route that called it.
 */
const test = require('node:test');
const assert = require('node:assert');
const auth = require('../auth.js');

const parse = (cookie) => auth.parseCookies({ headers: cookie === null ? {} : { cookie } });

// COOKIE_SECURE is read from the environment once at module load, so the only way to
// test both branches is to load the module twice. The cache entry is dropped again
// afterwards so the mutated copy can't leak into another test file's require.
function authWithCookieSecure(value) {
  const key = require.resolve('../auth.js');
  const previous = process.env.COOKIE_SECURE;
  process.env.COOKIE_SECURE = value;
  delete require.cache[key];
  const mod = require('../auth.js');
  delete require.cache[key];
  if (previous === undefined) delete process.env.COOKIE_SECURE;
  else process.env.COOKIE_SECURE = previous;
  return mod;
}

// --- parseCookies ------------------------------------------------------------

test('parseCookies: absent or empty header yields no cookies', () => {
  assert.deepStrictEqual(parse(null), {});
  assert.deepStrictEqual(parse(''), {});
});

test('parseCookies: splits pairs and trims the whitespace browsers send', () => {
  assert.deepStrictEqual(parse('a=1; b=2 ;  c=3'), { a: '1', b: '2', c: '3' });
});

test('parseCookies: percent-escapes are decoded', () => {
  assert.deepStrictEqual(parse('n=a%20b'), { n: 'a b' });
});

test('SEC-17 — a malformed percent-escape falls back to the raw value, never throws', () => {
  // decodeURIComponent('%ff') throws URIError. Unguarded, that propagated to the
  // top-level catch as a 500 AND was persisted into the server_errors diagnostic
  // table — an unauthenticated write into that surface via a plain GET /api/me.
  // Falling back to the raw text means a malformed cookie simply fails to match a
  // session (treated as not-logged-in), which is the correct outcome.
  assert.deepStrictEqual(parse('n=%ff'), { n: '%ff' });
  assert.deepStrictEqual(parse('sess=%E0%A4%A; other=fine'), { sess: '%E0%A4%A', other: 'fine' });
});

test('parseCookies: only the FIRST = separates, so base64 padding survives', () => {
  // Splitting on every '=' would truncate any base64 value at its padding — and a
  // session token that silently loses its tail fails to match with no clue why.
  assert.deepStrictEqual(parse('t=YWJjZA=='), { t: 'YWJjZA==' });
});

test('parseCookies: junk segments are skipped rather than poisoning the result', () => {
  assert.deepStrictEqual(parse('flag; k=1'), { k: '1' });     // no '=' at all
  assert.deepStrictEqual(parse('=v; k=1'), { k: '1' });       // empty name
});

test('parseCookies: a repeated name resolves to the last one', () => {
  // Pinned because it is a real decision, not an accident: a stale duplicate from a
  // wider-scoped path must not be able to shadow the freshly-set cookie.
  assert.deepStrictEqual(parse('k=1; k=2'), { k: '2' });
});

// --- sessionCookieHeader -----------------------------------------------------

test('sessionCookieHeader: carries every attribute that makes the cookie safe', () => {
  const header = auth.sessionCookieHeader('abc123', 3600);
  assert.ok(header.startsWith(`${auth.SESSION_COOKIE}=abc123;`), header);
  // Each of these is one string in an array, and dropping any of them is invisible
  // to every behavioural test in this suite. HttpOnly keeps the token away from
  // JavaScript (so an XSS cannot read it); SameSite=Strict keeps it off cross-site
  // requests (so a CSRF cannot ride it); Path=/ makes it apply to the whole app.
  assert.match(header, /(^|;\s)HttpOnly(;|$)/);
  assert.match(header, /(^|;\s)SameSite=Strict(;|$)/);
  assert.match(header, /(^|;\s)Path=\/(;|$)/);
  assert.match(header, /(^|;\s)Max-Age=3600(;|$)/);
});

test('sessionCookieHeader: the token is escaped, so a delimiter cannot break out', () => {
  // A token containing ';' or '=' would otherwise end the cookie early or inject a
  // second attribute. Tokens are hex today, which is exactly why this could rot
  // unnoticed if newSessionToken() ever changed encoding.
  const header = auth.sessionCookieHeader('a=b;c d/+', 60);
  assert.ok(header.startsWith(`${auth.SESSION_COOKIE}=a%3Db%3Bc%20d%2F%2B;`), header);
  assert.strictEqual(header.split(';').length, 5, `unexpected attribute count: ${header}`);
});

test('sessionCookieHeader/parseCookies round-trip an awkward token', () => {
  // The pairing that matters: encodeURIComponent on the way out, decodeURIComponent
  // on the way in. If either side changed alone, sessions would stop matching.
  const token = 'a=b;c d/+%';
  const value = auth.sessionCookieHeader(token, 60).split(';')[0].split('=').slice(1).join('=');
  assert.deepStrictEqual(parse(`${auth.SESSION_COOKIE}=${value}`), { [auth.SESSION_COOKIE]: token });
});

test('Secure is present only when COOKIE_SECURE=true', () => {
  assert.ok(!/(^|;\s)Secure(;|$)/.test(authWithCookieSecure('').sessionCookieHeader('t', 60)));
  assert.ok(/(^|;\s)Secure(;|$)/.test(authWithCookieSecure('true').sessionCookieHeader('t', 60)));
  // Self-hosters run over plain HTTP on a LAN by default, so Secure cannot be
  // unconditional — a Secure cookie is simply never sent over http:// and would lock
  // every such user out of logging in. SEC-24 warns at startup instead.
  assert.ok(!/(^|;\s)Secure(;|$)/.test(authWithCookieSecure('TRUE ').sessionCookieHeader('t', 60)),
    'only the exact lowercase "true" enables it, matching the documented env contract');
});

// --- clearSessionCookieHeader ------------------------------------------------

test('clearSessionCookieHeader: expires the cookie with matching attributes', () => {
  const header = auth.clearSessionCookieHeader();
  assert.ok(header.startsWith(`${auth.SESSION_COOKIE}=;`), header);
  assert.match(header, /(^|;\s)Max-Age=0(;|$)/);
  // A browser only replaces a cookie when Path (and Domain) match the original. A
  // logout that clears with different attributes leaves the old cookie in place and
  // the session appears not to end.
  assert.match(header, /(^|;\s)Path=\/(;|$)/);
  assert.match(header, /(^|;\s)HttpOnly(;|$)/);
  assert.match(header, /(^|;\s)SameSite=Strict(;|$)/);
});

test('clearSessionCookieHeader: follows COOKIE_SECURE the same way as setting does', () => {
  assert.ok(!/(^|;\s)Secure(;|$)/.test(authWithCookieSecure('').clearSessionCookieHeader()));
  assert.ok(/(^|;\s)Secure(;|$)/.test(authWithCookieSecure('true').clearSessionCookieHeader()));
});
