'use strict';
// Committed tests for backend/netguard.js's egress guard (docs/security-audit-roadmap.md
// SEC-4 + SEC-16). SEC-16 closed a bypass where 0.0.0.0/8 and IPv6 :: (both reach the
// local host on Linux) sailed past the loopback block; these tests lock in the full
// blocked-range list so it can't silently regress.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const netguard = require('../netguard.js');

describe('netguard isLoopbackOrLinkLocal', () => {
  test('blocks loopback, unspecified, link-local, broadcast, and cloud metadata (incl. SEC-16 additions)', () => {
    const blocked = [
      '0.0.0.0', '0.0.0.1', '0.1.2.3',          // 0.0.0.0/8 — SEC-16 (reaches loopback on Linux)
      '127.0.0.1', '127.1.2.3',                  // 127.0.0.0/8
      '169.254.169.254', '169.254.0.1',          // 169.254.0.0/16 (cloud metadata)
      '255.255.255.255',                          // limited broadcast — SEC-16
      '::', '::0', '0:0:0:0:0:0:0:0',            // IPv6 unspecified — SEC-16
      '::1',                                       // IPv6 loopback
      '::ffff:127.0.0.1', '::ffff:7f00:1',       // IPv4-mapped loopback, dotted AND hex — SEC-16
      '::ffff:0.0.0.0',                           // IPv4-mapped 0.0.0.0
      'fe80::1', 'febf::abcd',                    // fe80::/10 link-local
    ];
    for (const ip of blocked) {
      assert.equal(netguard.isLoopbackOrLinkLocal(ip), true, `${ip} should be blocked`);
    }
  });

  test('allows normal public and LAN addresses', () => {
    const allowed = ['8.8.8.8', '1.2.3.4', '192.168.1.5', '10.0.0.9', '172.16.0.1',
      '2606:4700:4700::1111', '::ffff:8.8.8.8'];
    for (const ip of allowed) {
      assert.equal(netguard.isLoopbackOrLinkLocal(ip), false, `${ip} should not be loopback/link-local`);
    }
  });
});

describe('netguard isPrivateRange', () => {
  test('flags RFC1918 / ULA, including the IPv4-mapped hex form', () => {
    for (const ip of ['10.0.0.1', '172.16.5.5', '172.31.0.1', '192.168.0.1',
      'fc00::1', 'fd12::3456', '::ffff:192.168.0.1', '::ffff:c0a8:1']) {
      assert.equal(netguard.isPrivateRange(ip), true, `${ip} should be private`);
    }
  });
  test('does not flag public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111']) {
      assert.equal(netguard.isPrivateRange(ip), false, `${ip} should be public`);
    }
  });
});

describe('netguard resolveAllowedHost', () => {
  test('rejects a literal 0.0.0.0 and :: (SEC-16), accepts a public literal', async () => {
    await assert.rejects(() => netguard.resolveAllowedHost('0.0.0.0'), /loopback or link-local/i);
    await assert.rejects(() => netguard.resolveAllowedHost('::'), /loopback or link-local/i);
    await assert.rejects(() => netguard.resolveAllowedHost('127.0.0.1'), /loopback or link-local/i);
    const ip = await netguard.resolveAllowedHost('8.8.8.8');
    assert.equal(ip, '8.8.8.8');
  });
});
