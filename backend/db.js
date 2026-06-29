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
    out_mode  TEXT NOT NULL DEFAULT 'double',
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
    darts_thrown    INTEGER NOT NULL DEFAULT 3,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_turns_player ON turns(player_id);
  CREATE INDEX IF NOT EXISTS idx_turns_game   ON turns(game_id);

  CREATE TABLE IF NOT EXISTS darts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id    INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    dart_no    INTEGER NOT NULL,    -- 1, 2, or 3 (position in the visit)
    sector     INTEGER NOT NULL,    -- 0=miss  1-20=number  25=bull area
    multiplier INTEGER NOT NULL,    -- 1=single  2=double  3=treble
    scored     INTEGER NOT NULL,    -- face value regardless of bust
    is_treble  INTEGER NOT NULL DEFAULT 0,
    is_double  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_darts_turn   ON darts(turn_id);
  CREATE INDEX IF NOT EXISTS idx_darts_sector ON darts(sector, multiplier);

  CREATE TABLE IF NOT EXISTS timeline_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    set_no      INTEGER,
    leg_no      INTEGER,
    event_type  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_timeline_game ON timeline_events(game_id);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
`);

// Column migrations — safe to re-run; ALTER TABLE throws if column exists, which we catch.
try { db.exec('ALTER TABLE players      ADD COLUMN dart_weight INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE game_players ADD COLUMN dart_weight INTEGER'); } catch(e) {}
try { db.exec("ALTER TABLE game_players ADD COLUMN out_mode TEXT NOT NULL DEFAULT 'double'"); } catch(e) {}
try { db.exec('ALTER TABLE games        ADD COLUMN practice    INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE turns        ADD COLUMN darts_thrown INTEGER NOT NULL DEFAULT 3'); } catch(e) {}

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
  addParticipant: db.prepare('INSERT OR IGNORE INTO game_players (game_id, player_id, dart_weight, out_mode) VALUES (?, ?, ?, ?)'),
  completeGame : db.prepare("UPDATE games SET completed_at = datetime('now'), winner_id = ? WHERE id = ?"),

  insertTurn   : db.prepare(`INSERT INTO turns
                   (game_id, player_id, set_no, leg_no, scored, treble_less, bust, checkout, checkout_points, darts_thrown)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),

  insertDart   : db.prepare(`INSERT INTO darts
                   (turn_id, dart_no, sector, multiplier, scored, is_treble, is_double)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`),
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
  (players || []).forEach(entry => {
    // entry can be a plain name string (legacy) or { name, out } object
    const nm  = typeof entry === 'string' ? entry : entry.name;
    const out = typeof entry === 'string' ? 'double' : (entry.out === 'single' ? 'single' : 'double');
    const p   = ensurePlayer(nm);
    q.addParticipant.run(gameId, p.id, p.dart_weight ?? null, out);
  });
  return { gameId };
}

