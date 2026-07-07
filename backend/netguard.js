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

// Extracts the embedded IPv4 from an IPv4-mapped IPv6 address, or null if `norm`
// isn't one. BOTH spellings must be handled — the dotted form (`::ffff:127.0.0.1`)
// and the hex form (`::ffff:7f00:1`, the same address) — so a loopback/private
// target can't hide behind the hex spelling the dotted-only regex used to miss
// (docs/security-audit-roadmap.md SEC-16). `norm` is already lower-cased.
function embeddedIPv4(norm) {
  const dotted = norm.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = norm.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

// True iff `norm` (a lower-cased IPv6 string) is the unspecified address — all
// eight hextets zero, in any spelling (`::`, `::0`, `0:0:0:0:0:0:0:0`). On Linux a
// client socket connecting to the unspecified address reaches the local host, the
// same as 0.0.0.0 does for IPv4 (SEC-16).
function isUnspecifiedIPv6(norm) {
  if (norm === '::' || norm === '::0') return true;
  if (norm.includes('::')) return false; // any other compressed form has a nonzero group
  return norm.split(':').every(h => parseInt(h, 16) === 0);
}

function isLoopbackOrLinkLocal(ip) {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    // 0.0.0.0/8 ("this host on this network", RFC 1122) — connecting to 0.0.0.0 (or
    // any 0.x.x.x) reaches the local host on Linux, so it bypasses the 127/8 block
    // below if left out (SEC-16).
    if (o[0] === 0) return true;
    if (o[0] === 127) return true;               // 127.0.0.0/8
    if (o[0] === 169 && o[1] === 254) return true; // 169.254.0.0/16 (incl. cloud metadata 169.254.169.254)
    if (o[0] === 255 && o[1] === 255 && o[2] === 255 && o[3] === 255) return true; // 255.255.255.255 (limited broadcast)
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (isUnspecifiedIPv6(norm)) return true;    // :: — reaches the local host on Linux
    if (norm === '::1') return true;             // loopback
    // IPv4-mapped IPv6 (dotted OR hex form) — range-check the embedded v4 address
    const v4 = embeddedIPv4(norm);
    if (v4) return isLoopbackOrLinkLocal(v4);
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
    const v4 = embeddedIPv4(norm); // same dotted-OR-hex handling as the loopback check
    if (v4) return isPrivateRange(v4);
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
