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
const crypto = require('crypto');
const auth = require('./auth.js');
const netguard = require('./netguard.js');
const backupLib = require('./backup-lib.js');
const { checkoutHint, dartLabel,
  rebuildX01State, rebuildCricketState, rebuildBaseballState,
  rebuildAroundTheClockState, rebuildAroundTheWorldState, rebuildBobs27State,
  rebuildCheckoutLadderState,
  GAUNTLET_STATION_ORDER, gauntletTotalScars, gauntletResultTier, rebuildGauntletState,
  KILLER_DEFAULT_LIVES, assignKillerNumbers, evaluateDartKiller, rebuildKillerState,
  computeFatigueSplit, classifyMarathonTrend,
  shanghaiRoundTarget, evaluateVisitShanghai, rebuildShanghaiState,
  HALVE_IT_DEFAULT_TARGETS, halveItRoundTarget, halveItDartValue, rebuildHalveItState,
  deadManWalkingBandFor, deadManWalkingParForTarget, pickDeadManWalkingTargets,
  rebuildDeadManWalkingState, deadManWalkingResultTier, CHALLENGE_CHECKOUTS,
  makeDartCore, PRESSURE_ROUNDS, generatePressureCard, computePressureRoundResult,
  pressureMissPenaltyForCard, pressureComposureRating, rebuildPressureChamberState,
  doubleElimStructure } = require('../frontend/scoring.js');

