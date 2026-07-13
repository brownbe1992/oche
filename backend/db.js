'use strict';
/* =============================================================================
   Database layer for the darts scorer.

   Uses Node's built-in SQLite (node:sqlite, Node 22.13+ — it exists as of
   22.5.0 but stays behind the --experimental-sqlite flag until 22.13.0, and
   this project never passes that flag, so anything older throws
   ERR_UNKNOWN_BUILTIN_MODULE), so there are NO external dependencies to
   install or compile — important for running on Unraid / Docker without
   native-module headaches.

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
const netguard = require('./netguard.js');
const { checkoutHint, dartLabel } = require('../frontend/scoring.js');

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
    -- leg_won (added via ALTER TABLE below) is a game-type-agnostic "this turn won
    -- the leg" signal, distinct from checkout (X01's own narrower double-out
    -- concept) — Cricket has no checkout mechanism, so Personal Bests need their
    -- own marker for finding winning legs.
  );

  CREATE INDEX IF NOT EXISTS idx_turns_player ON turns(player_id);
  CREATE INDEX IF NOT EXISTS idx_turns_game   ON turns(game_id);

  -- darts stores one row per physical dart. scored/is_treble/is_double are generated
  -- from sector+multiplier — no app code writes them; SQLite computes and stores them.
  -- thrown_at (added via ALTER TABLE below) is the client-captured tap timestamp, only
  -- populated when the "collect_dart_timing" setting is on; null otherwise. zone/
  -- miss_zone/miss_depth/bounced (also added via ALTER TABLE below,
  -- docs/archive/dartboard-zone-tracking-roadmap.md) are purely additive Dartboard-mode-only
  -- positional metadata — see that migration's own comment for the full rationale.
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

  -- Persistent record of server-side 5xx failures (docs/testing-and-observability-roadmap.md
  -- Part A) — console.error alone only survives as long as the container's stdout log
  -- retention does, and requires shell/docker access to read. Storing the same events here
  -- gives a self-hoster a "recent errors" view in Settings without either of those. Kept
  -- small on purpose (see logServerError()'s prune-to-500 behavior below) — this is a
  -- diagnostic tail, not a full audit log.
  CREATE TABLE IF NOT EXISTS server_errors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    method     TEXT,
    path       TEXT,
    status     INTEGER,
    message    TEXT
  );

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

  -- Every badge a player has earned (docs/archive/achievements-badges-roadmap.md), one row
  -- per player+badge with a running count. Two award modes, chosen by the caller:
  --  - counted (most badges): count increments every time the badge's trigger
  --    condition fires (a visit, a leg, a match) — the Badge Case shows this count.
  --  - once (state-based badges whose condition stays true forever once crossed,
  --    e.g. Around the Clock/World, Grudge Match): INSERT OR IGNORE only, so
  --    re-checking the same still-true condition doesn't inflate the count.
  CREATE TABLE IF NOT EXISTS player_badges (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    badge_id  TEXT NOT NULL,
    count     INTEGER NOT NULL DEFAULT 1,
    earned_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(player_id, badge_id)
  );

  -- Daily Challenge attempts (docs/daily-challenge-roadmap.md). Per the games-context
  -- convention in CLAUDE.md, a challenge attempt links into games via its own table
  -- with a game_id FK rather than a new boolean column on games itself.
  CREATE TABLE IF NOT EXISTS daily_challenge_attempts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id        INTEGER NOT NULL REFERENCES games(id)   ON DELETE CASCADE,
    player_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    challenge_date TEXT NOT NULL,   -- YYYY-MM-DD, local to whoever attempted it
    format         TEXT NOT NULL,   -- 'checkout_sprint' | 'speed_to_zero' | 'bullseye_gauntlet'
                                     -- | 'steady_hand' | 'treble_run' | 'long_game'
    target         INTEGER,         -- checkout target for checkout_sprint; null for speed_to_zero
    result_darts   INTEGER,         -- darts taken to complete; null if not completed
    completed      INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(player_id, challenge_date)
  );
  CREATE INDEX IF NOT EXISTS idx_challenge_player_date ON daily_challenge_attempts(player_id, challenge_date);

  -- Tournament mode (docs/tournament-mode-roadmap.md), single-elimination only —
  -- built on top of the existing 1v1 scoring engine rather than a parallel system.
  -- A tournament match IS a normal games row under the hood (tournament_matches.game_id),
  -- so PINs, checkout hints, undo, live scoreboard, and all existing stats keep
  -- working with zero changes to the scoring engine itself; this layer is purely
  -- bracket orchestration on top. winner_next_match_id/slot and loser_next_match_id/
  -- slot are the same pointer-pair design the roadmap doc uses to make single- and
  -- double-elimination the same schema — a future double-elimination pass (tracked
  -- separately, see docs/open-roadmap-items.md) can reuse this table set unchanged;
  -- v1 only ever writes loser_next_match_id/slot as NULL.
  CREATE TABLE IF NOT EXISTS tournaments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    category      TEXT NOT NULL,   -- X01 starting score as a string: '501'|'301'|'170'|'101'
    bracket_type  TEXT NOT NULL DEFAULT 'single_elim' CHECK (bracket_type IN ('single_elim','double_elim')),
    player_count  INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
    champion_id   INTEGER REFERENCES players(id) ON DELETE SET NULL,
    runner_up_id  INTEGER REFERENCES players(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS tournament_players (
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_id     INTEGER NOT NULL REFERENCES players(id)     ON DELETE CASCADE,
    seed          INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','eliminated','champion')),
    PRIMARY KEY (tournament_id, player_id)
  );

  -- One row per round so each can carry its own format (e.g. Bo3 early rounds
  -- stepping up to Bo5 in the final) — resolved and stored at bracket-creation
  -- time, not looked up dynamically.
  CREATE TABLE IF NOT EXISTS tournament_rounds (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    bracket       TEXT NOT NULL DEFAULT 'winners' CHECK (bracket IN ('winners','losers','grand_final')),
    round_no      INTEGER NOT NULL,
    label         TEXT NOT NULL,   -- e.g. "Quarterfinal", "Final"
    legs_per_set  INTEGER NOT NULL,
    sets_per_game INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tournament_rounds_tournament ON tournament_rounds(tournament_id);

  CREATE TABLE IF NOT EXISTS tournament_matches (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id             INTEGER NOT NULL REFERENCES tournament_rounds(id) ON DELETE CASCADE,
    slot                 INTEGER NOT NULL,   -- 1-based position within the round
    player1_id           INTEGER REFERENCES players(id) ON DELETE SET NULL,
    player2_id           INTEGER REFERENCES players(id) ON DELETE SET NULL,
    is_bye               INTEGER NOT NULL DEFAULT 0,
    game_id              INTEGER REFERENCES games(id) ON DELETE SET NULL,
    winner_id            INTEGER REFERENCES players(id) ON DELETE SET NULL,
    winner_next_match_id INTEGER REFERENCES tournament_matches(id) ON DELETE SET NULL,
    winner_next_slot     INTEGER,   -- 1 or 2 — which slot of winner_next_match_id the winner fills
    loser_next_match_id  INTEGER REFERENCES tournament_matches(id) ON DELETE SET NULL,
    loser_next_slot      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tournament_matches_round ON tournament_matches(round_id);
  CREATE INDEX IF NOT EXISTS idx_tournament_matches_game  ON tournament_matches(game_id);

  -- League mode (docs/league-mode-roadmap.md), X01 only for v1. Unlike tournament mode,
  -- a league game has no bracket position/round/advancement state of its own — it's
  -- just an ordinary casual H2H game that happens to get tagged — so per CLAUDE.md's
  -- "context tables link into games via FK" convention, the link is a direct nullable
  -- games.league_id column (added via ALTER TABLE below) rather than a junction table
  -- with its own game_id the way tournament_matches has. Deliberately NO points/played/
  -- won/lost tally columns on league_players: standings are computed LIVE from
  -- games/game_players (getLeagueStandings()), matching this file's "nothing
  -- pre-aggregated" design and avoiding a drift-prone maintained counter. Deliberately
  -- no stored player_count either (unlike tournaments.player_count, which is frozen
  -- because the bracket SHAPE depends on it) — a league's roster can grow any time
  -- during the season, so its count is always a live COUNT(league_players).
  CREATE TABLE IF NOT EXISTS leagues (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    game_type     TEXT NOT NULL DEFAULT 'x01',   -- 'x01' | 'cricket'
    category      TEXT NOT NULL,   -- X01: starting score as a string ('501'|'301'|'170'|'101').
                                    -- Cricket: 'Cricket (15-20, Bull)' | 'Custom Cricket' — the
                                    -- exact same two-value games.category label a Cricket H2H
                                    -- game is already tagged with (frontend/index.html), reused
                                    -- as-is rather than inventing a parallel category vocabulary.
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
    starts_at     TEXT NOT NULL,   -- YYYY-MM-DD
    ends_at       TEXT,            -- YYYY-MM-DD, nullable = open-ended/ongoing season
    points_win    INTEGER NOT NULL DEFAULT 1,
    points_loss   INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS league_players (
    league_id  INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (league_id, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_league_players_player ON league_players(player_id);

  -- Dart Builder / loadout customization (docs/archive/dart-builder-roadmap.md). Not a new
  -- column on games/players — a player's owned catalog of parts, each row personal
  -- (not shared/global) since real dart preferences are personal. No 'tip' type: tip
  -- texture is a single attribute of the assembled loadout (see loadouts.tip_texture
  -- below), not a reusable catalog part the way barrels/shafts/flights are.
  CREATE TABLE IF NOT EXISTS dart_components (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('barrel','shaft','flight')),
    name       TEXT NOT NULL,
    length_mm  TEXT,     -- a preset range label (e.g. "medium"), not a raw millimeter number
    weight_g   INTEGER,  -- barrel only in practice; shaft/flight weight is negligible and left NULL
    material   TEXT,
    shape      TEXT,     -- barrel: straight/torpedo/ton. shaft: "type" (fixed/spinning), stored
                          -- here rather than a separate column since it's the same one-of-a-
                          -- fixed-list-per-type slot conceptually. flight: standard/slim/kite/pear.
    grip       TEXT,      -- barrel only: smooth/knurled/ringed (surface texture, separate from shape)
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_dart_components_player ON dart_components(player_id);

  -- A saved, named combination of exactly one component per type. barrel/shaft/
  -- flight_id are individually nullable (a loadout can be saved "in progress"), but a
  -- loadout can't be selected for a game until all three are filled (checked at
  -- selection time in resolveLoadoutForGame(), not at save time).
  CREATE TABLE IF NOT EXISTS loadouts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    barrel_id    INTEGER REFERENCES dart_components(id) ON DELETE SET NULL,
    shaft_id     INTEGER REFERENCES dart_components(id) ON DELETE SET NULL,
    flight_id    INTEGER REFERENCES dart_components(id) ON DELETE SET NULL,
    tip_texture  TEXT CHECK (tip_texture IN ('smooth','grooved')),
    dart_count   INTEGER NOT NULL DEFAULT 3,
    is_default   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_loadouts_player ON loadouts(player_id);

  -- Ghost Opponent win/loss tracking (docs/archive/ghost-opponent-roadmap.md). A ghost race
  -- is a genuine interleaved race (playGhostTurn()/enterTurn() alternate, whoever
  -- checks out first wins) but the result was never recorded anywhere before this —
  -- game_id is the race's own new practice game; source_game_id/source_set_no/
  -- source_leg_no identify which historical leg was raced.
  CREATE TABLE IF NOT EXISTS ghost_races (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    source_game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    source_set_no  INTEGER NOT NULL,
    source_leg_no  INTEGER NOT NULL,
    result         TEXT NOT NULL CHECK (result IN ('win','loss')),
    human_darts    INTEGER,
    ghost_darts    INTEGER,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ghost_races_player ON ghost_races(player_id);
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
// game_type/config lay the groundwork for future non-X01 game types (see
// docs/game-modes-roadmap.md) without changing any current behavior — every game
// created today is still 'x01', config just carries its starting score.
try { db.exec("ALTER TABLE games ADD COLUMN game_type TEXT NOT NULL DEFAULT 'x01'"); } catch(e) {}
try { db.exec('ALTER TABLE games ADD COLUMN config TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE admins ADD COLUMN login_fail_count INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE admins ADD COLUMN login_locked_until INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE player_badges ADD COLUMN count INTEGER NOT NULL DEFAULT 1'); } catch(e) {}
// Cricket has no checkout mechanism, so its Personal Bests (fewest darts to close
// a leg, best MPR in a leg) need their own "this turn won the leg" signal instead
// of reusing checkout (X01's narrower double-out concept). Defaults to 0 for every
// existing/X01 row — X01's own Personal Bests queries keep using checkout=1
// unchanged. Only Cricket's write path (enterTurnCricket()) sets it.
try { db.exec('ALTER TABLE turns ADD COLUMN leg_won INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
// Checkout Trainer (docs/checkout-trainer-roadmap.md): the target score given for
// that round. Unlike X01 there's no persistent "remaining score" game state to
// derive it from afterward, so it has to be stored per-turn. Only ever populated
// for game_type='checkout_trainer'; every other game type leaves it NULL.
try { db.exec('ALTER TABLE turns ADD COLUMN target_score INTEGER'); } catch(e) {}
// player_count is the participant count captured once at game creation. H2H-vs-practice
// classification reads THIS instead of a live COUNT(game_players) subquery, so deleting
// or resetting a player can never retroactively reclassify a game (a 2-player H2H game
// stays H2H even after one participant is removed). Backfilled for existing rows below.
try { db.exec('ALTER TABLE games ADD COLUMN player_count INTEGER'); } catch(e) {}
// Dart Builder (docs/archive/dart-builder-roadmap.md): resolved once at game creation and
// snapshotted, same reasoning already applied to game_players.dart_weight/out_mode —
// renaming/deleting a loadout later never rewrites a past game's history.
try { db.exec('ALTER TABLE game_players ADD COLUMN loadout_id INTEGER REFERENCES loadouts(id) ON DELETE SET NULL'); } catch(e) {}
// League mode (docs/league-mode-roadmap.md): nullable, set by the onGameCreated
// auto-tag hook below (or left NULL for any game that isn't a tagged league match).
try { db.exec('ALTER TABLE games ADD COLUMN league_id INTEGER REFERENCES leagues(id) ON DELETE SET NULL'); } catch(e) {}
// League mode Cricket support (docs/league-mode-roadmap.md): a second game type
// alongside the original X01-only v1. Defaults to 'x01' for every pre-existing row
// (and any insert that omits it) so the column is purely additive — no backfill
// guesswork needed, since every league created before this shipped genuinely was X01.
try { db.exec("ALTER TABLE leagues ADD COLUMN game_type TEXT NOT NULL DEFAULT 'x01'"); } catch(e) {}
// Dartboard zone/miss/bounce-out tracking (docs/archive/dartboard-zone-tracking-roadmap.md).
// All four columns are purely additive metadata riding alongside an otherwise-
// identical dart row — sector/multiplier/scored/is_treble/is_double keep meaning
// exactly what they always have, so every existing consumer (evaluateVisit(),
// every badge chain check, getGhostLegScript() replay, getFullDatabaseExport())
// needs zero changes. Only Dartboard-mode taps ever populate these (Pad mode and
// Cricket's own pad have no geometric tap position, so they stay NULL forever) —
// "precision arrives gradually," never backfilled or guessed for existing rows.
try { db.exec("ALTER TABLE darts ADD COLUMN zone TEXT"); } catch(e) {}         // 'inner'|'outer', single hits only
try { db.exec('ALTER TABLE darts ADD COLUMN miss_zone INTEGER'); } catch(e) {} // 1-20 (nearest wedge), misses only
try { db.exec("ALTER TABLE darts ADD COLUMN miss_depth TEXT"); } catch(e) {}   // 'near'|'far', misses only
try { db.exec('ALTER TABLE darts ADD COLUMN bounced INTEGER'); } catch(e) {}   // 1 = bounced/fell out, misses only
db.exec(`UPDATE games SET player_count = (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = games.id) WHERE player_count IS NULL`);
// config wasn't backfilled when the column was added (unlike player_count above) —
// every pre-existing row is X01 (game_type defaults to 'x01') with category as its
// stringified starting score, so this mirrors createGame()'s own derivation exactly.
db.exec(`UPDATE games SET config = json_object('startingScore', CAST(category AS INTEGER)) WHERE config IS NULL AND game_type = 'x01'`);

const DEFAULT_PIN_LOCKOUT_THRESHOLD = 10;
// Admin login backoff (docs/archive/admin-login-backoff-roadmap.md) — replaces the old flat
// admin_lockout_threshold+5-minute-lock scheme. The first few wrong passwords cost no
// delay at all (real admins mistype); every failure past that grace window doubles the
// wait, capped at the max, so a legitimate admin is never fully locked out — only ever
// made to wait slightly longer before the next attempt — while brute-forcing the
// password stays computationally infeasible after a dozen or so guesses.
const DEFAULT_ADMIN_LOCKOUT_GRACE = 3;
const DEFAULT_ADMIN_LOCKOUT_BASE_SECONDS = 2;
const DEFAULT_ADMIN_LOCKOUT_MAX_SECONDS = 900; // 15 minutes
const DEFAULT_BACKUP_RETENTION_DAYS = 7; // mirrors backup-lib.js's own fallback for when this setting is unset

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
  // RETURNING the post-increment count so callers compare the actual persisted value
  // against the lockout threshold, instead of computing (staleCount + 1) from a row
  // read before the `await auth.verifySecret(...)` yield — two concurrent failed
  // attempts racing across that yield would otherwise both compute the same stale
  // fails count and could let one extra guess past the threshold.
  bumpPinFail  : db.prepare('UPDATE players SET pin_fail_count = pin_fail_count + 1 WHERE id = ? RETURNING pin_fail_count'),
  lockPin      : db.prepare('UPDATE players SET pin_locked_until = ? WHERE id = ?'),
  resetPinFail : db.prepare('UPDATE players SET pin_fail_count = 0, pin_locked_until = NULL WHERE id = ?'),

  awardBadgeOnce      : db.prepare('INSERT OR IGNORE INTO player_badges (player_id, badge_id, count) VALUES (?, ?, 1)'),
  awardBadgeIncrement : db.prepare(`
    INSERT INTO player_badges (player_id, badge_id, count) VALUES (?, ?, 1)
    ON CONFLICT(player_id, badge_id) DO UPDATE SET count = count + 1
  `),
  badgeCount   : db.prepare('SELECT count FROM player_badges WHERE player_id = ? AND badge_id = ?'),
  decrementBadge : db.prepare('UPDATE player_badges SET count = count - 1 WHERE player_id = ? AND badge_id = ?'),
  deleteBadge    : db.prepare('DELETE FROM player_badges WHERE player_id = ? AND badge_id = ?'),
  playerBadges : db.prepare('SELECT badge_id, count, earned_at FROM player_badges WHERE player_id = ? ORDER BY earned_at DESC'),

  insertAdmin    : db.prepare('INSERT INTO admins (username, password_hash, password_salt) VALUES (?, ?, ?)'),
  // docs/security-audit-roadmap.md SEC-20: an atomic "insert only if no admin exists
  // yet" for createFirstAdmin() — the WHERE NOT EXISTS makes the whole guard-and-insert
  // one indivisible statement, so two concurrent /api/setup requests can't both pass a
  // separate check-then-insert and both create an admin during the same first-run window.
  insertAdminIfNone: db.prepare(`INSERT INTO admins (username, password_hash, password_salt)
    SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admins)`),
  adminByUsername: db.prepare('SELECT id, username, password_hash, password_salt, login_fail_count, login_locked_until FROM admins WHERE username = ? COLLATE NOCASE'),
  adminById      : db.prepare('SELECT id, username FROM admins WHERE id = ?'),
  // Wider shape than adminById — includes the fields needed to actually re-verify a
  // password (verifyAdminPassword, for the backup-restore re-auth gate) rather than
  // just confirming the id exists.
  adminByIdFull  : db.prepare('SELECT id, username, password_hash, password_salt, login_fail_count, login_locked_until FROM admins WHERE id = ?'),
  listAdmins     : db.prepare('SELECT id, username, created_at, login_fail_count, login_locked_until FROM admins ORDER BY username COLLATE NOCASE'),
  countAdmins    : db.prepare('SELECT COUNT(*) AS n FROM admins'),
  deleteAdmin    : db.prepare('DELETE FROM admins WHERE id = ?'),
  // RETURNING the post-increment count — see bumpPinFail's comment above for why.
  bumpLoginFail  : db.prepare('UPDATE admins SET login_fail_count = login_fail_count + 1 WHERE id = ? RETURNING login_fail_count'),
  lockLogin      : db.prepare('UPDATE admins SET login_locked_until = ? WHERE id = ?'),
  resetLoginFail : db.prepare('UPDATE admins SET login_fail_count = 0, login_locked_until = NULL WHERE id = ?'),
  updateAdminPw  : db.prepare('UPDATE admins SET password_hash = ?, password_salt = ? WHERE id = ?'),

  insertServerError : db.prepare('INSERT INTO server_errors (method, path, status, message) VALUES (?, ?, ?, ?)'),
  pruneServerErrors : db.prepare('DELETE FROM server_errors WHERE id NOT IN (SELECT id FROM server_errors ORDER BY id DESC LIMIT 500)'),
  recentServerErrors: db.prepare('SELECT id, created_at, method, path, status, message FROM server_errors ORDER BY id DESC LIMIT ?'),

  insertSession  : db.prepare('INSERT INTO sessions (token_hash, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  sessionByHash  : db.prepare('SELECT token_hash, admin_id, expires_at FROM sessions WHERE token_hash = ?'),
  deleteSession  : db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  deleteSessionsForAdmin: db.prepare('DELETE FROM sessions WHERE admin_id = ?'),

  insertGame   : db.prepare('INSERT INTO games (category, legs_per_set, sets_per_game, practice, game_type, config) VALUES (?, ?, ?, ?, ?, ?)'),
  addParticipant: db.prepare('INSERT OR IGNORE INTO game_players (game_id, player_id, dart_weight, out_mode, loadout_id) VALUES (?, ?, ?, ?, ?)'),
  completeGame : db.prepare("UPDATE games SET completed_at = datetime('now'), winner_id = ? WHERE id = ?"),

  insertTurn   : db.prepare(`INSERT INTO turns
                   (game_id, player_id, set_no, leg_no, scored, bust, checkout, checkout_points, leg_won, target_score)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),

  insertDart   : db.prepare(`INSERT INTO darts (turn_id, dart_no, sector, multiplier, thrown_at, zone, miss_zone, miss_depth, bounced)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
};

/* ---------- player operations ---------- */
function getPlayer(name) { return q.playerByName.get(String(name)); }

// docs/security-audit-roadmap.md SEC-13: player names previously had no server-side
// length or shape bound (just String(name).trim()) — unbounded free-text from an
// unauthenticated caller (POST /api/players is public by default), and the raw
// material for SEC-12 (a stored-XSS sink that has since been fixed at the render
// site, but an input bound is still the right defense-in-depth here). Charset stays
// permissive (real names use emoji/apostrophes/etc.) — only a length cap and a
// control-character reject, since control characters have no legitimate use in a
// display name and the length cap keeps a single giant name from bloating every
// view/canvas/live-payload broadcast that echoes it.
const MAX_PLAYER_NAME_LEN = 64;
const CONTROL_CHAR_RE = /[\x00-\x1f]/;
function validatePlayerName(name) {
  name = String(name || '').trim();
  if (!name) throw httpError(400, 'Name is required');
  if (name.length > MAX_PLAYER_NAME_LEN) throw httpError(400, `Name must be ${MAX_PLAYER_NAME_LEN} characters or fewer`);
  if (CONTROL_CHAR_RE.test(name)) throw httpError(400, 'Name must not contain control characters');
  return name;
}

function ensurePlayer(name, out = 'double') {
  name = validatePlayerName(name);
  const existing = getPlayer(name);
  if (existing) return existing;
  q.insertPlayer.run(name, out === 'single' ? 'single' : 'double');
  return getPlayer(name);
}

function listPlayers() {
  return q.listPlayers.all().map(p => ({ name: p.name, out: p.out_mode, dartWeight: p.dart_weight ?? null, hasPin: !!p.pin_hash }));
}

// async: setPlayerPin() awaits scrypt hashing internally, and this function's own
// return value reads pin_hash back from the DB — without awaiting it here, the
// hasPin field below could report false for a player created with a PIN, since
// the hash write wouldn't have landed yet when getPlayer() re-reads the row.
async function addPlayer(name, out = 'double', opts = {}) {
  name = validatePlayerName(name);
  const existing = getPlayer(name);
  if (existing) return { name: existing.name, out: existing.out_mode, hasPin: !!existing.pin_hash, dartWeight: existing.dart_weight ?? null };
  q.insertPlayer.run(name, out === 'single' ? 'single' : 'double');
  if (opts.pin) await setPlayerPin(name, opts.pin);
  if (opts.dartWeight !== undefined && opts.dartWeight !== null && opts.dartWeight !== '') {
    setDartWeight(name, opts.dartWeight);
  }
  const p = getPlayer(name);
  return { name, out: out === 'single' ? 'single' : 'double', hasPin: !!p.pin_hash, dartWeight: p.dart_weight ?? null };
}

function renamePlayer(from, to) {
  to = validatePlayerName(to);
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

// Games with no remaining participants (every player who played in them has
// since been deleted) are dead weight: no stats point at them, but they still
// count toward "games played" and can still surface as "last game played"
// with a blank player list. Drop them.
function pruneOrphanedGames() {
  db.prepare('DELETE FROM games WHERE id NOT IN (SELECT DISTINCT game_id FROM game_players)').run();
}

/* ---------- player-deletion guard extensibility (docs/archive/existing-app-prep-roadmap.md item 6) ----------
   Mirrors the game-lifecycle hook pattern below: a small, growing list of "is this
   player referenced by an active thing" checks that deletePlayer() consults before
   deleting, rather than hardcoding tournament logic directly into deletePlayer(). A
   guard receives the player row ({id, name, ...}) and returns either a non-empty
   string (the reason to block the delete) or a falsy value (no objection) — the
   first blocking reason wins. Tournament mode registers one below (blocking deletion
   of an active competitor in an in-progress bracket, since bracket advancement
   depends on that exact player still existing at a specific slot).

   League mode (docs/league-mode-roadmap.md) deliberately registers NO guard, even
   though an earlier draft of this comment anticipated one: deleting a league-enrolled
   player cascades away only their own league_players/game_players/turns rows — the
   surviving opponent's game_players row and the game's own winner_id are untouched
   (games.winner_id ON DELETE SET NULL only fires if the DELETED player was the
   winner), so a deleted player's own history disappears exactly the same way it
   already does everywhere else in this app (H2H stats, badges, etc.), and standings
   simply recompute live over what remains. This is only safe BECAUSE league
   standings are computed live rather than incrementally maintained (see the
   `leagues`/`league_players` schema comment) — a guard would have been necessary
   under a maintained-tally design, not this one. */
const deletePlayerGuards = [];
function registerDeletePlayerGuard(fn) { deletePlayerGuards.push(fn); }
function _checkDeletePlayerGuards(player) {
  for (const fn of deletePlayerGuards) {
    const reason = fn(player);
    if (reason) return reason;
  }
  return null;
}

function deletePlayer(name) {
  const p = getPlayer(name);
  if (p) {
    const blockReason = _checkDeletePlayerGuards(p);
    if (blockReason) throw httpError(409, blockReason);
    q.deletePlayer.run(p.id);     // cascades to turns + game_players
    pruneOrphanedGames();
  }
  return { ok: true };
}

/* ---------- game-lifecycle hooks (docs/archive/existing-app-prep-roadmap.md item 4) ----------
   A minimal internal hook mechanism around createGame()/completeGame() so a future
   feature (HA polling on game start/end, tournament bracket advancement on
   completion, league standings updates, etc.) registers its own reaction here
   instead of editing these two core functions directly every time they need a
   new consequence stacked on. Fired synchronously, in registration order, right
   after the core DB write — a listener that throws is caught and logged, not
   rethrown, so one broken future feature can't take down game creation/completion
   itself. It doesn't retrofit the existing client-side achievement checks (those
   stay inline in frontend/index.html's enterTurn()/onLegWon(), a different layer
   entirely).

   Current 'created' payload: { gameId, gameType, practice, category, playerCount,
   playerIds, leagueId }. playerIds/leagueId were added for league mode's auto-tag
   hook below (docs/league-mode-roadmap.md) — playerIds is createGame()'s
   participants in submission order (not deduped); leagueId is whatever the caller
   passed through (unvalidated — each listener validates what it needs).
   Current 'completed' payload: { gameId, winnerName } — used by tournament mode's
   bracket-advancement hook (see the tournament section below). League mode needs no
   'completed' hook: unlike a tournament bracket, standings have no propagation step
   to react to — a completed game with league_id/winner_id already set is read
   directly at standings-query time. */
const gameLifecycleHooks = { created: [], completed: [] };
function onGameCreated(fn) { gameLifecycleHooks.created.push(fn); }
function onGameCompleted(fn) { gameLifecycleHooks.completed.push(fn); }
function _fireGameLifecycleHooks(event, payload) {
  for (const fn of gameLifecycleHooks[event]) {
    try { fn(payload); } catch (e) { console.error(`game-lifecycle "${event}" hook failed:`, e); }
  }
}

/* ---------- game + turn operations ---------- */
// docs/bug-roadmap.md BUG-5: legs-per-set / sets-per-game were stored as
// `Number(x) || 1`, which accepts a float (2.5 -> "first to 2.5 legs") or an
// absurd magnitude (1e9 -> an unwinnable match). Clamp to a whole number in a
// sane range at the write boundary. Lenient like the old `|| 1` (garbage floors
// to 1 rather than erroring) — the strict integer+range REJECT lives in
// createTournament(), whose UI never produces a bad value in the first place.
const MAX_LEGS_OR_SETS = 99;
function clampMatchFormat(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_LEGS_OR_SETS, n);
}
// A loadout can be saved "in progress" with empty slots (see dart_components CRUD
// below), but can't actually be used in a game until barrel/shaft/flight are all
// filled — checked here, at game-creation/selection time, not at save time.
function _resolveLoadoutForParticipant(playerId, loadoutId) {
  if (loadoutId === undefined || loadoutId === null || loadoutId === '') return null;
  const row = db.prepare('SELECT * FROM loadouts WHERE id = ?').get(Number(loadoutId));
  if (!row || row.player_id !== playerId) throw httpError(400, 'Loadout not found');
  if (row.barrel_id == null || row.shaft_id == null || row.flight_id == null) {
    throw httpError(400, `Loadout "${row.name}" is missing a barrel, shaft, or flight and can't be used in a game yet`);
  }
  return row;
}

