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
const auth = require('./auth.js');

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

  -- turns stores visit-level outcomes that require game-state knowledge to compute.
  -- treble_less and darts_thrown are gone — both are now derived from the darts table.
  CREATE TABLE IF NOT EXISTS turns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id         INTEGER NOT NULL REFERENCES games(id)   ON DELETE CASCADE,
    player_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    set_no          INTEGER NOT NULL,
    leg_no          INTEGER NOT NULL,
    scored          INTEGER NOT NULL,    -- effective score; 0 for busts (game-state knowledge)
    bust            INTEGER NOT NULL DEFAULT 0,
    checkout        INTEGER NOT NULL DEFAULT 0,
    checkout_points INTEGER,             -- kept as performance cache for ton+/Big Fish queries
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_turns_player ON turns(player_id);
  CREATE INDEX IF NOT EXISTS idx_turns_game   ON turns(game_id);

  -- darts stores one row per physical dart. scored/is_treble/is_double are generated
  -- from sector+multiplier — no app code writes them; SQLite computes and stores them.
  -- thrown_at (added via ALTER TABLE below) is the client-captured tap timestamp, only
  -- populated when the "collect_dart_timing" setting is on; null otherwise.
  CREATE TABLE IF NOT EXISTS darts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id    INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    dart_no    INTEGER NOT NULL,
    sector     INTEGER NOT NULL,    -- 0=miss  1-20=number  25=bull area
    multiplier INTEGER NOT NULL,    -- 1=single  2=double  3=treble
    scored     INTEGER NOT NULL GENERATED ALWAYS AS (
      CASE WHEN sector=0 THEN 0
           WHEN sector=25 AND multiplier=2 THEN 50
           WHEN sector=25 THEN 25
           ELSE sector*multiplier END
    ) STORED,
    is_treble  INTEGER NOT NULL GENERATED ALWAYS AS (
      CASE WHEN multiplier=3 AND sector>=1 AND sector<=20 THEN 1 ELSE 0 END
    ) STORED,
    is_double  INTEGER NOT NULL GENERATED ALWAYS AS (
      CASE WHEN multiplier=2 AND sector!=0 THEN 1 ELSE 0 END
    ) STORED
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

  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// Column migrations for tables not recreated above — safe to re-run.
try { db.exec('ALTER TABLE players      ADD COLUMN dart_weight INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE game_players ADD COLUMN dart_weight INTEGER'); } catch(e) {}
try { db.exec("ALTER TABLE game_players ADD COLUMN out_mode TEXT NOT NULL DEFAULT 'double'"); } catch(e) {}
try { db.exec('ALTER TABLE games        ADD COLUMN practice    INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE players ADD COLUMN pin_hash TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE players ADD COLUMN pin_salt TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE players ADD COLUMN pin_fail_count INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE players ADD COLUMN pin_locked_until INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE darts ADD COLUMN thrown_at TEXT'); } catch(e) {}

const DEFAULT_PIN_LOCKOUT_THRESHOLD = 10;

