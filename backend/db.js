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

  CREATE TABLE IF NOT EXISTS timeline_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    set_no      INTEGER,
    leg_no      INTEGER,
    event_type  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_timeline_game ON timeline_events(game_id);
`);

// Column migrations — safe to re-run; ALTER TABLE throws if column exists, which we catch.
try { db.exec('ALTER TABLE players      ADD COLUMN dart_weight INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE game_players ADD COLUMN dart_weight INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE games        ADD COLUMN practice    INTEGER NOT NULL DEFAULT 0'); } catch(e) {}

/* ---------- prepared statements ---------- */
const q = {
  playerByName : db.prepare('SELECT id, name, out_mode, dart_weight FROM players WHERE name = ? COLLATE NOCASE'),
  insertPlayer : db.prepare("INSERT INTO players (name, out_mode) VALUES (?, ?)"),
  listPlayers  : db.prepare('SELECT id, name, out_mode, dart_weight FROM players ORDER BY name COLLATE NOCASE'),
  renamePlayer : db.prepare('UPDATE players SET name = ? WHERE id = ?'),
  setOut       : db.prepare('UPDATE players SET out_mode = ? WHERE id = ?'),
  setDartWeight: db.prepare('UPDATE players SET dart_weight = ? WHERE id = ?'),
  deletePlayer : db.prepare('DELETE FROM players WHERE id = ?'),

  insertGame   : db.prepare('INSERT INTO games (category, legs_per_set, sets_per_game, practice) VALUES (?, ?, ?, ?)'),
  addParticipant: db.prepare('INSERT OR IGNORE INTO game_players (game_id, player_id, dart_weight) VALUES (?, ?, ?)'),
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
  return q.listPlayers.all().map(p => ({ name: p.name, out: p.out_mode, dartWeight: p.dart_weight ?? null }));
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

function setDartWeight(name, weight) {
  const p = getPlayer(name);
  if (!p) throw httpError(404, 'Player not found');
  const w = (weight !== null && weight !== undefined && weight !== '') ? Number(weight) : null;
  q.setDartWeight.run(w, p.id);
  return { name: p.name, dartWeight: w };
}

function getDartWeights(playerName) {
  const p = getPlayer(playerName);
  if (!p) return [];
  return db.prepare(`
    SELECT DISTINCT gp.dart_weight AS weight
    FROM game_players gp
    WHERE gp.player_id = ? AND gp.dart_weight IS NOT NULL
    ORDER BY gp.dart_weight
  `).all(p.id).map(r => r.weight);
}

function deletePlayer(name) {
  const p = getPlayer(name);
  if (p) q.deletePlayer.run(p.id);     // cascades to turns + game_players
  return { ok: true };
}

/* ---------- game + turn operations ---------- */
function createGame({ category, legsPerSet, setsPerGame, players, practice }) {
  const info = q.insertGame.run(String(category), Number(legsPerSet) || 1, Number(setsPerGame) || 1, practice ? 1 : 0);
  const gameId = Number(info.lastInsertRowid);
  (players || []).forEach(nm => {
    const p = ensurePlayer(nm);
    q.addParticipant.run(gameId, p.id, p.dart_weight ?? null);
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

  // H2H = non-practice games with 2+ players
  const legs = db.prepare(`
    SELECT t.player_id AS pid, g.category AS cat,
           COUNT(DISTINCT t.game_id || '-' || t.set_no || '-' || t.leg_no) AS legs
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE g.practice = 0
      AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
    GROUP BY t.player_id, g.category
  `).all();

  const gms = db.prepare(`
    SELECT gp.player_id AS pid, g.category AS cat, COUNT(*) AS games
    FROM game_players gp JOIN games g ON g.id = gp.game_id
    WHERE g.completed_at IS NOT NULL AND g.practice = 0
      AND (SELECT COUNT(*) FROM game_players gp2 WHERE gp2.game_id = g.id) > 1
    GROUP BY gp.player_id, g.category
  `).all();

  const h2hLegs = db.prepare(`
    SELECT t.player_id AS pid, g.category AS cat, COUNT(*) AS legs
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE t.checkout = 1 AND g.practice = 0
      AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
    GROUP BY t.player_id, g.category
  `).all();

  const h2hSets = db.prepare(`
    SELECT player_id AS pid, category AS cat, COUNT(*) AS sets
    FROM (
      SELECT t.player_id, g.category
      FROM turns t JOIN games g ON g.id = t.game_id
      WHERE t.checkout = 1 AND g.practice = 0
        AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
      GROUP BY t.game_id, t.player_id, g.category, t.set_no
      HAVING COUNT(*) >= g.legs_per_set
    )
    GROUP BY player_id, category
  `).all();

  const h2hGames = db.prepare(`
    SELECT g.winner_id AS pid, g.category AS cat, COUNT(*) AS games
    FROM games g
    WHERE g.completed_at IS NOT NULL AND g.winner_id IS NOT NULL AND g.practice = 0
      AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
    GROUP BY g.winner_id, g.category
  `).all();

  // Practice = explicit practice flag OR solo (1-player) games
  const practiceLegs = db.prepare(`
    SELECT t.player_id AS pid, g.category AS cat,
           COUNT(DISTINCT t.game_id || '-' || t.set_no || '-' || t.leg_no) AS legs
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE g.practice = 1
      OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) = 1
    GROUP BY t.player_id, g.category
  `).all();

  // Average darts per leg (visits × 3) for won legs only
  const h2hAvgDarts = db.prepare(`
    SELECT pid, AVG(leg_visits) * 3 AS avg_darts
    FROM (
      SELECT t.player_id AS pid, COUNT(*) AS leg_visits
      FROM turns t JOIN games g ON g.id = t.game_id
      WHERE g.practice = 0
        AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING SUM(CASE WHEN t.checkout = 1 THEN 1 ELSE 0 END) > 0
    ) GROUP BY pid
  `).all();

  const practiceAvgDarts = db.prepare(`
    SELECT pid, AVG(leg_visits) * 3 AS avg_darts
    FROM (
      SELECT t.player_id AS pid, COUNT(*) AS leg_visits
      FROM turns t JOIN games g ON g.id = t.game_id
      WHERE g.practice = 1
        OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) = 1
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING SUM(CASE WHEN t.checkout = 1 THEN 1 ELSE 0 END) > 0
    ) GROUP BY pid
  `).all();

  // Nine-darters: 501 legs won in exactly 3 visits
  const nineDarterBase = (extraWhere) => db.prepare(`
    SELECT pid, COUNT(*) AS n FROM (
      SELECT t.player_id AS pid
      FROM turns t JOIN games g ON g.id = t.game_id
      WHERE g.category = '501' ${extraWhere}
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING COUNT(*) = 3 AND SUM(t.checkout) = 1
    ) GROUP BY pid
  `).all();

  const nd9All  = nineDarterBase('');
  const nd9H2H  = nineDarterBase("AND g.practice = 0 AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1");
  const nd9Prac = nineDarterBase("AND (g.practice = 1 OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) = 1)");

  const agg180 = db.prepare(
    'SELECT player_id, COUNT(*) AS n FROM turns WHERE scored = 180 GROUP BY player_id'
  ).all();

  const aggBF = db.prepare(
    'SELECT player_id, COUNT(*) AS n FROM turns WHERE checkout = 1 AND checkout_points = 170 GROUP BY player_id'
  ).all();

  const h2hAgg = db.prepare(`
    SELECT t.player_id,
      COUNT(*) AS turns,
      COALESCE(SUM(t.scored), 0) AS total,
      COALESCE(SUM(t.treble_less), 0) AS trebleLess,
      COALESCE(SUM(CASE WHEN t.checkout=1 AND t.checkout_points>=100 THEN 1 ELSE 0 END),0) AS co100,
      COALESCE(SUM(CASE WHEN t.scored=180 THEN 1 ELSE 0 END),0) AS oneEighties,
      COALESCE(SUM(CASE WHEN t.checkout=1 AND t.checkout_points=170 THEN 1 ELSE 0 END),0) AS bigFish
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE g.practice = 0
      AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
    GROUP BY t.player_id
  `).all();

  const pracAgg = db.prepare(`
    SELECT t.player_id,
      COUNT(*) AS turns,
      COALESCE(SUM(t.scored), 0) AS total,
      COALESCE(SUM(t.treble_less), 0) AS trebleLess,
      COALESCE(SUM(CASE WHEN t.checkout=1 AND t.checkout_points>=100 THEN 1 ELSE 0 END),0) AS co100,
      COALESCE(SUM(CASE WHEN t.scored=180 THEN 1 ELSE 0 END),0) AS oneEighties,
      COALESCE(SUM(CASE WHEN t.checkout=1 AND t.checkout_points=170 THEN 1 ELSE 0 END),0) AS bigFish
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE g.practice = 1
      OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) = 1
    GROUP BY t.player_id
  `).all();

  const aggById = {}; agg.forEach(r => aggById[r.player_id] = r);
  const nd9AllById  = {}; nd9All.forEach(r  => nd9AllById[r.pid]  = r.n);
  const nd9H2HById  = {}; nd9H2H.forEach(r  => nd9H2HById[r.pid]  = r.n);
  const nd9PracById = {}; nd9Prac.forEach(r => nd9PracById[r.pid] = r.n);
  const agg180ById    = {}; agg180.forEach(r => agg180ById[r.player_id] = r.n);
  const aggBFById     = {}; aggBF.forEach(r  => aggBFById[r.player_id]  = r.n);
  const h2hDartsById  = {}; h2hAvgDarts.forEach(r     => h2hDartsById[r.pid]  = r.avg_darts);
  const pracDartsById = {}; practiceAvgDarts.forEach(r => pracDartsById[r.pid] = r.avg_darts);
  const h2hAggById    = {}; h2hAgg.forEach(r  => h2hAggById[r.player_id]  = r);
  const pracAggById   = {}; pracAgg.forEach(r  => pracAggById[r.player_id] = r);
  const nameById = {};
  const out = {};
  players.forEach(p => {
    nameById[p.id] = p.name;
    const a = aggById[p.id] || { turns: 0, total: 0, trebleLess: 0, co100: 0 };
    const ha = h2hAggById[p.id]  || { turns:0, total:0, trebleLess:0, co100:0, oneEighties:0, bigFish:0 };
    const pa = pracAggById[p.id] || { turns:0, total:0, trebleLess:0, co100:0, oneEighties:0, bigFish:0 };
    out[p.name] = {
      out: p.out_mode,
      dartWeight: p.dart_weight ?? null,
      turns: a.turns,
      totalPoints: a.total,
      trebleLess: a.trebleLess,
      checkouts100: a.co100,
      oneEighties: agg180ById[p.id] ?? 0,
      bigFish: aggBFById[p.id] ?? 0,
      nineDarters: nd9AllById[p.id] ?? 0,
      h2hAvgDartsPerLeg: h2hDartsById[p.id] != null ? +h2hDartsById[p.id].toFixed(1) : null,
      practiceAvgDartsPerLeg: pracDartsById[p.id] != null ? +pracDartsById[p.id].toFixed(1) : null,
      h2hStats: { turns:ha.turns, totalPoints:ha.total, trebleLess:ha.trebleLess,
                  checkouts100:ha.co100, oneEighties:ha.oneEighties, bigFish:ha.bigFish,
                  nineDarters: nd9H2HById[p.id] ?? 0 },
      practiceStats: { turns:pa.turns, totalPoints:pa.total, trebleLess:pa.trebleLess,
                       checkouts100:pa.co100, oneEighties:pa.oneEighties, bigFish:pa.bigFish,
                       nineDarters: nd9PracById[p.id] ?? 0 },
      legsByCat: {},
      gamesByCat: {},
      practiceLegs: {},
      h2hLegsWonByCat: {},
      h2hSetsWonByCat: {},
      h2hGamesWonByCat: {},
    };
  });
  legs.forEach(r => { const nm = nameById[r.pid]; if (nm) out[nm].legsByCat[r.cat] = r.legs; });
  gms.forEach(r => { const nm = nameById[r.pid]; if (nm) out[nm].gamesByCat[r.cat] = r.games; });
  practiceLegs.forEach(r => { const nm = nameById[r.pid]; if (nm) out[nm].practiceLegs[r.cat] = r.legs; });
  h2hLegs.forEach(r => { const nm = nameById[r.pid]; if (nm) out[nm].h2hLegsWonByCat[r.cat] = r.legs; });
  h2hSets.forEach(r => { const nm = nameById[r.pid]; if (nm) out[nm].h2hSetsWonByCat[r.cat] = r.sets; });
  h2hGames.forEach(r => { const nm = nameById[r.pid]; if (nm) out[nm].h2hGamesWonByCat[r.cat] = r.games; });
  return out;
}

function getSummary() {
  const players    = db.prepare('SELECT COUNT(*) AS n FROM players').get().n;
  const games      = db.prepare('SELECT COUNT(*) AS n FROM games WHERE completed_at IS NOT NULL').get().n;
  const sets       = db.prepare("SELECT COUNT(DISTINCT game_id || '-' || set_no) AS n FROM turns").get().n;
  const legs       = db.prepare("SELECT COUNT(DISTINCT game_id || '-' || set_no || '-' || leg_no) AS n FROM turns").get().n;
  const darts      = db.prepare('SELECT COUNT(*) AS n FROM turns').get().n * 3;
  const oneEighties  = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE scored = 180').get().n;
  const bigFish      = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE checkout = 1 AND checkout_points = 170').get().n;
  const nineDarters  = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT t.player_id FROM turns t JOIN games g ON g.id = t.game_id
      WHERE g.category = '501'
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING COUNT(*) = 3 AND SUM(t.checkout) = 1
    )
  `).get().n;
  return { players, games, sets, legs, darts, oneEighties, bigFish, nineDarters };
}

