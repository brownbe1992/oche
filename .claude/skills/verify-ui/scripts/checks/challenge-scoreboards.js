'use strict';
/* The in-app scoreboard and /display agree during a Daily Challenge.
 *
 * A challenge attempt is plain X01 underneath — `game.gameType` stays `'x01'`
 * the whole way — so neither scoreboard has a game type to branch on, and each
 * needed its own carve-out. Only `/display` ever got one. Mid-attempt the app
 * itself showed the filler starting score ticking down (a Ton Hunter run three
 * visits in read "893", which looks like a target and is not one) while
 * `/display`, on the same game at the same moment, read "1 ton · 2/6 visits".
 *
 * Both now read `challengeLiveState(game)`. This check drives a real attempt of
 * every format and asserts against BOTH surfaces, because a single shared
 * function is only worth having if both callers actually use it.
 *
 * The formats are not hardcoded here: they come from `CHALLENGE_FORMATS` at run
 * time, and each format's own `usesFillerScore` decides which assertion applies.
 * Adding a tenth format therefore extends this check for free — and a new format
 * that forgets `usesFillerScore` shows up as the filler score leaking onto the
 * scoreboard, which is the bug this exists for.
 *
 * The date rotation picks the format, so each case pins `localDateStr()` to a
 * date whose rotation lands on the format under test rather than waiting for it
 * to come round.
 */
const L = require('../lib');

module.exports = async function run() {
  const rep = L.makeReporter('challenge-scoreboards');

  await L.withPage(L.PORTRAIT, async (page, pageErrors) => {
    const results = await page.evaluate(async () => {
      const out = [];
      for (const want of CHALLENGE_FORMATS) {
        try {
          let d = null;
          for (let i = 0; i < 900; i++) {
            const t = new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
            if (todaysChallenge(t).format === want) { d = t; break; }
          }
          if (!d) { out.push({ want, error: 'no date in the next 900 days rotates to this format' }); continue; }
          window.localDateStr = () => d;

          const n = 'CS_' + want + '_' + Date.now();
          await DB.addPlayer(n); roster.push(n);
          player = n; setMode('challenge'); setup.slots = [n];
          await startGame(); await new Promise(r => setTimeout(r, 450));
          const startScore = game.players[0].score;
          // One real visit, so there is a committed visit to count and the
          // score has actually moved off its starting value.
          setMult(3); throwDart(20); setMult(1); throwDart(20); setMult(1); throwDart(20);
          enterTurn(); await new Promise(r => setTimeout(r, 250));

          const cs = challengeLiveState(game);
          const hero = (document.querySelector('#scoreboard .rem') || {}).textContent;
          const meta = (document.querySelector('#scoreboard .avgs') || {}).textContent || '';
          const live = await fetch('/api/live').then(r => r.json());
          const ms = live.modeState || {};

          out.push({ want, startScore, score: String(game.players[0].score),
            filler: !!(cs && cs.usesFillerScore), metric: cs && String(cs.metric),
            metricLabel: cs && cs.metricLabel, visitCap: cs && cs.visitCap,
            hero, meta,
            liveMetric: ms.challengeMetric != null ? String(ms.challengeMetric) : null,
            liveMetricLabel: ms.challengeMetricLabel,
            liveFiller: ms.challengeUsesFillerScore,
            liveVisitCap: ms.challengeVisitCap });

          game = null; activeChallenge = null; show('home');
          await new Promise(r => setTimeout(r, 160));
        } catch (e) { out.push({ want, error: String(e && e.message || e) }); }
      }
      return out;
    });

    rep.ok('challenge: every format in the rotation was played',
      results.length > 0 && results.every(r => !r.error),
      results.filter(r => r.error).map(r => `${r.want}: ${r.error}`).join('; ') || `${results.length} formats`);

    for (const r of results) {
      if (r.error) continue;
      // The fixture has to have MOVED the score, or "the hero is not the score"
      // would pass for the wrong reason on a format whose metric happens to
      // equal its starting score.
      rep.ok(`${r.want}: the fixture visit actually changed the X01 score`,
        r.score !== String(r.startScore), `${r.startScore} -> ${r.score}`);

      if (r.filler) {
        rep.ok(`${r.want}: the in-app hero is the challenge metric, not the filler countdown`,
          r.hero === r.metric && r.hero !== r.score, `hero="${r.hero}" metric=${r.metric} score=${r.score}`);
      } else {
        rep.ok(`${r.want}: the in-app hero stays the real remaining score`,
          r.hero === r.score, `hero="${r.hero}" score=${r.score}`);
      }

      rep.ok(`${r.want}: the in-app meta line reports the challenge, not leg/game averages`,
        r.meta.includes(r.metricLabel) && !/\bleg\b.*\bgame\b/.test(r.meta), JSON.stringify(r.meta));

      if (r.visitCap) {
        rep.ok(`${r.want}: the in-app meta line says which visit of how many`,
          new RegExp(`of\\s*${r.visitCap}\\b`).test(r.meta), JSON.stringify(r.meta));
      }

      // The whole point: one computation, so the two surfaces cannot disagree.
      rep.ok(`${r.want}: /display and the app report the same metric`,
        r.liveMetric === r.metric && r.liveMetricLabel === r.metricLabel,
        `app=${r.metric}/${r.metricLabel} display=${r.liveMetric}/${r.liveMetricLabel}`);
      rep.ok(`${r.want}: /display and the app agree on whether the score is a filler`,
        !!r.liveFiller === r.filler, `app=${r.filler} display=${r.liveFiller}`);
    }

    rep.ok('challenge-scoreboards: no uncaught page errors', pageErrors.length === 0,
      pageErrors.slice(0, 3).join('; '));
  });

  return rep.finish();
};
