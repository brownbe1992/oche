'use strict';
// Committed regression test for backend/server.js's readJson() hardening:
// docs/bug-roadmap.md BUG-10 (multi-byte characters split across a TCP chunk
// boundary previously corrupted request bodies) and docs/security-audit-roadmap.md
// SEC-19 (writes accepted any Content-Type, opening a CSRF hole under the
// OCHE_REQUIRE_AUTH=false LAN-trust opt-out) / SEC-21 (the size cap counted decoded
// JS string length instead of real bytes, undercounting multi-byte bodies by up to
// ~3-4x).
//
// server.js isn't require()-able (it .listen()s at load and exports nothing), so
// this spawns it as a real child process against a scratch DB and hits it over
// HTTP/raw TCP — the same shape as server.input-hardening.test.js. The chunk-split
// test uses a raw net.Socket (not fetch()) so the exact byte offset of the split is
// controllable, which is the whole point of the regression it's guarding.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

function waitForHealth(port, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(`http://localhost:${port}/api/health`).then(r => { if (r.ok) resolve(); else retry(); }).catch(retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) { reject(new Error('server did not start in time')); return; }
      setTimeout(tryOnce, 100);
    };
    tryOnce();
  });
}

async function withServer(port, fn) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-bodytest-'));
  const dbPath = path.join(scratchDir, 'test.db');
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(port), DARTS_DB: dbPath, OCHE_REQUIRE_AUTH: 'false' },
    stdio: 'ignore',
  });
  try {
    await waitForHealth(port);
    await fn(port, dbPath);
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 150));
  }
}

// Sends a raw HTTP/1.1 POST, writing `bodyBuffer` in two separate socket writes
// split at byte offset `splitAt` — with a real gap between them so they arrive as
// two distinct TCP reads (and therefore two distinct 'data' events on the server's
// request stream) rather than being coalesced into one.
function rawPostSplit(port, urlPath, bodyBuffer, splitAt) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, 'localhost', () => {
      const header = `POST ${urlPath} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${bodyBuffer.length}\r\nConnection: close\r\n\r\n`;
      socket.write(header);
      socket.write(bodyBuffer.subarray(0, splitAt));
      setTimeout(() => { socket.write(bodyBuffer.subarray(splitAt)); }, 30);
    });
    let raw = Buffer.alloc(0);
    socket.on('data', d => { raw = Buffer.concat([raw, d]); });
    socket.on('end', () => resolve(raw.toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('raw socket timed out')); });
  });
}

// send()'s res.end(body) over an HTTP/1.1 keep-alive-capable server without an
// explicit Content-Length triggers Node's default Transfer-Encoding: chunked
// framing (hex chunk-size lines around each piece), so the body has to be
// de-chunked before it's valid JSON again.
function dechunk(bodyText) {
  let out = '';
  let rest = bodyText;
  while (rest.length) {
    const nl = rest.indexOf('\r\n');
    if (nl === -1) break;
    const sizeHex = rest.slice(0, nl).trim();
    const size = parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out += rest.slice(nl + 2, nl + 2 + size);
    rest = rest.slice(nl + 2 + size + 2); // skip the chunk's trailing \r\n too
  }
  return out;
}

function parseRawResponse(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const statusLine = head.split('\r\n')[0];
  const status = Number(statusLine.split(' ')[1]);
  const isChunked = /transfer-encoding:\s*chunked/i.test(head);
  const bodyText = isChunked ? dechunk(rest.join('\r\n\r\n')) : rest.join('\r\n\r\n');
  let json = null;
  try { json = JSON.parse(bodyText); } catch (e) { /* non-JSON — fine for this test */ }
  return { status, bodyText, json };
}

describe('BUG-10 — request body chunks are buffer-safe across a multi-byte character split', () => {
  test('a 4-byte UTF-8 character split across two TCP writes is not corrupted', async () => {
    await withServer(8491, async (port) => {
      // U+1F3AF DIRECT HIT (🎯) is 4 bytes in UTF-8 (F0 9F 8E AF). Build a JSON body
      // and split the raw buffer at an offset that lands strictly inside that 4-byte
      // sequence, so neither half is a valid UTF-8 fragment on its own.
      const name = 'Target🎯Player';
      const body = Buffer.from(JSON.stringify({ name, out: 'double' }), 'utf8');
      const emojiByteOffset = body.indexOf(Buffer.from('🎯', 'utf8'));
      const splitAt = emojiByteOffset + 2; // strictly inside the 4-byte sequence

      const res = await rawPostSplit(port, '/api/players', body, splitAt);
      const parsed = parseRawResponse(res);
      assert.equal(parsed.status, 200, `expected 200, got ${parsed.status}: ${parsed.bodyText}`);
      assert.equal(parsed.json.name, name, 'the split character must round-trip intact, not become a replacement character');

      // Confirm what was actually persisted also has the intact name (not just the
      // echoed response) — a subtler corruption could theoretically differ between
      // the two.
      const list = await (await fetch(`http://localhost:${port}/api/players`)).json();
      assert.ok(list.some(p => p.name === name), 'stored player name must match exactly, byte for byte');
    });
  });
});

describe('SEC-21 — request body size cap counts real bytes, not decoded character length', () => {
  test('a body under 1e6 JS string-length units but over 1e6 real bytes is rejected', async () => {
    await withServer(8492, async (port) => {
      // U+6587 (文) is 3 bytes in UTF-8 but exactly 1 UTF-16 code unit (JS string
      // length 1). 400,000 repeats: JS string length ~400,010 (comfortably under the
      // old char-counted 1e6 cap) but real UTF-8 byte length ~1,200,030 (over the
      // real 1e6-byte cap this fix now enforces).
      const bigValue = '文'.repeat(400000);
      const bodyStr = JSON.stringify({ name: 'x', tagline: bigValue });
      const bodyBuf = Buffer.from(bodyStr, 'utf8');
      assert.ok(bodyStr.length < 1e6, 'sanity: JS string length must be under the old (incorrect) cap');
      assert.ok(bodyBuf.length > 1e6, 'sanity: real byte length must be over the cap');

      const res = await fetch(`http://localhost:${port}/api/players`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyBuf,
      });
      assert.equal(res.status, 413);
    });
  });
});

describe('SEC-19 — write endpoints require Content-Type: application/json', () => {
  test('a POST with Content-Type: text/plain is rejected with 415 and performs no write', async () => {
    await withServer(8493, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/players`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ name: 'Mallory' }),
      });
      assert.equal(res.status, 415);
      const list = await (await fetch(`http://localhost:${port}/api/players`)).json();
      assert.ok(!list.some(p => p.name === 'Mallory'), 'a rejected Content-Type must not perform the write');
    });
  });

  test('a POST with no Content-Type at all is also rejected with 415', async () => {
    await withServer(8494, async (port) => {
      // fetch() defaults to text/plain;charset=UTF-8 for a plain string body when no
      // headers are given, but assert this explicitly rather than relying on that
      // default by omitting the header key entirely via a raw request.
      const res = await fetch(`http://localhost:${port}/api/players`, {
        method: 'POST', body: JSON.stringify({ name: 'Eve' }),
      });
      assert.equal(res.status, 415);
    });
  });

  test('a POST with Content-Type: application/json (with a charset suffix) still succeeds', async () => {
    await withServer(8495, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/players`, {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ name: 'Alice' }),
      });
      assert.equal(res.status, 200);
    });
  });
});
