'use strict';
// Committed regression coverage for docs/bug-roadmap.md BUG-14: handleUploadRestore()
// ignored fs.createWriteStream()'s write() return value, so on a disk slower than the
// incoming network stream, Node kept buffering unwritten chunks in process memory
// instead of pausing the request — a large upload (up to the 500MB cap) could
// transiently hold most or all of itself in memory instead of the small streaming
// footprint the design intends.
//
// The existing full upload-restore round trip (server.backups.test.js) already
// proves the fix doesn't break normal uploads — re-run against this change, it stays
// green. What that test CAN'T meaningfully prove is that backpressure is actually
// respected: whether fs.createWriteStream()'s internal buffer fills up depends on
// real OS/disk write timing, which isn't reliably triggerable (or observable from
// outside the process) in a fast, deterministic unit test — especially against this
// sandbox's typically very fast overlay filesystem, where write() essentially never
// returns false for a test-sized payload regardless of whether the handling code is
// present. Asserting the source pattern directly is the practical, honest way to
// guard against this specific fix being silently reverted later while everything
// else still appears to work (correctness of a small test upload doesn't depend on
// backpressure being handled at all — only memory behavior under a genuinely slow
// destination does, which is exactly what this check can't otherwise observe).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function extractHandleUploadRestore(src) {
  const m = src.match(/async function handleUploadRestore\(req, res, admin\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'handleUploadRestore() not found in server.js — has it moved/renamed?');
  return m[0];
}

describe('BUG-14 — handleUploadRestore() respects write-stream backpressure', () => {
  test('checks write()\'s return value and pauses/resumes the request around \'drain\'', () => {
    const fn = extractHandleUploadRestore(SERVER_SRC);
    assert.match(fn, /out\.write\(chunk\)\s*===\s*false/, 'must check write()\'s return value, not ignore it');
    assert.match(fn, /req\.pause\(\)/, 'must pause the readable side when the write buffer is full');
    assert.match(fn, /out\.once\(\s*['"]drain['"]/, 'must wait for the write stream\'s own \'drain\' event');
    assert.match(fn, /req\.resume\(\)/, 'must resume the readable side once drained');
  });
});
