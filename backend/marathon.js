// @ts-check
'use strict';
/* Marathon mode — a long session of X01 legs played against one loadout.
 *
 * Lifted out of backend/db.js (2026-07). It had been sharing the "dart builder /
 * loadouts" banner, because a marathon session is configured FROM a loadout — but
 * it is a game mode with its own session lifecycle, stat bubbles, personal bests
 * and leaderboard, not part of the builder.
 *
 * Every marathon leg is an ordinary `x01` game row; 'marathon' is a dispatchOnly
 * routing key in GAME_TYPE_REGISTRY, never a games.game_type value.
 *
 * @param {{ db: any, httpError: any, getPlayer: any, createGame: any, _scope: any, CHECKOUT_POINTS: string }} deps
 */
module.exports = function initMarathon(deps) {
  const { db, httpError, getPlayer, createGame, _scope, CHECKOUT_POINTS } = deps;
  // Pure maths, required directly rather than injected — scoring.js has no
  // dependency on db.js, so there is no cycle to avoid and no reason to route
  // these through the argument list.
  const { computeFatigueSplit, classifyMarathonTrend } = require('../frontend/scoring.js');

  /* ---------- Marathon mode ----------
     A game mode, not part of the dart builder above — it shares that section only
     because a marathon session is configured from a loadout. Its own leg/session
     lifecycle, stat bubbles, personal bests and leaderboard all live here. */
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
        (SELECT ${CHECKOUT_POINTS} FROM turns t JOIN games g ON g.id = t.game_id
          WHERE t.game_id = msl.game_id AND t.checkout = 1 LIMIT 1) AS checkoutPoints,
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

  return {
    startMarathonSession,
    startNextMarathonLeg,
    endMarathonSession,
    getMarathonSessionDetail,
    getMarathonStatBubbles,
    getMarathonPersonalBests,
    getMarathonLeaderboard,
  };
};