/* ---------- prepared statements ---------- */
const q = {
  playerByName : db.prepare('SELECT id, name, out_mode, dart_weight, pin_hash, pin_salt, pin_fail_count, pin_locked_until FROM players WHERE name = ? COLLATE NOCASE'),
  insertPlayer : db.prepare("INSERT INTO players (name, out_mode) VALUES (?, ?)"),
  listPlayers  : db.prepare('SELECT id, name, out_mode, dart_weight, pin_hash FROM players ORDER BY name COLLATE NOCASE'),
  renamePlayer : db.prepare('UPDATE players SET name = ? WHERE id = ?'),
  setOut       : db.prepare('UPDATE players SET out_mode = ? WHERE id = ?'),
  setDartWeight: db.prepare('UPDATE players SET dart_weight = ? WHERE id = ?'),
  deletePlayer : db.prepare('DELETE FROM players WHERE id = ?'),
  setPin       : db.prepare('UPDATE players SET pin_hash = ?, pin_salt = ?, pin_fail_count = 0, pin_locked_until = NULL WHERE id = ?'),
  clearPin     : db.prepare('UPDATE players SET pin_hash = NULL, pin_salt = NULL, pin_fail_count = 0, pin_locked_until = NULL WHERE id = ?'),
  bumpPinFail  : db.prepare('UPDATE players SET pin_fail_count = pin_fail_count + 1 WHERE id = ?'),
  lockPin      : db.prepare('UPDATE players SET pin_locked_until = ? WHERE id = ?'),
  resetPinFail : db.prepare('UPDATE players SET pin_fail_count = 0, pin_locked_until = NULL WHERE id = ?'),

  insertAdmin    : db.prepare('INSERT INTO admins (username, password_hash, password_salt) VALUES (?, ?, ?)'),
  adminByUsername: db.prepare('SELECT id, username, password_hash, password_salt FROM admins WHERE username = ? COLLATE NOCASE'),
  adminById      : db.prepare('SELECT id, username FROM admins WHERE id = ?'),
  listAdmins     : db.prepare('SELECT id, username, created_at FROM admins ORDER BY username COLLATE NOCASE'),
  countAdmins    : db.prepare('SELECT COUNT(*) AS n FROM admins'),
  deleteAdmin    : db.prepare('DELETE FROM admins WHERE id = ?'),
  updateAdminPw  : db.prepare('UPDATE admins SET password_hash = ?, password_salt = ? WHERE id = ?'),

  insertSession  : db.prepare('INSERT INTO sessions (token_hash, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  sessionByHash  : db.prepare('SELECT token_hash, admin_id, expires_at FROM sessions WHERE token_hash = ?'),
  deleteSession  : db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  deleteSessionsForAdmin: db.prepare('DELETE FROM sessions WHERE admin_id = ?'),

  insertGame   : db.prepare('INSERT INTO games (category, legs_per_set, sets_per_game, practice) VALUES (?, ?, ?, ?)'),
  addParticipant: db.prepare('INSERT OR IGNORE INTO game_players (game_id, player_id, dart_weight, out_mode) VALUES (?, ?, ?, ?)'),
  completeGame : db.prepare("UPDATE games SET completed_at = datetime('now'), winner_id = ? WHERE id = ?"),

  insertTurn   : db.prepare(`INSERT INTO turns
                   (game_id, player_id, set_no, leg_no, scored, bust, checkout, checkout_points)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),

  insertDart   : db.prepare(`INSERT INTO darts (turn_id, dart_no, sector, multiplier, thrown_at)
                   VALUES (?, ?, ?, ?, ?)`),
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
  return q.listPlayers.all().map(p => ({ name: p.name, out: p.out_mode, dartWeight: p.dart_weight ?? null, hasPin: !!p.pin_hash }));
}

function addPlayer(name, out = 'double', opts = {}) {
  name = String(name || '').trim();
  if (!name) throw httpError(400, 'Name is required');
  const existing = getPlayer(name);
  if (existing) return { name: existing.name, out: existing.out_mode, hasPin: !!existing.pin_hash, dartWeight: existing.dart_weight ?? null };
  q.insertPlayer.run(name, out === 'single' ? 'single' : 'double');
  if (opts.pin) setPlayerPin(name, opts.pin);
  if (opts.dartWeight !== undefined && opts.dartWeight !== null && opts.dartWeight !== '') {
    setDartWeight(name, opts.dartWeight);
  }
  const p = getPlayer(name);
  return { name, out: out === 'single' ? 'single' : 'double', hasPin: !!p.pin_hash, dartWeight: p.dart_weight ?? null };
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
    const out = entry.out === 'single' ? 'single' : 'double';
    const p   = ensurePlayer(entry.name);
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
    t.bust ? 1 : 0,
    t.checkout ? 1 : 0,
    t.checkout ? (Number(t.checkoutPoints) || 0) : null
  );
  // Insert individual dart rows — scored/is_treble/is_double are generated columns
  if (Array.isArray(t.darts) && t.darts.length) {
    const turnId = Number(info.lastInsertRowid);
    for (const d of t.darts) {
      // thrownAt is an ISO timestamp captured client-side at tap time; only sent when
      // the admin has enabled the "collect_dart_timing" setting.
      const thrownAt = d.thrownAt ? String(d.thrownAt) : null;
      q.insertDart.run(turnId, Number(d.dartNo), Number(d.sector), Number(d.multiplier), thrownAt);
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

  // Average actual darts per won leg — COUNT(darts) replaces the removed darts_thrown column
  const h2hAvgDarts = db.prepare(`
    SELECT pid, AVG(leg_darts) AS avg_darts FROM (
      SELECT t.player_id AS pid, COUNT(d.id) AS leg_darts
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.practice=0 AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id=g.id)>1
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no HAVING SUM(t.checkout)>0
    ) GROUP BY pid
  `).all();

  const practiceAvgDarts = db.prepare(`
    SELECT pid, AVG(leg_darts) AS avg_darts FROM (
      SELECT t.player_id AS pid, COUNT(d.id) AS leg_darts
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.practice=1 OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id=g.id)=1
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no HAVING SUM(t.checkout)>0
    ) GROUP BY pid
  `).all();

  // Nine-darters: 501 legs won in exactly 9 darts across 3 visits
  const nineDarterBase = (extraWhere) => db.prepare(`
    SELECT pid, COUNT(*) AS n FROM (
      SELECT t.player_id AS pid
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.category='501' ${extraWhere}
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING COUNT(DISTINCT t.id)=3 AND SUM(t.checkout)>0 AND COUNT(d.id)=9
    ) GROUP BY pid
  `).all();

  const nd9All  = nineDarterBase('');
  const nd9H2H  = nineDarterBase("AND g.practice=0 AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id=g.id)>1");
  const nd9Prac = nineDarterBase("AND (g.practice=1 OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id=g.id)=1)");

  // Aggregate stats per mode — trebleLess and dartsThrown now come from the darts JOIN.
  const _agg = (modeWhere) => db.prepare(`
    SELECT t.player_id,
      COUNT(*) AS turns,
      COALESCE(SUM(t.scored), 0) AS total,
      COALESCE(SUM(CASE WHEN dt.trebles=0 THEN 1 ELSE 0 END), 0) AS trebleLess,
      COALESCE(SUM(CASE WHEN t.checkout=1 AND t.checkout_points>=100 THEN 1 ELSE 0 END),0) AS co100,
      COALESCE(SUM(CASE WHEN t.scored=180 THEN 1 ELSE 0 END),0) AS oneEighties,
      COALESCE(SUM(CASE WHEN t.checkout=1 AND t.checkout_points=170 THEN 1 ELSE 0 END),0) AS bigFish,
      COALESCE(SUM(dt.cnt), 0) AS dartsThrown,
      -- darts counted toward the 3-dart average: a bust counts as a full 3-dart visit,
      -- a winning visit counts only the darts actually thrown (dt.cnt)
      COALESCE(SUM(CASE WHEN t.bust=1 THEN 3 ELSE dt.cnt END), 0) AS avgDarts
    FROM turns t JOIN games g ON g.id=t.game_id
    LEFT JOIN (SELECT turn_id, COUNT(*) AS cnt, SUM(is_treble) AS trebles FROM darts GROUP BY turn_id) dt
      ON dt.turn_id=t.id
    WHERE ${modeWhere}
    GROUP BY t.player_id
  `).all();

  const h2hAgg  = _agg(`g.practice=0 AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id=g.id)>1`);
  const pracAgg = _agg(`g.practice=1 OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id=g.id)=1`);

  // Last played date and recent-form average (last 30 turns) per player — used on the roster page.
  const lastPlayedRows = db.prepare(`
    SELECT player_id AS pid, MAX(created_at) AS ts FROM turns GROUP BY player_id
  `).all();
  const recentAvgRows = db.prepare(`
    SELECT pid, CAST(SUM(scored) AS REAL)/NULLIF(SUM(dcount),0)*3 AS recentAvg FROM (
      SELECT t.player_id AS pid, t.scored,
             CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END AS dcount,
             ROW_NUMBER() OVER (PARTITION BY t.player_id ORDER BY t.id DESC) AS rn
      FROM turns t
      LEFT JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dc ON dc.turn_id=t.id
    ) WHERE rn <= 30 GROUP BY pid
  `).all();

  const lastPlayedById = {}; lastPlayedRows.forEach(r => lastPlayedById[r.pid] = r.ts);
  const recentAvgById  = {}; recentAvgRows.forEach(r  => recentAvgById[r.pid]  = r.recentAvg);
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
    const ha = h2hAggById[p.id]  || { turns:0, total:0, trebleLess:0, co100:0, oneEighties:0, bigFish:0, dartsThrown:0, avgDarts:0 };
    const pa = pracAggById[p.id] || { turns:0, total:0, trebleLess:0, co100:0, oneEighties:0, bigFish:0, dartsThrown:0, avgDarts:0 };
    out[p.name] = {
      out: p.out_mode,
      dartWeight: p.dart_weight ?? null,
      hasPin: !!p.pin_hash,
      turns:       (ha.turns||0)       + (pa.turns||0),
      totalPoints: (ha.total||0)       + (pa.total||0),
      trebleLess:  (ha.trebleLess||0)  + (pa.trebleLess||0),
      checkouts100:(ha.co100||0)       + (pa.co100||0),
      dartsThrown: (ha.dartsThrown||0) + (pa.dartsThrown||0),
      avgDarts:    (ha.avgDarts||0)    + (pa.avgDarts||0),
      oneEighties: (ha.oneEighties ?? 0) + (pa.oneEighties ?? 0),
      bigFish:     (ha.bigFish     ?? 0) + (pa.bigFish     ?? 0),
      nineDarters: nd9AllById[p.id] ?? 0,
      lastPlayed:  lastPlayedById[p.id] ?? null,
      recentAvg:   recentAvgById[p.id]  ?? null,
      h2hAvgDartsPerLeg: h2hDartsById[p.id] != null ? +h2hDartsById[p.id].toFixed(1) : null,
      practiceAvgDartsPerLeg: pracDartsById[p.id] != null ? +pracDartsById[p.id].toFixed(1) : null,
      h2hStats: { turns:ha.turns, totalPoints:ha.total, trebleLess:ha.trebleLess,
                  checkouts100:ha.co100, oneEighties:ha.oneEighties, bigFish:ha.bigFish,
                  nineDarters: nd9H2HById[p.id] ?? 0, dartsThrown: ha.dartsThrown ?? 0, avgDarts: ha.avgDarts ?? 0 },
      practiceStats: { turns:pa.turns, totalPoints:pa.total, trebleLess:pa.trebleLess,
                       checkouts100:pa.co100, oneEighties:pa.oneEighties, bigFish:pa.bigFish,
                       nineDarters: nd9PracById[p.id] ?? 0, dartsThrown: pa.dartsThrown ?? 0, avgDarts: pa.avgDarts ?? 0 },
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
  const darts        = db.prepare('SELECT COUNT(*) AS n FROM darts').get().n ?? 0;
  const tonPlus      = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE checkout=1 AND checkout_points>=100').get().n;
  const oneEighties  = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE scored=180').get().n;
  const bigFish      = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE checkout=1 AND checkout_points=170').get().n;
  const nineDarters  = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT t.player_id FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.category='501'
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING COUNT(DISTINCT t.id)=3 AND SUM(t.checkout)>0 AND COUNT(d.id)=9
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

// Additional homepage stats: win rates, trebleless %, ton+ rate, highest checkout,
// last game played, today/this-week activity, and dart-pace (when timing data exists).
function getHomeExtra() {
  const winRows = db.prepare(`
    SELECT p.id, p.name,
      COUNT(*) AS played,
      SUM(CASE WHEN g.winner_id = p.id THEN 1 ELSE 0 END) AS won
    FROM game_players gp
    JOIN players p ON p.id = gp.player_id
    JOIN games g ON g.id = gp.game_id
    WHERE g.completed_at IS NOT NULL AND g.practice = 0
      AND (SELECT COUNT(*) FROM game_players gp2 WHERE gp2.game_id = g.id) > 1
    GROUP BY p.id
    HAVING played >= 1
    ORDER BY won DESC, played ASC
  `).all();
  const winLeaderboard = winRows.map(r => ({
    name: r.name, played: r.played, won: r.won,
    rate: r.played ? +((r.won / r.played) * 100).toFixed(1) : 0
  }));

  const trebleLessRows = db.prepare(`
    SELECT p.name AS name, COUNT(*) AS turns,
      SUM(CASE WHEN dt.trebles = 0 THEN 1 ELSE 0 END) AS trebleLess
    FROM turns t
    JOIN players p ON p.id = t.player_id
    LEFT JOIN (SELECT turn_id, SUM(is_treble) AS trebles FROM darts GROUP BY turn_id) dt ON dt.turn_id = t.id
    GROUP BY p.id
    HAVING turns >= 10
    ORDER BY (CAST(trebleLess AS REAL) / turns) ASC
  `).all().map(r => ({ name: r.name, turns: r.turns, trebleLess: r.trebleLess,
    rate: r.turns ? +((r.trebleLess / r.turns) * 100).toFixed(1) : 0 }));

  const tonPlusRows = db.prepare(`
    SELECT p.name AS name,
      COUNT(*) AS checkouts,
      SUM(CASE WHEN t.checkout_points >= 100 THEN 1 ELSE 0 END) AS tonPlus
    FROM turns t
    JOIN players p ON p.id = t.player_id
    WHERE t.checkout = 1
    GROUP BY p.id
    HAVING checkouts >= 3
    ORDER BY (CAST(tonPlus AS REAL) / checkouts) DESC
  `).all().map(r => ({ name: r.name, checkouts: r.checkouts, tonPlus: r.tonPlus,
    rate: r.checkouts ? +((r.tonPlus / r.checkouts) * 100).toFixed(1) : 0 }));

  const highestCheckout = db.prepare(`
    SELECT p.name AS name, t.checkout_points AS points, t.created_at AS createdAt
    FROM turns t JOIN players p ON p.id = t.player_id
    WHERE t.checkout = 1 AND t.checkout_points IS NOT NULL
    ORDER BY t.checkout_points DESC, t.created_at ASC
    LIMIT 1
  `).get() || null;

  const lastGame = db.prepare(`
    SELECT g.id, g.category, g.completed_at AS completedAt, w.name AS winnerName,
      (SELECT GROUP_CONCAT(p2.name, ', ') FROM game_players gp2 JOIN players p2 ON p2.id = gp2.player_id WHERE gp2.game_id = g.id) AS players
    FROM games g LEFT JOIN players w ON w.id = g.winner_id
    WHERE g.completed_at IS NOT NULL
    ORDER BY g.completed_at DESC
    LIMIT 1
  `).get() || null;

  const todayLegs = db.prepare(`
    SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS n
    FROM turns t WHERE date(t.created_at) = date('now')
  `).get().n;
  const todayDarts = db.prepare(`SELECT COUNT(*) AS n FROM darts d JOIN turns t ON t.id = d.turn_id WHERE date(t.created_at) = date('now')`).get().n;
  const weekLegs = db.prepare(`
    SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS n
    FROM turns t WHERE date(t.created_at) >= date('now', '-6 days')
  `).get().n;
  const weekDarts = db.prepare(`SELECT COUNT(*) AS n FROM darts d JOIN turns t ON t.id = d.turn_id WHERE date(t.created_at) >= date('now', '-6 days')`).get().n;

  // Pace: avg ms between consecutive thrown_at timestamps within the same turn -> darts/min.
  const _pace = (modeWhere) => {
    const row = db.prepare(`
      SELECT AVG(gap_ms) AS avgMs FROM (
        SELECT (julianday(d.thrown_at) - julianday(prev.thrown_at)) * 86400000 AS gap_ms
        FROM darts d
        JOIN darts prev ON prev.turn_id = d.turn_id AND prev.dart_no = d.dart_no - 1
        JOIN turns t ON t.id = d.turn_id
        JOIN games g ON g.id = t.game_id
        WHERE d.thrown_at IS NOT NULL AND prev.thrown_at IS NOT NULL AND ${modeWhere}
      ) WHERE gap_ms > 0 AND gap_ms < 60000
    `).get();
    if (!row || !row.avgMs) return null;
    return +(60000 / row.avgMs).toFixed(2);
  };
  const pace = {
    h2h: _pace(`g.practice = 0 AND (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) > 1`),
    practice: _pace(`g.practice = 1 OR (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) = 1`)
  };

  return { winLeaderboard, trebleLessRows, tonPlusRows, highestCheckout, lastGame,
    today: { legs: todayLegs, darts: todayDarts }, week: { legs: weekLegs, darts: weekDarts }, pace };
}

function getPlayerStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const mf = _mf(mode);
  const q = (sql) => { const r = db.prepare(sql).get(p.id); return r ? r.v : null; };
  const J = `FROM turns t JOIN games g ON g.id = t.game_id WHERE t.player_id = ?`;

  const JD = `FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id = ?`;
  const qd = (sql) => { const r = db.prepare(sql).get(p.id); return r ? r.v : null; };
  const dartsThrown    = qd(`SELECT COUNT(*) AS v ${JD} ${mf}`) ?? 0;
  const avgDartsPerDay = qd(`SELECT CAST(COUNT(*) AS REAL)/NULLIF(COUNT(DISTINCT date(t.created_at)),0) AS v ${JD} ${mf}`);
  const avgDartsPerLeg = qd(`SELECT AVG(leg_darts) AS v FROM (SELECT COUNT(d.id) AS leg_darts ${JD} ${mf} GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(t.checkout)>0)`);
  const legsWithOneEighty = q(`SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS v ${J} ${mf} AND t.scored=180`) ?? 0;
  // Standard 3-dart average: total points / counted darts * 3, where a bust counts
  // as a full 3-dart visit and a winning visit counts only the darts actually thrown.
  const avgDarts   = qd(`SELECT SUM(adj) AS v FROM (SELECT CASE WHEN t.bust=1 THEN 3 ELSE COUNT(d.id) END AS adj ${JD} ${mf} GROUP BY t.id)`) ?? 0;
  const totalPts   = q(`SELECT SUM(t.scored) AS v ${J} ${mf}`) ?? 0;
  const avg        = avgDarts > 0 ? (totalPts / avgDarts * 3) : null;
  const one80s     = q(`SELECT COUNT(*) AS v ${J} ${mf} AND t.scored=180`) ?? 0;
  const bigFish    = q(`SELECT COUNT(*) AS v ${J} ${mf} AND t.checkout=1 AND t.checkout_points=170`) ?? 0;
  const nineDarters= qd(`SELECT COUNT(*) AS v FROM (SELECT 1 ${JD} ${mf} AND g.category='501' GROUP BY t.game_id,t.set_no,t.leg_no HAVING COUNT(DISTINCT t.id)=3 AND SUM(t.checkout)>0 AND COUNT(d.id)=9)`) ?? 0;
  const totalLegs  = q(`SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS v ${J} ${mf}`) ?? 0;
  // tlLegs: legs where no dart was a treble
  const tlLegs     = qd(`SELECT COUNT(*) AS v FROM (SELECT t.game_id,t.set_no,t.leg_no ${JD} ${mf} GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(d.is_treble)=0)`) ?? 0;

  // first3avg: actual score of first 3 darts (visit 1) per leg, using darts table
  const first3avg = db.prepare(`
    SELECT AVG(CAST(visit_scored AS REAL)) AS v FROM (
      SELECT SUM(d.scored) AS visit_scored
      FROM (SELECT t.id, t.game_id, t.set_no, t.leg_no,
                   ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
            ${J} ${mf}) t
      JOIN darts d ON d.turn_id = t.id
      WHERE t.rn = 1
      GROUP BY t.game_id, t.set_no, t.leg_no
    )
  `).get(p.id)?.v ?? null;

  // first9avg: actual score of first 9 darts (visits 1-3) per leg, all legs included (no selection bias)
  const first9avg = db.prepare(`
    SELECT AVG(CAST(total_scored AS REAL) / NULLIF(dart_count,0) * 3) AS v FROM (
      SELECT SUM(d.scored) AS total_scored, COUNT(d.id) AS dart_count
      FROM (SELECT t.id, t.game_id, t.set_no, t.leg_no,
                   ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
            ${J} ${mf}) t
      JOIN darts d ON d.turn_id = t.id
      WHERE t.rn <= 3
      GROUP BY t.game_id, t.set_no, t.leg_no
    )
  `).get(p.id)?.v ?? null;

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
    dartsThrown, avgDartsPerDay, avgDartsPerLeg, avg, one80s, bigFish, nineDarters,
    treblelessPct: totalLegs > 0 ? (tlLegs / totalLegs * 100) : null,
    first3avg, first9avg, avg100plus, avg90minus, score140pct,
    one80sPerLeg: totalLegs > 0 ? (legsWithOneEighty / totalLegs) : null,
  };
}

// Personal-best / "tracking improvement" markers for the player page: best single-leg
// average, fewest darts to finish a leg, current H2H win streak, and recent-form (last
// 10 completed legs) average vs lifetime average.
function getPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const mf = _mf(mode);

  const legAvgSql = `
    SELECT t.game_id, t.set_no, t.leg_no, MAX(t.id) AS lastTurnId,
      CAST(SUM(t.scored) AS REAL)/NULLIF(SUM(CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END),0)*3 AS la
    FROM turns t JOIN games g ON g.id=t.game_id
    JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dc ON dc.turn_id=t.id
    WHERE t.player_id=? ${mf}
    GROUP BY t.game_id,t.set_no,t.leg_no
    HAVING SUM(t.checkout)>0
  `;
  const legs = db.prepare(legAvgSql).all(p.id);
  const bestLegAvg = legs.length ? Math.max(...legs.map(r=>r.la)) : null;

  const fewestDartsCheckout = db.prepare(`
    SELECT MIN(leg_darts) AS v FROM (
      SELECT COUNT(d.id) AS leg_darts
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE t.player_id=? ${mf}
      GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(t.checkout)>0
    )
  `).get(p.id)?.v ?? null;

  const recentLegs = legs.slice().sort((a,b)=>b.lastTurnId-a.lastTurnId).slice(0,10);
  const recentFormAvg = recentLegs.length ? recentLegs.reduce((s,r)=>s+r.la,0)/recentLegs.length : null;
  const lifetimeAvg = legs.length ? legs.reduce((s,r)=>s+r.la,0)/legs.length : null;

  let winStreak = 0;
  if (mode !== 'practice') {
    const recentGames = db.prepare(`
      SELECT g.winner_id AS winnerId
      FROM games g JOIN game_players gp ON gp.game_id=g.id
      WHERE gp.player_id=? AND g.completed_at IS NOT NULL AND g.practice=0
        AND (SELECT COUNT(*) FROM game_players gp2 WHERE gp2.game_id=g.id) > 1
      ORDER BY g.completed_at DESC
      LIMIT 50
    `).all(p.id);
    for (const r of recentGames) {
      if (r.winnerId === p.id) winStreak++; else break;
    }
  }

  return { bestLegAvg, fewestDartsCheckout, winStreak, recentFormAvg, lifetimeAvg };
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

  // Timestamps are stored in UTC; bucket labels and day/hour boundaries are shifted
  // to the client's local time using the validated tz offset (minutes east of UTC).
  const tz = Number.isInteger(opts.tz) ? opts.tz : 0;
  const tzMod = tz ? `, '${tz>=0?'+':''}${tz} minutes'` : '';
  const L_ = (col) => `${col}${tzMod}`;   // local-shifted column expression

  const bld = (tsCol) => {
    const c = L_(tsCol);   // local-time expression for bucket labels & local-date boundaries
    let fmt, flt;
    if      (period==='today')  { fmt=`strftime('%H',${c})`;          flt=`date(${c})=date('now'${tzMod})`; }
    else if (period==='week')   { fmt=`strftime('%Y-%m-%d',${c})`;    flt=`${tsCol}>=datetime('now','-7 days')`; }
    else if (period==='month')  { fmt=`strftime('%Y-%m-%d',${c})`;    flt=`${tsCol}>=datetime('now','-30 days')`; }
    else if (period==='year')   { fmt=`'w'||strftime('%Y-%W',${c})`;  flt=`${tsCol}>=datetime('now','-365 days')`; }
    else if (period==='custom') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.start) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.end)) throw new Error('Invalid date range');
      fmt=`strftime('%Y-%m-%d',${c})`; flt=`date(${c})>='${opts.start}' AND date(${c})<='${opts.end}'`;
    }
    else                        { fmt=`strftime('%Y-%m',${c})`;       flt=null; }
    return { fmt, and: flt ? `AND ${flt}` : '', where: flt ? `WHERE ${flt}` : '' };
  };

  const T = bld('t.created_at');
  const L = bld('leg_ts');
  const F = bld('created_at');  // after window func unwrapping, no t. prefix

  const TBASE = `FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${T.and} ${modeWhere} ${weightWhere}`;

  switch (metric) {
    case 'dartsthrown':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(d.id) AS value FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${T.and} ${modeWhere} ${weightWhere} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'avgdartsperday':
      return db.prepare(`SELECT ${T.fmt} AS bucket, CAST(COUNT(d.id) AS REAL)/NULLIF(COUNT(DISTINCT date(t.created_at)),0) AS value FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${T.and} ${modeWhere} ${weightWhere} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'avg':
      // Standard 3-dart average: total points / counted darts * 3 (per-turn darts
      // pre-aggregated so the darts JOIN doesn't inflate SUM(scored)). A bust counts
      // as a full 3-dart visit; a winning visit counts only the darts actually thrown.
      return db.prepare(`SELECT bucket, CAST(SUM(scored) AS REAL)/NULLIF(SUM(dcount),0)*3 AS value, COUNT(*) AS count FROM (
        SELECT ${T.fmt} AS bucket, t.scored AS scored, CASE WHEN t.bust=1 THEN 3 ELSE COUNT(d.id) END AS dcount
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${T.and} ${modeWhere} ${weightWhere}
        GROUP BY t.id
      ) GROUP BY bucket ORDER BY bucket`).all(...params);
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
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? AND g.category='501' ${modeWhere} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no HAVING COUNT(DISTINCT t.id)=3 AND SUM(t.checkout)>0 AND COUNT(d.id)=9
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'treblelesspct':
      return db.prepare(`SELECT ${L.fmt} AS bucket, CAST(SUM(is_tl) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, CASE WHEN SUM(d.is_treble)=0 THEN 1 ELSE 0 END AS is_tl
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${modeWhere} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'first3avg':
      // Score of first 3 actual darts (visit 1) per leg, using darts table for accuracy
      return db.prepare(`SELECT ${F.fmt} AS bucket, AVG(CAST(visit_scored AS REAL)) AS value FROM (
        SELECT t.created_at, SUM(d.scored) AS visit_scored
        FROM (SELECT t.id, t.game_id, t.set_no, t.leg_no, t.created_at,
                     ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
              FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${modeWhere} ${weightWhere}) t
        JOIN darts d ON d.turn_id = t.id
        WHERE t.rn = 1 ${F.and}
        GROUP BY t.game_id, t.set_no, t.leg_no
      ) GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'first9avg':
      // Score of first 9 actual darts (visits 1-3), all legs included — no HAVING bias
      return db.prepare(`SELECT ${L.fmt} AS bucket, AVG(CAST(total_scored AS REAL)/NULLIF(dart_count,0)*3) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, SUM(d.scored) AS total_scored, COUNT(d.id) AS dart_count
        FROM (SELECT t.id, t.game_id, t.set_no, t.leg_no, t.created_at,
                     ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
              FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${modeWhere} ${weightWhere}) t
        JOIN darts d ON d.turn_id = t.id
        WHERE t.rn <= 3
        GROUP BY t.game_id, t.set_no, t.leg_no
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
    case 'pace':
      // Darts/minute, derived from the gap between consecutive thrown_at timestamps
      // within the same turn — only populated when "collect per-dart timing" is on.
      return db.prepare(`SELECT bucket, 60000.0/AVG(gap_ms) AS value FROM (
        SELECT ${T.fmt} AS bucket, (julianday(d.thrown_at) - julianday(prev.thrown_at)) * 86400000 AS gap_ms
        FROM darts d
        JOIN darts prev ON prev.turn_id = d.turn_id AND prev.dart_no = d.dart_no - 1
        JOIN turns t ON t.id = d.turn_id JOIN games g ON g.id = t.game_id
        WHERE t.player_id=? AND d.thrown_at IS NOT NULL AND prev.thrown_at IS NOT NULL ${T.and} ${modeWhere} ${weightWhere}
      ) WHERE gap_ms > 0 AND gap_ms < 60000 GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'avgdartsperleg':
      return db.prepare(`SELECT ${L.fmt} AS bucket, AVG(leg_darts) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, COUNT(d.id) AS leg_darts
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${modeWhere} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(t.checkout)>0
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
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
      SELECT t.player_id FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.category = '501' ${mf}
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING COUNT(DISTINCT t.id) = 3 AND SUM(t.checkout) > 0 AND COUNT(d.id) = 9
    ) x JOIN players p ON p.id = x.player_id
    GROUP BY x.player_id ORDER BY count DESC
  `).all();
  const recent = db.prepare(`
    SELECT p.name, MAX(t.created_at) AS created_at
    FROM turns t JOIN games g ON g.id=t.game_id JOIN players p ON p.id=t.player_id
    JOIN darts d ON d.turn_id=t.id
    WHERE g.category = '501' ${mf}
    GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
    HAVING COUNT(DISTINCT t.id) = 3 AND SUM(t.checkout) > 0 AND COUNT(d.id) = 9
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

function getCheckoutRoutes(playerName, score, mode) {
  const p = getPlayer(playerName);
  if (!p) return [];
  const mf = _mf(mode);
  return db.prepare(`
    SELECT d1.sector AS s1, d1.multiplier AS m1,
           d2.sector AS s2, d2.multiplier AS m2,
           d3.sector AS s3, d3.multiplier AS m3,
           COUNT(*) AS times
    FROM turns t
    JOIN games g ON g.id = t.game_id
    JOIN  darts d1 ON d1.turn_id = t.id AND d1.dart_no = 1
    LEFT JOIN darts d2 ON d2.turn_id = t.id AND d2.dart_no = 2
    LEFT JOIN darts d3 ON d3.turn_id = t.id AND d3.dart_no = 3
    WHERE t.player_id = ? AND t.checkout = 1 AND t.checkout_points = ? ${mf}
    GROUP BY s1, m1, s2, m2, s3, m3
    ORDER BY times DESC
    LIMIT 5
  `).all(p.id, Number(score));
}

function getDartAnalytics(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const mf = _mf(mode);

  // Base FROM for dart-level queries (darts → turns → games)
  // Excludes darts thrown on busted turns — they shouldn't count toward sector/treble analytics
  const BASE = `FROM darts d JOIN turns t ON t.id = d.turn_id JOIN games g ON g.id = t.game_id WHERE t.player_id = ? AND t.bust = 0`;

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
// Public (no-auth) read of just the dart-timing flag — gameplay needs this on every
// device, including ones that never log in as admin.
function getDartTimingEnabled() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'collect_dart_timing'").get();
  return { enabled: row ? row.value === '1' : false };
}

/* ---------- admin accounts + sessions ---------- */
function isSetupRequired() {
  return q.countAdmins.get().n === 0;
}

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

function validateCredentials(username, password) {
  username = String(username || '').trim();
  if (!USERNAME_RE.test(username)) throw httpError(400, 'Username must be 3-32 characters: letters, numbers, _ . -');
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw httpError(400, 'Password must be at least 8 characters');
  }
  return username;
}

function createFirstAdmin(username, password) {
  if (!isSetupRequired()) throw httpError(403, 'Setup already completed');
  username = validateCredentials(username, password);
  const { hash, salt } = auth.hashSecret(password);
  try {
    q.insertAdmin.run(username, hash, salt);
  } catch (e) {
    throw httpError(409, 'Username already exists');
  }
  return { ok: true };
}

function createAdmin(username, password) {
  username = validateCredentials(username, password);
  const { hash, salt } = auth.hashSecret(password);
  try {
    q.insertAdmin.run(username, hash, salt);
  } catch (e) {
    throw httpError(409, 'Username already exists');
  }
  return { ok: true };
}

function listAdmins() {
  return q.listAdmins.all().map(a => ({ id: a.id, username: a.username, createdAt: a.created_at }));
}

function deleteAdmin(id) {
  id = Number(id);
  if (q.countAdmins.get().n <= 1) throw httpError(400, 'Cannot delete the last remaining admin account');
  q.deleteAdmin.run(id);
  q.deleteSessionsForAdmin.run(id);
  return { ok: true };
}

function changeAdminPassword(id, password) {
  id = Number(id);
  const admin = q.adminById.get(id);
  if (!admin) throw httpError(404, 'Admin not found');
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw httpError(400, 'Password must be at least 8 characters');
  }
  const { hash, salt } = auth.hashSecret(password);
  q.updateAdminPw.run(hash, salt, id);
  q.deleteSessionsForAdmin.run(id); // force re-login on this and any other device after a password change
  return { ok: true };
}

// Generic failure message for both "unknown username" and "wrong password" — avoids
// leaking which usernames exist (user enumeration).
const INVALID_LOGIN = 'Invalid username or password';

// Fixed dummy hash/salt used to verify against on unknown usernames, so login() always
// performs one scrypt computation regardless of whether the username exists — this keeps
// response timing from leaking which usernames are registered.
const DUMMY_PW_HASH = auth.hashSecret('dummy-password-for-constant-time-login');

function login(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  const admin = q.adminByUsername.get(username);
  const ok = admin
    ? auth.verifySecret(password, admin.password_hash, admin.password_salt)
    : (auth.verifySecret(password, DUMMY_PW_HASH.hash, DUMMY_PW_HASH.salt), false);
  if (!admin || !ok) throw httpError(401, INVALID_LOGIN);

  const token = auth.newSessionToken();
  const tokenHash = auth.hashToken(token);
  const now = Date.now();
  q.insertSession.run(tokenHash, admin.id, now, now + auth.SESSION_TTL_MS);
  q.deleteExpiredSessions.run(now);
  return { token, username: admin.username };
}

function logout(token) {
  if (!token) return { ok: true };
  q.deleteSession.run(auth.hashToken(token));
  return { ok: true };
}

function getSessionAdmin(token) {
  if (!token) return null;
  const row = q.sessionByHash.get(auth.hashToken(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) { q.deleteSession.run(row.token_hash); return null; }
  const admin = q.adminById.get(row.admin_id);
  return admin ? { id: admin.id, username: admin.username } : null;
}

/* ---------- player PIN management ---------- */
const PIN_RE = /^\d{4,8}$/;

function pinLockoutThreshold() {
  const v = Number(getSettings().pin_lockout_threshold);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_PIN_LOCKOUT_THRESHOLD;
}

function setPlayerPin(name, pin) {
  const p = getPlayer(name);
  if (!p) throw httpError(404, 'Player not found');
  if (!PIN_RE.test(String(pin))) throw httpError(400, 'PIN must be 4-8 digits');
  const { hash, salt } = auth.hashSecret(String(pin));
  q.setPin.run(hash, salt, p.id);
  return { name: p.name, hasPin: true };
}

function removePlayerPin(name) {
  const p = getPlayer(name);
  if (!p) throw httpError(404, 'Player not found');
  q.clearPin.run(p.id);
  return { name: p.name, hasPin: false };
}

// Generic failure message — doesn't distinguish "no pin set", "wrong pin", or "locked",
// to avoid leaking player PIN state to a guesser.
const INVALID_PIN = 'Incorrect PIN';

function verifyPlayerPin(name, pin) {
  const p = getPlayer(name);
  if (!p) throw httpError(404, 'Player not found');
  if (!p.pin_hash) return { ok: true }; // no PIN set — anyone may play as this player

  const now = Date.now();
  if (p.pin_locked_until && p.pin_locked_until > now) {
    throw httpError(423, 'Too many incorrect attempts. Try again later.');
  }

  const ok = auth.verifySecret(String(pin || ''), p.pin_hash, p.pin_salt);
  if (!ok) {
    q.bumpPinFail.run(p.id);
    const fails = (p.pin_fail_count || 0) + 1;
    const threshold = pinLockoutThreshold();
    if (fails >= threshold) {
      q.lockPin.run(now + 5 * 60 * 1000, p.id); // 5 minute lockout
    }
    throw httpError(401, INVALID_PIN);
  }
  q.resetPinFail.run(p.id);
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

function getH2HRecord(name1, name2) {
  if(!name1 || !name2) return null;
  const p1 = db.prepare(`SELECT id FROM players WHERE name=?`).get(name1);
  const p2 = db.prepare(`SELECT id FROM players WHERE name=?`).get(name2);
  if(!p1 || !p2) return null;
  const rows = db.prepare(`
    SELECT g.winner_id FROM games g
    JOIN game_players gp1 ON gp1.game_id=g.id AND gp1.player_id=?
    JOIN game_players gp2 ON gp2.game_id=g.id AND gp2.player_id=?
    WHERE g.practice=0 AND g.winner_id IS NOT NULL
  `).all(p1.id, p2.id);
  const p1Wins = rows.filter(r=>r.winner_id===p1.id).length;
  const p2Wins = rows.filter(r=>r.winner_id===p2.id).length;
  return { p1:name1, p2:name2, p1Wins, p2Wins, total:rows.length };
}

/* ---------- helpers ---------- */
function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}

module.exports = {
  listPlayers, addPlayer, renamePlayer, setOut, setDartWeight, deletePlayer,
  createGame, addTurn, completeGame, recordEvent,
  computeStats, getSummary, getHomeExtra, getOneEightyStats, getBigFishStats, getNineDarterStats,
  getPlayerStatBubbles, getMetricHistory, getPersonalBests, getH2HRecord,
  getTopFinishes, getTopFinishesAll, getDartWeights, clearPlayerStats, resetStats, deleteLastTurn,
  getCheckoutRoutes, getDartAnalytics,
  getSettings, updateSettings, getDartTimingEnabled, fireHaWebhook,
  isSetupRequired, createFirstAdmin, createAdmin, listAdmins, deleteAdmin, changeAdminPassword,
  login, logout, getSessionAdmin,
  setPlayerPin, removePlayerPin, verifyPlayerPin, pinLockoutThreshold,
  _db: db,
};
