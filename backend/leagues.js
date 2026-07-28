// @ts-check
'use strict';
/* League mode (docs/archive/league-mode-roadmap.md) — round-robin seasons of X01
 * or Cricket, with standings, fixtures and an optional play-off tournament.
 *
 * Lifted out of backend/db.js (2026-07). A true leaf: nothing in db.js calls into
 * it, so the cut moved code without moving behaviour.
 *
 * The one leaf that depends on ANOTHER leaf — a league can generate a play-off
 * bracket — so db.js builds tournaments first and passes its three functions in
 * alongside the core ones. That dependency is visible in the argument list rather
 * than hidden in a shared scope, which is the whole point of the shape.
 *
 * @param {{ db: any, httpError: any, getPlayer: any, ensurePlayer: any, createGame: any, completeGame: any, abandonGame: any, forfeitPlayer: any, onGameCompleted: any, onGameCreated: any, clampMatchFormat: any, computeStats: any, getHomeExtra: any, createTournament: any, getTournament: any, getTournamentStats: any }} deps
 */
module.exports = function initLeagues(deps) {
  const { db, httpError, getPlayer, ensurePlayer, createGame, completeGame, abandonGame, forfeitPlayer, onGameCompleted, onGameCreated, clampMatchFormat, computeStats, getHomeExtra, createTournament, getTournament, getTournamentStats } = deps;

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

  // Hook: a fixture whose game was abandoned goes back to being unplayed.
  //
  // getLeagueFixtures() derives status from the linked game (pending while game_id
  // IS NULL, in_progress until it completes, fulfilled after), and
  // getPendingFixturesForPlayers() only ever offers a fixture with game_id IS NULL.
  // An abandoned game gets dnf_at, never completed_at — so before this hook, a
  // fixture whose game was abandoned sat at "in progress" forever: it could never
  // reach fulfilled (no completed_at is ever coming), and it could never be picked
  // again from the New Game screen (its game_id is set), leaving that pairing
  // permanently unplayable for the rest of the season. An abandonment is not a
  // result — _computeLeagueStandings() already ignores it for exactly that reason —
  // so the honest state to return to is the one before the game was created.
  //
  // Registered as a hook rather than a line inside abandonGame() so every DNF path
  // gets it: today that's abandonGame() and forfeitPlayer()'s "nobody left standing"
  // branch, both of which fire this same event with a null winner.
  onGameCompleted(({ gameId }) => {
    const g = db.prepare('SELECT dnf_at FROM games WHERE id = ?').get(gameId);
    if (!g || g.dnf_at == null) return;
    db.prepare('UPDATE league_fixtures SET game_id = NULL WHERE game_id = ?').run(gameId);
  });

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
    // Ended leagues sink to the bottom, then newest first. Written out rather than as
    // `(a.status==='ended') - (b.status==='ended')`, which works only because JavaScript
    // coerces false/true to 0/1 — correct, and a genuine puzzle to read.
    }).sort((a, b) => {
      const ended = (/** @type {{status: string}} */ r) => r.status === 'ended' ? 1 : 0;
      return ended(a) - ended(b) || b.leagueId - a.leagueId;
    });
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

  return {
    createLeague,
    listLeagues,
    getLeague,
    getLeagueStandings,
    getLeagueFixtures,
    getPendingFixturesForPlayers,
    enrollLeaguePlayer,
    setLeagueStatus,
    getPlayerLeagueSummary,
    getEligibleLeagues,
  };
};