function createGame({ category, legsPerSet, setsPerGame, players, practice, gameType, config, leagueId }) {
  // gameType/config default to X01 for every caller today (no New Game UI sends
  // anything else yet) — see docs/game-modes-roadmap.md. Accepting them as params
  // means a future Cricket/Baseball New Game flow can pass its own without another
  // signature change here.
  const resolvedGameType = gameType || 'x01';
  // docs/security-audit-roadmap.md SEC-14 / docs/bug-roadmap.md BUG-2: an unknown
  // gameType was previously accepted and stored as-is — it then counted toward every
  // UNSCOPED aggregate (total darts thrown, games played) while being silently
  // excluded from every TYPED stat query (X01_ONLY, _scope({gameType:...}), which
  // already whitelists against this same KNOWN_GAME_TYPES list on the read side).
  // Reject at the write boundary instead of letting a bad row drift the totals.
  if (!KNOWN_GAME_TYPES.includes(resolvedGameType)) {
    throw httpError(400, `Unknown gameType "${resolvedGameType}"`);
  }
  const categoryStr = String(category);
  if (categoryStr.length > 64) throw httpError(400, 'category must be 64 characters or fewer');
  const resolvedConfig = config ? JSON.stringify(config) : JSON.stringify({ startingScore: Number(category) || null });
  if (Buffer.byteLength(resolvedConfig) > 4096) throw httpError(400, 'config is too large');
  const info = q.insertGame.run(categoryStr, clampMatchFormat(legsPerSet), clampMatchFormat(setsPerGame), practice ? 1 : 0, resolvedGameType, resolvedConfig);
  const gameId = Number(info.lastInsertRowid);
  // participantIds (submission order, not deduped — see the player_count freeze below
  // for the deduped count) is threaded into the 'created' hook payload so a listener
  // (currently only league mode's auto-tag hook) can look up "who played this game"
  // without a second query — see docs/league-mode-roadmap.md.
  const participantIds = [];
  (players || []).forEach(entry => {
    const out = entry.out === 'single' ? 'single' : 'double';
    const p   = ensurePlayer(entry.name);
    participantIds.push(p.id);
    // docs/archive/dart-builder-roadmap.md: players.dart_weight is retired as a standalone
    // fallback — a selected loadout's barrel weight is the only source for
    // game_players.dart_weight going forward; no loadout means NULL, even for a
    // player who still has an old dart_weight value sitting orphaned on their row.
    const loadout = _resolveLoadoutForParticipant(p.id, entry.loadoutId);
    const weight = loadout ? _getComponentOrNull(loadout.barrel_id)?.weight_g ?? null : null;
    q.addParticipant.run(gameId, p.id, weight, out, loadout ? loadout.id : null);
  });
  // Freeze the participant count now (deduped, since addParticipant is INSERT OR IGNORE)
  // so H2H/practice classification survives later player deletion — see the migration note.
  const pc = db.prepare('SELECT COUNT(*) AS n FROM game_players WHERE game_id = ?').get(gameId).n;
  db.prepare('UPDATE games SET player_count = ? WHERE id = ?').run(pc, gameId);
  _fireGameLifecycleHooks('created', { gameId, gameType: resolvedGameType, practice: !!practice,
    category: categoryStr, playerCount: pc, playerIds: participantIds, leagueId });
  return { gameId };
}

function addTurn(gameId, t) {
  const p = ensurePlayer(t.player);
  // Every real visit is 1-3 physical darts. Enforce that here so a malformed/hostile
  // request can't record a "scored" turn with no dart rows — which would count toward
  // total points but not the darts denominator, silently inflating the 3-dart average.
  if (!Array.isArray(t.darts) || t.darts.length < 1 || t.darts.length > 3) {
    throw httpError(400, 'A turn must contain 1 to 3 darts');
  }
  // Validate each dart before writing: sector 0 (miss), 1-20, or 25 (bull); multiplier
  // 1-3. Rejecting garbage here keeps sector/treble/checkout analytics trustworthy.
  const darts = t.darts.map((d, i) => {
    const sector = Number(d.sector), multiplier = Number(d.multiplier);
    const validSector = Number.isInteger(sector) && (sector === 0 || sector === 25 || (sector >= 1 && sector <= 20));
    const validMult   = Number.isInteger(multiplier) && multiplier >= 1 && multiplier <= 3;
    if (!validSector || !validMult) throw httpError(400, 'Invalid dart sector or multiplier');
    // Reject physically impossible combinations the client can never produce: no
    // treble bull exists (makeDart() downgrades that tap to a single), and a miss is
    // always stored as multiplier 1 (a "double/treble miss" tap expands to N single
    // misses client-side). Left unchecked, a hostile/buggy client could store these
    // as phantom distinct (sector, multiplier) outcomes and corrupt the Around the
    // World progress count, whose 63-outcome total assumes only real combos exist.
    if (sector === 25 && multiplier === 3) throw httpError(400, 'No treble bull exists');
    if (sector === 0 && multiplier !== 1) throw httpError(400, 'A miss must have multiplier 1');
    // docs/archive/dartboard-zone-tracking-roadmap.md: zone/missZone/missDepth/bounced are all
    // purely additive, Dartboard-mode-only positional metadata — validated the same
    // "reject garbage, don't silently coerce" way as sector/multiplier above, and
    // each only meaningful on the specific dart shape it actually describes (a hit
    // can't have a miss wedge, a miss can't have an inner/outer zone).
    const zone = (d.zone === 'inner' || d.zone === 'outer') ? d.zone : null;
    if (d.zone != null && zone == null) throw httpError(400, "zone must be 'inner' or 'outer'");
    if (zone != null && !(sector >= 1 && sector <= 20 && multiplier === 1)) {
      throw httpError(400, 'zone is only valid for a single hit on a number 1-20');
    }
    const missDepth = (d.missDepth === 'near' || d.missDepth === 'far') ? d.missDepth : null;
    if (d.missDepth != null && missDepth == null) throw httpError(400, "missDepth must be 'near' or 'far'");
    let missZone = null;
    if (d.missZone != null) {
      missZone = Number(d.missZone);
      if (!Number.isInteger(missZone) || missZone < 1 || missZone > 20) throw httpError(400, 'missZone must be an integer 1-20');
    }
    if ((missZone != null) !== (missDepth != null)) throw httpError(400, 'missZone and missDepth must be set together');
    if (missZone != null && sector !== 0) throw httpError(400, 'missZone/missDepth are only valid on a miss (sector 0)');
    const bounced = !!d.bounced;
    if (bounced && sector !== 0) throw httpError(400, 'bounced is only valid on a miss (sector 0)');
    return { dartNo: Number.isInteger(Number(d.dartNo)) ? Number(d.dartNo) : i + 1, sector, multiplier,
             thrownAt: d.thrownAt ? String(d.thrownAt) : null, zone, missZone, missDepth, bounced };
  });
  // Validate the visit-level numbers too, not just the darts. turns.scored feeds every
  // points/average stat, so a negative or absurd value would silently corrupt them; a
  // negative set/leg number is meaningless. Max single-visit score is 180 (3xT20) and
  // max checkout is 170, so anything beyond those is garbage from a malformed/hostile
  // client (this is a requireWrite route, public by default on a LAN).
  // t.scored != null ? ... : 0, not `Number(t.scored) || 0` — the latter would
  // silently turn a non-numeric garbage value into a "valid" 0 (Number(garbage) is
  // NaN, and NaN || 0 is 0), defeating the Number.isFinite check on the next line
  // for exactly the malformed input it exists to catch.
  const scored = t.scored != null ? Number(t.scored) : 0;
  if (!Number.isFinite(scored) || scored < 0 || scored > 180) throw httpError(400, 'scored must be between 0 and 180');
  // t.set/t.leg default to 1 only when actually omitted (null/undefined) — a plain
  // `t.set || 1` would also silently coerce an explicit 0 to 1 (0 is falsy), which
  // would defeat the "positive integer" check on the very next line for exactly the
  // value it exists to catch.
  const setNo = Number(t.set != null ? t.set : 1), legNo = Number(t.leg != null ? t.leg : 1);
  if (!Number.isInteger(setNo) || setNo < 1 || !Number.isInteger(legNo) || legNo < 1) throw httpError(400, 'set and leg must be positive integers');
  const checkoutPoints = t.checkout ? (Number(t.checkoutPoints) || 0) : null;
  if (checkoutPoints != null && (!Number.isFinite(checkoutPoints) || checkoutPoints < 0 || checkoutPoints > 170)) throw httpError(400, 'checkoutPoints must be between 0 and 170');
  // Checkout Trainer (docs/checkout-trainer-roadmap.md): the target score offered
  // for this round. Server-computed context, not a scored value, so it's only
  // range-checked (1-170, the finishable range) rather than tied to any other field.
  let targetScore = null;
  if (t.targetScore != null) {
    targetScore = Number(t.targetScore);
    if (!Number.isInteger(targetScore) || targetScore < 1 || targetScore > 170) throw httpError(400, 'targetScore must be an integer between 1 and 170');
  }
  const info = q.insertTurn.run(
    Number(gameId), p.id,
    setNo, legNo,
    scored,
    t.bust ? 1 : 0,
    t.checkout ? 1 : 0,
    checkoutPoints,
    t.legWon ? 1 : 0,
    targetScore
  );
  // Insert individual dart rows — scored/is_treble/is_double are generated columns.
  // thrownAt is an ISO timestamp captured client-side at tap time; only sent when
  // the admin has enabled the "collect_dart_timing" setting.
  const turnId = Number(info.lastInsertRowid);
  for (const d of darts) {
    q.insertDart.run(turnId, d.dartNo, d.sector, d.multiplier, d.thrownAt,
      d.zone, d.missZone, d.missDepth, d.bounced ? 1 : null);
  }
  return { ok: true };
}

function completeGame(gameId, winnerName) {
  const w = winnerName ? getPlayer(winnerName) : null;
  // docs/bug-roadmap.md BUG-9: only a player who actually took part in this game may be
  // recorded as its winner. winnerName is client-supplied; without this check, a
  // malformed/hostile client (or, under the OCHE_REQUIRE_AUTH=false LAN opt-out, any
  // anonymous caller) could set games.winner_id to any player — crediting a phantom
  // H2H game win in computeStats() and resetting the real participants' win streaks.
  // Mirrors recordWalkover()'s own participant check and completes the guard BUG-4
  // added only to the tournament-advancement consumer (the base game record was left
  // unguarded). A null winner (an abandoned game) stays allowed.
  if (w && !db.prepare('SELECT 1 FROM game_players WHERE game_id = ? AND player_id = ?').get(Number(gameId), w.id)) {
    throw httpError(400, 'winner must be a participant of this game');
  }
  q.completeGame.run(w ? w.id : null, Number(gameId));
  _fireGameLifecycleHooks('completed', { gameId: Number(gameId), winnerName: w ? w.name : null });
  return { ok: true };
}

/* ---------- daily challenge (docs/daily-challenge-roadmap.md) ---------- */
// Links a just-started practice game to today's challenge attempt. One attempt per
// player per calendar date (UNIQUE(player_id, challenge_date)) — a second attempt on
// the same date fails quietly rather than overwriting the first, since "today's"
// challenge is meant to be a single daily shot, not retriable.
function startChallengeAttempt(playerName, gameId, challengeDate, format, target) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');
  if (!Number.isFinite(Number(gameId))) throw httpError(400, 'gameId must be a number');
  // docs/security-audit-roadmap.md SEC-14 / docs/bug-roadmap.md BUG-1: the write path
  // previously stored challengeDate/format via bare String(...) with no validation,
  // while every READ path (getChallengeStatus, resetChallengeAttempt) requires
  // challengeDate to match this same regex and the streak walks assume it parses as
  // a real calendar date — a malformed date written here would count toward
  // getChallengeHistory()'s played/completed totals (which doesn't validate) but
  // silently corrupt the streak walk (NaN day-gap resets a real run to 1). Reject
  // both at the write boundary instead of writing an attempt no read path can find.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(challengeDate))) throw httpError(400, 'challengeDate must be YYYY-MM-DD');
  if (!Object.prototype.hasOwnProperty.call(CHALLENGE_BETTER_DIRECTION, String(format))) {
    throw httpError(400, `Unknown challenge format "${format}"`);
  }
  try {
    db.prepare(`
      INSERT INTO daily_challenge_attempts (game_id, player_id, challenge_date, format, target)
      VALUES (?, ?, ?, ?, ?)
    `).run(Number(gameId), p.id, String(challengeDate), String(format), target != null ? Number(target) : null);
    return { ok: true };
  } catch (e) {
    // Only the UNIQUE(player_id, challenge_date) violation means "already attempted";
    // a foreign-key failure means the gameId doesn't exist (a distinct client error),
    // and anything else is a genuine server fault — don't disguise either as a 409.
    const msg = String(e && e.message || '');
    if (/UNIQUE constraint failed/i.test(msg)) throw httpError(409, 'Already attempted today\'s challenge');
    if (/FOREIGN KEY constraint failed/i.test(msg)) throw httpError(400, 'gameId does not reference an existing game');
    throw e;
  }
}

// Each challenge format's success metric points a different direction (see
// challengeMetricLabel() in frontend/index.html) — 'asc' means lower is better
// (fewest darts/visits), 'desc' means higher is better (most bulls/trebles/points).
const CHALLENGE_BETTER_DIRECTION = {
  checkout_sprint: 'asc', speed_to_zero: 'asc', long_game: 'asc',
  bullseye_gauntlet: 'desc', treble_run: 'desc', steady_hand: 'desc',
};

function completeChallengeAttempt(playerName, challengeDate, resultDarts) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');
  // See startChallengeAttempt()'s comment (SEC-14/BUG-1) — same read/write asymmetry,
  // guarded the same way here.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(challengeDate))) throw httpError(400, 'challengeDate must be YYYY-MM-DD');
  // A day's result is locked in like a Wordle guess — once completed it must not be
  // overwritten. The `AND completed = 0` guard makes a repeat/retried/replayed
  // completion a no-op instead of letting a second (e.g. better) resultDarts replace
  // the locked one and fabricate a personal best / streak. /api/challenges/complete is
  // a requireWrite route, public by default, so a plain double-submit could trigger it.
  const info = db.prepare(`
    UPDATE daily_challenge_attempts SET completed = 1, result_darts = ?
    WHERE player_id = ? AND challenge_date = ? AND completed = 0
  `).run(resultDarts != null ? Number(resultDarts) : null, p.id, String(challengeDate));
  if (info.changes === 0) {
    // Distinguish "no attempt started for that date" (a genuine 404) from "already
    // completed" (locked in — return the no-op result rather than erroring, so a
    // network retry of a legit completion doesn't surface as a user-visible failure).
    const existing = db.prepare(`SELECT completed FROM daily_challenge_attempts WHERE player_id = ? AND challenge_date = ?`).get(p.id, String(challengeDate));
    if (!existing) throw httpError(404, 'No matching challenge attempt for that date');
    return { ok: true, isPersonalBest: false, alreadyCompleted: true };
  }

  // "Beat your best" callout: compare this result against every other completed
  // attempt of the same format (excluding today, since UNIQUE(player_id,
  // challenge_date) means today's row is already the one we just wrote above).
  const row = db.prepare(`SELECT format, result_darts FROM daily_challenge_attempts WHERE player_id = ? AND challenge_date = ?`).get(p.id, String(challengeDate));
  let isPersonalBest = false;
  const dir = row && CHALLENGE_BETTER_DIRECTION[row.format];
  if (dir && row.result_darts != null) {
    const agg = dir === 'asc' ? 'MIN' : 'MAX';
    const prior = db.prepare(`
      SELECT ${agg}(result_darts) AS v FROM daily_challenge_attempts
      WHERE player_id = ? AND format = ? AND completed = 1 AND challenge_date != ?
    `).get(p.id, row.format, String(challengeDate));
    const priorBest = prior ? prior.v : null;
    isPersonalBest = priorBest == null || (dir === 'asc' ? row.result_darts < priorBest : row.result_darts > priorBest);
  }
  return { ok: true, isPersonalBest };
}

// Admin reset (Settings → Daily Challenge): removes a player's attempt for a given
// date AND every stat recorded during it, so the player can retake that day's
// challenge with a clean slate. Deleting the linked games row does all the work —
// ON DELETE CASCADE removes the game's turns (and their darts), game_players,
// timeline_events, and the daily_challenge_attempts row itself (its game_id FK also
// cascades). Badges earned during the wiped attempt are intentionally NOT revoked —
// a badge celebrates something that physically happened at the board.
function resetChallengeAttempt(playerName, challengeDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(challengeDate))) throw httpError(400, 'date must be YYYY-MM-DD');
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');
  const attempt = db.prepare(`
    SELECT id, game_id FROM daily_challenge_attempts
    WHERE player_id = ? AND challenge_date = ?
  `).get(p.id, String(challengeDate));
  if (!attempt) throw httpError(404, 'No challenge attempt found for that player and date');
  db.prepare('DELETE FROM games WHERE id = ?').run(attempt.game_id);
  // Belt and braces: if the games row was somehow already gone (it shouldn't be —
  // each attempt owns exactly one game), remove the attempt row directly so the
  // reset still unlocks a retake.
  db.prepare('DELETE FROM daily_challenge_attempts WHERE id = ?').run(attempt.id);
  return { ok: true };
}

// Today's attempt (if any) plus the current streak (consecutive calendar dates,
// counting back from today, with a completed attempt — a missed or DNF day breaks it).
function getChallengeStatus(playerName, todayDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(todayDate))) throw httpError(400, 'date must be YYYY-MM-DD');
  const p = getPlayer(playerName);
  if (!p) return { today: null, streak: 0, history: [] };
  const today = db.prepare(`
    SELECT format, target, completed, result_darts FROM daily_challenge_attempts
    WHERE player_id = ? AND challenge_date = ?
  `).get(p.id, todayDate) || null;

  const history = db.prepare(`
    SELECT challenge_date, format, target, completed, result_darts
    FROM daily_challenge_attempts
    WHERE player_id = ? AND challenge_date <= ?
    ORDER BY challenge_date DESC LIMIT 7
  `).all(p.id, todayDate);

  // Streak needs its own (much longer) lookback — the 7-row `history` above is only
  // for the display strip and would silently cap a real streak at 7 if reused here.
  const streakRows = db.prepare(`
    SELECT challenge_date, completed FROM daily_challenge_attempts
    WHERE player_id = ? AND challenge_date <= ?
    ORDER BY challenge_date DESC LIMIT 400
  `).all(p.id, todayDate);

  // Streak: walk back day by day, stopping at the first gap or DNF. Today not
  // having been attempted yet doesn't break a real streak on its own — the day
  // isn't over yet — so counting starts from yesterday in that case instead.
  // An ATTEMPTED-but-uncompleted today gets no such grace (REFERENCE.md §6: the
  // walk "stops at the first missing date or DNF") — the walk starts at today,
  // hits the incomplete row, and reports 0. Note completed=0 also describes an
  // attempt still in progress, so the streak reads 0 mid-attempt until the
  // completion lands — the day's attempt is spent either way.
  const byDate = new Map(streakRows.map(h => [h.challenge_date, h]));
  const cursor = new Date(todayDate + 'T00:00:00Z');
  if (!today) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let streak = 0;
  for (;;) {
    const key = cursor.toISOString().slice(0, 10);
    const row = byDate.get(key);
    if (!row || !row.completed) break;
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return { today, streak, history };
}