function addTurn(gameId, t) {
  const p = ensurePlayer(t.player);
  const info = q.insertTurn.run(
    Number(gameId), p.id,
    Number(t.set || 1), Number(t.leg || 1),
    Number(t.scored) || 0,
    t.trebleLess ? 1 : 0,
    t.bust ? 1 : 0,
    t.checkout ? 1 : 0,
    t.checkout ? (Number(t.checkoutPoints) || 0) : null,
    Number(t.dartsThrown) || 3
  );
  // Insert individual dart rows — one row per dart in the visit
  if (Array.isArray(t.darts) && t.darts.length) {
    const turnId = Number(info.lastInsertRowid);
    for (const d of t.darts) {
      q.insertDart.run(
        turnId,
        Number(d.dartNo),
        Number(d.sector),
        Number(d.multiplier),
        Number(d.scored),
        d.isTreble ? 1 : 0,
        d.isDouble ? 1 : 0
      );
    }
  }
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

  // Global totals are derived from h2hAgg + pracAgg (those two cover all turns exactly)

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

  // Average actual darts per leg for won legs only
  const h2hAvgDarts = db.prepare(`
    SELECT pid, AVG(leg_darts) AS avg_darts
    FROM (
      SELECT t.player_id AS pid, SUM(t.darts_thrown) AS leg_darts
      FROM turns t JOIN games g ON g.id = t.game_id
      WHERE g.practice = 0
        AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING SUM(CASE WHEN t.checkout = 1 THEN 1 ELSE 0 END) > 0
    ) GROUP BY pid
  `).all();

  const practiceAvgDarts = db.prepare(`
    SELECT pid, AVG(leg_darts) AS avg_darts
    FROM (
      SELECT t.player_id AS pid, SUM(t.darts_thrown) AS leg_darts
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
      HAVING COUNT(*) = 3 AND SUM(t.checkout) = 1 AND SUM(t.darts_thrown) = 9
    ) GROUP BY pid
  `).all();

  const nd9All  = nineDarterBase('');
  const nd9H2H  = nineDarterBase("AND g.practice = 0 AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1");
  const nd9Prac = nineDarterBase("AND (g.practice = 1 OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) = 1)");

  const h2hAgg = db.prepare(`
    SELECT t.player_id,
      COUNT(*) AS turns,
      COALESCE(SUM(t.scored), 0) AS total,
      COALESCE(SUM(t.treble_less), 0) AS trebleLess,
      COALESCE(SUM(CASE WHEN t.checkout=1 AND t.checkout_points>=100 THEN 1 ELSE 0 END),0) AS co100,
      COALESCE(SUM(CASE WHEN t.scored=180 THEN 1 ELSE 0 END),0) AS oneEighties,
      COALESCE(SUM(CASE WHEN t.checkout=1 AND t.checkout_points=170 THEN 1 ELSE 0 END),0) AS bigFish,
      COALESCE(SUM(t.darts_thrown),0) AS dartsThrown
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
      COALESCE(SUM(CASE WHEN t.checkout=1 AND t.checkout_points=170 THEN 1 ELSE 0 END),0) AS bigFish,
      COALESCE(SUM(t.darts_thrown),0) AS dartsThrown
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE g.practice = 1
      OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) = 1
    GROUP BY t.player_id
  `).all();

  const nd9AllById  = {}; nd9All.forEach(r  => nd9AllById[r.pid]  = r.n);
  const nd9H2HById  = {}; nd9H2H.forEach(r  => nd9H2HById[r.pid]  = r.n);
  const nd9PracById = {}; nd9Prac.forEach(r => nd9PracById[r.pid] = r.n);
  const h2hDartsById  = {}; h2hAvgDarts.forEach(r     => h2hDartsById[r.pid]  = r.avg_darts);
  const pracDartsById = {}; practiceAvgDarts.forEach(r => pracDartsById[r.pid] = r.avg_darts);
  const h2hAggById    = {}; h2hAgg.forEach(r  => h2hAggById[r.player_id]  = r);
  const pracAggById   = {}; pracAgg.forEach(r  => pracAggById[r.player_id] = r);
  const nameById = {};
  const out = {};
  players.forEach(p => {
    nameById[p.id] = p.name;
    const ha = h2hAggById[p.id]  || { turns:0, total:0, trebleLess:0, co100:0, oneEighties:0, bigFish:0, dartsThrown:0 };
    const pa = pracAggById[p.id] || { turns:0, total:0, trebleLess:0, co100:0, oneEighties:0, bigFish:0, dartsThrown:0 };
    out[p.name] = {
      out: p.out_mode,
      dartWeight: p.dart_weight ?? null,
      turns:       (ha.turns||0)       + (pa.turns||0),
      totalPoints: (ha.total||0)       + (pa.total||0),
      trebleLess:  (ha.trebleLess||0)  + (pa.trebleLess||0),
      checkouts100:(ha.co100||0)       + (pa.co100||0),
      dartsThrown: (ha.dartsThrown||0) + (pa.dartsThrown||0),
      oneEighties: (ha.oneEighties ?? 0) + (pa.oneEighties ?? 0),
      bigFish:     (ha.bigFish     ?? 0) + (pa.bigFish     ?? 0),
      nineDarters: nd9AllById[p.id] ?? 0,
      h2hAvgDartsPerLeg: h2hDartsById[p.id] != null ? +h2hDartsById[p.id].toFixed(1) : null,
      practiceAvgDartsPerLeg: pracDartsById[p.id] != null ? +pracDartsById[p.id].toFixed(1) : null,
      h2hStats: { turns:ha.turns, totalPoints:ha.total, trebleLess:ha.trebleLess,
                  checkouts100:ha.co100, oneEighties:ha.oneEighties, bigFish:ha.bigFish,
                  nineDarters: nd9H2HById[p.id] ?? 0, dartsThrown: ha.dartsThrown ?? 0 },
      practiceStats: { turns:pa.turns, totalPoints:pa.total, trebleLess:pa.trebleLess,
                       checkouts100:pa.co100, oneEighties:pa.oneEighties, bigFish:pa.bigFish,
                       nineDarters: nd9PracById[p.id] ?? 0, dartsThrown: pa.dartsThrown ?? 0 },
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
  const sets = db.prepare(`
    SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no) AS n
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE g.practice = 0
      AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
  `).get().n;
  const legs = db.prepare(`
    SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS n
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE g.practice = 0
      AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1
  `).get().n;
  const darts      = db.prepare('SELECT SUM(darts_thrown) AS n FROM turns').get().n ?? 0;
  const tonPlus      = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE checkout = 1 AND checkout_points >= 100').get().n;
  const oneEighties  = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE scored = 180').get().n;
  const bigFish      = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE checkout = 1 AND checkout_points = 170').get().n;
  const nineDarters  = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT t.player_id FROM turns t JOIN games g ON g.id = t.game_id
      WHERE g.category = '501'
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING COUNT(*) = 3 AND SUM(t.checkout) = 1 AND SUM(t.darts_thrown) = 9
    )
  `).get().n;
  const practiceLegs = db.prepare(`
    SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS n
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE g.practice = 1
      OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) = 1
  `).get().n;
  return { players, games, sets, legs, darts, tonPlus, oneEighties, bigFish, nineDarters, practiceLegs };
}

function getPlayerStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const mf = _mf(mode);
  const q = (sql) => { const r = db.prepare(sql).get(p.id); return r ? r.v : null; };
  const J = `FROM turns t JOIN games g ON g.id = t.game_id WHERE t.player_id = ?`;

  const dartsThrown = q(`SELECT SUM(t.darts_thrown) AS v ${J} ${mf}`) ?? 0;
  const legsWithOneEighty = q(`SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS v ${J} ${mf} AND t.scored=180`) ?? 0;
  const avg        = q(`SELECT CAST(SUM(t.scored) AS REAL)/NULLIF(COUNT(*),0) AS v ${J} ${mf}`);
  const one80s     = q(`SELECT COUNT(*) AS v ${J} ${mf} AND t.scored=180`) ?? 0;
  const bigFish    = q(`SELECT COUNT(*) AS v ${J} ${mf} AND t.checkout=1 AND t.checkout_points=170`) ?? 0;
  const nineDarters= q(`SELECT COUNT(*) AS v FROM (SELECT 1 ${J} ${mf} AND g.category='501' GROUP BY t.game_id,t.set_no,t.leg_no HAVING COUNT(*)=3 AND SUM(t.checkout)=1 AND SUM(t.darts_thrown)=9)`) ?? 0;
  const totalLegs  = q(`SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS v ${J} ${mf}`) ?? 0;
  const tlLegs     = q(`SELECT COUNT(*) AS v FROM (SELECT 1 ${J} ${mf} GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(1-t.treble_less)=0)`) ?? 0;

  const first3avg = q(`SELECT AVG(scored) AS v FROM (
    SELECT t.scored, ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
    ${J} ${mf}
  ) WHERE rn=1`);

  const first9avg = q(`SELECT AVG(first3)/3.0 AS v FROM (
    SELECT SUM(CASE WHEN rn<=3 THEN scored ELSE 0 END) AS first3,
           SUM(CASE WHEN rn<=3 THEN 1 ELSE 0 END) AS c3
    FROM (SELECT t.game_id,t.set_no,t.leg_no,t.scored,
                 ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
          ${J} ${mf}) t
    GROUP BY game_id,set_no,leg_no HAVING c3=3
  )`);

  // avg100plus and avg90minus share the same subquery — compute in one pass
  const _legAvgs = db.prepare(`SELECT CAST(SUM(t.scored) AS REAL)/COUNT(*) AS la ${J} ${mf} GROUP BY t.game_id,t.set_no,t.leg_no`).all(p.id);
  const _legAvgCount = _legAvgs.length || 0;
  const avg100plus = _legAvgCount ? _legAvgs.filter(r=>r.la>=100).length * 100 / _legAvgCount : null;
  const avg90minus = _legAvgCount ? _legAvgs.filter(r=>r.la<=90).length  * 100 / _legAvgCount : null;
  const score140pct = q(`SELECT CAST(SUM(CASE WHEN scored>=140 THEN 1 ELSE 0 END) AS REAL)*100/NULLIF(COUNT(*),0) AS v FROM (
    SELECT t.scored, ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
    ${J} ${mf}
  ) WHERE rn=1`);

  return {
    dartsThrown, avg, one80s, bigFish, nineDarters,
    treblelessPct: totalLegs > 0 ? (tlLegs / totalLegs * 100) : null,
    first3avg, first9avg, avg100plus, avg90minus, score140pct,
    one80sPerLeg: totalLegs > 0 ? (legsWithOneEighty / totalLegs) : null,
  };
}

function getMetricHistory(playerName, metric, period, opts = {}) {
  const p = getPlayer(playerName);
  if (!p) return [];
  const modeWhere = opts.mode === 'h2h'
    ? `AND g.practice = 0 AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1`
    : opts.mode === 'practice'
    ? `AND (g.practice = 1 OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) = 1)`
    : '';
  const params = [p.id];
  let weightWhere = '';
  if (opts.dartWeight) {
    weightWhere = ` AND EXISTS (SELECT 1 FROM game_players gp WHERE gp.game_id = t.game_id AND gp.player_id = ? AND gp.dart_weight = ?)`;
    params.push(p.id, Number(opts.dartWeight));
  }

  const bld = (tsCol) => {
    let fmt, flt;
    if      (period==='today')  { fmt=`strftime('%H',${tsCol})`;          flt=`date(${tsCol})=date('now')`; }
    else if (period==='week')   { fmt=`strftime('%Y-%m-%d',${tsCol})`;    flt=`${tsCol}>=datetime('now','-7 days')`; }
    else if (period==='month')  { fmt=`strftime('%Y-%m-%d',${tsCol})`;    flt=`${tsCol}>=datetime('now','-30 days')`; }
    else if (period==='year')   { fmt=`'w'||strftime('%Y-%W',${tsCol})`;  flt=`${tsCol}>=datetime('now','-365 days')`; }
    else if (period==='custom') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.start) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.end)) throw new Error('Invalid date range');
      fmt=`strftime('%Y-%m-%d',${tsCol})`; flt=`date(${tsCol})>='${opts.start}' AND date(${tsCol})<='${opts.end}'`;
    }
    else                        { fmt=`strftime('%Y-%m',${tsCol})`;       flt=null; }
    return { fmt, and: flt ? `AND ${flt}` : '', where: flt ? `WHERE ${flt}` : '' };
  };

  const T = bld('t.created_at');
  const L = bld('leg_ts');
  const F = bld('created_at');  // after window func unwrapping, no t. prefix

  const TBASE = `FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${T.and} ${modeWhere} ${weightWhere}`;

  switch (metric) {
    case 'dartsthrown':
      return db.prepare(`SELECT ${T.fmt} AS bucket, SUM(t.darts_thrown) AS value ${TBASE} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'avg':
      return db.prepare(`SELECT ${T.fmt} AS bucket, CAST(SUM(t.scored) AS REAL)/COUNT(*) AS value, COUNT(*) AS count ${TBASE} GROUP BY bucket ORDER BY bucket`).all(...params);
    case '180s':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(*) AS value ${TBASE} AND t.scored=180 GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'bigfish':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(*) AS value ${TBASE} AND t.checkout=1 AND t.checkout_points=170 GROUP BY bucket ORDER BY bucket`).all(...params);
    case '180sperleg':
      return db.prepare(`SELECT ${L.fmt} AS bucket, CAST(SUM(has_180) AS REAL)/NULLIF(COUNT(*),0) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, MAX(CASE WHEN t.scored=180 THEN 1 ELSE 0 END) AS has_180
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE t.player_id=? ${modeWhere} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'ninedarters':
      return db.prepare(`SELECT ${L.fmt} AS bucket, COUNT(*) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE t.player_id=? AND g.category='501' ${modeWhere} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no HAVING COUNT(*)=3 AND SUM(t.checkout)=1 AND SUM(t.darts_thrown)=9
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'treblelesspct':
      return db.prepare(`SELECT ${L.fmt} AS bucket, CAST(SUM(is_tl) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, CASE WHEN SUM(1-t.treble_less)=0 THEN 1 ELSE 0 END AS is_tl
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE t.player_id=? ${modeWhere} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'first3avg':
      return db.prepare(`SELECT ${F.fmt} AS bucket, AVG(scored) AS value FROM (
        SELECT t.scored, t.created_at, ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
        FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${modeWhere} ${weightWhere}
      ) WHERE rn=1 ${F.and} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'first9avg':
      return db.prepare(`SELECT ${L.fmt} AS bucket, AVG(first3)/3.0 AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, SUM(CASE WHEN rn<=3 THEN t.scored ELSE 0 END) AS first3,
               SUM(CASE WHEN rn<=3 THEN 1 ELSE 0 END) AS c3
        FROM (SELECT t.game_id,t.set_no,t.leg_no,t.scored,t.created_at,
                     ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
              FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${modeWhere} ${weightWhere}) t
        GROUP BY t.game_id,t.set_no,t.leg_no HAVING c3=3
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'avg100plus':
      return db.prepare(`SELECT ${L.fmt} AS bucket, CAST(SUM(CASE WHEN la>=100 THEN 1 ELSE 0 END) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, CAST(SUM(t.scored) AS REAL)/COUNT(*) AS la
        FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${modeWhere} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'avg90minus':
      return db.prepare(`SELECT ${L.fmt} AS bucket, CAST(SUM(CASE WHEN la<=90 THEN 1 ELSE 0 END) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, CAST(SUM(t.scored) AS REAL)/COUNT(*) AS la
        FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${modeWhere} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'score140pct':
      return db.prepare(`SELECT ${F.fmt} AS bucket, CAST(SUM(CASE WHEN scored>=140 THEN 1 ELSE 0 END) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT t.scored, t.created_at, ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
        FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${modeWhere} ${weightWhere}
      ) WHERE rn=1 ${F.and} GROUP BY bucket ORDER BY bucket`).all(...params);
    default:
      return [];
  }
}

function _mf(mode) {
  if (mode === 'h2h')      return `AND g.practice = 0 AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1`;
  if (mode === 'practice') return `AND (g.practice = 1 OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) = 1)`;
  return '';
}

function getOneEightyStats(mode) {
  const mf = _mf(mode);
  const J = `FROM turns t JOIN games g ON g.id = t.game_id JOIN players p ON p.id = t.player_id`;
  const leaderboard = db.prepare(`SELECT p.name, COUNT(*) AS count ${J} WHERE t.scored = 180 ${mf} GROUP BY t.player_id ORDER BY count DESC`).all();
  const recent      = db.prepare(`SELECT p.name, t.created_at ${J} WHERE t.scored = 180 ${mf} ORDER BY t.created_at DESC LIMIT 10`).all();
  return { leaderboard, recent };
}

function getBigFishStats(mode) {
  const mf = _mf(mode);
  const J = `FROM turns t JOIN games g ON g.id = t.game_id JOIN players p ON p.id = t.player_id`;
  const leaderboard = db.prepare(`SELECT p.name, COUNT(*) AS count ${J} WHERE t.checkout = 1 AND t.checkout_points = 170 ${mf} GROUP BY t.player_id ORDER BY count DESC`).all();
  const recent      = db.prepare(`SELECT p.name, t.created_at ${J} WHERE t.checkout = 1 AND t.checkout_points = 170 ${mf} ORDER BY t.created_at DESC LIMIT 10`).all();
  return { leaderboard, recent };
}

function getNineDarterStats(mode) {
  const mf = _mf(mode);
  const leaderboard = db.prepare(`
    SELECT p.name, COUNT(*) AS count FROM (
      SELECT t.player_id FROM turns t JOIN games g ON g.id = t.game_id
      WHERE g.category = '501' ${mf}
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING COUNT(*) = 3 AND SUM(t.checkout) = 1 AND SUM(t.darts_thrown) = 9
    ) x JOIN players p ON p.id = x.player_id
    GROUP BY x.player_id ORDER BY count DESC
  `).all();
  const recent = db.prepare(`
    SELECT p.name, MAX(t.created_at) AS created_at
    FROM turns t JOIN games g ON g.id = t.game_id JOIN players p ON p.id = t.player_id
    WHERE g.category = '501' ${mf}
    GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
    HAVING COUNT(*) = 3 AND SUM(t.checkout) = 1 AND SUM(t.darts_thrown) = 9
    ORDER BY created_at DESC LIMIT 10
  `).all();
  return { leaderboard, recent };
}

function getTopFinishesAll(limit = 10, mode) {
  const mf = _mf(mode);
  return db.prepare(`
    SELECT p.name, gp.out_mode AS out, t.checkout_points AS score, COUNT(*) AS times,
           MIN(t.created_at) AS first_date, MAX(t.created_at) AS last_date
    FROM turns t
    JOIN games g ON g.id = t.game_id
    JOIN players p ON p.id = t.player_id
    JOIN game_players gp ON gp.game_id = t.game_id AND gp.player_id = t.player_id
    WHERE t.checkout = 1 AND t.checkout_points > 0 ${mf}
    GROUP BY t.player_id, t.checkout_points, gp.out_mode
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
  const mf = _mf(mode);
  return db.prepare(`
    SELECT t.checkout_points AS score,
           COUNT(*)          AS times,
           MIN(t.created_at) AS first_date,
           MAX(t.created_at) AS last_date,
           gp.out_mode       AS out_mode
    FROM turns t
    JOIN games g ON g.id = t.game_id
    JOIN game_players gp ON gp.game_id = t.game_id AND gp.player_id = t.player_id
    WHERE t.player_id = ?
      AND t.checkout = 1
      AND t.checkout_points > 0
      ${mf}
    GROUP BY t.checkout_points, gp.out_mode
    ORDER BY t.checkout_points DESC
    LIMIT 10
  `).all(p.id).map(r => ({ ...r, out: r.out_mode }));
}


function clearPlayerStats(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');

  if (mode === 'all') {
    // Delete solo games (where this player was the sole participant) — cascades to their turns and game_players
    db.prepare(`
      DELETE FROM games WHERE id IN (
        SELECT g.id FROM games g
        WHERE (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) = 1
          AND EXISTS (SELECT 1 FROM game_players gp2 WHERE gp2.game_id = g.id AND gp2.player_id = ?)
      )
    `).run(p.id);
    // Delete this player's turns and participation in any remaining multi-player games
    db.prepare('DELETE FROM turns        WHERE player_id = ?').run(p.id);
    db.prepare('DELETE FROM game_players WHERE player_id = ?').run(p.id);
    return { ok: true };
  }

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
  db.prepare(`DELETE FROM turns WHERE player_id = ? AND game_id IN (${ph})`).run(p.id, ...gameIds);
  // game_players rows are intentionally kept: removing them would change the apparent player
  // count for shared games, silently reclassifying opponents' H2H turns as practice.
  return { ok: true };
}

function deleteLastTurn(gameId) {
  db.prepare('DELETE FROM turns WHERE id = (SELECT MAX(id) FROM turns WHERE game_id = ?)').run(Number(gameId));
  return { ok: true };
}

function getDartAnalytics(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const mf = _mf(mode);

  // Base FROM for dart-level queries (darts → turns → games)
  const BASE = `FROM darts d JOIN turns t ON t.id = d.turn_id JOIN games g ON g.id = t.game_id WHERE t.player_id = ?`;

  // 1 — Most hit sector/multiplier combinations
  const topSectors = db.prepare(`
    SELECT d.sector, d.multiplier, COUNT(*) AS hits
    ${BASE} ${mf}
    GROUP BY d.sector, d.multiplier
    ORDER BY hits DESC
    LIMIT 15
  `).all(p.id);

  // 2 — Treble hit rate per number (sectors 1-20 only)
  const trebleRates = db.prepare(`
    SELECT d.sector, COUNT(*) AS total,
           SUM(d.is_treble) AS trebles,
           ROUND(100.0 * SUM(d.is_treble) / COUNT(*), 1) AS treble_pct
    ${BASE} ${mf} AND d.sector BETWEEN 1 AND 20
    GROUP BY d.sector
    ORDER BY treble_pct DESC
  `).all(p.id);

  // 3 — Most common checkout routes (up to 3 darts; d2/d3 are NULL for shorter finishes)
  const checkoutRoutes = db.prepare(`
    SELECT d1.sector AS s1, d1.multiplier AS m1,
           d2.sector AS s2, d2.multiplier AS m2,
           d3.sector AS s3, d3.multiplier AS m3,
           COUNT(*) AS times
    FROM turns t
    JOIN games g ON g.id = t.game_id
    JOIN  darts d1 ON d1.turn_id = t.id AND d1.dart_no = 1
    LEFT JOIN darts d2 ON d2.turn_id = t.id AND d2.dart_no = 2
    LEFT JOIN darts d3 ON d3.turn_id = t.id AND d3.dart_no = 3
    WHERE t.player_id = ? AND t.checkout = 1 ${mf}
    GROUP BY s1, m1, s2, m2, s3, m3
    ORDER BY times DESC
    LIMIT 10
  `).all(p.id);

  return { topSectors, trebleRates, checkoutRoutes };
}

function resetStats() {
  db.exec('DELETE FROM turns; DELETE FROM game_players; DELETE FROM games;');
  return { ok: true };
}

/* ---------- settings ---------- */
function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
}
function updateSettings(obj) {
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(obj)) upsert.run(String(k), String(v ?? ''));
  return { ok: true };
}

/* ---------- Home Assistant webhook proxy ---------- */
function fireHaWebhook(event, payload) {
  const cfg = getSettings();
  const haUrl    = cfg.ha_url    || '';
  const whId     = cfg[`ha_webhook_${event}`] || '';
  if (!haUrl || !whId) return Promise.resolve({ skipped: true });

  return new Promise((resolve) => {
    const body = JSON.stringify({ ...payload, event, timestamp: Date.now() });
    let url;
    try { url = new URL(`/api/webhook/${encodeURIComponent(whId)}`, haUrl); }
    catch(e) { return resolve({ ok: false, error: 'Invalid HA URL' }); }

    const mod = url.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve({ ok: true, status: res.statusCode }); });
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end(body);
  });
}

/* ---------- helpers ---------- */
function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}

module.exports = {
  listPlayers, addPlayer, renamePlayer, setOut, setDartWeight, deletePlayer,
  createGame, addTurn, completeGame, recordEvent,
  computeStats, getSummary, getOneEightyStats, getBigFishStats, getNineDarterStats,
  getPlayerStatBubbles, getMetricHistory,
  getTopFinishes, getTopFinishesAll, getDartWeights, clearPlayerStats, resetStats, deleteLastTurn,
  getDartAnalytics,
  getSettings, updateSettings, fireHaWebhook,
  _db: db,
};
