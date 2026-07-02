'use strict';
/* =============================================================================
   Outbound-request egress guard (docs/security-audit-roadmap.md, SEC-4).

   Used before any server-initiated HTTP request to an admin-configured destination
   (currently: the Home Assistant URL) to stop that feature from being turned into a
   pivot point into the rest of the network — e.g. pointing ha_url at
   http://169.254.169.254/ (cloud instance metadata, often credential-bearing) or a
   loopback address to probe other local services.

   Resolves the hostname ONCE and returns that same IP for the caller to connect to
   (rather than letting the caller re-resolve at connect time), which closes the
   DNS-rebinding window between "checked" and "connected".

   Policy:
     - Loopback (127.0.0.0/8, ::1) and link-local (169.254.0.0/16 — this includes the
       cloud metadata address — and fe80::/10) are ALWAYS blocked. A real Home
       Assistant instance never lives at one of these.
     - Private/LAN ranges (10/8, 172.16/12, 192.168/16, fc00::/7) are ALLOWED by
       default, since that's where most self-hosted Home Assistant installs actually
       run. Set HA_BLOCK_PRIVATE=true to also block these for a hardened/
       internet-exposed deployment that wants outbound requests restricted to
       non-private hosts only.
   ============================================================================= */
const dns = require('dns').promises;
const net = require('net');

const BLOCK_PRIVATE = String(process.env.HA_BLOCK_PRIVATE || '').toLowerCase() === 'true';

function isLoopbackOrLinkLocal(ip) {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 127) return true;               // 127.0.0.0/8
    if (o[0] === 169 && o[1] === 254) return true; // 169.254.0.0/16 (incl. cloud metadata)
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (norm === '::1') return true;
    // IPv4-mapped IPv6 (::ffff:127.0.0.1 etc.) — check the embedded v4 address too
    const v4 = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) return isLoopbackOrLinkLocal(v4[1]);
    const first = parseInt(norm.split(':')[0] || '0', 16);
    if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10
    return false;
  }
  return false;
}

function isPrivateRange(ip) {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 10) return true;                          // 10.0.0.0/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16.0.0/12
    if (o[0] === 192 && o[1] === 168) return true;          // 192.168.0.0/16
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    const v4 = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) return isPrivateRange(v4[1]);
    const first = parseInt(norm.split(':')[0] || '0', 16);
    return first >= 0xfc00 && first <= 0xfdff; // fc00::/7 (unique local)
  }
  return false;
}

// Resolves `hostname`, rejects if any resolved address is disallowed, and returns
// the single IP address the caller should actually connect to. Throws a
// caller-safe Error (no internal detail beyond "this destination isn't allowed") on
// rejection or unresolvable hosts.
async function resolveAllowedHost(hostname) {
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
  if (!addresses.length) throw new Error(`Could not resolve host: ${hostname}`);
  for (const a of addresses) {
    if (isLoopbackOrLinkLocal(a.address)) {
      throw new Error('Refusing to contact a loopback or link-local address');
    }
    if (BLOCK_PRIVATE && isPrivateRange(a.address)) {
      throw new Error('Refusing to contact a private-network address (HA_BLOCK_PRIVATE is set)');
    }
  }
  return addresses[0].address;
}

module.exports = { resolveAllowedHost, isLoopbackOrLinkLocal, isPrivateRange };