const DB_PATH = process.env.DARTS_DB || path.join(__dirname, '..', 'data', 'darts.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// docs/bug-roadmap.md BUG-11: apply any restore staged via the Settings "Restore
// backup" flow BEFORE opening the live database connection below — see
// backup-lib.js's applyPendingRestoreIfAny() for why this ordering is what makes the
// swap safe (nothing can be mid-write against DB_PATH at a point before it's ever
// been opened this process).
if (backupLib.applyPendingRestoreIfAny()) {
  console.log(`[oche] Applied a pending database restore from ${backupLib.RESTORE_PENDING_PATH}`);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    out_mode   TEXT NOT NULL DEFAULT 'double' CHECK (out_mode IN ('double','single')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- docs/archive/data-export-roadmap.md: a portable identity for per-player export/import.
    -- Unlike the autoincrement id (guaranteed to collide across independently-run
    -- servers, since every fresh install starts counting from 1), a v4 UUID needs
    -- no coordination between servers to stay unique -- that's the whole point of
    -- using one here. Backfilled for pre-existing rows below (ALTER TABLE block).
    uuid       TEXT
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

  -- Daily Challenge attempts (docs/archive/daily-challenge-roadmap.md). Per the games-context
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

  -- Tournament mode (docs/archive/tournament-mode-roadmap.md), single-elimination only —
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

  -- League mode (docs/archive/league-mode-roadmap.md), X01 only for v1. Unlike tournament mode,
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

  -- League fixtures / pending matches (docs/archive/league-mode-roadmap.md "League fixtures /
  -- pending matches"). Unlike a plain league game (tagged after the fact via the
  -- direct games.league_id column above), a fixture is a scheduled-but-maybe-unplayed
  -- pairing that needs to exist BEFORE any game does -- so, per CLAUDE.md's "own table
  -- with a game_id FK" convention, this follows tournament_matches' shape instead:
  -- its own table with a nullable game_id FK. No stored status column, matching
  -- tournament_matches' own "derive it, don't store it" precedent -- pending while
  -- game_id IS NULL, in progress once linked but the game isn't complete yet, fulfilled
  -- once it is (see getLeagueFixtures()/getPendingFixturesForPlayers()). player1_id is
  -- always the lower player id of the pair (canonical order, chosen at generation time)
  -- so a lookup never has to try both orderings. Single round-robin only for v1 (a
  -- return-match "double round-robin" is a resolved-for-now open question, see the
  -- roadmap doc) -- generated once per unique pair, at league creation for the initial
  -- roster and again for just the new pairings whenever a player joins an
  -- already-active league (_generateRoundRobinFixtures()). No admin-driven manual
  -- fixture creation/cancellation in v1 -- round-robin generation is the only source.
  CREATE TABLE IF NOT EXISTS league_fixtures (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id  INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    player1_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    player2_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_id    INTEGER REFERENCES games(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_league_fixtures_league  ON league_fixtures(league_id);
  CREATE INDEX IF NOT EXISTS idx_league_fixtures_game    ON league_fixtures(game_id);
  CREATE INDEX IF NOT EXISTS idx_league_fixtures_players ON league_fixtures(player1_id, player2_id);

  -- Saved games / pause & resume (docs/archive/saved-games-roadmap.md). "This game is
  -- paused" is the only new fact — per CLAUDE.md's "context table, never a
  -- boolean on games" convention, same tournament_matches/league_fixtures shape,
  -- just with a UNIQUE + CASCADE game_id instead of a nullable + SET NULL one:
  -- a saved game always points at exactly one real games row, and deleting that
  -- row (a total wipe, a stats reset) should take the pause state with it rather
  -- than leaving a dangling saved_games row. Everything needed to actually resume
  -- (scores, marks, innings, legs/sets, whose turn) is DERIVED from the turns/
  -- darts already recorded live — no snapshot blob, no schema-versioned client
  -- state to drift; see getResumeState()'s own comment for the replay-not-
  -- snapshot rebuild.
  CREATE TABLE IF NOT EXISTS saved_games (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id   INTEGER NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
    saved_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

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

  -- Player merge (docs/archive/player-merge-roadmap.md): when mergePlayers() absorbs one
  -- player row into another, the deleted source row's uuid is recorded here pointing
  -- at the surviving player, so importPlayerExport()'s resolveStub() can still
  -- resolve an OLD export (from another server, still carrying the merged-away
  -- uuid) onto the surviving row instead of silently recreating a duplicate stub —
  -- without this, the merge tool and the import feature actively work against each
  -- other over time. A merge also REPOINTS any aliases already targeting the source
  -- (a chained merge A->B then B->C leaves A's alias pointing at C), so an alias
  -- always resolves to a live players row in one hop. ON DELETE CASCADE: if the
  -- surviving player is ever genuinely deleted, their accumulated aliases go too.
  CREATE TABLE IF NOT EXISTS player_uuid_aliases (
    uuid       TEXT PRIMARY KEY,
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    merged_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_uuid_aliases_player ON player_uuid_aliases(player_id);

  -- Marathon Mode (docs/archive/marathon-mode-roadmap.md) — the same "context table with a
  -- game_id FK" pattern league_fixtures already established (CLAUDE.md's standing
  -- convention), NOT a new game_type: every leg is a completely ordinary solo
  -- practice 501 game, contributing to lifetime X01 stats exactly like any other
  -- practice leg. ended_at NULL means the session is still in progress (mirrors
  -- games.completed_at's own nullable-lifecycle-marker shape).
  CREATE TABLE IF NOT EXISTS marathon_sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id        INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    duration_minutes INTEGER NOT NULL DEFAULT 45,
    started_at       TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at         TEXT
  );
  -- game_id is only ever populated by startMarathonSession()/startNextMarathonLeg()
  -- themselves (they create the underlying game server-side and link it in the same
  -- call) — no endpoint ever accepts a client-supplied game_id to link, so the
  -- roadmap doc's own flagged worry about validating an externally-supplied game_id
  -- never actually applies here.
  CREATE TABLE IF NOT EXISTS marathon_session_legs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES marathon_sessions(id) ON DELETE CASCADE,
    game_id    INTEGER REFERENCES games(id) ON DELETE SET NULL,
    leg_order  INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_marathon_session_legs_session ON marathon_session_legs(session_id);
  CREATE INDEX IF NOT EXISTS idx_marathon_session_legs_game    ON marathon_session_legs(game_id);
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
// Checkout Trainer (docs/archive/checkout-trainer-roadmap.md): the target score given for
// that round. Unlike X01 there's no persistent "remaining score" game state to
// derive it from afterward, so it has to be stored per-turn. Only ever populated
// for game_type='checkout_trainer'; every other game type leaves it NULL.
try { db.exec('ALTER TABLE turns ADD COLUMN target_score INTEGER'); } catch(e) {}
// Checkout Trainer trick questions (docs/archive/checkout-trainer-roadmap.md "Trick-question
// difficulty variant"): 1 marks a round answered by declaring "no possible checkout"
// instead of tapping out darts — the only turn shape allowed to carry zero dart rows
// (see addTurn()'s declaredUnsolvable branch). The grading outcome still lives on
// the same bust/checkout/leg_won three-way every stat already reads (correct
// declaration -> checkout=1,leg_won=1; wrong -> bust=1); this flag exists so the
// queries that specifically mean "a real checkout was solved" (toughest-checkout
// Personal Best) can exclude declarations — correctly calling 169 a bogey is not
// the same feat as actually finishing from 169. Defaults to 0 for every existing
// row and every other game type's write path.
try { db.exec('ALTER TABLE turns ADD COLUMN declared_unsolvable INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
// Killer (docs/game-modes-roadmap.md "Killer"): which player, if any, had
// their own life total change because of THIS dart — the one game type where a
// single dart can affect a DIFFERENT player than the one who threw it (an attack).
// NULL means the dart changed nothing at all; equal to the thrower's own player_id
// means a self-effect (building toward killer, or a self-kill); any other player_id
// means an attack landed on that opponent. `scored` stays the plain non-negative
// magnitude of the change (0-3) either way — the direction (gain vs loss) is
// derived by replay (rebuildKillerState(), frontend/scoring.js), never stored,
// same "derive the special case, don't pre-compute it" shape Halve-It/Gauntlet use.
try { db.exec('ALTER TABLE turns ADD COLUMN affected_player_id INTEGER'); } catch(e) {}
// The Pressure Chamber self-declare honesty mechanic (docs/archive/pressure-chamber-roadmap.md
// build-order step 10): the player's SELF-DECLARED hit/miss call for this round,
// made BEFORE their actual darts are read off the board — 1 = "I'll hit it",
// 0 = "I'll miss". NULL for every turn that carries no declaration at all (every
// other game type, and any pre-existing Pressure Chamber turn recorded before this
// mechanic shipped). Explicitly NOT a scoring input and carries no leaderboard
// weight — it feeds only the informational Honesty% stat, which compares the
// declaration against the round's real bust/checkout outcome at read time. The
// server can never verify the declaration was truly made before verifying (a
// determined client can submit one matching the outcome in hindsight), so unlike
// every other new column there is no consistency guard for it — it is an
// honor-system self-discipline signal by design. Purely additive, same pattern as
// target_score/declared_unsolvable/affected_player_id above.
try { db.exec('ALTER TABLE turns ADD COLUMN declared_hit INTEGER'); } catch(e) {}
// player_count is the participant count captured once at game creation. H2H-vs-practice
// classification reads THIS instead of a live COUNT(game_players) subquery, so deleting
// or resetting a player can never retroactively reclassify a game (a 2-player H2H game
// stays H2H even after one participant is removed). Backfilled for existing rows below.
try { db.exec('ALTER TABLE games ADD COLUMN player_count INTEGER'); } catch(e) {}
// Dart Builder (docs/archive/dart-builder-roadmap.md): resolved once at game creation and
// snapshotted, same reasoning already applied to game_players.dart_weight/out_mode —
// renaming/deleting a loadout later never rewrites a past game's history.
try { db.exec('ALTER TABLE game_players ADD COLUMN loadout_id INTEGER REFERENCES loadouts(id) ON DELETE SET NULL'); } catch(e) {}
// League mode (docs/archive/league-mode-roadmap.md): nullable, set by the onGameCreated
// auto-tag hook below (or left NULL for any game that isn't a tagged league match).
try { db.exec('ALTER TABLE games ADD COLUMN league_id INTEGER REFERENCES leagues(id) ON DELETE SET NULL'); } catch(e) {}
// Handicapping (docs/archive/rating-and-handicap-roadmap.md Part B): a per-player,
// per-game starting-score override — NULL (the default for every existing
// row and every game that doesn't use it) means "the game's own
// config.startingScore", the same snapshot-column shape out_mode/dart_weight/
// loadout_id already use above. Added here (ahead of Part B's own UI/engine
// work) because getEloRatings() (Part A) already needs to query it to
// exclude handicapped games from the rating walk — see that function's own
// comment.
try { db.exec('ALTER TABLE game_players ADD COLUMN start_score INTEGER'); } catch(e) {}
// League mode Cricket support (docs/archive/league-mode-roadmap.md): a second game type
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
// docs/archive/data-export-roadmap.md: portable per-player identity for export/import (see
// the players table comment above). The ALTER TABLE is required here, unlike some
// other columns in this block -- CREATE TABLE IF NOT EXISTS above only takes effect
// on a genuinely fresh database; an existing installation's players table already
// exists (without this column) and needs this explicit ADD COLUMN to get it at all.
// Unlike every other backfill in this block, each row also needs a DISTINCT
// generated value, so the backfill itself can't be a single UPDATE statement --
// looped in JS instead, same as any other "one random value per row" migration
// would have to be.
try { db.exec('ALTER TABLE players ADD COLUMN uuid TEXT'); } catch (e) {}
{
  const unassigned = db.prepare('SELECT id FROM players WHERE uuid IS NULL').all();
  if (unassigned.length) {
    const setUuid = db.prepare('UPDATE players SET uuid = ? WHERE id = ?');
    for (const row of unassigned) setUuid.run(crypto.randomUUID(), row.id);
  }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_players_uuid ON players(uuid)');
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
  insertPlayer : db.prepare("INSERT INTO players (name, out_mode, uuid) VALUES (?, ?, ?)"),
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
  gameTypeById : db.prepare('SELECT game_type FROM games WHERE id = ?'),
  addParticipant: db.prepare('INSERT OR IGNORE INTO game_players (game_id, player_id, dart_weight, out_mode, loadout_id, start_score) VALUES (?, ?, ?, ?, ?, ?)'),
  completeGame : db.prepare("UPDATE games SET completed_at = datetime('now'), winner_id = ? WHERE id = ?"),

  insertTurn   : db.prepare(`INSERT INTO turns
                   (game_id, player_id, set_no, leg_no, scored, bust, checkout, checkout_points, leg_won, target_score, declared_unsolvable, affected_player_id, declared_hit)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),

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
  q.insertPlayer.run(name, out === 'single' ? 'single' : 'double', crypto.randomUUID());
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
  q.insertPlayer.run(name, out === 'single' ? 'single' : 'double', crypto.randomUUID());
  if (opts.pin) await setPlayerPin(name, opts.pin);
  if (opts.dartWeight !== undefined && opts.dartWeight !== null && opts.dartWeight !== '') {
    setDartWeight(name, opts.dartWeight);
  }
  const p = getPlayer(name);
  return { name, out: out === 'single' ? 'single' : 'double', hasPin: !!p.pin_hash, dartWeight: p.dart_weight ?? null };
}

// Killer's number assignment lives in games.config keyed by player NAME
// (docs/game-modes-roadmap.md "Killer"), while every replay path
// (_killerLegOutcomesForPlayer(), rebuildKillerState(), the addTurn guard) looks
// players up by their CURRENT name — so any operation that changes a player's
// name (rename, merge, import onto a differently-named local row) must rewrite
// the stored config key in the same change, or every past killer game's
// assignment is orphaned and the player's whole participation replays as inert
// (zero kills/lives for them AND their opponents). The two primitives below are
// the ONLY way any path reads or rewrites that map — one guard and one key-move
// instead of a hand-rolled copy per call site.
function _parseKillerConfig(json) {
  if (!json) return null;
  let cfg;
  try { cfg = JSON.parse(json); } catch { return null; }
  return (cfg && cfg.numbers) ? cfg : null;
}
// Returns true when the move changed anything. Equal ids are a no-op by
// construction (object keys are always strings once round-tripped through
// JSON, so both sides are coerced here rather than trusting the caller).
function _moveKillerNumberKey(cfg, fromId, toId) {
  fromId = String(fromId); toId = String(toId);
  if (fromId === toId || !Object.prototype.hasOwnProperty.call(cfg.numbers, fromId)) return false;
  cfg.numbers[toId] = cfg.numbers[fromId];
  delete cfg.numbers[fromId];
  return true;
}
// mergePlayers()'s own compensator (item 43, docs/code-quality-roadmap.md):
// game_players.player_id has already been reassigned from source.id to
// playerId (== target.id) by the time this runs, but the killer config's
// stored key is still oldId (== source.id) — move it to match, or the merged
// history replays with an orphaned assignment. Renaming a player no longer
// needs an equivalent: config.numbers is keyed by the immutable players.id
// now, so a rename alone can never orphan it (unlike the old name-keyed
// scheme, which needed this same rewrite on every rename too).
function _rewriteKillerConfigIds(playerId, oldId) {
  if (oldId === playerId) return;
  const rows = db.prepare(`
    SELECT g.id, g.config FROM games g
      JOIN game_players gp ON gp.game_id = g.id
     WHERE gp.player_id = ? AND g.game_type = 'killer' AND g.config IS NOT NULL`).all(playerId);
  const upd = db.prepare('UPDATE games SET config = ? WHERE id = ?');
  for (const row of rows) {
    const cfg = _parseKillerConfig(row.config);
    if (cfg && _moveKillerNumberKey(cfg, oldId, playerId)) upd.run(JSON.stringify(cfg), row.id);
  }
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

   League mode (docs/archive/league-mode-roadmap.md) deliberately registers NO guard, even
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
   hook below (docs/archive/league-mode-roadmap.md) — playerIds is createGame()'s
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

// Deduped participant-name list (truthy name, first-occurrence order, exact
// string compare) — shared by every createGame() branch that validates or keys
// on the roster (Killer's number assignment, DMW's solo check).
function _uniquePlayerNames(players) {
  return [...new Set((players || []).map(e => e.name).filter(Boolean))];
}

function createGame({ category, legsPerSet, setsPerGame, players, practice, gameType, config, leagueId, leagueFixtureId }) {
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
  // League fixtures (docs/archive/league-mode-roadmap.md "League fixtures / pending matches"):
  // unlike leagueId below (a hint the onGameCreated hook re-validates and silently
  // falls through on staleness), choosing a specific fixture is an explicit, not an
  // inferred, choice — so it's fully validated up front and a stale/mismatched one
  // REJECTS game creation rather than quietly creating an untracked casual game the
  // caller didn't ask for.
  let fixture = null;
  if (leagueFixtureId != null && leagueFixtureId !== '') {
    fixture = db.prepare('SELECT * FROM league_fixtures WHERE id = ?').get(Number(leagueFixtureId));
    if (!fixture) throw httpError(404, 'League fixture not found');
    if (fixture.game_id != null) throw httpError(409, 'This fixture already has a game linked to it');
    const league = db.prepare('SELECT * FROM leagues WHERE id = ?').get(fixture.league_id);
    if (league.game_type !== resolvedGameType || league.category !== categoryStr) {
      throw httpError(400, "gameType/category must match the fixture's league");
    }
    const givenIds = (players || []).map(entry => ensurePlayer(entry.name).id);
    const fixtureIds = [fixture.player1_id, fixture.player2_id];
    const samePair = givenIds.length === 2 && fixtureIds.every(id => givenIds.includes(id)) && givenIds.every(id => fixtureIds.includes(id));
    if (!samePair) throw httpError(400, 'The selected players do not match this fixture');
  }
  // docs/archive/checkout-drill-link-roadmap.md "Drill this checkout": pinnedTarget rides
  // games.config through this same path unchanged — validate it server-side like
  // any other config field reaching this function from an untrusted client,
  // independent of whatever the setup screen already enforces client-side.
  if (resolvedGameType === 'checkout_trainer' && config && config.pinnedTarget != null) {
    const pin = Number(config.pinnedTarget);
    if (!Number.isInteger(pin) || pin < 2 || pin > 170) {
      throw httpError(400, 'pinnedTarget must be an integer between 2 and 170');
    }
  }
  // docs/archive/cutthroat-cricket-roadmap.md: same "validate a config field reaching this
  // function from an untrusted client" precedent as pinnedTarget above — an
  // unrecognized value would otherwise ride into games.config as-is and be silently
  // treated as 'standard' by evaluateVisitCricket()'s own `=== 'cutthroat'` check,
  // which is a confusing way to fail rather than an explicit rejection.
  if (resolvedGameType === 'cricket' && config && config.variant != null && !['standard', 'cutthroat'].includes(config.variant)) {
    throw httpError(400, "variant must be 'standard' or 'cutthroat'");
  }
  // Halve-It custom target editor (docs/archive/halve-it-roadmap.md "Custom target editor"):
  // config.targets rides in from the untrusted client just like cricket's variant/
  // numbers above, and both the write-time consistency guard (addTurn) and the
  // saved-game replay derive each round's expected points from it — so a malformed
  // entry (a non-existent sector, an unhittable ring, a wrong shape) must be rejected
  // here, not silently stored. Absent config.targets keeps the classic default
  // (HALVE_IT_DEFAULT_TARGETS). Each entry is { sector: 1-20 or 25, ring?: 'single' |
  // 'double' | 'treble' }; a treble on the Bull (25) can never be hit (no treble-bull
  // ring exists) so it's rejected as an unwinnable round. Length is bounded 1-20, the
  // same ceiling Shanghai's long-form uses.
  if (resolvedGameType === 'halve_it' && config && config.targets != null) {
    const t = config.targets;
    if (!Array.isArray(t) || t.length < 1 || t.length > 20) {
      throw httpError(400, 'targets must be an array of 1 to 20 rounds');
    }
    for (const entry of t) {
      if (!entry || typeof entry !== 'object') throw httpError(400, 'each target must be an object');
      const sector = Number(entry.sector);
      if (!Number.isInteger(sector) || !((sector >= 1 && sector <= 20) || sector === 25)) {
        throw httpError(400, 'each target sector must be an integer 1-20 or 25 (Bull)');
      }
      if (entry.ring != null && !['single', 'double', 'treble'].includes(entry.ring)) {
        throw httpError(400, "target ring must be 'single', 'double', or 'treble'");
      }
      if (sector === 25 && entry.ring === 'treble') {
        throw httpError(400, 'the Bull has no treble ring — a treble-25 round can never be won');
      }
    }
    // Normalize to exactly {sector} or {sector, ring} so no extra client-supplied field
    // rides into games.config — the server owns the stored shape.
    config.targets = t.map(e => e.ring != null
      ? { sector: Number(e.sector), ring: e.ring }
      : { sector: Number(e.sector) });
  }
  // Killer (docs/game-modes-roadmap.md "Killer"): the become-a-killer
  // lives threshold is a New Game option (validated here, same as every other
  // config field reaching this function from an untrusted client), but the
  // per-player number ASSIGNMENT is never trusted from the client at all — a
  // hostile submission could otherwise hand itself a favorable matchup.
  // Assigned here, server-side, once per match (not re-derived per leg — every
  // leg of this same game reuses this same assignment).
  //
  // Stored keyed by players.id (item 43, docs/code-quality-roadmap.md) — an
  // immutable identifier a later rename/merge can't orphan, unlike the old
  // name-keyed scheme this replaces. The client only ever models players by
  // name and has no other reason to learn ids, so killerNumbersForClient
  // below translates back to {name: number} purely for this one-shot
  // createGame() response; nothing else about the frontend changes.
  let killerConfig = null;
  let killerNumbersForClient = null;
  if (resolvedGameType === 'killer') {
    const names = _uniquePlayerNames(players);
    if (names.length < 2) throw httpError(400, 'Killer requires at least 2 players');
    let lives = KILLER_DEFAULT_LIVES;
    if (config && config.lives != null) {
      lives = Number(config.lives);
      if (!Number.isInteger(lives) || lives < 1 || lives > 20) throw httpError(400, 'lives must be an integer between 1 and 20');
    }
    const ids = names.map(n => ensurePlayer(n).id);
    const numbers = assignKillerNumbers(ids);
    killerConfig = { lives, numbers };
    killerNumbersForClient = {};
    names.forEach((n, i) => { killerNumbersForClient[n] = numbers[ids[i]]; });
  }
  // Dead Man Walking (docs/archive/dead-man-walking-roadmap.md "Data model" /
  // "Server-authoritative round generation"): config.rounds — the frozen
  // array of 15 {target, par} pairs — is computed HERE, server-side, from a
  // live snapshot of this specific player's own X01 history, and NEVER
  // accepted from the client at all (unlike killerConfig above, there isn't
  // even a client-supplied field to validate against; any config the request
  // body carries for this game type is simply ignored). A hostile client
  // choosing its own easy targets/generous pars for itself is exactly what
  // this closes off — the real security requirement this doc calls out by
  // name, not just tidiness.
  let dmwConfig = null;
  if (resolvedGameType === 'dead_man_walking') {
    const names = _uniquePlayerNames(players);
    if (names.length !== 1) throw httpError(400, 'Dead Man Walking is solo only');
    dmwConfig = { rounds: _buildDeadManWalkingRounds(names[0]) };
  }
  // The Pressure Chamber (docs/archive/pressure-chamber-roadmap.md): rounds is fixed
  // at 15, never a client choice — overridden server-side the same way
  // Killer's number assignment is above, so a hostile client can't submit a
  // shorter/longer run that generatePressureCard()'s own round-index math
  // (and the PRESSURE_ROUNDS-capped write-time guard) wasn't built for.
  const pressureChamberConfig = resolvedGameType === 'pressure_chamber' ? { rounds: PRESSURE_ROUNDS } : null;
  const resolvedConfig = killerConfig ? JSON.stringify(killerConfig)
    : dmwConfig ? JSON.stringify(dmwConfig)
    : pressureChamberConfig ? JSON.stringify(pressureChamberConfig)
    : config ? JSON.stringify(config) : JSON.stringify({ startingScore: Number(category) || null });
  if (Buffer.byteLength(resolvedConfig) > 4096) throw httpError(400, 'config is too large');
  // Handicapping (docs/archive/rating-and-handicap-roadmap.md Part B): validated here,
  // server-side, the same "never trust the client's own eligibility check"
  // precedent pinnedTarget/cricket variant already establish above — a
  // hostile client could otherwise create a 2-point-start farm for win-rate
  // stats. X01 only (the setup screen never offers this outside X01); must be
  // strictly less than the game's own category (equal-or-above isn't a real
  // handicap, and would otherwise still wrongly exclude this player from Elo/
  // nine-darter/fewest-darts credit for a game they didn't actually shorten);
  // 101 is the lowest starting score this app supports at all.
  const categoryNum = Number(category);
  (players || []).forEach(entry => {
    if (entry.startScore == null) return;
    if (resolvedGameType !== 'x01') throw httpError(400, 'startScore is only valid for X01 games');
    const s = Number(entry.startScore);
    if (!Number.isInteger(s) || s < 101 || s >= categoryNum) {
      throw httpError(400, `startScore must be an integer between 101 and ${categoryNum - 1}`);
    }
  });
  const info = q.insertGame.run(categoryStr, clampMatchFormat(legsPerSet), clampMatchFormat(setsPerGame), practice ? 1 : 0, resolvedGameType, resolvedConfig);
  const gameId = Number(info.lastInsertRowid);
  // participantIds (submission order, not deduped — see the player_count freeze below
  // for the deduped count) is threaded into the 'created' hook payload so a listener
  // (currently only league mode's auto-tag hook) can look up "who played this game"
  // without a second query — see docs/archive/league-mode-roadmap.md.
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
    // Handicapping (docs/archive/rating-and-handicap-roadmap.md Part B): a per-player
    // starting-score override for this one game, X01 only. NULL means "use
    // the game's own config.startingScore" — see game_players.start_score's
    // own migration comment. Already validated (range, X01-only) in the loop
    // above, before any row is written.
    const startScore = entry.startScore != null ? Number(entry.startScore) : null;
    q.addParticipant.run(gameId, p.id, weight, out, loadout ? loadout.id : null, startScore);
  });
  // Freeze the participant count now (deduped, since addParticipant is INSERT OR IGNORE)
  // so H2H/practice classification survives later player deletion — see the migration note.
  const pc = db.prepare('SELECT COUNT(*) AS n FROM game_players WHERE game_id = ?').get(gameId).n;
  db.prepare('UPDATE games SET player_count = ? WHERE id = ?').run(pc, gameId);
  if (fixture) {
    // Sets games.league_id DIRECTLY here, before the 'created' hook fires below —
    // ties the game to the fixture's league unambiguously, for free, without the
    // onGameCreated auto-tag hook's fuzzy 0/1/>1-candidate eligibility logic ever
    // running for a fixture-originated game (see that hook's own early-return check).
    db.prepare('UPDATE league_fixtures SET game_id = ? WHERE id = ?').run(gameId, fixture.id);
    db.prepare('UPDATE games SET league_id = ? WHERE id = ?').run(fixture.league_id, gameId);
  }
  _fireGameLifecycleHooks('created', { gameId, gameType: resolvedGameType, practice: !!practice,
    category: categoryStr, playerCount: pc, playerIds: participantIds, leagueId });
  // Killer's number assignment is decided HERE, server-side (never trusted from
  // the client — see killerConfig's own comment above) — the client has no other
  // way to learn it, so it rides back on this same response rather than needing
  // a second round-trip right after every game creation. Dead Man Walking's
  // frozen config.rounds is the same shape of problem — the client has no
  // other way to learn its own 15 personalized targets/pars, since they were
  // never client-supplied in the first place (see dmwConfig's own comment above).
  return killerConfig ? { gameId, config: { lives: killerConfig.lives, numbers: killerNumbersForClient } }
    : dmwConfig ? { gameId, config: dmwConfig }
    : { gameId };
}

// recordTurn() is the ONE entry point any network/untrusted write must use — it always
// validates (Architecture Roadmap P1-d / Structural Security). It takes no options, so a
// caller structurally *cannot* skip the scored/darts consistency cross-check the way a
// bare addTurn() call could by omitting a flag. server.js's POST /api/games/:id/turns
// route calls this; any future write path that records a turn should reach for this verb.
function recordTurn(gameId, t) {
  return addTurn(gameId, t, { enforceConsistency: true });
}

// addTurn() is the raw persistence primitive — the lower-level seam recordTurn() wraps,
// and the one the backend/test/db.*.test.js suite calls directly to seed hand-picked
// turns (arbitrary `scored`/`checkout` values unrelated to the invariant under test — a
// pervasive fixture convention across ~14 test files). Its `opts.enforceConsistency`
// gates the scored/darts cross-check (docs/security-audit-roadmap.md SEC-22); it stays
// opt-in HERE so those internal seeders keep working, but the network never calls addTurn
// directly — it goes through recordTurn() above, which is validated by construction, so
// the trust boundary doesn't depend on a caller remembering to pass a flag.
function addTurn(gameId, t, opts = {}) {
  const p = ensurePlayer(t.player);
  // Checkout Trainer trick-question declarations (docs/archive/checkout-trainer-roadmap.md
  // "Trick-question difficulty variant"): answering "no possible checkout" is the
  // one turn shape that carries ZERO darts — there's no proposed route to record,
  // only the graded verdict on bust/checkout/leg_won. Locked to checkout_trainer
  // games (whose turns already have zero footprint on any physical stat, so an
  // empty-darts turn can't inflate anything) and to exactly zero darts, so the
  // 1-3-darts invariant below stays fully intact for every other game type.
  const declaredUnsolvable = !!t.declaredUnsolvable;
  if (declaredUnsolvable) {
    const gt = q.gameTypeById.get(Number(gameId));
    if (!gt || gt.game_type !== 'checkout_trainer') throw httpError(400, 'declaredUnsolvable is only valid in a Checkout Trainer game');
    if (Array.isArray(t.darts) && t.darts.length > 0) throw httpError(400, 'A declared-unsolvable turn must not contain darts');
  } else if (!Array.isArray(t.darts) || t.darts.length < 1 || t.darts.length > 3) {
    // Every real visit is 1-3 physical darts. Enforce that here so a malformed/hostile
    // request can't record a "scored" turn with no dart rows — which would count toward
    // total points but not the darts denominator, silently inflating the 3-dart average.
    throw httpError(400, 'A turn must contain 1 to 3 darts');
  }
  // Validate each dart before writing: sector 0 (miss), 1-20, or 25 (bull); multiplier
  // 1-3. Rejecting garbage here keeps sector/treble/checkout analytics trustworthy.
  // (A declared-unsolvable turn reaches here with no darts array at all — validated
  // empty above — so it maps over nothing.)
  const darts = (t.darts || []).map((d, i) => {
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
  // A declaration proposes no darts, so it can never carry points either.
  if (declaredUnsolvable && scored !== 0) throw httpError(400, 'a declared-unsolvable turn must have scored=0');
  // t.set/t.leg default to 1 only when actually omitted (null/undefined) — a plain
  // `t.set || 1` would also silently coerce an explicit 0 to 1 (0 is falsy), which
  // would defeat the "positive integer" check on the very next line for exactly the
  // value it exists to catch.
  const setNo = Number(t.set != null ? t.set : 1), legNo = Number(t.leg != null ? t.leg : 1);
  if (!Number.isInteger(setNo) || setNo < 1 || !Number.isInteger(legNo) || legNo < 1) throw httpError(400, 'set and leg must be positive integers');
  const checkoutPoints = t.checkout ? (Number(t.checkoutPoints) || 0) : null;
  if (checkoutPoints != null && (!Number.isFinite(checkoutPoints) || checkoutPoints < 0 || checkoutPoints > 170)) throw httpError(400, 'checkoutPoints must be between 0 and 170');
  // docs/security-audit-roadmap.md SEC-22: cross-check scored against the darts it's
  // paired with — but ONLY when opted in (see the opts.enforceConsistency comment
  // above) AND for X01 (game_type check below), where the relationship is simple and
  // unambiguous (REFERENCE.md §2: scored = sum of this visit's dart face values, or 0
  // on a bust; a checkout turn's checkoutPoints always equals scored, since it's the
  // same finishing visit's own score). Cricket's turns.scored is NOT this —
  // evaluateVisitCricket() computes it from mark-closing state the server would have
  // to re-derive from the whole game's history to check, so a naive "scored ===
  // sum(dartValue)" rule would reject entirely legitimate Cricket visits (e.g. 3
  // marks closing a number score 0 points despite 3 real, non-miss darts). Every
  // other game type (Doubles Practice/Chuckin/Checkout Trainer/Around the
  // Clock/World) has its own similarly non-arithmetic relationship between scored and
  // its darts, or doesn't use `scored` as a points total at all — left unchecked here
  // for the same reason, not an oversight.
  const gameTypeRow = opts.enforceConsistency ? q.gameTypeById.get(Number(gameId)) : null;
  if (gameTypeRow && gameTypeRow.game_type === 'x01') {
    const dartSum = darts.reduce((sum, d) => sum + (d.sector === 0 ? 0 : d.sector === 25 ? (d.multiplier === 2 ? 50 : 25) : d.sector * d.multiplier), 0);
    if (t.bust) {
      if (scored !== 0) throw httpError(400, 'a bust turn must have scored=0');
    } else if (scored !== dartSum) {
      throw httpError(400, 'scored does not match the value of the darts thrown this visit');
    }
    if (t.checkout && checkoutPoints !== scored) {
      throw httpError(400, 'checkoutPoints must match scored on a checkout turn');
    }
  } else if (gameTypeRow && gameTypeRow.game_type === 'baseball') {
    // docs/security-audit-roadmap.md SEC-25: Baseball was added after SEC-22's
    // per-game-type analysis and never re-checked against it — but unlike Cricket
    // (whose scored needs whole-game mark state to re-derive) Baseball's turns.scored
    // IS arithmetically derivable from this visit's own darts plus the inning number,
    // and it IS a points-like total the leaderboards trust (RPI, Perfect Innings,
    // Best Inning, getBaseballWonLegs()'s leg-winner derivation). Only the range
    // check (0..180) guarded it, while a real Baseball visit maxes at 9 — so a
    // hostile scored:180 would multiply RPI ~20x and corrupt the won-leg derivation.
    // The inning is derived server-side from this player's own prior turn count in
    // the same game/set/leg (each player throws exactly once per inning, so their
    // own turn count is their inning progression) — correct mid-round and across
    // undo (which deletes the newest turn). Extra innings keep targeting 9, matching
    // baseballInningTarget(). Baseball has no bust/checkout concept, so both must be
    // false (enterTurnBaseball() always sends them so).
    if (t.bust) throw httpError(400, 'a Baseball turn cannot be a bust');
    if (t.checkout) throw httpError(400, 'a Baseball turn cannot be a checkout');
    const priorTurns = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id = ? AND player_id = ? AND set_no = ? AND leg_no = ?')
      .get(Number(gameId), p.id, setNo, legNo).n;
    const target = Math.min(priorTurns + 1, 9);
    const expectedRuns = darts.reduce((sum, d) => sum + (d.sector === target ? d.multiplier : 0), 0);
    if (scored !== expectedRuns) {
      throw httpError(400, 'scored does not match this Baseball visit\'s runs on the target number');
    }
  } else if (gameTypeRow && gameTypeRow.game_type === 'bobs_27') {
    // docs/archive/practice-ladders-roadmap.md Part A: scored is this round's GAIN
    // (0 when all 3 darts missed the double — it can't go negative, so the
    // penalty is derived at read time from scored===0, not stored directly;
    // see evaluateVisitBobs27()'s own comment in frontend/scoring.js). Round is
    // derived the same "this player's own prior-turn count in this game/set/
    // leg" way Baseball's inning is (SEC-25) — bobs_27 always has exactly one
    // set/leg, but the query stays scoped identically for consistency. bust
    // must reflect whether THIS round's outcome drops the running score to 0
    // or below, which needs replaying every prior round's own gain/penalty to
    // know the running total entering this one — cheap (at most 19 rows, since
    // a run is capped at 20 rounds).
    if (t.checkout) throw httpError(400, "a Bob's 27 turn cannot be a checkout");
    const priorTurns = db.prepare('SELECT scored FROM turns WHERE game_id = ? AND player_id = ? AND set_no = ? AND leg_no = ? ORDER BY id')
      .all(Number(gameId), p.id, setNo, legNo);
    const round = priorTurns.length + 1;
    if (round > 20) throw httpError(400, "Bob's 27 only has 20 rounds (D1 through D20)");
    let running = 27;
    priorTurns.forEach((pt, i) => { const r = i + 1; running += pt.scored > 0 ? pt.scored : -2 * r; });
    const doubleValue = round * 2;
    const hits = darts.filter(d => d.sector === round && d.multiplier === 2).length;
    const expectedGain = hits * doubleValue;
    if (scored !== expectedGain) {
      throw httpError(400, "scored does not match this round's double hits");
    }
    const expectedRunning = running + (expectedGain > 0 ? expectedGain : -doubleValue);
    if (!!t.bust !== (expectedRunning <= 0)) {
      throw httpError(400, 'bust must reflect whether this round drops the running score to 0 or below');
    }
  } else if (gameTypeRow && gameTypeRow.game_type === 'checkout_ladder') {
    // docs/archive/practice-ladders-roadmap.md Part B: a genuine X01 visit (identical
    // dart-sum/bust/checkout arithmetic to the 'x01' branch above, reused
    // wholesale — this game type's whole design is "an ordinary X01 visit,
    // just starting from a target that isn't 501/301/etc") from a per-attempt
    // starting remainder — each attempt is its own leg (leg_no increments per
    // attempt), capped at 3 visits (9 darts) before the attempt fails.
    const dartSum = darts.reduce((sum, d) => sum + (d.sector === 0 ? 0 : d.sector === 25 ? (d.multiplier === 2 ? 50 : 25) : d.sector * d.multiplier), 0);
    if (t.bust) {
      if (scored !== 0) throw httpError(400, 'a bust turn must have scored=0');
    } else if (scored !== dartSum) {
      throw httpError(400, 'scored does not match the value of the darts thrown this visit');
    }
    if (t.checkout && checkoutPoints !== scored) {
      throw httpError(400, 'checkoutPoints must match scored on a checkout turn');
    }
    // At most 3 visits per attempt — a 4th would mean the attempt should have
    // already resolved (won, or failed after visit 3) and the client is
    // trying to keep going past the cap.
    const visitsThisLeg = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id=? AND player_id=? AND set_no=? AND leg_no=?')
      .get(Number(gameId), p.id, setNo, legNo).n;
    if (visitsThisLeg >= 3) throw httpError(400, 'a checkout ladder attempt is capped at 3 visits');
    // The ladder's current target is never trusted from the client — it's
    // derived from every STRICTLY PRIOR attempt's own outcome (a leg only
    // ever advances once it's actually resolved): a win (any turn with
    // checkout=1) climbs the ladder by 1; a loss (3 visits recorded with no
    // checkout) drops it by 1, floored at 61. Capped at 170 (not just the
    // highest badge rung but a hard ceiling): turns.target_score is the same
    // shared column Checkout Trainer uses for "a checkout target," which by
    // definition can never exceed the highest possible double-out finish —
    // repeatedly clearing 170 just keeps the run parked there rather than
    // requesting a target outside the column's own valid range.
    const priorLegRows = db.prepare('SELECT leg_no, checkout FROM turns WHERE game_id=? AND player_id=? AND set_no=? AND leg_no<? ORDER BY leg_no, id')
      .all(Number(gameId), p.id, setNo, legNo);
    const byLeg = new Map();
    priorLegRows.forEach(r => { if (!byLeg.has(r.leg_no)) byLeg.set(r.leg_no, false); if (r.checkout) byLeg.set(r.leg_no, true); });
    let expectedTarget = 121;
    for (const won of byLeg.values()) expectedTarget = won ? Math.min(170, expectedTarget + 1) : Math.max(61, expectedTarget - 1);
    if (Number(t.targetScore) !== expectedTarget) {
      throw httpError(400, "targetScore does not match this attempt's derived ladder position");
    }
  } else if (gameTypeRow && gameTypeRow.game_type === 'gauntlet') {
    // docs/archive/gauntlet-roadmap.md: turns.scored is this attempt's own miss count
    // (0-3, "Scored-range guard"); turns.target_score is which station (1-20)
    // this attempt was for. The "sequence guard" (only the next station in
    // GAUNTLET_STATION_ORDER) and the "repeat-count guard" (at most 2 rows
    // per station, and only if the first came back as exactly 2) collapse
    // into ONE check here: rebuildGauntletState()'s own derivation of "which
    // station is next" already accounts for a pending one-time repeat, so
    // re-deriving it from every prior turn and comparing against it catches
    // both a skipped-ahead station and a 3rd attempt at an already-settled
    // one in a single comparison.
    if (t.checkout) throw httpError(400, 'a Gauntlet turn cannot be a checkout');
    if (t.bust) throw httpError(400, 'a Gauntlet turn cannot be a bust');
    if (scored < 0 || scored > 3) throw httpError(400, "a Gauntlet turn's scored (miss count) must be between 0 and 3");
    const priorTurns = db.prepare('SELECT target_score AS targetScore, scored FROM turns WHERE game_id=? AND player_id=? ORDER BY id')
      .all(Number(gameId), p.id);
    const state = rebuildGauntletState({ turns: priorTurns });
    if (state.done) throw httpError(400, 'this Gauntlet run has already completed all 20 stations');
    if (Number(t.targetScore) !== state.currentStation) {
      throw httpError(400, "targetScore does not match this run's next station (in fixed clock-adjacency order, or its one pending repeat)");
    }
  } else if (gameTypeRow && gameTypeRow.game_type === 'killer') {
    // docs/game-modes-roadmap.md "Killer": scored is the plain non-negative
    // magnitude of this dart's life-total change (0-3); affected_player_id says
    // WHOSE total it landed on (see that column's own migration comment for why).
    // Both are independently re-derived here by replaying every prior dart this
    // LEG (numbers/lives reset every leg; the assignment itself is match-wide,
    // read from the game's own config) and running evaluateDartKiller() against
    // the reconstructed state — the same "the server re-derives the expected
    // shape and rejects a submission that couldn't have produced it" spirit as
    // every other consistency guard, just for a game type where a single dart
    // can affect a DIFFERENT player than the one who threw it. Turn ORDER itself
    // is not enforced here, matching every other existing guard's scope (SEC-22/
    // SEC-25 verify arithmetic, never who-throws-next — the client is trusted
    // for sequencing the same way it already is everywhere else).
    if (t.checkout) throw httpError(400, 'a Killer turn cannot be a checkout');
    if (t.bust) throw httpError(400, 'a Killer turn cannot be a bust');
    if (scored < 0 || scored > 3) throw httpError(400, "a Killer turn's scored (life change) must be between 0 and 3");
    if (darts.length !== 1) throw httpError(400, 'a Killer turn must be exactly 1 dart (per-dart evaluation)');
    const gameRow = db.prepare('SELECT config FROM games WHERE id=?').get(Number(gameId));
    const cfg = gameRow && gameRow.config ? JSON.parse(gameRow.config) : null;
    if (!cfg || !cfg.numbers) throw httpError(400, 'this game has no Killer number assignment');
    const participants = db.prepare(`
      SELECT p.id, p.name FROM game_players gp JOIN players p ON p.id=gp.player_id
      WHERE gp.game_id=? ORDER BY gp.rowid
    `).all(Number(gameId));
    const idToName = new Map(participants.map(pp => [pp.id, pp.name]));
    const throwerName = idToName.get(p.id);
    if (!throwerName) throw httpError(400, 'thrower is not a participant in this game');

    const priorRows = db.prepare(`
      SELECT t.player_id AS playerId, d.sector AS sector, d.multiplier AS mult
      FROM turns t JOIN darts d ON d.turn_id=t.id
      WHERE t.game_id=? AND t.set_no=? AND t.leg_no=? ORDER BY t.id
    `).all(Number(gameId), setNo, legNo);
    const priorTurns = priorRows.map(r => ({ throwerName: idToName.get(r.playerId), sector: r.sector, mult: r.mult }));
    const state = rebuildKillerState({ participants, numbers: cfg.numbers, turns: priorTurns, threshold: cfg.lives });
    if (state.winner) throw httpError(400, 'this Killer leg has already been won');
    const thrower = state.players.find(pl => pl.name === throwerName);
    if (!thrower || thrower.eliminated) throw httpError(400, 'this player has already been eliminated this leg');

    const dart = darts[0];
    const dartCore = { sector: dart.sector, mult: dart.multiplier, isDouble: dart.multiplier === 2 && dart.sector !== 0 };
    const expected = evaluateDartKiller(dartCore, throwerName, state.players);
    const expectedAffectedName = expected ? expected.affectedName : null;
    const expectedDelta = expected ? expected.delta : 0;
    const submittedAffectedName = t.affectedPlayer != null ? String(t.affectedPlayer) : null;
    if (submittedAffectedName !== expectedAffectedName) {
      throw httpError(400, "affectedPlayer does not match this dart's derived effect");
    }
    if (scored !== expectedDelta) {
      throw httpError(400, "scored does not match this dart's derived life-change magnitude");
    }
  } else if (gameTypeRow && gameTypeRow.game_type === 'shanghai') {
    // docs/archive/shanghai-roadmap.md: same SEC-25 shape Baseball's own branch above
    // uses — turns.scored IS arithmetically derivable from this visit's own
    // darts plus the round number, and is the points total every Shanghai
    // stat/leaderboard trusts. The round is derived server-side from this
    // player's own prior turn count in this game/set/leg (SEC-25 pattern),
    // capped at config.rounds (default 7) for extra rounds, matching
    // shanghaiRoundTarget()/evaluateVisitShanghai() exactly. Note: the
    // roadmap doc's own draft text says "max legit visit = 6x the round
    // number" — that undersells it; three trebles of the round's number is
    // a real, non-Shanghai 9x-the-round-number visit, so the real ceiling
    // enforced here is 9x, not 6x (a correctness fix over the doc's literal
    // wording, not a deviation from its actual intent).
    if (t.bust) throw httpError(400, 'a Shanghai turn cannot be a bust');
    if (t.checkout) throw httpError(400, 'a Shanghai turn cannot be a checkout');
    const gameRow = db.prepare('SELECT config FROM games WHERE id=?').get(Number(gameId));
    const cfg = gameRow && gameRow.config ? JSON.parse(gameRow.config) : null;
    const maxRounds = (cfg && cfg.rounds) || 7;
    const priorTurns = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id = ? AND player_id = ? AND set_no = ? AND leg_no = ?')
      .get(Number(gameId), p.id, setNo, legNo).n;
    const round = shanghaiRoundTarget(priorTurns + 1, maxRounds);
    const expectedPoints = darts.reduce((sum, d) => sum + (d.sector === round ? d.multiplier * round : 0), 0);
    if (scored !== expectedPoints) {
      throw httpError(400, "scored does not match this Shanghai visit's points on the round's own number");
    }
  } else if (gameTypeRow && gameTypeRow.game_type === 'halve_it') {
    // docs/archive/halve-it-roadmap.md: same SEC-25 shape as Baseball/Shanghai's own
    // branches above — turns.scored IS arithmetically derivable from this visit's
    // own darts plus the round's target (sector, optionally ring-restricted), and
    // is the points-gained total every Halve-It stat trusts. Unlike Shanghai,
    // `bust` is NOT rejected here -- it's repurposed as the "this visit halved the
    // running total" flag (docs/archive/halve-it-roadmap.md's own column-repurposing
    // precedent, same as Doubles Practice/guided Around the Clock), so it's
    // validated for CONSISTENCY with the derived points instead: bust must be true
    // iff the visit gained exactly 0 (hitting the target always scores >0, so
    // scored===0 is unambiguous). `checkout` has no meaning here and is rejected.
    if (t.checkout) throw httpError(400, 'a Halve-It turn cannot be a checkout');
    const gameRow = db.prepare('SELECT config FROM games WHERE id=?').get(Number(gameId));
    const cfg = gameRow && gameRow.config ? JSON.parse(gameRow.config) : null;
    const targets = (cfg && cfg.targets) || HALVE_IT_DEFAULT_TARGETS;
    const priorTurns = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id = ? AND player_id = ? AND set_no = ? AND leg_no = ?')
      .get(Number(gameId), p.id, setNo, legNo).n;
    const target = halveItRoundTarget(priorTurns + 1, targets);
    const expectedGained = darts.reduce((sum, d) => sum + halveItDartValue({ sector: d.sector, mult: d.multiplier }, target), 0);
    if (scored !== expectedGained) {
      throw httpError(400, "scored does not match this Halve-It visit's points on the round's own target");
    }
    if (!!t.bust !== (expectedGained === 0)) {
      throw httpError(400, 'bust must reflect whether this Halve-It visit missed the round\'s target entirely');
    }
  } else if (gameTypeRow && gameTypeRow.game_type === 'dead_man_walking') {
    // docs/archive/dead-man-walking-roadmap.md "Data model": ordinary X01 bust/checkout
    // columns reused in their normal sense (no repurposing needed) — the same
    // dart-sum/bust/checkoutPoints arithmetic as the 'x01'/'checkout_ladder'
    // branches above, reused wholesale. What's new is the per-round variable
    // dart-budget guard (generalizing Checkout Ladder's flat 9-dart/3-visit cap
    // to a variable `config.rounds[leg-1].par - 1`) and validating targetScore
    // against the FROZEN round the server itself computed at creation, never
    // the ladder's own live-derived climbing target.
    const dartSum = darts.reduce((sum, d) => sum + (d.sector === 0 ? 0 : d.sector === 25 ? (d.multiplier === 2 ? 50 : 25) : d.sector * d.multiplier), 0);
    if (t.bust) {
      if (scored !== 0) throw httpError(400, 'a bust turn must have scored=0');
    } else if (scored !== dartSum) {
      throw httpError(400, 'scored does not match the value of the darts thrown this visit');
    }
    if (t.checkout && checkoutPoints !== scored) {
      throw httpError(400, 'checkoutPoints must match scored on a checkout turn');
    }
    const gameRow = db.prepare('SELECT config FROM games WHERE id=?').get(Number(gameId));
    const cfg = gameRow && gameRow.config ? JSON.parse(gameRow.config) : null;
    const rounds = (cfg && cfg.rounds) || [];
    if (legNo < 1 || legNo > rounds.length) throw httpError(400, `Dead Man Walking only has ${rounds.length} rounds`);
    const round = rounds[legNo - 1];
    if (Number(t.targetScore) !== round.target) {
      throw httpError(400, "targetScore does not match this round's frozen target");
    }
    const priorTurns = db.prepare('SELECT bust, checkout FROM turns WHERE game_id=? AND player_id=? AND set_no=? AND leg_no=? ORDER BY id')
      .all(Number(gameId), p.id, setNo, legNo);
    const priorDarts = db.prepare(`
      SELECT COUNT(*) AS n FROM turns t JOIN darts d ON d.turn_id=t.id
      WHERE t.game_id=? AND t.player_id=? AND t.set_no=? AND t.leg_no=?
    `).get(Number(gameId), p.id, setNo, legNo).n;
    const budget = round.par - 1;
    // A round already ended the instant it resolved (a real bust, a checkout,
    // or the budget already fully spent without either — "Executed, out of
    // darts," see evaluateDeadManDart()/resolveDeadManDart()'s own header
    // comments for why that last case is bust=0) — a further turn against the
    // same leg is always illegitimate.
    const alreadyResolved = priorTurns.some(pt => pt.checkout) || priorTurns.some(pt => pt.bust) || priorDarts >= budget;
    if (alreadyResolved) throw httpError(400, 'this Dead Man Walking round has already ended');
    if (priorDarts + darts.length > budget) {
      throw httpError(400, `this round's dart budget (${budget}) would be exceeded`);
    }
  } else if (gameTypeRow && gameTypeRow.game_type === 'pressure_chamber') {
    // docs/archive/pressure-chamber-roadmap.md: reuses Checkout Trainer's exact 3-way
    // bust=1(miss)/checkout=1,leg_won=0(partial)/checkout=1,leg_won=1(full)
    // outcome. The round's card (target+modifier) is never stored — it's a
    // pure function of (gameId, roundIndex), re-derived here exactly the way
    // the client derived it (generatePressureCard()), same SEC-25
    // "recompute the expected shape server-side, reject a mismatch"
    // principle as every branch above. Round is this player's own prior turn
    // count in this game/set/leg (SEC-25 pattern); fixed at exactly 15 rounds
    // — no extra-rounds extension exists for this game type (see
    // pressureChamberDecideWinnerIndex() in scoring.js for how a tie at the
    // final round resolves instead).
    const priorTurns = db.prepare('SELECT COUNT(*) AS n FROM turns WHERE game_id = ? AND player_id = ? AND set_no = ? AND leg_no = ?')
      .get(Number(gameId), p.id, setNo, legNo).n;
    const round = priorTurns + 1;
    if (round > PRESSURE_ROUNDS) throw httpError(400, `a Pressure Chamber run only has ${PRESSURE_ROUNDS} rounds`);
    const card = generatePressureCard(Number(gameId), round);
    const dartsCore = darts.map(d => makeDartCore(d.sector, d.multiplier));
    const result = computePressureRoundResult(card, dartsCore);
    if (scored !== result.gained) {
      throw httpError(400, "scored does not match this round's derived Composure Points");
    }
    const expectedBust = result.outcome === 'miss';
    const expectedCheckout = result.outcome !== 'miss';
    const expectedLegWon = result.outcome === 'full';
    if (!!t.bust !== expectedBust) throw httpError(400, 'bust must reflect whether this round was missed entirely');
    if (!!t.checkout !== expectedCheckout) throw httpError(400, 'checkout must reflect whether this round was at least a partial hit');
    if (!!t.legWon !== expectedLegWon) throw httpError(400, 'legWon must reflect whether this round was a full hit');
  }
  // Checkout Trainer (docs/archive/checkout-trainer-roadmap.md): the target score offered
  // for this round. Server-computed context, not a scored value, so it's only
  // range-checked (1-170, the finishable range) rather than tied to any other field.
  let targetScore = null;
  if (t.targetScore != null) {
    targetScore = Number(t.targetScore);
    if (!Number.isInteger(targetScore) || targetScore < 1 || targetScore > 170) throw httpError(400, 'targetScore must be an integer between 1 and 170');
  }
  // Killer (docs/game-modes-roadmap.md "Killer"): which player this dart's
  // life-total change landed on, by name. NULL for every non-Killer turn, and NULL
  // for a Killer dart that changed nothing (see the killer branch above for what's
  // actually enforced). Gated to killer games the same way declaredUnsolvable is
  // gated to checkout_trainer and declaredHit to pressure_chamber below — and
  // resolved via getPlayer(), NOT ensurePlayer(): the affected player is always an
  // existing participant, so an unknown name is a 400, never a fresh players row
  // (ensurePlayer here let any write-tier turn POST mint junk roster entries).
  let affectedPlayerId = null;
  if (t.affectedPlayer != null) {
    const agt = q.gameTypeById.get(Number(gameId));
    if (!agt || agt.game_type !== 'killer') throw httpError(400, 'affectedPlayer is only valid in a Killer game');
    const ap = getPlayer(t.affectedPlayer);
    if (!ap) throw httpError(400, 'affectedPlayer is not a known player');
    affectedPlayerId = ap.id;
  }
  // The Pressure Chamber self-declare honesty mechanic (docs/archive/pressure-chamber-roadmap.md
  // build-order step 10): 1 = declared hit, 0 = declared miss, NULL = no declaration.
  // Only valid for pressure_chamber games (gated the same way declaredUnsolvable is
  // gated to checkout_trainer, and looked up only when a declaration is actually
  // present so the common no-declaration path stays query-free). It is deliberately
  // NOT cross-checked against the round's real outcome — see the column's migration
  // comment: the whole point is that the declaration is unverifiable, an honor-system
  // self-discipline signal feeding only the informational Honesty% stat.
  let declaredHit = null;
  if (t.declaredHit != null) {
    declaredHit = Number(t.declaredHit);
    if (declaredHit !== 0 && declaredHit !== 1) throw httpError(400, 'declaredHit must be 0 (declared miss) or 1 (declared hit)');
    const gt = q.gameTypeById.get(Number(gameId));
    if (!gt || gt.game_type !== 'pressure_chamber') throw httpError(400, 'declaredHit is only valid in a Pressure Chamber game');
  }
  const info = q.insertTurn.run(
    Number(gameId), p.id,
    setNo, legNo,
    scored,
    t.bust ? 1 : 0,
    t.checkout ? 1 : 0,
    checkoutPoints,
    t.legWon ? 1 : 0,
    targetScore,
    declaredUnsolvable ? 1 : 0,
    affectedPlayerId,
    declaredHit
  );
  // Insert individual dart rows — scored/is_treble/is_double are generated columns.
  // thrownAt is an ISO timestamp captured client-side at tap time; only sent when
  // the admin has enabled the "collect_dart_timing" setting.
  const turnId = Number(info.lastInsertRowid);
  for (const d of darts) {
    q.insertDart.run(turnId, d.dartNo, d.sector, d.multiplier, d.thrownAt,
      d.zone, d.missZone, d.missDepth, d.bounced ? 1 : null);
  }
  // docs/bug-roadmap.md BUG-13: returned so the client can remember exactly which
  // turn it just recorded and pass it back to deleteLastTurn() — purely additive,
  // nothing previously read this response beyond `ok`.
  return { ok: true, turnId };
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

/* ---------- Saved games / pause & resume (docs/archive/saved-games-roadmap.md) ----------
   "This game is paused" is the only new fact (saved_games.game_id) — everything
   needed to actually resume is DERIVED from the turns/darts already recorded
   live, via the pure rebuild functions in frontend/scoring.js (required in at
   the top of this file) — "replay, not snapshot," see that section's own header
   comment. Savable game types are enforced here, server-side, never trusting
   the client's own eligibility check (per the roadmap doc's security section).
   Not savable: Daily Challenge, Ghost mode, Doubles Practice, Just Chuckin' It,
   Checkout Trainer — each has its own reason (see the roadmap doc's "Scope"
   section), not an oversight.
   Standing-rule follow-through: saved_games needs NO extra code in
   wipeAllData()/resetStats() — game_id is ON DELETE CASCADE, so deleting the
   games it wipes already cascades away the pause state for free. It's also
   deliberately NOT in getPlayerExport() (a pause is local workflow state, not
   portable history — an imported incomplete game just arrives unsaved) but IS
   in getFullDatabaseExport() below (ordinary "your data" for a full-server
   dump).
   bobs_27 (docs/archive/practice-ladders-roadmap.md Part A) IS savable — its
   running total replays deterministically from `turns` the same way every
   other entry here does (rebuildBobs27State(), frontend/scoring.js). */
// dead_man_walking (docs/archive/dead-man-walking-roadmap.md "Saved games"): a resumed
// run replays from the frozen config.rounds array plus a count of completed
// legs so far -- pure function of stored config + turns, same shape every
// other entry here already follows.
// One registry for every game type, so adding a mode is a single record here
// rather than edits scattered across KNOWN_GAME_TYPES, SAVABLE_GAME_TYPES, and the
// two per-type dispatch chains that used to live in server.js. Each entry declares:
//   savable       — whether a paused game of this type can be resumed (SAVABLE list)
//   statBubbles   — the Player Profile stat-bubble function for this type
//   personalBests — the Player Profile Personal-Bests function for this type
//   dispatchOnly  — true for 'marathon', a routing key that isn't a real games.game_type
//                   value (every Marathon leg is a plain 'x01' game) — it takes part in
//                   the stat dispatch but must NOT appear in KNOWN/SAVABLE_GAME_TYPES.
// Every function referenced here is a hoisted top-level declaration below, so this
// literal can name them regardless of file order. KNOWN_GAME_TYPES, SAVABLE_GAME_TYPES,
// and getStatBubblesFor()/getPersonalBestsFor() all derive from this — see each below.
const GAME_TYPE_REGISTRY = {
  x01:              { savable: true,  statBubbles: getPlayerStatBubbles,            personalBests: getPersonalBests,
    // Item 37: `rebuild(game, participants, turns)` replays turns.js.
    // recorded turns into full per-player state (the same shape resumeGame()'s
    // frontend counterpart reconstructs); `position(game, r)` trims that down
    // to the one-line saved-games-list summary. Both members exist ONLY on
    // savable types — see _savedGamePosition()'s generic dispatch below.
    rebuild: (game, participants, turns) => rebuildX01State({ names: participants.map(p => p.name),
      outModes: participants.map(p => p.outMode), startScore: Number(game.category) || 501,
      startScores: participants.map(p => p.startScore ?? null),
      practice: !!game.practice, legsPerSet: game.legs_per_set, turns }),
    position: (game, r) => ({ setNo: r.setNo, legNo: r.legNo,
      players: r.players.map(p => ({ name: p.name, legsWon: p.legsWon, setsWon: p.setsWon, score: p.score })) }) },
  cricket:          { savable: true,  statBubbles: getCricketStatBubbles,           personalBests: getCricketPersonalBests,
    rebuild: (game, participants, turns) => rebuildCricketState({ names: participants.map(p => p.name),
      config: game.config ? JSON.parse(game.config) : null, practice: !!game.practice, legsPerSet: game.legs_per_set, turns }),
    position: (game, r) => ({ setNo: r.setNo, legNo: r.legNo,
      players: r.players.map(p => ({ name: p.name, legsWon: p.legsWon, setsWon: p.setsWon, points: p.points })) }) },
  baseball:         { savable: true,  statBubbles: getBaseballStatBubbles,          personalBests: getBaseballPersonalBests,
    rebuild: (game, participants, turns) => rebuildBaseballState({ names: participants.map(p => p.name),
      legsPerSet: game.legs_per_set, turns }),
    position: (game, r) => ({ setNo: r.setNo, legNo: r.legNo, baseballInning: r.baseballInning,
      players: r.players.map(p => ({ name: p.name, legsWon: p.legsWon, setsWon: p.setsWon, totalRuns: p.totalRuns })) }) },
  doubles_practice: { savable: false, statBubbles: getDoublesPracticeStatBubbles,   personalBests: getDoublesPracticePersonalBests },
  chuckin:          { savable: false, statBubbles: getChuckinStatBubbles,           personalBests: getChuckinPersonalBests },
  // Checkout Trainer's Personal Bests merge two records (the trainer's toughest-checkout/
  // best-streak plus Checkout Blitz's peak/lifetime score) into one response.
  checkout_trainer: { savable: false, statBubbles: getCheckoutTrainerStatBubbles,
                      personalBests: (name, mode) => Object.assign({}, getCheckoutTrainerPersonalBests(name, mode), getCheckoutBlitzPersonalStats(name)) },
  around_the_clock: { savable: true,  statBubbles: getAroundTheClockStatBubbles,    personalBests: getAroundTheClockPersonalBests,
    rebuild: (game, participants, turns) => rebuildAroundTheClockState({ turns }),
    position: (game, r) => ({ legNo: r.legNo, hit: r.hitSet.size, total: 20 }) },
  // Note the stat-bubble function's own "Drill" name (distinct from the passive Around
  // the World badge helper) — preserved exactly as the old dispatch had it.
  around_the_world: { savable: true,  statBubbles: getAroundTheWorldDrillStatBubbles, personalBests: getAroundTheWorldPersonalBests,
    rebuild: (game, participants, turns) => rebuildAroundTheWorldState({ turns }),
    position: (game, r) => ({ sessionDarts: r.sessionDarts }) },
  bobs_27:          { savable: true,  statBubbles: getBobs27StatBubbles,            personalBests: getBobs27PersonalBests,
    rebuild: (game, participants, turns) => rebuildBobs27State({ turns }),
    position: (game, r) => ({ round: r.round, running: r.running }) },
  checkout_ladder:  { savable: true,  statBubbles: getCheckoutLadderStatBubbles,    personalBests: getCheckoutLadderPersonalBests,
    rebuild: (game, participants, turns) => rebuildCheckoutLadderState({ turns }),
    position: (game, r) => ({ target: r.target, legNo: r.legNo, remaining: r.remaining }) },
  gauntlet:         { savable: true,  statBubbles: getGauntletStatBubbles,          personalBests: getGauntletPersonalBests,
    rebuild: (game, participants, turns) => rebuildGauntletState({ turns }),
    position: (game, r) => ({ station: r.currentStation, settled: r.settledCount, totalScars: r.totalScars, awaitingRepeat: r.awaitingRepeat }) },
  killer:           { savable: false, statBubbles: getKillerStatBubbles,            personalBests: getKillerPersonalBests },
  shanghai:         { savable: true,  statBubbles: getShanghaiStatBubbles,          personalBests: getShanghaiPersonalBests,
    rebuild: (game, participants, turns) => {
      const config = game.config ? JSON.parse(game.config) : null;
      return rebuildShanghaiState({ names: participants.map(p => p.name), legsPerSet: game.legs_per_set,
        maxRounds: (config && config.rounds) || 7, turns });
    },
    position: (game, r) => ({ setNo: r.setNo, legNo: r.legNo, shanghaiRound: r.shanghaiRound,
      players: r.players.map(p => ({ name: p.name, legsWon: p.legsWon, setsWon: p.setsWon, totalPoints: p.totalPoints })) }) },
  halve_it:         { savable: true,  statBubbles: getHalveItStatBubbles,           personalBests: getHalveItPersonalBests,
    rebuild: (game, participants, turns) => {
      const config = game.config ? JSON.parse(game.config) : null;
      return rebuildHalveItState({ names: participants.map(p => p.name), legsPerSet: game.legs_per_set,
        targets: (config && config.targets) || HALVE_IT_DEFAULT_TARGETS, turns });
    },
    position: (game, r) => ({ setNo: r.setNo, legNo: r.legNo, halveItRound: r.halveItRound,
      players: r.players.map(p => ({ name: p.name, legsWon: p.legsWon, setsWon: p.setsWon, total: p.total })) }) },
  dead_man_walking: { savable: true,  statBubbles: getDeadManWalkingStatBubbles,    personalBests: getDeadManWalkingPersonalBests,
    // Field names are free to overlap with other types' (round/target/etc) now
    // that savedGamePositionLabel() (frontend/index.html) dispatches on
    // sg.gameType rather than field presence — see item 38,
    // docs/code-quality-roadmap.md. Unrelated to the live-state game.dmw*
    // keys (docs/live-state-keys, item 42), which are a separate object.
    rebuild: (game, participants, turns) => {
      const config = game.config ? JSON.parse(game.config) : null;
      return rebuildDeadManWalkingState({ rounds: (config && config.rounds) || [], turns });
    },
    position: (game, r) => {
      const config = game.config ? JSON.parse(game.config) : null;
      const rounds = (config && config.rounds) || [];
      return { round: r.roundIndex + 1, totalRounds: rounds.length,
        target: r.remaining, walkedOutCount: r.walkedOutCount, dartsUsedThisRound: r.dartsUsedThisRound, budget: r.budget };
    } },
  pressure_chamber: { savable: true,  statBubbles: getPressureChamberStatBubbles,   personalBests: getPressureChamberPersonalBests,
    rebuild: (game, participants, turns) => {
      const config = game.config ? JSON.parse(game.config) : null;
      return rebuildPressureChamberState({ gameId: game.id, names: participants.map(p => p.name), legsPerSet: game.legs_per_set,
        maxRounds: (config && config.rounds) || PRESSURE_ROUNDS, turns });
    },
    position: (game, r) => ({ setNo: r.setNo, legNo: r.legNo, pressureChamberRound: r.pressureChamberRound,
      players: r.players.map(p => ({ name: p.name, legsWon: p.legsWon, setsWon: p.setsWon, totalCp: p.totalCp })) }) },
  marathon:         { dispatchOnly: true, statBubbles: getMarathonStatBubbles,      personalBests: getMarathonPersonalBests },
};
// Resolves the per-type Player Profile stat function, falling back to the X01 default
// for an unknown/absent type — the same behavior the old server.js ternary's trailing
// `: db.getPlayerStatBubbles(...)` gave. server.js now calls these instead of dispatching.
function getStatBubblesFor(gameType, name, mode) {
  const e = GAME_TYPE_REGISTRY[gameType];
  return (e && e.statBubbles ? e.statBubbles : getPlayerStatBubbles)(name, mode);
}
function getPersonalBestsFor(gameType, name, mode) {
  const e = GAME_TYPE_REGISTRY[gameType];
  return (e && e.personalBests ? e.personalBests : getPersonalBests)(name, mode);
}
// Item 51: tournament average-seeding used to fire one getPersonalBestsFor() call
// PER SELECTED PLAYER as N separate HTTP round trips (Promise.all of N fetches);
// this collapses it to the one round trip the client actually needs — same X01-
// lifetime record each of those calls already asked for (no gameType/mode), just
// batched server-side into a single response keyed by name.
function getPersonalBestsBatch(names) {
  return Object.fromEntries((names || []).map(name => [name, getPersonalBestsFor(undefined, name, undefined)]));
}

const SAVABLE_GAME_TYPES = Object.keys(GAME_TYPE_REGISTRY).filter(k => GAME_TYPE_REGISTRY[k].savable);

function _savedGameRow(gameId) {
  return db.prepare('SELECT * FROM saved_games WHERE game_id = ?').get(Number(gameId));
}

// Participant NAMES, sorted case-insensitively — the canonical, order-
// independent form the "one saved game per matchup" check and the merge-
// collision check both compare against ("Ben & Alaina" and "Alaina & Ben" are
// the same matchup).
function _participantNames(gameId) {
  return db.prepare(`
    SELECT p.name FROM game_players gp JOIN players p ON p.id = gp.player_id
    WHERE gp.game_id = ? ORDER BY p.name COLLATE NOCASE
  `).all(Number(gameId)).map(r => r.name);
}

// One saved game per (participant set, game type) [decided 2026-07] — returns
// the existing saved game's id for this exact matchup+type, or null. Used both
// by saveGame() (reject a second save into an occupied slot) and by the New
// Game resume prompt (client-side match against getSavedGames()' own list —
// "the check reuses the same endpoint the list below uses," per the roadmap
// doc — so this function itself is only ever called server-side).
function findSavedGameForParticipants(names, gameType) {
  const target = names.slice().sort((a, b) => a.localeCompare(b));
  const rows = db.prepare(`
    SELECT sg.game_id AS gameId FROM saved_games sg JOIN games g ON g.id = sg.game_id
    WHERE g.game_type = ?
  `).all(gameType);
  for (const row of rows) {
    const existing = _participantNames(row.gameId);
    if (existing.length === target.length && existing.every((n, i) => n.toLowerCase() === target[i].toLowerCase())) {
      return row.gameId;
    }
  }
  return null;
}

function saveGame(gameId) {
  const game = db.prepare('SELECT id, game_type, completed_at FROM games WHERE id = ?').get(Number(gameId));
  if (!game) throw httpError(404, 'Game not found');
  if (game.completed_at != null) throw httpError(409, 'This game is already complete and cannot be saved');
  if (!SAVABLE_GAME_TYPES.includes(game.game_type)) throw httpError(400, `${game.game_type} games can't be saved for later`);
  // Idempotent-safe: saving an already-saved game id is a no-op 200 (double-tap
  // protection), not an error — see the roadmap doc's "Saving" section.
  if (_savedGameRow(game.id)) return { ok: true, alreadySaved: true };
  const names = _participantNames(game.id);
  const existingId = findSavedGameForParticipants(names, game.game_type);
  if (existingId != null) {
    throw httpError(409, 'A saved game already exists for these players and this game type — abandon it first.');
  }
  db.prepare('INSERT INTO saved_games (game_id) VALUES (?)').run(game.id);
  return { ok: true, alreadySaved: false };
}

function abandonSavedGame(gameId) {
  const info = db.prepare('DELETE FROM saved_games WHERE game_id = ?').run(Number(gameId));
  if (info.changes === 0) throw httpError(404, 'No saved game found for that game id');
  return { ok: true };
}

// Shared by getSavedGames() (the list's one-line position summary) and
// getResumeState() (the real resume payload) — same participant/turn query,
// same {playerIndex,setNo,legNo,darts} shape the pure rebuild functions in
// frontend/scoring.js expect. playerIndex is recovered from game_players'
// insertion order (an implicit SQLite rowid — no other signal records
// "submission order" once players() no longer preserves array position),
// which is the same order createGame() itself inserted them in.
function _resumeStateTurns(gameId) {
  const participants = db.prepare(`
    SELECT p.id AS playerId, p.name AS name, gp.out_mode AS outMode, gp.start_score AS startScore
    FROM game_players gp JOIN players p ON p.id = gp.player_id
    WHERE gp.game_id = ? ORDER BY gp.rowid
  `).all(Number(gameId));
  const idToIndex = new Map(participants.map((p, i) => [p.playerId, i]));
  const dartStmt = db.prepare('SELECT sector, multiplier AS mult FROM darts WHERE turn_id = ? ORDER BY dart_no');
  const turns = db.prepare(`
    SELECT t.id, t.player_id AS playerId, t.set_no AS setNo, t.leg_no AS legNo,
      t.target_score AS targetScore, t.scored AS scored
    FROM turns t WHERE t.game_id = ? ORDER BY t.id
  `).all(Number(gameId)).map(t => ({
    playerIndex: idToIndex.get(t.playerId), setNo: t.setNo, legNo: t.legNo,
    // targetScore/scored: ignored by every rebuild*State() that derives its own
    // state purely from darts (the "replay, not snapshot" contract) — carried
    // through only for rebuildGauntletState(), whose meaningful state legitimately
    // lives in these two stored scalars (docs/archive/gauntlet-roadmap.md's own "storing
    // the station explicitly sidesteps needing that derivation at all").
    targetScore: t.targetScore, scored: t.scored,
    darts: dartStmt.all(t.id).map(d => ({ sector: d.sector, mult: d.mult })),
  }));
  return { participants, turns };
}

// Reuses the exact same pure rebuild functions the real resume path uses
// (frontend/scoring.js) to compute the Saved Games list's one-line position
// summary — rather than a second, parallel "roughly where things stand"
// implementation that could silently drift from what resuming actually
// produces. Returns null for a game type with no meaningful "position" beyond
// the raw turn count (none currently — every SAVABLE_GAME_TYPES entry has one).
function _savedGamePosition(game, participants, turns) {
  const entry = GAME_TYPE_REGISTRY[game.game_type];
  if (!entry || !entry.rebuild) return null;
  const r = entry.rebuild(game, participants, turns);
  return entry.position(game, r);
}

// Everything the New Game resume prompt and the Saved Games list both need —
// one row per saved game, with enough position/opponent context for a
// one-line summary ("Ben & Alaina, 501, Ben leads 2-1, saved July 3rd")
// without a second round-trip per row.
function getSavedGames() {
  const rows = db.prepare(`
    SELECT sg.id AS savedGameId, sg.game_id AS gameId, sg.saved_at AS savedAt,
           g.category AS category, g.game_type AS gameType, g.legs_per_set AS legsPerSet,
           g.sets_per_game AS setsPerGame, g.practice AS practice, g.config AS config
    FROM saved_games sg JOIN games g ON g.id = sg.game_id
    ORDER BY sg.saved_at DESC
  `).all();
  return rows.map(r => {
    const { participants, turns } = _resumeStateTurns(r.gameId);
    const gameRow = { id: r.gameId, game_type: r.gameType, category: r.category, practice: r.practice, legs_per_set: r.legsPerSet, config: r.config };
    // Tournament linkage (docs/archive/saved-games-roadmap.md "Abandoning"): the client
    // needs to know this UP FRONT, before the admin taps Abandon, so it can route
    // to the bracket/walkover control instead of a plain delete — a tournament
    // match can't just be orphaned the way a casual game can.
    const tm = db.prepare('SELECT id FROM tournament_matches WHERE game_id = ?').get(r.gameId);
    return {
      savedGameId: r.savedGameId, gameId: r.gameId, savedAt: r.savedAt,
      category: r.category, gameType: r.gameType, practice: !!r.practice,
      players: participants.map(p => p.name),
      position: _savedGamePosition(gameRow, participants, turns),
      tournamentMatchId: tm ? tm.id : null,
    };
  });
}

// The real resume payload — GET /api/games/:id/resume-state (server.js).
// Deliberately mutates (deletes the saved_games row) as part of this same
// "read": the divergence guard (docs/archive/saved-games-roadmap.md "two devices could
// race") re-verifies the game is still genuinely saved right before consuming
// the pause, so a second device racing the same resume gets a clean 409
// instead of silently double-driving one game from two controllers — doing
// this as a separate mutation call would let a network hiccup between the two
// leave a phantom saved_games row (or a resumed game that still LOOKS saved).
// "The game is simply live again" (the roadmap doc's own framing) — pausing
// again just re-saves it.
function getResumeState(gameId) {
  const game = db.prepare('SELECT id, category, game_type, config, legs_per_set, sets_per_game, practice, completed_at FROM games WHERE id = ?').get(Number(gameId));
  if (!game) throw httpError(404, 'Game not found');
  if (game.completed_at != null) throw httpError(409, 'This game is already complete');
  if (!_savedGameRow(game.id)) {
    throw httpError(409, 'This game is not currently saved — it may already have been resumed or abandoned elsewhere');
  }
  db.prepare('DELETE FROM saved_games WHERE game_id = ?').run(game.id);

  const { participants, turns } = _resumeStateTurns(game.id);
  const tm = db.prepare('SELECT id FROM tournament_matches WHERE game_id = ?').get(game.id);
  const fx = db.prepare('SELECT id FROM league_fixtures WHERE game_id = ?').get(game.id);
  return {
    gameId: game.id, category: game.category, gameType: game.game_type,
    config: game.config ? JSON.parse(game.config) : null,
    legsPerSet: game.legs_per_set, setsPerGame: game.sets_per_game, practice: !!game.practice,
    players: participants.map(p => ({ name: p.name, outMode: p.outMode, startScore: p.startScore ?? null })),
    turns,
    // Tournament/league-fixture linkage restore (docs/archive/saved-games-roadmap.md
    // "Tournament matches and league fixture games... are savable [decided
    // 2026-07]") — the client threads these straight back onto game.tournamentMatchId/
    // game.leagueFixtureId exactly as _reallyBeginTournamentMatch()/startGame()
    // set them the first time, so completion advances the bracket/fulfills the
    // fixture exactly as if never paused.
    tournamentMatchId: tm ? tm.id : null,
    leagueFixtureId: fx ? fx.id : null,
  };
}

/* ---------- daily challenge (docs/archive/daily-challenge-roadmap.md) ---------- */
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
// (docs/archive/daily-challenge-roadmap.md "Player Profile: Daily Challenge history"):
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

// docs/bug-roadmap.md BUG-29: one row per actually-won completed H2H leg
// ({gameId, setNo, legNo, pid, cat, legsPerSet}), used to build the per-category
// H2H legs/sets records. The old `(t.checkout=1 OR t.leg_won=1)` heuristic assumed
// exactly one such signal per won leg — true for X01/Cricket/Baseball/Checkout
// Ladder, but The Pressure Chamber writes checkout=1 on EVERY hit round (so a single
// run counted as up to 15 "won legs"), Halve-It writes neither signal, Shanghai
// writes leg_won=1 only on an instant win (both under-counted), and Killer writes
// NEITHER signal ever (its addTurn branch actively rejects checkout, and no turn
// carries legWon — the win is only on games.winner_id). Here each game type's real
// leg winner is derived the same way its own stat functions already do it, so a
// leg is credited to exactly the player who won it.
// Shared killer leg-replay pipeline — used by _h2hWonLegs() and
// _killerLegOutcomesForPlayer(), which previously carried two near-verbatim
// copies of the same three queries. ONE participants query + ONE turns+darts
// query per game (the per-LEG query cascade made every /api/stats call an N+1
// as killer history grew), grouped into legs in JS, each fed through
// rebuildKillerState() — the same shared replay the write-time guard uses.
// Statements are prepared once at module scope (node:sqlite has no statement
// cache, so a db.prepare inside the loop paid a full SQL compile per iteration).
const _killerReplayStmts = {
  participants: db.prepare(`
    SELECT p.id, p.name FROM game_players gp JOIN players p ON p.id=gp.player_id
    WHERE gp.game_id=? ORDER BY gp.rowid`),
  turns: db.prepare(`
    SELECT t.set_no AS setNo, t.leg_no AS legNo, t.player_id AS playerId,
           d.sector AS sector, d.multiplier AS mult
    FROM turns t JOIN darts d ON d.turn_id=t.id
    WHERE t.game_id=? ORDER BY t.set_no, t.leg_no, t.id`),
};
function _replayKillerLegs(gameId, cfg) {
  const participants = _killerReplayStmts.participants.all(gameId);
  const idToName = new Map(participants.map(pp => [pp.id, pp.name]));
  const names = participants.map(pp => pp.name);
  const legGroups = [];
  let cur = null;
  for (const r of _killerReplayStmts.turns.all(gameId)) {
    if (!cur || cur.setNo !== r.setNo || cur.legNo !== r.legNo) {
      cur = { setNo: r.setNo, legNo: r.legNo, turns: [] };
      legGroups.push(cur);
    }
    cur.turns.push({ throwerName: idToName.get(r.playerId), sector: r.sector, mult: r.mult });
  }
  return { participants, names,
    legs: legGroups.map(l => ({ setNo: l.setNo, legNo: l.legNo,
      state: rebuildKillerState({ participants, numbers: cfg.numbers, turns: l.turns, threshold: cfg.lives }) })) };
}

function _h2hWonLegs() {
  const gameMeta = new Map(db.prepare(`
    SELECT id, category AS cat, legs_per_set AS legsPerSet
    FROM games g WHERE 1=1 ${_mf('h2h')}
  `).all().map(g => [g.id, g]));
  const won = [];
  const push = (gameId, setNo, legNo, pid) => {
    const m = gameMeta.get(gameId);
    if (m) won.push({ gameId, setNo, legNo, pid, cat: m.cat, legsPerSet: m.legsPerSet });
  };

  // Signal types: (checkout=1 OR leg_won=1) marks exactly the leg winner. Excludes the
  // types whose signal doesn't identify a leg winner — pressure_chamber/checkout_trainer
  // (per-round signal), halve_it (no signal), shanghai (points-wins have no signal),
  // killer (no signal at all); each of those is handled by its own derivation below.
  db.prepare(`
    SELECT DISTINCT t.game_id AS gameId, t.set_no AS setNo, t.leg_no AS legNo, t.player_id AS pid
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE (t.checkout=1 OR t.leg_won=1) ${_mf('h2h')}
      AND g.game_type NOT IN ('pressure_chamber','checkout_trainer','halve_it','shanghai','killer')
  `).all().forEach(r => push(r.gameId, r.setNo, r.legNo, r.pid));

  // Killer: no turn ever carries a winner signal, so each leg's winner is derived
  // by replaying its turn history through _replayKillerLegs() — the same shared
  // pipeline _killerLegOutcomesForPlayer() and the write-time guard use.
  const killerGames = db.prepare(`
    SELECT g.id AS gameId, g.config AS config FROM games g
    WHERE g.game_type='killer' AND g.config IS NOT NULL ${_mf('h2h')}
  `).all();
  for (const g of killerGames) {
    const cfg = _parseKillerConfig(g.config);
    if (!cfg) continue;
    const { participants, legs } = _replayKillerLegs(g.gameId, cfg);
    const nameToId = new Map(participants.map(pp => [pp.name, pp.id]));
    for (const { setNo, legNo, state } of legs) {
      if (state.winner && nameToId.has(state.winner)) push(g.gameId, setNo, legNo, nameToId.get(state.winner));
    }
  }

  // Shanghai (hybrid instant/points) and Halve-It (final-total comparison): reuse the
  // exact per-leg winner derivation their own Personal Bests/leaderboards use.
  for (const gt of ['shanghai', 'halve_it']) {
    const pids = db.prepare(`
      SELECT DISTINCT gp.player_id AS pid FROM game_players gp JOIN games g ON g.id=gp.game_id
      WHERE g.game_type=? ${_mf('h2h')}
    `).all(gt).map(r => r.pid);
    for (const pid of pids) {
      const legs = gt === 'shanghai' ? getShanghaiWonLegs(pid, 'h2h') : getHalveItWonLegs(pid, 'h2h');
      for (const l of legs) push(l.gameId ?? l.game_id, l.setNo ?? l.set_no, l.legNo ?? l.leg_no, pid);
    }
  }

  // The Pressure Chamber: the leg winner is the highest CP total in that leg (the same
  // metric pressureChamberDecideWinnerIndex() ranks on), tie-broken fewest misses then
  // fewest darts — a real CP tie is vanishingly unlikely.
  const pcByLeg = new Map();
  for (const l of _pressureChamberLegTotals('h2h').filter(l => l.completed)) {
    const key = `${l.gameId}|${l.setNo}|${l.legNo}`;
    if (!pcByLeg.has(key)) pcByLeg.set(key, []);
    pcByLeg.get(key).push(l);
  }
  for (const legs of pcByLeg.values()) {
    const winner = legs.slice().sort((a, b) => b.total - a.total || a.misses - b.misses || a.darts - b.darts)[0];
    push(winner.gameId, winner.setNo, winner.legNo, winner.playerId);
  }

  return won;
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

  // docs/bug-roadmap.md BUG-29: per-category H2H legs/sets won, derived from the
  // game-type-aware won-leg list (_h2hWonLegs()) instead of the old
  // `(checkout=1 OR leg_won=1)` turn-count heuristic, which over-counted The Pressure
  // Chamber (per-round checkout=1) and under-counted Halve-It/Shanghai. Each won leg is
  // credited to exactly its real winner; a set is won by whoever took at least
  // legs_per_set of its legs.
  const wonLegs = _h2hWonLegs();
  const legsByPidCat = new Map();          // pid -> Map(cat -> legs)
  const setLegCount = new Map();           // "game|set|pid" -> { count, cat, legsPerSet, pid }
  for (const l of wonLegs) {
    if (!legsByPidCat.has(l.pid)) legsByPidCat.set(l.pid, new Map());
    const cm = legsByPidCat.get(l.pid);
    cm.set(l.cat, (cm.get(l.cat) || 0) + 1);
    const sk = `${l.gameId}|${l.setNo}|${l.pid}`;
    let e = setLegCount.get(sk);
    if (!e) { e = { count: 0, cat: l.cat, legsPerSet: l.legsPerSet, pid: l.pid }; setLegCount.set(sk, e); }
    e.count += 1;
  }
  const h2hLegs = [];
  for (const [pid, cm] of legsByPidCat) for (const [cat, legs] of cm) h2hLegs.push({ pid, cat, legs });
  const setsByPidCat = new Map();          // pid -> Map(cat -> sets)
  for (const e of setLegCount.values()) {
    if (e.count >= e.legsPerSet) {
      if (!setsByPidCat.has(e.pid)) setsByPidCat.set(e.pid, new Map());
      const cm = setsByPidCat.get(e.pid);
      cm.set(e.cat, (cm.get(e.cat) || 0) + 1);
    }
  }
  const h2hSets = [];
  for (const [pid, cm] of setsByPidCat) for (const [cat, sets] of cm) h2hSets.push({ pid, cat, sets });

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

  // Average actual darts per won leg — COUNT(darts) replaces the removed darts_thrown
  // column. docs/bug-roadmap.md BUG-29: X01_ONLY — "darts per leg" is an X01 figure
  // (REFERENCE.md §3), and SUM(checkout)>0 is no longer X01-exclusive (a Pressure Chamber
  // leg's ~45 darts across 15 hit rounds would otherwise dilute the average).
  const h2hAvgDarts = db.prepare(`
    SELECT pid, AVG(leg_darts) AS avg_darts FROM (
      SELECT t.player_id AS pid, COUNT(d.id) AS leg_darts
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.practice=0 AND g.player_count>1 ${X01_ONLY}
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
      WHERE g.game_type='x01' AND json_extract(g.config,'$.startingScore')=501 ${extraWhere} ${NOT_HANDICAPPED}
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
  // docs/bug-roadmap.md BUG-27: X01_ONLY — checkout=1 + checkout_points is no longer an
  // X01-exclusive signal (121 Checkout Ladder and Dead Man Walking both write real
  // checkouts too), so Ton+ and Big Fish must scope to X01 or they silently fold in drill
  // checkouts, the same guard getPersonalBests() already applies.
  const tonPlus      = db.prepare(`SELECT COUNT(*) AS n FROM turns t JOIN games g ON g.id=t.game_id WHERE t.checkout=1 AND t.checkout_points>=100 ${X01_ONLY}`).get().n;
  const oneEighties  = db.prepare(`SELECT COUNT(*) AS n FROM turns t JOIN games g ON g.id=t.game_id WHERE t.scored=180 ${X01_ONLY}`).get().n;
  const bigFish      = db.prepare(`SELECT COUNT(*) AS n FROM turns t JOIN games g ON g.id=t.game_id WHERE t.checkout=1 AND t.checkout_points=170 ${X01_ONLY}`).get().n;
  const nineDarters  = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT t.player_id FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.game_type='x01' AND json_extract(g.config,'$.startingScore')=501 ${NOT_HANDICAPPED}
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
  // The all-game-types board is the seventh sibling of the six per-type win
  // leaderboards — same body, just no gameType scope (gameType is optional on
  // _winLeaderboard for exactly this caller), so a ranking-rule tweak can't
  // diverge between the homepage board and the per-type boards.
  const winLeaderboard = _winLeaderboard();

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
    WHERE t.checkout = 1 AND ${modeWhere} ${NOT_CHECKOUT_TRAINER} ${X01_ONLY}
    GROUP BY p.id
    HAVING checkouts >= 3
    ORDER BY (CAST(tonPlus AS REAL) / checkouts) DESC
  `).all().map(r => ({ name: r.name, checkouts: r.checkouts, tonPlus: r.tonPlus,
    rate: r.checkouts ? +((r.tonPlus / r.checkouts) * 100).toFixed(1) : 0 }));
  const tonPlusRows = { h2h: _tonPlus(H2H_WHERE), practice: _tonPlus(PRACTICE_WHERE) };

  // Best First-9 Average leaderboard (docs/archive/first-nine-average-roadmap.md): same
  // per-leg first9avg computation getPlayerStatBubbles()/getPersonalBests() use
  // (OPENING_CATS-scoped, bust-as-3-darts denominator, first up-to-3 visits),
  // averaged per player and ranked descending. `HAVING legs >= 20` — the same
  // lifetime-legs floor COACHING_MIN_LEGS_FOR_FORM uses elsewhere in this file
  // for "trust a small-sample average" — keeps one or two lucky opening legs from
  // topping the board over a player with a genuinely strong, well-established start.
  const _first9 = (modeWhere) => db.prepare(`
    SELECT p.name AS name, COUNT(*) AS legs, AVG(leg.la) AS avgv
    FROM (
      SELECT t.player_id, t.game_id, t.set_no, t.leg_no,
        CAST(SUM(t.scored) AS REAL) / NULLIF(SUM(CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END),0) * 3 AS la
      FROM (
        SELECT t.id, t.player_id, t.game_id, t.set_no, t.leg_no, t.scored, t.bust,
               ROW_NUMBER() OVER (PARTITION BY t.player_id,t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE ${modeWhere} ${OPENING_CATS}
      ) t
      LEFT JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dc ON dc.turn_id = t.id
      WHERE t.rn <= 3
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
    ) leg
    JOIN players p ON p.id = leg.player_id
    GROUP BY leg.player_id
    HAVING legs >= 20
    ORDER BY avgv DESC
  `).all().map(r => ({ name: r.name, legs: r.legs, avg: +r.avgv.toFixed(1) }));
  const first9Rows = { h2h: _first9(H2H_WHERE), practice: _first9(PRACTICE_WHERE) };

  // docs/bug-roadmap.md BUG-27: X01_ONLY — "highest checkout" is an X01-scoped record
  // (REFERENCE.md §3); without it a 121-170 Checkout Ladder / Dead Man Walking finish
  // would top the household record.
  const _highestCheckout = (modeWhere) => db.prepare(`
    SELECT p.name AS name, t.checkout_points AS points, t.created_at AS createdAt
    FROM turns t JOIN players p ON p.id = t.player_id
    JOIN games g ON g.id = t.game_id
    WHERE t.checkout = 1 AND t.checkout_points IS NOT NULL AND ${modeWhere} ${X01_ONLY}
    ORDER BY t.checkout_points DESC, t.created_at ASC
    LIMIT 1
  `).get() || null;
  const highestCheckout = {
    overall: db.prepare(`
      SELECT p.name AS name, t.checkout_points AS points, t.created_at AS createdAt
      FROM turns t JOIN players p ON p.id = t.player_id
      JOIN games g ON g.id = t.game_id
      WHERE t.checkout = 1 AND t.checkout_points IS NOT NULL ${X01_ONLY}
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

  // docs/archive/league-mode-roadmap.md: a small Home-page teaser ("N active leagues, view
  // standings") piggybacks on this existing payload rather than a new endpoint —
  // just the id/name, not full standings (the Leagues screen fetches those itself).
  const activeLeagues = db.prepare(`SELECT id, name FROM leagues WHERE status = 'active' ORDER BY created_at DESC`).all();

  // Household Elo (docs/archive/rating-and-handicap-roadmap.md Part A): piggybacks on
  // this existing payload the same way activeLeagues does just above — a
  // cross-game-type teaser that doesn't belong to any one game type's own
  // Home tab, so it's always visible regardless of which per-game-type
  // toggle is selected, rather than living inside renderHomeTabBody()'s
  // per-type dispatch.
  const eloLeaderboard = getEloLeaderboard();

  return { winLeaderboard, trebleLessRows, tonPlusRows, first9Rows, highestCheckout, lastGame,
    today: { legs: todayLegs, darts: todayDarts }, week: { legs: weekLegs, darts: weekDarts }, pace,
    activeLeagues, eloLeaderboard };
}

// Shared client-timezone modifier for local-time bucketing (timestamps are
// stored UTC): `tzEastMin` is minutes EAST of UTC — the one wire convention
// every tz-taking endpoint uses (clients send `-new Date().getTimezoneOffset()`;
// see getMetricHistory/getOnThisDay/getSessionRecap). Returns a SQLite datetime
// modifier fragment ('' at UTC or on an absent/invalid value — the raw-UTC
// old-client fallback), validated and clamped here so it is safe to interpolate.
function _tzModifier(tzEastMin) {
  const tz = Number(tzEastMin);
  if (!Number.isInteger(tz) || tz < -840 || tz > 840) return '';
  return tz ? `, '${tz >= 0 ? '+' : ''}${tz} minutes'` : '';
}

// End-of-Night Session Recap (docs/archive/session-recap-roadmap.md) — one read-time
// aggregation over a single local calendar date's activity; nothing stored,
// matching the "nothing pre-aggregated" house rule (CLAUDE.md). "The session"
// = the LOCAL calendar date of turns.created_at/games.completed_at. Timestamps
// are stored UTC (datetime('now')), so the client also sends its UTC offset
// (`tz`, minutes EAST of UTC — the same _tzModifier() convention avg-history
// and on-this-day use) and every date() bucket below shifts by it — without
// this, a user west of UTC had every game after ~7-8pm local land in
// TOMORROW's recap, truncating the feature's headline "tonight" use case.
// A night that genuinely straddles the local midnight still splits in two;
// accepted for v1, same as Daily Challenge's own tradeoff — see the roadmap
// doc's Open Questions.
// date is caller-supplied (server.js passes the query params straight through)
// and validated here, matching getChallengeStatus()'s own pattern.
function getSessionRecap(date, tzEastMin) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw httpError(400, 'date must be YYYY-MM-DD');
  const TZ = _tzModifier(tzEastMin);
  // Local-date bucket for a timestamp column — used by every query below, so a
  // future query added to this function can't silently omit the shift.
  const dl = col => `date(${col}${TZ})`;

  // The recap's spine (docs/archive/session-recap-roadmap.md: "the recap's spine is the
  // games people played against each other") — every H2H game (practice=0,
  // player_count>1) that COMPLETED on this date. A single 3+ player game has no
  // single "matchup" pair, so it's listed in h2hGames but left out of
  // h2hResultsByMatchup below.
  const h2hGames = db.prepare(`
    SELECT g.id AS gameId, g.category, g.game_type AS gameType, g.completed_at AS completedAt,
      g.winner_id AS winnerId, w.name AS winnerName
    FROM games g LEFT JOIN players w ON w.id = g.winner_id
    WHERE g.completed_at IS NOT NULL ${_mf('h2h')}
      AND ${dl('g.completed_at')} = ?
    ORDER BY g.completed_at ASC
  `).all(date);
  const gamePlayersStmt = db.prepare(`
    SELECT p.name FROM game_players gp JOIN players p ON p.id = gp.player_id
    WHERE gp.game_id = ? ORDER BY p.name COLLATE NOCASE
  `);
  h2hGames.forEach(g => { g.players = gamePlayersStmt.all(g.gameId).map(r => r.name); });
  const totalGames = h2hGames.length;

  // Pairwise records (2-player matchups only, per the roadmap doc's "head-to-head
  // results grid for the night's matchups") — grouped by the unordered pair, in
  // first-played order.
  const matchupOrder = [];
  const matchupMap = new Map();
  h2hGames.filter(g => g.players.length === 2).forEach(g => {
    const key = g.players.slice().sort((a, b) => a.localeCompare(b)).join('\u0000');
    if (!matchupMap.has(key)) { matchupMap.set(key, { players: g.players.slice(), games: [], record: {} }); matchupOrder.push(key); }
    const m = matchupMap.get(key);
    m.games.push({ gameId: g.gameId, category: g.category, gameType: g.gameType, winner: g.winnerName });
    if (g.winnerName) m.record[g.winnerName] = (m.record[g.winnerName] || 0) + 1;
  });
  const h2hResultsByMatchup = matchupOrder.map(k => matchupMap.get(k));

  // Every player who threw a dart today (H2H or solo/practice) — the universe
  // for perPlayer/soloActivity below.
  const activePlayers = db.prepare(`
    SELECT DISTINCT p.id, p.name FROM turns t
    JOIN players p ON p.id = t.player_id
    WHERE ${dl('t.created_at')} = ?
    ORDER BY p.name COLLATE NOCASE
  `).all(date);

  // Per-player activity tonight. Only the games won/played RECORD is H2H-scoped
  // (the roadmap doc's "the recap's spine is the games people played against
  // each other"); the activity stats (darts thrown, 180s, ton+ checkouts, best
  // visit, best leg) deliberately cover EVERY game type the player touched that
  // date, practice included — REFERENCE.md §29 documents exactly this split, and
  // it's why a solo-practice-only player still shows real darts next to a 0-0
  // record. Best visit/leg are X01-only (same scope getPersonalBests()'s own
  // bestLegAvg uses) — extending "best leg" to every other game type's own
  // formula is left for a future pass rather than ballooning this aggregation.
  const gamesWonStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM games g JOIN game_players gp ON gp.game_id = g.id
    WHERE gp.player_id = ? AND g.winner_id = gp.player_id ${_mf('h2h')}
      AND ${dl('g.completed_at')} = ?
  `);
  const gamesPlayedStmt = db.prepare(`
    SELECT COUNT(DISTINCT g.id) AS n FROM games g JOIN game_players gp ON gp.game_id = g.id
    WHERE gp.player_id = ? ${_mf('h2h')} AND ${dl('g.completed_at')} = ?
  `);
  const dartsTodayStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM darts d JOIN turns t ON t.id = d.turn_id JOIN games g ON g.id = t.game_id
    WHERE t.player_id = ? AND ${dl('t.created_at')} = ? ${NOT_CHECKOUT_TRAINER}
  `);
  const oneEightiesStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM turns t JOIN games g ON g.id = t.game_id
    WHERE t.player_id = ? AND ${dl('t.created_at')} = ? AND t.scored = 180 ${X01_ONLY}
  `);
  const tonPlusStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM turns t JOIN games g ON g.id = t.game_id
    WHERE t.player_id = ? AND ${dl('t.created_at')} = ? AND t.checkout = 1 AND t.checkout_points >= 100 ${X01_ONLY}
  `);
  const bestVisitStmt = db.prepare(`
    SELECT MAX(t.scored) AS v FROM turns t JOIN games g ON g.id = t.game_id
    WHERE t.player_id = ? AND ${dl('t.created_at')} = ? AND t.bust = 0 ${X01_ONLY}
  `);
  const bestLegStmt = db.prepare(`
    SELECT MAX(la) AS avg, MIN(darts) AS minDartsAtBest FROM (
      SELECT CAST(SUM(t.scored) AS REAL)/NULLIF(SUM(CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END),0)*3 AS la,
        SUM(CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END) AS darts
      FROM turns t JOIN games g ON g.id = t.game_id
      JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dc ON dc.turn_id = t.id
      WHERE t.player_id = ? AND ${dl('t.created_at')} = ? ${X01_ONLY}
      GROUP BY t.game_id, t.set_no, t.leg_no
      HAVING SUM(t.checkout) > 0
    )
  `);
  const perPlayer = activePlayers.map(p => {
    const gamesWon = gamesWonStmt.get(p.id, date).n;
    const gamesPlayed = gamesPlayedStmt.get(p.id, date).n;
    const bestLegRow = bestLegStmt.get(p.id, date);
    return {
      name: p.name,
      gamesPlayed, gamesWon, gamesLost: gamesPlayed - gamesWon,
      dartsThrown: dartsTodayStmt.get(p.id, date).n,
      oneEighties: oneEightiesStmt.get(p.id, date).n,
      tonPlusCheckouts: tonPlusStmt.get(p.id, date).n,
      bestVisit: bestVisitStmt.get(p.id, date).v ?? null,
      bestLegAvg: bestLegRow.avg != null ? +bestLegRow.avg.toFixed(1) : null,
    };
  });

  // "Also tonight" — non-H2H (practice or solo) activity, deliberately NOT
  // itemized (roadmap doc: "appear as a light 'also tonight' line, not fully
  // itemized"). Grouped by player+game_type: rounds/legs played (excluding the
  // continuous-stream types, same NOT_CONTINUOUS_STREAM convention as
  // getHomeExtra()'s todayLegs) and darts thrown.
  const soloActivity = db.prepare(`
    SELECT p.name AS name, g.game_type AS gameType,
      COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS legs,
      COUNT(d.id) AS darts
    FROM turns t
    JOIN players p ON p.id = t.player_id
    JOIN games g ON g.id = t.game_id
    LEFT JOIN darts d ON d.turn_id = t.id
    WHERE ${dl('t.created_at')} = ? ${_mf('practice')}
    GROUP BY p.id, g.game_type
    ORDER BY p.name COLLATE NOCASE, g.game_type
  `).all(date).map(r => ({
    name: r.name, gameType: r.gameType,
    // "legs" is meaningless for the continuous-stream types (one long session,
    // no round boundary) — same set NOT_CONTINUOUS_STREAM excludes elsewhere —
    // so only darts thrown is reported for those; every other solo/practice
    // type reports both.
    legs: ['chuckin', 'checkout_trainer', 'around_the_world'].includes(r.gameType) ? null : r.legs,
    darts: r.darts,
  }));

  // Badges earned tonight (player_badges.earned_at date-scoped) — raw badge_id
  // only; label/icon/description live in the frontend's own BADGE_INFO map
  // (single source of truth, same as everywhere else badges surface).
  const badgesEarnedTonight = db.prepare(`
    SELECT p.name AS player, pb.badge_id AS badgeId, pb.count AS count, pb.earned_at AS earnedAt
    FROM player_badges pb JOIN players p ON p.id = pb.player_id
    WHERE ${dl('pb.earned_at')} = ?
    ORDER BY pb.earned_at ASC
  `).all(date);

  // Personal bests set tonight (X01 only — see perPlayer's own scoping note
  // above) — tonight's own best for each of 3 well-defined single-number
  // records, compared against the SAME player's best from every day BEFORE
  // this one. A record only counts if tonight's value exists and beats (or, for
  // a first-ever occurrence, simply exists where there was no prior value) the
  // pre-tonight baseline in the correct direction — ascending for leg average/
  // highest checkout, descending for fewest-darts checkout.
  const preLegAvgStmt = db.prepare(`
    SELECT MAX(la) AS v FROM (
      SELECT CAST(SUM(t.scored) AS REAL)/NULLIF(SUM(CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END),0)*3 AS la
      FROM turns t JOIN games g ON g.id = t.game_id
      JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dc ON dc.turn_id = t.id
      WHERE t.player_id = ? AND ${dl('t.created_at')} < ? ${X01_ONLY}
      GROUP BY t.game_id, t.set_no, t.leg_no HAVING SUM(t.checkout) > 0
    )
  `);
  const preFewestDartsStmt = db.prepare(`
    SELECT MIN(legDarts) AS v FROM (
      SELECT COUNT(d.id) AS legDarts FROM turns t JOIN games g ON g.id = t.game_id JOIN darts d ON d.turn_id = t.id
      WHERE t.player_id = ? AND ${dl('t.created_at')} < ? ${NOT_CHECKOUT_TRAINER} ${NOT_HANDICAPPED} ${X01_ONLY}
      GROUP BY t.game_id, t.set_no, t.leg_no HAVING SUM(t.checkout) > 0
    )
  `);
  // docs/bug-roadmap.md BUG-27: X01_ONLY on all four Personal-Best-tonight checkout
  // statements — highest checkout and fewest-darts-to-checkout are X01-scoped records
  // (matching getPersonalBests()), and checkout=1 is no longer X01-exclusive (121
  // Checkout Ladder / Dead Man Walking both write it), so without this a drill checkout
  // would fire a false "new personal best tonight."
  const preHighestCheckoutStmt = db.prepare(`
    SELECT MAX(t.checkout_points) AS v FROM turns t JOIN games g ON g.id = t.game_id
    WHERE t.player_id = ? AND ${dl('t.created_at')} < ? AND t.checkout = 1 AND t.checkout_points IS NOT NULL ${X01_ONLY}
  `);
  const tonightFewestDartsStmt = db.prepare(`
    SELECT MIN(legDarts) AS v FROM (
      SELECT COUNT(d.id) AS legDarts FROM turns t JOIN games g ON g.id = t.game_id JOIN darts d ON d.turn_id = t.id
      WHERE t.player_id = ? AND ${dl('t.created_at')} = ? ${NOT_CHECKOUT_TRAINER} ${NOT_HANDICAPPED} ${X01_ONLY}
      GROUP BY t.game_id, t.set_no, t.leg_no HAVING SUM(t.checkout) > 0
    )
  `);
  const tonightHighestCheckoutStmt = db.prepare(`
    SELECT MAX(t.checkout_points) AS v FROM turns t JOIN games g ON g.id = t.game_id
    WHERE t.player_id = ? AND ${dl('t.created_at')} = ? AND t.checkout = 1 AND t.checkout_points IS NOT NULL ${X01_ONLY}
  `);
  const personalBestsSetTonight = [];
  activePlayers.forEach(p => {
    const tonightLegAvg = perPlayer.find(pp => pp.name === p.name)?.bestLegAvg ?? null;
    const preLegAvg = preLegAvgStmt.get(p.id, date).v;
    if (tonightLegAvg != null && (preLegAvg == null || tonightLegAvg > preLegAvg)) {
      personalBestsSetTonight.push({ player: p.name, metric: 'legAvg', value: tonightLegAvg, previousBest: preLegAvg != null ? +preLegAvg.toFixed(1) : null });
    }
    const tonightFewest = tonightFewestDartsStmt.get(p.id, date).v;
    const preFewest = preFewestDartsStmt.get(p.id, date).v;
    if (tonightFewest != null && (preFewest == null || tonightFewest < preFewest)) {
      personalBestsSetTonight.push({ player: p.name, metric: 'fewestDartsCheckout', value: tonightFewest, previousBest: preFewest ?? null });
    }
    const tonightHighest = tonightHighestCheckoutStmt.get(p.id, date).v;
    const preHighest = preHighestCheckoutStmt.get(p.id, date).v;
    if (tonightHighest != null && (preHighest == null || tonightHighest > preHighest)) {
      personalBestsSetTonight.push({ player: p.name, metric: 'highestCheckout', value: tonightHighest, previousBest: preHighest ?? null });
    }
  });

  // Chronological moments timeline — the same event classes the live moment
  // cards already fire on, merged and sorted by when they actually happened.
  const moments = [];
  db.prepare(`
    SELECT t.created_at AS ts, p.name AS player FROM turns t JOIN players p ON p.id = t.player_id JOIN games g ON g.id = t.game_id
    WHERE ${dl('t.created_at')} = ? AND t.scored = 180 ${X01_ONLY}
  `).all(date).forEach(r => moments.push({ ts: r.ts, type: '180', player: r.player, text: '180!' }));
  db.prepare(`
    SELECT t.created_at AS ts, p.name AS player, t.checkout_points AS points FROM turns t JOIN players p ON p.id = t.player_id JOIN games g ON g.id = t.game_id
    WHERE ${dl('t.created_at')} = ? AND t.checkout = 1 AND t.checkout_points >= 100 ${X01_ONLY}
  `).all(date).forEach(r => moments.push({ ts: r.ts, type: r.points === 170 ? 'bigfish' : 'tonplus', player: r.player, text: `Checked out ${r.points}` }));
  h2hGames.forEach(g => { if (g.winnerName) moments.push({ ts: g.completedAt, type: 'matchwin', player: g.winnerName, text: `Won ${g.category}` }); });
  badgesEarnedTonight.forEach(b => moments.push({ ts: b.earnedAt, type: 'badge', player: b.player, text: b.badgeId }));
  moments.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);

  return {
    date, totalGames,
    h2hGames, h2hResultsByMatchup,
    perPlayer, soloActivity,
    badgesEarnedTonight, personalBestsSetTonight,
    moments,
  };
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
  // X01-scoped counterparts of the two lifetime/all-modes figures above (Player
  // Profile's "Lifetime" block uses dartsThrown/avgDartsPerDay; the X01 tab's own
  // stat bubbles use these instead, so a Chuckin' or Cricket dart never inflates
  // what's supposed to be an X01-only count).
  const x01DartsThrown    = qd(`SELECT COUNT(*) AS v ${JD} ${mf} ${X01_ONLY}`) ?? 0;
  const x01AvgDartsPerDay = qd(`SELECT CAST(COUNT(*) AS REAL)/NULLIF(COUNT(DISTINCT date(t.created_at)),0) AS v ${JD} ${mf} ${X01_ONLY}`);
  // X01_ONLY: same fix as getPersonalBests()'s legAvgSql/fewestDartsCheckout —
  // checkout=1 alone no longer implies "this is an X01 leg" now that Checkout
  // Ladder and Dead Man Walking both set it too on non-X01 turns.
  const avgDartsPerLeg = qd(`SELECT AVG(leg_darts) AS v FROM (SELECT COUNT(d.id) AS leg_darts ${JD} ${mf} ${X01_ONLY} GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(t.checkout)>0)`);
  const legsWithOneEighty = q(`SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS v ${J} ${mf} ${X01_ONLY} AND t.scored=180`) ?? 0;
  // Standard 3-dart average: total points / counted darts * 3, where a bust counts
  // as a full 3-dart visit and a winning visit counts only the darts actually thrown.
  const avgDarts   = qd(`SELECT SUM(adj) AS v FROM (SELECT CASE WHEN t.bust=1 THEN 3 ELSE COUNT(d.id) END AS adj ${JD} ${mf} ${X01_ONLY} GROUP BY t.id)`) ?? 0;
  const totalPts   = q(`SELECT SUM(t.scored) AS v ${J} ${mf} ${X01_ONLY}`) ?? 0;
  const avg        = avgDarts > 0 ? (totalPts / avgDarts * 3) : null;
  const one80s     = q(`SELECT COUNT(*) AS v ${J} ${mf} ${X01_ONLY} AND t.scored=180`) ?? 0;
  const bigFish    = q(`SELECT COUNT(*) AS v ${J} ${mf} ${X01_ONLY} AND t.checkout=1 AND t.checkout_points=170`) ?? 0;
  const nineDarters= qd(`SELECT COUNT(*) AS v FROM (SELECT 1 ${JD} ${mf} AND g.game_type='x01' AND json_extract(g.config,'$.startingScore')=501 ${NOT_HANDICAPPED} GROUP BY t.game_id,t.set_no,t.leg_no HAVING COUNT(DISTINCT t.id)=3 AND SUM(t.checkout)>0 AND COUNT(d.id)=9)`) ?? 0;
  // totalLegs is only ever a denominator for the X01 leg stats below (trebleless %,
  // 180s/leg) — X01-scoped so a cricket leg can't dilute either.
  const totalLegs  = q(`SELECT COUNT(DISTINCT t.game_id||'-'||t.set_no||'-'||t.leg_no) AS v ${J} ${mf} ${X01_ONLY}`) ?? 0;
  // tlLegs: legs where no dart was a treble
  const tlLegs     = qd(`SELECT COUNT(*) AS v FROM (SELECT t.game_id,t.set_no,t.leg_no ${JD} ${mf} ${X01_ONLY} GROUP BY t.game_id,t.set_no,t.leg_no HAVING SUM(d.is_treble)=0)`) ?? 0;

  // first3avg / first9avg / score140pct ("opening exchanges" stats) share the
  // module-level OPENING_CATS scope (exactly 501/301/170/101) — see its own
  // comment above X01_ONLY for the full rationale.

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
    dartsThrown, avgDartsPerDay, x01DartsThrown, x01AvgDartsPerDay, avgDartsPerLeg, avg, one80s, bigFish, nineDarters,
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

// Shared H2H win/loss leaderboard body — every game type whose match win lives
// on games.winner_id ranks identically (played/won/rate, HAVING played >= 1,
// most wins first, fewest games as tie-break). H2H-only by nature (practice has
// no opponent to win against), so no mode param. gameType is optional: omitted,
// it produces getHomeExtra()'s all-game-types board. One body behind seven
// callers, so a ranking-rule tweak can never silently diverge between them.
function _winLeaderboard(gameType) {
  const scope = _scope({ mode: 'h2h', gameType });
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

function getCricketWinLeaderboard() { return _winLeaderboard('cricket'); }

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

  // X01_ONLY: t.checkout=1 is no longer a reliable "this is a real X01 leg"
  // signal on its own — it started out only ever set by X01 (and Checkout
  // Trainer's proposed-route checkout, excluded via NOT_CHECKOUT_TRAINER), but
  // Checkout Ladder and Dead Man Walking both now set a genuine checkout=1 too,
  // on ordinary turns rows that AREN'T X01 legs at all. Without an explicit
  // X01_ONLY filter here, a player's Checkout Ladder climbs or Dead Man
  // Walking Walked Out rounds silently leaked into this "X01 Personal Bests"
  // computation — found via a real committed test (docs/dead-man-walking-
  // roadmap.md's own isolation-regression requirement) that played a Dead Man
  // Walking run and caught bestLegAvg/bestLeg/recentFormAvg/lifetimeAvg all
  // changing from null to real (wrong) values. bestLeg in particular feeds the
  // Ghost Opponent "Race this leg" button, which is explicitly X01-only
  // (docs/archive/ghost-opponent-roadmap.md) — pointing it at a personalized-
  // deficit Dead Man Walking round or a non-501 Checkout Ladder attempt would
  // have made that button silently replay the wrong thing.
  const legAvgSql = `
    SELECT t.game_id, t.set_no, t.leg_no, MAX(t.id) AS lastTurnId,
      CAST(SUM(t.scored) AS REAL)/NULLIF(SUM(CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END),0)*3 AS la
    FROM turns t JOIN games g ON g.id=t.game_id
    JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dc ON dc.turn_id=t.id
    WHERE t.player_id=? ${mf} ${NOT_CHECKOUT_TRAINER} ${X01_ONLY}
    GROUP BY t.game_id,t.set_no,t.leg_no
    HAVING SUM(t.checkout)>0
  `;
  const legs = db.prepare(legAvgSql).all(p.id);
  const bestLegRow = legs.length ? legs.reduce((best, r) => r.la > best.la ? r : best) : null;
  const bestLegAvg = bestLegRow ? bestLegRow.la : null;
  const bestLeg = bestLegRow ? { gameId: bestLegRow.game_id, setNo: bestLegRow.set_no, legNo: bestLegRow.leg_no } : null;

  // Best First-9 (docs/archive/first-nine-average-roadmap.md): MAX of the same per-leg
  // first9avg computation getPlayerStatBubbles() averages — same OPENING_CATS scope
  // (501/301/170/101), same bust-as-3-darts denominator, same "first up-to-3
  // visits" window. Deliberately NOT restricted to won legs the way bestLegAvg is
  // above: the opening 9 darts are already fully determined the moment the 3rd
  // visit is recorded, regardless of how (or whether yet) the leg ends, and the
  // stat bubble this mirrors carries no such restriction either — adding one here
  // would silently disagree with the bubble over what counts. (No "race this leg"
  // deep link the way bestLeg gets: Ghost mode can only replay a leg this player
  // actually won, so pointing it at a first9-record leg that's unfinished or lost
  // would frequently 404.)
  const bestFirst9 = db.prepare(`
    SELECT MAX(CAST(total_scored AS REAL) / NULLIF(dart_count,0) * 3) AS v FROM (
      SELECT SUM(t.scored) AS total_scored,
             SUM(CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END) AS dart_count
      FROM (SELECT t.id, t.game_id, t.set_no, t.leg_no, t.scored, t.bust,
                   ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
            FROM turns t JOIN games g ON g.id=t.game_id
            WHERE t.player_id=? ${mf} ${OPENING_CATS}) t
      LEFT JOIN (SELECT turn_id, COUNT(*) AS cnt FROM darts GROUP BY turn_id) dc ON dc.turn_id = t.id
      WHERE t.rn <= 3
      GROUP BY t.game_id, t.set_no, t.leg_no
    )
  `).get(p.id)?.v ?? null;

  // Same X01_ONLY fix as legAvgSql above — a Checkout Ladder/Dead Man Walking
  // checkout is real, but not an X01 leg, and must not shrink this figure.
  const fewestDartsCheckout = db.prepare(`
    SELECT MIN(leg_darts) AS v FROM (
      SELECT COUNT(d.id) AS leg_darts
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE t.player_id=? ${mf} ${NOT_CHECKOUT_TRAINER} ${NOT_HANDICAPPED} ${X01_ONLY}
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

  return { bestLegAvg, bestLeg, bestFirst9, fewestDartsCheckout, winStreak, recentFormAvg, lifetimeAvg };
}

// Ghost Opponent (docs/archive/ghost-opponent-roadmap.md): pick one of your own past won
// X01 legs to replay dart-by-dart as a virtual second player. Deliberately X01-only
// for v1 — Cricket's leg_won signal would need its own MPR-based candidate/script
// queries, deferred until Cricket ghost support is actually requested.
//
// Browsable list of past legs this player won — the "browsable list"
// alternative to picking straight from Personal Bests' best-leg-average entry.
// GHOST_LEG_SORTS whitelists the only 3 orderings the picker's "sort by"
// control offers (never interpolate a raw request value into ORDER BY —
// SEC-18 discipline); `sort` outside this set silently falls back to 'recent',
// same "constrain the payload, don't trust it" posture as the rest of the file.
const GHOST_LEG_SORTS = {
  recent: 'date DESC, lastTurnId DESC',
  // Ties on `avg` break the same way 'recent' does — newest first — rather
  // than an arbitrary DB-order tie, so paging is stable across requests.
  best:   'avg DESC, date DESC, lastTurnId DESC',
  worst:  'avg ASC, date DESC, lastTurnId DESC',
};
function getGhostCandidateLegs(playerName, limit, opts) {
  const p = getPlayer(playerName);
  if (!p) return [];
  // docs/security-audit-roadmap.md SEC-23: this is a public, unauthenticated route
  // (GET /api/players/ghost-legs) — an unbounded `limit` forced a full grouped scan
  // over every X01 leg the player has ever played and returned it in one response.
  // Clamp the same way getServerErrors() already clamps its own admin-only `limit`.
  const lim = Math.min(Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20, 100);
  const offset = Number.isInteger(Number(opts && opts.offset)) && Number(opts && opts.offset) > 0 ? Number(opts.offset) : 0;
  const orderBy = GHOST_LEG_SORTS[opts && opts.sort] || GHOST_LEG_SORTS.recent;
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
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(p.id, lim, offset).map(({ lastTurnId, ...r }) => r);
}
// Total count of ghost-race-able legs (same WHERE/HAVING as getGhostCandidateLegs,
// no LIMIT/OFFSET) — lets the picker's pagination controls know how many pages
// exist / whether "Next" should be disabled, without fetching every row.
function getGhostCandidateLegsCount(playerName) {
  const p = getPlayer(playerName);
  if (!p) return 0;
  return db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT 1 FROM turns t JOIN games g ON g.id = t.game_id
      WHERE t.player_id = ? AND g.game_type = 'x01'
      GROUP BY t.game_id, t.set_no, t.leg_no
      HAVING SUM(t.checkout) > 0
    )
  `).get(p.id).c;
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

// Baseball's stat-bubble equivalents (game-modes-roadmap.md "Baseball" — stats
// pass). Runs Per Inning (RPI) is Baseball's direct analog of X01's 3-dart
// average / Cricket's MPR: total runs / total rounds (innings/turns) played.
// Unlike Cricket's marks (derived from darts+config.numbers at query time),
// turns.scored for a Baseball turn already IS that visit's runs
// (enterTurnBaseball() writes scored:ev.scored directly), so these read
// turns.scored as-is — no per-dart derivation needed.
function getBaseballStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'baseball' });

  const row = db.prepare(`
    SELECT COUNT(*) AS rounds, COALESCE(SUM(t.scored),0) AS totalRuns,
           COALESCE(MAX(t.scored),0) AS bestInning,
           COALESCE(SUM(CASE WHEN t.scored=9 THEN 1 ELSE 0 END),0) AS perfectInnings
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? ${scope}
  `).get(p.id);
  const rounds = row?.rounds ?? 0;
  const rpi = rounds > 0 ? (row.totalRuns / rounds) : null;
  const bestInning = rounds > 0 ? row.bestInning : null;

  const gamesRow = db.prepare(`
    SELECT COUNT(*) AS played, SUM(CASE WHEN g.winner_id=? THEN 1 ELSE 0 END) AS won
    FROM game_players gp JOIN games g ON g.id=gp.game_id
    WHERE gp.player_id=? ${scope} AND g.completed_at IS NOT NULL
  `).get(p.id, p.id);
  const gamesPlayed = gamesRow?.played ?? 0;
  const winPct = gamesPlayed > 0 ? (gamesRow.won / gamesPlayed * 100) : null;

  const dartsThrown = db.prepare(`SELECT COUNT(*) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;

  // totalRuns (docs/archive/culture-badges-roadmap.md Part B): the raw SUM(scored) rpi is
  // already computed from, exposed directly so the frontend's lifetime runs ladder
  // (newMatchPlayerBaseball()'s lifetimeRunsBase) has a base to fetch — same
  // "no mode param -> genuinely unscoped lifetime" pattern the 180s ladder uses.
  return { rpi, perfectInnings: row?.perfectInnings ?? 0, winPct, gamesPlayed, dartsThrown, bestInning, totalRuns: row?.totalRuns ?? 0 };
}

// Baseball has no turns.leg_won signal (unlike X01/Cricket): a Baseball leg's
// winner isn't self-referential to a single player's own visit the way a
// checkout or closing every Cricket number is — evaluateVisitBaseball()'s own
// comment notes the round-ending visit and the actual highest scorer aren't
// always the same player, so there's no one turn to flag "this won the leg."
// Instead, a "won leg" is derived at query time: each player's total runs per
// (game,set,leg), compared against the max among that leg's participants —
// exactly how the live game itself determines a winner (see
// evaluateVisitBaseball()'s matchComplete/winnerIndex). Scoped to
// g.completed_at IS NOT NULL as a safety net: an abandoned mid-leg's partial
// totals can never be mistaken for a real result, since an abandoned game
// never sets completed_at at all — this can only ever under-count a real
// completed leg belonging to a since-abandoned multi-leg match, never
// fabricate a win.
function getBaseballWonLegs(playerId, mode) {
  const scope = _scope({ mode, gameType: 'baseball' });
  return db.prepare(`
    WITH turn_totals AS (
      -- Per-turn darts pre-aggregated first (like getMetricHistory()'s 'avg' case
      -- does for X01) so the darts JOIN doesn't fan out t.scored — without this,
      -- a 3-dart turn's scored value gets summed 3x instead of once.
      SELECT t.id AS turn_id, t.game_id, t.set_no, t.leg_no, t.player_id,
             t.scored AS runs, COUNT(d.id) AS darts
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.completed_at IS NOT NULL ${scope}
      GROUP BY t.id
    ),
    leg_totals AS (
      SELECT game_id, set_no, leg_no, player_id, MAX(turn_id) AS lastTurnId,
             SUM(runs) AS runs, SUM(darts) AS darts
      FROM turn_totals
      GROUP BY game_id, set_no, leg_no, player_id
    ),
    leg_max AS (
      SELECT game_id, set_no, leg_no, MAX(runs) AS maxRuns
      FROM leg_totals GROUP BY game_id, set_no, leg_no
    )
    SELECT lt.game_id, lt.set_no, lt.leg_no, lt.runs, lt.darts, lt.lastTurnId
    FROM leg_totals lt JOIN leg_max lm
      ON lm.game_id=lt.game_id AND lm.set_no=lt.set_no AND lm.leg_no=lt.leg_no
    WHERE lt.player_id=? AND lt.runs=lm.maxRuns
  `).all(playerId);
}

// Baseball's Personal Bests — same 5-field shape as getPersonalBests()/
// getCricketPersonalBests(), adapted to what's actually meaningful for a
// fixed-inning-count game: darts-per-leg is nearly constant in X01/Cricket
// terms of reflecting skill (every leg is 9 innings times however many darts
// each visit used, extended only by extra innings on a tie), so
// fewestDartsToWin reads as "won in regulation vs. needed extra innings"
// rather than Cricket's "closed efficiently" framing — still a genuine skill
// signal, just a differently-shaped one.
function getBaseballPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;

  const legs = getBaseballWonLegs(p.id, mode);
  const bestLegRuns = legs.length ? Math.max(...legs.map(l => l.runs)) : null;
  const fewestDartsToWin = legs.length ? Math.min(...legs.map(l => l.darts)) : null;

  const recentLegs = legs.slice().sort((a, b) => b.lastTurnId - a.lastTurnId).slice(0, 10);
  const recentFormRuns = recentLegs.length ? recentLegs.reduce((s, l) => s + l.runs, 0) / recentLegs.length : null;
  const lifetimeRuns = legs.length ? legs.reduce((s, l) => s + l.runs, 0) / legs.length : null;

  let winStreak = 0;
  if (mode !== 'practice') {
    const h2hScope = _scope({ mode: 'h2h', gameType: 'baseball' });
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

  return { bestLegRuns, fewestDartsToWin, winStreak, recentFormRuns, lifetimeRuns };
}

// Home page leaderboards for Baseball — direct structural analogs of Cricket's
// four getCricket*() leaderboard/stat functions (9 Marks, MPR, Wins, Perfect Leg),
// mapped onto Baseball's own vocabulary: Perfect Inning is the per-visit max
// (9 runs, three trebles) mirroring 9 Marks; RPI (runs per inning) mirrors MPR;
// Wins is identical in shape; Perfect Game (81 runs across all 9 innings) mirrors
// Perfect Leg.

// Perfect Inning leaderboard + recent feed — counts every turn where a player
// scored the inning max (9 runs / three trebles on target), same
// leaderboard+recent shape as getCricketNineMarksStats().
function getBaseballPerfectInningsStats(mode) {
  const scope = _scope({ mode, gameType: 'baseball' });
  const base = `
    SELECT t.id, t.player_id, t.created_at
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE t.scored=9 ${scope}
  `;
  const leaderboard = db.prepare(`SELECT p.name, COUNT(*) AS count FROM (${base}) x JOIN players p ON p.id=x.player_id GROUP BY x.player_id ORDER BY count DESC`).all();
  const recent      = db.prepare(`SELECT p.name, x.created_at FROM (${base}) x JOIN players p ON p.id=x.player_id ORDER BY x.created_at DESC LIMIT 10`).all();
  return { leaderboard, recent };
}

// RPI (runs per inning) leaderboard — direct analog of getCricketMprLeaderboard(),
// same minimum-rounds floor to keep one lucky inning from topping the board.
function getBaseballRpiLeaderboard(mode) {
  const scope = _scope({ mode, gameType: 'baseball' });
  const rows = db.prepare(`
    SELECT p.name AS name, COUNT(*) AS rounds, SUM(t.scored) AS runs
    FROM turns t JOIN games g ON g.id=t.game_id JOIN players p ON p.id=t.player_id
    WHERE 1=1 ${scope}
    GROUP BY t.player_id
    HAVING rounds >= 5
  `).all();
  return rows
    .map(r => ({ name: r.name, rpi: +(r.runs / r.rounds).toFixed(2), rounds: r.rounds }))
    .sort((a, b) => b.rpi - a.rpi);
}

function getBaseballWinLeaderboard() { return _winLeaderboard('baseball'); }

// Perfect Game leaderboard + recent feed — a leg won with 9 runs in every one of
// the 9 innings (81 total, the mathematical max), mirroring
// getCricketPerfectLegStats(). Unlike getBaseballWonLegs(), a Perfect Game is
// trivially always the leg's winner (81 is the max possible score), so no
// intersection with the general "won legs" derivation is needed here.
function getBaseballPerfectGameStats(mode) {
  const scope = _scope({ mode, gameType: 'baseball' });
  const base = `
    SELECT t.player_id, MAX(t.id) AS lastTurnId, MAX(t.created_at) AS created_at
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE g.completed_at IS NOT NULL ${scope}
    GROUP BY t.game_id, t.set_no, t.leg_no, t.player_id
    HAVING COUNT(t.id) = 9 AND SUM(t.scored) = 81
  `;
  const leaderboard = db.prepare(`SELECT p.name, COUNT(*) AS count FROM (${base}) x JOIN players p ON p.id=x.player_id GROUP BY x.player_id ORDER BY count DESC`).all();
  const recent      = db.prepare(`SELECT p.name, x.created_at FROM (${base}) x JOIN players p ON p.id=x.player_id ORDER BY x.created_at DESC LIMIT 10`).all();
  return { leaderboard, recent };
}

/* ---------- Shanghai (docs/archive/shanghai-roadmap.md) ----------
   turns.scored for a Shanghai turn already IS that visit's points on the
   round's own number (enterTurnShanghai() writes scored:ev.scored directly,
   same as Baseball), so these read turns.scored as-is like Baseball's own
   block above. Points-per-round is Shanghai's direct analog of Baseball's RPI. */
function getShanghaiStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'shanghai' });

  const row = db.prepare(`
    SELECT COUNT(*) AS rounds, COALESCE(SUM(t.scored),0) AS totalPoints,
           COALESCE(MAX(t.scored),0) AS bestRound,
           COALESCE(SUM(t.leg_won),0) AS shanghaisThrown
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? ${scope}
  `).get(p.id);
  const rounds = row?.rounds ?? 0;
  const ppr = rounds > 0 ? (row.totalPoints / rounds) : null;
  const bestRound = rounds > 0 ? row.bestRound : null;

  const gamesRow = db.prepare(`
    SELECT COUNT(*) AS played, SUM(CASE WHEN g.winner_id=? THEN 1 ELSE 0 END) AS won
    FROM game_players gp JOIN games g ON g.id=gp.game_id
    WHERE gp.player_id=? ${scope} AND g.completed_at IS NOT NULL
  `).get(p.id, p.id);
  const gamesPlayed = gamesRow?.played ?? 0;
  const winPct = gamesPlayed > 0 ? (gamesRow.won / gamesPlayed * 100) : null;

  const dartsThrown = db.prepare(`SELECT COUNT(*) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;

  return { ppr, bestRound, shanghaisThrown: row?.shanghaisThrown ?? 0, winPct, gamesPlayed, dartsThrown, totalPoints: row?.totalPoints ?? 0 };
}

// A completed Shanghai leg ends exactly one of two ways (evaluateVisitShanghai()
// never allows a third): (1) an instant Shanghai -- self-referential to the
// winning player's own visit, same signal Cricket uses turns.leg_won for;
// or (2) the final round completes with no Shanghai thrown, decided by whichever
// player has the higher point total -- NOT self-referential to any one turn
// (the round-ending visit and the actual leader aren't always the same player),
// same situation getBaseballWonLegs() handles. So this unions both derivations:
// legs already decided by a leg_won=1 turn use that signal directly; every other
// completed leg falls back to the total-points-max comparison.
function getShanghaiWonLegs(playerId, mode) {
  const scope = _scope({ mode, gameType: 'shanghai' });

  const shanghaiWins = db.prepare(`
    SELECT t.game_id, t.set_no, t.leg_no,
      (SELECT COALESCE(SUM(t2.scored),0) FROM turns t2 WHERE t2.game_id=t.game_id AND t2.set_no=t.set_no AND t2.leg_no=t.leg_no AND t2.player_id=t.player_id) AS points,
      (SELECT COUNT(d2.id) FROM turns t2 JOIN darts d2 ON d2.turn_id=t2.id WHERE t2.game_id=t.game_id AND t2.set_no=t.set_no AND t2.leg_no=t.leg_no AND t2.player_id=t.player_id) AS darts,
      t.id AS lastTurnId
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE t.leg_won=1 AND t.player_id=? ${scope}
  `).all(playerId);

  const finalRoundWins = db.prepare(`
    WITH turn_totals AS (
      SELECT t.id AS turn_id, t.game_id, t.set_no, t.leg_no, t.player_id, t.scored AS points, COUNT(d.id) AS darts
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.completed_at IS NOT NULL ${scope}
      GROUP BY t.id
    ),
    leg_totals AS (
      SELECT game_id, set_no, leg_no, player_id, MAX(turn_id) AS lastTurnId, SUM(points) AS points, SUM(darts) AS darts
      FROM turn_totals GROUP BY game_id, set_no, leg_no, player_id
    ),
    decided_by_shanghai AS (
      SELECT DISTINCT game_id, set_no, leg_no FROM turns WHERE leg_won=1
    ),
    leg_max AS (
      SELECT lt.game_id, lt.set_no, lt.leg_no, MAX(lt.points) AS maxPoints
      FROM leg_totals lt
      LEFT JOIN decided_by_shanghai dbs ON dbs.game_id=lt.game_id AND dbs.set_no=lt.set_no AND dbs.leg_no=lt.leg_no
      WHERE dbs.game_id IS NULL
      GROUP BY lt.game_id, lt.set_no, lt.leg_no
    )
    SELECT lt.game_id, lt.set_no, lt.leg_no, lt.points, lt.darts, lt.lastTurnId
    FROM leg_totals lt JOIN leg_max lm ON lm.game_id=lt.game_id AND lm.set_no=lt.set_no AND lm.leg_no=lt.leg_no
    WHERE lt.player_id=? AND lt.points=lm.maxPoints
  `).all(playerId);

  return shanghaiWins.concat(finalRoundWins);
}

// Shanghai's Personal Bests -- same 5-field shape as getBaseballPersonalBests(),
// built on getShanghaiWonLegs()'s hybrid leg-winner derivation.
function getShanghaiPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;

  const legs = getShanghaiWonLegs(p.id, mode);
  const bestLegPoints = legs.length ? Math.max(...legs.map(l => l.points)) : null;
  const fewestDartsToWin = legs.length ? Math.min(...legs.map(l => l.darts)) : null;

  const recentLegs = legs.slice().sort((a, b) => b.lastTurnId - a.lastTurnId).slice(0, 10);
  const recentFormPoints = recentLegs.length ? recentLegs.reduce((s, l) => s + l.points, 0) / recentLegs.length : null;
  const lifetimePoints = legs.length ? legs.reduce((s, l) => s + l.points, 0) / legs.length : null;

  let winStreak = 0;
  if (mode !== 'practice') {
    const h2hScope = _scope({ mode: 'h2h', gameType: 'shanghai' });
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

  return { bestLegPoints, fewestDartsToWin, winStreak, recentFormPoints, lifetimePoints };
}

// Points-per-round leaderboard -- direct analog of getBaseballRpiLeaderboard(),
// same minimum-rounds floor to keep one lucky round from topping the board.
function getShanghaiPprLeaderboard(mode) {
  const scope = _scope({ mode, gameType: 'shanghai' });
  const rows = db.prepare(`
    SELECT p.name AS name, COUNT(*) AS rounds, SUM(t.scored) AS points
    FROM turns t JOIN games g ON g.id=t.game_id JOIN players p ON p.id=t.player_id
    WHERE 1=1 ${scope}
    GROUP BY t.player_id
    HAVING rounds >= 5
  `).all();
  return rows
    .map(r => ({ name: r.name, ppr: +(r.points / r.rounds).toFixed(2), rounds: r.rounds }))
    .sort((a, b) => b.ppr - a.ppr);
}

// Shanghai! leaderboard + recent feed -- counts every instant-Shanghai win
// (turns.leg_won=1), same leaderboard+recent shape as getBaseballPerfectInningsStats().
function getShanghaiShanghaisStats(mode) {
  const scope = _scope({ mode, gameType: 'shanghai' });
  const base = `
    SELECT t.id, t.player_id, t.created_at
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE t.leg_won=1 ${scope}
  `;
  const leaderboard = db.prepare(`SELECT p.name, COUNT(*) AS count FROM (${base}) x JOIN players p ON p.id=x.player_id GROUP BY x.player_id ORDER BY count DESC`).all();
  const recent      = db.prepare(`SELECT p.name, x.created_at FROM (${base}) x JOIN players p ON p.id=x.player_id ORDER BY x.created_at DESC LIMIT 10`).all();
  return { leaderboard, recent };
}

function getShanghaiWinLeaderboard() { return _winLeaderboard('shanghai'); }

/* ---------- Halve-It (docs/archive/halve-it-roadmap.md) ----------
   Structurally another Baseball/Shanghai sibling, but with one genuine
   complication neither of those has: Halve-It's running total is NOT a
   simple SUM(scored) -- the halving rule (ceil(total/2) whenever a visit
   gains 0) makes the total order-dependent, so it can't be computed with a
   single SQL aggregate the way RPI/PPR can. Replayed once here in JS instead
   -- the same "nothing pre-aggregated, replay the raw turns" philosophy
   rebuildHalveItState() already uses for live resume, just read-only and
   grouped for stats. Also unlike Baseball/Shanghai, Halve-It never sets
   turns.leg_won at all -- there's no instant-win condition, ever (the match
   only completes once the final round settles), so a leg's winner is ALWAYS
   derived from final totals, with no hybrid self-referential case to handle. */
function _replayHalveItLegTotals(mode) {
  const scope = _scope({ mode, gameType: 'halve_it' });
  const rows = db.prepare(`
    SELECT t.id, t.game_id, t.set_no, t.leg_no, t.player_id, t.scored, t.bust,
           g.completed_at,
           (SELECT COUNT(*) FROM darts d WHERE d.turn_id=t.id) AS darts
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE 1=1 ${scope}
    ORDER BY t.game_id, t.set_no, t.leg_no, t.player_id, t.id
  `).all();
  const legs = new Map();
  for (const r of rows) {
    const key = `${r.game_id}|${r.set_no}|${r.leg_no}|${r.player_id}`;
    let leg = legs.get(key);
    if (!leg) {
      leg = { gameId: r.game_id, setNo: r.set_no, legNo: r.leg_no, playerId: r.player_id, total: 0, darts: 0, halvedCount: 0, lastTurnId: r.id, completed: !!r.completed_at };
      legs.set(key, leg);
    }
    leg.total = r.bust ? Math.ceil(leg.total / 2) : leg.total + r.scored;
    leg.darts += r.darts;
    if (r.bust) leg.halvedCount += 1;
    leg.lastTurnId = r.id;
    leg.completed = !!r.completed_at;
  }
  return Array.from(legs.values());
}

function getHalveItStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'halve_it' });

  const gamesRow = db.prepare(`
    SELECT COUNT(*) AS played, SUM(CASE WHEN g.winner_id=? THEN 1 ELSE 0 END) AS won
    FROM game_players gp JOIN games g ON g.id=gp.game_id
    WHERE gp.player_id=? ${scope} AND g.completed_at IS NOT NULL
  `).get(p.id, p.id);
  const gamesPlayed = gamesRow?.played ?? 0;
  const winPct = gamesPlayed > 0 ? (gamesRow.won / gamesPlayed * 100) : null;

  const dartsThrown = db.prepare(`SELECT COUNT(*) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;

  const timesHalved = db.prepare(`SELECT COALESCE(SUM(t.bust),0) AS v FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;

  // Best Round -- highest single-round GAIN (never a halved visit, which
  // always gains 0), same "peak single-round figure" shape as Baseball's own
  // Best Inning bubble.
  const bestRoundRow = db.prepare(`SELECT MAX(t.scored) AS v FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id);
  const bestRound = (dartsThrown > 0) ? (bestRoundRow?.v ?? null) : null;

  const myLegs = _replayHalveItLegTotals(mode).filter(l => l.playerId === p.id && l.completed);
  const avgFinalTotal = myLegs.length ? myLegs.reduce((s, l) => s + l.total, 0) / myLegs.length : null;

  return { gamesPlayed, winPct, dartsThrown, timesHalved, bestRound, avgFinalTotal };
}

// A completed Halve-It leg's winner is ALWAYS derived from final totals
// (never a leg_won=1 turn -- see this section's own header comment) --
// direct analog of getBaseballWonLegs(), just built on the halving-aware
// replay above instead of a plain SUM(scored).
function getHalveItWonLegs(playerId, mode) {
  const all = _replayHalveItLegTotals(mode).filter(l => l.completed);
  const byLeg = new Map();
  for (const l of all) {
    const key = `${l.gameId}|${l.setNo}|${l.legNo}`;
    if (!byLeg.has(key)) byLeg.set(key, []);
    byLeg.get(key).push(l);
  }
  const won = [];
  for (const legs of byLeg.values()) {
    const maxTotal = Math.max(...legs.map(l => l.total));
    const mine = legs.find(l => l.playerId === playerId && l.total === maxTotal);
    if (mine) won.push(mine);
  }
  return won;
}

// Halve-It's Personal Bests -- same 5-field shape as getBaseballPersonalBests()/
// getShanghaiPersonalBests(), bestFinalTotal replacing bestLegRuns/bestLegPoints
// (docs/archive/halve-it-roadmap.md's own "best final total" is this field;
// its "best single round" lives in the stat bubbles above instead, matching
// Baseball's own split between Personal Bests and its Best Inning bubble).
function getHalveItPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;

  const legs = getHalveItWonLegs(p.id, mode);
  const bestFinalTotal = legs.length ? Math.max(...legs.map(l => l.total)) : null;
  const fewestDartsToWin = legs.length ? Math.min(...legs.map(l => l.darts)) : null;

  const recentLegs = legs.slice().sort((a, b) => b.lastTurnId - a.lastTurnId).slice(0, 10);
  const recentFormTotal = recentLegs.length ? recentLegs.reduce((s, l) => s + l.total, 0) / recentLegs.length : null;
  const lifetimeTotal = legs.length ? legs.reduce((s, l) => s + l.total, 0) / legs.length : null;

  let winStreak = 0;
  if (mode !== 'practice') {
    const h2hScope = _scope({ mode: 'h2h', gameType: 'halve_it' });
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

  return { bestFinalTotal, fewestDartsToWin, winStreak, recentFormTotal, lifetimeTotal };
}

// Highest final total ever reached, one row per player -- same "single best-
// ever run, no minimum floor" shape as Checkout Blitz's/121 Checkout Ladder's
// own Home leaderboards, scoped across BOTH won and lost legs (a peak total
// is a real feat even in a leg that was eventually lost to an even bigger one).
function getHalveItBestTotalLeaderboard(mode) {
  const legs = _replayHalveItLegTotals(mode).filter(l => l.completed);
  const byPlayer = new Map();
  for (const l of legs) {
    const cur = byPlayer.get(l.playerId);
    if (cur == null || l.total > cur) byPlayer.set(l.playerId, l.total);
  }
  return Array.from(byPlayer.entries())
    .map(([playerId, total]) => ({ name: db.prepare('SELECT name FROM players WHERE id=?').get(playerId)?.name, total }))
    .filter(r => r.name)
    .sort((a, b) => b.total - a.total);
}

function getHalveItWinLeaderboard() { return _winLeaderboard('halve_it'); }

/* ---------- Dead Man Walking (docs/archive/dead-man-walking-roadmap.md) ----------
   Solo only — no win/loss leaderboard (there's no opponent, same reasoning
   Bob's 27/Checkout Ladder/The Gauntlet already established). Each round is
   its own leg; a round is Walked Out iff any turn within it has checkout=1,
   Executed otherwise — but "Executed" itself splits into two distinct,
   separately-tallied failure modes (a real bust vs. simply running out of
   the round's dart budget without one — see evaluateDeadManDart()'s own
   header comment in frontend/scoring.js), which is why this needs its own
   per-leg replay (`_replayDeadManWalkingLegs()`) rather than a single SUM()
   aggregate, the same "nothing pre-aggregated, replay the raw turns"
   complication Halve-It's own `_replayHalveItLegTotals()` already hit. */
function _replayDeadManWalkingLegs(mode) {
  const scope = _scope({ mode, gameType: 'dead_man_walking' });
  const rows = db.prepare(`
    SELECT t.game_id AS gameId, t.player_id AS playerId, t.leg_no AS legNo,
           MAX(t.checkout) AS walked, MAX(t.bust) AS busted,
           (SELECT COUNT(*) FROM darts d JOIN turns t2 ON t2.id=d.turn_id
              WHERE t2.game_id=t.game_id AND t2.player_id=t.player_id AND t2.leg_no=t.leg_no) AS dartsUsed,
           g.completed_at AS completedAt, g.config AS config
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE 1=1 ${scope}
    GROUP BY t.game_id, t.player_id, t.leg_no
  `).all();
  return rows.map(r => {
    const cfg = r.config ? JSON.parse(r.config) : null;
    const rounds = (cfg && cfg.rounds) || [];
    const round = rounds[r.legNo - 1];
    const par = round ? round.par : null;
    const budget = par != null ? par - 1 : null;
    const walked = !!r.walked;
    return {
      gameId: r.gameId, playerId: r.playerId, legNo: r.legNo,
      walked,
      bustEnded: !walked && !!r.busted,
      outOfDartsEnded: !walked && !r.busted,
      dartsUsed: r.dartsUsed, budget,
      // Margin of darts NOT needed on a Walked Out round — a Personal-Best-
      // adjacent flavor stat (docs/archive/dead-man-walking-roadmap.md "Stat bubbles":
      // "average darts of margin remaining on a Walked Out round").
      margin: (walked && budget != null) ? (budget - r.dartsUsed) : null,
      completed: !!r.completedAt,
      completedAt: r.completedAt,
    };
  });
}

function getDeadManWalkingStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const legs = _replayDeadManWalkingLegs(mode).filter(l => l.playerId === p.id && l.completed);

  const runsMap = new Map(); // gameId -> walked-out count this run
  legs.forEach(l => {
    if (!runsMap.has(l.gameId)) runsMap.set(l.gameId, 0);
    if (l.walked) runsMap.set(l.gameId, runsMap.get(l.gameId) + 1);
  });
  const runsCompleted = runsMap.size;
  // Exact integer sum (not derived by re-multiplying the average, which would
  // risk a floating-point drift the lifetime-Walked-Out-rounds achievement
  // ladder's exact >= threshold check shouldn't have to tolerate) — the raw
  // ingredient newMatchPlayerDeadManWalking()'s own lifetime-base fetch reads.
  const totalWalkedOut = Array.from(runsMap.values()).reduce((s, v) => s + v, 0);
  const avgWalkedOutPerRun = runsCompleted ? totalWalkedOut / runsCompleted : null;

  const totalLegs = legs.length;
  const bustRate = totalLegs ? (legs.filter(l => l.bustEnded).length / totalLegs) * 100 : null;
  const ranOutOfDartsRate = totalLegs ? (legs.filter(l => l.outOfDartsEnded).length / totalLegs) * 100 : null;

  const walkedLegs = legs.filter(l => l.walked && l.margin != null);
  const avgMarginOnWalkedOut = walkedLegs.length ? walkedLegs.reduce((s, l) => s + l.margin, 0) / walkedLegs.length : null;

  // Longest Walked-Out streak (lifetime, chronological, spanning any number of
  // runs — docs/archive/dead-man-walking-roadmap.md "Achievements": "within or across
  // runs") — exposed here too (not just as an achievement-ladder input) since
  // it's a genuinely interesting lifetime number in its own right.
  const longestWalkedOutStreak = getDeadManWalkingLongestStreak(playerName);

  return { runsCompleted, totalWalkedOut, avgWalkedOutPerRun, bustRate, ranOutOfDartsRate, avgMarginOnWalkedOut, longestWalkedOutStreak };
}

// ONE Personal Best (docs/archive/dead-man-walking-roadmap.md "Personal Bests"): most
// Walked Out rounds in a single run — a higher-is-better peak (MAX()), the
// standard descending shape most "best run" boards in this app already use
// (contrast The Gauntlet's deliberately ascending Scar count — this one isn't
// inverted). No win-streak/recent-form/lifetime-average fields — there's no
// opponent, same reasoning Bob's 27/Checkout Ladder/The Gauntlet's own single-
// or-few-field Personal Bests already settled on.
function getDeadManWalkingPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const legs = _replayDeadManWalkingLegs(mode).filter(l => l.playerId === p.id && l.completed);
  const runsMap = new Map();
  legs.forEach(l => {
    if (!runsMap.has(l.gameId)) runsMap.set(l.gameId, 0);
    if (l.walked) runsMap.set(l.gameId, runsMap.get(l.gameId) + 1);
  });
  const mostWalkedOut = runsMap.size ? Math.max(...runsMap.values()) : null;
  return { mostWalkedOut };
}

// Home leaderboard (docs/archive/dead-man-walking-roadmap.md "Home leaderboard"): best
// (highest) Walked Out count, one row per player, their peak run — no mode
// param (always solo/practice, same "no h2h/practice split needed" precedent
// Doubles Practice's own leaderboards already established).
function getDeadManWalkingLeaderboard() {
  const legs = _replayDeadManWalkingLegs().filter(l => l.completed);
  const runsMap = new Map(); // "gameId|playerId" -> {playerId, walked, achievedAt}
  legs.forEach(l => {
    const key = `${l.gameId}|${l.playerId}`;
    if (!runsMap.has(key)) runsMap.set(key, { playerId: l.playerId, walked: 0, achievedAt: l.completedAt });
    if (l.walked) runsMap.get(key).walked += 1;
  });
  const byPlayer = new Map();
  for (const r of runsMap.values()) {
    const cur = byPlayer.get(r.playerId);
    if (cur == null || r.walked > cur.walked) byPlayer.set(r.playerId, r);
  }
  return Array.from(byPlayer.values())
    .map(r => ({ name: db.prepare('SELECT name FROM players WHERE id=?').get(r.playerId)?.name, bestWalkedOut: r.walked, achievedAt: r.achievedAt }))
    .filter(r => r.name)
    .sort((a, b) => b.bestWalkedOut - a.bestWalkedOut);
}

// Longest lifetime consecutive-Walked-Out streak (docs/dead-man-walking-
// roadmap.md "Achievements": "within or across runs") — a flat chronological
// scan of EVERY round this player has ever played, across every game, since
// game_id increases with creation time and MIN(turn id) orders rounds within
// a game correctly too; this naturally lets a streak begun at the tail of one
// run continue into the next run's opening rounds, which a per-run-only
// calculation (checked once at each run's own end, the way Gauntlet's
// clean-station streak is) could never represent.
function getDeadManWalkingLongestStreak(playerName) {
  const p = getPlayer(playerName);
  if (!p) return 0;
  const rows = db.prepare(`
    SELECT t.leg_no AS legNo, MAX(t.checkout) AS walked, MIN(t.id) AS firstId
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? AND g.game_type='dead_man_walking'
    GROUP BY t.game_id, t.leg_no
    ORDER BY firstId
  `).all(p.id);
  let longest = 0, current = 0;
  rows.forEach(r => {
    if (r.walked) { current += 1; longest = Math.max(longest, current); }
    else current = 0;
  });
  return longest;
}


/* ---------- The Pressure Chamber (docs/archive/pressure-chamber-roadmap.md) ----------
   Reuses Checkout Trainer's exact 3-way bust=1(miss)/checkout=1,leg_won=0
   (partial)/checkout=1,leg_won=1(full) outcome, so full/partial-hit rate read
   directly off those columns with no replay needed. The one genuine
   complication: a run's total CP is NOT SUM(scored) alone -- it's
   SUM(scored) MINUS a derived total miss penalty (every bust=1 turn's own
   card, re-rolled via generatePressureCard(), never stored) -- so per-leg
   totals need one JS pass over the raw turns, the same "nothing
   pre-aggregated, replay once" philosophy _replayHalveItLegTotals() already
   uses, just simpler here since CP total isn't order-dependent the way
   Halve-It's halving-interspersed total is -- a plain SUM minus a derived
   subtraction, not a running replay. */
function _pressureChamberLegTotals(mode){
  const scope = _scope({ mode, gameType: 'pressure_chamber' });
  const rows = db.prepare(`
    SELECT t.id, t.game_id, t.set_no, t.leg_no, t.player_id, t.scored, t.bust, t.checkout, t.leg_won,
           g.completed_at,
           (SELECT COUNT(*) FROM darts d WHERE d.turn_id=t.id) AS darts,
           ROW_NUMBER() OVER (PARTITION BY t.game_id, t.set_no, t.leg_no, t.player_id ORDER BY t.id) AS round
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE 1=1 ${scope}
    ORDER BY t.game_id, t.set_no, t.leg_no, t.player_id, t.id
  `).all();
  const legs = new Map();
  for (const r of rows) {
    const key = `${r.game_id}|${r.set_no}|${r.leg_no}|${r.player_id}`;
    let leg = legs.get(key);
    if (!leg) {
      leg = { gameId: r.game_id, setNo: r.set_no, legNo: r.leg_no, playerId: r.player_id,
        gainedTotal: 0, missPenaltyTotal: 0, darts: 0, rounds: 0, fullHits: 0, partialHits: 0, misses: 0,
        currentFullHitStreak: 0, bestFullHitStreak: 0, lastTurnId: r.id, completed: !!r.completed_at };
      legs.set(key, leg);
    }
    leg.gainedTotal += r.scored;
    leg.darts += r.darts;
    leg.rounds += 1;
    leg.lastTurnId = r.id;
    leg.completed = !!r.completed_at;
    if (r.bust) {
      const card = generatePressureCard(r.game_id, r.round);
      leg.missPenaltyTotal += pressureMissPenaltyForCard(card);
      leg.misses += 1;
      leg.currentFullHitStreak = 0;
    } else if (r.leg_won) {
      leg.fullHits += 1;
      leg.currentFullHitStreak += 1;
      leg.bestFullHitStreak = Math.max(leg.bestFullHitStreak, leg.currentFullHitStreak);
    } else if (r.checkout) {
      leg.partialHits += 1;
      leg.currentFullHitStreak = 0;
    }
  }
  return Array.from(legs.values()).map(l => Object.assign(l, { total: l.gainedTotal - l.missPenaltyTotal }));
}

function getPressureChamberStatBubbles(playerName, mode){
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'pressure_chamber' });

  const gamesRow = db.prepare(`
    SELECT COUNT(*) AS played, SUM(CASE WHEN g.winner_id=? THEN 1 ELSE 0 END) AS won
    FROM game_players gp JOIN games g ON g.id=gp.game_id
    WHERE gp.player_id=? ${scope} AND g.completed_at IS NOT NULL
  `).get(p.id, p.id);
  const gamesPlayed = gamesRow?.played ?? 0;
  const winPct = gamesPlayed > 0 ? (gamesRow.won / gamesPlayed * 100) : null;

  const dartsThrown = db.prepare(`SELECT COUNT(*) AS v FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${scope}`).get(p.id)?.v ?? 0;

  const roundsRow = db.prepare(`
    SELECT COUNT(*) AS rounds,
      COALESCE(SUM(CASE WHEN t.leg_won=1 THEN 1 ELSE 0 END),0) AS fullHits,
      COALESCE(SUM(CASE WHEN t.checkout=1 AND t.leg_won=0 THEN 1 ELSE 0 END),0) AS partialHits
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? ${scope}
  `).get(p.id);
  const rounds = roundsRow?.rounds ?? 0;
  const fullHitRate = rounds > 0 ? (roundsRow.fullHits / rounds * 100) : null;
  const partialHitRate = rounds > 0 ? (roundsRow.partialHits / rounds * 100) : null;

  // Honesty% (docs/archive/pressure-chamber-roadmap.md build-order step 10): of every round
  // where the player made a self-declaration (declared_hit IS NOT NULL), what % were
  // honest — the declaration matching the round's real outcome. A round is an actual
  // HIT when it graded at least a partial hit (checkout=1) and an actual MISS when it
  // graded a whole miss (bust=1), so an honest call is "declared hit AND checked out"
  // or "declared miss AND busted". Purely informational, never a scoring input — null
  // until the player has made at least one declaration.
  const honestyRow = db.prepare(`
    SELECT COUNT(*) AS declared,
      COALESCE(SUM(CASE WHEN (t.declared_hit=1 AND t.checkout=1) OR (t.declared_hit=0 AND t.bust=1) THEN 1 ELSE 0 END),0) AS honest
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? ${scope} AND t.declared_hit IS NOT NULL
  `).get(p.id);
  const declaredRounds = honestyRow?.declared ?? 0;
  const honestyPct = declaredRounds > 0 ? (honestyRow.honest / declaredRounds * 100) : null;

  const myLegs = _pressureChamberLegTotals(mode).filter(l => l.playerId === p.id && l.completed);
  const runsCompleted = myLegs.length;
  const avgCp = runsCompleted > 0 ? (myLegs.reduce((s, l) => s + l.total, 0) / runsCompleted) : null;
  // Lifetime CP earned (docs/archive/pressure-chamber-roadmap.md "Achievements" ladder
  // metric) -- clamped at 0 per run before summing, so a heavily-missed run
  // (net negative under Double Down) never subtracts from a lifetime
  // cumulative achievement total the way it legitimately can from a single
  // run's own Personal Best/leaderboard peak.
  const totalCpEarned = myLegs.reduce((s, l) => s + Math.max(0, l.total), 0);

  return { gamesPlayed, winPct, dartsThrown, runsCompleted, avgCp, fullHitRate, partialHitRate, totalCpEarned, honestyPct, declaredRounds };
}

// Personal Bests (docs/archive/pressure-chamber-roadmap.md "Stats, Personal Bests,
// leaderboard"): best single-run CP total (a peak, no minimum-attempts floor
// -- the Checkout Blitz/Halve-It "Highest Final Total" precedent), best
// Composure Rating ever reached (since the rating thresholds are monotonic
// in totalCp, this is always just pressureComposureRating() of bestRunCp --
// no separate tracking needed), and the longest full-hit streak reached in
// any single run (bestFullHitStreak is already computed per-run above).
function getPressureChamberPersonalBests(playerName, mode){
  const p = getPlayer(playerName);
  if (!p) return null;

  const legs = _pressureChamberLegTotals(mode).filter(l => l.playerId === p.id && l.completed);
  const bestRunCp = legs.length ? Math.max(...legs.map(l => l.total)) : null;
  const bestRating = bestRunCp != null ? pressureComposureRating(bestRunCp) : null;
  const longestFullHitStreak = legs.length ? Math.max(...legs.map(l => l.bestFullHitStreak)) : null;

  return { bestRunCp, bestRating, longestFullHitStreak };
}

// Home leaderboard -- one row per player, their own peak single-run CP total,
// same "no minimum floor" shape as getHalveItBestTotalLeaderboard()/
// getCheckoutBlitzLeaderboard().
function getPressureChamberBestCpLeaderboard(mode){
  const legs = _pressureChamberLegTotals(mode).filter(l => l.completed);
  const byPlayer = new Map();
  for (const l of legs) {
    const cur = byPlayer.get(l.playerId);
    if (cur == null || l.total > cur) byPlayer.set(l.playerId, l.total);
  }
  return Array.from(byPlayer.entries())
    .map(([playerId, total]) => ({ name: db.prepare('SELECT name FROM players WHERE id=?').get(playerId)?.name, total, rating: pressureComposureRating(total) }))
    .filter(r => r.name)
    .sort((a, b) => b.total - a.total);
}

// The match winner is decided the normal way (a real completeGame(winnerName)
// call at the final round, per pressureChamberDecideWinnerIndex()'s
// deterministic tie-break) -- no replay needed, unlike the CP-total queries
// above, so the shared winner_id-based leaderboard body applies.
function getPressureChamberWinLeaderboard() { return _winLeaderboard('pressure_chamber'); }

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

  // hits (docs/archive/culture-badges-roadmap.md Part B): the raw lifetime doubles-hit
  // count doublesPct is already computed from, exposed directly as the base for
  // the frontend's lifetime doubles-hit ladder (newMatchPlayerDoublesPractice()'s
  // lifetimeHitsBase) — same pattern as Baseball's totalRuns above.
  return { doublesPct, avgDartsPerRound, avgHitsPerRound, roundsPlayed, dartsThrown, hits };
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

// 🎪 Ring Master progress (docs/archive/culture-badges-roadmap.md Part B): lifetime
// completion over every double D1-D20 plus bull (21 distinct targets) in
// Doubles Practice — direct structural analog of getAroundTheWorldProgress()
// above, just scoped to this mode's own "hit" definition (DOUBLES_HIT_CASE:
// multiplier=2 AND the sector was a genuine target in that round's
// config.doubles) instead of every raw dart outcome. No mode param — Doubles
// Practice is always practice=1 by construction (same reasoning as
// getDoublesPracticeAccuracyLeaderboard() above), so an h2h/practice split
// would always leave one side empty.
function getDoublesPracticeHitSectors(playerName) {
  const p = getPlayer(playerName);
  if (!p) return { hit: [], count: 0, total: 21 };
  const scope = _scope({ gameType: 'doubles_practice' });
  const rows = db.prepare(`
    SELECT DISTINCT d.sector AS sector
    FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? AND ${DOUBLES_HIT_CASE('d')}=1 ${scope}
  `).all(p.id);
  return { hit: rows.map(r => r.sector), count: rows.length, total: 21 };
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

/* ---------- Checkout Trainer (docs/archive/checkout-trainer-roadmap.md) ----------
   A pure mental-recall drill: every dart is its own 1-dart turn (same per-dart-
   turn shape Doubles Practice/Chuckin already established), graded by
   frontend/scoring.js's evaluateVisit()/checkoutHint() before it's ever written
   here — the three-way outcome (bust=1 "not legal" / checkout=1,leg_won=0
   "legal but not optimal" / checkout=1,leg_won=1 "legal and optimal") already
   exists on every turns row, so nothing new to store beyond target_score. Both
   sub-modes (Freeform, Checkout Blitz — distinguished by config.mode, not a
   separate game_type) share one game_type='checkout_trainer' and count toward
   these lifetime stats together — a round is a round regardless of which mode
   served it (docs/archive/checkout-trainer-roadmap.md's explicit ruling).

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

  // declared_unsolvable=0: a correctly-called trick question grades leg_won=1
  // (it's that round's best possible answer), but its bogey target was never a
  // checkout anyone SOLVED — without this, one correct "169 is a bogey" call
  // would permanently pin this Personal Best at 169.
  // json_extract(...pinnedTarget) IS NULL (docs/archive/checkout-drill-link-roadmap.md
  // "Drill this checkout"): grinding one number repeatedly via a pinned drill
  // shouldn't set a "toughest ever" record the random target pool didn't
  // actually produce — scoped by the game row's config, no schema change needed
  // since every turn in a pinned game already shares the same pinnedTarget.
  const toughestCheckout = db.prepare(`SELECT MAX(t.target_score) AS v FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? AND t.leg_won=1 AND t.declared_unsolvable=0 AND json_extract(g.config,'$.pinnedTarget') IS NULL ${scope}`).get(p.id)?.v ?? null;

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

/* ---------- Bob's 27 (docs/archive/practice-ladders-roadmap.md Part A) ----------
   Nothing is pre-aggregated (same house style as everywhere else in this
   schema): a run's final score is derived at read time from its own turns via
   the identical store-gain/derive-penalty formula the live client and the
   SEC-25-style write-time guard (addTurn()) both use — 27 + SUM(scored if >0
   else -2*round), where `round` is the turn's own 1-indexed position within
   its game (ROW_NUMBER() OVER game_id — bobs_27 always has exactly one
   player/set/leg per game, so partitioning by game_id alone is unambiguous).
   A run that died early and one that finished all 20 rounds both fall out of
   this same formula for free — the fatal or 20th-round turn is simply the
   last row for that game either way. That reasoning only covers runs that
   actually ENDED, though: a paused/abandoned/in-progress run has no bust row
   simply because it hasn't died YET, so every run-level aggregate below
   (runs/survivalRate/avgFinalScore/bestFinalScore/leaderboard) filters to
   g.completed_at IS NOT NULL — same rule Gauntlet's own PBs apply ("an
   abandoned run's partial total isn't a real result"). The dart-level
   doubles-hit-rate deliberately does NOT filter (real darts, real board
   outcomes — "no hypothetical exclusion"). */
function getBobs27StatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'bobs_27' });

  const runs = db.prepare(`
    WITH numbered AS (
      SELECT t.game_id AS gameId, t.scored, t.bust,
        ROW_NUMBER() OVER (PARTITION BY t.game_id ORDER BY t.id) AS round
      FROM turns t JOIN games g ON g.id=t.game_id
      WHERE t.player_id=? AND g.completed_at IS NOT NULL ${scope}
    )
    SELECT gameId,
      27 + SUM(CASE WHEN scored>0 THEN scored ELSE -2*round END) AS finalScore,
      MAX(bust) AS died
    FROM numbered GROUP BY gameId
  `).all(p.id);

  const runCount = runs.length;
  const survivalRate = runCount > 0 ? (runs.filter(r => !r.died).length / runCount * 100) : null;
  const avgFinalScore = runCount > 0 ? (runs.reduce((s, r) => s + r.finalScore, 0) / runCount) : null;

  // Doubles hit rate: of every dart actually thrown across every round, what
  // fraction landed on that round's own double — real darts, real board
  // outcomes (docs/archive/practice-ladders-roadmap.md Part A: "no hypothetical
  // exclusion"), same shape Doubles Practice's own hit-rate bubble uses.
  const dartsRow = db.prepare(`
    WITH numbered AS (
      SELECT t.id AS turnId, ROW_NUMBER() OVER (PARTITION BY t.game_id ORDER BY t.id) AS round
      FROM turns t JOIN games g ON g.id=t.game_id
      WHERE t.player_id=? ${scope}
    )
    SELECT COUNT(*) AS dartsThrown,
      COALESCE(SUM(CASE WHEN d.sector=n.round AND d.multiplier=2 THEN 1 ELSE 0 END),0) AS hits
    FROM darts d JOIN numbered n ON n.turnId=d.turn_id
  `).get(p.id);
  const dartsThrown = dartsRow?.dartsThrown ?? 0;
  const doublesHitRate = dartsThrown > 0 ? (dartsRow.hits / dartsThrown * 100) : null;

  return { runs: runCount, survivalRate, avgFinalScore, doublesHitRate, dartsThrown };
}

// Personal Bests: best-ever final score (peak single run, same "no minimum
// floor" reasoning a peak stat never needs one) and the deepest double reached
// on a run that ended in death — the "how close did I get" companion number,
// scoped to only the runs that actually failed (a survived run has no
// "reached on a fail" to report).
function getBobs27PersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'bobs_27' });

  const runs = db.prepare(`
    WITH numbered AS (
      SELECT t.game_id AS gameId, t.scored, t.bust,
        ROW_NUMBER() OVER (PARTITION BY t.game_id ORDER BY t.id) AS round
      FROM turns t JOIN games g ON g.id=t.game_id
      WHERE t.player_id=? AND g.completed_at IS NOT NULL ${scope}
    )
    SELECT gameId,
      27 + SUM(CASE WHEN scored>0 THEN scored ELSE -2*round END) AS finalScore,
      COUNT(*) AS roundsReached,
      MAX(bust) AS died
    FROM numbered GROUP BY gameId
  `).all(p.id);

  const bestFinalScore = runs.length ? Math.max(...runs.map(r => r.finalScore)) : null;
  const failedRuns = runs.filter(r => r.died);
  const deepestDoubleOnFail = failedRuns.length ? Math.max(...failedRuns.map(r => r.roundsReached)) : null;

  return { bestFinalScore, deepestDoubleOnFail };
}

