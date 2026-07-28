// @ts-check
'use strict';
/* =============================================================================
   Auth primitives: password/PIN hashing, session tokens, cookie helpers.
   Dependency-free — uses only Node's built-in crypto module.

   The `// @ts-check` line above turns on type checking for this file (see
   REFERENCE.md section 39). It is opt-in per file, and this was the first file to take
   it because it is the one where a wrong type is worst: everything here either
   protects a credential or builds the cookie that carries a session.
   ============================================================================= */
const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SESSION_TOKEN_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_COOKIE = 'oche_session';

// Promise wrapper around the async crypto.scrypt — used everywhere instead of
// scryptSync (docs/security-audit-roadmap.md, SEC-1). scryptSync blocks Node's single
// event loop for ~50-100ms per call; since login() must pay this cost on every
// attempt (including a dummy hash for unknown usernames, to avoid leaking which
// usernames exist via timing), a synchronous version let an unauthenticated flood of
// login attempts stall the entire server, including the live scoreboard. The async
// form still costs the same CPU time per call, but no longer blocks other requests
// while it runs.
/**
 * @param {string} secret
 * @param {string} salt
 * @param {number} keylen
 * @returns {Promise<Buffer>}
 */
function scryptAsync(secret, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, keylen, (err, derivedKey) => err ? reject(err) : resolve(derivedKey));
  });
}

/**
 * Hashes a password or PIN for storage. The salt is generated here and returned
 * alongside, because verifying needs both — store them together.
 * @param {string} secret  a password or PIN; coerced, so a numeric PIN is fine
 * @returns {Promise<{hash: string, salt: string}>} both hex-encoded
 */
async function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(String(secret), salt, SCRYPT_KEYLEN)).toString('hex');
  return { hash, salt };
}

/**
 * Checks a candidate against a stored hash+salt pair, in constant time.
 * @param {string} secret       what the user typed
 * @param {string|null} hash    the stored hex hash (a missing one is a `false`, not a throw)
 * @param {string|null} salt    the stored hex salt
 * @returns {Promise<boolean>}
 */
async function verifySecret(secret, hash, salt) {
  if (!hash || !salt) return false;
  const candidate = await scryptAsync(String(secret), salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, 'hex');
  // Length must match before timingSafeEqual, which THROWS on a length mismatch
  // rather than returning false — a stored hash of the wrong length would otherwise
  // turn a failed login into a 500.
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

/** @returns {string} a new session token, hex, {@link SESSION_TOKEN_BYTES} bytes of entropy */
function newSessionToken() {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString('hex');
}

/**
 * What actually gets stored for a session. Tokens are hashed at rest so a leaked
 * database does not hand over live sessions.
 * @param {string} token
 * @returns {string} hex sha256
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* ---------- cookie helpers ---------- */
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';

/**
 * Parses a request's Cookie header into a plain object.
 * @param {{headers: {cookie?: string|undefined}}} req  any object with headers — an
 *   `http.IncomingMessage`, or a stub in a test. Not `string[]`: only `set-cookie` is
 *   ever an array on the way IN, and writing that here made `.split` a type error.
 * @returns {Record<string, string>} empty when there is no header; never throws
 */
function parseCookies(req) {
  const header = req.headers.cookie;
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    // docs/security-audit-roadmap.md SEC-17: a malformed cookie value (e.g. a bad
    // percent-escape like "%ff") makes decodeURIComponent throw — left unguarded that
    // propagated to the top-level catch as a 500 and got persisted into the
    // server_errors diagnostic table, an unauthenticated write into that surface via
    // GET /api/me. Fall back to the raw value instead, so a malformed cookie simply
    // fails to match a session (treated as not-logged-in) rather than 500-ing.
    if (k) { try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; } }
  }
  return out;
}

/**
 * The Set-Cookie value that establishes a session.
 * @param {string} token           the raw token (hashed before storage, not here)
 * @param {number} maxAgeSeconds
 * @returns {string}
 */
function sessionCookieHeader(token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

/**
 * The Set-Cookie value that ends one. Its attributes must match
 * {@link sessionCookieHeader}'s or the browser will not replace the cookie.
 * @returns {string}
 */
function clearSessionCookieHeader() {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

module.exports = {
  hashSecret, verifySecret,
  newSessionToken, hashToken,
  parseCookies, sessionCookieHeader, clearSessionCookieHeader,
  SESSION_COOKIE, SESSION_TTL_MS, COOKIE_SECURE,
};