// Full lifetime Daily Challenge history for a player's profile
// (docs/daily-challenge-roadmap.md "Player Profile: Daily Challenge history"):
// completion record (Wordle-stats-style: played, completed, current streak,
// longest-ever streak), best result per format (six separate personal-best lines,
// not one combined number — mirrors how Personal Bests already separates unrelated
// metrics like Best Leg Average from Fewest Darts to Finish), and the full
// attempt-by-attempt log. Current streak is delegated to getChallengeStatus() (not
// re-derived) per the roadmap doc's explicit instruction; longest-ever streak is
// the same day-by-day walk without stopping at the first gap.
function getChallengeHistory(playerName, todayDate) {
  const p = getPlayer(playerName);
  if (!p) return { played: 0, completed: 0, currentStreak: 0, longestStreak: 0, bestByFormat: {}, attempts: [] };

  const totals = db.prepare(`
    SELECT COUNT(*) AS played, SUM(completed) AS completedCount
    FROM daily_challenge_attempts WHERE player_id = ?
  `).get(p.id);

  const allDates = db.prepare(`
    SELECT challenge_date, completed FROM daily_challenge_attempts
    WHERE player_id = ? ORDER BY challenge_date ASC
  `).all(p.id);
  let longestStreak = 0, run = 0, prevDate = null;
  for (const row of allDates) {
    if (!row.completed) { run = 0; prevDate = null; continue; }
    if (prevDate) {
      const dayGap = Math.round((new Date(row.challenge_date + 'T00:00:00Z') - new Date(prevDate + 'T00:00:00Z')) / 86400000);
      run = dayGap === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    longestStreak = Math.max(longestStreak, run);
    prevDate = row.challenge_date;
  }

  const currentStreak = /^\d{4}-\d{2}-\d{2}$/.test(String(todayDate)) ? getChallengeStatus(playerName, todayDate).streak : 0;

  const bestByFormat = {};
  for (const row of db.prepare(`
    SELECT format, result_darts FROM daily_challenge_attempts
    WHERE player_id = ? AND completed = 1 AND result_darts IS NOT NULL
  `).all(p.id)) {
    const dir = CHALLENGE_BETTER_DIRECTION[row.format];
    if (!dir) continue;
    const cur = bestByFormat[row.format];
    if (cur == null || (dir === 'asc' ? row.result_darts < cur : row.result_darts > cur)) {
      bestByFormat[row.format] = row.result_darts;
    }
  }

  const attempts = db.prepare(`
    SELECT challenge_date, format, target, completed, result_darts
    FROM daily_challenge_attempts WHERE player_id = ?
    ORDER BY challenge_date DESC LIMIT 400
  `).all(p.id);

  return { played: totals.played || 0, completed: totals.completedCount || 0, currentStreak, longestStreak, bestByFormat, attempts };
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
      AND g.player_count > 1
    GROUP BY t.player_id, g.category
  `).all();

  const gms = db.prepare(`
    SELECT gp.player_id AS pid, g.category AS cat, COUNT(*) AS games
    FROM game_players gp JOIN games g ON g.id = gp.game_id
    WHERE g.completed_at IS NOT NULL AND g.practice = 0
      AND g.player_count > 1
    GROUP BY gp.player_id, g.category
  `).all();

  // A won leg is signaled by checkout=1 in X01 but leg_won=1 in Cricket (which has
  // no checkout concept) — count both, or a profile's per-category H2H record shows
  // cricket wins as "N games · 0 sets · 0 legs".
  const h2hLegs = db.prepare(`
    SELECT t.player_id AS pid, g.category AS cat, COUNT(*) AS legs
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE (t.checkout = 1 OR t.leg_won = 1) AND g.practice = 0
      AND g.player_count > 1
    GROUP BY t.player_id, g.category
  `).all();

  const h2hSets = db.prepare(`
    SELECT player_id AS pid, category AS cat, COUNT(*) AS sets
    FROM (
      SELECT t.player_id, g.category
      FROM turns t JOIN games g ON g.id = t.game_id
      WHERE (t.checkout = 1 OR t.leg_won = 1) AND g.practice = 0
        AND g.player_count > 1
      GROUP BY t.game_id, t.player_id, g.category, t.set_no
      HAVING COUNT(*) >= g.legs_per_set
    )
    GROUP BY player_id, category
  `).all();

  const h2hGames = db.prepare(`
    SELECT g.winner_id AS pid, g.category AS cat, COUNT(*) AS games
    FROM games g
    WHERE g.completed_at IS NOT NULL AND g.winner_id IS NOT NULL AND g.practice = 0
      AND g.player_count > 1
    GROUP BY g.winner_id, g.category
  `).all();

  // Practice = explicit practice flag OR solo (1-player) games. Excludes Just
  // Chuckin' It, Checkout Trainer, and guided Around the World
  // (NOT_CONTINUOUS_STREAM) — their darts count toward the global dartsThrown
  // total below but not toward this per-category legs breakdown, since none of
  // them has a real leg boundary (or, for Checkout Trainer, a real dart at all).
  const practiceLegs = db.prepare(`
    SELECT t.player_id AS pid, g.category AS cat,
           COUNT(DISTINCT t.game_id || '-' || t.set_no || '-' || t.leg_no) AS legs
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE (g.practice = 1
      OR g.player_count = 1) ${NOT_CONTINUOUS_STREAM}
    GROUP BY t.player_id, g.category
  `).all();

  // Average actual darts per won leg — COUNT(darts) replaces the removed darts_thrown column
  const h2hAvgDarts = db.prepare(`
    SELECT pid, AVG(leg_darts) AS avg_darts FROM (
      SELECT t.player_id AS pid, COUNT(d.id) AS leg_darts
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.practice=0 AND g.player_count>1
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no HAVING SUM(t.checkout)>0
    ) GROUP BY pid
  `).all();

  // NOT_CHECKOUT_TRAINER: unlike h2hAvgDarts above (never matches — Checkout
  // Trainer is always solo/practice, never player_count>1), this practice-side
  // query WOULD otherwise pick up Checkout Trainer's own "legs" (single-dart-
  // to-multi-dart rounds that set checkout=1 for a legal attempt).
  const practiceAvgDarts = db.prepare(`
    SELECT pid, AVG(leg_darts) AS avg_darts FROM (
      SELECT t.player_id AS pid, COUNT(d.id) AS leg_darts
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE (g.practice=1 OR g.player_count=1) ${NOT_CHECKOUT_TRAINER}
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no HAVING SUM(t.checkout)>0
    ) GROUP BY pid
  `).all();

  // Nine-darters: 501 legs won in exactly 9 darts across 3 visits
  const nineDarterBase = (extraWhere) => db.prepare(`
    SELECT pid, COUNT(*) AS n FROM (
      SELECT t.player_id AS pid
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.game_type='x01' AND json_extract(g.config,'$.startingScore')=501 ${extraWhere}
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING COUNT(DISTINCT t.id)=3 AND SUM(t.checkout)>0 AND COUNT(d.id)=9
    ) GROUP BY pid
  `).all();

  const nd9All  = nineDarterBase('');
  const nd9H2H  = nineDarterBase("AND g.practice=0 AND g.player_count>1");
  const nd9Prac = nineDarterBase("AND (g.practice=1 OR g.player_count=1)");

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
    WHERE (${modeWhere}) ${X01_ONLY}
    GROUP BY t.player_id
  `).all();

  const h2hAgg  = _agg(`g.practice=0 AND g.player_count>1`);
  const pracAgg = _agg(`g.practice=1 OR g.player_count=1`);

  // Unscoped (all-game-type) turn/dart counts for display sites labeled "all-time"
  // (roster "N turns", profile "N turns thrown"). _agg above is X01_ONLY because it
  // feeds scored-derived math (averages, trebleless), but a cricket visit is a real
  // visit and a cricket dart a real dart — physical-throw counters include them
  // (REFERENCE.md §3's cricket-interaction table).
  const allCounts = db.prepare(`
    SELECT t.player_id AS pid, COUNT(*) AS turns, COALESCE(SUM(dt.cnt), 0) AS dartsThrown
    FROM turns t JOIN games g ON g.id = t.game_id
    LEFT JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dt ON dt.turn_id = t.id
    WHERE 1=1 ${NOT_CHECKOUT_TRAINER}
    GROUP BY t.player_id
  `).all();

  // Last played date and recent-form average (last 30 turns) per player — used on the roster page.
  // Excludes Checkout Trainer (NOT_CHECKOUT_TRAINER) — a session of proposed
  // checkouts is not "playing darts" for this purpose, unlike every other
  // solo drill mode (Doubles Practice, Chuckin) which legitimately updates it.
  const lastPlayedRows = db.prepare(`
    SELECT t.player_id AS pid, MAX(t.created_at) AS ts
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE 1=1 ${NOT_CHECKOUT_TRAINER}
    GROUP BY t.player_id
  `).all();
  const recentAvgRows = db.prepare(`
    SELECT pid, CAST(SUM(scored) AS REAL)/NULLIF(SUM(dcount),0)*3 AS recentAvg FROM (
      SELECT t.player_id AS pid, t.scored,
             CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END AS dcount,
             ROW_NUMBER() OVER (PARTITION BY t.player_id ORDER BY t.id DESC) AS rn
      FROM turns t JOIN games g ON g.id=t.game_id
      LEFT JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dc ON dc.turn_id=t.id
      WHERE 1=1 ${X01_ONLY}
    ) WHERE rn <= 30 GROUP BY pid
  `).all();

  const lastPlayedById = {}; lastPlayedRows.forEach(r => lastPlayedById[r.pid] = r.ts);
  const recentAvgById  = {}; recentAvgRows.forEach(r  => recentAvgById[r.pid]  = r.recentAvg);
  const nd9AllById  = {}; nd9All.forEach(r  => nd9AllById[r.pid]  = r.n);
  const nd9H2HById  = {}; nd9H2H.forEach(r  => nd9H2HById[r.pid]  = r.n);
  const nd9PracById = {}; nd9Prac.forEach(r => nd9PracById[r.pid] = r.n);
  const allCountsById = {}; allCounts.forEach(r => allCountsById[r.pid] = r);
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
      // turns/dartsThrown are the unscoped "all-time" physical counts (cricket visits
      // and darts included); the X01-scoped equivalents that back the averages live
      // in h2hStats/practiceStats below.
      turns:       (allCountsById[p.id] && allCountsById[p.id].turns) || 0,
      totalPoints: (ha.total||0)       + (pa.total||0),
      trebleLess:  (ha.trebleLess||0)  + (pa.trebleLess||0),
      checkouts100:(ha.co100||0)       + (pa.co100||0),
      dartsThrown: (allCountsById[p.id] && allCountsById[p.id].dartsThrown) || 0,
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
  // "Games Played" is deliberately H2H matches only — practice, solo, and Daily
  // Challenge sessions do NOT count (product decision, see REFERENCE.md §3). The
  // explicit practice/player_count filter makes that intentional rather than an
  // accident of practice games never receiving completed_at: even if a future change
  // starts completing practice games (e.g. for "last game played"), this count stays
  // H2H-only.
  const games      = db.prepare('SELECT COUNT(*) AS n FROM games WHERE completed_at IS NOT NULL AND practice = 0 AND player_count > 1').get().n;
  const sets = db.prepare(`
    SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no) AS n
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE g.practice = 0
      AND g.player_count > 1
  `).get().n;
  const legs = db.prepare(`
    SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS n
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE g.practice = 0
      AND g.player_count > 1
  `).get().n;
  // Excludes Checkout Trainer (NOT_CHECKOUT_TRAINER) — unlike Chuckin, whose darts
  // are real physical throws and stay counted here, a Checkout Trainer dart never
  // touched a dartboard and must not inflate the global "darts thrown" total.
  const darts        = db.prepare(`SELECT COUNT(*) AS n FROM darts d JOIN turns t ON t.id = d.turn_id JOIN games g ON g.id = t.game_id WHERE 1=1 ${NOT_CHECKOUT_TRAINER}`).get().n ?? 0;
  const tonPlus      = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE checkout=1 AND checkout_points>=100').get().n;
  const oneEighties  = db.prepare(`SELECT COUNT(*) AS n FROM turns t JOIN games g ON g.id=t.game_id WHERE t.scored=180 ${X01_ONLY}`).get().n;
  const bigFish      = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE checkout=1 AND checkout_points=170').get().n;
  const nineDarters  = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT t.player_id FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.game_type='x01' AND json_extract(g.config,'$.startingScore')=501
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING COUNT(DISTINCT t.id)=3 AND SUM(t.checkout)>0 AND COUNT(d.id)=9
    )
  `).get().n;
  const practiceLegs = db.prepare(`
    SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS n
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE (g.practice = 1
      OR g.player_count = 1) ${NOT_CONTINUOUS_STREAM}
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
      AND g.player_count > 1
    GROUP BY p.id
    HAVING played >= 1
    ORDER BY won DESC, played ASC
  `).all();
  const winLeaderboard = winRows.map(r => ({
    name: r.name, played: r.played, won: r.won,
    rate: r.played ? +((r.won / r.played) * 100).toFixed(1) : 0
  }));

  const H2H_WHERE = `(g.practice = 0 AND g.player_count > 1)`;
  const PRACTICE_WHERE = `(g.practice = 1 OR g.player_count = 1)`;

  // "Fewest Trebleless Visits" leaderboard — ranked ascending on purpose: a
  // trebleless visit is a visit that failed to find a treble, so FEWER is better
  // and rank #1 goes to the player with the lowest trebleless rate.
  const _trebleLess = (modeWhere) => db.prepare(`
    SELECT p.name AS name, COUNT(*) AS turns,
      SUM(CASE WHEN dt.trebles = 0 THEN 1 ELSE 0 END) AS trebleLess
    FROM turns t
    JOIN players p ON p.id = t.player_id
    JOIN games g ON g.id = t.game_id
    LEFT JOIN (SELECT turn_id, SUM(is_treble) AS trebles FROM darts GROUP BY turn_id) dt ON dt.turn_id = t.id
    WHERE ${modeWhere} ${X01_ONLY}
    GROUP BY p.id
    HAVING turns >= 10
    ORDER BY (CAST(trebleLess AS REAL) / turns) ASC
  `).all().map(r => ({ name: r.name, turns: r.turns, trebleLess: r.trebleLess,
    rate: r.turns ? +((r.trebleLess / r.turns) * 100).toFixed(1) : 0 }));
  const trebleLessRows = { h2h: _trebleLess(H2H_WHERE), practice: _trebleLess(PRACTICE_WHERE) };

  // NOT_CHECKOUT_TRAINER: checkout_points always being null for Checkout Trainer
  // rows already protects the tonPlus numerator, but the `checkouts` denominator
  // (COUNT(*), no checkout_points requirement) would otherwise still count its
  // legal/optimal attempts, silently diluting a player's Ton+ Finish Rate.
  const _tonPlus = (modeWhere) => db.prepare(`
    SELECT p.name AS name,
      COUNT(*) AS checkouts,
      SUM(CASE WHEN t.checkout_points >= 100 THEN 1 ELSE 0 END) AS tonPlus
    FROM turns t
    JOIN players p ON p.id = t.player_id
    JOIN games g ON g.id = t.game_id
    WHERE t.checkout = 1 AND ${modeWhere} ${NOT_CHECKOUT_TRAINER}
    GROUP BY p.id
    HAVING checkouts >= 3
    ORDER BY (CAST(tonPlus AS REAL) / checkouts) DESC
  `).all().map(r => ({ name: r.name, checkouts: r.checkouts, tonPlus: r.tonPlus,
    rate: r.checkouts ? +((r.tonPlus / r.checkouts) * 100).toFixed(1) : 0 }));
  const tonPlusRows = { h2h: _tonPlus(H2H_WHERE), practice: _tonPlus(PRACTICE_WHERE) };

  const _highestCheckout = (modeWhere) => db.prepare(`
    SELECT p.name AS name, t.checkout_points AS points, t.created_at AS createdAt
    FROM turns t JOIN players p ON p.id = t.player_id
    JOIN games g ON g.id = t.game_id
    WHERE t.checkout = 1 AND t.checkout_points IS NOT NULL AND ${modeWhere}
    ORDER BY t.checkout_points DESC, t.created_at ASC
    LIMIT 1
  `).get() || null;
  const highestCheckout = {
    overall: db.prepare(`
      SELECT p.name AS name, t.checkout_points AS points, t.created_at AS createdAt
      FROM turns t JOIN players p ON p.id = t.player_id
      WHERE t.checkout = 1 AND t.checkout_points IS NOT NULL
      ORDER BY t.checkout_points DESC, t.created_at ASC
      LIMIT 1
    `).get() || null,
    h2h: _highestCheckout(H2H_WHERE),
    practice: _highestCheckout(PRACTICE_WHERE)
  };

  const lastGame = db.prepare(`
    SELECT g.id, g.category, g.completed_at AS completedAt, w.name AS winnerName,
      (SELECT GROUP_CONCAT(p2.name, ', ') FROM game_players gp2 JOIN players p2 ON p2.id = gp2.player_id WHERE gp2.game_id = g.id) AS players
    FROM games g LEFT JOIN players w ON w.id = g.winner_id
    WHERE g.completed_at IS NOT NULL
    ORDER BY g.completed_at DESC
    LIMIT 1
  `).get() || null;

  // legs/darts "activity" counts — legs excludes Just Chuckin' It, Checkout
  // Trainer, and guided Around the World (NOT_CONTINUOUS_STREAM, joins games for
  // the first time here to apply it); darts excludes Checkout Trainer only
  // (NOT_CHECKOUT_TRAINER) — chuckin/guided-World darts are real physical throws
  // and stay counted here, but a Checkout Trainer dart never touched a board at all.
  const todayLegs = db.prepare(`
    SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS n
    FROM turns t JOIN games g ON g.id = t.game_id WHERE date(t.created_at) = date('now') ${NOT_CONTINUOUS_STREAM}
  `).get().n;
  const todayDarts = db.prepare(`
    SELECT COUNT(*) AS n FROM darts d JOIN turns t ON t.id = d.turn_id JOIN games g ON g.id = t.game_id
    WHERE date(t.created_at) = date('now') ${NOT_CHECKOUT_TRAINER}
  `).get().n;
  const weekLegs = db.prepare(`
    SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS n
    FROM turns t JOIN games g ON g.id = t.game_id WHERE date(t.created_at) >= date('now', '-6 days') ${NOT_CONTINUOUS_STREAM}
  `).get().n;
  const weekDarts = db.prepare(`
    SELECT COUNT(*) AS n FROM darts d JOIN turns t ON t.id = d.turn_id JOIN games g ON g.id = t.game_id
    WHERE date(t.created_at) >= date('now', '-6 days') ${NOT_CHECKOUT_TRAINER}
  `).get().n;

  // Pace: avg ms between consecutive thrown_at timestamps within the same turn -> darts/min.
  // Excludes Just Chuckin' It, Checkout Trainer, and guided Around the World
  // (NOT_CONTINUOUS_STREAM) — all are rapid-fire per-dart-only rhythms (no scoring
  // pauses, no walking to collect between legs the way a real match has), or in
  // Checkout Trainer's case not real darts at all, that would skew this as a
  // measure of match-throwing pace.
  const _pace = (modeWhere) => {
    const row = db.prepare(`
      SELECT AVG(gap_ms) AS avgMs FROM (
        SELECT (julianday(d.thrown_at) - julianday(prev.thrown_at)) * 86400000 AS gap_ms
        FROM darts d
        JOIN darts prev ON prev.turn_id = d.turn_id AND prev.dart_no = d.dart_no - 1
        JOIN turns t ON t.id = d.turn_id
        JOIN games g ON g.id = t.game_id
        WHERE d.thrown_at IS NOT NULL AND prev.thrown_at IS NOT NULL AND ${modeWhere} ${NOT_CONTINUOUS_STREAM}
      ) WHERE gap_ms > 0 AND gap_ms < 60000
    `).get();
    if (!row || !row.avgMs) return null;
    return +(60000 / row.avgMs).toFixed(2);
  };
  const pace = {
    h2h: _pace(H2H_WHERE),
    practice: _pace(PRACTICE_WHERE)
  };

  // docs/league-mode-roadmap.md: a small Home-page teaser ("N active leagues, view
  // standings") piggybacks on this existing payload rather than a new endpoint —
  // just the id/name, not full standings (the Leagues screen fetches those itself).
  const activeLeagues = db.prepare(`SELECT id, name FROM leagues WHERE status = 'active' ORDER BY created_at DESC`).all();

  return { winLeaderboard, trebleLessRows, tonPlusRows, highestCheckout, lastGame,
    today: { legs: todayLegs, darts: todayDarts }, week: { legs: weekLegs, darts: weekDarts }, pace,
    activeLeagues };
}

function getPlayerStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const mf = _mf(mode);
  const q = (sql) => { const r = db.prepare(sql).get(p.id); return r ? r.v : null; };
  const J = `FROM turns t JOIN games g ON g.id = t.game_id WHERE t.player_id = ?`;

  // NOT_CHECKOUT_TRAINER: every JD-based figure below is a genuine "darts
  // physically thrown" count (darts thrown, darts/day, darts/leg) — a Checkout
  // Trainer dart never touches a board, so it must never inflate any of them.
  const JD = `FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id = ? ${NOT_CHECKOUT_TRAINER}`;
  const qd = (sql) => { const r = db.prepare(sql).get(p.id); return r ? r.v : null; };
  const dartsThrown    = qd(`SELECT COUNT(*) AS v ${JD} ${mf}`) ?? 0;
  const avgDartsPerDay = qd(`SELECT CAST(COUNT(*) AS REAL)/NULLIF(COUNT(DISTINCT date(t.created_at)),0) AS v ${JD} ${mf}`);
  const avgDartsPerLeg = qd(`SELECT AVG(leg_darts) AS v FROM (SELECT COUNT(d.id) AS leg_darts ${JD} ${mf} GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(t.checkout)>0)`);
  const legsWithOneEighty = q(`SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS v ${J} ${mf} ${X01_ONLY} AND t.scored=180`) ?? 0;
  // Standard 3-dart average: total points / counted darts * 3, where a bust counts
  // as a full 3-dart visit and a winning visit counts only the darts actually thrown.
  const avgDarts   = qd(`SELECT SUM(adj) AS v FROM (SELECT CASE WHEN t.bust=1 THEN 3 ELSE COUNT(d.id) END AS adj ${JD} ${mf} ${X01_ONLY} GROUP BY t.id)`) ?? 0;
  const totalPts   = q(`SELECT SUM(t.scored) AS v ${J} ${mf} ${X01_ONLY}`) ?? 0;
  const avg        = avgDarts > 0 ? (totalPts / avgDarts * 3) : null;
  const one80s     = q(`SELECT COUNT(*) AS v ${J} ${mf} ${X01_ONLY} AND t.scored=180`) ?? 0;
  const bigFish    = q(`SELECT COUNT(*) AS v ${J} ${mf} AND t.checkout=1 AND t.checkout_points=170`) ?? 0;
  const nineDarters= qd(`SELECT COUNT(*) AS v FROM (SELECT 1 ${JD} ${mf} AND g.game_type='x01' AND json_extract(g.config,'$.startingScore')=501 GROUP BY t.game_id,t.set_no,t.leg_no HAVING COUNT(DISTINCT t.id)=3 AND SUM(t.checkout)>0 AND COUNT(d.id)=9)`) ?? 0;
  // totalLegs is only ever a denominator for the X01 leg stats below (trebleless %,
  // 180s/leg) — X01-scoped so a cricket leg can't dilute either.
  const totalLegs  = q(`SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS v ${J} ${mf} ${X01_ONLY}`) ?? 0;
  // tlLegs: legs where no dart was a treble
  const tlLegs     = qd(`SELECT COUNT(*) AS v FROM (SELECT t.game_id,t.set_no,t.leg_no ${JD} ${mf} ${X01_ONLY} GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(d.is_treble)=0)`) ?? 0;

  // first3avg / first9avg / score140pct ("opening exchanges" stats) are scoped to
  // exactly the 4 standard X01 starting scores (501/301/170/101) — never any other
  // game type, and never a non-standard/custom X01 starting score — per an explicit
  // product decision (2026-07): these three-and-nine-dart-average stats count for
  // 501/301/170/101 only, ever, unless a future change explicitly says otherwise.
  // Checks game_type (not just category, which is only a human-readable label) plus
  // the actual numeric startingScore from config, matching the same robust pattern
  // getNineDarterStats()/getSummary() already use for their own 501-only scoping —
  // stronger than a bare category-string match, which a future game type could
  // coincidentally collide with. Daily Challenge's non-scoring formats (Bullseye
  // Gauntlet, Steady Hand, Treble Run) use a filler 1000 starting score, already
  // excluded by this same numeric check.
  const OPENING_CATS = `AND g.game_type='x01' AND json_extract(g.config,'$.startingScore') IN (501,301,170,101)`;

  // first3avg: turn-level score of the leg's first visit. t.scored is already 0 for
  // a busted visit — the previous version summed raw per-dart points instead, which
  // wrongly counted a busted opening visit's attempted score as if it had counted.
  const first3avg = db.prepare(`
    SELECT AVG(CAST(scored AS REAL)) AS v FROM (
      SELECT t.scored, ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
      ${J} ${mf} ${OPENING_CATS}
    ) WHERE rn = 1
  `).get(p.id)?.v ?? null;

  // first9avg: 3-dart-average-equivalent over the leg's first up-to-3 visits. Uses
  // t.scored (bust-zeroed) for points and the same "bust counts as 3 darts"
  // convention used everywhere else (avgDarts, etc.) for the denominator — a bust
  // ends the visit early (fewer darts recorded), but still uses up a full visit.
  const first9avg = db.prepare(`
    SELECT AVG(CAST(total_scored AS REAL) / NULLIF(dart_count,0) * 3) AS v FROM (
      SELECT SUM(t.scored) AS total_scored,
             SUM(CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END) AS dart_count
      FROM (SELECT t.id, t.game_id, t.set_no, t.leg_no, t.scored, t.bust,
                   ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
            ${J} ${mf} ${OPENING_CATS}) t
      LEFT JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dc ON dc.turn_id = t.id
      WHERE t.rn <= 3
      GROUP BY t.game_id, t.set_no, t.leg_no
    )
  `).get(p.id)?.v ?? null;

  // avg100plus and avg90minus share the same subquery — compute in one pass
  const _legAvgs = db.prepare(`SELECT CAST(SUM(t.scored) AS REAL)/COUNT(*) AS la ${J} ${mf} ${X01_ONLY} GROUP BY t.game_id,t.set_no,t.leg_no`).all(p.id);
  const _legAvgCount = _legAvgs.length || 0;
  const avg100plus = _legAvgCount ? _legAvgs.filter(r=>r.la>=100).length * 100 / _legAvgCount : null;
  const avg90minus = _legAvgCount ? _legAvgs.filter(r=>r.la<=90).length  * 100 / _legAvgCount : null;
  // Same "opening visit" shape as first3avg above, so it needs the same OPENING_CATS
  // scoping — a Daily Challenge filler-category leg (or a 170 leg) isn't a real X01
  // opening exchange and shouldn't count toward this stat.
  const score140pct = q(`SELECT CAST(SUM(CASE WHEN scored>=140 THEN 1 ELSE 0 END) AS REAL)*100/NULLIF(COUNT(*),0) AS v FROM (
    SELECT t.scored, ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
    ${J} ${mf} ${OPENING_CATS}
  ) WHERE rn=1`);

  // Average Pace (darts/minute) — same formula as getHomeExtra()'s pace and
  // getMetricHistory()'s 'pace' case: gaps between consecutive thrown_at timestamps
  // within a turn, clamped to plausible human timing. Null (bubble shows "—") until
  // "collect per-dart timing" has captured data. The pace STAT_DEF bubble on the
  // Player Profile reads this key — it was missing from this return object for a
  // while, leaving that bubble permanently blank even with timing data recorded.
  const pace = q(`SELECT 60000.0/AVG(gap_ms) AS v FROM (
    SELECT (julianday(d.thrown_at) - julianday(prev.thrown_at)) * 86400000 AS gap_ms
    FROM darts d
    JOIN darts prev ON prev.turn_id = d.turn_id AND prev.dart_no = d.dart_no - 1
    JOIN turns t ON t.id = d.turn_id JOIN games g ON g.id = t.game_id
    WHERE t.player_id = ? AND d.thrown_at IS NOT NULL AND prev.thrown_at IS NOT NULL ${mf}
  ) WHERE gap_ms > 0 AND gap_ms < 60000`);

  return {
    dartsThrown, avgDartsPerDay, avgDartsPerLeg, avg, one80s, bigFish, nineDarters,
    treblelessPct: totalLegs > 0 ? (tlLegs / totalLegs * 100) : null,
    first3avg, first9avg, avg100plus, avg90minus, score140pct, pace,
    one80sPerLeg: totalLegs > 0 ? (legsWithOneEighty / totalLegs) : null,
  };
}

// A dart's marks toward Cricket's in-play numbers — a mark is the dart's multiplier
// (1/2/3) if its sector is one of this match's config.numbers, else 0. Used
// everywhere a Cricket formula needs "marks scored," derived at query time from
// darts+games.config rather than any persisted mark/closed state (matching the
// engine's own "nothing pre-aggregated" design, docs/game-modes-roadmap.md).
// Achieving SUM(...)=9 over exactly 3 darts (COUNT=3) necessarily means every dart
// hit an in-play number as a treble (3 is the per-dart maximum), so the 9-marks
// check below needs no separate "all in-play" condition.
const CRICKET_MARK_CASE = (d) => `CASE WHEN EXISTS (SELECT 1 FROM json_each(g.config,'$.numbers') je WHERE je.value=${d}.sector) THEN ${d}.multiplier ELSE 0 END`;

// Cricket's stat-bubble equivalents (game-modes-roadmap.md build-order step 3).
// Marks Per Round (MPR) is Cricket's direct analog of X01's 3-dart average: total
// marks scored / total rounds (turns) played — a miss-only turn still counts as a
// round, matching real MPR's definition. Everything here is scoped by
// g.game_type='cricket' instead of X01_ONLY, since turns.scored/marks mean
// something different per game type (see X01_ONLY's comment below).
function getCricketStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'cricket' });

  const rounds = db.prepare(`SELECT COUNT(*) AS v FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const marks  = db.prepare(`SELECT COALESCE(SUM(${CRICKET_MARK_CASE('d')}),0) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const mpr = rounds > 0 ? (marks / rounds) : null;

  // 9 marks in one visit — 3 darts, each a treble on an in-play number, the
  // maximum possible marks in a single visit (Cricket's 180 analog).
  const nineMarks = db.prepare(`
    SELECT COUNT(*) AS v FROM (
      SELECT t.id FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE t.player_id=? ${scope}
      GROUP BY t.id HAVING COUNT(d.id)=3 AND SUM(${CRICKET_MARK_CASE('d')})=9
    )
  `).get(p.id)?.v ?? 0;

  const gamesRow = db.prepare(`
    SELECT COUNT(*) AS played, SUM(CASE WHEN g.winner_id=? THEN 1 ELSE 0 END) AS won
    FROM game_players gp JOIN games g ON g.id=gp.game_id
    WHERE gp.player_id=? ${scope} AND g.completed_at IS NOT NULL
  `).get(p.id, p.id);
  const gamesPlayed = gamesRow?.played ?? 0;
  const winPct = gamesPlayed > 0 ? (gamesRow.won / gamesPlayed * 100) : null;

  const dartsThrown = db.prepare(`SELECT COUNT(*) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;

  const avgDartsPerLeg = db.prepare(`
    SELECT AVG(leg_darts) AS v FROM (
      SELECT COUNT(d.id) AS leg_darts
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE t.player_id=? ${scope}
      GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(t.leg_won)>0
    )
  `).get(p.id)?.v ?? null;

  return { mpr, nineMarks, winPct, gamesPlayed, dartsThrown, avgDartsPerLeg };
}

// Cricket leaderboard for the 9-marks achievement (see getCricketStatBubbles'
// nineMarks formula above) — same leaderboard+recent shape as getOneEightyStats.
function getCricketNineMarksStats(mode) {
  const scope = _scope({ mode, gameType: 'cricket' });
  const base = `
    SELECT t.id, t.player_id, t.created_at
    FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
    WHERE 1=1 ${scope}
    GROUP BY t.id HAVING COUNT(d.id)=3 AND SUM(${CRICKET_MARK_CASE('d')})=9
  `;
  const leaderboard = db.prepare(`SELECT p.name, COUNT(*) AS count FROM (${base}) x JOIN players p ON p.id=x.player_id GROUP BY x.player_id ORDER BY count DESC`).all();
  const recent      = db.prepare(`SELECT p.name, x.created_at FROM (${base}) x JOIN players p ON p.id=x.player_id ORDER BY x.created_at DESC LIMIT 10`).all();
  return { leaderboard, recent };
}

// Home page's Cricket leaderboards (game-modes-roadmap.md build-order step 4).
// Marks Per Round across every player, mirroring getCricketStatBubbles()'s mpr
// formula but grouped across all players at once instead of one name. A
// minimum-rounds floor (matching _trebleLess()'s HAVING turns>=10 convention)
// keeps a single lucky visit from topping the board.
function getCricketMprLeaderboard(mode) {
  const scope = _scope({ mode, gameType: 'cricket' });
  const rows = db.prepare(`
    SELECT p.name AS name, COUNT(DISTINCT t.id) AS rounds, SUM(${CRICKET_MARK_CASE('d')}) AS marks
    FROM turns t JOIN games g ON g.id=t.game_id JOIN players p ON p.id=t.player_id JOIN darts d ON d.turn_id=t.id
    WHERE 1=1 ${scope}
    GROUP BY t.player_id
    HAVING rounds >= 5
  `).all();
  return rows
    .map(r => ({ name: r.name, mpr: +(r.marks / r.rounds).toFixed(2), rounds: r.rounds }))
    .sort((a, b) => b.mpr - a.mpr);
}

// Cricket win leaderboard — same shape as getHomeExtra()'s winLeaderboard, just
// scoped to game_type='cricket'. H2H-only by nature (practice has no opponent
// to win against), so no mode param.
function getCricketWinLeaderboard() {
  const scope = _scope({ mode: 'h2h', gameType: 'cricket' });
  const winRows = db.prepare(`
    SELECT p.name AS name, COUNT(*) AS played, SUM(CASE WHEN g.winner_id = p.id THEN 1 ELSE 0 END) AS won
    FROM game_players gp
    JOIN players p ON p.id = gp.player_id
    JOIN games g ON g.id = gp.game_id
    WHERE g.completed_at IS NOT NULL ${scope}
    GROUP BY p.id
    HAVING played >= 1
    ORDER BY won DESC, played ASC
  `).all();
  return winRows.map(r => ({ name: r.name, played: r.played, won: r.won,
    rate: r.played ? +((r.won / r.played) * 100).toFixed(1) : 0 }));
}

// Cricket's nine-darter analog leaderboard — a won leg (turns.leg_won=1) whose
// total darts equal that match's theoretical minimum (each non-Bull number
// closes in a single treble; Bull can't be trebled, so it needs a 2-dart
// minimum — same logic as the Perfect Leg achievement in frontend/index.html's
// enterTurnCricket(), computed here in SQL instead of read from client state).
function getCricketPerfectLegStats(mode) {
  const scope = _scope({ mode, gameType: 'cricket' });
  const base = `
    SELECT t.player_id, MAX(t.created_at) AS created_at
    FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
    WHERE 1=1 ${scope}
    GROUP BY t.game_id, t.set_no, t.leg_no, t.player_id
    HAVING SUM(t.leg_won) > 0
      AND COUNT(d.id) = (
        (SELECT COUNT(*) FROM json_each(g.config,'$.numbers') je WHERE je.value != 25)
        + (CASE WHEN EXISTS (SELECT 1 FROM json_each(g.config,'$.numbers') je2 WHERE je2.value = 25) THEN 2 ELSE 0 END)
      )
  `;
  const leaderboard = db.prepare(`SELECT p.name, COUNT(*) AS count FROM (${base}) x JOIN players p ON p.id=x.player_id GROUP BY x.player_id ORDER BY count DESC`).all();
  const recent      = db.prepare(`SELECT p.name, x.created_at FROM (${base}) x JOIN players p ON p.id=x.player_id ORDER BY x.created_at DESC LIMIT 10`).all();
  return { leaderboard, recent };
}

// Personal-best / "tracking improvement" markers for the player page: best single-leg
// average, fewest darts to finish a leg, current H2H win streak, and recent-form (last
// 10 completed legs) average vs lifetime average.
function getPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const mf = _mf(mode);

  // NOT_CHECKOUT_TRAINER: t.checkout=1 is only ever set by X01 and Checkout
  // Trainer (Cricket/Doubles Practice/Chuckin all leave it false, so they're
  // already excluded by the HAVING clause below) — a proposed-route "checkout"
  // is not a real leg and must not surface as a Personal Best here, nor drag
  // down bestLegAvg/recentFormAvg/lifetimeAvg or shrink fewestDartsCheckout.
  const legAvgSql = `
    SELECT t.game_id, t.set_no, t.leg_no, MAX(t.id) AS lastTurnId,
      CAST(SUM(t.scored) AS REAL)/NULLIF(SUM(CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END),0)*3 AS la
    FROM turns t JOIN games g ON g.id=t.game_id
    JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dc ON dc.turn_id=t.id
    WHERE t.player_id=? ${mf} ${NOT_CHECKOUT_TRAINER}
    GROUP BY t.game_id,t.set_no,t.leg_no
    HAVING SUM(t.checkout)>0
  `;
  const legs = db.prepare(legAvgSql).all(p.id);
  const bestLegRow = legs.length ? legs.reduce((best, r) => r.la > best.la ? r : best) : null;
  const bestLegAvg = bestLegRow ? bestLegRow.la : null;
  const bestLeg = bestLegRow ? { gameId: bestLegRow.game_id, setNo: bestLegRow.set_no, legNo: bestLegRow.leg_no } : null;

  const fewestDartsCheckout = db.prepare(`
    SELECT MIN(leg_darts) AS v FROM (
      SELECT COUNT(d.id) AS leg_darts
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE t.player_id=? ${mf} ${NOT_CHECKOUT_TRAINER}
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
        AND g.player_count > 1
      ORDER BY g.completed_at DESC
      LIMIT 50
    `).all(p.id);
    for (const r of recentGames) {
      if (r.winnerId === p.id) winStreak++; else break;
    }
  }

  return { bestLegAvg, bestLeg, fewestDartsCheckout, winStreak, recentFormAvg, lifetimeAvg };
}

// Ghost Opponent (docs/archive/ghost-opponent-roadmap.md): pick one of your own past won
// X01 legs to replay dart-by-dart as a virtual second player. Deliberately X01-only
// for v1 — Cricket's leg_won signal would need its own MPR-based candidate/script
// queries, deferred until Cricket ghost support is actually requested.
//
// Browsable list of past legs this player won, most recent first — the "browsable
// list" alternative to picking straight from Personal Bests' best-leg-average entry.
function getGhostCandidateLegs(playerName, limit) {
  const p = getPlayer(playerName);
  if (!p) return [];
  const lim = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
  // Ties on `date` (created_at only has second-level resolution — plausible within
  // one fast-inserted test or a quick real session) break on MAX(t.id) DESC, the
  // same "force a deterministic newest-first order" fix winStreak's own tie case
  // already needed (db.x01-stats.test.js).
  return db.prepare(`
    SELECT t.game_id AS gameId, t.set_no AS setNo, t.leg_no AS legNo,
           MAX(t.created_at) AS date, MAX(t.id) AS lastTurnId, g.category AS category, g.practice AS practice,
           CAST(SUM(t.scored) AS REAL)/NULLIF(SUM(CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END),0)*3 AS avg,
           SUM(dc.cnt) AS darts
    FROM turns t
    JOIN games g ON g.id = t.game_id
    JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dc ON dc.turn_id = t.id
    WHERE t.player_id = ? AND g.game_type = 'x01'
    GROUP BY t.game_id, t.set_no, t.leg_no
    HAVING SUM(t.checkout) > 0
    ORDER BY date DESC, lastTurnId DESC
    LIMIT ?
  `).all(p.id, lim).map(({ lastTurnId, ...r }) => r);
}