// Bob's 27's arcade-style high-score table — one row per player, their single
// best-ever run's final score, ranked descending. Peak single-run value
// (structurally identical to Checkout Blitz's own leaderboard above — a
// single legendary run, even The Full Anderson's 1287 itself, is exactly the
// kind of feat this exists to surface), so no minimum-runs floor.
function getBobs27Leaderboard() {
  const rows = db.prepare(`
    WITH numbered AS (
      SELECT t.game_id AS gameId, t.player_id AS playerId, t.scored, t.created_at,
        ROW_NUMBER() OVER (PARTITION BY t.game_id ORDER BY t.id) AS round
      FROM turns t JOIN games g ON g.id=t.game_id
      WHERE g.game_type='bobs_27' AND g.completed_at IS NOT NULL
    )
    SELECT n.gameId AS gameId, p.name AS name, MAX(n.created_at) AS achievedAt,
      27 + SUM(CASE WHEN n.scored>0 THEN n.scored ELSE -2*n.round END) AS finalScore
    FROM numbered n JOIN players p ON p.id=n.playerId
    GROUP BY n.gameId
  `).all();
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.name);
    if (!cur || r.finalScore > cur.bestScore) best.set(r.name, { name: r.name, bestScore: r.finalScore, achievedAt: r.achievedAt });
  }
  return Array.from(best.values()).sort((a, b) => b.bestScore - a.bestScore);
}

