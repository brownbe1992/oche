'use strict';
// Committed tests for getPlayerCsvExport() (docs/archive/data-export-roadmap.md — the CSV
// "your own stats as a spreadsheet" export, the simpler non-portable counterpart to
// getPlayerExport()'s JSON). Per CLAUDE.md's standing rule, every calculated column
// (points_scored, avg_per_turn, best_turn, busts, checkouts, highest_checkout,
// result, darts_thrown, the per-dart notation) gets its math proven here, plus the
// scoping guarantee that an opponent's turns never leak into the player's rows, and
// the two security-relevant encoding behaviors (RFC-4180 quoting and the
// formula-injection guard for hostile player names).
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

// Minimal CSV reader for assertions: handles the quoted cells _csvCell() produces.
// Deliberately independent of the implementation's own encoder so an encoding bug
// can't hide from its own decoder.
function parseCsv(text) {
  assert.ok(text.endsWith('\r\n'), 'CSV ends with a CRLF');
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  return rows;
}
function asObjects(text) {
  const [header, ...rows] = parseCsv(text);
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

describe('getPlayerCsvExport (docs/archive/data-export-roadmap.md — CSV spreadsheet export)', () => {
  // Shared fixture: Ben vs Alaina H2H (Ben wins with a checkout, Alaina busts once),
  // plus Ben's own solo practice game, plus Alaina's unrelated solo game that must
  // never appear in Ben's CSVs.
  let h2h, solo, alainaSolo;
  test('fixture setup', () => {
    db.addPlayer('csv_ben');
    db.addPlayer('csv_alaina');

    h2h = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'csv_ben' }, { name: 'csv_alaina' }] });
    db.addTurn(h2h.gameId, { player: 'csv_ben', set: 1, leg: 1, scored: 100, darts: [
      { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 },
    ] });
    db.addTurn(h2h.gameId, { player: 'csv_alaina', set: 1, leg: 1, scored: 0, bust: 1, darts: [
      { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 }, { sector: 20, multiplier: 3 },
    ] });
    db.addTurn(h2h.gameId, { player: 'csv_ben', set: 1, leg: 1, scored: 40, checkout: 1, checkoutPoints: 40, darts: [
      { sector: 20, multiplier: 2 },
    ] });
    db.completeGame(h2h.gameId, 'csv_ben');

    solo = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name: 'csv_ben' }] });
    db.addTurn(solo.gameId, { player: 'csv_ben', set: 1, leg: 1, scored: 26, darts: [
      { sector: 20, multiplier: 1 }, { sector: 5, multiplier: 1 }, { sector: 1, multiplier: 1 },
    ] });

    alainaSolo = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
      players: [{ name: 'csv_alaina' }] });
    db.addTurn(alainaSolo.gameId, { player: 'csv_alaina', set: 1, leg: 1, scored: 45, darts: [
      { sector: 15, multiplier: 1 }, { sector: 15, multiplier: 1 }, { sector: 15, multiplier: 1 },
    ] });
  });

  test("games CSV: one row per game with correct player-scoped aggregates, result, and opponents; the opponent's unrelated game never appears", () => {
    const games = asObjects(db.getPlayerCsvExport('csv_ben', 'games'));
    assert.equal(games.length, 2, "Ben's two games, nothing else");
    assert.equal(games.some(g => g.game_id === String(alainaSolo.gameId)), false, "Alaina's solo game must not appear");

    const h2hRow = games.find(g => g.game_id === String(h2h.gameId));
    assert.equal(h2hRow.game_type, 'x01');
    assert.equal(h2hRow.category, '501');
    assert.equal(h2hRow.practice, '0');
    assert.equal(h2hRow.opponents, 'csv_alaina');
    assert.equal(h2hRow.result, 'won');
    // Ben's own turns only: 100 + 40 over 2 turns, 4 darts — Alaina's 0-scored bust
    // turn (3 more darts in the same game) must not pollute his aggregates.
    assert.equal(h2hRow.turns, '2');
    assert.equal(h2hRow.darts_thrown, '4');
    assert.equal(h2hRow.points_scored, '140');
    assert.equal(h2hRow.avg_per_turn, '70');
    assert.equal(h2hRow.best_turn, '100');
    assert.equal(h2hRow.busts, '0');
    assert.equal(h2hRow.checkouts, '1');
    assert.equal(h2hRow.highest_checkout, '40');

    const soloRow = games.find(g => g.game_id === String(solo.gameId));
    assert.equal(soloRow.practice, '1');
    assert.equal(soloRow.opponents, '', 'a solo game has no opponents');
    assert.equal(soloRow.result, 'unfinished', 'an open-ended practice game never completed');
    assert.equal(soloRow.turns, '1');
    assert.equal(soloRow.points_scored, '26');
    assert.equal(soloRow.avg_per_turn, '26');
    assert.equal(soloRow.highest_checkout, '', 'no checkout -> empty cell, not 0');

    // The losing side of the same H2H game: Alaina's row reports 'lost' and HER
    // aggregates (1 bust turn, 0 points), proving result/aggregates are relative
    // to the requested player, not to the game.
    const alainaGames = asObjects(db.getPlayerCsvExport('csv_alaina', 'games'));
    const alainaH2h = alainaGames.find(g => g.game_id === String(h2h.gameId));
    assert.equal(alainaH2h.result, 'lost');
    assert.equal(alainaH2h.opponents, 'csv_ben');
    assert.equal(alainaH2h.turns, '1');
    assert.equal(alainaH2h.busts, '1');
    assert.equal(alainaH2h.points_scored, '0');
  });

  test('avg_per_turn rounds to 2 decimals', () => {
    db.addPlayer('csv_avg');
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: 'csv_avg' }] });
    for (const scored of [26, 41, 33]) { // 100 / 3 = 33.333... -> 33.33
      db.addTurn(g.gameId, { player: 'csv_avg', set: 1, leg: 1, scored, darts: [{ sector: 20, multiplier: 1 }] });
    }
    const [row] = asObjects(db.getPlayerCsvExport('csv_avg', 'games'));
    assert.equal(row.avg_per_turn, '33.33');
  });

  test("turns CSV: one row per own turn in order, with per-dart notation; opponent's turns in shared games are excluded", () => {
    const turns = asObjects(db.getPlayerCsvExport('csv_ben', 'turns'));
    assert.equal(turns.length, 3, "Ben's 3 turns only — not Alaina's turn in the shared game");

    const [t1, t2, t3] = turns;
    assert.equal(t1.game_id, String(h2h.gameId));
    assert.equal(t1.scored, '100');
    assert.equal(t1.bust, '0');
    assert.equal(t1.darts, '3');
    assert.equal(t1.darts_detail, 'T20 S20 S20');

    assert.equal(t2.scored, '40');
    assert.equal(t2.checkout, '1');
    assert.equal(t2.checkout_points, '40');
    assert.equal(t2.darts, '1');
    assert.equal(t2.darts_detail, 'D20');

    assert.equal(t3.game_id, String(solo.gameId));
    assert.equal(t3.darts_detail, 'S20 S5 S1');
    assert.equal(t3.target_score, '', 'target_score only populated for Checkout Trainer turns');
  });

  test('dart notation covers miss, single bull, and bullseye', () => {
    db.addPlayer('csv_notation');
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1, players: [{ name: 'csv_notation' }] });
    db.addTurn(g.gameId, { player: 'csv_notation', set: 1, leg: 1, scored: 75, darts: [
      { sector: 0, multiplier: 1 }, { sector: 25, multiplier: 1 }, { sector: 25, multiplier: 2 },
    ] });
    const [row] = asObjects(db.getPlayerCsvExport('csv_notation', 'turns'));
    assert.equal(row.darts_detail, 'MISS 25 BULL');
  });

  test('a player name containing commas and quotes is RFC-4180 quoted, and a formula-shaped name is neutralized', () => {
    // Names only reject control characters (validatePlayerName), so both of these
    // are legal rosters entries — the CSV layer has to handle them, not the roster.
    db.addPlayer('csv_quoted, "the arrow"');
    db.addPlayer('=HYPERLINK("http://evil")');
    const g = db.createGame({ category: '501', legsPerSet: 1, setsPerGame: 1, practice: 0,
      players: [{ name: 'csv_quoted, "the arrow"' }, { name: '=HYPERLINK("http://evil")' }] });
    db.addTurn(g.gameId, { player: 'csv_quoted, "the arrow"', set: 1, leg: 1, scored: 60, darts: [
      { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 }, { sector: 20, multiplier: 1 },
    ] });

    const raw = db.getPlayerCsvExport('csv_quoted, "the arrow"', 'games');
    // The opponents cell round-trips through a real CSV parse with the formula
    // guard prefix in place of the raw leading '=' — never an executable formula.
    const [row] = asObjects(raw);
    assert.equal(row.opponents, '\'=HYPERLINK("http://evil")');
    assert.equal(raw.includes(',=HYPERLINK'), false, 'no cell may begin with a bare =');
    assert.equal(raw.includes('"=HYPERLINK'), false, 'not even inside a quoted cell');
  });

  test('a player with no games exports a header-only CSV for both kinds', () => {
    db.addPlayer('csv_empty');
    const games = parseCsv(db.getPlayerCsvExport('csv_empty', 'games'));
    const turns = parseCsv(db.getPlayerCsvExport('csv_empty', 'turns'));
    assert.equal(games.length, 1, 'header row only');
    assert.equal(turns.length, 1, 'header row only');
    assert.deepEqual(games[0], ['game_id', 'started_at', 'completed_at', 'game_type', 'category',
      'legs_per_set', 'sets_per_game', 'practice', 'opponents', 'result', 'turns',
      'darts_thrown', 'points_scored', 'avg_per_turn', 'best_turn', 'busts',
      'checkouts', 'highest_checkout']);
    assert.deepEqual(turns[0], ['turn_id', 'game_id', 'game_type', 'category', 'turn_at', 'set_no',
      'leg_no', 'scored', 'bust', 'checkout', 'checkout_points', 'leg_won',
      'target_score', 'darts', 'darts_detail']);
  });

  test('throws 404 for an unknown player and 400 for an unknown kind', () => {
    assert.throws(() => db.getPlayerCsvExport('csv_does_not_exist_xyz', 'games'), /Player not found/);
    assert.throws(() => db.getPlayerCsvExport('csv_ben', 'darts'), /kind must be one of/);
  });
});