function getOneEightyStats() {
  const leaderboard = db.prepare(`
    SELECT p.name, COUNT(*) AS count
    FROM turns t JOIN players p ON p.id = t.player_id
    WHERE t.scored = 180
    GROUP BY t.player_id ORDER BY count DESC
  `).all();
  const recent = db.prepare(`
    SELECT p.name, t.created_at
    FROM turns t JOIN players p ON p.id = t.player_id
    WHERE t.scored = 180
    ORDER BY t.created_at DESC LIMIT 10
  `).all();
  return { leaderboard, recent };
}

function getNineDarterStats() {
  const leaderboard = db.prepare(`
    SELECT p.name, COUNT(*) AS count
    FROM (
      SELECT t.player_id
      FROM turns t JOIN games g ON g.id = t.game_id
      WHERE g.category = '501'
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING COUNT(*) = 3 AND SUM(t.checkout) = 1
    ) x
    JOIN players p ON p.id = x.player_id
    GROUP BY x.player_id ORDER BY count DESC
  `).all();
  const recent = db.prepare(`
    SELECT p.name, MAX(t.created_at) AS created_at
    FROM turns t
    JOIN games g ON g.id = t.game_id
    JOIN players p ON p.id = t.player_id
    WHERE g.category = '501'
    GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
    HAVING COUNT(*) = 3 AND SUM(t.checkout) = 1
    ORDER BY created_at DESC LIMIT 10
  `).all();
  return { leaderboard, recent };
}