/* ---------- Household Elo rating (docs/archive/rating-and-handicap-roadmap.md Part A) ----------
   Live-computed, never stored — the standing "nothing pre-aggregated" schema
   philosophy fits Elo unusually well: every completed, non-practice, 2-player
   game (across every competitive game type combined into one household
   rating — this is "who beats whom," not a per-game-type number) is walked in
   (created_at, id) order, folding the textbook update (start 1000, K=32,
   expected = 1/(1+10^((opponent-mine)/400)), winner gets K*(1-expected),
   loser gets the exact same amount subtracted — a simple zero-sum split
   rather than rounding each side's own formula independently, which could
   drift by a point through independent rounding). This means ratings
   retroactively heal after undo/merge/game-deletion/import with zero
   migration machinery, at the cost of re-walking the whole games table on
   every request — a few thousand games is a trivial walk at household scale
   (see the roadmap doc's own reasoning); revisit only if a server ever
   accumulates enough games for this to matter.
   Handicapped games (docs/archive/rating-and-handicap-roadmap.md Part B) are
   excluded once game_players.start_score exists — see the WHERE clause
   below, added in the same change that ships Part B. */
function getEloRatings() {
  const K = 32;
  const rows = db.prepare(`
    SELECT g.id AS gameId, g.created_at AS createdAt, g.completed_at AS completedAt, g.winner_id AS winnerId,
      gp.player_id AS playerId, p.name AS name
    FROM games g
    JOIN game_players gp ON gp.game_id = g.id
    JOIN players p ON p.id = gp.player_id
    WHERE g.completed_at IS NOT NULL AND g.practice = 0 AND g.player_count = 2
      -- Handicapping (Part B): a game where either participant's start_score
      -- was overridden says nothing about raw strength, so it never enters
      -- the walk at all — same reasoning a compensated result shouldn't move
      -- an uncompensated rating.
      AND NOT EXISTS (SELECT 1 FROM game_players gp2 WHERE gp2.game_id = g.id AND gp2.start_score IS NOT NULL)
    ORDER BY g.created_at ASC, g.id ASC, gp.player_id ASC
  `).all();

  const byGame = new Map();
  rows.forEach(r => {
    if (!byGame.has(r.gameId)) byGame.set(r.gameId, { gameId: r.gameId, createdAt: r.createdAt, completedAt: r.completedAt, winnerId: r.winnerId, players: [] });
    byGame.get(r.gameId).players.push({ id: r.playerId, name: r.name });
  });

  const ratings = new Map(); // playerId -> { name, rating, wins, losses, played, history:[{gameId,date,rating}] }
  const ensure = (id, name) => {
    if (!ratings.has(id)) ratings.set(id, { name, rating: 1000, wins: 0, losses: 0, played: 0, history: [] });
    return ratings.get(id);
  };
  let lastGame = null;
  for (const g of byGame.values()) {
    // player_count=2 already guarantees exactly 2 rows; winnerId is required
    // for a completed game (completeGame() always sets it) — both defensive,
    // not expected to ever actually skip a row.
    if (g.players.length !== 2 || g.winnerId == null) continue;
    const [a, b] = g.players;
    const ra = ensure(a.id, a.name), rb = ensure(b.id, b.name);
    const winnerIsA = g.winnerId === a.id;
    const preA = ra.rating, preB = rb.rating;
    const expectedA = 1 / (1 + Math.pow(10, (preB - preA) / 400));
    const deltaA = Math.round(K * ((winnerIsA ? 1 : 0) - expectedA));
    ra.rating = preA + deltaA;
    rb.rating = preB - deltaA;
    if (winnerIsA) { ra.wins++; rb.losses++; } else { rb.wins++; ra.losses++; }
    ra.played++; rb.played++;
    const date = (g.completedAt || g.createdAt).slice(0, 10);
    ra.history.push({ gameId: g.gameId, date, rating: ra.rating });
    rb.history.push({ gameId: g.gameId, date, rating: rb.rating });
    const winner = winnerIsA ? ra : rb, loser = winnerIsA ? rb : ra;
    const winnerPre = winnerIsA ? preA : preB, loserPre = winnerIsA ? preB : preA;
    lastGame = {
      gameId: g.gameId, winnerName: winner.name, loserName: loser.name,
      winnerDelta: winnerIsA ? deltaA : -deltaA, winnerRating: winner.rating,
      // Upset (docs/archive/rating-and-handicap-roadmap.md Part A): beat an opponent
      // rated 150+ above you, checked against PRE-game ratings (the gap that
      // made the win an upset in the first place), not the post-game ones.
      isUpset: (loserPre - winnerPre) >= 150,
    };
  }

  const list = Array.from(ratings.entries()).map(([playerId, r]) => ({
    playerId, name: r.name, rating: r.rating, wins: r.wins, losses: r.losses, played: r.played, history: r.history,
  })).sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  return { ratings: list, lastGame };
}