// The ordered turn-by-turn, dart-by-dart script for one specific past leg — the
// ghost's fixed replay. Scoped to playerName + a "this player actually won this
// leg" check so a ghost can only ever be built from a leg the requester genuinely
// played and won themselves ("one of your own past legs", per the roadmap doc).
function getGhostLegScript(gameId, setNo, legNo, playerName) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const game = db.prepare('SELECT id, category, game_type, config FROM games WHERE id = ?').get(Number(gameId));
  if (!game || game.game_type !== 'x01') return null;
  // out_mode is that historical leg's actual double/single-out rule — the replay
  // must reuse it (not whatever the new race happens to be configured with),
  // otherwise re-evaluating the ghost's scripted darts against the wrong rule
  // could turn a historical win into a bust (or vice versa).
  const outMode = db.prepare('SELECT out_mode AS outMode FROM game_players WHERE game_id = ? AND player_id = ?')
    .get(Number(gameId), p.id)?.outMode || 'double';
  const turns = db.prepare(`
    SELECT id, scored, bust, checkout, checkout_points AS checkoutPoints
    FROM turns
    WHERE game_id = ? AND set_no = ? AND leg_no = ? AND player_id = ?
    ORDER BY id
  `).all(Number(gameId), Number(setNo), Number(legNo), p.id);
  if (!turns.length || !turns.some(t => t.checkout)) return null;
  const dartStmt = db.prepare('SELECT sector, multiplier FROM darts WHERE turn_id = ? ORDER BY dart_no');
  const scriptTurns = turns.map(t => ({
    scored: t.scored, bust: !!t.bust, checkout: !!t.checkout, checkoutPoints: t.checkoutPoints,
    darts: dartStmt.all(t.id).map(d => ({ sector: d.sector, multiplier: d.multiplier })),
  }));
  return { category: game.category, config: JSON.parse(game.config), outMode, turns: scriptTurns };
}

// Ghost race win/loss tracking (docs/archive/ghost-opponent-roadmap.md). Result is always
// from the human's perspective — the client computes it (whichever side's turn
// triggered onLegWon() first), since the ghost is never a real players/game_players
// row for the server to determine a winner from independently. Re-validates the
// source leg the same way getGhostLegScript() does (game exists, is X01, and this
// player actually won that leg) so a hostile client can't fabricate a fake "win"
// history by claiming a leg it never won.
//
// A human win also checks the Ghost Slayer badge (docs/archive/ghost-opponent-roadmap.md's
// "Ghost race badges" section) right here at the write path, rather than via a
// separate scan — awardBadge()'s `once` mode is already idempotent (INSERT OR
// IGNORE), so calling it on every win and reporting its `newlyEarned` flag back to
// the caller is sufficient to fire the celebration only on the player's first ever
// ghost-race win.
function recordGhostRace(playerName, { gameId, sourceGameId, sourceSetNo, sourceLegNo, result, humanDarts, ghostDarts }) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');
  if (result !== 'win' && result !== 'loss') throw httpError(400, "result must be 'win' or 'loss'");
  const gid = Number(gameId);
  const raceGame = db.prepare('SELECT id FROM games WHERE id = ?').get(gid);
  if (!raceGame) throw httpError(404, 'Game not found');
  if (!db.prepare('SELECT 1 FROM game_players WHERE game_id = ? AND player_id = ?').get(gid, p.id)) {
    throw httpError(400, 'That player did not play in that game');
  }
  if (!getGhostLegScript(sourceGameId, sourceSetNo, sourceLegNo, playerName)) {
    throw httpError(400, 'Source leg not found, not X01, or not won by this player');
  }
  const hd = (humanDarts !== undefined && humanDarts !== null && humanDarts !== '') ? Number(humanDarts) : null;
  const gd = (ghostDarts !== undefined && ghostDarts !== null && ghostDarts !== '') ? Number(ghostDarts) : null;
  const info = db.prepare(`
    INSERT INTO ghost_races (game_id, player_id, source_game_id, source_set_no, source_leg_no, result, human_darts, ghost_darts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(gid, p.id, Number(sourceGameId), Number(sourceSetNo), Number(sourceLegNo), result, hd, gd);
  const ghostSlayerNewlyEarned = result === 'win' ? awardBadge(playerName, 'ghost_slayer', true).newlyEarned : false;
  return { id: Number(info.lastInsertRowid), ghostSlayerNewlyEarned };
}

function getGhostRaceRecord(playerName) {
  const p = getPlayer(playerName);
  if (!p) return { wins: 0, losses: 0, totalRaces: 0 };
  const wins = db.prepare("SELECT COUNT(*) AS n FROM ghost_races WHERE player_id = ? AND result = 'win'").get(p.id).n;
  const losses = db.prepare("SELECT COUNT(*) AS n FROM ghost_races WHERE player_id = ? AND result = 'loss'").get(p.id).n;
  return { wins, losses, totalRaces: wins + losses };
}

// Cricket's Personal Bests — same 5-field shape as getPersonalBests() above, but
// keyed on turns.leg_won instead of turns.checkout (Cricket has no checkout
// mechanism, so it needs its own "this turn won the leg" signal — see the
// turns.leg_won column comment in the schema).
function getCricketPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'cricket' });

  const legRowsSql = `
    SELECT t.game_id, t.set_no, t.leg_no, MAX(t.id) AS lastTurnId,
      SUM(${CRICKET_MARK_CASE('d')}) AS marks, COUNT(DISTINCT t.id) AS rounds, COUNT(d.id) AS darts
    FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
    WHERE t.player_id=? ${scope}
    GROUP BY t.game_id, t.set_no, t.leg_no
    HAVING SUM(t.leg_won) > 0
  `;
  // mpr uses the same marks/rounds formula as getCricketStatBubbles' lifetime MPR,
  // just scoped to a single leg — keeps "MPR" meaning one consistent thing
  // everywhere it appears rather than two different scales.
  const legs = db.prepare(legRowsSql).all(p.id).map(r => ({ ...r, mpr: r.rounds > 0 ? r.marks / r.rounds : 0 }));
  const bestLegMpr = legs.length ? Math.max(...legs.map(r => r.mpr)) : null;
  const fewestDartsToClose = legs.length ? Math.min(...legs.map(r => r.darts)) : null;

  const recentLegs = legs.slice().sort((a, b) => b.lastTurnId - a.lastTurnId).slice(0, 10);
  const recentFormMpr = recentLegs.length ? recentLegs.reduce((s, r) => s + r.mpr, 0) / recentLegs.length : null;
  const lifetimeMpr = legs.length ? legs.reduce((s, r) => s + r.mpr, 0) / legs.length : null;

  let winStreak = 0;
  if (mode !== 'practice') {
    const h2hScope = _scope({ mode: 'h2h', gameType: 'cricket' });
    const recentGames = db.prepare(`
      SELECT g.winner_id AS winnerId
      FROM games g JOIN game_players gp ON gp.game_id=g.id
      WHERE gp.player_id=? AND g.completed_at IS NOT NULL ${h2hScope}
      ORDER BY g.completed_at DESC
      LIMIT 50
    `).all(p.id);
    for (const r of recentGames) {
      if (r.winnerId === p.id) winStreak++; else break;
    }
  }

  return { bestLegMpr, fewestDartsToClose, winStreak, recentFormMpr, lifetimeMpr };
}

/* ---------- Doubles Practice (docs/game-modes-roadmap.md) ----------
   Solo drill mode: no opponent, no win/loss, no legs won — a "round" is one
   turns.leg_no grouping (incremented client-side by startNextRoundDoublesPractice()
   every time evaluateDartDoublesPractice() ends it), spanning as many single-dart
   turns as were thrown before the ending dart. Every dart is its own turn
   (addTurn() already allows 1-3 darts per turn); a "hit" is a double landed on one
   of that game's own config.doubles targets — mirrors CRICKET_MARK_CASE's
   json_each join against config, just against a different config key and with a
   simpler 0/1 result (a mark can be worth up to 3; a "hit" is binary). */
const DOUBLES_HIT_CASE = (d) => `CASE WHEN ${d}.multiplier=2 AND EXISTS (SELECT 1 FROM json_each(g.config,'$.doubles') je WHERE je.value=${d}.sector) THEN 1 ELSE 0 END`;

function getDoublesPracticeStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'doubles_practice' });

  const dartsThrown = db.prepare(`SELECT COUNT(*) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const hits = db.prepare(`SELECT COALESCE(SUM(${DOUBLES_HIT_CASE('d')}),0) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const doublesPct = dartsThrown > 0 ? (hits / dartsThrown * 100) : null;

  const roundsPlayed = db.prepare(`
    SELECT COUNT(*) AS v FROM (
      SELECT 1 FROM turns t JOIN games g ON g.id=t.game_id
      WHERE t.player_id=? ${scope}
      GROUP BY t.game_id, t.set_no, t.leg_no
    )
  `).get(p.id)?.v ?? 0;
  const avgDartsPerRound = roundsPlayed > 0 ? (dartsThrown / roundsPlayed) : null;
  const avgHitsPerRound = roundsPlayed > 0 ? (hits / roundsPlayed) : null;

  return { doublesPct, avgDartsPerRound, avgHitsPerRound, roundsPlayed, dartsThrown };
}

// Personal Bests analog: "best round" records rather than X01/Cricket's win-
// gated leg bests, since a Doubles Practice round never "wins" — every round
// (however it ended) counts equally. No winStreak/recentForm/lifetime fields —
// those are all win- or leg-gated concepts that don't map onto a mode with no
// win condition; getDoublesPracticeStatBubbles()'s lifetime doublesPct already
// covers the "how am I doing overall" question this mode has an equivalent for.
function getDoublesPracticePersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'doubles_practice' });

  const rounds = db.prepare(`
    SELECT COUNT(d.id) AS darts, COALESCE(SUM(${DOUBLES_HIT_CASE('d')}),0) AS hits
    FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
    WHERE t.player_id=? ${scope}
    GROUP BY t.game_id, t.set_no, t.leg_no
  `).all(p.id);

  let bestRoundDarts = null, bestRoundHits = null;
  for (const r of rounds) {
    if (bestRoundDarts == null || r.darts > bestRoundDarts) bestRoundDarts = r.darts;
    if (bestRoundHits == null || r.hits > bestRoundHits) bestRoundHits = r.hits;
  }
  return { bestRoundDarts, bestRoundHits };
}

// Home page leaderboards for Doubles Practice (game-modes-roadmap.md, previously a
// known gap — deliberately deferred when the mode first shipped). No mode param on
// either function: this mode is always practice=1 (startGame() forces it via
// setup.practice, set whenever setup.mode !== 'h2h'), so an h2h/practice split would
// always leave the h2h side empty — same reasoning as getCricketWinLeaderboard()'s
// "H2H only by nature, no mode param" precedent, just the opposite polarity.

// Doubles % leaderboard across every player — direct structural analog of
// getCricketMprLeaderboard() (same minimum-rounds floor to keep one lucky round
// from topping the board), just ranking accuracy instead of a per-round average.
function getDoublesPracticeAccuracyLeaderboard() {
  const scope = _scope({ gameType: 'doubles_practice' });
  const rows = db.prepare(`
    SELECT p.name AS name, COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS rounds,
           COUNT(d.id) AS darts, SUM(${DOUBLES_HIT_CASE('d')}) AS hits
    FROM turns t JOIN games g ON g.id=t.game_id JOIN players p ON p.id=t.player_id JOIN darts d ON d.turn_id=t.id
    WHERE 1=1 ${scope}
    GROUP BY t.player_id
    HAVING rounds >= 5
  `).all();
  return rows
    .map(r => ({ name: r.name, pct: +(r.hits / r.darts * 100).toFixed(1), rounds: r.rounds }))
    .sort((a, b) => b.pct - a.pct);
}

// Best-single-round leaderboard — one row per player, their own best round (most
// hits; fewest darts breaks a tie), across every round they've ever played. Not a
// "leaderboard"/"recent" achievement-count shape like Cricket's 9 Marks/Perfect Leg,
// since a best round isn't a repeatable qualifying event — it's a record-book entry,
// structurally closer to getPersonalBests() extended across players than to an
// achievement tally.
function getDoublesPracticeBestRoundStats() {
  const scope = _scope({ gameType: 'doubles_practice' });
  const rows = db.prepare(`
    SELECT p.name AS name, COUNT(d.id) AS darts, SUM(${DOUBLES_HIT_CASE('d')}) AS hits,
           MAX(t.created_at) AS created_at
    FROM turns t JOIN games g ON g.id=t.game_id JOIN players p ON p.id=t.player_id JOIN darts d ON d.turn_id=t.id
    WHERE 1=1 ${scope}
    GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
  `).all();
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.name);
    if (!cur || r.hits > cur.hits || (r.hits === cur.hits && r.darts < cur.darts)) best.set(r.name, r);
  }
  return [...best.values()]
    .sort((a, b) => b.hits - a.hits || a.darts - b.darts)
    .map(r => ({ name: r.name, hits: r.hits, darts: r.darts, createdAt: r.created_at }));
}

/* ---------- Just Chuckin' It (game-modes-roadmap.md "Just Chuckin' It") ----------
   Freeform, completely unscored practice: every dart is its own 1-dart turn
   (mirrors Doubles Practice's per-dart-turn precedent — addTurn() already allows
   1-3 darts per turn), with no bust/win/checkout concept at all (turns.bust/
   checkout always 0/false, scored always 0 — none of them are repurposed the way
   Doubles Practice repurposes bust, since this mode has no round-ending condition
   to signal). A "session" is one games row; darts group into a single
   set_no=1/leg_no=1 for the whole session, since there's no round/leg boundary to
   increment at all (unlike Doubles Practice's per-round leg_no bump) — grouping by
   t.game_id alone is equivalent and clearer intent-wise. Deliberately the INVERSE
   of every other game-type addition: its darts must NOT count toward any existing
   stat (see NOT_HYPOTHETICAL_DARTS above) — the one exception, the pure "total darts thrown"
   counters, are already fully unscoped queries that need no change to include it. */

// Groups a player's chuckin darts into non-overlapping runs of 3, in throw
// order, *within each session* (a run never spans two different games) —
// the "assuming three darts per turn" convention requested for tracking 180s
// in a game type that otherwise has no turn/visit boundary at all. Shared by
// the `oneEighties` stat bubble below and (mirrored client-side in
// checkChuckinMilestones()'s sibling, throwDartChuckin()'s own rolling buffer)
// the live chuckin180 achievement check.
const CHUCKIN_GROUPS_OF_3 = (scope) => `
  SELECT SUM(val) AS grp_score, COUNT(*) AS grp_count FROM (
    SELECT d.sector * d.multiplier AS val, t.game_id AS game_id,
           (ROW_NUMBER() OVER (PARTITION BY t.game_id ORDER BY d.id) - 1) / 3 AS grp
    FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? ${scope}
  ) GROUP BY game_id, grp
`;

function getChuckinStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'chuckin' });

  const dartsThrown = db.prepare(`SELECT COUNT(*) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const trebles = db.prepare(`SELECT COALESCE(SUM(d.is_treble),0) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const bulls = db.prepare(`SELECT COUNT(*) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? AND d.sector=25 ${scope}`).get(p.id)?.v ?? 0;
  const doubles = db.prepare(`SELECT COALESCE(SUM(d.is_double),0) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const treblePct = dartsThrown > 0 ? (trebles / dartsThrown * 100) : null;
  const bullPct = dartsThrown > 0 ? (bulls / dartsThrown * 100) : null;
  const doublePct = dartsThrown > 0 ? (doubles / dartsThrown * 100) : null;

  const sessionsPlayed = db.prepare(`SELECT COUNT(DISTINCT t.game_id) AS v FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const avgDartsPerSession = sessionsPlayed > 0 ? (dartsThrown / sessionsPlayed) : null;

  // Standard 3-dart average (matches X01's own formula exactly): total score
  // across every dart thrown, scaled to a 3-dart-visit equivalent. Unlike
  // oneEighties below, this doesn't need the 3-dart grouping at all — it's
  // just points-per-dart * 3, so a trailing partial group still counts fully.
  const totalScore = db.prepare(`SELECT COALESCE(SUM(d.sector * d.multiplier),0) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const avg = dartsThrown > 0 ? (totalScore / dartsThrown * 3) : null;

  // 180s: every completed (exactly 3 darts) group above whose total is 180 —
  // only physically possible as three treble 20s, same as X01's 180.
  const oneEighties = db.prepare(`SELECT COUNT(*) AS v FROM (${CHUCKIN_GROUPS_OF_3(scope)} HAVING grp_count=3 AND grp_score=180)`).get(p.id)?.v ?? 0;

  return { dartsThrown, trebles, treblePct, bulls, bullPct, doubles, doublePct, sessionsPlayed, avgDartsPerSession, avg, oneEighties };
}

// Personal Bests analog: "best session" records (mirrors Doubles Practice's
// bestRoundDarts/bestRoundHits shape) — no winStreak/recentForm/lifetime fields,
// since a chuckin session never "wins"; getChuckinStatBubbles()'s lifetime
// treblePct already covers "how am I doing overall."
function getChuckinPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'chuckin' });

  const sessions = db.prepare(`
    SELECT COUNT(d.id) AS darts, COALESCE(SUM(d.is_treble),0) AS trebles
    FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
    WHERE t.player_id=? ${scope}
    GROUP BY t.game_id
  `).all(p.id);

  let bestSessionDarts = null, bestSessionTrebles = null;
  for (const s of sessions) {
    if (bestSessionDarts == null || s.darts > bestSessionDarts) bestSessionDarts = s.darts;
    if (bestSessionTrebles == null || s.trebles > bestSessionTrebles) bestSessionTrebles = s.trebles;
  }
  return { bestSessionDarts, bestSessionTrebles };
}

/* ---------- Checkout Trainer (docs/checkout-trainer-roadmap.md) ----------
   A pure mental-recall drill: every dart is its own 1-dart turn (same per-dart-
   turn shape Doubles Practice/Chuckin already established), graded by
   frontend/scoring.js's evaluateVisit()/checkoutHint() before it's ever written
   here — the three-way outcome (bust=1 "not legal" / checkout=1,leg_won=0
   "legal but not optimal" / checkout=1,leg_won=1 "legal and optimal") already
   exists on every turns row, so nothing new to store beyond target_score. Both
   sub-modes (Freeform, Checkout Blitz — distinguished by config.mode, not a
   separate game_type) share one game_type='checkout_trainer' and count toward
   these lifetime stats together — a round is a round regardless of which mode
   served it (docs/checkout-trainer-roadmap.md's explicit ruling).

   Unlike every other solo drill, a Checkout Trainer dart never touches a real
   dartboard at all — it's the app grading a proposed route, not a throw. Product
   decision: it must have zero footprint on any pre-existing stat, full stop —
   not just the heatmap/treble-rate/pace exclusions Chuckin's proposed-route-
   adjacent darts already get via NOT_HYPOTHETICAL_DARTS, but also the raw "total
   darts thrown"/"last played" counters that Chuckin (a real physical throw)
   deliberately keeps counting toward. See NOT_CHECKOUT_TRAINER, a narrower,
   Checkout-Trainer-only sibling of NOT_HYPOTHETICAL_DARTS applied at exactly
   those few spots. */
function getCheckoutTrainerStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'checkout_trainer' });

  const totalAttempts = db.prepare(`SELECT COUNT(*) AS v FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const legalCount = db.prepare(`SELECT COUNT(*) AS v FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? AND t.checkout=1 ${scope}`).get(p.id)?.v ?? 0;
  const optimalCount = db.prepare(`SELECT COUNT(*) AS v FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? AND t.leg_won=1 ${scope}`).get(p.id)?.v ?? 0;
  const accuracyPct = totalAttempts > 0 ? (legalCount / totalAttempts * 100) : null;
  const optimalPct = totalAttempts > 0 ? (optimalCount / totalAttempts * 100) : null;

  return { totalAttempts, legalCount, optimalCount, accuracyPct, optimalPct };
}

// Personal Bests analog: toughest checkout ever solved optimally (a single
// standout number, same "one record" shape bestLegAvg/bestRoundDarts already
// use) plus the best-ever optimal streak — walked from ordered turns and reset
// on any non-optimal result, the same "walk until broken" approach a win-streak
// is already computed elsewhere with, not a maintained counter.
function getCheckoutTrainerPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'checkout_trainer' });

  const toughestCheckout = db.prepare(`SELECT MAX(t.target_score) AS v FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? AND t.leg_won=1 ${scope}`).get(p.id)?.v ?? null;

  const rows = db.prepare(`SELECT t.leg_won AS legWon FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope} ORDER BY t.id`).all(p.id);
  let bestStreak = 0, current = 0;
  for (const r of rows) {
    if (r.legWon) { current += 1; if (current > bestStreak) bestStreak = current; }
    else current = 0;
  }

  return { toughestCheckout, bestStreak };
}

// Checkout Blitz's arcade-style high-score table — one row per player, their
// single best-ever 60-second run, ranked descending. A peak single-run value
// (structurally closest to "Highest Checkout"), so no minimum-attempts floor
// the rate-based leaderboards (Doubles Practice accuracy, Cricket MPR) use to
// guard against a lucky small sample. Score is computed at read time from the
// same SUM(2/1/0) formula Checkout Blitz's own scoring design specifies —
// nothing pre-aggregated, same philosophy as everywhere else in this schema.
function getCheckoutBlitzLeaderboard() {
  const rows = db.prepare(`
    SELECT g.id AS gameId, p.name AS name, MAX(t.created_at) AS achievedAt,
           COALESCE(SUM(CASE WHEN t.leg_won=1 THEN 2 WHEN t.checkout=1 THEN 1 ELSE 0 END),0) AS score
    FROM turns t JOIN games g ON g.id=t.game_id JOIN players p ON p.id=t.player_id
    WHERE g.game_type='checkout_trainer' AND json_extract(g.config,'$.mode')='blitz'
    GROUP BY g.id
  `).all();
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.name);
    if (!cur || r.score > cur.bestScore) best.set(r.name, { name: r.name, bestScore: r.score, achievedAt: r.achievedAt });
  }
  return Array.from(best.values()).sort((a, b) => b.bestScore - a.bestScore);
}

// That same player's own peak Blitz run plus a lifetime average across every
// run — same "peak plus lifetime average for context" shape getPersonalBests()
// already uses for bestLegAvg/lifetimeAvg.
function getCheckoutBlitzPersonalStats(playerName) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const rows = db.prepare(`
    SELECT g.id AS gameId,
           COALESCE(SUM(CASE WHEN t.leg_won=1 THEN 2 WHEN t.checkout=1 THEN 1 ELSE 0 END),0) AS score
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? AND g.game_type='checkout_trainer' AND json_extract(g.config,'$.mode')='blitz'
    GROUP BY g.id
  `).all(p.id);
  if (!rows.length) return { bestScore: null, lifetimeAvgScore: null, runs: 0 };
  const bestScore = Math.max(...rows.map(r => r.score));
  const lifetimeAvgScore = rows.reduce((s, r) => s + r.score, 0) / rows.length;
  return { bestScore, lifetimeAvgScore, runs: rows.length };
}

// Per-sector/multiplier/zone hit-count grid feeding the Player Profile's dartboard
// heatmap. Originally Chuckin-only ("heatmap-heavy... patterns and trends" reporting
// that mode was specifically requested to have); generalized (docs/dartboard-zone-
// tracking-roadmap.md, "Beyond Just Chuckin' It") to any game type via the same
// _scope() helper every other per-game-type stat query already uses, since `darts`
// is the one universal per-dart table every game type writes into. Grouping by zone/
// miss_zone/miss_depth splits a single number's inner/outer singles (and a miss's
// wedge+depth) into separate rows instead of one undifferentiated bucket — a hit row
// only ever has `zone` populated, a miss row (sector=0) only ever has miss_zone/
// miss_depth populated, so a given row's fields are always unambiguous.
function getDartHeatmap(playerName, gameType, mode) {
  const p = getPlayer(playerName);
  if (!p) return [];
  const scope = _scope({ mode, gameType });
  return db.prepare(`
    SELECT d.sector AS sector, d.multiplier AS multiplier, d.zone AS zone,
           d.miss_zone AS missZone, d.miss_depth AS missDepth, COUNT(*) AS hits
    FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? ${scope}
    GROUP BY d.sector, d.multiplier, d.zone, d.miss_zone, d.miss_depth
  `).all(p.id);
}
// Chuckin's existing call sites keep working unchanged.
function getChuckinHeatmap(playerName, mode) { return getDartHeatmap(playerName, 'chuckin', mode); }

// Bounce-outs have no position to plot (v1, see docs/archive/dartboard-zone-tracking-roadmap.md
// "Bounce-out tracking") — surfaced as a plain count alongside the heatmap rather than
// a spatial overlay.
function getBounceOutCount(playerName, gameType, mode) {
  const p = getPlayer(playerName);
  if (!p) return 0;
  const scope = _scope({ mode, gameType });
  return db.prepare(`
    SELECT COUNT(*) AS n
    FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? AND d.bounced=1 ${scope}
  `).get(p.id).n;
}

/* ---------- Guided Around the Clock / Around the World (docs/game-modes-roadmap.md
   "Guided Around the Clock / Around the World") ----------
   Around the Clock: structurally identical to Doubles Practice — a "round" is one
   turns.leg_no grouping (leg_no repurposed as a round counter, incremented
   client-side by startNextClockRound()), ending the instant the player has hit all
   20 numbers 1-20 as singles. turns.bust is repurposed exactly the way Doubles
   Practice repurposes it: 1 marks whichever dart ended the round (here, always the
   dart that completed the 20th number — this mode has no "so close"/"wrong target"
   failure mode, only completion or abandonment). A round with no bust=1 dart yet
   was abandoned (player quit mid-round) rather than completed.
   Around the World: structurally identical to Chuckin — one continuous stream of
   1-dart turns per games row (set_no=leg_no=1 throughout), no round boundary,
   tracking progress toward the same lifetime 63-outcome set getAroundTheWorldProgress()
   already computes (deliberately NOT re-scoped to this game_type there — see
   NOT_CONTINUOUS_STREAM's comment above). */

function getAroundTheClockStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'around_the_clock' });

  const dartsThrown = db.prepare(`SELECT COUNT(*) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;

  const rounds = db.prepare(`
    SELECT COUNT(d.id) AS darts, SUM(t.bust) AS ended
    FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
    WHERE t.player_id=? ${scope}
    GROUP BY t.game_id, t.set_no, t.leg_no
  `).all(p.id);

  const sessionsPlayed = rounds.length;
  const completedRounds = rounds.filter(r => r.ended === 1);
  const completions = completedRounds.length;
  const completionRate = sessionsPlayed > 0 ? (completions / sessionsPlayed * 100) : null;
  const avgDartsPerCompletion = completions > 0
    ? (completedRounds.reduce((sum, r) => sum + r.darts, 0) / completions)
    : null;

  return { dartsThrown, sessionsPlayed, completions, completionRate, avgDartsPerCompletion };
}

// Personal Bests analog: fastest completion only (mirrors Doubles Practice/Chuckin's
// "best round"/"best session" minimalism) — no winStreak/recentForm/lifetime, this
// mode never "wins" against an opponent, and getAroundTheClockStatBubbles()'s
// completionRate already covers "how am I doing overall."
function getAroundTheClockPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'around_the_clock' });

  const completedRounds = db.prepare(`
    SELECT COUNT(d.id) AS darts
    FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
    WHERE t.player_id=? ${scope}
    GROUP BY t.game_id, t.set_no, t.leg_no
    HAVING SUM(t.bust)=1
  `).all(p.id);

  let bestCompletionDarts = null;
  for (const r of completedRounds) {
    if (bestCompletionDarts == null || r.darts < bestCompletionDarts) bestCompletionDarts = r.darts;
  }
  return { bestCompletionDarts };
}

// Home page leaderboards for Around the Clock — no mode param on either (always
// practice=1 by construction, same reasoning as Doubles Practice's Home boards).
function getAroundTheClockFastestLeaderboard() {
  const scope = _scope({ gameType: 'around_the_clock' });
  const rows = db.prepare(`
    SELECT p.name AS name, COUNT(d.id) AS darts, MAX(t.created_at) AS created_at
    FROM turns t JOIN games g ON g.id=t.game_id JOIN players p ON p.id=t.player_id JOIN darts d ON d.turn_id=t.id
    WHERE 1=1 ${scope}
    GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
    HAVING SUM(t.bust)=1
  `).all();
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.name);
    if (!cur || r.darts < cur.darts) best.set(r.name, r);
  }
  return [...best.values()].sort((a, b) => a.darts - b.darts)
    .map(r => ({ name: r.name, darts: r.darts, createdAt: r.created_at }));
}

function getAroundTheClockCompletionsLeaderboard() {
  const scope = _scope({ gameType: 'around_the_clock' });
  const rows = db.prepare(`
    SELECT p.name AS name, COUNT(*) AS completions FROM (
      SELECT t.player_id
      FROM turns t JOIN games g ON g.id=t.game_id
      WHERE 1=1 ${scope}
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING SUM(t.bust)=1
    ) c JOIN players p ON p.id=c.player_id
    GROUP BY c.player_id
  `).all();
  return rows.sort((a, b) => b.completions - a.completions);
}

function getAroundTheWorldDrillStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'around_the_world' });

  const dartsThrown = db.prepare(`SELECT COUNT(*) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const sessionsPlayed = db.prepare(`SELECT COUNT(DISTINCT t.game_id) AS v FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const avgDartsPerSession = sessionsPlayed > 0 ? (dartsThrown / sessionsPlayed) : null;

  // Lifetime progress — the same cross-mode 63-outcome tracker every other mode
  // already feeds, not a drill-scoped count of its own.
  const progress = getAroundTheWorldProgress(playerName);

  return { dartsThrown, sessionsPlayed, avgDartsPerSession, progress: progress.count, total: progress.total };
}