function getBigFishStats() {
  const leaderboard = db.prepare(`
    SELECT p.name, COUNT(*) AS count
    FROM turns t JOIN players p ON p.id = t.player_id
    WHERE t.checkout = 1 AND t.checkout_points = 170
    GROUP BY t.player_id ORDER BY count DESC
  `).all();
  const recent = db.prepare(`
    SELECT p.name, t.created_at
    FROM turns t JOIN players p ON p.id = t.player_id
    WHERE t.checkout = 1 AND t.checkout_points = 170
    ORDER BY t.created_at DESC LIMIT 10
  `).all();
  return { leaderboard, recent };
}

function getTopFinishesAll(limit = 10) {
  return db.prepare(`
    SELECT p.name,
           t.checkout_points AS score,
           COUNT(*)          AS times,
           MIN(t.created_at) AS first_date,
           MAX(t.created_at) AS last_date
    FROM turns t
    JOIN players p ON p.id = t.player_id
    WHERE t.checkout = 1 AND t.checkout_points > 0
    GROUP BY t.player_id, t.checkout_points
    ORDER BY t.checkout_points DESC, first_date ASC
    LIMIT ?
  `).all(limit);
}

function recordEvent(gameId, eventType, setNo, legNo) {
  db.prepare(
    'INSERT INTO timeline_events (game_id, event_type, set_no, leg_no) VALUES (?, ?, ?, ?)'
  ).run(Number(gameId), String(eventType), setNo ?? null, legNo ?? null);
  return { ok: true };
}

