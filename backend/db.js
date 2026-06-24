'use strict';
/* =============================================================================
   Database layer for the darts scorer.

   Uses Node's built-in SQLite (node:sqlite, Node 22.5+), so there are NO
   external dependencies to install or compile — important for running on
   Unraid / Docker without native-module headaches.

   The schema is normalized and event-based: we store every TURN a player
   throws, plus the games they were part of, and compute all statistics with
   SQL queries. Nothing is pre-aggregated, so the numbers can never drift out
   of sync, and richer stats can be added later without changing how data is
   stored.
   ============================================================================= */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DARTS_DB || path.join(__dirname, '..', 'data', 'darts.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    out_mode   TEXT NOT NULL DEFAULT 'double' CHECK (out_mode IN ('double','single')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    category      TEXT NOT NULL,
    legs_per_set  INTEGER NOT NULL,
    sets_per_game INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at  TEXT,
    winner_id     INTEGER REFERENCES players(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS game_players (
    game_id   INTEGER NOT NULL REFERENCES games(id)   ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    PRIMARY KEY (game_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS turns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id         INTEGER NOT NULL REFERENCES games(id)   ON DELETE CASCADE,
    player_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    set_no          INTEGER NOT NULL,
    leg_no          INTEGER NOT NULL,
    scored          INTEGER NOT NULL,
    treble_less     INTEGER NOT NULL DEFAULT 0,
    bust            INTEGER NOT NULL DEFAULT 0,
    checkout        INTEGER NOT NULL DEFAULT 0,
    checkout_points INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_turns_player ON turns(player_id);
  CREATE INDEX IF NOT EXISTS idx_turns_game   ON turns(game_id);
`);

/* ---------- prepared statements ---------- */
const q = {
  playerByName : db.prepare('SELECT id, name, out_mode FROM players WHERE name = ? COLLATE NOCASE'),
  insertPlayer : db.prepare("INSERT INTO players (name, out_mode) VALUES (?, ?)"),
  listPlayers  : db.prepare('SELECT id, name, out_mode FROM players ORDER BY name COLLATE NOCASE'),
  renamePlayer : db.prepare('UPDATE players SET name = ? WHERE id = ?'),
  setOut       : db.prepare('UPDATE players SET out_mode = ? WHERE id = ?'),
  deletePlayer : db.prepare('DELETE FROM players WHERE id = ?'),

  insertGame   : db.prepare('INSERT INTO games (category, legs_per_set, sets_per_game) VALUES (?, ?, ?)'),
  addParticipant: db.prepare('INSERT OR IGNORE INTO game_players (game_id, player_id) VALUES (?, ?)'),
  completeGame : db.prepare("UPDATE games SET completed_at = datetime('now'), winner_id = ? WHERE id = ?"),

  insertTurn   : db.prepare(`INSERT INTO turns
                   (game_id, player_id, set_no, leg_no, scored, treble_less, bust, checkout, checkout_points)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
};

/* ---------- player operations ---------- */
function getPlayer(name) { return q.playerByName.get(String(name)); }

function ensurePlayer(name, out = 'double') {
  const existing = getPlayer(name);
  if (existing) return existing;
  q.insertPlayer.run(String(name).trim(), out === 'single' ? 'single' : 'double');
  return getPlayer(name);
}

function listPlayers() {
  return q.listPlayers.all().map(p => ({ name: p.name, out: p.out_mode }));
}

function addPlayer(name, out = 'double') {
  name = String(name || '').trim();
  if (!name) throw httpError(400, 'Name is required');
  const existing = getPlayer(name);
  if (existing) return { name: existing.name, out: existing.out_mode };
  q.insertPlayer.run(name, out === 'single' ? 'single' : 'double');
  return { name, out: out === 'single' ? 'single' : 'double' };
}

function renamePlayer(from, to) {
  to = String(to || '').trim();
  if (!to) throw httpError(400, 'New name is required');
  const p = getPlayer(from);
  if (!p) throw httpError(404, 'Player not found');
  const clash = getPlayer(to);
  if (clash && clash.id !== p.id) throw httpError(409, `"${to}" already exists`);
  q.renamePlayer.run(to, p.id);
  return { name: to };
}

function setOut(name, out) {
  const p = ensurePlayer(name);
  q.setOut.run(out === 'single' ? 'single' : 'double', p.id);
  return { name: p.name, out: out === 'single' ? 'single' : 'double' };
}

function deletePlayer(name) {
  const p = getPlayer(name);
  if (p) q.deletePlayer.run(p.id);     // cascades to turns + game_players
  return { ok: true };
}

/* ---------- game + turn operations ---------- */
function createGame({ category, legsPerSet, setsPerGame, players }) {
  const info = q.insertGame.run(String(category), Number(legsPerSet) || 1, Number(setsPerGame) || 1);
  const gameId = Number(info.lastInsertRowid);
  (players || []).forEach(nm => {
    const p = ensurePlayer(nm);
    q.addParticipant.run(gameId, p.id);
  });
  return { gameId };
}

function addTurn(gameId, t) {
  const p = ensurePlayer(t.player);
  q.insertTurn.run(
    Number(gameId), p.id,
    Number(t.set || 1), Number(t.leg || 1),
    Number(t.scored) || 0,
    t.trebleLess ? 1 : 0,
    t.bust ? 1 : 0,
    t.checkout ? 1 : 0,
    t.checkout ? (Number(t.checkoutPoints) || 0) : null
  );
  return { ok: true };
}

function completeGame(gameId, winnerName) {
  const w = winnerName ? getPlayer(winnerName) : null;
  q.completeGame.run(w ? w.id : null, Number(gameId));
  return { ok: true };
}

/* ---------- statistics (computed with SQL) ---------- */
function computeStats() {
  const players = q.listPlayers.all();

  const agg = db.prepare(`
    SELECT player_id,
           COUNT(*)                                                            AS turns,
           COALESCE(SUM(scored), 0)                                            AS total,
           COALESCE(SUM(treble_less), 0)                                       AS trebleLess,
           COALESCE(SUM(CASE WHEN checkout = 1 AND checkout_points >= 100
                             THEN 1 ELSE 0 END), 0)                            AS co100
    FROM turns GROUP BY player_id
  `).all();

  const legs = db.prepare(`
    SELECT t.player_id AS pid, g.category AS cat,
           COUNT(DISTINCT t.game_id || '-' || t.set_no || '-' || t.leg_no) AS legs
    FROM turns t JOIN games g ON g.id = t.game_id
    GROUP BY t.player_id, g.category
  `).all();

  const gms = db.prepare(`
    SELECT gp.player_id AS pid, g.category AS cat, COUNT(*) AS games
    FROM game_players gp JOIN games g ON g.id = gp.game_id
    WHERE g.completed_at IS NOT NULL
    GROUP BY gp.player_id, g.category
  `).all();

  // H2H = games with 2+ players. Track wins only (not participation).
  const h2hLegs = db.prepare(`
    SELECT t.player_id AS pid, g.category AS cat, COUNT(*) AS legs
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE t.checkout = 1
      AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
    GROUP BY t.player_id, g.category
  `).all();

  const h2hSets = db.prepare(`
    SELECT player_id AS pid, category AS cat, COUNT(*) AS sets
    FROM (
      SELECT t.player_id, g.category
      FROM turns t JOIN games g ON g.id = t.game_id
      WHERE t.checkout = 1
        AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
      GROUP BY t.game_id, t.player_id, g.category, t.set_no
      HAVING COUNT(*) >= g.legs_per_set
    )
    GROUP BY player_id, category
  `).all();

  const h2hGames = db.prepare(`
    SELECT g.winner_id AS pid, g.category AS cat, COUNT(*) AS games
    FROM games g
    WHERE g.completed_at IS NOT NULL
      AND g.winner_id IS NOT NULL
      AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
    GROUP BY g.winner_id, g.category
  `).all();

  const aggById = {}; agg.forEach(r => aggById[r.player_id] = r);
  const nameById = {};
  const out = {};
  players.forEach(p => {
    nameById[p.id] = p.name;
    const a = aggById[p.id] || { turns: 0, total: 0, trebleLess: 0, co100: 0 };
    out[p.name] = {
      out: p.out_mode,
      turns: a.turns,
      totalPoints: a.total,
      trebleLess: a.trebleLess,
      checkouts100: a.co100,
      legsByCat: {},
      gamesByCat: {},
      h2hLegsWonByCat: {},
      h2hSetsWonByCat: {},
      h2hGamesWonByCat: {},
    };
  });
  legs.forEach(r => { const nm = nameById[r.pid]; if (nm) out[nm].legsByCat[r.cat] = r.legs; });
  gms.forEach(r => { const nm = nameById[r.pid]; if (nm) out[nm].gamesByCat[r.cat] = r.games; });
  h2hLegs.forEach(r => { const nm = nameById[r.pid]; if (nm) out[nm].h2hLegsWonByCat[r.cat] = r.legs; });
  h2hSets.forEach(r => { const nm = nameById[r.pid]; if (nm) out[nm].h2hSetsWonByCat[r.cat] = r.sets; });
  h2hGames.forEach(r => { const nm = nameById[r.pid]; if (nm) out[nm].h2hGamesWonByCat[r.cat] = r.games; });
  return out;
}

function resetStats() {
  db.exec('DELETE FROM turns; DELETE FROM game_players; DELETE FROM games;');
  return { ok: true };
}

/* ---------- helpers ---------- */
function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}

module.exports = {
  listPlayers, addPlayer, renamePlayer, setOut, deletePlayer,
  createGame, addTurn, completeGame,
  computeStats, resetStats,
  _db: db,
};