// Home page leaderboard: rating + W/L, sorted desc, min 5 rated games before
// appearing so a 1-game player isn't ranked off a single result.
const ELO_MIN_GAMES = 5;
function getEloLeaderboard() {
  return getEloRatings().ratings.filter(r => r.played >= ELO_MIN_GAMES)
    .map(r => ({ name: r.name, rating: r.rating, wins: r.wins, losses: r.losses, played: r.played }));
}

// Single-player Elo view for the Player Profile (rating + rank + history
// chart) and for the post-match badge check (👑 Top of the House / 🗡️
// Upset) — both read from the same walk so the numbers can never disagree.
// `rank`/`qualifies` are computed against the SAME min-5-games-played pool
// the Home leaderboard itself uses, so "rank #1" and "topping the Home
// leaderboard" are always the same claim — a player under the floor can't
// become Top of the House by playing one lucky game.
function getPlayerElo(playerName) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const { ratings, lastGame } = getEloRatings();
  const mine = ratings.find(r => r.playerId === p.id);
  const qualified = ratings.filter(r => r.played >= ELO_MIN_GAMES);
  const rank = mine && mine.played >= ELO_MIN_GAMES
    ? qualified.findIndex(r => r.playerId === p.id) + 1
    : null;
  return {
    rating: mine ? mine.rating : 1000,
    wins: mine ? mine.wins : 0,
    losses: mine ? mine.losses : 0,
    played: mine ? mine.played : 0,
    qualifies: !!mine && mine.played >= ELO_MIN_GAMES,
    rank,
    ratedPlayers: qualified.length,
    history: mine ? mine.history : [],
    // Global, not player-scoped — the client only reads this when it's the
    // player who just won a match, immediately after that match completed
    // (see checkEloOnMatchWin() in index.html), the same "no explicit
    // gameId correlation needed" assumption every other post-match async
    // lookup in this app already makes (h2h-summary, etc.) since nothing
    // else could have completed a 2-player game in between.
    lastCompetitiveGame: lastGame,
  };
}

/* ---------- The 121 Checkout Ladder (docs/archive/practice-ladders-roadmap.md Part B) ----------
   Nothing pre-aggregated, same house style as everywhere else: every
   `(game_id, leg_no)` group of turns is one attempt at a target — a win if
   any turn in it has checkout=1, a fail otherwise (the write-time guard
   already enforces at most 3 turns per attempt). The ladder's target for a
   given attempt is stamped on `turns.target_score` at write time (validated
   server-side against the same "replay every prior attempt's outcome"
   derivation `addTurn()`'s own guard uses), so read-time queries can just
   read it back rather than re-deriving it. */
function _checkoutLadderAttempts(playerId, scope) {
  return db.prepare(`
    SELECT t.game_id AS gameId, t.leg_no AS legNo, MAX(t.checkout) AS won,
      MAX(t.target_score) AS target, COUNT(*) AS visits,
      MAX(t.created_at) AS lastAt
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? ${scope}
    GROUP BY t.game_id, t.leg_no
  `).all(playerId);
}

function getCheckoutLadderStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'checkout_ladder' });
  const attempts = _checkoutLadderAttempts(p.id, scope);
  // An attempt only counts once it's RESOLVED — won, or all 3 visits used. The
  // temporally-last (game, leg) group can be a still-in-progress attempt (1-2
  // visits, no checkout yet; permanently so for a paused/abandoned game), and
  // treating it as a completed failure would drop the ladder a rung and inflate
  // attempts/successRate before the attempt actually ends. Same resolved check
  // rebuildCheckoutLadderState() (frontend/scoring.js) applies, so the stat
  // bubble and the resume/write-guard derivation always agree on the position.
  const resolved = attempts.filter(a => a.won || a.visits >= 3);
  const attemptCount = resolved.length;
  const wins = resolved.filter(a => a.won).length;
  const successRate = attemptCount > 0 ? (wins / attemptCount * 100) : null;

  // Current ladder position: replay the temporally-latest game's own resolved
  // attempts (121, +1 per win capped at 170, -1 per fail, floor 61 — the same
  // 61..170 bounds rebuildCheckoutLadderState() enforces) — "where would my
  // next attempt in that run start from," the closest a lifetime stat bubble
  // can get to a genuinely live "current position" for a mode with no
  // persistent cross-session ladder.
  let currentPosition = null;
  if (attempts.length > 0) {
    // "Temporally latest" must order by timestamp, not by MAX(game_id):
    // importPlayerExport() inserts historical games with fresh AUTOINCREMENT
    // ids, so after an import an old run can carry the highest id — the same
    // (created_at, id) recency idiom the Elo walk uses. gameId breaks the tie
    // for two games sharing a second.
    const latest = attempts.reduce((best, a) =>
      (!best || a.lastAt > best.lastAt || (a.lastAt === best.lastAt && a.gameId > best.gameId)) ? a : best, null);
    const latestGameId = latest.gameId;
    const latestAttempts = resolved.filter(a => a.gameId === latestGameId).sort((a, b) => a.legNo - b.legNo);
    let target = 121;
    latestAttempts.forEach(a => { target = a.won ? Math.min(170, target + 1) : Math.max(61, target - 1); });
    currentPosition = target;
  }

  const dartsThrown = db.prepare(`
    SELECT COUNT(*) AS n FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? ${scope}
  `).get(p.id).n;

  return { attempts: attemptCount, successRate, currentPosition, dartsThrown };
}

// Personal Bests: highest target ever reached (a peak, no minimum floor —
// "reached" means attempted, win or fail, since standing at rung 150
// already means you climbed that high regardless of how that attempt ends)
// and fewest darts on the highest attempt actually WON (the "how efficiently
// did you bag your best rung" companion number).
function getCheckoutLadderPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'checkout_ladder' });
  const attempts = _checkoutLadderAttempts(p.id, scope);
  if (!attempts.length) return { highestTargetReached: null, fewestDartsOnHighestCheckout: null };

  const highestTargetReached = Math.max(...attempts.map(a => a.target));
  const wonAttempts = attempts.filter(a => a.won);
  let fewestDartsOnHighestCheckout = null;
  if (wonAttempts.length) {
    const highestWonTarget = Math.max(...wonAttempts.map(a => a.target));
    // Which (game_id, leg_no) attempts actually won at that peak target — the
    // attempts array already has everything needed, so this is a plain JS
    // filter rather than a second SQL round-trip per candidate.
    const pegLegs = wonAttempts.filter(a => a.target === highestWonTarget);
    const dartsCounts = pegLegs.map(a => db.prepare(`
      SELECT COUNT(d.id) AS n FROM turns t JOIN darts d ON d.turn_id=t.id
      WHERE t.player_id=? AND t.game_id=? AND t.leg_no=?
    `).get(p.id, a.gameId, a.legNo).n);
    fewestDartsOnHighestCheckout = dartsCounts.length ? Math.min(...dartsCounts) : null;
  }
  return { highestTargetReached, fewestDartsOnHighestCheckout };
}

// Home page leaderboard: one row per player, their own highest-ever target
// reached (a peak, no minimum-attempts floor — same reasoning every other
// single-best-run board in this app uses).
function getCheckoutLadderLeaderboard() {
  const rows = db.prepare(`
    SELECT p.name AS name, MAX(t.target_score) AS bestTarget, MAX(t.created_at) AS achievedAt
    FROM turns t JOIN games g ON g.id=t.game_id JOIN players p ON p.id=t.player_id
    WHERE g.game_type='checkout_ladder'
    GROUP BY t.player_id
  `).all();
  return rows.sort((a, b) => b.bestTarget - a.bestTarget);
}

/* ---------- The Gauntlet (docs/archive/gauntlet-roadmap.md) ----------
   Nothing pre-aggregated: every (game_id, target_score) group of turns is
   one station's attempt history (1 row, or 2 if it was repeated) — replayed
   via rebuildGauntletState() (frontend/scoring.js), the SAME pure function
   the write-time guard and saved-game resume both use, so "which stations
   are settled, is the run done, what's the total Scars" is derived exactly
   once and never drifts between call sites. */
function _gauntletRuns(playerId, scope) {
  const rows = db.prepare(`
    SELECT t.game_id AS gameId, t.target_score AS targetScore, t.scored AS scored, t.id AS id
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? ${scope}
    ORDER BY t.game_id, t.id
  `).all(playerId);
  const byGame = new Map();
  rows.forEach(r => { if (!byGame.has(r.gameId)) byGame.set(r.gameId, []); byGame.get(r.gameId).push(r); });
  return Array.from(byGame.entries()).map(([gameId, turns]) => {
    const state = rebuildGauntletState({ turns });
    const byStation = new Map();
    turns.forEach(t => byStation.set(t.targetScore, (byStation.get(t.targetScore) || 0) + 1));
    const retries = Array.from(byStation.values()).filter(c => c > 1).length;
    return { gameId, ...state, retries };
  });
}

function getGauntletStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'gauntlet' });
  const runs = _gauntletRuns(p.id, scope);
  const completedRuns = runs.filter(r => r.done);
  // Clean-station/Deep-Scar/retry rates are scoped to every SETTLED station
  // across every run (completed or still in progress) — a settled station is
  // a real, final result regardless of whether the rest of that run was ever
  // finished. avgTotalScars is completed-runs-only: a partial run's running
  // total isn't comparable to a real finished run's.
  const allSettled = runs.flatMap(r => r.finalMisses);
  const totalSettled = allSettled.length;
  const totalRetries = runs.reduce((s, r) => s + r.retries, 0);
  return {
    runsCompleted: completedRuns.length,
    avgTotalScars: completedRuns.length ? completedRuns.reduce((s, r) => s + r.totalScars, 0) / completedRuns.length : null,
    cleanStationRate: totalSettled ? (allSettled.filter(m => m === 0).length / totalSettled * 100) : null,
    deepScarRate: totalSettled ? (allSettled.filter(m => m === 3).length / totalSettled * 100) : null,
    retryRate: totalSettled ? (totalRetries / totalSettled * 100) : null,
    // Not one of this bubble set's 5 user-facing fields (docs/archive/gauntlet-roadmap.md
    // "Stat bubbles" only names the rate) — a raw lifetime count, purely so the
    // frontend's lifetime-clean-stations achievement ladder (newMatchPlayerGauntlet())
    // has a base to add this session's own count onto, the same "fetch once at
    // game start" pattern Chuckin's own lifetime ladders use.
    cleanStations: allSettled.filter(m => m === 0).length,
  };
}

// Personal Best: LOWEST total Scars in a completed run — ascending-is-better,
// same MIN()-not-MAX() shape X01's fewestDartsCheckout/Baseball's
// fewestDartsToWin use, just applied to a brand-new metric. Only completed
// runs are eligible (an abandoned run's partial total isn't a real result).
function getGauntletPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'gauntlet' });
  const completedRuns = _gauntletRuns(p.id, scope).filter(r => r.done);
  if (!completedRuns.length) return { lowestTotalScars: null };
  return { lowestTotalScars: Math.min(...completedRuns.map(r => r.totalScars)) };
}

// Home page leaderboard: one row per player, their own lowest-ever total
// Scars across a completed run — ascending sort (lower is better), the
// opposite polarity from every other "single best run" board in this app.
function getGauntletLeaderboard() {
  const rows = db.prepare(`
    SELECT t.player_id AS playerId, t.game_id AS gameId, t.target_score AS targetScore, t.scored AS scored, t.id AS id, t.created_at AS createdAt
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE g.game_type='gauntlet'
    ORDER BY t.player_id, t.game_id, t.id
  `).all();
  const byPlayer = new Map();
  rows.forEach(r => {
    if (!byPlayer.has(r.playerId)) byPlayer.set(r.playerId, new Map());
    const games = byPlayer.get(r.playerId);
    if (!games.has(r.gameId)) games.set(r.gameId, []);
    games.get(r.gameId).push(r);
  });
  const result = [];
  byPlayer.forEach((games, playerId) => {
    let best = null, achievedAt = null;
    games.forEach(turns => {
      const state = rebuildGauntletState({ turns });
      if (state.done && (best == null || state.totalScars < best)) {
        best = state.totalScars;
        achievedAt = turns[turns.length - 1].createdAt;
      }
    });
    if (best != null) {
      const player = db.prepare('SELECT name FROM players WHERE id=?').get(playerId);
      result.push({ name: player.name, bestTotalScars: best, achievedAt });
    }
  });
  return result.sort((a, b) => a.bestTotalScars - b.bestTotalScars);
}

// The Scar Map — the actual point of the game (docs/archive/gauntlet-roadmap.md "The
// Scar Map — the actual point of the game"): for every COMPLETED Gauntlet run,
// take each station's final (post-any-repeat) miss count and average it per
// station number across every run this player has ever finished — the direct
// structural sibling of getDartHeatmap(), just shaded by average Scar
// severity instead of hit frequency.
function getGauntletScarMap(playerName) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const rows = db.prepare(`
    SELECT t.game_id AS gameId, t.target_score AS targetScore, t.scored AS scored, t.id AS id
    FROM turns t JOIN games g ON g.id=t.game_id
    WHERE t.player_id=? AND g.game_type='gauntlet'
    ORDER BY t.game_id, t.id
  `).all(p.id);
  const byGame = new Map();
  rows.forEach(r => { if (!byGame.has(r.gameId)) byGame.set(r.gameId, []); byGame.get(r.gameId).push(r); });
  const perStation = new Map();
  byGame.forEach(turns => {
    const state = rebuildGauntletState({ turns });
    if (!state.done) return;
    GAUNTLET_STATION_ORDER.forEach((station, i) => {
      if (!perStation.has(station)) perStation.set(station, { sum: 0, count: 0 });
      const entry = perStation.get(station);
      entry.sum += state.finalMisses[i];
      entry.count += 1;
    });
  });
  const stations = GAUNTLET_STATION_ORDER.map(station => {
    const entry = perStation.get(station);
    return { station, avgScars: entry ? entry.sum / entry.count : null, runs: entry ? entry.count : 0 };
  });
  return { stations };
}

/* ---------- Killer (docs/game-modes-roadmap.md "Killer") ----------
   games.winner_id/completed_at cover games-played/win-rate for free, exactly
   like Baseball/Cricket's own win leaderboards (Killer plays real best-of-N
   matches, DB.completeGame() called once the match is decided) — no replay
   needed for those two. Kills/lives-lost/"survived without becoming a
   killer" are genuinely new per-LEG metrics with no existing column to read,
   so they're derived by replaying every leg's own turn history through
   _replayKillerLegs() (the shared pipeline _h2hWonLegs() also uses, itself
   built on rebuildKillerState() — the same function the write-time guard
   uses). */
function _killerLegOutcomesForPlayer(playerName, playerId, scope) {
  const games = db.prepare(`
    SELECT DISTINCT g.id AS gameId, g.config AS config
    FROM games g JOIN game_players gp ON gp.game_id=g.id
    WHERE gp.player_id=? AND g.game_type='killer' ${scope}
  `).all(playerId);
  const outcomes = [];
  games.forEach(g => {
    const cfg = _parseKillerConfig(g.config);
    if (!cfg) return;
    const { names, legs } = _replayKillerLegs(g.gameId, cfg);
    if (!names.includes(playerName)) return;
    legs.forEach(({ state }) => {
      const me = state.players.find(pl => pl.name === playerName);
      if (!me) return;
      outcomes.push({ won: state.winner === playerName, kills: me.kills, livesLost: me.livesLost, becameKiller: me.isKiller, eliminated: me.eliminated });
    });
  });
  return outcomes;
}

function getKillerStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'killer' });
  const matchRow = db.prepare(`
    SELECT COUNT(*) AS played, SUM(CASE WHEN g.winner_id=? THEN 1 ELSE 0 END) AS won
    FROM game_players gp JOIN games g ON g.id=gp.game_id
    WHERE gp.player_id=? AND g.completed_at IS NOT NULL ${scope}
  `).get(p.id, p.id);
  const outcomes = _killerLegOutcomesForPlayer(playerName, p.id, scope);
  const n = outcomes.length;
  return {
    gamesPlayed: matchRow.played || 0,
    winRate: matchRow.played ? (matchRow.won / matchRow.played * 100) : null,
    avgKillsPerLeg: n ? (outcomes.reduce((s, o) => s + o.kills, 0) / n) : null,
    avgLivesLostPerLeg: n ? (outcomes.reduce((s, o) => s + o.livesLost, 0) / n) : null,
    // A curiosity stat (docs/game-modes-roadmap.md's own sketch): how often
    // this player rode out an entire leg alive without ever becoming a killer
    // themselves — everyone else eliminated each other while they sat back.
    survivedWithoutKillerRate: n ? (outcomes.filter(o => !o.becameKiller && !o.eliminated).length / n * 100) : null,
  };
}

// Personal Best: most kills landed in a single leg — higher-is-better, same
// MAX() shape most "best run" Personal Bests in this app use.
function getKillerPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const scope = _scope({ mode, gameType: 'killer' });
  const outcomes = _killerLegOutcomesForPlayer(playerName, p.id, scope);
  if (!outcomes.length) return { mostKillsInALeg: null };
  return { mostKillsInALeg: Math.max(...outcomes.map(o => o.kills)) };
}

