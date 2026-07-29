'use strict';
// New Game Step 1 opens with NOTHING selected, and a game's settings panel is
// only ever reachable through its own visible row.
//
// The bug this pins: Step 1 used to open with X01 pre-selected inside an
// auto-expanded Traditional category, and `setupOpenCategoryKey()` hard-coded
// 'traditional' as its fallback so *something* was always expanded. On top of
// that, `renderSetupGameLedger()` rendered a second copy of the selected game's
// settings panel below the entire ledger whenever the selection's own category
// was collapsed — so collapsing Traditional (or opening any other category)
// left a bare X01 "starting score / format / Continue" block stranded at the
// bottom of the page, under five collapsed headers, with nothing naming what it
// belonged to.
//
// The DOM half of this behaviour is covered by the browser suite
// (.claude/skills/verify-ui, `new-game` check). What is pinned HERE is the pure
// selection logic underneath it, which is where the defaults actually lived:
// which key counts as selected, and which category that opens.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const INDEX = path.join(FRONTEND, 'index.html');
const src = fs.readFileSync(INDEX, 'utf8');

// Brace-matching extraction, the same technique completion-panels.test.js and
// frontend.multiplayer-x01.test.js use — index.html has no module boundary to
// require() through.
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name}() not found in index.html — renamed, or no longer a top-level function?`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

// The real tables, read out of the source rather than restated here — a test
// carrying its own copy of the game list would keep passing after someone added a
// category the app forgot to wire up. `open` is '[' for an array const, '{' for an
// object one.
function extractConst(name, open) {
  const close = open === '[' ? ']' : '}';
  const start = src.indexOf(`const ${name} = ${open}`);
  assert.ok(start > -1, `${name} not found in index.html`);
  let depth = 0;
  for (let i = src.indexOf(open, start); i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(start, i + 1) + ';';
  }
  throw new Error(`unbalanced ${open}${close} in ${name}`);
}

const ctx = vm.createContext({ setup: {} });
vm.runInContext([
  extractConst('GAME_LEDGER_CATEGORIES', '['),
  extractConst('GAME_LEDGER_NAMES', '{'),
  extractConst('GAME_LEDGER_TEASERS', '{'),
  // `const` inside a vm script is a lexical binding, not a property of the
  // context — hand them out explicitly so the assertions below can read them.
  'globalThis.GAME_LEDGER_CATEGORIES = GAME_LEDGER_CATEGORIES;',
  'globalThis.GAME_LEDGER_NAMES = GAME_LEDGER_NAMES;',
  'globalThis.GAME_LEDGER_TEASERS = GAME_LEDGER_TEASERS;',
  extract('ledgerCategoryIcon'),
  extract('currentSetupOptionKey'),
  extract('setupLedgerRowKey'),
  extract('setupOpenCategoryKey'),
].join('\n'), ctx);

const CATEGORIES = ctx.GAME_LEDGER_CATEGORIES;
const ALL_KEYS = CATEGORIES.flatMap(c => c.keys);

// How a given ledger key leaves `setup` once picked, derived from that key's own
// NEW_GAME_MODE_OPTIONS.apply() in the source instead of a second hand-kept list
// here. An entry whose apply() calls setGameType('<key>') lands as
// mode:'practice'|'h2h' + gameType:'<key>'; every other entry is its own mode
// (setMode('<key>')) and leaves gameType on a real scored type underneath.
function setupStateFor(key) {
  const entry = src.match(new RegExp(`key:'${key}'[\\s\\S]{0,2000}?apply\\(\\)\\{([^}]*)\\}`));
  assert.ok(entry, `no NEW_GAME_MODE_OPTIONS entry with an apply() found for '${key}'`);
  const usesGameType = entry[1].includes(`setGameType('${key}')`);
  return usesGameType
    ? { mode: 'h2h', gameType: key, leagueFixtureId: null, gameChosen: true }
    : { mode: key, gameType: 'x01', leagueFixtureId: null, gameChosen: true };
}

const keyFor = (state) => { ctx.setup = state; return ctx.currentSetupOptionKey(); };
const rowFor = (state) => { ctx.setup = state; return ctx.setupLedgerRowKey(); };
const openFor = (state) => { ctx.setup = state; return ctx.setupOpenCategoryKey(); };

describe('Step 1 opens with no game selected', () => {
  test('a fresh visit selects nothing, whatever mode/gameType still hold', () => {
    // gameChosen:false is the whole point — `mode` and `gameType` always carry
    // some concrete value (startGame() reads them directly and cannot cope with
    // null), so they can never mean "nothing picked yet" on their own. Before
    // this flag existed, these very values reported X01 as the selection.
    assert.equal(keyFor({ mode: 'h2h', gameType: 'x01', leagueFixtureId: null, gameChosen: false }), '');
    assert.equal(keyFor({ mode: 'practice', gameType: 'cricket', leagueFixtureId: null, gameChosen: false }), '');
    assert.equal(keyFor({ mode: 'gauntlet', gameType: 'gauntlet', leagueFixtureId: null, gameChosen: false }), '');
  });

  test('with nothing selected, no category is expanded either', () => {
    // The old fallback was a literal 'traditional', which is what made Step 1
    // open with that category expanded and X01 sitting selected inside it.
    const fresh = { mode: 'h2h', gameType: 'x01', leagueFixtureId: null, gameChosen: false };
    assert.equal(openFor(fresh), '', 'no selection must mean no auto-expanded category');
    assert.equal(rowFor(fresh), '', 'no selection must highlight no row');
  });

  test("'traditional' is not a fallback for an unrecognised selection", () => {
    // An unknown key must collapse everything rather than silently expanding
    // Traditional and lighting up nothing inside it.
    assert.equal(openFor({ mode: 'practice', gameType: 'not_a_real_game', leagueFixtureId: null, gameChosen: true }), '');
  });
});

describe('every game in every category behaves the same way', () => {
  test('the category table is coherent — no orphans, no duplicates', () => {
    const seen = new Set();
    for (const key of ALL_KEYS) {
      assert.ok(!seen.has(key), `'${key}' is listed in more than one category`);
      seen.add(key);
    }
    assert.ok(CATEGORIES.length >= 5, `expected at least 5 ledger categories, got ${CATEGORIES.length}`);
    for (const cat of CATEGORIES) {
      assert.ok(cat.keys.length > 0, `category '${cat.key}' has no games in it`);
    }
  });

  test('every category renders a real icon', () => {
    // ledgerCategoryIcon() looks its glyph up by category key and falls back to
    // an EMPTY string, so a category added without a glyph gets a blank 20x20
    // SVG — a hole in the row that no other assertion here would notice.
    for (const cat of CATEGORIES) {
      const svg = ctx.ledgerCategoryIcon(cat.key, cat.accent);
      assert.match(svg, /^<svg /, `category '${cat.key}' produced no svg`);
      assert.ok(/<(circle|rect|line|path|polyline)/.test(svg),
        `category '${cat.key}' has no glyph in ledgerCategoryIcon() — it renders an empty icon`);
    }
  });

  test('every game has a display name and a teaser', () => {
    // Both maps are keyed by game, not category, so moving a game between
    // categories can't break them — but a NEW game arriving in a new category
    // can, and `GAME_LEDGER_NAMES[k]||k` would silently print a raw snake_case
    // key on the row.
    for (const key of ALL_KEYS) {
      assert.ok(ctx.GAME_LEDGER_NAMES[key], `'${key}' has no GAME_LEDGER_NAMES entry`);
      assert.ok(ctx.GAME_LEDGER_TEASERS[key], `'${key}' has no GAME_LEDGER_TEASERS entry`);
    }
  });
});

describe('Minigames is first, and owns Checkout Trainer', () => {
  // Both are deliberate placements from an owner request, and both are the kind of
  // thing an unrelated edit to the category table could undo without any other
  // assertion here noticing — the ledger would still be perfectly coherent.
  test('Minigames is the first category on the screen', () => {
    assert.equal(CATEGORIES[0].key, 'minigames',
      `first category is '${CATEGORIES[0].key}' — Minigames is meant to lead, before Traditional`);
  });

  test('Traditional still follows it', () => {
    assert.equal(CATEGORIES[1].key, 'traditional');
  });

  test('Checkout Trainer lives in Minigames and nowhere else', () => {
    const owner = CATEGORIES.find(c => c.keys.includes('checkout_trainer'));
    assert.ok(owner, 'checkout_trainer is not in any category at all');
    assert.equal(owner.key, 'minigames', `checkout_trainer is under '${owner.key}'`);
    // It used to sit in Practice & Drills; the move is the point, so assert the
    // old home is actually clear rather than trusting the dedupe check above.
    const training = CATEGORIES.find(c => c.key === 'training');
    assert.ok(training, 'the training category has been renamed or removed');
    assert.ok(!training.keys.includes('checkout_trainer'),
      'checkout_trainer is still listed under Practice & Drills too');
  });

  test('selecting Checkout Trainer opens Minigames', () => {
    assert.equal(openFor(setupStateFor('checkout_trainer')), 'minigames');
  });

  test('choosing any game selects that row and expands exactly its own category', () => {
    // The reported bug was demonstrated with X01/Traditional, but the fix has to
    // hold for every row of every category — so this walks all of them rather
    // than spot-checking, which is what makes "consistent across all game modes
    // of all categories" a checked property instead of a claim.
    for (const cat of CATEGORIES) {
      for (const key of cat.keys) {
        const state = setupStateFor(key);
        assert.equal(rowFor(state), key, `selecting '${key}' should highlight its own row`);
        assert.equal(openFor(state), cat.key,
          `selecting '${key}' should expand '${cat.key}', not some other category`);
      }
    }
  });

  test('no game resolves to an empty selection once picked', () => {
    for (const key of ALL_KEYS) {
      assert.notEqual(keyFor(setupStateFor(key)), '', `'${key}' reported nothing selected after being picked`);
    }
  });
});

describe('a league fixture still has a row to show', () => {
  // 'league_game' belongs to no category, so it has no row of its own. Left as
  // itself it would resolve to no open category — and with the fallback panel
  // gone that is a dead end: Back from Step 2 with a fixture toggled on would
  // show a fully collapsed ledger and no Continue anywhere. setupLedgerRowKey()
  // resolves it to the underlying game the fixture pinned instead.
  test('currentSetupOptionKey() still reports the fixture itself', () => {
    assert.equal(keyFor({ mode: 'h2h', gameType: 'x01', leagueFixtureId: 7, gameChosen: true }), 'league_game');
  });

  test('the ledger falls back to the row of the game the fixture pinned', () => {
    for (const gameType of ['x01', 'cricket']) {
      const state = { mode: 'h2h', gameType, leagueFixtureId: 7, gameChosen: true };
      assert.equal(rowFor(state), gameType);
      assert.equal(openFor(state), 'traditional',
        `a ${gameType} league fixture should open the category holding ${gameType}`);
    }
  });
});

describe('the settings panel has no stranded second copy', () => {
  test('setupGamePanelHtml() is rendered in exactly two places', () => {
    // The selected ledger row, and the Daily Challenge spotlight card. A third
    // call site is how the stranded-at-the-bottom panel existed in the first
    // place: a copy rendered below the whole ledger for the "selection's
    // category is collapsed" state. If this count has gone up, check that the
    // new site renders somewhere the user can see what it belongs to.
    const files = ['index.html', 'js/daily-challenge.js'];
    const calls = files.reduce((n, f) => {
      const text = fs.readFileSync(path.join(FRONTEND, f), 'utf8');
      // Every real call passes an object literal, so `({` separates calls from
      // the prose references in nearby comments (which write `setupGamePanelHtml()`);
      // the lookbehind then drops the definition, which also opens with `({`.
      return n + (text.match(/(?<!function )setupGamePanelHtml\(\{/g) || []).length;
    }, 0);
    assert.equal(calls, 2, `expected 2 call sites (selected row + Daily Challenge card), found ${calls}`);
  });

  test('the panel no longer takes a heading', () => {
    // `heading` existed only for the stranded copy, which sat outside any row and
    // so had to name its own game. Inside a row the row already names it.
    const def = extract('setupGamePanelHtml');
    assert.ok(!/heading/.test(def),
      'setupGamePanelHtml() still mentions `heading` — the out-of-row copy may be back');
  });

  test('a fresh visit to the wizard clears the previous choice', () => {
    // Pinned as source text because the reset lives inside show(), a function far
    // too entangled with the DOM to run here. The behaviour it guards is the
    // reported one: opening New Game must not inherit last game's selection.
    const show = extract('show');
    assert.ok(/setup\.gameChosen\s*=\s*false/.test(show),
      "show('setup') no longer clears setup.gameChosen — Step 1 will reopen with the last game selected");
    assert.ok(/setupExpandedCategory\s*=\s*''/.test(show),
      "show('setup') no longer clears setupExpandedCategory — Step 1 will reopen with a category expanded");
  });
});