function getTopFinishes(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return [];
  const modeWhere = mode === 'h2h'
    ? ` AND EXISTS (SELECT 1 FROM games g WHERE g.id = t.game_id AND g.practice = 0 AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1)`
    : mode === 'practice'
    ? ` AND (EXISTS (SELECT 1 FROM games g WHERE g.id = t.game_id AND g.practice = 1) OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = t.game_id) = 1)`
    : '';
  return db.prepare(`
    SELECT t.checkout_points AS score,
           COUNT(*)          AS times,
           MIN(t.created_at) AS first_date,
           MAX(t.created_at) AS last_date
    FROM turns t
    WHERE t.player_id = ?
      AND t.checkout = 1
      AND t.checkout_points > 0
      ${modeWhere}
    GROUP BY t.checkout_points
    ORDER BY t.checkout_points DESC
    LIMIT 10
  `).all(p.id);
}

function getAvgHistory(playerName, period, opts = {}) {
  const p = getPlayer(playerName);
  if (!p) return [];

  let fmt, where;
  if (period === 'today') {
    fmt = "strftime('%H', t.created_at)";
    where = `WHERE t.player_id = ? AND date(t.created_at) = date('now')`;
  } else if (period === 'week') {
    fmt = "strftime('%Y-%m-%d', t.created_at)";
    where = `WHERE t.player_id = ? AND t.created_at >= datetime('now', '-7 days')`;
  } else if (period === 'month') {
    fmt = "strftime('%Y-%m-%d', t.created_at)";
    where = `WHERE t.player_id = ? AND t.created_at >= datetime('now', '-30 days')`;
  } else if (period === 'year') {
    // 'w' prefix distinguishes week buckets from YYYY-MM month buckets
    fmt = "'w' || strftime('%Y-%W', t.created_at)";
    where = `WHERE t.player_id = ? AND t.created_at >= datetime('now', '-365 days')`;
  } else if (period === 'custom') {
    const { start, end } = opts;
    const days = Math.round((new Date(end) - new Date(start)) / 86400000);
    if (days <= 31) {
      fmt = "strftime('%Y-%m-%d', t.created_at)";
    } else if (days <= 365) {
      fmt = "'w' || strftime('%Y-%W', t.created_at)";
    } else {
      fmt = "strftime('%Y-%m', t.created_at)";
    }
    // dates already validated as YYYY-MM-DD by the server
    where = `WHERE t.player_id = ? AND date(t.created_at) >= '${start}' AND date(t.created_at) <= '${end}'`;
  } else {
    // all time
    fmt = "strftime('%Y-%m', t.created_at)";
    where = `WHERE t.player_id = ?`;
  }

  const params = [p.id];
  let weightWhere = '';
  if (opts.dartWeight) {
    weightWhere = ` AND EXISTS (
      SELECT 1 FROM game_players gp
      WHERE gp.game_id = t.game_id AND gp.player_id = ? AND gp.dart_weight = ?
    )`;
    params.push(p.id, Number(opts.dartWeight));
  }

  const modeWhere = opts.mode === 'h2h'
    ? ` AND EXISTS (SELECT 1 FROM games g WHERE g.id = t.game_id AND g.practice = 0 AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1)`
    : opts.mode === 'practice'
    ? ` AND (EXISTS (SELECT 1 FROM games g WHERE g.id = t.game_id AND g.practice = 1) OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = t.game_id) = 1)`
    : '';

  return db.prepare(`
    SELECT ${fmt} AS bucket,
           CAST(SUM(t.scored) AS REAL) / COUNT(*) AS avg,
           COUNT(*) AS turns
    FROM turns t
    ${where}
    ${weightWhere}
    ${modeWhere}
    GROUP BY bucket
    ORDER BY bucket
  `).all(...params);
}