// Killer's win/loss lives on games.winner_id the same generic way, so the
// shared winner_id-based leaderboard body applies.
function getKillerWinLeaderboard() { return _winLeaderboard('killer'); }

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
  const baseballScope = _scope({ mode: opts.mode, gameType: 'baseball' });
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
  // to the client's local time via the shared _tzModifier() (minutes east of UTC).
  const tzMod = _tzModifier(opts.tz);
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
    // x01dartsthrown/x01avgdartsperday: the X01 tab's own bubbles — same shape as
    // dartsthrown/avgdartsperday above, but X01_ONLY-scoped instead of just
    // excluding Checkout Trainer, so a Cricket or Chuckin' dart can't count here.
    case 'x01dartsthrown':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(d.id) AS value FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${T.and} ${modeWhere} ${weightWhere} ${X01_ONLY} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'x01avgdartsperday':
      return db.prepare(`SELECT ${T.fmt} AS bucket, CAST(COUNT(d.id) AS REAL)/NULLIF(COUNT(DISTINCT date(t.created_at)),0) AS value FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${T.and} ${modeWhere} ${weightWhere} ${X01_ONLY} GROUP BY bucket ORDER BY bucket`).all(...params);
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
      // docs/bug-roadmap.md BUG-27: X01_ONLY, matching the '180s' case above — a Big Fish
      // is an X01 170 checkout, not a drill (Checkout Ladder / Dead Man Walking) 170.
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(*) AS value ${TBASE} ${X01_ONLY} AND t.checkout=1 AND t.checkout_points=170 GROUP BY bucket ORDER BY bucket`).all(...params);
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
        WHERE t.player_id=? AND g.game_type='x01' AND json_extract(g.config,'$.startingScore')=501 ${modeWhere} ${weightWhere} ${NOT_HANDICAPPED}
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
      // wrongly counting a busted opening visit's attempted score). Scoped by the
      // shared module-level OPENING_CATS (exactly 501/301/170/101) — see its
      // comment above X01_ONLY for why (2026-07 product decision).
      return db.prepare(`SELECT ${F.fmt} AS bucket, AVG(CAST(scored AS REAL)) AS value FROM (
        SELECT t.created_at, t.scored,
               ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE t.player_id=? ${modeWhere} ${weightWhere} ${OPENING_CATS}
      ) WHERE rn = 1 ${F.and} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'first9avg':
      // 3-dart-average-equivalent over the leg's first up-to-3 visits — uses
      // t.scored (bust-zeroed) for points and the same "bust counts as 3 darts"
      // convention used everywhere else for the denominator, instead of raw
      // per-dart sums that previously counted a busted visit's attempted points as
      // if they'd scored. Scoped by the shared module-level OPENING_CATS.
      return db.prepare(`SELECT ${L.fmt} AS bucket, AVG(CAST(total_scored AS REAL)/NULLIF(dart_count,0)*3) AS value FROM (
        SELECT MAX(t.created_at) AS leg_ts, SUM(t.scored) AS total_scored,
               SUM(CASE WHEN t.bust=1 THEN 3 ELSE dc.cnt END) AS dart_count
        FROM (SELECT t.id, t.game_id, t.set_no, t.leg_no, t.created_at, t.scored, t.bust,
                     ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
              FROM turns t JOIN games g ON g.id=t.game_id
              WHERE t.player_id=? ${modeWhere} ${weightWhere} ${OPENING_CATS}) t
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
      // Same "opening visit" shape as first3avg above — needs the same shared
      // module-level OPENING_CATS scoping.
      return db.prepare(`SELECT ${F.fmt} AS bucket, CAST(SUM(CASE WHEN scored>=140 THEN 1 ELSE 0 END) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT t.scored, t.created_at, ROW_NUMBER() OVER (PARTITION BY t.game_id,t.set_no,t.leg_no ORDER BY t.id) AS rn
        FROM turns t JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${modeWhere} ${weightWhere} ${OPENING_CATS}
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

    // ---- Baseball metrics (game-modes-roadmap.md "Baseball" — stats pass) ----
    case 'baseballrpi':
      // Runs Per Inning: turns.scored already IS a Baseball visit's runs (set
      // by enterTurnBaseball()), so this reads it directly — no per-dart
      // derivation needed, unlike Cricket's marks.
      return db.prepare(`SELECT ${T.fmt} AS bucket, CAST(SUM(t.scored) AS REAL)/NULLIF(COUNT(*),0) AS value
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE t.player_id=? ${baseballScope} ${T.and} ${weightWhere}
        GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'baseballperfectinnings':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(*) AS value
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE t.player_id=? ${baseballScope} ${T.and} ${weightWhere} AND t.scored=9
        GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'baseballwinpct': {
      const G = bld('g.completed_at');
      return db.prepare(`SELECT bucket, CAST(SUM(won) AS REAL)*100/NULLIF(COUNT(*),0) AS value FROM (
        SELECT ${G.fmt} AS bucket, CASE WHEN g.winner_id=? THEN 1 ELSE 0 END AS won
        FROM game_players gp JOIN games g ON g.id=gp.game_id
        WHERE gp.player_id=? AND g.completed_at IS NOT NULL ${baseballScope} ${G.and}
      ) GROUP BY bucket ORDER BY bucket`).all(p.id, p.id);
    }
    case 'baseballgames': {
      const G = bld('g.completed_at');
      return db.prepare(`SELECT ${G.fmt} AS bucket, COUNT(*) AS value
        FROM game_players gp JOIN games g ON g.id=gp.game_id
        WHERE gp.player_id=? AND g.completed_at IS NOT NULL ${baseballScope} ${G.and}
        GROUP BY bucket ORDER BY bucket`).all(p.id);
    }
    case 'baseballdartsthrown':
      return db.prepare(`SELECT ${T.fmt} AS bucket, COUNT(d.id) AS value FROM darts d JOIN turns t ON t.id=d.turn_id JOIN games g ON g.id=t.game_id WHERE t.player_id=? ${baseballScope} ${T.and} ${weightWhere} GROUP BY bucket ORDER BY bucket`).all(...params);
    case 'baseballbestinning':
      return db.prepare(`SELECT ${T.fmt} AS bucket, MAX(t.scored) AS value
        FROM turns t JOIN games g ON g.id=t.game_id
        WHERE t.player_id=? ${baseballScope} ${T.and} ${weightWhere}
        GROUP BY bucket ORDER BY bucket`).all(...params);

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
// Every real games.game_type value — derived from GAME_TYPE_REGISTRY (above) minus the
// dispatch-only 'marathon' routing key, so adding a game type to the registry
// automatically registers it here (and in SAVABLE_GAME_TYPES) with no separate edit.
const KNOWN_GAME_TYPES = Object.keys(GAME_TYPE_REGISTRY).filter(k => !GAME_TYPE_REGISTRY[k].dispatchOnly);
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

// "Opening exchange" stats (1st 3 AVG, 1st 9 AVG, 140/Leg,
// docs/archive/first-nine-average-roadmap.md) are scoped to exactly the 4
// standard X01 starting scores (501/301/
// 170/101) — never any other game type, and never a non-standard/custom X01
// starting score — per an explicit product decision (2026-07): these three stats
// count for 501/301/170/101 only, ever, unless a future change explicitly says
// otherwise. Checks game_type (not just category, which is only a human-readable
// label) plus the actual numeric startingScore from config, matching the same
// robust pattern getNineDarterStats()/getSummary() already use for their own
// 501-only scoping — stronger than a bare category-string match, which a future
// game type could coincidentally collide with. Daily Challenge's non-scoring
// formats (Bullseye Gauntlet, Steady Hand, Treble Run) use a filler 1000 starting
// score, already excluded by this same numeric check. Module-level (not local to
// getPlayerStatBubbles, where this originated) so getPersonalBests()'s bestFirst9
// and getHomeExtra()'s First-9 Average leaderboard can share the exact same scope
// instead of a second, driftable copy of this string.
const OPENING_CATS = `AND g.game_type='x01' AND json_extract(g.config,'$.startingScore') IN (501,301,170,101)`;

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
// Checkout Trainer (docs/archive/checkout-trainer-roadmap.md) joins this exclusion for the
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

// Handicapping (docs/archive/rating-and-handicap-roadmap.md Part B): a handicapped
// player's own game_players.start_score overrides games.config.startingScore
// for THAT PLAYER ONLY — the game's own category/config keeps reading e.g.
// "501" regardless, since the other (unhandicapped) participant really is
// playing a straight 501. That means nine-darter detection (which checks
// config.startingScore=501) and "fewest darts to finish" Personal Bests would
// otherwise silently credit a handicapped player's shortened-start leg (say,
// finishing a 401-start leg in 9 darts) as a genuine 501 nine-darter/record —
// a fewer-darts feat that's mechanical, not earned, once the start is
// shortened. Every turns-table query below scopes on `t.` (turns), so this
// checks the SAME player's own start_score override for the SAME game, not
// just "was anyone in this game handicapped."
const NOT_HANDICAPPED = `AND NOT EXISTS (SELECT 1 FROM game_players gph WHERE gph.game_id = t.game_id AND gph.player_id = t.player_id AND gph.start_score IS NOT NULL)`;

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
  // docs/bug-roadmap.md BUG-27: X01_ONLY — a Big Fish is a 170 checkout in an X01 game;
  // without this, a 170 finish in a 121 Checkout Ladder / Dead Man Walking drill would
  // top the Big Fish leaderboard.
  const leaderboard = db.prepare(`SELECT p.name, COUNT(*) AS count ${J} WHERE t.checkout = 1 AND t.checkout_points = 170 ${mf} ${X01_ONLY} GROUP BY t.player_id ORDER BY count DESC`).all();
  const recent      = db.prepare(`SELECT p.name, t.created_at ${J} WHERE t.checkout = 1 AND t.checkout_points = 170 ${mf} ${X01_ONLY} ORDER BY t.created_at DESC LIMIT 10`).all();
  return { leaderboard, recent };
}

function getNineDarterStats(mode) {
  const mf = _mf(mode);
  const leaderboard = db.prepare(`
    SELECT p.name, COUNT(*) AS count FROM (
      SELECT t.player_id FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      WHERE g.game_type = 'x01' AND json_extract(g.config,'$.startingScore') = 501 ${mf} ${NOT_HANDICAPPED}
      GROUP BY t.player_id, t.game_id, t.set_no, t.leg_no
      HAVING COUNT(DISTINCT t.id) = 3 AND SUM(t.checkout) > 0 AND COUNT(d.id) = 9
    ) x JOIN players p ON p.id = x.player_id
    GROUP BY x.player_id ORDER BY count DESC
  `).all();
  const recent = db.prepare(`
    SELECT p.name, MAX(t.created_at) AS created_at
    FROM turns t JOIN games g ON g.id=t.game_id JOIN players p ON p.id=t.player_id
    JOIN darts d ON d.turn_id=t.id
    WHERE g.game_type = 'x01' AND json_extract(g.config,'$.startingScore') = 501 ${mf} ${NOT_HANDICAPPED}
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
    WHERE t.checkout = 1 AND t.checkout_points > 0 ${mf} ${X01_ONLY}
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
      ${mf} ${X01_ONLY}
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
  const tzMod = _tzModifier(tz);
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
            WHEN t.checkout = 1 AND t.checkout_points = 170 AND g.game_type = 'x01' THEN 2
            WHEN t.checkout = 1 AND t.checkout_points >= 100 AND g.game_type = 'x01' THEN 1
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
  // docs/bug-roadmap.md BUG-27: the checkout flashbacks are X01-only (a 170/100+ checkout
  // in a 121 Checkout Ladder / Dead Man Walking drill isn't the X01 "big fish"/ton+ this
  // celebrates) — same game_type guard the 180 branch above already carries.
  if (row.checkout && row.checkout_points === 170 && row.game_type === 'x01') {
    return { type: 'bigfish', year: Number(row.yr), yearsAgo, statLine: `A 170 checkout, ${row.category}` };
  }
  if (row.checkout && row.checkout_points >= 100 && row.game_type === 'x01') {
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

// docs/bug-roadmap.md BUG-13: `turnId` is optional, additive — omitting it (or
// passing null/undefined) keeps the original "delete whatever's newest" behavior
// unchanged for backward compatibility / the common single-controller-device case.
// When supplied (index.html's DB.deleteLastTurn() now remembers the id its own
// last recordTurn() call returned), it must match the game's actual current newest
// turn before anything is deleted — otherwise this device's "last turn" is stale
// (a second device/tab scored this same game since), and blindly deleting the
// newest turn would delete a turn this device never recorded. Fails closed (409)
// rather than guessing.
function deleteLastTurn(gameId, turnId) {
  if (turnId != null) {
    const requestedId = Number(turnId);
    const newest = db.prepare('SELECT id FROM turns WHERE game_id = ? ORDER BY id DESC LIMIT 1').get(Number(gameId));
    if (!Number.isInteger(requestedId) || !newest || newest.id !== requestedId) {
      throw httpError(409, 'This is no longer the most recent turn — refresh and try again.');
    }
  }
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
    WHERE t.player_id = ? AND t.checkout = 1 AND t.checkout_points = ? ${mf} ${X01_ONLY}
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

/* ---------- coaching insights (docs/archive/coaching-insights-roadmap.md) ----------
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
          // docs/archive/checkout-drill-link-roadmap.md "Drill this checkout": the one coaching
          // insight type with a concrete drillable number — weak_number/bust_parity/
          // form_trend below have no single checkout score to pin, so they carry no
          // `score` field and the frontend only offers the Drill button where one exists.
          score: scoreRow.score,
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

/* ---------- Dead Man Walking (docs/archive/dead-man-walking-roadmap.md) ----------
   getWeakestCheckouts() reuses Coaching Insight #3's own remaining-score
   reconstruction technique directly above (the same window-function trick,
   the same "starting score minus running prior-scored sum, per leg" formula)
   to find every double-out X01 turn's OWN remaining-before-the-turn, then
   groups those by that remaining value into a per-number weakness score.
   Sample-size floor mirrors COACHING_MIN_NUMBER_DARTS/COACHING_MIN_ROUTE_USES
   (see that section's own header comment) rather than inventing a fresh
   threshold from nothing -- a first-pass number, not confirmed against real
   play, same "not final" caveat every tunable constant in this feature set
   carries. */
const DMW_MIN_NUMBER_SAMPLES = 8; // encounters at a remaining value required before it's trusted as a real weakness
const DMW_TARGET_MIN = 32, DMW_TARGET_MAX = 170; // roadmap doc's own "32-170" range -- below 32 isn't "genuinely weak" territory for this drill

// Per-number weakness ranking, worst-first, capped at `count` -- the
// candidate pool getWeakestCheckouts()'s own caller (createGame(), via
// _buildDeadManWalkingRounds() below) draws this session's 15 rounds from
// (with repeats allowed via pickDeadManWalkingTargets(), frontend/scoring.js).
// Weakness score = 0.5*bustRate + 0.5*nonCompletionRate (deliberately
// overlapping -- every bust IS a non-completion too, so a number a player
// busts on often is weighted extra vs. one they merely leave unfinished
// without busting). Bogey numbers (159/162/163/165/166/168/169 under
// double-out) are excluded via checkoutHint()'s own '' unfinishable signal --
// the same source of truth the Checkout Trainer trick-question tier already
// trusts -- never served as a round's deficit; a player can't legally be
// asked to finish what can't be finished in 3 darts anyway. "Avoided"
// checkouts (the pitch's third failure category) aren't measured here at all
// -- see the roadmap doc's own "Open questions": no reliable signal exists in
// recorded data for "the player routed around this number on purpose."
function getWeakestCheckouts(playerName, count) {
  const p = getPlayer(playerName);
  if (!p) return [];
  const rows = db.prepare(`
    WITH ordered AS (
      SELECT t.bust, t.checkout,
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
    )
    SELECT remaining, COUNT(*) AS attempts, SUM(bust) AS busts, SUM(checkout) AS completions
    FROM ordered
    WHERE remaining BETWEEN ${DMW_TARGET_MIN} AND ${DMW_TARGET_MAX}
    GROUP BY remaining
  `).all(p.id);

  return rows
    .filter(r => r.attempts >= DMW_MIN_NUMBER_SAMPLES)
    .filter(r => checkoutHint(r.remaining, true, 3) !== '')
    .map(r => {
      const bustRate = r.busts / r.attempts;
      const nonCompletionRate = 1 - (r.completions / r.attempts);
      return {
        target: r.remaining,
        weaknessScore: 0.5 * bustRate + 0.5 * nonCompletionRate,
        attempts: r.attempts, busts: r.busts, completions: r.completions,
      };
    })
    .sort((a, b) => b.weaknessScore - a.weaknessScore || b.attempts - a.attempts || a.target - b.target)
    .slice(0, count);
}

// Historical average total darts-to-finish for the player's OWN won X01
// double-out legs whose checkout value falls in the given band -- the raw
// ingredient deadManWalkingParForTarget() (frontend/scoring.js) turns into a
// round's actual par. turns.checkout_points already IS the deficit that
// checkout turn closed (see getCoachingInsights()'s own checkout-route
// insight above, which reads it the same way) -- no window-function
// reconstruction needed here, unlike getWeakestCheckouts() above, since a WON
// leg's checkout_points is stored directly. "Total darts" spans every visit
// in that leg (including any earlier busts within it), matching how
// fewestDartsCheckout/getShanghaiWonLegs() etc. already count a real
// multi-visit checkout -- just averaged instead of minimum-ed.
function _dmwHistoricalAverageDarts(playerId, band) {
  const row = db.prepare(`
    SELECT AVG(leg_darts) AS avg FROM (
      SELECT COUNT(d.id) AS leg_darts
      FROM turns t JOIN games g ON g.id=t.game_id JOIN darts d ON d.turn_id=t.id
      JOIN game_players gp ON gp.game_id=t.game_id AND gp.player_id=t.player_id
      WHERE t.player_id=? AND g.game_type='x01' AND gp.out_mode='double'
      GROUP BY t.game_id, t.set_no, t.leg_no
      HAVING SUM(t.checkout)>0 AND MAX(t.checkout_points) BETWEEN ? AND ?
    )
  `).get(playerId, band.low, band.high);
  return row && row.avg != null ? row.avg : null;
}

// Server-authoritative round generation (docs/archive/dead-man-walking-roadmap.md
// "Data model": "config.rounds is computed once, server-side, at game
// creation... never accepted from the client") -- the whole security point of
// this function is that createGame() calls it itself, ignoring any
// client-supplied config.rounds entirely (see createGame()'s own
// dead_man_walking branch below). Cold start: a player with too little
// double-out X01 checkout history for a confident weakness ranking falls back
// to CHALLENGE_CHECKOUTS (frontend/scoring.js, shared with Daily Challenge)
// rather than inventing a second curated list.
function _buildDeadManWalkingRounds(playerName) {
  const p = getPlayer(playerName);
  let pool = getWeakestCheckouts(playerName, 15).map(c => c.target);
  if (!pool.length) pool = CHALLENGE_CHECKOUTS.slice();
  const targets = pickDeadManWalkingTargets(pool, 15, Math.random);
  return targets.map(target => {
    const band = deadManWalkingBandFor(target);
    const historicalAverage = p ? _dmwHistoricalAverageDarts(p.id, band) : null;
    const par = deadManWalkingParForTarget(target, historicalAverage);
    return { target, par };
  });
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
  // league_fixtures rows DO need no explicit delete despite pointing at a games row
  // (game_id) -- unlike tournament_matches, that FK is ON DELETE SET NULL, not
  // CASCADE, so wiping every game just reverts every fixture back to "pending"
  // (correct: the game that would have fulfilled it no longer exists) rather than
  // leaving a stranded non-NULL game_id or needing the row itself removed.
  // docs/archive/saved-games-roadmap.md: saved_games needs no explicit delete either --
  // its game_id IS CASCADE (unlike league_fixtures' SET NULL above), so wiping
  // every game takes any pause state with it for free, same as tournament_matches.
  // marathon_sessions needs the same explicit delete tournaments got from BUG-7:
  // nothing in it references a games row (only player_id → players), so the games
  // wipe can't cascade it, and marathon_session_legs.game_id is ON DELETE SET NULL —
  // without this line, completed sessions would survive a stats reset as phantom
  // history (sessionsCompleted > 0 with zero legs). DELETE FROM marathon_sessions
  // cascades marathon_session_legs (session_id ON DELETE CASCADE).
  db.exec('DELETE FROM turns; DELETE FROM game_players; DELETE FROM games; DELETE FROM tournaments; DELETE FROM marathon_sessions;');
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
// player_uuid_aliases (docs/archive/player-merge-roadmap.md) is covered the same way
// (player_id ON DELETE CASCADE onto the surviving player's row).
// ghost_races is covered twice over — player_id and both game FKs are all
// ON DELETE CASCADE, so either the player wipe or the game wipe below clears it.
// docs/archive/saved-games-roadmap.md: saved_games is covered twice over too — deleting
// all players cascades away their games (and with them, CASCADE, saved_games),
// and the explicit games delete below would clear it independently either way.
// docs/archive/league-mode-roadmap.md: leagues needs the same explicit delete tournaments
// got from BUG-7 — wiping all players cascades away league_players (player_id ON
// DELETE CASCADE), but nothing references the leagues PARENT row, so without this
// the league shells (name/category/dates) would survive a total wipe with a now-
// empty roster, showing an orphaned "0 players" league in the Leagues list. DELETE
// FROM leagues cascades league_players too, and league_fixtures with it (league_id
// ON DELETE CASCADE) — also independently cascaded by the players delete above
// (player1_id/player2_id are ON DELETE CASCADE too), so it's covered twice over,
// same as ghost_races below.
function wipeAllData() {
  db.exec('DELETE FROM players; DELETE FROM games; DELETE FROM tournaments; DELETE FROM leagues;');
  return { ok: true };
}

// Full-database export (docs/archive/data-export-roadmap.md, admin-only, Settings ->
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
    players: db.prepare('SELECT id, uuid, name, out_mode, created_at, dart_weight FROM players').all(),
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
    // docs/archive/league-mode-roadmap.md: same standing rule — leagues/league_players carry
    // no credential columns, so they belong in "take your data with you" too.
    leagues: db.prepare('SELECT * FROM leagues').all(),
    leaguePlayers: db.prepare('SELECT * FROM league_players').all(),
    // docs/archive/league-mode-roadmap.md "League fixtures / pending matches": same standing
    // rule as tournament tables above — ordinary user data, no secrets.
    leagueFixtures: db.prepare('SELECT * FROM league_fixtures').all(),
    // docs/archive/player-merge-roadmap.md: merged-away-uuid aliases are ordinary user data
    // (identity mappings, no secrets) and materially affect how future per-player
    // imports resolve, so they belong in "take your data with you" too.
    playerUuidAliases: db.prepare('SELECT * FROM player_uuid_aliases').all(),
    // docs/archive/saved-games-roadmap.md: same standing rule — a pause is ordinary local
    // workflow state (which games are currently sitting mid-match, no secrets),
    // so it belongs in the full-database "take your data with you" dump. Deliberately
    // NOT in the per-player export below — see this table's own schema comment.
    savedGames: db.prepare('SELECT * FROM saved_games').all(),
    // docs/archive/marathon-mode-roadmap.md: same standing rule — session groupings
    // (durations, start/end times, leg order) are ordinary user data that can't be
    // reconstructed from the raw leg games alone, so they belong in the dump too.
    marathonSessions: db.prepare('SELECT * FROM marathon_sessions').all(),
    marathonSessionLegs: db.prepare('SELECT * FROM marathon_session_legs').all(),
  };
}

// Per-player export (docs/archive/data-export-roadmap.md, admin-only, Settings -> Data
// Export -> Export Player): unlike the full-database dump above, this scopes to
// one player's own history — but H2H isn't stored anywhere (getH2HRecord() computes
// it live from games/game_players/turns), so preserving it means bundling the real
// game/turn/dart rows for every game this player is in, including opponents' own
// turns within those SAME games — "Ben beat Alaina 3-1" can't be represented
// without Alaina's side of the board. Opponents therefore get a minimal identity
// stub (uuid + name only) plus their rows within games shared with this player —
// never their other games against other people; this isn't a backdoor to exporting
// someone else's full history. The uuid (assigned to every player at creation, see
// the players table migration above) is what makes an opponent stub re-attachable
// on another server without a name collision: a future import path can look a
// stub up by uuid first and auto-create a placeholder row for it if missing, so
// "Ben beat Alaina" stays intact even when Alaina herself was never exported.
// Deliberately out of scope for v1: tournament/league/daily-challenge/ghost-race
// participation — each ties into structures (brackets, seasons, streaks) bigger
// than a single player's own record, and is left for a future pass rather than
// attempted here.
//
// `player`/`opponents` both carry a plain `id` alongside `uuid` -- this is the
// SOURCE server's local integer id, only meaningful together with this same export
// payload (games/gamePlayers/turns below reference player_id using these same
// integers). importPlayerExport() uses it to build a source-id -> target-id map
// before touching any game data; `uuid` remains the only identity that's portable
// on its own.
// docs/bug-roadmap.md BUG-19: SQLite caps a single statement at
// SQLITE_MAX_VARIABLE_NUMBER bound parameters (32766 in current builds), so a naive
// `... IN (?,?,?,...)` list with one placeholder per id throws "too many SQL
// variables" once a prolific player has more than that many turns (the first list to
// cross the cap). Splitting the ids into sub-cap batches and concatenating the reads
// bounds the per-statement variable count regardless of history size. 900 matches
// SQLite's own conservative historical default and leaves generous headroom.
const ID_CHUNK = 900;
function _selectByIdChunks(cols, table, column, ids, chunkSize = ID_CHUNK) {
  const out = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const batch = ids.slice(i, i + chunkSize);
    const ph = batch.map(() => '?').join(',');
    out.push(...db.prepare(`SELECT ${cols} FROM ${table} WHERE ${column} IN (${ph})`).all(...batch));
  }
  return out;
}

function getPlayerExport(name, chunkSize = ID_CHUNK) {
  const p = db.prepare('SELECT id, uuid, name, out_mode, dart_weight, created_at FROM players WHERE name = ? COLLATE NOCASE').get(String(name));
  if (!p) throw httpError(404, 'Player not found');

  const gameIds = db.prepare('SELECT game_id FROM game_players WHERE player_id = ?').all(p.id).map(r => r.game_id);

  const games       = _selectByIdChunks('*', 'games', 'id', gameIds, chunkSize);
  const gamePlayers = _selectByIdChunks('*', 'game_players', 'game_id', gameIds, chunkSize);
  const turns       = _selectByIdChunks('*', 'turns', 'game_id', gameIds, chunkSize);

  const turnIds = turns.map(t => t.id);
  const darts = _selectByIdChunks('*', 'darts', 'turn_id', turnIds, chunkSize);

  const opponentIds = [...new Set(gamePlayers.map(gp => gp.player_id))].filter(id => id !== p.id);
  const opponents = _selectByIdChunks('id, uuid, name', 'players', 'id', opponentIds, chunkSize);

  const playerBadges = db.prepare('SELECT badge_id, count, earned_at FROM player_badges WHERE player_id = ?').all(p.id);

  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    player: { id: p.id, uuid: p.uuid, name: p.name, outMode: p.out_mode, dartWeight: p.dart_weight ?? null, createdAt: p.created_at },
    games, gamePlayers, turns, darts, opponents, playerBadges,
  };
}

// CSV export (docs/archive/data-export-roadmap.md, admin-only, the "your own stats as a
// spreadsheet" counterpart to the JSON export above): deliberately simpler and
// NON-portable — no uuids, no opponents' turns, no round-trip/import story. Two
// flavors, both scoped strictly to the named player's OWN rows:
//   kind='games' -> one row per game they played, with per-game aggregates of
//                   their own turns (points, avg/turn, busts, checkouts, ...)
//   kind='turns' -> one row per turn they threw, with per-dart notation
//                   ("T20 S5 D16"; "25"=single bull, "BULL"=50, "MISS")
// Opponents appear only as a names column on the games CSV — never their turns,
// so unlike the JSON export this can't reconstruct H2H and isn't meant to.
// Column semantics follow the underlying schema: `scored`/`checkout`/`bust` mean
// whatever they mean for that row's game_type (e.g. Cricket's scored is points,
// Checkout Trainer's target_score is only ever set for its own turns).
//
// Cell encoding is RFC-4180 (quote+double any cell containing `"`, `,`, or a
// newline; CRLF line endings for spreadsheet-app friendliness). Player names are
// the one user-controlled string that lands in these cells, and names may start
// with `=`/`+`/`-`/`@` (only control characters are rejected at creation) — a
// classic CSV-formula-injection vector when the file is opened in Excel/Sheets,
// so any string cell starting with one of those is prefixed with a `'` (the
// standard OWASP neutralization; displays near-identically, never executes).
// Numeric cells are app-computed and pass through untouched.
function _csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function _csvDocument(header, rows) {
  return [header, ...rows].map(cells => cells.map(_csvCell).join(',')).join('\r\n') + '\r\n';
}
function _dartNotation(d) {
  if (d.sector === 0) return 'MISS';
  if (d.sector === 25) return d.multiplier === 2 ? 'BULL' : '25';
  return (d.multiplier === 3 ? 'T' : d.multiplier === 2 ? 'D' : 'S') + d.sector;
}

const CSV_EXPORT_KINDS = ['games', 'turns'];

function getPlayerCsvExport(name, kind) {
  if (!CSV_EXPORT_KINDS.includes(kind)) throw httpError(400, `kind must be one of: ${CSV_EXPORT_KINDS.join(', ')}`);
  const p = db.prepare('SELECT id, name FROM players WHERE name = ? COLLATE NOCASE').get(String(name));
  if (!p) throw httpError(404, 'Player not found');
  return kind === 'games' ? _buildGamesCsv(p) : _buildTurnsCsv(p);
}

function _buildGamesCsv(p) {
  const rows = db.prepare(`
    SELECT g.id, g.created_at, g.completed_at, g.game_type, g.category,
           g.legs_per_set, g.sets_per_game, g.practice, g.winner_id,
           COUNT(t.id)                                          AS turns,
           COALESCE(SUM(t.scored), 0)                           AS points_scored,
           MAX(t.scored)                                        AS best_turn,
           COALESCE(SUM(t.bust), 0)                             AS busts,
           COALESCE(SUM(t.checkout), 0)                         AS checkouts,
           MAX(CASE WHEN t.checkout = 1 THEN t.checkout_points END) AS highest_checkout,
           (SELECT COUNT(*) FROM darts d JOIN turns t2 ON t2.id = d.turn_id
             WHERE t2.game_id = g.id AND t2.player_id = ?)      AS darts_thrown,
           (SELECT GROUP_CONCAT(name, '; ') FROM (
              SELECT p2.name FROM game_players gp2 JOIN players p2 ON p2.id = gp2.player_id
               WHERE gp2.game_id = g.id AND gp2.player_id != ? ORDER BY p2.name)) AS opponents
      FROM games g
      JOIN game_players gp ON gp.game_id = g.id AND gp.player_id = ?
      LEFT JOIN turns t ON t.game_id = g.id AND t.player_id = ?
     GROUP BY g.id
     ORDER BY g.created_at, g.id
  `).all(p.id, p.id, p.id, p.id);

  const header = ['game_id', 'started_at', 'completed_at', 'game_type', 'category',
    'legs_per_set', 'sets_per_game', 'practice', 'opponents', 'result', 'turns',
    'darts_thrown', 'points_scored', 'avg_per_turn', 'best_turn', 'busts',
    'checkouts', 'highest_checkout'];
  return _csvDocument(header, rows.map(g => {
    // result is relative to THIS player: 'won'/'lost' when a completed game has a
    // recorded winner, 'completed' when it finished without one (some practice
    // flows), 'unfinished' when it never completed at all.
    const result = g.winner_id === p.id ? 'won'
      : (g.completed_at ? (g.winner_id != null ? 'lost' : 'completed') : 'unfinished');
    const avg = g.turns ? Math.round((g.points_scored / g.turns) * 100) / 100 : null;
    return [g.id, g.created_at, g.completed_at, g.game_type, g.category,
      g.legs_per_set, g.sets_per_game, g.practice, g.opponents, result, g.turns,
      g.darts_thrown, g.points_scored, avg, g.best_turn, g.busts,
      g.checkouts, g.highest_checkout];
  }));
}

function _buildTurnsCsv(p) {
  const turns = db.prepare(`
    SELECT t.id, t.game_id, g.game_type, g.category, t.created_at, t.set_no, t.leg_no,
           t.scored, t.bust, t.checkout, t.checkout_points, t.leg_won, t.target_score,
           t.declared_unsolvable
      FROM turns t JOIN games g ON g.id = t.game_id
     WHERE t.player_id = ?
     ORDER BY t.game_id, t.id
  `).all(p.id);
  const dartsByTurn = new Map();
  for (const d of db.prepare(`
    SELECT d.turn_id, d.sector, d.multiplier FROM darts d
      JOIN turns t ON t.id = d.turn_id
     WHERE t.player_id = ?
     ORDER BY d.turn_id, d.dart_no
  `).all(p.id)) {
    if (!dartsByTurn.has(d.turn_id)) dartsByTurn.set(d.turn_id, []);
    dartsByTurn.get(d.turn_id).push(_dartNotation(d));
  }

  const header = ['turn_id', 'game_id', 'game_type', 'category', 'turn_at', 'set_no',
    'leg_no', 'scored', 'bust', 'checkout', 'checkout_points', 'leg_won',
    'target_score', 'declared_unsolvable', 'darts', 'darts_detail'];
  return _csvDocument(header, turns.map(t => {
    const notations = dartsByTurn.get(t.id) || [];
    return [t.id, t.game_id, t.game_type, t.category, t.created_at, t.set_no,
      t.leg_no, t.scored, t.bust, t.checkout, t.checkout_points, t.leg_won,
      t.target_score, t.declared_unsolvable, notations.length, notations.join(' ')];
  }));
}

// Per-player import (docs/archive/data-export-roadmap.md, admin-only, the counterpart to
// getPlayerExport() above): takes exactly the JSON shape that function produces and
// writes it into THIS server's database.
//
// Player resolution (main player AND every opponent stub, all resolved BEFORE any
// game/turn/dart is touched) always looks up by `uuid` first -- never by `name`
// alone, since names are only unique within one server's own roster
// (`players.name UNIQUE COLLATE NOCASE`), not across independently-run servers. A
// uuid match reuses that existing local row (this is also what makes importing the
// SAME player's export twice, or later importing an opponent's own full export
// after they'd only existed as a stub, land on one row instead of creating
// duplicates -- see docs/archive/data-export-roadmap.md). No uuid match creates a new
// player row from the exported uuid+name; if that name collides with an unrelated
// local player (different uuid -- a genuine coincidence, not the same person), the
// import uniquifies the name rather than silently merging two different people's
// histories onto one row, and reports the rename so the admin can see it happened.
//
// Games/turns/darts are inserted directly via raw SQL, deliberately bypassing
// createGame()/addTurn()/completeGame() and their lifecycle hooks (league
// auto-tagging, badge-award checks, HA webhooks) -- this is a historical data
// restore, not a live game being played, and the export's own playerBadges array
// already carries exactly which badges the source earned, so nothing needs
// re-deriving. league_id is always imported as NULL (leagues aren't part of a
// per-player export at all, so a source league_id is never meaningful here).
//
// Duplicate-import guard: before inserting each game, checks for an existing local
// game with the same created_at/category/game_type/legs_per_set/sets_per_game and
// the exact same (already-remapped) participant id set, and skips it if found --
// this is what makes importing the same export file twice a safe no-op instead of
// doubling every stat, without needing a separate "have I imported this before"
// tracking table (computed at import time from data already in the DB, the same
// "nothing pre-aggregated" philosophy as the rest of this schema).
function _findMatchingLocalGame(g, participantTargetIds) {
  if (!participantTargetIds.length) return null;
  const candidates = db.prepare(
    `SELECT id FROM games WHERE created_at = ? AND category = ? AND game_type = ? AND legs_per_set = ? AND sets_per_game = ?`
  ).all(g.created_at, g.category, g.game_type, g.legs_per_set, g.sets_per_game);
  const wanted = [...participantTargetIds].sort((a, b) => a - b);
  for (const c of candidates) {
    const ids = db.prepare('SELECT player_id FROM game_players WHERE game_id = ? ORDER BY player_id').all(c.id).map(r => r.player_id);
    if (ids.length === wanted.length && ids.every((v, i) => v === wanted[i])) return c.id;
  }
  return null;
}

function importPlayerExport(payload) {
  if (!payload || typeof payload !== 'object') throw httpError(400, 'Invalid import file');
  if (payload.schemaVersion !== 1) throw httpError(400, `Unsupported schemaVersion (expected 1, got ${payload.schemaVersion})`);
  const { player, games, gamePlayers, turns, darts, opponents, playerBadges } = payload;
  if (!player || typeof player !== 'object' || !Array.isArray(games) || !Array.isArray(gamePlayers)
      || !Array.isArray(turns) || !Array.isArray(darts) || !Array.isArray(opponents)) {
    throw httpError(400, 'Malformed import file — expected the shape produced by GET /api/players/export');
  }

  const idMap = new Map(); // exported (source-server) player id -> this server's local player id

  function resolveStub(stub) {
    if (!stub || typeof stub.uuid !== 'string' || !stub.uuid || typeof stub.id !== 'number') {
      throw httpError(400, 'Import file has a player/opponent entry missing id/uuid');
    }
    const existing = db.prepare('SELECT id, name FROM players WHERE uuid = ?').get(stub.uuid);
    if (existing) {
      idMap.set(stub.id, existing.id);
      return { name: existing.name, uuid: stub.uuid, created: false, renamed: false };
    }
    // docs/archive/player-merge-roadmap.md: a merged-away player's uuid no longer exists on
    // any players row, but an OLD export (from another server) can still carry it.
    // The alias table mergePlayers() maintains resolves it onto the surviving row —
    // otherwise this import would recreate a stub duplicate of a player the admin
    // had deliberately consolidated.
    const aliased = db.prepare(
      `SELECT p.id, p.name FROM player_uuid_aliases a JOIN players p ON p.id = a.player_id WHERE a.uuid = ?`
    ).get(stub.uuid);
    if (aliased) {
      idMap.set(stub.id, aliased.id);
      return { name: aliased.name, uuid: stub.uuid, created: false, renamed: false };
    }
    let finalName = validatePlayerName(stub.name);
    let n = 2;
    const originalName = finalName;
    while (db.prepare('SELECT id FROM players WHERE name = ? COLLATE NOCASE').get(finalName)) {
      finalName = validatePlayerName(`${originalName} (${n})`);
      n++;
    }
    db.prepare('INSERT INTO players (name, out_mode, uuid) VALUES (?, ?, ?)').run(finalName, 'double', stub.uuid);
    const created = db.prepare('SELECT id FROM players WHERE uuid = ?').get(stub.uuid);
    idMap.set(stub.id, created.id);
    return { name: finalName, uuid: stub.uuid, created: true, renamed: finalName !== originalName };
  }

  const playerReport = resolveStub(player);
  if (playerReport.created) {
    db.prepare('UPDATE players SET out_mode = ?, dart_weight = ? WHERE uuid = ?')
      .run(player.outMode === 'single' ? 'single' : 'double', player.dartWeight ?? null, player.uuid);
  }
  const opponentReports = opponents.map(resolveStub);

  let gamesImported = 0, gamesSkipped = 0, turnsImported = 0, dartsImported = 0, badgesImported = 0;
  const gameIdMap = new Map();
  // Games matched to an existing local row by _findMatchingLocalGame() are skipped
  // entirely -- their turns/darts already exist locally too (either from the original
  // play-through or an earlier import) and must NOT be re-inserted under the existing
  // game. gameIdMap still records the source->local id (needed so a *different*
  // export that references this same game, e.g. an opponent's own import, can still
  // resolve it), so the turns loop below checks this set first rather than relying on
  // gameIdMap.get() being null.
  const skippedGameIds = new Set();

  const insertGame = db.prepare(`INSERT INTO games
    (category, legs_per_set, sets_per_game, created_at, completed_at, winner_id, practice, game_type, config, player_count, league_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
  // start_score must round-trip: NULLing it would strip the handicap marker, so
  // imported shortened legs would evade the NOT_HANDICAPPED exclusions (nine-darter/
  // fewest-darts/first-9 leaderboards, Elo) that live play applies. `?? null` keeps
  // an export written before start_score existed importable.
  const insertGamePlayer = db.prepare('INSERT INTO game_players (game_id, player_id, out_mode, dart_weight, loadout_id, start_score) VALUES (?, ?, ?, ?, NULL, ?)');

  for (const g of games) {
    const participants = gamePlayers.filter(gp => gp.game_id === g.id);
    const targetIds = participants.map(gp => idMap.get(gp.player_id)).filter(id => id != null);

    const existingId = _findMatchingLocalGame(g, targetIds);
    if (existingId) { gameIdMap.set(g.id, existingId); skippedGameIds.add(g.id); gamesSkipped++; continue; }

    // games.config is untrusted file content and the read paths parse it
    // unguarded — reject malformed JSON at the boundary rather than inserting a
    // row that would 500 every later turn write / saved-games read. For killer
    // games, re-key the id-keyed number assignment from the export's
    // (source-server) player ids to this server's own resolved local ids —
    // idMap already carries exactly that translation for every stub this
    // import touched, so no separate name-based map is needed the way the
    // old name-keyed scheme required (item 43, docs/code-quality-roadmap.md).
    let configJson = g.config ?? null;
    if (configJson != null) {
      let cfg;
      try { cfg = JSON.parse(configJson); } catch {
        throw httpError(400, `Import file has malformed JSON in games.config (source game ${g.id})`);
      }
      if (g.game_type === 'killer' && cfg && cfg.numbers) {
        const remapped = {};
        for (const [sourceId, num] of Object.entries(cfg.numbers)) {
          const localId = idMap.get(Number(sourceId));
          if (localId != null) remapped[localId] = num;
        }
        cfg.numbers = remapped;
        configJson = JSON.stringify(cfg);
      }
    }

    const info = insertGame.run(
      g.category, g.legs_per_set, g.sets_per_game, g.created_at, g.completed_at,
      g.winner_id != null ? (idMap.get(g.winner_id) ?? null) : null,
      g.practice, g.game_type, configJson, g.player_count
    );
    const newGameId = Number(info.lastInsertRowid);
    gameIdMap.set(g.id, newGameId);
    gamesImported++;

    for (const gp of participants) {
      const tid = idMap.get(gp.player_id);
      if (tid == null) continue; // every participant must resolve via player/opponents stubs; skip defensively if not
      insertGamePlayer.run(newGameId, tid, gp.out_mode, gp.dart_weight ?? null, gp.start_score ?? null);
    }
  }

  const turnIdMap = new Map();
  const insertTurn = db.prepare(`INSERT INTO turns
    (game_id, player_id, set_no, leg_no, scored, bust, checkout, checkout_points, created_at, leg_won, target_score, declared_unsolvable, affected_player_id, declared_hit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const t of turns) {
    if (skippedGameIds.has(t.game_id)) continue; // game already exists locally -- its turns/darts do too
    const newGameId = gameIdMap.get(t.game_id);
    const tid = idMap.get(t.player_id);
    if (newGameId == null || tid == null) continue; // unresolved player, or a game that failed to insert
    // `?? 0`/`?? null` keeps an export written before declared_unsolvable /
    // affected_player_id / declared_hit existed importable. affected_player_id is a
    // players FK, so it must remap through idMap like every other player reference —
    // carrying the source server's raw id would attribute the effect to an arbitrary
    // local player.
    const affectedTid = t.affected_player_id != null ? (idMap.get(t.affected_player_id) ?? null) : null;
    const info = insertTurn.run(newGameId, tid, t.set_no, t.leg_no, t.scored, t.bust, t.checkout, t.checkout_points, t.created_at, t.leg_won, t.target_score, t.declared_unsolvable ?? 0, affectedTid, t.declared_hit ?? null);
    turnIdMap.set(t.id, Number(info.lastInsertRowid));
    turnsImported++;
  }

  const insertDart = db.prepare(`INSERT INTO darts
    (turn_id, dart_no, sector, multiplier, thrown_at, zone, miss_zone, miss_depth, bounced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const d of darts) {
    const newTurnId = turnIdMap.get(d.turn_id);
    if (newTurnId == null) continue;
    insertDart.run(newTurnId, d.dart_no, d.sector, d.multiplier, d.thrown_at, d.zone, d.miss_zone, d.miss_depth, d.bounced);
    dartsImported++;
  }

  const insertBadge = db.prepare('INSERT INTO player_badges (player_id, badge_id, count, earned_at) VALUES (?, ?, ?, ?)');
  for (const b of (playerBadges || [])) {
    const exists = db.prepare('SELECT 1 FROM player_badges WHERE player_id = ? AND badge_id = ?').get(idMap.get(player.id), b.badge_id);
    if (exists) continue;
    insertBadge.run(idMap.get(player.id), b.badge_id, b.count, b.earned_at);
    badgesImported++;
  }

  return { ok: true, player: playerReport, opponents: opponentReports, gamesImported, gamesSkipped, turnsImported, dartsImported, badgesImported };
}

/* ---------- player merge (docs/archive/player-merge-roadmap.md) ----------
   Admin-only: absorbs one player row (the SOURCE) into another (the TARGET —
   always an explicit admin choice, never inferred) and deletes the source.
   Touches every table with a FK into players.id (grounded in this file's actual
   schema, `grep "REFERENCES players"`): game_players, turns, games.winner_id,
   player_badges, daily_challenge_attempts, tournaments.champion_id/runner_up_id,
   tournament_players, tournament_matches.player1/player2/winner_id,
   league_players, league_fixtures.player1_id/player2_id, dart_components,
   loadouts, ghost_races, player_uuid_aliases.

   Conflict policy (the roadmap doc's recommendations, adopted):
   - BLOCKED outright — the merge refuses to run — when source and target share
     a game (game_players' composite PK would collide, and a "played themselves"
     row is a structural oddity worth surfacing, not papering over), share a
     tournament or league enrollment (same composite-PK collision, plus silent
     bracket/standings corruption risk), or both attempted the same Daily
     Challenge date without exactly one of the two being completed (no
     non-destructive default exists; the admin resolves it first with the
     existing Settings -> Daily Challenge reset tool). Blocking the shared-league
     case also blocks every source-vs-target league fixture, so a fixture can
     never end up pairing a player with themselves.
   - AUTO-RESOLVED — a badge both earned keeps MAX(count) (a merge must never
     inflate a count beyond what either history actually earned) and
     MIN(earned_at) (the genuinely earliest "first earned"); a same-date
     challenge pair where exactly one is completed keeps the completed one.
   - The target's own profile row (name/out_mode/dart_weight/PIN/uuid) always
     wins, untouched — transplanting the source's PIN onto a different surviving
     record has security texture the roadmap doc deliberately declined.

   getMergePreview() computes everything the merge WOULD do — per-table move
   counts, auto-resolutions, and the full blocker list — without writing a byte;
   the UI requires it before any merge, and mergePlayers() re-derives the same
   blockers itself so the API can't be raced or called blind. The merge runs in
   a real transaction (the schema-wide rewrite is atomic: any failure rolls back
   to exactly the pre-merge state). */
function _mergeBlockers(sourceId, targetId) {
  const sharedGames = db.prepare(`
    SELECT g.id, g.created_at, g.game_type, g.category FROM games g
     WHERE EXISTS (SELECT 1 FROM game_players WHERE game_id = g.id AND player_id = ?)
       AND EXISTS (SELECT 1 FROM game_players WHERE game_id = g.id AND player_id = ?)
     ORDER BY g.id`).all(sourceId, targetId);
  const sharedTournaments = db.prepare(`
    SELECT t.id, t.name FROM tournaments t
     WHERE EXISTS (SELECT 1 FROM tournament_players WHERE tournament_id = t.id AND player_id = ?)
       AND EXISTS (SELECT 1 FROM tournament_players WHERE tournament_id = t.id AND player_id = ?)
     ORDER BY t.id`).all(sourceId, targetId);
  const sharedLeagues = db.prepare(`
    SELECT l.id, l.name FROM leagues l
     WHERE EXISTS (SELECT 1 FROM league_players WHERE league_id = l.id AND player_id = ?)
       AND EXISTS (SELECT 1 FROM league_players WHERE league_id = l.id AND player_id = ?)
     ORDER BY l.id`).all(sourceId, targetId);
  // Same-date Daily Challenge attempts from both, where the "keep the completed
  // one" rule can't decide (both completed, or neither) — needs the admin to
  // delete one first via the existing challenge reset tool.
  const ambiguousChallengeDates = db.prepare(`
    SELECT s.challenge_date AS date FROM daily_challenge_attempts s
      JOIN daily_challenge_attempts t ON t.challenge_date = s.challenge_date AND t.player_id = ?
     WHERE s.player_id = ? AND s.completed = t.completed
     ORDER BY s.challenge_date`).all(targetId, sourceId).map(r => r.date);
  // docs/archive/saved-games-roadmap.md "Interactions with existing features": a saved
  // game between source and target is already a shared game (blocked above).
  // A saved game against a THIRD player can still collide after the merge —
  // if target independently has their OWN saved game against that same third
  // player (and game type), reassigning source's saved game onto target would
  // leave target with two saved games in one (participants, game type) slot,
  // something normal play can never produce (saveGame() enforces "one per
  // slot" at save time). Blocked, consistent with every other shared-row case.
  const savedGameCollisions = _savedGameCollisions(sourceId, targetId);
  return { sharedGames, sharedTournaments, sharedLeagues, ambiguousChallengeDates, savedGameCollisions };
}

function _savedGameCollisions(sourceId, targetId) {
  const savedFor = (playerId) => db.prepare(`
    SELECT sg.game_id AS gameId, g.game_type AS gameType FROM saved_games sg
    JOIN games g ON g.id = sg.game_id
    WHERE EXISTS (SELECT 1 FROM game_players WHERE game_id = g.id AND player_id = ?)
  `).all(playerId);
  const sourceSaved = savedFor(sourceId);
  if (!sourceSaved.length) return [];
  const targetSaved = savedFor(targetId);
  if (!targetSaved.length) return [];
  const idsFor = (gameId) => new Set(db.prepare('SELECT player_id FROM game_players WHERE game_id = ?').all(gameId).map(r => r.player_id));
  const collisions = [];
  for (const s of sourceSaved) {
    // The source's saved game's participant set AFTER the merge — source's own
    // id becomes target's.
    const afterIds = new Set([...idsFor(s.gameId)].map(id => id === sourceId ? targetId : id));
    for (const t of targetSaved) {
      if (t.gameType !== s.gameType) continue;
      const targetIds = idsFor(t.gameId);
      if (afterIds.size === targetIds.size && [...afterIds].every(id => targetIds.has(id))) {
        collisions.push({ sourceGameId: s.gameId, targetGameId: t.gameId, gameType: s.gameType });
      }
    }
  }
  return collisions;
}

function _resolveMergePlayers(sourceName, targetName) {
  const source = db.prepare('SELECT id, uuid, name FROM players WHERE name = ? COLLATE NOCASE').get(String(sourceName ?? ''));
  const target = db.prepare('SELECT id, uuid, name FROM players WHERE name = ? COLLATE NOCASE').get(String(targetName ?? ''));
  if (!source || !target) throw httpError(404, 'Player not found');
  if (source.id === target.id) throw httpError(400, 'Source and target must be two different players');
  return { source, target };
}

function getMergePreview(sourceName, targetName) {
  const { source, target } = _resolveMergePlayers(sourceName, targetName);
  const blockers = _mergeBlockers(source.id, target.id);
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;

  const moves = {
    games:                 count('SELECT COUNT(*) n FROM game_players WHERE player_id = ?', source.id),
    turns:                 count('SELECT COUNT(*) n FROM turns WHERE player_id = ?', source.id),
    gameWins:              count('SELECT COUNT(*) n FROM games WHERE winner_id = ?', source.id),
    badges:                count('SELECT COUNT(*) n FROM player_badges WHERE player_id = ?', source.id),
    challengeAttempts:     count('SELECT COUNT(*) n FROM daily_challenge_attempts WHERE player_id = ?', source.id),
    tournamentEnrollments: count('SELECT COUNT(*) n FROM tournament_players WHERE player_id = ?', source.id),
    tournamentTitles:      count('SELECT COUNT(*) n FROM tournaments WHERE champion_id = ? OR runner_up_id = ?', source.id, source.id),
    tournamentMatchSlots:  count('SELECT COUNT(*) n FROM tournament_matches WHERE player1_id = ? OR player2_id = ? OR winner_id = ?', source.id, source.id, source.id),
    leagueEnrollments:     count('SELECT COUNT(*) n FROM league_players WHERE player_id = ?', source.id),
    leagueFixtures:        count('SELECT COUNT(*) n FROM league_fixtures WHERE player1_id = ? OR player2_id = ?', source.id, source.id),
    dartComponents:        count('SELECT COUNT(*) n FROM dart_components WHERE player_id = ?', source.id),
    loadouts:              count('SELECT COUNT(*) n FROM loadouts WHERE player_id = ?', source.id),
    ghostRaces:            count('SELECT COUNT(*) n FROM ghost_races WHERE player_id = ?', source.id),
    marathonSessions:      count('SELECT COUNT(*) n FROM marathon_sessions WHERE player_id = ?', source.id),
    uuidAliases:           count('SELECT COUNT(*) n FROM player_uuid_aliases WHERE player_id = ?', source.id),
  };
  const resolutions = {
    // Badges both players earned — target keeps MAX(count)/MIN(earned_at).
    sharedBadges: db.prepare(`
      SELECT s.badge_id AS badgeId FROM player_badges s
        JOIN player_badges t ON t.badge_id = s.badge_id AND t.player_id = ?
       WHERE s.player_id = ? ORDER BY s.badge_id`).all(target.id, source.id).map(r => r.badgeId),
    // Same-date challenge pairs where exactly one is completed — that one is kept.
    resolvableChallengeDates: db.prepare(`
      SELECT s.challenge_date AS date FROM daily_challenge_attempts s
        JOIN daily_challenge_attempts t ON t.challenge_date = s.challenge_date AND t.player_id = ?
       WHERE s.player_id = ? AND s.completed != t.completed
       ORDER BY s.challenge_date`).all(target.id, source.id).map(r => r.date),
  };
  const blocked = !!(blockers.sharedGames.length || blockers.sharedTournaments.length
    || blockers.sharedLeagues.length || blockers.ambiguousChallengeDates.length || blockers.savedGameCollisions.length);
  return { ok: !blocked, blocked,
    source: { name: source.name, uuid: source.uuid },
    target: { name: target.name, uuid: target.uuid },
    moves, resolutions, blockers };
}

function mergePlayers(sourceName, targetName) {
  const { source, target } = _resolveMergePlayers(sourceName, targetName);
  const blockers = _mergeBlockers(source.id, target.id);
  if (blockers.sharedGames.length || blockers.sharedTournaments.length
      || blockers.sharedLeagues.length || blockers.ambiguousChallengeDates.length || blockers.savedGameCollisions.length) {
    const parts = [];
    if (blockers.sharedGames.length) parts.push(`${blockers.sharedGames.length} shared game(s)`);
    if (blockers.sharedTournaments.length) parts.push(`${blockers.sharedTournaments.length} shared tournament(s)`);
    if (blockers.sharedLeagues.length) parts.push(`${blockers.sharedLeagues.length} shared league(s)`);
    if (blockers.ambiguousChallengeDates.length) parts.push(`${blockers.ambiguousChallengeDates.length} unresolvable same-day Daily Challenge attempt(s)`);
    if (blockers.savedGameCollisions.length) parts.push(`${blockers.savedGameCollisions.length} saved-game slot collision(s)`);
    throw httpError(400, `Merge blocked: ${parts.join(', ')} — resolve these by hand first (see the merge preview for the full list)`);
  }

  const preview = getMergePreview(sourceName, targetName); // captured pre-write, returned as the summary
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  db.exec('BEGIN');
  try {
    // Conflict-free reassignments (no shared game/tournament/league rows exist —
    // verified above — so none of the composite PKs can collide).
    run('UPDATE game_players SET player_id = ? WHERE player_id = ?', target.id, source.id);
    run('UPDATE turns SET player_id = ? WHERE player_id = ?', target.id, source.id);
    // affected_player_id (Killer: whose life total the dart changed) is a player
    // reference too — added via bare ALTER with no FK, so a missed reassignment
    // wouldn't error or cascade, it would just dangle at the deleted source id
    // and silently NULL out on any later export/import round trip.
    run('UPDATE turns SET affected_player_id = ? WHERE affected_player_id = ?', target.id, source.id);
    run('UPDATE games SET winner_id = ? WHERE winner_id = ?', target.id, source.id);

    // Badges: shared ones fold into the target (MAX count, earliest earned_at),
    // then the source's remaining, unshared rows reassign wholesale.
    run(`UPDATE player_badges SET
           count = MAX(count, (SELECT s.count FROM player_badges s WHERE s.player_id = ? AND s.badge_id = player_badges.badge_id)),
           earned_at = MIN(earned_at, (SELECT s.earned_at FROM player_badges s WHERE s.player_id = ? AND s.badge_id = player_badges.badge_id))
         WHERE player_id = ? AND badge_id IN (SELECT badge_id FROM player_badges WHERE player_id = ?)`,
      source.id, source.id, target.id, source.id);
    run(`DELETE FROM player_badges WHERE player_id = ? AND badge_id IN (SELECT badge_id FROM player_badges WHERE player_id = ?)`,
      source.id, target.id);
    run('UPDATE player_badges SET player_id = ? WHERE player_id = ?', target.id, source.id);

    // Daily Challenge: every remaining same-date pair has exactly one completed
    // attempt (the ambiguous ones blocked above) — keep the completed one,
    // whichever side it came from, then reassign the source's remaining dates.
    run(`DELETE FROM daily_challenge_attempts WHERE player_id = ? AND completed = 0
           AND challenge_date IN (SELECT challenge_date FROM daily_challenge_attempts WHERE player_id = ? AND completed = 1)`,
      target.id, source.id);
    run(`DELETE FROM daily_challenge_attempts WHERE player_id = ? AND completed = 0
           AND challenge_date IN (SELECT challenge_date FROM daily_challenge_attempts WHERE player_id = ? AND completed = 1)`,
      source.id, target.id);
    run('UPDATE daily_challenge_attempts SET player_id = ? WHERE player_id = ?', target.id, source.id);

    // Tournaments: title columns are plain SET NULL FKs (no uniqueness), and no
    // shared enrollment exists, so these are all straight reassignments.
    run('UPDATE tournaments SET champion_id = ? WHERE champion_id = ?', target.id, source.id);
    run('UPDATE tournaments SET runner_up_id = ? WHERE runner_up_id = ?', target.id, source.id);
    run('UPDATE tournament_players SET player_id = ? WHERE player_id = ?', target.id, source.id);
    run('UPDATE tournament_matches SET player1_id = ? WHERE player1_id = ?', target.id, source.id);
    run('UPDATE tournament_matches SET player2_id = ? WHERE player2_id = ?', target.id, source.id);
    run('UPDATE tournament_matches SET winner_id = ? WHERE winner_id = ?', target.id, source.id);

    // Leagues: enrollment reassigns (no shared league exists), and fixtures keep
    // their canonical player1_id < player2_id invariant (getPendingFixturesForPlayers()
    // relies on it for order-independent lookup) — a reassignment can flip a pair
    // out of order, so re-canonicalize any fixture the swap left inverted. A
    // source-vs-target fixture can't exist here (it would require a shared league).
    run('UPDATE league_players SET player_id = ? WHERE player_id = ?', target.id, source.id);
    run('UPDATE league_fixtures SET player1_id = ? WHERE player1_id = ?', target.id, source.id);
    run('UPDATE league_fixtures SET player2_id = ? WHERE player2_id = ?', target.id, source.id);
    run(`UPDATE league_fixtures SET player1_id = player2_id, player2_id = player1_id WHERE player1_id > player2_id`);

    // Equipment: reassign, but never leave the target with two default loadouts —
    // if the target already has one, the source's default flag is cleared (the
    // target's own settings/preferences always win, same rule as name/PIN/uuid).
    run('UPDATE dart_components SET player_id = ? WHERE player_id = ?', target.id, source.id);
    const targetHasDefault = db.prepare('SELECT 1 FROM loadouts WHERE player_id = ? AND is_default = 1').get(target.id);
    if (targetHasDefault) run('UPDATE loadouts SET is_default = 0 WHERE player_id = ?', source.id);
    run('UPDATE loadouts SET player_id = ? WHERE player_id = ?', target.id, source.id);

    run('UPDATE ghost_races SET player_id = ? WHERE player_id = ?', target.id, source.id);

    // Marathon sessions are player-owned with player_id ON DELETE CASCADE — the
    // one players-FK table with no games link — so without this reassignment the
    // DELETE FROM players below would silently cascade away the source's entire
    // Marathon history (sessions and, via session_id CASCADE, their legs).
    run('UPDATE marathon_sessions SET player_id = ? WHERE player_id = ?', target.id, source.id);

    // Killer configs key number assignments by player id — rewrite the source's
    // key to the target's id in every killer game being absorbed, or the merged
    // history replays with an orphaned assignment (see _rewriteKillerConfigIds).
    // The game_players reassignment already ran above, so the source's killer
    // games are found via target.id; target's own pre-existing killer games are
    // untouched (they never carried the source's id as a key).
    _rewriteKillerConfigIds(target.id, source.id);

    // Identity: repoint any aliases already targeting the source (chained merges),
    // record the source's own uuid as an alias of the target, then delete the
    // source row — a plain DELETE, not deletePlayer(), since every reference has
    // just been reassigned and the deletion guards exist to protect exactly the
    // history that's now the target's.
    run('UPDATE player_uuid_aliases SET player_id = ? WHERE player_id = ?', target.id, source.id);
    if (source.uuid) run('INSERT INTO player_uuid_aliases (uuid, player_id) VALUES (?, ?)', source.uuid, target.id);
    run('DELETE FROM players WHERE id = ?', source.id);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, source: preview.source, target: preview.target, moves: preview.moves, resolutions: preview.resolutions };
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
// Public (no-auth) read of WHETHER each HA webhook event is configured (never the
// webhook IDs themselves, which stay admin-only via getSettings()) — every device
// playing a game calls sendHaWebhook() and needs to know up front whether firing
// one is worth the request (item 57: fireHaWebhook() already no-ops server-side
// per-event when unconfigured, but the client was still building/POSTing the full
// payload — a ~250KB base64 moment-card image, for `momentcard` specifically —
// only for the server to discard it unread).
function getHaWebhookStatus() {
  const cfg = getSettings();
  const haUrl = cfg.ha_url || '';
  const events = ['oneeighty','bigfish','bust','ninedarter','tonplus','momentcard',
                   'gamestart','gameend','setstart','setend','legstart','legend'];
  return { enabled: !!haUrl, events: Object.fromEntries(events.map(e => [e, !!haUrl && !!cfg[`ha_webhook_${e}`]])) };
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
// backup (docs/archive/backups-roadmap.md v2), which is at least as destructive as
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

/* ---------- tournament mode (docs/archive/tournament-mode-roadmap.md, single-elim only) ----------
   Seeding (random shuffle / manual reorder / by lifetime 3-dart average) all happens
   client-side — `players` here is already the final seed order (index 0 = seed 1),
   the same way createGame()'s `players` array order already determines throw order
   with no server-side reordering. */
const TOURNAMENT_X01_CATEGORIES = ['501', '301', '170', '101'];
const TOURNAMENT_MAX_PLAYERS = 128;
// docs/archive/tournament-mode-roadmap.md §2: double-elimination is restricted to exact
// powers of two for v1 (no cascading byes in the losers bracket).
const TOURNAMENT_DOUBLE_ELIM_COUNTS = [4, 8, 16, 32, 64, 128];
// docs/archive/tournament-mode-roadmap.md §7: how many seed slots worse the winner must be
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
// docs/archive/tournament-mode-roadmap.md §7: Giant Slayer (Tournament) — awarded per
// match whenever the winner was seeded at least TOURNAMENT_GIANT_SLAYER_SEED_THRESHOLD
// slots WORSE than the opponent they just beat. Called from every real (non-bye)
// match result, single- or double-elimination alike, so a winners-bracket upset
// still counts even though that loser only drops to the losers bracket rather than
// being eliminated outright.
function _maybeAwardTournamentGiantSlayer(tournamentId, winnerId, loserId) {
  if (loserId == null) return;
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

// Settles the whole tournament on its deciding match: champion, runner-up, status,
// and the Champion badge (docs/archive/tournament-mode-roadmap.md §7), all in one place.
function _completeTournament(tournamentId, championId, runnerUpId) {
  db.prepare(`UPDATE tournaments SET status = 'completed', champion_id = ?, runner_up_id = ?, completed_at = datetime('now') WHERE id = ?`)
    .run(championId, runnerUpId, tournamentId);
  db.prepare(`UPDATE tournament_players SET status = 'champion' WHERE tournament_id = ? AND player_id = ?`)
    .run(tournamentId, championId);
  const championName = db.prepare('SELECT name FROM players WHERE id = ?').get(championId)?.name;
  if (championName) awardBadge(championName, 'tournament_champion', true);
}

// The grand final's conditional "bracket reset" (docs/archive/tournament-mode-roadmap.md §2).
// By construction GF game 1's slot 1 is the winners-bracket champion and slot 2 is
// the losers-bracket champion (they arrive from the WB/LB finals' winner_next
// pointers). If the WB champion wins game 1, they have zero losses and the tournament
// ends. If the LB champion (slot 2) wins game 1, BOTH players now hold exactly one
// loss, so a single decider game (the pre-created reset match) is played — this just
// populates that reset match's two slots and stops, without eliminating anyone or
// completing the tournament. The reset match itself, once decided, always ends the
// tournament.
function _resolveGrandFinal(match, winnerId, loserId, tournamentId) {
  const gfRounds = db.prepare(
    `SELECT id, round_no FROM tournament_rounds WHERE tournament_id = ? AND bracket = 'grand_final' ORDER BY round_no`
  ).all(tournamentId);
  const resetRoundId = gfRounds.length > 1 ? gfRounds[gfRounds.length - 1].id : null;
  const isResetMatch = resetRoundId != null && match.round_id === resetRoundId;

  if (!isResetMatch && resetRoundId != null && winnerId === match.player2_id) {
    // LB champion took game 1 — force the decider. Seed the reset match with the same
    // two finalists (WB champ still in slot 1, LB champ in slot 2) and stop here.
    const resetMatch = db.prepare('SELECT id FROM tournament_matches WHERE round_id = ? ORDER BY slot LIMIT 1').get(resetRoundId);
    if (resetMatch) {
      db.prepare('UPDATE tournament_matches SET player1_id = ?, player2_id = ? WHERE id = ?')
        .run(match.player1_id, match.player2_id, resetMatch.id);
    }
    return;
  }
  // Decisive: WB champ won game 1, or the reset game just finished. Whoever won is champion.
  db.prepare(`UPDATE tournament_players SET status = 'eliminated' WHERE tournament_id = ? AND player_id = ?`)
    .run(tournamentId, loserId);
  _maybeAwardTournamentGiantSlayer(tournamentId, winnerId, loserId);
  _completeTournament(tournamentId, winnerId, loserId);
}

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
  const round = db.prepare('SELECT tournament_id, bracket FROM tournament_rounds WHERE id = ?').get(match.round_id);
  const tournamentId = round.tournament_id;

  // The grand final (and its optional reset) has its own settle logic — a plain
  // "no winner_next => complete" rule can't express the conditional decider.
  if (round.bracket === 'grand_final') {
    return _resolveGrandFinal(match, winnerId, loserId, tournamentId);
  }

  if (loserId != null) {
    if (match.loser_next_match_id) {
      // Double-elimination: a winners-bracket loss drops the loser into the losers
      // bracket rather than eliminating them. (Losers-bracket matches leave
      // loser_next_match_id NULL, so a second loss there falls through to elimination.)
      const col = match.loser_next_slot === 1 ? 'player1_id' : 'player2_id';
      db.prepare(`UPDATE tournament_matches SET ${col} = ? WHERE id = ?`).run(loserId, match.loser_next_match_id);
    } else {
      db.prepare(`UPDATE tournament_players SET status = 'eliminated' WHERE tournament_id = ? AND player_id = ?`)
        .run(tournamentId, loserId);
    }
    // Awarded per match (see the helper) — never for a bye (loserId is null).
    _maybeAwardTournamentGiantSlayer(tournamentId, winnerId, loserId);
  }

  if (match.winner_next_match_id) {
    const col = match.winner_next_slot === 1 ? 'player1_id' : 'player2_id';
    db.prepare(`UPDATE tournament_matches SET ${col} = ? WHERE id = ?`).run(winnerId, match.winner_next_match_id);
  } else {
    // No next match and not a grand final — this is a single-elimination final, so
    // the whole tournament is decided. (Every double-elimination match except the
    // grand final has a winner_next pointer, so this branch is single-elim only.)
    _completeTournament(tournamentId, winnerId, loserId);
  }
}

// players: ordered array of names, index 0 = seed 1. rounds: [{legsPerSet,
// setsPerGame}, ...], earliest round first — must have exactly as many entries as
// the bracket has rounds (single-elim: ceil(log2(next power of two >= player
// count)); double-elim: doubleElimStructure(k).length). bracketType:
// 'single_elim' (default) | 'double_elim'.
function createTournament({ name, category, players, rounds, bracketType }) {
  name = String(name || '').trim();
  if (!name) throw httpError(400, 'Tournament name is required');
  if (name.length > 64) throw httpError(400, 'Tournament name must be 64 characters or fewer');
  if (!TOURNAMENT_X01_CATEGORIES.includes(String(category))) throw httpError(400, 'category must be one of 501, 301, 170, or 101');
  if (!Array.isArray(players) || players.length < 2) throw httpError(400, 'A tournament needs at least 2 players');
  if (players.length > TOURNAMENT_MAX_PLAYERS) throw httpError(400, `A tournament supports at most ${TOURNAMENT_MAX_PLAYERS} players`);
  const uniqueNames = new Set(players.map(n => String(n).trim().toLowerCase()));
  if (uniqueNames.size !== players.length) throw httpError(400, 'Duplicate players are not allowed');

  const bracketTypeClean = bracketType === 'double_elim' ? 'double_elim' : 'single_elim';
  // docs/archive/tournament-mode-roadmap.md §2: double-elimination is v1-restricted to exact
  // powers of two (4/8/16/32/64/128), the deliberate de-risking that keeps the losers
  // bracket free of the cascading-bye problem entirely — single-elim still handles
  // arbitrary counts, since its bye propagation is simple.
  if (bracketTypeClean === 'double_elim' && !TOURNAMENT_DOUBLE_ELIM_COUNTS.includes(players.length)) {
    throw httpError(400, `Double-elimination requires exactly ${TOURNAMENT_DOUBLE_ELIM_COUNTS.join(', ')} players`);
  }

  const bracketSize = _nextPowerOfTwo(players.length);
  const k = Math.log2(bracketSize);
  const plan = bracketTypeClean === 'double_elim' ? doubleElimStructure(k) : null;
  const expectedRoundCount = plan ? plan.length : k;
  if (!Array.isArray(rounds) || rounds.length !== expectedRoundCount) {
    throw httpError(400, `rounds must have exactly ${expectedRoundCount} entries for a ${bracketTypeClean === 'double_elim' ? 'double' : 'single'}-elimination bracket of ${players.length} players`);
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
    'INSERT INTO tournaments (name, category, bracket_type, player_count) VALUES (?, ?, ?, ?)'
  ).run(name, String(category), bracketTypeClean, playerRows.length).lastInsertRowid);

  playerRows.forEach((p, i) => {
    db.prepare('INSERT INTO tournament_players (tournament_id, player_id, seed) VALUES (?, ?, ?)')
      .run(tournamentId, p.id, i + 1);
  });

  const seedToPlayerId = {};
  playerRows.forEach((p, i) => { seedToPlayerId[i + 1] = p.id; });

  if (bracketTypeClean === 'double_elim') {
    _generateDoubleElimBracket(tournamentId, k, cleanRounds, plan, seedToPlayerId);
  } else {
    _generateSingleElimBracket(tournamentId, bracketSize, k, cleanRounds, seedToPlayerId);
  }

  return { tournamentId };
}

// Single-elimination generation (extracted unchanged from the original
// createTournament so double-elim could branch alongside it): one round per
// halving, standard seeding placement, cascading byes.
function _generateSingleElimBracket(tournamentId, bracketSize, roundCount, cleanRounds, seedToPlayerId) {
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
}

// Double-elimination generation (docs/archive/tournament-mode-roadmap.md §2). k = log2 of
// the exact player count (guaranteed a power of two here, so zero byes). Creates
// every round and match up-front, then wires the winner_next / loser_next pointer
// pairs the schema was designed for. Match layout per round comes from
// doubleElimStructure(k) (the shared plan). All rows are created first, so pointers
// are set by a second UPDATE pass — no last-to-first ordering dance needed.
function _generateDoubleElimBracket(tournamentId, k, cleanRounds, plan, seedToPlayerId) {
  const N = Math.pow(2, k);
  const roundIds = plan.map((r, i) => Number(db.prepare(
    'INSERT INTO tournament_rounds (tournament_id, bracket, round_no, label, legs_per_set, sets_per_game) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(tournamentId, r.bracket, i + 1, r.label, cleanRounds[i].legsPerSet, cleanRounds[i].setsPerGame).lastInsertRowid));

  // Create every match, grouped by plan-round index; matchIds[i] = array of match ids.
  const matchIds = plan.map((r, i) => Array.from({ length: r.matches }, (_, s) => Number(db.prepare(
    'INSERT INTO tournament_matches (round_id, slot) VALUES (?, ?)'
  ).run(roundIds[i], s + 1).lastInsertRowid)));

  // Convenience accessors into matchIds by bracket-relative round number.
  const WB = (i) => matchIds[i - 1];              // winners round i (1..k)
  const LB = (j) => matchIds[k + j - 1];          // losers round j (1..2k-2)
  const lbRounds = 2 * k - 2;
  const GF1 = matchIds[k + lbRounds][0];          // grand final game 1
  const GF2 = matchIds[k + lbRounds + 1][0];      // grand final reset (decider)
  const setWinnerNext = (id, nextId, slot) =>
    db.prepare('UPDATE tournament_matches SET winner_next_match_id = ?, winner_next_slot = ? WHERE id = ?').run(nextId, slot, id);
  const setLoserNext = (id, nextId, slot) =>
    db.prepare('UPDATE tournament_matches SET loser_next_match_id = ?, loser_next_slot = ? WHERE id = ?').run(nextId, slot, id);

  // Winners-bracket winner advancement (standard single-elim shape), the WB final
  // winner going on to grand-final slot 1.
  for (let i = 1; i <= k; i++) {
    WB(i).forEach((mid, s) => {
      if (i < k) setWinnerNext(mid, WB(i + 1)[Math.floor(s / 2)], (s % 2) + 1);
      else setWinnerNext(mid, GF1, 1);
    });
  }
  // Winners-bracket loser drops. WB round 1 losers pair up into losers round 1; each
  // later WB round i (>=2) drops its losers into losers round 2(i-1)'s slot 2.
  for (let i = 1; i <= k; i++) {
    WB(i).forEach((mid, s) => {
      if (i === 1) setLoserNext(mid, LB(1)[Math.floor(s / 2)], (s % 2) + 1);
      else setLoserNext(mid, LB(2 * (i - 1))[s], 2);
    });
  }
  // Losers-bracket winner advancement. Minor rounds (odd j) feed the next drop round
  // 1:1 into slot 1; drop rounds (even j) pair their winners into the next minor
  // round; the losers final (j = 2k-2) sends its winner to grand-final slot 2.
  for (let j = 1; j <= lbRounds; j++) {
    LB(j).forEach((mid, s) => {
      if (j === lbRounds) setWinnerNext(mid, GF1, 2);
      else if (j % 2 === 1) setWinnerNext(mid, LB(j + 1)[s], 1);
      else setWinnerNext(mid, LB(j + 1)[Math.floor(s / 2)], (s % 2) + 1);
    });
  }

  // Seed winners round 1 (no byes — exact power of two).
  const seedSlots = _bracketSeedOrder(N);
  WB(1).forEach((mid, s) => {
    const playerA = seedToPlayerId[seedSlots[s * 2]] ?? null;
    const playerB = seedToPlayerId[seedSlots[s * 2 + 1]] ?? null;
    db.prepare('UPDATE tournament_matches SET player1_id = ?, player2_id = ? WHERE id = ?').run(playerA, playerB, mid);
  });
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
           r.round_no, r.label, r.bracket, r.legs_per_set AS legsPerSet, r.sets_per_game AS setsPerGame,
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

// docs/archive/tournament-mode-roadmap.md §8: Player Profile "Tournaments" stat block —
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
  // round N+1 placement only ever happens after winning round N — and because a
  // double-elimination tournament numbers its rounds globally in play order
  // (winners, then losers, then the grand final), this stays true across both
  // bracket types. The reported LABEL is read from that furthest round itself
  // (`tournament_rounds.label`), not recomputed, so a double-elim "Losers Final"
  // or "Grand Final" reads correctly rather than being mislabeled by the
  // single-elim `_roundLabel()` naming.
  const rows = db.prepare(`
    SELECT tr.tournament_id AS tid, MAX(tr.round_no) AS maxRoundNo,
           (SELECT COUNT(*) FROM tournament_rounds WHERE tournament_id = tr.tournament_id) AS totalRounds
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.id = tm.round_id
    WHERE tm.player1_id = ? OR tm.player2_id = ?
    GROUP BY tr.tournament_id
  `).all(p.id, p.id);
  let bestRoundsFromFinal = Infinity, bestTid = null, bestRoundNo = null;
  for (const r of rows) {
    const roundsFromFinal = r.totalRounds - r.maxRoundNo;
    if (roundsFromFinal < bestRoundsFromFinal) {
      bestRoundsFromFinal = roundsFromFinal;
      bestTid = r.tid;
      bestRoundNo = r.maxRoundNo;
    }
  }
  const bestFinish = bestTid != null
    ? (db.prepare('SELECT label FROM tournament_rounds WHERE tournament_id = ? AND round_no = ?').get(bestTid, bestRoundNo)?.label ?? null)
    : null;
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

// docs/archive/saved-games-roadmap.md "Interactions with existing features": block
// deleting a player who's in a currently-saved game — resuming it would try to
// rebuild a match that includes a player who no longer exists. Cheaper and
// louder than an auto-abandon side effect buried inside a delete; the admin
// abandons the saved game first (its recorded stats are kept either way).
registerDeletePlayerGuard((player) => {
  const row = db.prepare(`
    SELECT g.category AS category FROM saved_games sg
    JOIN games g ON g.id = sg.game_id
    WHERE EXISTS (SELECT 1 FROM game_players WHERE game_id = g.id AND player_id = ?)
  `).get(player.id);
  return row ? `${player.name} is in a saved ${row.category} game — abandon it (or resume and finish it) before deleting.` : null;
});

/* ---------- league mode (docs/archive/league-mode-roadmap.md, X01 or Cricket) ----------
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
// than an X01 league fixes legs/sets — see docs/archive/league-mode-roadmap.md).
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
  _generateRoundRobinFixtures(leagueId, playerRows.map(p => p.id), []);
  return { leagueId };
}

// Single round-robin fixture generation (docs/archive/league-mode-roadmap.md "League
// fixtures / pending matches" — resolved: single, not double, round-robin for v1).
// Creates exactly one league_fixtures row per unique pair drawn from newPlayerIds
// paired against existingPlayerIds AND against each other (never a pair drawn
// only from existingPlayerIds — those already got their fixture the first time
// around). Called with the whole initial roster as newPlayerIds/[] existing at
// league creation, and with just the one new id/the rest of the roster as
// existing whenever a player joins an already-active league (enrollLeaguePlayer())
// — so an existing pair's fixture (pending, in progress, or fulfilled) is never
// touched or duplicated. player1_id/player2_id are stored in canonical (lower id
// first) order so a lookup never has to try both orderings.
function _generateRoundRobinFixtures(leagueId, newPlayerIds, existingPlayerIds) {
  const insert = db.prepare('INSERT INTO league_fixtures (league_id, player1_id, player2_id) VALUES (?, ?, ?)');
  newPlayerIds.forEach((a, i) => {
    const opponents = [...existingPlayerIds, ...newPlayerIds.slice(i + 1)];
    opponents.forEach(b => {
      const [player1Id, player2Id] = a < b ? [a, b] : [b, a];
      insert.run(leagueId, player1Id, player2Id);
    });
  });
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

// Fixture status is derived, never stored — same "compute from raw data"
// precedent as tournament_matches' status in getTournament(): pending while
// game_id IS NULL, in_progress once linked but the game isn't complete yet,
// fulfilled once it is.
function getLeagueFixtures(leagueId) {
  return db.prepare(`
    SELECT f.id, p1.name AS player1Name, p2.name AS player2Name, f.game_id AS gameId,
           g.completed_at AS gameCompletedAt, f.created_at AS createdAt
    FROM league_fixtures f
    JOIN players p1 ON p1.id = f.player1_id
    JOIN players p2 ON p2.id = f.player2_id
    LEFT JOIN games g ON g.id = f.game_id
    WHERE f.league_id = ?
    ORDER BY (CASE WHEN f.game_id IS NULL THEN 0 WHEN g.completed_at IS NULL THEN 1 ELSE 2 END),
      p1.name COLLATE NOCASE, p2.name COLLATE NOCASE
  `).all(Number(leagueId)).map(f => ({
    id: f.id, player1Name: f.player1Name, player2Name: f.player2Name, gameId: f.gameId,
    status: f.gameId == null ? 'pending' : (f.gameCompletedAt == null ? 'in_progress' : 'fulfilled'),
    createdAt: f.createdAt,
  }));
}

// Public read the New Game screen calls right after Step 1 (opponent pair picked) —
// see docs/archive/league-mode-roadmap.md's "New endpoint" section. Unlike getEligibleLeagues()
// (which needs gameType/category, since it only ever runs after those are already
// chosen), this needs neither: a fixture already carries them via its own league.
// Order-independent on the pair, mirroring _findEligibleLeagues(); fails soft to []
// for an unresolvable name, same defensive posture as getEligibleLeagues().
function getPendingFixturesForPlayers(playerName1, playerName2) {
  const p1 = getPlayer(playerName1), p2 = getPlayer(playerName2);
  if (!p1 || !p2) return [];
  const [a, b] = p1.id < p2.id ? [p1.id, p2.id] : [p2.id, p1.id];
  return db.prepare(`
    SELECT f.id AS fixtureId, l.id AS leagueId, l.name AS leagueName,
           l.game_type AS gameType, l.category
    FROM league_fixtures f JOIN leagues l ON l.id = f.league_id
    WHERE f.player1_id = ? AND f.player2_id = ? AND f.game_id IS NULL
      AND l.status = 'active' AND date('now') >= l.starts_at AND (l.ends_at IS NULL OR date('now') <= l.ends_at)
    ORDER BY l.created_at DESC
  `).all(a, b);
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
    fixtures: getLeagueFixtures(league.id),
  };
}

function enrollLeaguePlayer(leagueId, playerName) {
  const league = _getLeagueOrThrow(leagueId);
  const p = ensurePlayer(playerName);
  const existingIds = db.prepare('SELECT player_id FROM league_players WHERE league_id = ?').all(league.id).map(r => r.player_id);
  const info = db.prepare('INSERT OR IGNORE INTO league_players (league_id, player_id) VALUES (?, ?)').run(league.id, p.id);
  // Only generate fixtures for a genuinely NEW enrollment — re-enrolling an already-
  // enrolled player (INSERT OR IGNORE no-ops) must never duplicate their existing pairs.
  if (info.changes > 0) {
    _generateRoundRobinFixtures(league.id, [p.id], existingIds);
  }
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
// league. See docs/archive/league-mode-roadmap.md and the game-lifecycle-hooks doc comment
// above for the full payload shape and the "explicit choice is re-validated, not
// trusted" reasoning. Fires synchronously inside createGame(), before its HTTP
// response is sent — there's no race between this write and the client seeing the
// new gameId.
onGameCreated(({ gameType, practice, category, playerCount, playerIds, leagueId, gameId }) => {
  // League mode is X01 or Cricket, non-practice, exactly 2 players (Doubles
  // Practice/Chuckin/Checkout Trainer are structurally excluded regardless, being
  // solo/no-winner formats — see docs/archive/league-mode-roadmap.md).
  if ((gameType !== 'x01' && gameType !== 'cricket') || practice || playerCount !== 2 || !Array.isArray(playerIds) || playerIds.length !== 2) return;
  // A fixture-originated game (docs/archive/league-mode-roadmap.md "League fixtures / pending
  // matches") already had games.league_id set DIRECTLY by createGame(), before this
  // hook fired — that's an explicit, already-resolved choice, so re-running the fuzzy
  // eligibility match here would be redundant at best and could pick a DIFFERENT
  // league at worst if the pair happens to share more than one active league.
  if (db.prepare('SELECT league_id FROM games WHERE id = ?').get(gameId).league_id != null) return;
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

/* =========================================================================
   MARATHON MODE (docs/archive/marathon-mode-roadmap.md)
   Not a new game_type — every leg is a completely ordinary solo practice 501
   X01 game, chained together only via marathon_session_legs.game_id (the
   league_fixtures-style "context table with a game_id FK" pattern, per
   CLAUDE.md). The 45-minute wall-clock check happens in the FRONTEND, at leg
   boundaries only — these functions just create/link/end sessions and legs;
   none of them know or care what time it is.
   ========================================================================= */
function _createMarathonLegGame(playerName) {
  // Deliberately bypasses the New Game setup screen's own config — every leg
  // is always a straight solo practice 501, no exceptions, so this calls
  // createGame() directly rather than routing through any client-supplied
  // shape. Never accepts a client-supplied game_id anywhere in this feature —
  // see marathon_session_legs' own schema comment for why that means the
  // roadmap doc's "validate a linked game_id belongs to this player" worry
  // never actually applies here.
  return createGame({
    category: '501', legsPerSet: 1, setsPerGame: 1, practice: 1,
    gameType: 'x01', config: { startingScore: 501 },
    players: [{ name: playerName }],
  }).gameId;
}
function _getMarathonSession(sessionId) {
  const s = db.prepare('SELECT * FROM marathon_sessions WHERE id = ?').get(Number(sessionId));
  if (!s) throw httpError(404, 'Marathon session not found');
  return s;
}
function startMarathonSession(playerName, durationMinutes) {
  const p = getPlayer(playerName);
  if (!p) throw httpError(404, 'Player not found');
  const duration = durationMinutes != null ? Number(durationMinutes) : 45;
  if (!Number.isInteger(duration) || duration < 5 || duration > 240) {
    throw httpError(400, 'durationMinutes must be an integer between 5 and 240');
  }
  const info = db.prepare('INSERT INTO marathon_sessions (player_id, duration_minutes) VALUES (?, ?)').run(p.id, duration);
  const sessionId = Number(info.lastInsertRowid);
  const gameId = _createMarathonLegGame(playerName);
  db.prepare('INSERT INTO marathon_session_legs (session_id, game_id, leg_order) VALUES (?, ?, 1)').run(sessionId, gameId);
  const row = db.prepare('SELECT started_at FROM marathon_sessions WHERE id = ?').get(sessionId);
  return { sessionId, gameId, legOrder: 1, startedAt: row.started_at, durationMinutes: duration };
}
// Called once the CURRENT leg's own game has already completed (normal X01
// win) — creates the NEXT leg's game and links it. Rejects once the session
// has ended (`ended_at` already set) — the roadmap doc's own flagged linkage
// guard — and rejects a player mismatch, since a session belongs to exactly
// one player throughout.
function startNextMarathonLeg(sessionId, playerName) {
  const s = _getMarathonSession(sessionId);
  if (s.ended_at != null) throw httpError(409, 'This marathon session has already ended');
  const p = getPlayer(playerName);
  if (!p || p.id !== s.player_id) throw httpError(403, 'Player does not match this marathon session');
  const maxLeg = db.prepare('SELECT MAX(leg_order) AS n FROM marathon_session_legs WHERE session_id = ?').get(s.id).n || 0;
  const gameId = _createMarathonLegGame(playerName);
  const legOrder = maxLeg + 1;
  db.prepare('INSERT INTO marathon_session_legs (session_id, game_id, leg_order) VALUES (?, ?, ?)').run(s.id, gameId, legOrder);
  return { gameId, legOrder };
}
// Idempotent — ending an already-ended session just returns its existing
// (unchanged) detail rather than erroring, so a client retry after a dropped
// response can't double-process anything.
function endMarathonSession(sessionId) {
  const s = _getMarathonSession(sessionId);
  if (s.ended_at == null) {
    db.prepare("UPDATE marathon_sessions SET ended_at = datetime('now') WHERE id = ?").run(s.id);
  }
  return getMarathonSessionDetail(s.id);
}
// Full session detail, including the two analysis functions (frontend/scoring.js)
// run over this session's own completed legs' dart counts. A leg still
// in-progress (no completed_at on its game) is listed but excluded from the
// dart-count series the analysis reads — an unfinished leg has no final dart
// count to compare against the others yet.
function getMarathonSessionDetail(sessionId) {
  const s = _getMarathonSession(sessionId);
  const player = db.prepare('SELECT name FROM players WHERE id = ?').get(s.player_id);
  const legs = db.prepare(`
    SELECT msl.leg_order AS legOrder, msl.game_id AS gameId, g.completed_at AS completedAt,
      (SELECT COUNT(*) FROM darts d JOIN turns t ON t.id = d.turn_id WHERE t.game_id = msl.game_id) AS dartCount,
      (SELECT t.checkout_points FROM turns t WHERE t.game_id = msl.game_id AND t.checkout = 1 LIMIT 1) AS checkoutPoints,
      (SELECT COUNT(*) FROM turns t WHERE t.game_id = msl.game_id AND t.bust = 1) AS busts
    FROM marathon_session_legs msl JOIN games g ON g.id = msl.game_id
    WHERE msl.session_id = ?
    ORDER BY msl.leg_order ASC
  `).all(s.id);
  const completedLegs = legs.filter(l => l.completedAt != null);
  const dartCounts = completedLegs.map(l => l.dartCount);
  const fatigue = computeFatigueSplit(dartCounts);
  const trend = classifyMarathonTrend(dartCounts);
  return {
    sessionId: s.id, player: player.name, durationMinutes: s.duration_minutes,
    startedAt: s.started_at, endedAt: s.ended_at,
    legs, legsCompleted: completedLegs.length,
    fatigueSplit: fatigue.split, fatigueTier: fatigue.tier, trend,
  };
}

// Every Marathon leg's underlying game is always practice=1 — an 'h2h' mode
// request reaches the same "zero sessions" answer a SQL-side _scope() join
// would, just without the extra join, since there is never an H2H marathon
// session to find.
function getMarathonStatBubbles(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const empty = { sessionsCompleted: 0, avgLegsPerSession: null, avgFatigueSplit: null,
    trendBreakdown: { cliff: 0, warmMachine: 0, flatLine: 0, inconclusive: 0 },
    cliffSessions: 0, warmMachineSessions: 0, flatLineSessions: 0 };
  if (mode === 'h2h') return empty;
  const sessions = db.prepare('SELECT id FROM marathon_sessions WHERE player_id = ? AND ended_at IS NOT NULL').all(p.id);
  if (!sessions.length) return empty;
  let totalLegs = 0, totalSplit = 0, splitSessions = 0;
  const trendBreakdown = { cliff: 0, warmMachine: 0, flatLine: 0, inconclusive: 0 };
  sessions.forEach(row => {
    const d = getMarathonSessionDetail(row.id);
    totalLegs += d.legsCompleted;
    // fatigueSplit is null for a 0-1-leg session ("no second half to compare
    // against" — computeFatigueSplit's own contract), so only measured
    // sessions enter the average.
    if (d.fatigueSplit != null) { totalSplit += d.fatigueSplit; splitSessions++; }
    if (d.trend === 'The Cliff') trendBreakdown.cliff++;
    else if (d.trend === 'The Warm Machine') trendBreakdown.warmMachine++;
    else if (d.trend === 'Flat Line') trendBreakdown.flatLine++;
    else trendBreakdown.inconclusive++;
  });
  return {
    sessionsCompleted: sessions.length,
    avgLegsPerSession: +(totalLegs / sessions.length).toFixed(1),
    avgFatigueSplit: splitSessions ? +(totalSplit / splitSessions).toFixed(1) : null,
    trendBreakdown,
    // Lifetime total (not the average above) -- feeds the "lifetime legs
    // completed inside Marathon sessions" milestone ladder, which needs an
    // exact running total, not a derived-from-average approximation.
    totalLegsCompleted: totalLegs,
    // Flat convenience fields for the Player Profile's own flat stat-bubble
    // lookup (renderStatBubbles() reads data[bubbleKeyMap[key]], no nested-path
    // support) — same values as trendBreakdown above, just unnested.
    cliffSessions: trendBreakdown.cliff, warmMachineSessions: trendBreakdown.warmMachine, flatLineSessions: trendBreakdown.flatLine,
  };
}
// Personal Bests: lowest fatigue split ever (ascending-is-better, the same
// polarity The Gauntlet's Scar count uses) and most legs completed in a
// single session (a stamina/throughput metric). A session with zero
// completed legs (ended immediately) contributes to neither.
function getMarathonPersonalBests(playerName, mode) {
  const p = getPlayer(playerName);
  if (!p) return null;
  const empty = { lowestFatigueSplit: null, mostLegsInASession: null };
  if (mode === 'h2h') return empty;
  const sessions = db.prepare('SELECT id FROM marathon_sessions WHERE player_id = ? AND ended_at IS NOT NULL').all(p.id);
  if (!sessions.length) return empty;
  let lowestSplit = null, mostLegs = null;
  sessions.forEach(row => {
    const d = getMarathonSessionDetail(row.id);
    if (d.legsCompleted === 0) return;
    // fatigueSplit is null for a 1-leg session (unmeasurable, per
    // computeFatigueSplit's own contract) — without the null check, a one-leg
    // quit would record the mathematically unbeatable minimum and pin this PB
    // (and top the ascending-sorted fatigue leaderboard) forever.
    if (d.fatigueSplit != null && (lowestSplit == null || d.fatigueSplit < lowestSplit)) lowestSplit = d.fatigueSplit;
    if (mostLegs == null || d.legsCompleted > mostLegs) mostLegs = d.legsCompleted;
  });
  return { lowestFatigueSplit: lowestSplit, mostLegsInASession: mostLegs };
}
// Home leaderboard: one row per player, their own single best (lowest)
// fatigue split ever — same peak-value, no-minimum-floor shape every other
// single-best-run board in this app already uses, sorted ascending (lower is
// better) like The Gauntlet's own leaderboard.
function getMarathonLeaderboard() {
  const players = db.prepare(`
    SELECT DISTINCT p.id, p.name FROM marathon_sessions ms JOIN players p ON p.id = ms.player_id
    WHERE ms.ended_at IS NOT NULL
  `).all();
  return players.map(p => {
    const pb = getMarathonPersonalBests(p.name, null);
    return { name: p.name, lowestFatigueSplit: pb.lowestFatigueSplit, mostLegsInASession: pb.mostLegsInASession };
  }).filter(r => r.lowestFatigueSplit != null)
    .sort((a, b) => a.lowestFatigueSplit - b.lowestFatigueSplit);
}

/* ---------- helpers ---------- */
function httpError(status, message) {
  const e = new Error(message); e.status = status; return e;
}

// Self-heal on boot: older versions of deletePlayer() left a `games` row
// behind once every one of its participants had been deleted. Clean up any
// that are already sitting in the database.
pruneOrphanedGames();

// One-time boot migration (item 43, docs/code-quality-roadmap.md): killer
// configs used to be keyed by player NAME, which needed three separate
// compensating mechanisms to stay in sync with reality — a rewrite on
// rename, a rewrite on merge, and a boot self-heal for any config a pre-fix
// rename/merge had already orphaned. This migrates every such config to be
// keyed by the immutable players.id instead: first heals any still-orphaned
// key (the same unambiguous one-orphan/one-unclaimed heuristic the old
// reconciler used — anything more ambiguous than that is left alone, same as
// before), then translates every (now name-consistent) key to that
// participant's id. After this has run once, config.numbers is id-keyed
// everywhere and a plain rename can never orphan it again — only
// mergePlayers()/importPlayerExport() still rewrite a key going forward, and
// only because THEY intentionally change which id owns a participation,
// never because a name silently drifted underneath an unrelated key.
function migrateKillerConfigsToIdKeys() {
  // Fast exit for killer-free databases (including every test scratch DB this
  // module is required into): the work below is one-time-by-construction and
  // a no-op on every later boot (keys are already id-shaped strings) anyway,
  // but this skips even that re-check entirely.
  if (!db.prepare(`SELECT EXISTS(SELECT 1 FROM games WHERE game_type = 'killer') AS n`).get().n) return;
  const games = db.prepare(`SELECT id, config FROM games WHERE game_type = 'killer' AND config IS NOT NULL`).all();
  const upd = db.prepare('UPDATE games SET config = ? WHERE id = ?');
  for (const g of games) {
    const cfg = _parseKillerConfig(g.config);
    if (!cfg) continue;
    const keys = Object.keys(cfg.numbers);
    if (keys.length && keys.every(k => /^\d+$/.test(k))) continue; // already migrated
    const participants = db.prepare(`
      SELECT p.id, p.name FROM game_players gp JOIN players p ON p.id = gp.player_id
      WHERE gp.game_id = ?`).all(g.id);
    const names = participants.map(p => p.name);
    const orphanKeys = keys.filter(k => !names.includes(k));
    const unclaimed = names.filter(n => !keys.includes(n));
    if (orphanKeys.length === 1 && unclaimed.length === 1) _moveKillerNumberKey(cfg, orphanKeys[0], unclaimed[0]);
    const byName = new Map(participants.map(p => [p.name, p.id]));
    const migrated = {};
    for (const [key, num] of Object.entries(cfg.numbers)) {
      // An unresolvable key (still ambiguous after the heal above) is carried
      // over unchanged rather than dropped — same "don't guess, don't lose
      // data" stance the old reconciler took.
      migrated[byName.has(key) ? byName.get(key) : key] = num;
    }
    cfg.numbers = migrated;
    upd.run(JSON.stringify(cfg), g.id);
  }
}
migrateKillerConfigsToIdKeys();

module.exports = {
  listPlayers, addPlayer, renamePlayer, setOut, setDartWeight, deletePlayer, registerDeletePlayerGuard,
  createGame, addTurn, recordTurn, completeGame, recordEvent,
  onGameCreated, onGameCompleted,
  logServerError, getServerErrors,
  computeStats, getSummary, getHomeExtra, getSessionRecap, getOneEightyStats, getBigFishStats, getNineDarterStats,
  getPlayerStatBubbles, getMetricHistory, getPersonalBests, getH2HRecord,
  getStatBubblesFor, getPersonalBestsFor, getPersonalBestsBatch, KNOWN_GAME_TYPES, SAVABLE_GAME_TYPES,
  startMarathonSession, startNextMarathonLeg, endMarathonSession, getMarathonSessionDetail,
  getMarathonStatBubbles, getMarathonPersonalBests, getMarathonLeaderboard,
  getGhostCandidateLegs, getGhostCandidateLegsCount, getGhostLegScript,
  getCricketStatBubbles, getCricketNineMarksStats, getCricketPersonalBests,
  getBaseballStatBubbles, getBaseballPersonalBests,
  getBaseballPerfectInningsStats, getBaseballRpiLeaderboard, getBaseballWinLeaderboard, getBaseballPerfectGameStats,
  getShanghaiStatBubbles, getShanghaiPersonalBests, getShanghaiShanghaisStats, getShanghaiWinLeaderboard, getShanghaiPprLeaderboard,
  getHalveItStatBubbles, getHalveItPersonalBests, getHalveItBestTotalLeaderboard, getHalveItWinLeaderboard,
  getWeakestCheckouts,
  getDeadManWalkingStatBubbles, getDeadManWalkingPersonalBests, getDeadManWalkingLeaderboard, getDeadManWalkingLongestStreak,
  getPressureChamberStatBubbles, getPressureChamberPersonalBests, getPressureChamberBestCpLeaderboard, getPressureChamberWinLeaderboard,
  getCricketMprLeaderboard, getCricketWinLeaderboard, getCricketPerfectLegStats,
  getDoublesPracticeStatBubbles, getDoublesPracticePersonalBests,
  getDoublesPracticeAccuracyLeaderboard, getDoublesPracticeBestRoundStats, getDoublesPracticeHitSectors,
  getChuckinStatBubbles, getChuckinPersonalBests, getChuckinHeatmap, getDartHeatmap, getBounceOutCount,
  getCheckoutTrainerStatBubbles, getCheckoutTrainerPersonalBests,
  getCheckoutBlitzLeaderboard, getCheckoutBlitzPersonalStats,
  getBobs27StatBubbles, getBobs27PersonalBests, getBobs27Leaderboard,
  getEloRatings, getEloLeaderboard, getPlayerElo,
  getCheckoutLadderStatBubbles, getCheckoutLadderPersonalBests, getCheckoutLadderLeaderboard,
  getGauntletStatBubbles, getGauntletPersonalBests, getGauntletLeaderboard, getGauntletScarMap,
  getKillerStatBubbles, getKillerPersonalBests, getKillerWinLeaderboard,
  getAroundTheClockStatBubbles, getAroundTheClockPersonalBests,
  getAroundTheClockFastestLeaderboard, getAroundTheClockCompletionsLeaderboard,
  getAroundTheWorldDrillStatBubbles, getAroundTheWorldPersonalBests, getAroundTheWorldLeaderboard,
  getTopFinishes, getTopFinishesAll, getDartWeights, clearPlayerStats, resetStats, wipeAllData, deleteLastTurn, getFullDatabaseExport, getPlayerExport, getPlayerCsvExport, importPlayerExport, getMergePreview, mergePlayers,
  getOnThisDay,
  getCheckoutRoutes, getDartAnalytics, getCoachingInsights,
  getSettings, updateSettings, getDartTimingEnabled, getScoreboardLayout, getDefaultScoringInput, getColorblindMode, getVoiceAnnouncementSettings, getCardTagline, getHaWebhookStatus, fireHaWebhook,
  isSetupRequired, createFirstAdmin, createAdmin, listAdmins, deleteAdmin, changeAdminPassword, clearAdminLockout,
  login, logout, getSessionAdmin, adminLockoutDelayMs, verifyAdminPassword, backupRetentionDays,
  setPlayerPin, removePlayerPin, verifyPlayerPin, pinLockoutThreshold,
  awardBadge, revokeBadge, getPlayerBadges, getH2HSummary, getAroundTheWorldProgress,
  startChallengeAttempt, completeChallengeAttempt, getChallengeStatus, getChallengeHistory, resetChallengeAttempt,
  createTournament, listTournaments, getTournament, startTournamentMatch, recordWalkover, getTournamentStats,
  createLeague, listLeagues, getLeague, getLeagueStandings, enrollLeaguePlayer, setLeagueStatus,
  getPlayerLeagueSummary, getEligibleLeagues, getLeagueFixtures, getPendingFixturesForPlayers,
  getDartComponentOptions,
  createComponent, listComponents, updateComponent, deleteComponent,
  createLoadout, listLoadouts, getLoadout, updateLoadout, deleteLoadout, duplicateLoadout,
  setDefaultLoadout, getDefaultLoadout, getLoadoutStats,
  recordGhostRace, getGhostRaceRecord,
  saveGame, abandonSavedGame, getSavedGames, getResumeState, findSavedGameForParticipants,
  _db: db,
};
