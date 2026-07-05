'use strict';
// Committed tests for backend/db.js's getOnThisDay() (REFERENCE.md §3 "On This
// Day") — priority ordering (180 > 170 checkout > 100+ checkout), most-recent-
// year tiebreak, %m-%d-only date matching, and the X01-only gating on the 180
// case (a cricket 9-mark visit must never surface as a "180" flashback).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-test-'));
const scratchDb = path.join(scratchDir, 'test.db');
process.env.DARTS_DB = scratchDb;

const db = require('../db.js');

after(() => {
  for (const f of [scratchDb, scratchDb + '-wal', scratchDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
  try { fs.rmdirSync(scratchDir); } catch (e) {}
});

const now = new Date();
const MM = String(now.getUTCMonth() + 1).padStart(2, '0');
const DD = String(now.getUTCDate()).padStart(2, '0');
const thisYear = now.getUTCFullYear();

function lastTurnId() {
  return db._db.prepare('SELECT MAX(id) AS id FROM turns').get().id;
}
// Inserts a turn, then overrides its created_at to today's exact month/day (so
// getOnThisDay's %m-%d match fires) in an arbitrary past year — getOnThisDay
// itself doesn't care what time of day, only the (month,day,year) parts.
function pastDayTurn(gameId, player, year, opts) {
  db.addTurn(gameId, { player, set: 1, leg: 1, bust: false, checkout: false, checkoutPoints: null, darts: [{ sector: 1, multiplier: 1 }], ...opts });
  db._db.prepare('UPDATE turns SET created_at = ? WHERE id = ?').run(`${year}-${MM}-${DD} 12:00:00`, lastTurnId());
}
function offDayTurn(gameId, player, opts) {
  // A turn on a DIFFERENT day entirely (guaranteed not to match %m-%d unless
  // today happens to be day 1 of a month, which the -1-day shift below avoids
  // by always landing on the previous calendar day in a different past year).
  db.addTurn(gameId, { player, set: 1, leg: 1, bust: false, checkout: false, checkoutPoints: null, darts: [{ sector: 1, multiplier: 1 }], ...opts });
  db._db.prepare("UPDATE turns SET created_at = datetime(?, '-1 day') WHERE id = ?").run(`2010-${MM}-${DD} 12:00:00`, lastTurnId());
}

function x01Game(name) {
  return db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name }] });
}

describe('getOnThisDay', () => {
  test('a 180 on this exact month/day in a past year is the top-priority flashback', () => {
    const name = 'OTD_180';
    db.addPlayer(name);
    const g = x01Game(name);
    pastDayTurn(g.gameId, name, thisYear - 2, { scored: 180 });
    const flashback = db.getOnThisDay(name, 0);
    assert.equal(flashback.type, '180');
    assert.equal(flashback.year, thisYear - 2);
    assert.equal(flashback.yearsAgo, 2);
  });

  test('a 180 outranks a 170 checkout from a different past year on the same day', () => {
    const name = 'OTD_Priority_180_over_170';
    db.addPlayer(name);
    const g = x01Game(name);
    pastDayTurn(g.gameId, name, thisYear - 3, { scored: 180 });
    pastDayTurn(g.gameId, name, thisYear - 1, { scored: 170, checkout: true, checkoutPoints: 170 });
    const flashback = db.getOnThisDay(name, 0);
    assert.equal(flashback.type, '180', 'priority 3 beats priority 2 even though the 170 is more recent');
  });

  test('a 170 checkout outranks a 100+ checkout', () => {
    const name = 'OTD_Priority_170_over_100';
    db.addPlayer(name);
    const g = x01Game(name);
    pastDayTurn(g.gameId, name, thisYear - 1, { scored: 100, checkout: true, checkoutPoints: 100 });
    pastDayTurn(g.gameId, name, thisYear - 2, { scored: 170, checkout: true, checkoutPoints: 170 });
    const flashback = db.getOnThisDay(name, 0);
    assert.equal(flashback.type, 'bigfish');
  });

  test('among equal-priority candidates, the most recent year wins', () => {
    const name = 'OTD_MostRecentYear';
    db.addPlayer(name);
    const g = x01Game(name);
    pastDayTurn(g.gameId, name, thisYear - 5, { scored: 180 });
    pastDayTurn(g.gameId, name, thisYear - 1, { scored: 180 });
    const flashback = db.getOnThisDay(name, 0);
    assert.equal(flashback.year, thisYear - 1);
    assert.equal(flashback.yearsAgo, 1);
  });

  test('a cricket 9-mark visit scoring 180 cricket points never surfaces as a "180" flashback', () => {
    const name = 'OTD_Cricket_Not_180';
    db.addPlayer(name);
    db.addPlayer('OTD_Cricket_Opp');
    const g = db.createGame({
      category: 'Cricket (15-20, Bull)', legsPerSet: 1, setsPerGame: 1, practice: 0,
      gameType: 'cricket', config: { numbers: [15, 16, 17, 18, 19, 20, 25] },
      players: [{ name }, { name: 'OTD_Cricket_Opp' }],
    });
    pastDayTurn(g.gameId, name, thisYear - 1, { scored: 180 }); // cricket points, not an X01 180
    assert.equal(db.getOnThisDay(name, 0), null, 'no eligible (priority >= 1) match exists');
  });

  test('a 90-point checkout does not qualify (below the 100+ threshold)', () => {
    const name = 'OTD_Below100';
    db.addPlayer(name);
    const g = x01Game(name);
    pastDayTurn(g.gameId, name, thisYear - 1, { scored: 90, checkout: true, checkoutPoints: 90 });
    assert.equal(db.getOnThisDay(name, 0), null);
  });

  test('a turn on a different calendar day (same year offset) is never matched', () => {
    const name = 'OTD_WrongDay';
    db.addPlayer(name);
    const g = x01Game(name);
    offDayTurn(g.gameId, name, { scored: 180 });
    assert.equal(db.getOnThisDay(name, 0), null, 'a 180 on a different day never counts as "on this day"');
  });

  test('a player with no history at all returns null', () => {
    const name = 'OTD_NoHistory';
    db.addPlayer(name);
    assert.equal(db.getOnThisDay(name, 0), null);
  });
});