// "Personal Bests" analog for Around the World — this mode never "wins" and its
// progress is lifetime/cross-session by design, so there's no round/session record
// to chase the way Doubles Practice/Chuckin/Around the Clock have one. Reuses the
// same sessions-played + lifetime-progress fields getAroundTheWorldDrillStatBubbles()
// already computes, kept as its own function purely so the Personal Bests fetch
// path (a separate endpoint from stat bubbles in every other game type) has a
// matching entry to dispatch to.
function getAroundTheWorldPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'around_the_world' });
  const sessionsPlayed = db.prepare(`SELECT COUNT(DISTINCT t.game_id) AS v FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;
  const progress = getAroundTheWorldProgress(playerName);
  return { sessionsPlayed, progress: progress.count, total: progress.total };
}

// Home page leaderboard: every player ranked by lifetime Around the World progress
// (not scoped to this drill's own darts — the same lifetime count the Player
// Profile's existing progress grid already shows). Filters out players who've never
// hit anything, same as the other Home boards filtering out zero-activity players.
function getAroundTheWorldLeaderboard() {
  const players = db.prepare('SELECT name FROM players').all();
  return players
    .map(pl => {
      const prog = getAroundTheWorldProgress(pl.name);
      return { name: pl.name, progress: prog.count, total: prog.total };
    })
    .filter(r => r.progress > 0)
    .sort((a, b) => b.progress - a.progress);
}

function getMetricHistory(playerName, metric, period, opts = {}) {
  const p = getPlayer(playerName);
  if (!p) return [];
  const modeWhere = _mf(opts.mode);
  // Cricket's metric cases below scope through _scope() (docs/archive/existing-app-prep-roadmap.md
  // item 1) instead of hand-rolling their own "AND g.game_type='cricket'" alongside modeWhere.
  const cricketScope = _scope({ mode: opts.mode, gameType: 'cricket' });
  const doublesPracticeScope = _scope({ mode: opts.mode, gameType: 'doubles_practice' });
  const chuckinScope = _scope({ mode: opts.mode, gameType: 'chuckin' });
  const atcScope = _scope({ mode: opts.mode, gameType: 'around_the_clock' });
  const atwScope = _scope({ mode: opts.mode, gameType: 'around_the_world' });
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
    // NOT_CHECKOUT_TRAINER: a genuine "darts physically thrown" figure, same
    // reasoning as getPlayerStatBubbles()'s own dartsThrown/avgDartsPerDay above.
    case 'dartsthrown':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(d.id) AS value FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${T.and} ${modeWhere} ${weightWhere} ${NOT_CHECKOUT_TRAINER} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'avgdartsperday':
      return db.prepare(`SELECT ${T.fmt} AS bucket, CAST(COUNT(d.id) AS REAL)/NULLIF(COUNT(DISTINCT date(t.created_at)),0) AS value FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${T.and} ${modeWhere} ${weightWhere} ${NOT_CHECKOUT_TRAINER} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'avg':
      // Standard 3-dart average: total points / counted darts * 3 (per-turn darts
      // pre-aggregated so the darts JOIN doesn't inflate SUM(scored)). A bust counts
      // as a full 3-dart visit; a winning visit counts only the darts actually thrown.
      return db.prepare(`SELECT bucket, CAST(SUM(scored) AS REAL)/NULLIF(SUM(dcount),0)*3 AS value, COUNT(*) AS count FROM (
        SELECT ${T.fmt} AS bucket, t.scored AS scored, CASE WHEN t.bust=1 THEN 3 ELSE COUNT(d.id) END AS dcount
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${T.and} ${modeWhere} ${weightWhere} ${X01_ONLY}
        GROUP BY t.id
      ) GROUP BY bucket ORDER BY bucket`).all(...params);
    case '180s':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(*) AS value ${TBASE} ${X01_ONLY} AND t.scored=180 GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'bigfish':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(*) AS value ${TBASE} AND t.checkout=1 AND t.checkout_points=170 GROUP BY bucket ORDER BY bucket`).all(...params);
    case '180sperleg':
      return db.prepare(`SELECT ${L.fmt} AS bucket, CAST(SUM(has_180) AS REAL)/NULLIF(COUNT(*),0) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, MAX(CASE WHEN t.scored=180 THEN 1 ELSE 0 END) AS has_180
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE t.player_id=? ${modeWhere} ${weightWhere} ${X01_ONLY}
        GROUP BY t.game_id,t.set_no,t.leg_no
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'ninedarters':
      return db.prepare(`SELECT ${L.fmt} AS bucket, COUNT(*) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? AND g.game_type='x01' AND json_extract(g.config,'$.startingScore')=501 ${modeWhere} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no HAVING COUNT(DISTINCT t.id)=3 AND SUM(t.checkout)>0 AND COUNT(d.id)=9
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'treblelesspct':
      return db.prepare(`SELECT ${L.fmt} AS bucket, CAST(SUM(is_tl) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, CASE WHEN SUM(d.is_treble)=0 THEN 1 ELSE 0 END AS is_tl
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${modeWhere} ${weightWhere} ${X01_ONLY}
        GROUP BY t.game_id,t.set_no,t.leg_no
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'first3avg':
      // Turn-level score of the leg's first visit — t.scored is already 0 for a
      // busted visit (the previous version summed raw per-dart points instead,
      // wrongly counting a busted opening visit's attempted score). Scoped to
      // exactly 501/301/170/101 — see the OPENING_CATS comment in
      // getPlayerStatBubbles for why (2026-07 product decision: these three-and-
      // nine-dart-average stats count for these 4 starting scores only, ever).
      return db.prepare(`SELECT ${F.fmt} AS bucket, AVG(CAST(scored AS REAL)) AS value FROM (
        SELECT t.created_at, t.scored,
               ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE t.player_id=? ${modeWhere} ${weightWhere} AND g.game_type='x01' AND json_extract(g.config,'$.startingScore') IN (501,301,170,101)
      ) WHERE rn = 1 ${F.and} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'first9avg':
      // 3-dart-average-equivalent over the leg's first up-to-3 visits — uses
      // t.scored (bust-zeroed) for points and the same "bust counts as 3 darts"
      // convention used everywhere else for the denominator, instead of raw
      // per-dart sums that previously counted a busted visit's attempted points as
      // if they'd scored. Scoped to 501/301/170/101 — see getPlayerStatBubbles.
      return db.prepare(`SELECT ${L.fmt} AS bucket, AVG(CAST(total_scored AS REAL)/NULLIF(dart_count,0)*3) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, SUM(t.scored) AS total_scored,
               SUM(CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END) AS dart_count
        FROM (SELECT t.id, t.game_id, t.set_no, t.leg_no, t.created_at, t.scored, t.bust,
                     ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
              FROM turns t JOIN games g ON g.id=t.game_id
              WHERE t.player_id=? ${modeWhere} ${weightWhere} AND g.game_type='x01' AND json_extract(g.config,'$.startingScore') IN (501,301,170,101)) t
        LEFT JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dc ON dc.turn_id = t.id
        WHERE t.rn <= 3
        GROUP BY t.game_id, t.set_no, t.leg_no
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'avg100plus':
      return db.prepare(`SELECT ${L.fmt} AS bucket, CAST(SUM(CASE WHEN la>=100 THEN 1 ELSE 0 END) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, CAST(SUM(t.scored) AS REAL)/COUNT(*) AS la
        FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${modeWhere} ${weightWhere} ${X01_ONLY}
        GROUP BY t.game_id,t.set_no,t.leg_no
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'avg90minus':
      return db.prepare(`SELECT ${L.fmt} AS bucket, CAST(SUM(CASE WHEN la<=90 THEN 1 ELSE 0 END) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, CAST(SUM(t.scored) AS REAL)/COUNT(*) AS la
        FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${modeWhere} ${weightWhere} ${X01_ONLY}
        GROUP BY t.game_id,t.set_no,t.leg_no
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'score140pct':
      // Same "opening visit" shape as first3avg above — needs the same
      // 501/301/170/101 scoping, see the OPENING_CATS comment in getPlayerStatBubbles.
      return db.prepare(`SELECT ${F.fmt} AS bucket, CAST(SUM(CASE WHEN scored>=140 THEN 1 ELSE 0 END) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT t.scored, t.created_at, ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
        FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${modeWhere} ${weightWhere} AND g.game_type='x01' AND json_extract(g.config,'$.startingScore') IN (501,301,170,101)
      ) WHERE rn=1 ${F.and} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'pace':
      // Darts/minute, derived from the gap between consecutive thrown_at timestamps
      // within the same turn — only populated when "collect per-dart timing" is on.
      // NOT_HYPOTHETICAL_DARTS: same exclusion getHomeExtra()'s own _pace() already
      // applies (rapid-fire per-dart Chuckin/Checkout-Trainer rhythm would skew this
      // as a measure of match-throwing pace) — this per-metric-history version had
      // been missing it.
      return db.prepare(`SELECT bucket, 60000.0/AVG(gap_ms) AS value FROM (
        SELECT ${T.fmt} AS bucket, (julianday(d.thrown_at) - julianday(prev.thrown_at)) * 86400000 AS gap_ms
        FROM darts d
        JOIN darts prev ON prev.turn_id = d.turn_id AND prev.dart_no = d.dart_no - 1
        JOIN turns t ON t.id = d.turn_id JOIN games g ON g.id = t.game_id
        WHERE t.player_id=? AND d.thrown_at IS NOT NULL AND prev.thrown_at IS NOT NULL ${T.and} ${modeWhere} ${weightWhere} ${NOT_HYPOTHETICAL_DARTS}
      ) WHERE gap_ms > 0 AND gap_ms < 60000 GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'avgdartsperleg':
      // NOT_CHECKOUT_TRAINER: Chuckin never sets checkout=1 so it's already
      // excluded by the HAVING clause below, but Checkout Trainer's `checkout`
      // column IS set to 1 for legal attempts — needs the explicit exclusion.
      return db.prepare(`SELECT ${L.fmt} AS bucket, AVG(leg_darts) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, COUNT(d.id) AS leg_darts
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${modeWhere} ${weightWhere} ${NOT_CHECKOUT_TRAINER}
        GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(t.checkout)>0
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);

    // ---- Cricket metrics (game-modes-roadmap.md build-order step 3) ----
    case 'cricketmpr':
      // Marks Per Round: SUM(marks)/COUNT(rounds), pre-aggregated per turn (like
      // 'avg' above) so the darts JOIN doesn't inflate the marks sum.
      return db.prepare(`SELECT bucket, CAST(SUM(marks) AS REAL)/NULLIF(COUNT(*),0) AS value FROM (
        SELECT ${T.fmt} AS bucket, SUM(${CRICKET_MARK_CASE('d')}) AS marks
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${cricketScope} ${T.and} ${weightWhere}
        GROUP BY t.id
      ) GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'cricket9marks':
      return db.prepare(`SELECT bucket, COUNT(*) AS value FROM (
        SELECT ${T.fmt} AS bucket
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${cricketScope} ${T.and} ${weightWhere}
        GROUP BY t.id HAVING COUNT(d.id)=3 AND SUM(${CRICKET_MARK_CASE('d')})=9
      ) GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'cricketwinpct': {
      // Game-level bucketing (by completion date), not turn/leg-level — a new
      // bucket granularity for getMetricHistory, but bld() is generic over any
      // timestamp column. Dart-weight filtering doesn't apply at this granularity.
      const G = bld('g.completed_at');
      return db.prepare(`SELECT bucket, CAST(SUM(won) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT ${G.fmt} AS bucket, CASE WHEN g.winner_id=? THEN 1 ELSE 0 END AS won
        FROM game_players gp JOIN games g ON g.id=gp.game_id
        WHERE gp.player_id=? AND g.completed_at IS NOT NULL ${cricketScope} ${G.and}
      ) GROUP BY bucket ORDER BY bucket`).all(p.id, p.id);
    }
    case 'cricketgames': {
      const G = bld('g.completed_at');
      return db.prepare(`SELECT ${G.fmt} AS bucket, COUNT(*) AS value
        FROM game_players gp JOIN games g ON g.id=gp.game_id
        WHERE gp.player_id=? AND g.completed_at IS NOT NULL ${cricketScope} ${G.and}
        GROUP BY bucket ORDER BY bucket`).all(p.id);
    }
    case 'cricketdartsthrown':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(d.id) AS value FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${cricketScope} ${T.and} ${weightWhere} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'cricketavgdartsperleg':
      return db.prepare(`SELECT ${L.fmt} AS bucket, AVG(leg_darts) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, COUNT(d.id) AS leg_darts
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${cricketScope} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(t.leg_won)>0
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);

    // ---- Doubles Practice metrics (docs/game-modes-roadmap.md) ----
    case 'doublespracticepct':
      return db.prepare(`SELECT bucket, CAST(SUM(hits) AS REAL)*100/NULLIF(SUM(dcount),0) AS value FROM (
        SELECT ${T.fmt} AS bucket, ${DOUBLES_HIT_CASE('d')} AS hits, 1 AS dcount
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${doublesPracticeScope} ${T.and} ${weightWhere}
      ) GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'doublespracticedartsperround':
      // No HAVING gate (unlike X01/Cricket's avgdartsperleg) — a Doubles Practice
      // round never "wins", so every round, however it ended, counts equally.
      return db.prepare(`SELECT ${L.fmt} AS bucket, AVG(round_darts) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, COUNT(d.id) AS round_darts
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${doublesPracticeScope} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'doublespracticehitsperround':
      return db.prepare(`SELECT ${L.fmt} AS bucket, AVG(round_hits) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, SUM(${DOUBLES_HIT_CASE('d')}) AS round_hits
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${doublesPracticeScope} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);

    // ---- Just Chuckin' It metrics (game-modes-roadmap.md "Just Chuckin' It") ----
    // Per-dart bucketing (like Cricket's cricketdartsthrown/doublespracticepct) —
    // there's no leg/round boundary in this mode to bucket by instead.
    case 'chuckindartsthrown':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(d.id) AS value FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${chuckinScope} ${T.and} ${weightWhere} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'chuckintreblepct':
      return db.prepare(`SELECT bucket, CAST(SUM(is_treble) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT ${T.fmt} AS bucket, d.is_treble AS is_treble
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${chuckinScope} ${T.and} ${weightWhere}
      ) GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'chuckinbullpct':
      return db.prepare(`SELECT bucket, CAST(SUM(is_bull) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT ${T.fmt} AS bucket, CASE WHEN d.sector=25 THEN 1 ELSE 0 END AS is_bull
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${chuckinScope} ${T.and} ${weightWhere}
      ) GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'chuckindoublepct':
      return db.prepare(`SELECT bucket, CAST(SUM(is_double) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT ${T.fmt} AS bucket, d.is_double AS is_double
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${chuckinScope} ${T.and} ${weightWhere}
      ) GROUP BY bucket ORDER BY bucket`).all(...params);
    // Session-shaped metrics bucket by each session's own timestamp (leg_ts, via
    // the L bucketer already used for X01/Cricket/Doubles-Practice per-leg
    // metrics) — a "session" here is one games row, matching getChuckinPersonalBests().
    case 'chuckinsessions':
      return db.prepare(`SELECT ${L.fmt} AS bucket, COUNT(*) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE t.player_id=? ${chuckinScope} ${weightWhere}
        GROUP BY t.game_id
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'chuckinavgdartspersession':
      return db.prepare(`SELECT ${L.fmt} AS bucket, AVG(session_darts) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, COUNT(d.id) AS session_darts
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${chuckinScope} ${weightWhere}
        GROUP BY t.game_id
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    // Standard 3-dart average, per-dart bucketed like X01's own 'avg' case —
    // no 3-dart grouping needed, just points-per-dart * 3 (see getChuckinStatBubbles).
    case 'chuckinavg':
      return db.prepare(`SELECT bucket, CAST(SUM(val) AS REAL)*3/NULLIF(COUNT(*),0) AS value FROM (
        SELECT ${T.fmt} AS bucket, d.sector*d.multiplier AS val
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${chuckinScope} ${T.and} ${weightWhere}
      ) GROUP BY bucket ORDER BY bucket`).all(...params);
    // 180s: bucketed by the timestamp of each qualifying 3-dart group's last dart
    // (via its turn's created_at) — see CHUCKIN_GROUPS_OF_3's own comment for why
    // groups never span two sessions.
    case 'chuckin180s':
      return db.prepare(`SELECT ${F.fmt} AS bucket, COUNT(*) AS value FROM (
        SELECT MAX(created_at) AS created_at, SUM(val) AS grp_score, COUNT(*) AS grp_count FROM (
          SELECT d.sector*d.multiplier AS val, t.created_at AS created_at, t.game_id AS game_id,
                 (ROW_NUMBER() OVER (PARTITION BY t.game_id ORDER BY d.id) - 1) / 3 AS grp
          FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id
          WHERE t.player_id=? ${chuckinScope} ${weightWhere}
        ) GROUP BY game_id, grp
      ) WHERE grp_count=3 AND grp_score=180 ${F.and} GROUP BY bucket ORDER BY bucket`).all(...params);

    // ---- Guided Around the Clock metrics (docs/game-modes-roadmap.md) ----
    // Round-shaped metrics bucket by leg_ts (like Doubles Practice's own
    // per-round metrics) — a "round" here is one (game_id,set_no,leg_no) group.
    case 'atcdartsthrown':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(d.id) AS value FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${atcScope} ${T.and} ${weightWhere} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'atccompletions':
      return db.prepare(`SELECT ${L.fmt} AS bucket, COUNT(*) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE t.player_id=? ${atcScope} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(t.bust)=1
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'atcavgdartspercompletion':
      return db.prepare(`SELECT ${L.fmt} AS bucket, AVG(round_darts) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, COUNT(d.id) AS round_darts
        FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
        WHERE t.player_id=? ${atcScope} ${weightWhere}
        GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(t.bust)=1
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);

    // ---- Guided Around the World metrics (docs/game-modes-roadmap.md) ----
    // Per-dart/per-session bucketing, same shape as Chuckin's own metrics — no
    // round boundary exists in this mode to bucket by instead.
    case 'atwdartsthrown':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(d.id) AS value FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${atwScope} ${T.and} ${weightWhere} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'atwsessions':
      return db.prepare(`SELECT ${L.fmt} AS bucket, COUNT(*) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE t.player_id=? ${atwScope} ${weightWhere}
        GROUP BY t.game_id
      ) ${L.where} GROUP BY bucket ORDER BY bucket`).all(...params);

    default:
      return [];
  }
}

function _mf(mode) {
  if (mode === 'h2h')      return `AND g.practice = 0 AND g.player_count > 1`;
  if (mode === 'practice') return `AND (g.practice = 1 OR g.player_count = 1)`;
  return '';
}

// Central "game scope" filter builder (docs/archive/existing-app-prep-roadmap.md item 1)
// — composes the mode dimension (h2h/practice, via _mf) with the game-type
// dimension, so a future scoping dimension (online, league, tournament) only
// needs to touch this one function instead of being hand-rolled at 20+ query
// sites the way `practice` originally was. gameType is always an internally-
// controlled enum value (never raw request input — callers pass a literal
// 'x01'/'cricket', server.js only uses a query param to pick which function to
// call), and is whitelisted here regardless as a defense-in-depth measure
// against string interpolation.
const KNOWN_GAME_TYPES = ['x01', 'cricket', 'doubles_practice', 'chuckin', 'checkout_trainer', 'around_the_clock', 'around_the_world'];
function _scope({ mode, gameType } = {}) {
  let sql = _mf(mode);
  if (gameType) {
    if (!KNOWN_GAME_TYPES.includes(gameType)) throw new Error(`_scope: unknown gameType "${gameType}"`);
    sql += ` AND g.game_type='${gameType}'`;
  }
  return sql;
}

// X01-only scope for stats derived from turns.scored / leg averages / trebleless
// legs. turns.scored means "X01 points toward the countdown" in an X01 game but
// "cricket points earned" in a cricket game — same column, different quantity — so
// any formula built on it must exclude non-X01 games or a 9-mark cricket visit on
// 20s (180 cricket points) counts as a "180" and cricket points corrupt every
// average. Physical-dart stats (darts thrown, pace, sector analytics, Around the
// World), games/wins/H2H records, and checkout-based stats (cricket never writes
// checkout=1) deliberately do NOT use this — see REFERENCE.md §3.
const X01_ONLY = _scope({ gameType: 'x01' });

// Just Chuckin' It (game-modes-roadmap.md) is the inverse of every other game-type
// addition so far: Cricket/Doubles Practice darts were deliberately folded INTO the
// "physical dart stats" aggregates above (dartsThrown, pace, sector analytics,
// Around the World) since a cricket dart is still a real dart. Just Chuckin' It's
// darts must NOT count toward any of those — the one deliberate exception (per an
// explicit product decision) is the pure "total darts thrown" counters themselves
// (computeStats()'s allCounts, getSummary()'s darts/todayDarts/weekDarts — all
// already fully unscoped queries that need no change to keep including chuckin).
// Every other "physical dart stats" query that isn't naturally gated by a column
// chuckin never sets (checkout=1, game_type='x01') needs this exclusion added
// explicitly — getDartAnalytics(), getAroundTheWorldProgress(), getHomeExtra()'s
// _pace()/todayLegs/weekLegs, and the practiceLegs aggregates in getSummary()/
// computeStats(). These are hand-rolled WHERE clauses that don't go through
// _mf()/_scope() at all (unlike getChuckinStatBubbles() etc., which always pass an
// explicit gameType:'chuckin' and would contradict a blanket exclusion baked into
// _mf('practice') itself — that's why this is a separate constant applied at each
// specific call site, not folded into the central mode-scoping helpers above).
// Checkout Trainer (docs/checkout-trainer-roadmap.md) joins this exclusion for the
// same reason Just Chuckin' It does: its darts are a proposed route, not a real
// throw, and must not pollute sector heatmaps, treble rate, or dart-pace either.
const NOT_HYPOTHETICAL_DARTS = `AND g.game_type NOT IN ('chuckin','checkout_trainer')`;
// Narrower than NOT_HYPOTHETICAL_DARTS above — Just Chuckin' It deliberately DOES
// count toward the handful of "pure total darts thrown" counters this excludes
// Checkout Trainer from too (allCounts/getSummary's darts/todayDarts/weekDarts,
// the roster/profile "last played" timestamp): a chuckin dart is still a real
// physical throw, so the existing exception for it stands. A Checkout Trainer
// dart is never physical at all — not a proposed-route exception like chuckin's,
// a genuine "this never happened on a dartboard" exclusion — so it must not
// register as activity, a dart thrown, or a "last played" touch on any existing
// stat, full stop (explicit product decision, not inferred from the chuckin
// precedent this constant otherwise mirrors).
const NOT_CHECKOUT_TRAINER = `AND g.game_type != 'checkout_trainer'`;

// Guided Around the World (docs/game-modes-roadmap.md "Guided Around the Clock /
// Around the World") shares Chuckin's exact shape for leg/pace purposes: one
// continuous stream of 1-dart turns per games row, set_no=leg_no=1 throughout, no
// round boundary at all. Counting a single (potentially hours-long) World session
// as "1 leg" would skew the same leg-count/pace aggregates Chuckin and Checkout
// Trainer are already excluded from (via NOT_HYPOTHETICAL_DARTS above) for related
// reasons — a rapid-fire non-match rhythm for Chuckin/World, a non-physical
// "hypothetical" dart for Checkout Trainer, but the same corrupting effect on
// leg-count/pace either way. Guided Around the Clock is the opposite — it
// repurposes leg_no as a genuine per-round counter (same as Doubles Practice,
// which is NOT excluded from these), so its darts stay included here. This is
// intentionally a separate, broader constant from NOT_HYPOTHETICAL_DARTS, not a
// redefinition of it — getDartAnalytics() and getAroundTheWorldProgress() below
// deliberately keep using the narrower NOT_HYPOTHETICAL_DARTS (chuckin +
// checkout_trainer only): cross-game-type sector analytics should include
// targeted-practice darts (the existing Doubles Practice precedent), and excluding
// Around the World from getAroundTheWorldProgress() would break the very feature
// that query exists to feed.
const NOT_CONTINUOUS_STREAM = `AND g.game_type NOT IN ('chuckin','checkout_trainer','around_the_world')`;

function getOneEightyStats(mode) {
  const mf = _mf(mode);
  const J = `FROM turns t JOIN games g ON g.id = t.game_id JOIN players p ON p.id = t.player_id`;
  const leaderboard = db.prepare(`SELECT p.name, COUNT(*) AS count ${J} WHERE t.scored = 180 ${mf} ${X01_ONLY} GROUP BY t.player_id ORDER BY count DESC`).all();
  const recent      = db.prepare(`SELECT p.name, t.created_at ${J} WHERE t.scored = 180 ${mf} ${X01_ONLY} ORDER BY t.created_at DESC LIMIT 10`).all();
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
      WHERE g.game_type = 'x01' AND json_extract(g.config,'$.startingScore') = 501 ${mf}
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING COUNT(DISTINCT t.id) = 3 AND SUM(t.checkout) > 0 AND COUNT(d.id) = 9
    ) x JOIN players p ON p.id = x.player_id
    GROUP BY x.player_id ORDER BY count DESC
  `).all();
  const recent = db.prepare(`
    SELECT p.name, MAX(t.created_at) AS created_at
    FROM turns t JOIN games g ON g.id=t.game_id JOIN players p ON p.id=t.player_id
    JOIN darts d ON d.turn_id=t.id
    WHERE g.game_type = 'x01' AND json_extract(g.config,'$.startingScore') = 501 ${mf}
    GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
    HAVING COUNT(DISTINCT t.id) = 3 AND SUM(t.checkout) > 0 AND COUNT(d.id) = 9
    ORDER BY created_at DESC LIMIT 10
  `).all();
  return { leaderboard, recent };
}

/* ---------- badges (docs/archive/achievements-badges-roadmap.md) ---------- */
// Awards a badge. Two modes, chosen by the caller (see the player_badges table
// comment): `once` is idempotent (INSERT OR IGNORE) for state-based badges whose
// trigger condition stays true forever once crossed, so re-checking it doesn't
// inflate the count. Otherwise the count increments every call, for badges whose
// trigger condition fires once per relevant event (a visit, a leg, a match).
// docs/security-audit-roadmap.md SEC-14: badgeId previously accepted any string with
// no bound — awardBadge()/revokeBadge() are both requireWrite routes, public by
// default, so an unauthenticated caller could award/inflate an arbitrary badge_id
// (real or made-up) on any player, polluting the Badge Case/leaderboards. There is
// no single canonical badge-id registry shared between frontend and backend today
// (badge ids live only in frontend/index.html's BADGE_INFO plus the dynamically-
// generated Just Chuckin' It milestone-ladder ids, e.g. chuckin_darts_10) — building
// a duplicate exact-enumeration here would be a second place to keep in sync every
// time a badge is added, the exact "same meaning in two places" drift risk this
// codebase avoids elsewhere. Every existing badge id (checked against BADGE_INFO's
// keys, ACH_TYPE_TO_BADGE_ID's persisted values, and the ladder id prefixes) is
// lowercase snake_case, so a shape bound closes the "unbounded free-form string"
// gap without introducing that duplication.
const BADGE_ID_RE = /^[a-z0-9_]{1,64}$/;
function validateBadgeId(badgeId) {
  const id = String(badgeId || '');
  if (!BADGE_ID_RE.test(id)) throw httpError(400, 'badgeId must be lowercase letters, numbers, and underscores (max 64 characters)');
  return id;
}

function awardBadge(playerName, badgeId, once) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');
  badgeId = validateBadgeId(badgeId);
  if (once) {
    const info = q.awardBadgeOnce.run(p.id, badgeId);
    return { newlyEarned: info.changes > 0, count: 1 };
  }
  q.awardBadgeIncrement.run(p.id, badgeId);
  const row = q.badgeCount.get(p.id, badgeId);
  return { newlyEarned: row.count === 1, count: row.count };
}

// Reverses one occurrence of a badge (Undo Last Turn). Symmetric to awardBadge():
// decrements count by 1, deleting the row once it reaches 0. Works the same way
// for both award modes — a `once` badge only ever has count 1, so revoking it
// always deletes the row, exactly undoing the single INSERT OR IGNORE that
// created it.
function revokeBadge(playerName, badgeId) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');
  badgeId = validateBadgeId(badgeId);
  const row = q.badgeCount.get(p.id, badgeId);
  if (!row) return { count: 0 };
  if (row.count <= 1) {
    q.deleteBadge.run(p.id, badgeId);
    return { count: 0 };
  }
  q.decrementBadge.run(p.id, badgeId);
  return { count: row.count - 1 };
}

function getPlayerBadges(playerName) {
  const p = getPlayer(playerName);
  if (!p) return [];
  return q.playerBadges.all(p.id);
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

// docs/security-audit-roadmap.md SEC-14: eventType previously accepted any string.
// This is a requireWrite route, public by default, so an unauthenticated caller
// could pollute a game's timeline with arbitrary event types. The 6 real event
// types are exactly the ones frontend/index.html's DB.recordEvent() ever sends.
const KNOWN_EVENT_TYPES = ['game_start', 'game_end', 'set_start', 'set_end', 'leg_start', 'leg_end'];
function recordEvent(gameId, eventType, setNo, legNo) {
  if (!KNOWN_EVENT_TYPES.includes(eventType)) throw httpError(400, `Unknown event type "${eventType}"`);
  db.prepare(
    'INSERT INTO timeline_events (game_id, event_type, set_no, leg_no) VALUES (?, ?, ?, ?)'
  ).run(Number(gameId), String(eventType), setNo ?? null, legNo ?? null);
  return { ok: true };
}

/* ---------- server error log (docs/testing-and-observability-roadmap.md Part A) ----------
   Called from server.js's top-level catch alongside the existing console.error, for
   5xx responses only (a 4xx is an expected client mistake, not a server fault worth
   a diagnostic entry). Pruned to the most recent 500 rows on every insert — a
   deliberately small rolling window, not a full audit log, so a crash-loop can't
   grow this table unbounded between restarts. */
function logServerError({ method, path, status, message }) {
  q.insertServerError.run(method ? String(method) : null, path ? String(path) : null,
    Number.isInteger(status) ? status : null, message ? String(message).slice(0, 2000) : null);
  q.pruneServerErrors.run();
}
function getServerErrors(limit = 100) {
  const n = Number.isInteger(Number(limit)) && limit > 0 ? Math.min(Number(limit), 500) : 100;
  return q.recentServerErrors.all(n);
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


// "On This Day": the most notable thing this player did on this exact calendar
// month/day in a past year — a 180, a 170 checkout, or any 100+ checkout, in that
// priority order, picking the single most recent qualifying date if more than one
// year has one. Deliberately just one clear story rather than an exhaustive list —
// this feeds a homepage-style flashback callback, not a stats report. Feeds into
// the existing buildMomentCard()/share/HA-webhook pipeline client-side as a new
// 'flashback' moment type, reusing that machinery rather than building a new one.
function getOnThisDay(playerName, tz) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const tzOff = Number.isInteger(tz) ? tz : 0;
  const tzMod = tzOff ? `, '${tzOff >= 0 ? '+' : ''}${tzOff} minutes'` : '';
  // scored=180 only means "a 180" in an X01 game — a 9-mark cricket visit on 20s
  // records 180 cricket points and must not surface as a 180 flashback. Cricket
  // turns stay eligible for the generic "you played on this day" fallback (ELSE 0).
  const row = db.prepare(`
    SELECT t.scored, t.checkout, t.checkout_points, g.category, g.game_type,
           strftime('%Y', t.created_at${tzMod}) AS yr
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE t.player_id = ?
      AND strftime('%m-%d', t.created_at${tzMod}) = strftime('%m-%d', 'now'${tzMod})
      AND strftime('%Y',    t.created_at${tzMod}) != strftime('%Y', 'now'${tzMod})
    ORDER BY
      (CASE WHEN t.scored = 180 AND g.game_type = 'x01' THEN 3
            WHEN t.checkout = 1 AND t.checkout_points = 170 THEN 2
            WHEN t.checkout = 1 AND t.checkout_points >= 100 THEN 1
            ELSE 0 END) DESC,
      yr DESC
    LIMIT 1
  `).get(p.id);
  if (!row) return null;
  const nowYear = new Date().getFullYear();
  const yearsAgo = nowYear - Number(row.yr);
  if (row.scored === 180 && row.game_type === 'x01') {
    return { type: '180', year: Number(row.yr), yearsAgo, statLine: `A 180, ${row.category}` };
  }
  if (row.checkout && row.checkout_points === 170) {
    return { type: 'bigfish', year: Number(row.yr), yearsAgo, statLine: `A 170 checkout, ${row.category}` };
  }
  if (row.checkout && row.checkout_points >= 100) {
    return { type: 'checkout100', year: Number(row.yr), yearsAgo, statLine: `A ${row.checkout_points} checkout, ${row.category}` };
  }
  return null;
}

function clearPlayerStats(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');

  if (mode === 'all') {
    // Delete solo games (where this player was the sole participant) — cascades to their turns and game_players
    db.prepare(`
      DELETE FROM games WHERE id IN (
        SELECT g.id FROM games g
        WHERE g.player_count = 1
          AND EXISTS (SELECT 1 FROM game_players gp2 WHERE gp2.game_id = g.id AND gp2.player_id = ?)
      )
    `).run(p.id);
    // Delete this player's turns from any remaining multi-player games. game_players
    // rows are intentionally KEPT (same as the h2h/practice branches below) — and now
    // that classification reads the frozen games.player_count, keeping vs. removing them
    // no longer affects an opponent's H2H/practice split either way; keeping them just
    // preserves the honest record that this player took part in those games.
    db.prepare('DELETE FROM turns WHERE player_id = ?').run(p.id);
    return { ok: true };
  }

  const gameIdQuery = mode === 'h2h'
    ? `SELECT g.id FROM games g
       WHERE g.practice = 0
         AND g.player_count > 1
         AND EXISTS (SELECT 1 FROM game_players gp2 WHERE gp2.game_id = g.id AND gp2.player_id = ?)`
    : `SELECT g.id FROM games g
       WHERE (g.practice = 1 OR g.player_count = 1)
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
  // Excludes darts thrown on busted turns — they shouldn't count toward sector/treble
  // analytics — and Just Chuckin' It darts (NOT_HYPOTHETICAL_DARTS), which get their own
  // dedicated heatmap/treble-rate stats instead of feeding this cross-game-type view.
  const BASE = `FROM darts d JOIN turns t ON t.id = d.turn_id JOIN games g ON g.id = t.game_id WHERE t.player_id = ? AND t.bust = 0 ${NOT_HYPOTHETICAL_DARTS}`;

  // 1 — Most hit sector/multiplier combinations. Grouping by zone too (docs/dartboard-
  // zone-tracking-roadmap.md) splits a single-hit number's inner/outer regions into
  // separate rows ("S20 (inner)" vs "S20 (outer)") for players who want that precision
  // in this flat list, same as the geometric heatmap shows it.
  const topSectors = db.prepare(`
    SELECT d.sector, d.multiplier, d.zone, COUNT(*) AS hits
    ${BASE} ${mf}
    GROUP BY d.sector, d.multiplier, d.zone
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
  // NOT_HYPOTHETICAL_DARTS: unlike topSectors/trebleRates above, this doesn't reuse
  // ${BASE} (different JOIN shape — three dart-position joins, not one), so it needs
  // its own exclusion. Chuckin never sets checkout=1 so it's already naturally
  // excluded, but Checkout Trainer's proposed routes must not appear here either.
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
    WHERE t.player_id = ? AND t.checkout = 1 ${mf} ${NOT_HYPOTHETICAL_DARTS}
    GROUP BY s1, m1, s2, m2, s3, m3
    ORDER BY times DESC
    LIMIT 10
  `).all(p.id);

  return { topSectors, trebleRates, checkoutRoutes };
}

/* ---------- coaching insights (docs/coaching-insights-roadmap.md) ----------
   Turns tables that already exist (getDartAnalytics/getCheckoutRoutes above,
   getPersonalBests) into plain-language practice guidance. No new data
   collection — X01 only (checkout routes and bust parity are X01-specific
   concepts; Cricket/Doubles Practice/Chuckin aren't in scope for this pass).

   Thresholds below were chosen deliberately conservative ("Strict" — see the
   roadmap doc's now-resolved open question): a wrong coaching insight
   actively misleads a player about their own game, a worse failure mode than
   a wrong descriptive stat, so every insight requires a large enough sample
   that it reflects a real pattern rather than noise from a handful of visits. */
const COACHING_MIN_NUMBER_DARTS     = 40; // darts at a number before judging its treble rate
const COACHING_WEAK_NUMBER_GAP_PP   = 10; // percentage points below the player's own baseline
const COACHING_MIN_ROUTE_USES       = 10; // times a checkout score must have been hit before judging the route
const COACHING_MIN_PARITY_ATTEMPTS  = 20; // checkout-range attempts required in EACH of odd/even
const COACHING_BUST_RATE_GAP_PP     = 15; // percentage points difference to flag a parity bust bias
const COACHING_MIN_LEGS_FOR_FORM    = 20; // lifetime legs required before trusting the recent-form delta

function getCoachingInsights(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return [];
  const mf = _mf(mode);
  const insights = [];

  // 1 — Weak number: player's own treble rate on a number vs. their own overall
  // treble rate (never a fixed external benchmark).
  const { trebleRates } = getDartAnalytics(playerName, mode) || { trebleRates: [] };
  const totalTrebles = trebleRates.reduce((s, r) => s + r.trebles, 0);
  const totalDarts   = trebleRates.reduce((s, r) => s + r.total, 0);
  if (totalDarts > 0) {
    const baseline = 100 * totalTrebles / totalDarts;
    trebleRates
      .filter(r => r.total >= COACHING_MIN_NUMBER_DARTS && baseline - r.treble_pct >= COACHING_WEAK_NUMBER_GAP_PP)
      .sort((a, b) => a.treble_pct - b.treble_pct)
      .slice(0, 2)
      .forEach(r => insights.push({
        type: 'weak_number', tone: 'weakness',
        text: `Your treble-${r.sector} accuracy (${r.treble_pct.toFixed(0)}%) is well below your overall treble rate (${baseline.toFixed(0)}%) — worth some focused practice.`,
      }));
  }

  // 2 — Checkout route inefficiency: the player's most-used route for their
  // most-established checkout score, compared against checkoutHint()'s
  // dart-count-optimal route for that same score.
  const doubleOut = p.out_mode !== 'single';
  const scoreRow = db.prepare(`
    SELECT t.checkout_points AS score, COUNT(*) AS times
    FROM turns t JOIN games g ON g.id = t.game_id
    WHERE t.player_id = ? AND t.checkout = 1 ${X01_ONLY} ${mf}
    GROUP BY t.checkout_points
    HAVING COUNT(*) >= ${COACHING_MIN_ROUTE_USES}
    ORDER BY times DESC
    LIMIT 1
  `).get(p.id);
  if (scoreRow) {
    const topRoute = getCheckoutRoutes(playerName, scoreRow.score, mode)[0];
    const optimal = checkoutHint(scoreRow.score, doubleOut, 3);
    if (topRoute && optimal) {
      const actualParts = [[topRoute.s1, topRoute.m1], [topRoute.s2, topRoute.m2], [topRoute.s3, topRoute.m3]]
        .filter(([s]) => s != null);
      const optimalDartCount = optimal.split(' ').length;
      if (optimalDartCount < actualParts.length) {
        const actualLabel = actualParts.map(([s, m]) => dartLabel(s, m)).join(' ');
        insights.push({
          type: 'checkout_route', tone: 'weakness',
          text: `Your usual route for ${scoreRow.score} (${actualLabel}, ${actualParts.length} darts) takes more darts than necessary — ${optimal} finishes it in ${optimalDartCount}.`,
        });
      }
    }
  }

  // 3 — Bust pattern by parity (double-out only — single-out has no such bias,
  // any score reaching exactly zero wins). Reconstructs the remaining score
  // entering each turn (starting score minus the running sum of this player's
  // prior scored points in that same leg) since turns doesn't store it directly.
  if (doubleOut) {
    const parityRows = db.prepare(`
      WITH ordered AS (
        SELECT t.bust,
               json_extract(g.config,'$.startingScore')
                 - COALESCE(SUM(t.scored) OVER (
                     PARTITION BY t.game_id, t.set_no, t.leg_no
                     ORDER BY t.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                   ), 0) AS remaining
        FROM turns t
        JOIN games g ON g.id = t.game_id
        JOIN game_players gp ON gp.game_id = t.game_id AND gp.player_id = t.player_id
        WHERE t.player_id = ? AND gp.out_mode = 'double'
          AND g.game_type = 'x01' AND json_extract(g.config,'$.startingScore') IN (501,301,170,101)
          ${mf}
      )
      SELECT CASE WHEN remaining % 2 = 0 THEN 'even' ELSE 'odd' END AS parity,
             COUNT(*) AS attempts, SUM(bust) AS busts
      FROM ordered
      WHERE remaining BETWEEN 2 AND 170
      GROUP BY parity
    `).all(p.id);
    const odd  = parityRows.find(r => r.parity === 'odd');
    const even = parityRows.find(r => r.parity === 'even');
    if (odd && even && odd.attempts >= COACHING_MIN_PARITY_ATTEMPTS && even.attempts >= COACHING_MIN_PARITY_ATTEMPTS) {
      const oddRate  = 100 * odd.busts  / odd.attempts;
      const evenRate = 100 * even.busts / even.attempts;
      const [worse, better, worseRate, betterRate] = oddRate >= evenRate
        ? ['odd', 'even', oddRate, evenRate] : ['even', 'odd', evenRate, oddRate];
      if (worseRate - betterRate >= COACHING_BUST_RATE_GAP_PP) {
        insights.push({
          type: 'bust_parity', tone: 'weakness',
          text: `You bust ${worseRate.toFixed(0)}% of the time when left on an ${worse} number, vs. ${betterRate.toFixed(0)}% on ${better} numbers — worth drilling ${worse}-number finishes specifically.`,
        });
      }
    }
  }

  // 4 — Form trend: plain-language wrapper around getPersonalBests' existing
  // recentFormAvg/lifetimeAvg, gated on enough lifetime legs that the "last 10"
  // window isn't simply most/all of the player's history.
  const legsCount = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM turns t JOIN games g ON g.id = t.game_id
      WHERE t.player_id = ? ${X01_ONLY} ${mf}
      GROUP BY t.game_id, t.set_no, t.leg_no HAVING SUM(t.checkout) > 0
    )
  `).get(p.id)?.n ?? 0;
  if (legsCount >= COACHING_MIN_LEGS_FOR_FORM) {
    const pb = getPersonalBests(playerName, mode);
    if (pb && pb.recentFormAvg != null && pb.lifetimeAvg != null) {
      const delta = pb.recentFormAvg - pb.lifetimeAvg;
      if (Math.abs(delta) >= 5) {
        insights.push({
          type: 'form_trend', tone: delta >= 0 ? 'strength' : 'weakness',
          text: delta >= 0
            ? `Your average is up ${delta.toFixed(1)} over your last 10 legs vs. your lifetime average — good form.`
            : `Your average is down ${Math.abs(delta).toFixed(1)} over your last 10 legs vs. your lifetime average — a sign of fatigue, or just a rough patch?`,
        });
      }
    }
  }

  return insights;
}

function resetStats() {
  // docs/bug-roadmap.md BUG-7: this deletes every game, which is what tournament
  // matches link to — so leaving the tournament rows behind would strand every
  // bracket (game_id NULLed, in-progress matches silently reverting to "ready").
  // A stat reset that guts all games should clear the tournaments too. DELETE FROM
  // tournaments cascades to tournament_players/rounds/matches.
  // dart_components/loadouts are deliberately NOT touched here — they're player
  // profile data (a player's owned equipment), same category as dart_weight/
  // out_mode/PIN, which also survive a stats reset. ghost_races IS stat/game data
  // (an outcome of a specific practice game), so it should clear here — and does,
  // for free: both game_id and source_game_id are ON DELETE CASCADE, so DELETE FROM
  // games below cascades it without needing its own explicit line.
  // leagues/league_players are ALSO deliberately NOT touched here — a documented
  // exception to the "any new user-data table must be wired into resetStats() too"
  // rule below, not an oversight: unlike tournaments, nothing in the leagues/
  // league_players schema points at a games row (see the schema comment), so wiping
  // every game leaves leagues in a fully self-consistent state — standings are
  // computed LIVE and simply recompute to all-zero, never a stranded/half-updated
  // shell the way tournament brackets were pre-BUG-7. A league's own config (name/
  // category/date window/points formula) is closer to player-profile configuration
  // data than to tournament's mid-flight bracket state.
  db.exec('DELETE FROM turns; DELETE FROM game_players; DELETE FROM games; DELETE FROM tournaments;');
  return { ok: true };
}

// Wipes every player, game, and stat — admin accounts and app settings survive.
// Deleting all players cascades to game_players/turns/darts; deleting the
// (now-empty) games cascades their timeline_events too. docs/bug-roadmap.md BUG-7:
// nothing references the tournaments PARENT row, so without an explicit delete the
// tournament/round/match shells survived a total wipe and still showed (with blank
// names) in the Tournaments list. DELETE FROM tournaments cascades all four tables.
// dart_components/loadouts need no explicit delete either — both have a
// player_id ON DELETE CASCADE, so wiping players clears them for free.
// ghost_races is covered twice over — player_id and both game FKs are all
// ON DELETE CASCADE, so either the player wipe or the game wipe below clears it.
// docs/league-mode-roadmap.md: leagues needs the same explicit delete tournaments
// got from BUG-7 — wiping all players cascades away league_players (player_id ON
// DELETE CASCADE), but nothing references the leagues PARENT row, so without this
// the league shells (name/category/dates) would survive a total wipe with a now-
// empty roster, showing an orphaned "0 players" league in the Leagues list. DELETE
// FROM leagues cascades league_players too.
function wipeAllData() {
  db.exec('DELETE FROM players; DELETE FROM games; DELETE FROM tournaments; DELETE FROM leagues;');
  return { ok: true };
}

// Full-database export (docs/data-export-roadmap.md, admin-only, Settings ->
// Admin & Danger Zone -> Data Export): a complete, human-readable JSON dump of
// every player/game/stat table — "it's your data, and you can always take it
// with you." Deliberately excludes admins/sessions/settings/server_errors
// (internal/credential tables, not "your darts data"), and excludes players'
// pin_hash/pin_salt/pin_fail_count/pin_locked_until columns even though the
// players table itself is included — a password/PIN hash should never leave
// the server, exported or not, the same write-only handling every other
// credential in this app already gets.
function getFullDatabaseExport() {
  return {
    exportedAt: new Date().toISOString(),
    players: db.prepare('SELECT id, name, out_mode, created_at, dart_weight FROM players').all(),
    games: db.prepare('SELECT * FROM games').all(),
    gamePlayers: db.prepare('SELECT * FROM game_players').all(),
    turns: db.prepare('SELECT * FROM turns').all(),
    darts: db.prepare('SELECT * FROM darts').all(),
    timelineEvents: db.prepare('SELECT * FROM timeline_events').all(),
    playerBadges: db.prepare('SELECT * FROM player_badges').all(),
    dailyChallengeAttempts: db.prepare('SELECT * FROM daily_challenge_attempts').all(),
    // docs/bug-roadmap.md BUG-6: the tournament tables are ordinary user data (no
    // secrets), so they belong in "take your data with you" alongside games/stats —
    // omitting them silently dropped all tournament history from the export.
    // NOTE (standing rule): any NEW user-data table must be added HERE and to
    // wipeAllData()/resetStats() (BUG-7) in the same change that creates it.
    tournaments: db.prepare('SELECT * FROM tournaments').all(),
    tournamentPlayers: db.prepare('SELECT * FROM tournament_players').all(),
    tournamentRounds: db.prepare('SELECT * FROM tournament_rounds').all(),
    tournamentMatches: db.prepare('SELECT * FROM tournament_matches').all(),
    // docs/archive/dart-builder-roadmap.md: same "your data, take it with you" standing rule
    // as the tournament tables above — a player's dart components/loadouts are
    // ordinary user data with no secrets, so they belong in the export too.
    dartComponents: db.prepare('SELECT * FROM dart_components').all(),
    loadouts: db.prepare('SELECT * FROM loadouts').all(),
    // docs/archive/ghost-opponent-roadmap.md: same standing rule — a player's ghost-race
    // win/loss history is ordinary user data with no secrets.
    ghostRaces: db.prepare('SELECT * FROM ghost_races').all(),
    // docs/league-mode-roadmap.md: same standing rule — leagues/league_players carry
    // no credential columns, so they belong in "take your data with you" too.
    leagues: db.prepare('SELECT * FROM leagues').all(),
    leaguePlayers: db.prepare('SELECT * FROM league_players').all(),
  };
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
// Public (no-auth) read of the colorblind-mode flag — both the controller and the
// /display screen need this, and neither is necessarily logged in as admin.
function getColorblindMode() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'colorblind_mode'").get();
  return { enabled: row ? row.value === '1' : false };
}
// Public (no-auth) read of voice-announcement settings — the /display screen (where
// announcements are spoken) isn't logged in as admin. Sub-toggles default to true
// (opt-out, not opt-in) once the master switch is on — only 'voice_enabled' itself
// defaults to off.
function getVoiceAnnouncementSettings() {
  const s = getSettings();
  const on = (key) => s[key] !== '0'; // absent/anything but '0' -> enabled
  return {
    enabled:       s.voice_enabled === '1',
    turnScore:     on('voice_turn_score'),
    noScore:       on('voice_no_score'),
    checkoutReq:   on('voice_checkout_req'),
    oneEighty:     on('voice_180'),
    bigFish:       on('voice_bigfish'),
    matchProgress: on('voice_match_progress'),
  };
}
const DEFAULT_CARD_TAGLINE = 'Darts tracked via Oche — track your darts today!';
// Public (no-auth) read of the shareable-card tagline — any device generating a card
// (not just the admin's browser) needs this, and it's meant to be edited later once
// there's a real website/handle to point at.
function getCardTagline() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'card_tagline'").get();
  return { tagline: row && row.value ? row.value : DEFAULT_CARD_TAGLINE };
}
// Public (no-auth) read of the scoreboard layout preset — the /display screen
// isn't logged in as admin, it just needs to know which layout to render.
function getScoreboardLayout() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'scoreboard_layout'").get();
  const layout = row ? row.value : 'full';
  return { layout: ['full','compact','minimal'].includes(layout) ? layout : 'full' };
}
// Public (no-auth) read of the default scoring input (dartboard vs number pad) —
// every device scoring a game needs this, not just an admin's browser.
function getDefaultScoringInput() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'default_scoring_input'").get();
  const input = row ? row.value : 'board';
  return { input: ['pad','board'].includes(input) ? input : 'board' };
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

// docs/security-audit-roadmap.md SEC-20: the isSetupRequired() check below is a
// fast-path only (skip the ~50-100ms scrypt hash entirely when setup is obviously
// already done) — it is NOT what makes this safe against concurrent /api/setup
// calls. The real guard is q.insertAdminIfNone's WHERE NOT EXISTS, which makes
// "check and insert" one indivisible synchronous SQL statement executed AFTER the
// async hash step. Two concurrent requests both awaiting auth.hashSecret() in
// parallel can both observe isSetupRequired()===true, but once each resumes and
// calls the synchronous insertAdminIfNone.run(), JS's single-threaded execution
// means one fully completes (and is now the only admin) before the other's run()
// call even starts — so the second one's WHERE NOT EXISTS is false and it inserts
// zero rows, however different its username was from the winner's.
async function createFirstAdmin(username, password) {
  if (!isSetupRequired()) throw httpError(403, 'Setup already completed');
  username = validateCredentials(username, password);
  const { hash, salt } = await auth.hashSecret(password);
  const info = q.insertAdminIfNone.run(username, hash, salt);
  if (info.changes === 0) throw httpError(403, 'Setup already completed');
  return { ok: true };
}

async function createAdmin(username, password) {
  username = validateCredentials(username, password);
  const { hash, salt } = await auth.hashSecret(password);
  try {
    q.insertAdmin.run(username, hash, salt);
  } catch (e) {
    throw httpError(409, 'Username already exists');
  }
  return { ok: true };
}

// loginLockedUntil/loginFailCount are included so admin-recovery.js's `list`
// subcommand can show whether an account is currently locked (and for how
// much longer) without a separate query — docs/archive/admin-account-recovery-roadmap.md's
// own "resolved open question" that this makes `clear-lockout` an informed
// action rather than a shot in the dark. Harmless to also return to the
// Settings UI's admin list, which only ever reads `.id`/`.username` today.
function listAdmins() {
  return q.listAdmins.all().map(a => ({
    id: a.id, username: a.username, createdAt: a.created_at,
    loginFailCount: a.login_fail_count, loginLockedUntil: a.login_locked_until,
  }));
}

function deleteAdmin(id) {
  id = Number(id);
  if (q.countAdmins.get().n <= 1) throw httpError(400, 'Cannot delete the last remaining admin account');
  q.deleteAdmin.run(id);
  q.deleteSessionsForAdmin.run(id);
  return { ok: true };
}

// docs/archive/admin-account-recovery-roadmap.md's "design gap" section: login()'s
// lockout check runs unconditionally before the password is even consulted, so
// resetting a locked-out admin's password alone would NOT restore access until
// the existing lock naturally expired. Clearing login_fail_count/
// login_locked_until here closes that for both this normal in-app flow (an
// admin who successfully changes their own password has no reason to still be
// carrying a stale lockout) and the recovery CLI's `reset-password`, which gets
// this behavior for free with no separate call.
async function changeAdminPassword(id, password) {
  id = Number(id);
  const admin = q.adminById.get(id);
  if (!admin) throw httpError(404, 'Admin not found');
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw httpError(400, 'Password must be at least 8 characters');
  }
  const { hash, salt } = await auth.hashSecret(password);
  q.updateAdminPw.run(hash, salt, id);
  q.resetLoginFail.run(id);
  q.deleteSessionsForAdmin.run(id); // force re-login on this and any other device after a password change
  return { ok: true };
}

// Clears a stuck lockout without touching the password at all —
// admin-recovery.js's `clear-lockout` subcommand, for the "I remember my
// password fine, I just got locked out" case.
function clearAdminLockout(id) {
  id = Number(id);
  const admin = q.adminById.get(id);
  if (!admin) throw httpError(404, 'Admin not found');
  q.resetLoginFail.run(id);
  return { ok: true };
}

// Generic failure message for both "unknown username" and "wrong password" — avoids
// leaking which usernames exist (user enumeration).
const INVALID_LOGIN = 'Invalid username or password';

// Fixed dummy hash/salt used to verify against on unknown usernames, so login() always
// performs one scrypt computation regardless of whether the username exists — this keeps
// response timing from leaking which usernames are registered. hashSecret() is now
// async (SEC-1), so this is computed once lazily and cached as a promise rather than
// at module load (top-level await isn't available in CommonJS).
let _dummyPwHashPromise = null;
function getDummyPwHash() {
  if (!_dummyPwHashPromise) _dummyPwHashPromise = auth.hashSecret('dummy-password-for-constant-time-login');
  return _dummyPwHashPromise;
}

function adminLockoutGraceAttempts() {
  const v = Number(getSettings().admin_lockout_grace);
  return Number.isInteger(v) && v >= 0 ? v : DEFAULT_ADMIN_LOCKOUT_GRACE;
}
function adminLockoutBaseSeconds() {
  const v = Number(getSettings().admin_lockout_base_seconds);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_ADMIN_LOCKOUT_BASE_SECONDS;
}
function adminLockoutMaxSeconds() {
  const v = Number(getSettings().admin_lockout_max_seconds);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_ADMIN_LOCKOUT_MAX_SECONDS;
}

// The core backoff formula (docs/archive/admin-login-backoff-roadmap.md): 0 (no lock at all)
// while still inside the grace window, then doubling per consecutive failure past it,
// capped at adminLockoutMaxSeconds(). `fails` is the post-increment consecutive-failure
// count from q.bumpLoginFail. Worked example at the doc's own defaults (grace=3, base=2s):
// fails 1-3 -> 0; 4 -> 2s; 5 -> 4s; 6 -> 8s; ... 13 -> capped at 900s.
function adminLockoutDelayMs(fails) {
  const grace = adminLockoutGraceAttempts();
  if (fails <= grace) return 0;
  const seconds = Math.min(adminLockoutMaxSeconds(), adminLockoutBaseSeconds() * Math.pow(2, fails - grace - 1));
  return Math.round(seconds * 1000);
}

// Human-readable remaining-wait text for a 423 response body — mirrors the intent of
// the rate-limiter's Retry-After header (SEC-3) without changing this endpoint's
// existing plain-message error shape.
function formatLockoutWait(ms) {
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  if (totalSec < 60) return `${totalSec} second${totalSec === 1 ? '' : 's'}`;
  const min = Math.ceil(totalSec / 60);
  return `about ${min} minute${min === 1 ? '' : 's'}`;
}

// SEC-3/SEC-8 note: per-account lockout (below) is deliberately left as-is — an
// attacker who knows a username can still grief that one account into lockout. The
// server-side rate limiter (server.js, rateLimit()) applied to this endpoint bounds
// how fast any single IP can throw failed attempts at it, which is the primary
// defense. Unlike the old flat-lockout design, a real admin is never fully blocked —
// see docs/archive/admin-login-backoff-roadmap.md: the account is only ever made to wait
// slightly longer before its next attempt, never placed in a state where the correct
// password stops working once the wait has elapsed.
async function login(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  const admin = q.adminByUsername.get(username);
  const now = Date.now();
  const locked = !!(admin && admin.login_locked_until && admin.login_locked_until > now);

  // Always pay the same scrypt cost — regardless of whether the username exists or
  // is currently locked out — before any branching, so response timing can't be used
  // to probe either signal (matches the existing dummy-hash rationale below).
  let ok;
  if (admin) {
    ok = await auth.verifySecret(password, admin.password_hash, admin.password_salt);
  } else {
    const dummy = await getDummyPwHash();
    await auth.verifySecret(password, dummy.hash, dummy.salt);
    ok = false;
  }

  if (locked) {
    throw httpError(423, `Too many failed login attempts. Try again in ${formatLockoutWait(admin.login_locked_until - now)}.`);
  }

  if (!admin || !ok) {
    if (admin) {
      const fails = q.bumpLoginFail.get(admin.id).login_fail_count;
      const delayMs = adminLockoutDelayMs(fails);
      if (delayMs > 0) q.lockLogin.run(now + delayMs, admin.id);
    }
    throw httpError(401, INVALID_LOGIN);
  }
  q.resetLoginFail.run(admin.id);

  const token = auth.newSessionToken();
  const tokenHash = auth.hashToken(token);
  q.insertSession.run(tokenHash, admin.id, now, now + auth.SESSION_TTL_MS);
  q.deleteExpiredSessions.run(now);
  return { token, username: admin.username };
}

function logout(token) {
  if (!token) return { ok: true };
  q.deleteSession.run(auth.hashToken(token));
  return { ok: true };
}

// Re-verifies the password of an *already-known* admin (by id, from the current
// session) without creating a new session — used to gate restoring a database
// backup (docs/backups-roadmap.md v2), which is at least as destructive as
// "Wipe all data" and shouldn't rely on an active session alone. Reuses the same
// login_fail_count/login_locked_until lockout columns and progressive-backoff
// formula as login() itself, since this is a genuine additional password-guessing
// surface on the same account, not a separate concern.
async function verifyAdminPassword(id, password) {
  const admin = q.adminByIdFull.get(Number(id));
  if (!admin) throw httpError(404, 'Admin not found');
  password = String(password || '');
  const now = Date.now();
  if (admin.login_locked_until && admin.login_locked_until > now) {
    throw httpError(423, `Too many failed login attempts. Try again in ${formatLockoutWait(admin.login_locked_until - now)}.`);
  }
  const ok = await auth.verifySecret(password, admin.password_hash, admin.password_salt);
  if (!ok) {
    const fails = q.bumpLoginFail.get(admin.id).login_fail_count;
    const delayMs = adminLockoutDelayMs(fails);
    if (delayMs > 0) q.lockLogin.run(now + delayMs, admin.id);
    throw httpError(401, 'Incorrect password');
  }
  q.resetLoginFail.run(admin.id);
  return { ok: true };
}

function backupRetentionDays() {
  const v = Number(getSettings().backup_retention_days);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_BACKUP_RETENTION_DAYS;
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

async function setPlayerPin(name, pin) {
  const p = getPlayer(name);
  if (!p) throw httpError(404, 'Player not found');
  if (!PIN_RE.test(String(pin))) throw httpError(400, 'PIN must be 4-8 digits');
  const { hash, salt } = await auth.hashSecret(String(pin));
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

async function verifyPlayerPin(name, pin) {
  const p = getPlayer(name);
  if (!p) throw httpError(404, 'Player not found');
  if (!p.pin_hash) return { ok: true }; // no PIN set — anyone may play as this player

  const now = Date.now();
  if (p.pin_locked_until && p.pin_locked_until > now) {
    throw httpError(423, 'Too many incorrect attempts. Try again later.');
  }

  const ok = await auth.verifySecret(String(pin || ''), p.pin_hash, p.pin_salt);
  if (!ok) {
    const fails = q.bumpPinFail.get(p.id).pin_fail_count;
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
async function fireHaWebhook(event, payload) {
  const cfg = getSettings();
  const haUrl    = cfg.ha_url    || '';
  const whId     = cfg[`ha_webhook_${event}`] || '';
  if (!haUrl || !whId) return { skipped: true };

  const body = JSON.stringify({ ...payload, event, timestamp: Date.now() });
  let url;
  try { url = new URL(`/api/webhook/${encodeURIComponent(whId)}`, haUrl); }
  catch(e) { return { ok: false, error: 'Invalid HA URL' }; }

  // Egress guard (docs/security-audit-roadmap.md, SEC-4): resolve the hostname once
  // and connect to THAT resolved IP (with the original hostname sent as the Host
  // header / TLS SNI), so a DNS answer that changes between "checked" and "connected"
  // (rebinding) can't slip a blocked destination through.
  let resolvedIp;
  try { resolvedIp = await netguard.resolveAllowedHost(url.hostname); }
  catch (e) { return { ok: false, error: e.message }; }

  return new Promise((resolve) => {
    const mod = url.protocol === 'https:' ? require('https') : require('http');
    const opts = {
      hostname: resolvedIp,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: url.host },
    };
    if (url.protocol === 'https:') opts.servername = url.hostname; // keep SNI/cert checks on the real hostname
    const req = mod.request(opts, res => { res.resume(); resolve({ ok: true, status: res.statusCode }); });
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end(body);
  });
}

function getH2HRecord(name1, name2) {
  if(!name1 || !name2) return null;
  // COLLATE NOCASE to match players.name's case-insensitive uniqueness and every
  // other lookup in this file (getPlayer, getH2HSummary) — without it a
  // differently-cased name would return an empty record here but a correct one
  // everywhere else.
  const p1 = db.prepare(`SELECT id FROM players WHERE name=? COLLATE NOCASE`).get(name1);
  const p2 = db.prepare(`SELECT id FROM players WHERE name=? COLLATE NOCASE`).get(name2);
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

// Used by the Grudge Match / Rematch badges (docs/archive/achievements-badges-roadmap.md).
// excludeGameId lets the caller ask "who won the last time before this one" right
// after the current match has just been recorded.
function getH2HSummary(name1, name2, excludeGameId) {
  if(!name1 || !name2) return null;
  const p1 = getPlayer(name1), p2 = getPlayer(name2);
  if(!p1 || !p2) return null;
  const rows = db.prepare(`
    SELECT g.id, g.winner_id FROM games g
    JOIN game_players gp1 ON gp1.game_id=g.id AND gp1.player_id=?
    JOIN game_players gp2 ON gp2.game_id=g.id AND gp2.player_id=?
    WHERE g.practice=0 AND g.winner_id IS NOT NULL
    ORDER BY g.completed_at DESC, g.id DESC
  `).all(p1.id, p2.id);
  const totalGames = rows.length;
  const priorRows = Number.isFinite(excludeGameId) ? rows.filter(r=>r.id !== excludeGameId) : rows;
  const previousWinner = priorRows.length ? (priorRows[0].winner_id === p1.id ? name1 : name2) : null;
  return { totalGames, previousWinner };
}

// Around the World progress (docs/archive/achievements-badges-roadmap.md): 63 distinct dart
// outcomes total — 20 numbers x single/double/treble (60), outer bull, double bull,
// and a miss. No new schema; just a DISTINCT scan over darts already stored.
function getAroundTheWorldProgress(playerName) {
  const p = getPlayer(playerName);
  if(!p) return { hit:[], count:0, total:63 };
  // Joins games to apply NOT_HYPOTHETICAL_DARTS — Just Chuckin' It hitting a never-before-hit
  // outcome shouldn't silently complete this X01 achievement's progress.
  const rows = db.prepare(`
    SELECT DISTINCT d.sector AS sector, d.multiplier AS mult
    FROM darts d JOIN turns t ON t.id = d.turn_id JOIN games g ON g.id = t.game_id
    WHERE t.player_id = ? ${NOT_HYPOTHETICAL_DARTS}
  `).all(p.id);
  return { hit: rows, count: rows.length, total: 63 };
}

/* ---------- tournament mode (docs/tournament-mode-roadmap.md, single-elim only) ----------
   Seeding (random shuffle / manual reorder / by lifetime 3-dart average) all happens
   client-side — `players` here is already the final seed order (index 0 = seed 1),
   the same way createGame()'s `players` array order already determines throw order
   with no server-side reordering. */
const TOURNAMENT_X01_CATEGORIES = ['501', '301', '170', '101'];
const TOURNAMENT_MAX_PLAYERS = 128;
// docs/tournament-mode-roadmap.md §7: how many seed slots worse the winner must be
// than the opponent they beat to count as an upset — mirrors the spirit of the H2H
// Giant Slayer's 15-average gap without reusing its exact (average-based) threshold,
// which doesn't apply to a seed number.
const TOURNAMENT_GIANT_SLAYER_SEED_THRESHOLD = 3;

function _nextPowerOfTwo(n) { let p = 1; while (p < n) p *= 2; return p; }

// Standard single-elimination bracket seeding order — recursively expands
// [1,2] -> [1,4,2,3] -> [1,8,4,5,2,7,3,6] -> ..., pairing each existing seed s
// against (size+1-s) at the next size up. Guarantees seed 1 and seed 2 can't meet
// before the final, and (proven by induction on this construction) that byes —
// which only ever occupy seed numbers > player count — never double up in a
// single round-1 match as long as byes < bracketSize/2, which is always true
// since bracketSize is the SMALLEST power of two >= player count.
function _bracketSeedOrder(size) {
  let order = [1, 2];
  while (order.length < size) {
    const s = order.length * 2;
    const next = [];
    for (const seed of order) { next.push(seed); next.push(s + 1 - seed); }
    order = next;
  }
  return order;
}

function _roundLabel(roundsFromFinal, roundNo) {
  if (roundsFromFinal === 0) return 'Final';
  if (roundsFromFinal === 1) return 'Semifinal';
  if (roundsFromFinal === 2) return 'Quarterfinal';
  return `Round ${roundNo}`;
}

// Propagates a match's result: records the winner, marks the loser eliminated,
// fills the winner into the next round's match/slot (or, if there is no next
// match, completes the whole tournament). Called identically whether the result
// came from a played game, an admin-recorded walkover, or a round-1 bye cascading
// forward at generation time — advancement logic doesn't need to know which.
function _advanceTournamentMatch(matchId, winnerId) {
  const match = db.prepare('SELECT * FROM tournament_matches WHERE id = ?').get(matchId);
  if (!match) return;
  // docs/bug-roadmap.md BUG-4: two guards the walkover path already enforces but the
  // game-completion hook path was missing. (a) Never re-advance a match that's already
  // decided — a replayed/forged POST /api/games/:id/complete would otherwise overwrite
  // a settled bracket (even a finished tournament's champion). (b) Never advance a
  // winner who isn't one of this match's two players — a completion naming a
  // non-participant would inject an outsider into the next round or as champion. Skip
  // silently rather than throw: the game itself still completed and recorded stats
  // normally; this completion just doesn't correspond to a valid bracket result.
  // (Generation-time bye advances pass both guards: the bye match has winner_id null,
  // and its winnerId is its one real player.)
  if (match.winner_id != null) return;
  if (winnerId !== match.player1_id && winnerId !== match.player2_id) return;
  const loserId = winnerId === match.player1_id ? match.player2_id : match.player1_id;
  db.prepare('UPDATE tournament_matches SET winner_id = ? WHERE id = ?').run(winnerId, matchId);
  const tournamentId = db.prepare('SELECT tournament_id FROM tournament_rounds WHERE id = ?').get(match.round_id).tournament_id;
  if (loserId != null) {
    db.prepare(`UPDATE tournament_players SET status = 'eliminated' WHERE tournament_id = ? AND player_id = ?`)
      .run(tournamentId, loserId);
    // docs/tournament-mode-roadmap.md §7: Giant Slayer (Tournament) — checked right
    // here rather than a second parallel hook, same reasoning as Champion below.
    // Never fires for a bye (loserId is null, guarded by the enclosing `if`).
    const seedRows = db.prepare(
      `SELECT player_id, seed FROM tournament_players WHERE tournament_id = ? AND player_id IN (?, ?)`
    ).all(tournamentId, winnerId, loserId);
    const winnerSeed = seedRows.find(r => r.player_id === winnerId)?.seed;
    const loserSeed = seedRows.find(r => r.player_id === loserId)?.seed;
    if (winnerSeed != null && loserSeed != null && winnerSeed - loserSeed >= TOURNAMENT_GIANT_SLAYER_SEED_THRESHOLD) {
      const winnerName = db.prepare('SELECT name FROM players WHERE id = ?').get(winnerId)?.name;
      if (winnerName) awardBadge(winnerName, 'tournament_giant_slayer', true);
    }
  }
  if (match.winner_next_match_id) {
    const col = match.winner_next_slot === 1 ? 'player1_id' : 'player2_id';
    db.prepare(`UPDATE tournament_matches SET ${col} = ? WHERE id = ?`).run(winnerId, match.winner_next_match_id);
  } else {
    // No next match — this was the final. The whole tournament is decided.
    db.prepare(`UPDATE tournaments SET status = 'completed', champion_id = ?, runner_up_id = ?, completed_at = datetime('now') WHERE id = ?`)
      .run(winnerId, loserId, tournamentId);
    db.prepare(`UPDATE tournament_players SET status = 'champion' WHERE tournament_id = ? AND player_id = ?`)
      .run(tournamentId, winnerId);
    // docs/tournament-mode-roadmap.md §7: Champion badge, awarded right where
    // champion_id itself is set — not a second parallel hook.
    const championName = db.prepare('SELECT name FROM players WHERE id = ?').get(winnerId)?.name;
    if (championName) awardBadge(championName, 'tournament_champion', true);
  }
}

// players: ordered array of names, index 0 = seed 1. rounds: [{legsPerSet,
// setsPerGame}, ...], earliest round first — must have exactly as many entries
// as the bracket has rounds (ceil(log2(next power of two >= player count))).
function createTournament({ name, category, players, rounds }) {
  name = String(name || '').trim();
  if (!name) throw httpError(400, 'Tournament name is required');
  if (name.length > 64) throw httpError(400, 'Tournament name must be 64 characters or fewer');
  if (!TOURNAMENT_X01_CATEGORIES.includes(String(category))) throw httpError(400, 'category must be one of 501, 301, 170, or 101');
  if (!Array.isArray(players) || players.length < 2) throw httpError(400, 'A tournament needs at least 2 players');
  if (players.length > TOURNAMENT_MAX_PLAYERS) throw httpError(400, `A tournament supports at most ${TOURNAMENT_MAX_PLAYERS} players`);
  const uniqueNames = new Set(players.map(n => String(n).trim().toLowerCase()));
  if (uniqueNames.size !== players.length) throw httpError(400, 'Duplicate players are not allowed');

  const bracketSize = _nextPowerOfTwo(players.length);
  const roundCount = Math.log2(bracketSize);
  if (!Array.isArray(rounds) || rounds.length !== roundCount) {
    throw httpError(400, `rounds must have exactly ${roundCount} entries for ${players.length} players`);
  }
  const cleanRounds = rounds.map((r, i) => {
    const legsPerSet = Number(r.legsPerSet), setsPerGame = Number(r.setsPerGame);
    // docs/bug-roadmap.md BUG-5: reject non-integer or out-of-range formats here (the
    // setup UI never sends one), so a bogus round can't be persisted and then flow into
    // createGame() when the match is started. Upper bound matches MAX_LEGS_OR_SETS.
    if (!Number.isInteger(legsPerSet) || legsPerSet < 1 || legsPerSet > MAX_LEGS_OR_SETS ||
        !Number.isInteger(setsPerGame) || setsPerGame < 1 || setsPerGame > MAX_LEGS_OR_SETS) {
      throw httpError(400, `Round ${i + 1}: legsPerSet/setsPerGame must be integers between 1 and ${MAX_LEGS_OR_SETS}`);
    }
    return { legsPerSet, setsPerGame };
  });

  const playerRows = players.map(n => ensurePlayer(n));

  const tournamentId = Number(db.prepare(
    'INSERT INTO tournaments (name, category, player_count) VALUES (?, ?, ?)'
  ).run(name, String(category), playerRows.length).lastInsertRowid);

  playerRows.forEach((p, i) => {
    db.prepare('INSERT INTO tournament_players (tournament_id, player_id, seed) VALUES (?, ?, ?)')
      .run(tournamentId, p.id, i + 1);
  });

  const roundIds = cleanRounds.map((r, i) => {
    const roundNo = i + 1;
    const label = _roundLabel(roundCount - roundNo, roundNo);
    return Number(db.prepare(
      'INSERT INTO tournament_rounds (tournament_id, round_no, label, legs_per_set, sets_per_game) VALUES (?, ?, ?, ?, ?)'
    ).run(tournamentId, roundNo, label, r.legsPerSet, r.setsPerGame).lastInsertRowid);
  });

  // Build rounds LAST-to-FIRST so every match can point winner_next_match_id at
  // an already-created row in the next round — the final's matches (no next
  // match) are created first, round 1's matches (pointing at round 2) last.
  const matchIdsByRound = new Array(roundCount);
  for (let r = roundCount - 1; r >= 0; r--) {
    const matchesInRound = bracketSize / Math.pow(2, r + 1);
    const ids = [];
    for (let slot = 0; slot < matchesInRound; slot++) {
      let nextMatchId = null, nextSlot = null;
      if (r < roundCount - 1) {
        nextMatchId = matchIdsByRound[r + 1][Math.floor(slot / 2)];
        nextSlot = (slot % 2) + 1;
      }
      const id = Number(db.prepare(
        'INSERT INTO tournament_matches (round_id, slot, winner_next_match_id, winner_next_slot) VALUES (?, ?, ?, ?)'
      ).run(roundIds[r], slot + 1, nextMatchId, nextSlot).lastInsertRowid);
      ids.push(id);
    }
    matchIdsByRound[r] = ids;
  }

  // Fill round 1 from the seed order; a slot whose seed number exceeds the real
  // player count has no player (a bye) — the other side auto-advances immediately.
  const seedSlots = _bracketSeedOrder(bracketSize);
  const seedToPlayerId = {};
  playerRows.forEach((p, i) => { seedToPlayerId[i + 1] = p.id; });

  const round1MatchIds = matchIdsByRound[0];
  const byeAdvances = [];
  for (let m = 0; m < round1MatchIds.length; m++) {
    const playerA = seedToPlayerId[seedSlots[m * 2]] ?? null;
    const playerB = seedToPlayerId[seedSlots[m * 2 + 1]] ?? null;
    const isBye = (playerA == null) !== (playerB == null);
    db.prepare('UPDATE tournament_matches SET player1_id = ?, player2_id = ?, is_bye = ? WHERE id = ?')
      .run(playerA, playerB, isBye ? 1 : 0, round1MatchIds[m]);
    if (isBye) byeAdvances.push([round1MatchIds[m], playerA ?? playerB]);
  }
  // Propagate byes after every round-1 row exists, so a round-2+ match fed by two
  // separate round-1 byes ends up immediately "ready" (both real players known)
  // without either bye needing to reference the other.
  byeAdvances.forEach(([matchId, winnerId]) => _advanceTournamentMatch(matchId, winnerId));

  return { tournamentId };
}

function listTournaments() {
  return db.prepare(`
    SELECT t.id, t.name, t.category, t.status, t.player_count, t.created_at, t.completed_at,
           c.name AS champion_name
    FROM tournaments t LEFT JOIN players c ON c.id = t.champion_id
    ORDER BY t.created_at DESC
  `).all();
}

function getTournament(id) {
  const t = db.prepare(`
    SELECT t.*, c.name AS champion_name, r.name AS runner_up_name
    FROM tournaments t
    LEFT JOIN players c ON c.id = t.champion_id
    LEFT JOIN players r ON r.id = t.runner_up_id
    WHERE t.id = ?
  `).get(Number(id));
  if (!t) return null;

  const matches = db.prepare(`
    SELECT m.id, m.round_id, m.slot, m.is_bye, m.game_id, m.winner_id,
           m.winner_next_match_id, m.winner_next_slot,
           r.round_no, r.label, r.legs_per_set AS legsPerSet, r.sets_per_game AS setsPerGame,
           p1.name AS player1Name, p2.name AS player2Name, w.name AS winnerName
    FROM tournament_matches m
    JOIN tournament_rounds r ON r.id = m.round_id
    LEFT JOIN players p1 ON p1.id = m.player1_id
    LEFT JOIN players p2 ON p2.id = m.player2_id
    LEFT JOIN players w  ON w.id  = m.winner_id
    WHERE r.tournament_id = ?
    ORDER BY r.round_no, m.slot
  `).all(t.id).map(m => ({
    ...m,
    status: m.winner_id != null ? 'complete'
      : (m.game_id != null ? 'in_progress'
        : (m.player1Name != null && m.player2Name != null ? 'ready' : 'pending')),
  }));

  const players = db.prepare(`
    SELECT tp.seed, tp.status, p.name
    FROM tournament_players tp JOIN players p ON p.id = tp.player_id
    WHERE tp.tournament_id = ? ORDER BY tp.seed
  `).all(t.id);

  return { ...t, matches, players };
}

// docs/tournament-mode-roadmap.md §8: Player Profile "Tournaments" stat block —
// wins, runner-up count, and best finish reached, all simple COUNT/MAX-style
// queries against the existing tournament tables, no new derived formula.
function getTournamentStats(playerName) {
  const p = getPlayer(playerName);
  if (!p) return { wins: 0, runnerUps: 0, bestFinish: null };
  const wins = db.prepare('SELECT COUNT(*) AS n FROM tournaments WHERE champion_id = ?').get(p.id).n;
  const runnerUps = db.prepare('SELECT COUNT(*) AS n FROM tournaments WHERE runner_up_id = ?').get(p.id).n;
  // Best finish reached = the furthest round this player was ever placed into
  // (win or loss, including a bye placement) across every tournament they've
  // played, one row per tournament they appear in at all. A player's max
  // round_no within one tournament IS the furthest they reached there, since
  // round N+1 placement only ever happens after winning round N.
  const rows = db.prepare(`
    SELECT tr.tournament_id AS tid, MAX(tr.round_no) AS maxRoundNo,
           (SELECT COUNT(*) FROM tournament_rounds WHERE tournament_id = tr.tournament_id) AS totalRounds
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.id = tm.round_id
    WHERE tm.player1_id = ? OR tm.player2_id = ?
    GROUP BY tr.tournament_id
  `).all(p.id, p.id);
  let bestFinish = null, bestRoundsFromFinal = Infinity;
  for (const r of rows) {
    const roundsFromFinal = r.totalRounds - r.maxRoundNo;
    if (roundsFromFinal < bestRoundsFromFinal) {
      bestRoundsFromFinal = roundsFromFinal;
      bestFinish = _roundLabel(roundsFromFinal, r.maxRoundNo);
    }
  }
  return { wins, runnerUps, bestFinish };
}

// Starts the linked game for a "ready" match (both players known, not already
// started or complete) — reuses createGame() exactly as a normal New Game H2H
// match would, with the round's own configured category/legs/sets.
function startTournamentMatch(matchId) {
  const m = db.prepare(`
    SELECT m.id, m.player1_id, m.player2_id, m.game_id, m.winner_id,
           r.legs_per_set AS legsPerSet, r.sets_per_game AS setsPerGame, t.category
    FROM tournament_matches m
    JOIN tournament_rounds r ON r.id = m.round_id
    JOIN tournaments t ON t.id = r.tournament_id
    WHERE m.id = ?
  `).get(Number(matchId));
  if (!m) throw httpError(404, 'Match not found');
  if (m.player1_id == null || m.player2_id == null) throw httpError(409, 'Match is not ready yet — both players are not yet known');
  if (m.winner_id != null) throw httpError(409, 'Match is already complete');
  if (m.game_id != null) throw httpError(409, 'This match already has a game in progress');
  const p1 = db.prepare('SELECT name, out_mode FROM players WHERE id = ?').get(m.player1_id);
  const p2 = db.prepare('SELECT name, out_mode FROM players WHERE id = ?').get(m.player2_id);
  const { gameId } = createGame({
    category: m.category, legsPerSet: m.legsPerSet, setsPerGame: m.setsPerGame, practice: 0,
    players: [{ name: p1.name, out: p1.out_mode }, { name: p2.name, out: p2.out_mode }],
  });
  db.prepare('UPDATE tournament_matches SET game_id = ? WHERE id = ?').run(gameId, m.id);
  return { gameId };
}

// Records a result without playing it out — covers both "this match was never
// started" and "a game was started but abandoned mid-way" (the roadmap doc's
// requirement that a tournament match can't just be left as a plain unfinished
// game): allowed any time winner_id is still null, regardless of game_id.
function recordWalkover(matchId, winnerName) {
  const m = db.prepare('SELECT * FROM tournament_matches WHERE id = ?').get(Number(matchId));
  if (!m) throw httpError(404, 'Match not found');
  if (m.player1_id == null || m.player2_id == null) throw httpError(409, 'Match is not ready yet — both players are not yet known');
  if (m.winner_id != null) throw httpError(409, 'Match is already complete');
  const w = getPlayer(winnerName);
  if (!w || (w.id !== m.player1_id && w.id !== m.player2_id)) throw httpError(400, "winner must be one of this match's two players");
  _advanceTournamentMatch(m.id, w.id);
  return { ok: true };
}

// Hook: when ANY game completes, check whether it's linked to a tournament match
// and advance the bracket if so — this is the one piece of "tournament mode"
// logic that lives outside this section, registered here rather than editing
// completeGame() directly (docs/archive/existing-app-prep-roadmap.md item 4).
onGameCompleted(({ gameId, winnerName }) => {
  if (!winnerName) return;
  const m = db.prepare('SELECT id FROM tournament_matches WHERE game_id = ?').get(gameId);
  if (!m) return;
  const w = getPlayer(winnerName);
  if (!w) return;
  _advanceTournamentMatch(m.id, w.id);
});

// Player-deletion guard (docs/archive/existing-app-prep-roadmap.md item 6): block
// deleting a player who's still 'active' in an in-progress tournament — the
// bracket depends on that player's future matches existing to advance correctly.
// A player already eliminated, or a completed tournament, is safe to delete from
// (loses only that historical name, same tradeoff already accepted elsewhere —
// e.g. games.winner_id ON DELETE SET NULL).
registerDeletePlayerGuard((player) => {
  const row = db.prepare(`
    SELECT t.name FROM tournament_players tp
    JOIN tournaments t ON t.id = tp.tournament_id
    WHERE tp.player_id = ? AND tp.status = 'active' AND t.status = 'in_progress'
  `).get(player.id);
  return row ? `${player.name} is still active in the in-progress tournament "${row.name}" — eliminate them or finish the tournament before deleting.` : null;
});

/* ---------- league mode (docs/league-mode-roadmap.md, X01 or Cricket) ----------
   A season over which regular casual H2H matches accumulate into a standings table —
   deliberately lighter-weight than tournament mode: any two enrolled players can play
   any casual match any time during the season (no bracket, no pre-determined
   schedule), and every ordinary New-Game-created match that qualifies gets tagged
   automatically via the onGameCreated hook below — no extra step in New Game for the
   common case. A player may be enrolled in multiple concurrent leagues. Standings are
   always computed LIVE from games/game_players (see the schema comment above), never
   from a maintained tally, so there is nothing to keep in sync and nothing that can
   drift. */
const LEAGUE_X01_CATEGORIES = ['501', '301', '170', '101']; // same 4 values as
  // TOURNAMENT_X01_CATEGORIES, kept as its own local list rather than shared so a
  // future Cricket-league extension can diverge from tournament mode's own category
  // set independently.
// Cricket league support: reuses the exact two-value games.category label a Cricket
// H2H game is already tagged with at creation (frontend/index.html), rather than
// inventing a parallel category vocabulary — 'Cricket (15-20, Bull)' for the classic
// preset, 'Custom Cricket' for any custom target set (all custom-number games share
// this one league category; a league doesn't fix the exact target numbers any more
// than an X01 league fixes legs/sets — see docs/league-mode-roadmap.md).
const LEAGUE_CRICKET_CATEGORIES = ['Cricket (15-20, Bull)', 'Custom Cricket'];
const LEAGUE_GAME_TYPES = ['x01', 'cricket'];
function _leagueCategoriesFor(gameType) {
  return gameType === 'cricket' ? LEAGUE_CRICKET_CATEGORIES : LEAGUE_X01_CATEGORIES;
}
const MAX_LEAGUE_NAME_LEN = 64;
const LEAGUE_POINTS_MIN = -99, LEAGUE_POINTS_MAX = 99; // sane bound on an admin-set
  // points formula, same "bound every accepted input" standing practice as
  // createTournament()'s clampMatchFormat().

function _todayDate() { return db.prepare("SELECT date('now') AS d").get().d; }

function _validateLeagueDate(value, label) {
  const s = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw httpError(400, `${label} must be YYYY-MM-DD`);
  return s;
}

function _getLeagueOrThrow(id) {
  const row = db.prepare('SELECT * FROM leagues WHERE id = ?').get(Number(id));
  if (!row) throw httpError(404, 'League not found');
  return row;
}

// Shared by the onGameCreated auto-tag hook below AND the public GET
// /api/leagues/eligible read (getEligibleLeagues) — one place decides "is this
// league a legal auto-tag target for these two players," so the two callers can
// never drift into disagreeing about eligibility.
function _findEligibleLeagues(category, playerIds, gameType) {
  if (!Array.isArray(playerIds) || playerIds.length !== 2) return [];
  const [a, b] = playerIds;
  return db.prepare(`
    SELECT l.id, l.name FROM leagues l
    WHERE l.status = 'active' AND l.category = ? AND l.game_type = ?
      AND date('now') >= l.starts_at AND (l.ends_at IS NULL OR date('now') <= l.ends_at)
      AND EXISTS (SELECT 1 FROM league_players lp WHERE lp.league_id = l.id AND lp.player_id = ?)
      AND EXISTS (SELECT 1 FROM league_players lp WHERE lp.league_id = l.id AND lp.player_id = ?)
  `).all(String(category), gameType === 'cricket' ? 'cricket' : 'x01', a, b);
}

// Public read used by the New Game screen to decide whether to show a "log to which
// league?" picker. Resolves names via getPlayer() — NOT ensurePlayer() — since this
// is a read and must never silently create a player; fails soft to [] for anything
// not fully resolvable (unknown name, missing second name, unknown category), since
// the New Game screen calls this reactively while the admin is still mid-selection
// (same defensive posture as the existing H2H-summary fetch it sits alongside).
function getEligibleLeagues(playerName1, playerName2, category, gameType) {
  const p1 = getPlayer(playerName1), p2 = getPlayer(playerName2);
  if (!p1 || !p2 || !_leagueCategoriesFor(gameType).includes(String(category))) return [];
  return _findEligibleLeagues(category, [p1.id, p2.id], gameType);
}

function createLeague({ name, gameType, category, startsAt, endsAt, pointsWin, pointsLoss, players }) {
  name = String(name || '').trim();
  if (!name) throw httpError(400, 'League name is required');
  if (name.length > MAX_LEAGUE_NAME_LEN) throw httpError(400, `League name must be ${MAX_LEAGUE_NAME_LEN} characters or fewer`);
  const resolvedGameType = (gameType === undefined || gameType === null || gameType === '') ? 'x01' : String(gameType);   // omitted -> 'x01', same default the pre-Cricket schema always had
  if (!LEAGUE_GAME_TYPES.includes(resolvedGameType)) throw httpError(400, `gameType must be one of ${LEAGUE_GAME_TYPES.join(', ')}`);
  const categories = _leagueCategoriesFor(resolvedGameType);
  if (!categories.includes(String(category))) throw httpError(400, `category must be one of ${categories.join(', ')}`);
  const starts = (startsAt !== undefined && startsAt !== null && startsAt !== '') ? _validateLeagueDate(startsAt, 'startsAt') : _todayDate();
  const ends = (endsAt !== undefined && endsAt !== null && endsAt !== '') ? _validateLeagueDate(endsAt, 'endsAt') : null;
  if (ends != null && ends < starts) throw httpError(400, 'endsAt must not be before startsAt');
  const pw = (pointsWin !== undefined && pointsWin !== null && pointsWin !== '') ? Number(pointsWin) : 1;
  const pl = (pointsLoss !== undefined && pointsLoss !== null && pointsLoss !== '') ? Number(pointsLoss) : 0;
  if (!Number.isInteger(pw) || pw < LEAGUE_POINTS_MIN || pw > LEAGUE_POINTS_MAX) throw httpError(400, `pointsWin must be an integer between ${LEAGUE_POINTS_MIN} and ${LEAGUE_POINTS_MAX}`);
  if (!Number.isInteger(pl) || pl < LEAGUE_POINTS_MIN || pl > LEAGUE_POINTS_MAX) throw httpError(400, `pointsLoss must be an integer between ${LEAGUE_POINTS_MIN} and ${LEAGUE_POINTS_MAX}`);
  // Unlike tournament mode, a league needs no minimum player count at creation — an
  // empty league (create first, enroll people over time) is a legitimate season-setup
  // flow, since there's no bracket shape that structurally requires players up front.
  const names = Array.isArray(players) ? players : [];
  const uniqueNames = new Set(names.map(n => String(n).trim().toLowerCase()));
  if (uniqueNames.size !== names.length) throw httpError(400, 'Duplicate players are not allowed');

  const playerRows = names.map(n => ensurePlayer(n));
  const info = db.prepare(`
    INSERT INTO leagues (name, game_type, category, starts_at, ends_at, points_win, points_loss)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, resolvedGameType, String(category), starts, ends, pw, pl);
  const leagueId = Number(info.lastInsertRowid);
  const insertMember = db.prepare('INSERT OR IGNORE INTO league_players (league_id, player_id) VALUES (?, ?)');
  playerRows.forEach(p => insertMember.run(leagueId, p.id));
  return { leagueId };
}

function listLeagues() {
  return db.prepare(`
    SELECT l.id, l.name, l.game_type AS gameType, l.category, l.status, l.starts_at AS startsAt, l.ends_at AS endsAt,
      l.points_win AS pointsWin, l.points_loss AS pointsLoss, l.created_at AS createdAt,
      (SELECT COUNT(*) FROM league_players lp WHERE lp.league_id = l.id) AS playerCount
    FROM leagues l
    ORDER BY (l.status = 'ended'), l.created_at DESC
  `).all();
}

// roster-then-merge, mirroring computeStats()'s own base-row-then-patch-in-aggregate
// idiom: every enrolled player gets a row (played:0 if they haven't played any
// league-tagged game yet), not just players who've already played (unlike e.g.
// getHomeExtra()'s winLeaderboard, which only shows players with played>=1 — a
// season standings table should show the whole roster). Only games with a decided
// winner_id count as played — an abandoned league game completed with a null winner
// (completeGame() allows this) is not a result and must not count either way.
function _computeLeagueStandings(league) {
  const roster = db.prepare(`
    SELECT p.id, p.name FROM league_players lp JOIN players p ON p.id = lp.player_id
    WHERE lp.league_id = ? ORDER BY p.name COLLATE NOCASE
  `).all(league.id);
  const results = db.prepare(`
    SELECT gp.player_id AS pid, COUNT(*) AS played,
      SUM(CASE WHEN g.winner_id = gp.player_id THEN 1 ELSE 0 END) AS won
    FROM game_players gp JOIN games g ON g.id = gp.game_id
    WHERE g.league_id = ? AND g.winner_id IS NOT NULL
    GROUP BY gp.player_id
  `).all(league.id);
  const byId = {}; results.forEach(r => byId[r.pid] = r);
  const table = roster.map(p => {
    const r = byId[p.id] || { played: 0, won: 0 };
    const lost = r.played - r.won;
    const points = r.won * league.points_win + lost * league.points_loss;
    return {
      name: p.name, played: r.played, won: r.won, lost, points,
      winPct: r.played > 0 ? +((r.won / r.played) * 100).toFixed(1) : null,
    };
  });
  // Sort by points desc, then win% desc (a zero-played row's null win% sorts last
  // among equal points via the ?? -1 fallback — a real 0% win rate is still >= -1,
  // so it never gets confused with "hasn't played"), then name for a stable order.
  table.sort((a, b) => b.points - a.points || (b.winPct ?? -1) - (a.winPct ?? -1) || a.name.localeCompare(b.name));
  return table;
}

function getLeagueStandings(leagueId) {
  return _computeLeagueStandings(_getLeagueOrThrow(leagueId));
}

function getLeague(id) {
  const league = db.prepare('SELECT * FROM leagues WHERE id = ?').get(Number(id));
  if (!league) return null;
  return {
    id: league.id, name: league.name, gameType: league.game_type, category: league.category, status: league.status,
    startsAt: league.starts_at, endsAt: league.ends_at,
    pointsWin: league.points_win, pointsLoss: league.points_loss,
    createdAt: league.created_at, endedAt: league.ended_at,
    standings: _computeLeagueStandings(league),
  };
}

function enrollLeaguePlayer(leagueId, playerName) {
  const league = _getLeagueOrThrow(leagueId);
  const p = ensurePlayer(playerName);
  db.prepare('INSERT OR IGNORE INTO league_players (league_id, player_id) VALUES (?, ?)').run(league.id, p.id);
  return { ok: true };
}

function setLeagueStatus(leagueId, status) {
  const league = _getLeagueOrThrow(leagueId);
  if (status !== 'active' && status !== 'ended') throw httpError(400, "status must be 'active' or 'ended'");
  if (status === 'ended') {
    db.prepare("UPDATE leagues SET status = 'ended', ended_at = datetime('now') WHERE id = ?").run(league.id);
  } else {
    // Reopening is supported (a season ended by mistake shouldn't be a dead end) —
    // ends_at still independently gates future auto-tagging regardless of status.
    db.prepare("UPDATE leagues SET status = 'active', ended_at = NULL WHERE id = ?").run(league.id);
  }
  return { ok: true };
}

// Player Profile "Leagues" stat block: every league this player belongs to, plus
// their current rank/points in each — mirrors getTournamentStats()'s role for
// tournament mode, just across every league rather than a single aggregate.
function getPlayerLeagueSummary(playerName) {
  const p = getPlayer(playerName);
  if (!p) return [];
  const leagueIds = db.prepare('SELECT league_id FROM league_players WHERE player_id = ?').all(p.id).map(r => r.league_id);
  return leagueIds.map(id => {
    const league = db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
    const standings = _computeLeagueStandings(league);
    const idx = standings.findIndex(r => r.name === p.name); // names are unique (players.name COLLATE NOCASE UNIQUE)
    const row = idx >= 0 ? standings[idx] : { played: 0, won: 0, lost: 0, points: 0 };
    return {
      leagueId: league.id, name: league.name, gameType: league.game_type, category: league.category, status: league.status,
      rank: idx >= 0 ? idx + 1 : null, totalPlayers: standings.length,
      played: row.played, won: row.won, lost: row.lost, points: row.points,
    };
  }).sort((a, b) => (a.status === 'ended') - (b.status === 'ended') || b.leagueId - a.leagueId);
}

// Hook: whenever a new game is created, check whether it should be tagged into a
// league. See docs/league-mode-roadmap.md and the game-lifecycle-hooks doc comment
// above for the full payload shape and the "explicit choice is re-validated, not
// trusted" reasoning. Fires synchronously inside createGame(), before its HTTP
// response is sent — there's no race between this write and the client seeing the
// new gameId.
onGameCreated(({ gameType, practice, category, playerCount, playerIds, leagueId, gameId }) => {
  // League mode is X01 or Cricket, non-practice, exactly 2 players (Doubles
  // Practice/Chuckin/Checkout Trainer are structurally excluded regardless, being
  // solo/no-winner formats — see docs/league-mode-roadmap.md).
  if ((gameType !== 'x01' && gameType !== 'cricket') || practice || playerCount !== 2 || !Array.isArray(playerIds) || playerIds.length !== 2) return;
  let targetLeagueId = null;
  if (leagueId != null && leagueId !== '') {
    // Client-supplied choice (from the New Game "log to league?" picker, shown only
    // when more than one league was eligible at picker-render time). A few seconds
    // may have passed since the picker's own GET /api/leagues/eligible call, so
    // re-validate rather than trust it — a stale/invalid choice must never fail game
    // creation, just fall through to auto-detection below.
    const candidates = _findEligibleLeagues(category, playerIds, gameType);
    if (candidates.some(c => c.id === Number(leagueId))) targetLeagueId = Number(leagueId);
  }
  if (targetLeagueId == null) {
    const candidates = _findEligibleLeagues(category, playerIds, gameType);
    // Exactly one candidate: auto-tag silently — the common case, no picker was ever
    // shown. Zero or more than one: leave untagged. The New Game picker is meant to
    // have already resolved a >1 ambiguity; a non-frontend API caller that doesn't
    // supply a choice gets no guess.
    if (candidates.length === 1) targetLeagueId = candidates[0].id;
  }
  if (targetLeagueId != null) {
    db.prepare('UPDATE games SET league_id = ? WHERE id = ?').run(targetLeagueId, gameId);
  }
});

/* ---------- dart builder / loadouts (docs/archive/dart-builder-roadmap.md) ----------
   dart_components is a player-owned catalog of parts; loadouts combine exactly one
   component per type plus a tip texture. Every enum field is a closed list for v1
   (the roadmap doc's "closed enum vs free-text escape hatch" open question is
   resolved this way for now — revisit if a real component doesn't fit). */
const BARREL_SHAPES    = ['straight', 'torpedo', 'ton'];
const BARREL_GRIPS     = ['smooth', 'knurled', 'ringed'];
const BARREL_MATERIALS = ['brass', 'nickel_silver', 'tungsten_80', 'tungsten_90', 'tungsten_95', 'tungsten_97'];
const BARREL_LENGTH_RANGES = ['short', 'medium', 'long'];
// Mirrors frontend/index.html's dartWeightOptions() (10g-40g individual values) —
// the same list, now living on the barrel component instead of the player record.
const BARREL_WEIGHTS = Array.from({ length: 31 }, (_, i) => 10 + i);

// Stored in dart_components.shape for shaft rows — "type" not "shape" conceptually
// (fixed/spinning is a mechanical behavior, not a silhouette), but it occupies the
// same one-of-a-fixed-list-per-type slot as barrel/flight shape.
const SHAFT_TYPES     = ['fixed', 'spinning'];
const SHAFT_MATERIALS = ['nylon', 'aluminum', 'titanium', 'polycarbonate', 'carbon_fiber'];
const SHAFT_LENGTH_RANGES = ['short', 'medium', 'long', 'extra_long'];

const FLIGHT_SHAPES    = ['standard', 'slim', 'kite', 'pear'];
const FLIGHT_MATERIALS = ['standard_poly', 'fabric_reinforced'];

const TIP_TEXTURES = ['smooth', 'grooved'];
const COMPONENT_TYPES = ['barrel', 'shaft', 'flight'];
const MAX_COMPONENT_NAME_LEN = 64;
const MAX_LOADOUT_NAME_LEN = 64;
const MAX_COMPONENT_NOTES_LEN = 500;
const MAX_DART_COUNT = 12;

// Single source of truth for every dropdown's option list, so the frontend never
// hardcodes a second copy of an enum that could drift out of sync with validation.
function getDartComponentOptions() {
  return {
    barrel: { shapes: BARREL_SHAPES, grips: BARREL_GRIPS, materials: BARREL_MATERIALS, lengthRanges: BARREL_LENGTH_RANGES, weights: BARREL_WEIGHTS },
    shaft:  { types: SHAFT_TYPES, materials: SHAFT_MATERIALS, lengthRanges: SHAFT_LENGTH_RANGES },
    flight: { shapes: FLIGHT_SHAPES, materials: FLIGHT_MATERIALS },
    tipTextures: TIP_TEXTURES,
  };
}

function validateComponentFields(type, { name, lengthMm, weightG, material, shape, grip, notes } = {}) {
  if (!COMPONENT_TYPES.includes(type)) throw httpError(400, `type must be one of ${COMPONENT_TYPES.join(', ')}`);
  name = String(name || '').trim();
  if (!name) throw httpError(400, 'Component name is required');
  if (name.length > MAX_COMPONENT_NAME_LEN) throw httpError(400, `Component name must be ${MAX_COMPONENT_NAME_LEN} characters or fewer`);

  const lengthRanges = type === 'barrel' ? BARREL_LENGTH_RANGES : type === 'shaft' ? SHAFT_LENGTH_RANGES : null;
  if (lengthMm !== undefined && lengthMm !== null && lengthMm !== '') {
    if (!lengthRanges) throw httpError(400, `length does not apply to a ${type}`);
    if (!lengthRanges.includes(lengthMm)) throw httpError(400, `length must be one of ${lengthRanges.join(', ')}`);
  } else {
    lengthMm = null;
  }

  if (weightG !== undefined && weightG !== null && weightG !== '') {
    if (type !== 'barrel') throw httpError(400, 'weight only applies to a barrel');
    const w = Number(weightG);
    if (!BARREL_WEIGHTS.includes(w)) throw httpError(400, `weight must be between ${BARREL_WEIGHTS[0]} and ${BARREL_WEIGHTS[BARREL_WEIGHTS.length - 1]} grams`);
    weightG = w;
  } else {
    weightG = null;
  }

  const materials = type === 'barrel' ? BARREL_MATERIALS : type === 'shaft' ? SHAFT_MATERIALS : FLIGHT_MATERIALS;
  if (material !== undefined && material !== null && material !== '') {
    if (!materials.includes(material)) throw httpError(400, `material must be one of ${materials.join(', ')}`);
  } else {
    material = null;
  }

  const shapes = type === 'barrel' ? BARREL_SHAPES : type === 'shaft' ? SHAFT_TYPES : FLIGHT_SHAPES;
  if (shape !== undefined && shape !== null && shape !== '') {
    if (!shapes.includes(shape)) throw httpError(400, `shape must be one of ${shapes.join(', ')}`);
  } else {
    shape = null;
  }

  if (grip !== undefined && grip !== null && grip !== '') {
    if (type !== 'barrel') throw httpError(400, 'grip only applies to a barrel');
    if (!BARREL_GRIPS.includes(grip)) throw httpError(400, `grip must be one of ${BARREL_GRIPS.join(', ')}`);
  } else {
    grip = null;
  }

  notes = notes != null ? String(notes).trim() : '';
  if (notes.length > MAX_COMPONENT_NOTES_LEN) throw httpError(400, `notes must be ${MAX_COMPONENT_NOTES_LEN} characters or fewer`);
  notes = notes || null;

  return { name, lengthMm, weightG, material, shape, grip, notes };
}

function _componentRowToObj(r) {
  if (!r) return null;
  return {
    id: r.id, playerId: r.player_id, type: r.type, name: r.name, lengthMm: r.length_mm,
    weightG: r.weight_g, material: r.material, shape: r.shape, grip: r.grip, notes: r.notes,
    createdAt: r.created_at,
  };
}

function createComponent(playerName, type, fields) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');
  const clean = validateComponentFields(type, fields);
  const info = db.prepare(`
    INSERT INTO dart_components (player_id, type, name, length_mm, weight_g, material, shape, grip, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(p.id, type, clean.name, clean.lengthMm, clean.weightG, clean.material, clean.shape, clean.grip, clean.notes);
  return _componentRowToObj(db.prepare('SELECT * FROM dart_components WHERE id = ?').get(Number(info.lastInsertRowid)));
}

function listComponents(playerName, type) {
  const p = getPlayer(playerName);
  if (!p) return [];
  const rows = type
    ? db.prepare('SELECT * FROM dart_components WHERE player_id = ? AND type = ? ORDER BY name COLLATE NOCASE').all(p.id, type)
    : db.prepare('SELECT * FROM dart_components WHERE player_id = ? ORDER BY type, name COLLATE NOCASE').all(p.id);
  return rows.map(_componentRowToObj);
}

function _getOwnedComponent(playerName, componentId) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');
  const row = db.prepare('SELECT * FROM dart_components WHERE id = ?').get(Number(componentId));
  if (!row || row.player_id !== p.id) throw httpError(404, 'Component not found');
  return row;
}

function updateComponent(playerName, componentId, fields) {
  const row = _getOwnedComponent(playerName, componentId);
  const clean = validateComponentFields(row.type, fields);
  db.prepare(`
    UPDATE dart_components SET name=?, length_mm=?, weight_g=?, material=?, shape=?, grip=?, notes=? WHERE id=?
  `).run(clean.name, clean.lengthMm, clean.weightG, clean.material, clean.shape, clean.grip, clean.notes, row.id);
  return _componentRowToObj(db.prepare('SELECT * FROM dart_components WHERE id = ?').get(row.id));
}

// Deleting a component leaves any loadout that referenced it with that slot set
// back to NULL (barrel_id/shaft_id/flight_id are ON DELETE SET NULL) rather than
// deleting the whole loadout — same "loses only that piece" tradeoff already
// accepted elsewhere (e.g. games.winner_id ON DELETE SET NULL).
function deleteComponent(playerName, componentId) {
  const row = _getOwnedComponent(playerName, componentId);
  db.prepare('DELETE FROM dart_components WHERE id = ?').run(row.id);
  return { ok: true };
}

function _getComponentOrNull(id) {
  return id == null ? null : db.prepare('SELECT * FROM dart_components WHERE id = ?').get(id);
}

function _loadoutRowToObj(r) {
  if (!r) return null;
  return {
    id: r.id, playerId: r.player_id, name: r.name,
    barrel: _componentRowToObj(_getComponentOrNull(r.barrel_id)),
    shaft:  _componentRowToObj(_getComponentOrNull(r.shaft_id)),
    flight: _componentRowToObj(_getComponentOrNull(r.flight_id)),
    tipTexture: r.tip_texture, dartCount: r.dart_count, isDefault: !!r.is_default,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function _resolveSlotComponent(playerId, componentId, expectedType) {
  if (componentId === undefined || componentId === null || componentId === '') return null;
  const row = db.prepare('SELECT * FROM dart_components WHERE id = ?').get(Number(componentId));
  if (!row || row.player_id !== playerId) throw httpError(400, `${expectedType} component not found`);
  if (row.type !== expectedType) throw httpError(400, `That component is not a ${expectedType}`);
  return row.id;
}

function validateLoadoutFields(playerId, { name, barrelId, shaftId, flightId, tipTexture, dartCount } = {}) {
  name = String(name || '').trim();
  if (!name) throw httpError(400, 'Loadout name is required');
  if (name.length > MAX_LOADOUT_NAME_LEN) throw httpError(400, `Loadout name must be ${MAX_LOADOUT_NAME_LEN} characters or fewer`);

  const resolvedBarrelId = _resolveSlotComponent(playerId, barrelId, 'barrel');
  const resolvedShaftId  = _resolveSlotComponent(playerId, shaftId, 'shaft');
  const resolvedFlightId = _resolveSlotComponent(playerId, flightId, 'flight');

  if (tipTexture !== undefined && tipTexture !== null && tipTexture !== '') {
    if (!TIP_TEXTURES.includes(tipTexture)) throw httpError(400, `tipTexture must be one of ${TIP_TEXTURES.join(', ')}`);
  } else {
    tipTexture = null;
  }

  let count = (dartCount !== undefined && dartCount !== null && dartCount !== '') ? Math.floor(Number(dartCount)) : 3;
  if (!Number.isFinite(count) || count < 1) count = 3;
  count = Math.min(MAX_DART_COUNT, count);

  return { name, barrelId: resolvedBarrelId, shaftId: resolvedShaftId, flightId: resolvedFlightId, tipTexture, dartCount: count };
}

function createLoadout(playerName, fields) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');
  const clean = validateLoadoutFields(p.id, fields);
  const info = db.prepare(`
    INSERT INTO loadouts (player_id, name, barrel_id, shaft_id, flight_id, tip_texture, dart_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(p.id, clean.name, clean.barrelId, clean.shaftId, clean.flightId, clean.tipTexture, clean.dartCount);
  return _loadoutRowToObj(db.prepare('SELECT * FROM loadouts WHERE id = ?').get(Number(info.lastInsertRowid)));
}

function listLoadouts(playerName) {
  const p = getPlayer(playerName);
  if (!p) return [];
  return db.prepare('SELECT * FROM loadouts WHERE player_id = ? ORDER BY name COLLATE NOCASE').all(p.id).map(_loadoutRowToObj);
}

function _getOwnedLoadout(playerName, loadoutId) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');
  const row = db.prepare('SELECT * FROM loadouts WHERE id = ?').get(Number(loadoutId));
  if (!row || row.player_id !== p.id) throw httpError(404, 'Loadout not found');
  return row;
}

function getLoadout(playerName, loadoutId) {
  return _loadoutRowToObj(_getOwnedLoadout(playerName, loadoutId));
}

function updateLoadout(playerName, loadoutId, fields) {
  const row = _getOwnedLoadout(playerName, loadoutId);
  const clean = validateLoadoutFields(row.player_id, fields);
  db.prepare(`
    UPDATE loadouts SET name=?, barrel_id=?, shaft_id=?, flight_id=?, tip_texture=?, dart_count=?, updated_at=datetime('now')
    WHERE id=?
  `).run(clean.name, clean.barrelId, clean.shaftId, clean.flightId, clean.tipTexture, clean.dartCount, row.id);
  return _loadoutRowToObj(db.prepare('SELECT * FROM loadouts WHERE id = ?').get(row.id));
}

function deleteLoadout(playerName, loadoutId) {
  const row = _getOwnedLoadout(playerName, loadoutId);
  db.prepare('DELETE FROM loadouts WHERE id = ?').run(row.id);
  return { ok: true };
}

function duplicateLoadout(playerName, loadoutId) {
  const row = _getOwnedLoadout(playerName, loadoutId);
  const baseName = `${row.name} (copy)`.slice(0, MAX_LOADOUT_NAME_LEN);
  const info = db.prepare(`
    INSERT INTO loadouts (player_id, name, barrel_id, shaft_id, flight_id, tip_texture, dart_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.player_id, baseName, row.barrel_id, row.shaft_id, row.flight_id, row.tip_texture, row.dart_count);
  return _loadoutRowToObj(db.prepare('SELECT * FROM loadouts WHERE id = ?').get(Number(info.lastInsertRowid)));
}

// Only one loadout per player is ever the default (pre-selected on New Game) —
// setting one clears every other of that player's loadouts in the same operation.
// loadoutId of null/'' clears the default entirely (no loadout pre-selected).
function setDefaultLoadout(playerName, loadoutId) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');
  if (loadoutId === null || loadoutId === undefined || loadoutId === '') {
    db.prepare('UPDATE loadouts SET is_default = 0 WHERE player_id = ?').run(p.id);
    return { ok: true, defaultLoadoutId: null };
  }
  const row = _getOwnedLoadout(playerName, loadoutId);
  db.prepare('UPDATE loadouts SET is_default = 0 WHERE player_id = ?').run(p.id);
  db.prepare('UPDATE loadouts SET is_default = 1 WHERE id = ?').run(row.id);
  return { ok: true, defaultLoadoutId: row.id };
}

function getDefaultLoadout(playerName) {
  const p = getPlayer(playerName);
  if (!p) return null;
  return _loadoutRowToObj(db.prepare('SELECT * FROM loadouts WHERE player_id = ? AND is_default = 1').get(p.id));
}

// Per docs/archive/dart-builder-roadmap.md's "Stats" section: this lives only on the Dart
// Builder screen for the loadout currently open, not as a Player Profile filter.
// No new derived formula — every figure here reuses the exact same computation
// getPlayerStatBubbles() already uses (X01_ONLY 3-dart average, 180 count), just
// scoped down to games where THIS loadout was selected via a game_players join,
// instead of every game the player has ever played.
function getLoadoutStats(playerName, loadoutId) {
  const lo = _getOwnedLoadout(playerName, loadoutId);
  const playerId = lo.player_id;
  // gamesPlayed/wins are anchored on game_players/games directly, NOT turns — a
  // game with zero turns recorded so far (just started, or abandoned immediately)
  // still counts as "played" under this loadout; darts/avg/180s/checkouts below
  // correctly stay at 0 for it since those genuinely require turns/darts to exist.
  // NOT_CHECKOUT_TRAINER on J/JD: dartsThrown/checkouts below are genuine
  // "physically thrown" figures (unlike avgDarts/totalPts, already safe via
  // X01_ONLY) — a Checkout Trainer dart never touched a board and must not
  // inflate a loadout's dart/checkout counts just because it happened to be
  // that player's default loadout at the time.
  const GJ = `FROM game_players gp JOIN games g ON g.id=gp.game_id WHERE gp.player_id=? AND gp.loadout_id=?`;
  const J  = `FROM turns t JOIN games g ON g.id=t.game_id JOIN game_players gp ON gp.game_id=t.game_id AND gp.player_id=t.player_id WHERE t.player_id=? AND gp.loadout_id=? ${NOT_CHECKOUT_TRAINER}`;
  const JD = `FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id JOIN game_players gp ON gp.game_id=t.game_id AND gp.player_id=t.player_id WHERE t.player_id=? AND gp.loadout_id=? ${NOT_CHECKOUT_TRAINER}`;

  const gamesPlayed = db.prepare(`SELECT COUNT(DISTINCT g.id) AS v ${GJ}`).get(playerId, lo.id).v ?? 0;
  const wins = db.prepare(`SELECT COUNT(DISTINCT g.id) AS v ${GJ} AND g.winner_id = ?`).get(playerId, lo.id, playerId).v ?? 0;
  const dartsThrown = db.prepare(`SELECT COUNT(*) AS v ${JD}`).get(playerId, lo.id).v ?? 0;

  const avgDarts = db.prepare(`
    SELECT SUM(adj) AS v FROM (SELECT CASE WHEN t.bust=1 THEN 3 ELSE COUNT(d.id) END AS adj ${JD} ${X01_ONLY} GROUP BY t.id)
  `).get(playerId, lo.id).v ?? 0;
  const totalPts = db.prepare(`SELECT SUM(t.scored) AS v ${J} ${X01_ONLY}`).get(playerId, lo.id).v ?? 0;
  const avg = avgDarts > 0 ? (totalPts / avgDarts * 3) : null;

  const one80s    = db.prepare(`SELECT COUNT(*) AS v ${J} ${X01_ONLY} AND t.scored=180`).get(playerId, lo.id).v ?? 0;
  const checkouts = db.prepare(`SELECT COUNT(*) AS v ${J} AND t.checkout=1`).get(playerId, lo.id).v ?? 0;

  return {
    loadoutId: lo.id, loadoutName: lo.name,
    gamesPlayed, wins, dartsThrown, avg, one80s, checkouts,
  };
}

/* ---------- helpers ---------- */
function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}

// Self-heal on boot: older versions of deletePlayer() left a `games` row
// behind once every one of its participants had been deleted. Clean up any
// that are already sitting in the database.
pruneOrphanedGames();

module.exports = {
  listPlayers, addPlayer, renamePlayer, setOut, setDartWeight, deletePlayer, registerDeletePlayerGuard,
  createGame, addTurn, completeGame, recordEvent,
  onGameCreated, onGameCompleted,
  logServerError, getServerErrors,
  computeStats, getSummary, getHomeExtra, getOneEightyStats, getBigFishStats, getNineDarterStats,
  getPlayerStatBubbles, getMetricHistory, getPersonalBests, getH2HRecord,
  getGhostCandidateLegs, getGhostLegScript,
  getCricketStatBubbles, getCricketNineMarksStats, getCricketPersonalBests,
  getCricketMprLeaderboard, getCricketWinLeaderboard, getCricketPerfectLegStats,
  getDoublesPracticeStatBubbles, getDoublesPracticePersonalBests,
  getDoublesPracticeAccuracyLeaderboard, getDoublesPracticeBestRoundStats,
  getChuckinStatBubbles, getChuckinPersonalBests, getChuckinHeatmap, getDartHeatmap, getBounceOutCount,
  getCheckoutTrainerStatBubbles, getCheckoutTrainerPersonalBests,
  getCheckoutBlitzLeaderboard, getCheckoutBlitzPersonalStats,
  getAroundTheClockStatBubbles, getAroundTheClockPersonalBests,
  getAroundTheClockFastestLeaderboard, getAroundTheClockCompletionsLeaderboard,
  getAroundTheWorldDrillStatBubbles, getAroundTheWorldPersonalBests, getAroundTheWorldLeaderboard,
  getTopFinishes, getTopFinishesAll, getDartWeights, clearPlayerStats, resetStats, wipeAllData, deleteLastTurn, getFullDatabaseExport,
  getOnThisDay,
  getCheckoutRoutes, getDartAnalytics, getCoachingInsights,
  getSettings, updateSettings, getDartTimingEnabled, getScoreboardLayout, getDefaultScoringInput, getColorblindMode, getVoiceAnnouncementSettings, getCardTagline, fireHaWebhook,
  isSetupRequired, createFirstAdmin, createAdmin, listAdmins, deleteAdmin, changeAdminPassword, clearAdminLockout,
  login, logout, getSessionAdmin, adminLockoutDelayMs, verifyAdminPassword, backupRetentionDays,
  setPlayerPin, removePlayerPin, verifyPlayerPin, pinLockoutThreshold,
  awardBadge, revokeBadge, getPlayerBadges, getH2HSummary, getAroundTheWorldProgress,
  startChallengeAttempt, completeChallengeAttempt, getChallengeStatus, getChallengeHistory, resetChallengeAttempt,
  createTournament, listTournaments, getTournament, startTournamentMatch, recordWalkover, getTournamentStats,
  createLeague, listLeagues, getLeague, getLeagueStandings, enrollLeaguePlayer, setLeagueStatus,
  getPlayerLeagueSummary, getEligibleLeagues,
  getDartComponentOptions,
  createComponent, listComponents, updateComponent, deleteComponent,
  createLoadout, listLoadouts, getLoadout, updateLoadout, deleteLoadout, duplicateLoadout,
  setDefaultLoadout, getDefaultLoadout, getLoadoutStats,
  recordGhostRace, getGhostRaceRecord,
  _db: db,
};
