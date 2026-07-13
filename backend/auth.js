'use strict';
/* =============================================================================
   Auth primitives: password/PIN hashing, session tokens, cookie helpers.
   Dependency-free — uses only Node's built-in crypto module.
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
function scryptAsync(secret, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, keylen, (err, derivedKey) => err ? reject(err) : resolve(derivedKey));
  });
}

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(String(secret), salt, SCRYPT_KEYLEN)).toString('hex');
  return { hash, salt };
}

async function verifySecret(secret, hash, salt) {
  if (!hash || !salt) return false;
  const candidate = await scryptAsync(String(secret), salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

function newSessionToken() {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* ---------- cookie helpers ---------- */
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';

function parseCookies(req) {
  const header = req.headers.cookie;
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
