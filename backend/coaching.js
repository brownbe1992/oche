// @ts-check
'use strict';
/* Coaching insights (docs/archive/coaching-insights-roadmap.md) — the ranked
 * "here is what to practise" list on the Player Profile.
 *
 * Lifted out of backend/db.js (2026-07). One exported function, but it is a pure
 * READER: it composes four existing stat functions and adds no schema, no writes
 * and no state of its own, which is what makes it a clean leaf despite its size.
 *
 * @param {{ db: any, getPlayer: any, _mf: any, getPersonalBests: any, getDartAnalytics: any, getCheckoutRoutes: any, CHECKOUT_POINTS: string, X01_ONLY: string }} deps
 */
module.exports = function initCoaching(deps) {
  const { db, getPlayer, _mf, getPersonalBests, getDartAnalytics, getCheckoutRoutes,
          CHECKOUT_POINTS, X01_ONLY } = deps;
  // Pure checkout maths, required straight from scoring.js — it has no dependency
  // on db.js, so there is no cycle to avoid and nothing gained by injecting it.
  const { checkoutHint, dartLabel } = require('../frontend/scoring.js');

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
      SELECT ${CHECKOUT_POINTS} AS score, COUNT(*) AS times
      FROM turns t JOIN games g ON g.id = t.game_id
      WHERE t.player_id = ? AND t.checkout = 1 ${X01_ONLY} ${mf}
      GROUP BY score
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

  return {
    getCoachingInsights,
  };
};
