'use strict';
// Committed guard for code-quality item 39 (docs/code-quality-roadmap.md): index.html's
// NON_SAVABLE_GAME_TYPES hand-mirrors the backend GAME_TYPE_REGISTRY's savable flags
// (backend/db.js SAVABLE_GAME_TYPES) with nothing tying the two lists together. A drifted
// entry either shows a client Save button the server 400s, or hides pause/resume for a mode
// the server actually supports. This is the "cheap 80% version" the roadmap item calls for:
// a committed test asserting the two lists match, rather than serving the list over the wire.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const db = require('../db.js');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');

describe('item 39 — frontend NON_SAVABLE_GAME_TYPES matches backend SAVABLE_GAME_TYPES', () => {
  test('every backend non-savable, non-dispatch-only type is in the frontend list, and vice versa', () => {
    const m = INDEX_HTML.match(/const NON_SAVABLE_GAME_TYPES\s*=\s*\[([^\]]*)\]/);
    assert.ok(m, 'NON_SAVABLE_GAME_TYPES literal not found in index.html — has it moved/renamed?');
    const frontendNonSavable = [...m[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map(x => x[1]).sort();

    const backendNonSavable = db.KNOWN_GAME_TYPES
      .filter(t => !db.SAVABLE_GAME_TYPES.includes(t))
      .sort();

    assert.deepEqual(frontendNonSavable, backendNonSavable,
      `frontend NON_SAVABLE_GAME_TYPES (${frontendNonSavable.join(', ')}) must exactly match ` +
      `backend's non-savable known types (${backendNonSavable.join(', ')})`);
  });
});