function clearPlayerStats(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');

  const gameIdQuery = mode === 'h2h'
    ? `SELECT g.id FROM games g
       WHERE g.practice = 0
         AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
         AND EXISTS (SELECT 1 FROM game_players gp2 WHERE gp2.game_id = g.id AND gp2.player_id = ?)`
    : `SELECT g.id FROM games g
       WHERE (g.practice = 1 OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) = 1)
         AND EXISTS (SELECT 1 FROM game_players gp2 WHERE gp2.game_id = g.id AND gp2.player_id = ?)`;

  const gameIds = db.prepare(gameIdQuery).all(p.id).map(r => r.id);
  if (!gameIds.length) return { ok: true };

  const ph = gameIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM turns        WHERE player_id = ? AND game_id IN (${ph})`).run(p.id, ...gameIds);
  db.prepare(`DELETE FROM game_players WHERE player_id = ? AND game_id IN (${ph})`).run(p.id, ...gameIds);
  return { ok: true };
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
  listPlayers, addPlayer, renamePlayer, setOut, setDartWeight, deletePlayer,
  createGame, addTurn, completeGame, recordEvent,
  computeStats, getSummary, getOneEightyStats, getBigFishStats, getNineDarterStats,
  getTopFinishes, getTopFinishesAll, getAvgHistory, getDartWeights, clearPlayerStats, resetStats,
  _db: db,
};
