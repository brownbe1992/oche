'use strict';
// Committed regression test for docs/bug-roadmap.md BUG-21: shareEarnedBadge()
// (the Badge Case's re-share button) built a shareable moment card with no
// explanation at all — no statLine, no achievement description — because it never
// read BADGE_INFO[badgeId].desc even though that field was sitting right there.
// The fix wires every card-building path (fireMomentCard()'s live-firing choke
// point, the On This Day flashback, sharePersonalBest(), and shareEarnedBadge()
// itself) through achDescFor(type), and adds three missing ACH_DESC_FALLBACK
// entries (matchwin/dailychallenge/checkout100) so that lookup never resolves to
// an empty string for any moment-card type actually in use.
//
// buildMomentCard() itself draws onto a real <canvas> 2D context and can't be
// exercised in a vm context with no DOM (unlike the pure-string SVG builders in
// display.html) — see BUG-8/BUG-18's precedent for UI/canvas-shaped fixes relying
// on a live Playwright check instead of a node:test for the rendering itself. What
// IS a pure, side-effect-free, vm-extractable calculation is achDescFor()'s
// fallback-resolution chain and its three small constant dependencies (BADGE_INFO,
// ACH_TYPE_TO_BADGE_ID, ACH_DESC_FALLBACK) — extracted here directly from
// frontend/index.html's real source (the same "test the function's actual current
// source, not a hand-copied duplicate" approach display.heatmap-hardening.test.js
// established), so a future achievement/badge type added without a description
// fails this test immediately instead of silently shipping a blank moment card.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', '..', 'frontend', 'index.html');
const { CRICKET_COMEBACK_THRESHOLD } = require(path.join('..', '..', 'frontend', 'scoring.js'));

function loadAchDescFor() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const badgeInfoMatch = src.match(/^const BADGE_INFO = \{[\s\S]*?\n\};/m);
  const achTypeMatch = src.match(/^const ACH_TYPE_TO_BADGE_ID = \{[\s\S]*?\n\};/m);
  const achDescMatch = src.match(/^const ACH_DESC_FALLBACK = \{[\s\S]*?\n\};/m);
  const fnMatch = src.match(/function achDescFor\(type\)\{[\s\S]*?\n\}/);
  assert.ok(badgeInfoMatch, 'BADGE_INFO declaration not found in index.html — has it moved/renamed?');
  assert.ok(achTypeMatch, 'ACH_TYPE_TO_BADGE_ID declaration not found in index.html — has it moved/renamed?');
  assert.ok(achDescMatch, 'ACH_DESC_FALLBACK declaration not found in index.html — has it moved/renamed?');
  assert.ok(fnMatch, 'achDescFor() not found in index.html — has it moved/renamed?');
  const context = { CRICKET_COMEBACK_THRESHOLD };
  vm.createContext(context);
  vm.runInContext(
    `${badgeInfoMatch[0]}\n${achTypeMatch[0]}\n${achDescMatch[0]}\n${fnMatch[0]}\n` +
    `this.achDescFor = achDescFor; this.BADGE_INFO = BADGE_INFO;`,
    context
  );
  return context;
}

describe('BUG-21 — achDescFor() resolves a non-empty explanation for every moment-card type in use', () => {
  test('the three new fallback entries (previously unresolved) now return real text', () => {
    const { achDescFor } = loadAchDescFor();
    assert.equal(achDescFor('matchwin'), 'Won the match.');
    assert.equal(achDescFor('dailychallenge'), "Completed today's Daily Challenge.");
    assert.equal(achDescFor('checkout100'), 'A checkout of 100 points or more.');
  });

  test('the three pre-existing ACH_DESC_FALLBACK entries (180/bigfish/ninedarter) are unaffected', () => {
    const { achDescFor } = loadAchDescFor();
    assert.equal(achDescFor('180'), 'Three darts, sixty each — the biggest score possible in one visit.');
    assert.match(achDescFor('bigfish'), /170 checkout/);
    assert.match(achDescFor('ninedarter'), /nine darts/);
  });

  test('resolves through the ACH_TYPE_TO_BADGE_ID bridge for the four historically-renamed types', () => {
    const { achDescFor } = loadAchDescFor();
    // These moment-card/overlay type strings predate their BADGE_INFO badge_id and
    // are bridged via ACH_TYPE_TO_BADGE_ID — confirms the bridge itself still works,
    // not just a direct id match.
    for (const type of ['first100checkout', 'grudgematch', 'aroundtheclock', 'aroundtheworld', 'ghostslayer', 'tournamentchampion', 'tournamentgiantslayer']) {
      const desc = achDescFor(type);
      assert.ok(desc && desc.length > 0, `achDescFor('${type}') must not be empty`);
    }
  });

  test('resolves directly from BADGE_INFO for a representative id in every game-type category', () => {
    const { achDescFor } = loadAchDescFor();
    const representative = [
      'hattrick', 'triplebull', 'bullseyefinish',            // X01 chain-check badges
      'cricket9marks', 'cricketperfectclose', 'cricketwhitewash', 'cricketcomebackkid', // Cricket
      'baseballperfectinning', 'baseballperfectgame',        // Baseball
      'challengeweek', 'challengemonth', 'challengeallformats', // Daily Challenge
      'chuckin180',                                          // Just Chuckin' It (the one static entry)
      'tournament_champion', 'tournament_giant_slayer',       // Tournament (direct badge_id, not the bridged alias)
      'checkout_trainer_170_club', 'checkout_trainer_one_darter', // Checkout Trainer one-offs
      'guided_clock', 'guided_world',                        // Guided drills
    ];
    for (const id of representative) {
      const desc = achDescFor(id);
      assert.ok(desc && desc.length > 0, `achDescFor('${id}') must not be empty`);
    }
  });

  test("cricketcomebackkid's description correctly interpolates the real CRICKET_COMEBACK_THRESHOLD from scoring.js", () => {
    const { achDescFor } = loadAchDescFor();
    assert.match(achDescFor('cricketcomebackkid'), new RegExp(`${CRICKET_COMEBACK_THRESHOLD}\\+`));
  });

  test('an unknown type with no BADGE_INFO entry and no fallback resolves to the empty string (documents the terminal case)', () => {
    const { achDescFor } = loadAchDescFor();
    assert.equal(achDescFor('not_a_real_achievement_type'), '');
  });

  test('BADGE_INFO itself is non-empty and every entry has a non-empty desc (catches a future badge shipped without one)', () => {
    const { BADGE_INFO } = loadAchDescFor();
    const ids = Object.keys(BADGE_INFO);
    assert.ok(ids.length > 30, 'BADGE_INFO should have dozens of static entries');
    for (const id of ids) {
      assert.ok(BADGE_INFO[id].desc && BADGE_INFO[id].desc.length > 0, `BADGE_INFO['${id}'] must have a non-empty desc`);
    }
  });
});
