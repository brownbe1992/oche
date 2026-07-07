# Dart Builder / Loadout Customization — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

## Goal

A "custom loadout" builder — visually closer to a shooter game's weapon-customization
screen (Call of Duty-style: pick a barrel, pick a shaft, pick a flight, see the
assembled dart, save it as a loadout) than to a settings form. The point isn't
cosmetic: it lets a player build several concrete dart configurations (different
weights, lengths, barrel shapes, shaft/flight combos), save each as a named loadout,
pick one before a game in a couple of taps, and then see stats broken out **per
loadout** — so "which combination of components actually performs best for me" has a
real, data-backed answer instead of a guess.

## Relationship to the existing `dart_weight` field

The app already has a single-number `players.dart_weight` column (grams only, set via
the Add/Edit Player modal's "Dart Weight" dropdown — `dartWeightOptions()` in
`frontend/index.html`), snapshotted per-game into `game_players.dart_weight`, and
already usable as a stat-history filter (`weight` query param on
`/api/players/:name/history`, `backend/server.js`). It's a real, working precedent for
exactly the thing this doc generalizes — "tag a game with the darts thrown, filter
stats by that tag" — just for one attribute (weight) instead of a full set built from
component parts.

This feature supersedes it rather than living alongside it: once loadouts exist, a
loadout's total weight (sum of its components, see below) **is** the dart-weight
value for that game, so a separate free-standing weight picker becomes redundant.
`players.dart_weight` should be treated as the "no loadout picked" fallback for
players who never build one (kept working, not removed), while
`game_players.dart_weight` keeps its existing snapshot role but gets populated from
the resolved loadout's total weight when one was selected. The existing `weight`
stat-history filter stays working unchanged; loadout-scoped filtering is additive
(see "Stats" below), not a replacement for it.

## 1. Data model

New tables, additive to the existing schema — no changes to `games`, `turns`, or
`darts`. Per `CLAUDE.md`'s standing convention, a loadout is a **context that gets
tagged onto a game via its own table with a `game_id` FK** — never a new column
bolted onto `games` itself.

**`dart_components`** — the catalog of individual parts a player has entered (barrels
they own, shaft styles, flight styles). Not shared/global; each row belongs to one
player, since real dart sets and preferences are personal.
`id, player_id, type ('barrel'|'shaft'|'flight'), name, length_mm, weight_g, material,
shape, notes, created_at`

- `length_mm` — every component type carries a length attribute, per the request.
  Barrels: physical barrel length. Shafts: shaft length (also where "shaft length"
  presets like short/medium/long/extra-long map to a concrete number). Flights:
  flight height/profile length (standard/slim/kite/pear all reduce to a length +
  shape combination).
- `weight_g` — only meaningful for barrels in practice (shafts/flights are
  negligible), but kept on every row for uniformity rather than a barrel-only column,
  since a shaft or flight's `weight_g` can simply stay `NULL`/`0`.
- `shape` — free-text or a small fixed enum (barrel: straight/torpedo/ton/scalloped;
  flight: standard/slim/kite/pear) — an enum reads better in the builder UI as a
  visual picker, so lean toward a fixed list per `type` rather than free text, with
  `material` (tungsten %, brass, nylon, etc.) as a separate free-text field alongside
  it.
- No `tip` type in v1 (steel vs. soft-tip changes the whole board/game, not just a
  loadout) — scope this doc to steel-tip barrel/shaft/flight customization only,
  consistent with the rest of the app's steel-tip assumption.

**`loadouts`** — a saved, named combination of exactly one component per type (plus
optional freeform flight-count/weight-per-dart override, since real sets are usually
3 identical darts but the builder shouldn't hard-code that assumption away).
`id, player_id, name, barrel_id, shaft_id, flight_id, dart_count, is_default,
created_at, updated_at`

- `barrel_id` / `shaft_id` / `flight_id` — FKs into `dart_components`, each nullable
  individually (a loadout can be saved "in progress" with a barrel picked but no
  flight yet — matches how a loadout screen in a game lets you leave slots empty),
  but the loadout can't be *selected* for a game until all three are filled (validated
  at selection time, not at save time).
- `dart_count` — defaults to `3`; exists so total-weight-per-set math
  (`(barrel.weight_g + shaft.weight_g + flight.weight_g) * dart_count`) has
  something to multiply by. Total per-dart weight is a derived value, not stored —
  the usual "compute from raw data" preference already used elsewhere in this app
  (see the league-mode roadmap's identical reasoning for `league_players` tallies).
- `is_default` — one loadout per player can be flagged as the one pre-selected by
  default on the New Game screen, so a player who only ever throws one set of darts
  never has to actively pick a loadout at all.
- Total length (barrel + shaft + flight, tip-to-flight-end) is also a derived value
  at render time, not stored, for the same reason.

**`game_players.loadout_id`** — nullable FK added to the existing `game_players`
table (not a new join table — `game_players` already carries per-player, per-game
snapshot data like `out_mode` and `dart_weight`, so a loadout selection belongs
alongside them as one more per-player-per-game attribute, not as its own
`game_id`-linked context table; the context/FK convention in `CLAUDE.md` is about
giving a *game itself* a category, like "this game belongs to a tournament," not
about every per-player attribute of a game). Resolved once at game creation and
snapshotted (loadout name + component summary copied in, not just the ID) so that
renaming/deleting a loadout later never rewrites history — same reasoning already
applied to `game_players.dart_weight` and `game_players.out_mode`.

## 2. UI/UX

**Dart Builder screen** (new, reachable from Settings or a player's profile — "Manage
Loadouts"): a loadout-editor styled like a game loadout screen —three slots across the
top (Barrel / Shaft / Flight), each opening a horizontally-scrollable card picker of
that player's entered components (image/icon placeholder, name, length, weight),
tapping a card fills the slot and updates a live-assembled dart preview + running
total weight/length at the bottom. A "+" on each slot's picker opens a small form to
add a new component of that type (name, length, weight if applicable, material,
shape). Below the three slots: loadout name field, dart count, "Set as default"
toggle, Save.

**Loadout list**: saved loadouts shown as cards (assembled-dart preview thumbnail,
name, total weight/length, small "used in N games" count), with Edit/Duplicate/Delete
per card. Duplicate is worth calling out specifically — tweaking one component of an
existing loadout to test a variant (e.g. same barrel/flight, one shaft length longer)
is the exact workflow this feature exists to support, and starting from a copy is much
faster than rebuilding from scratch each time.

**New Game integration**: a **"Change Loadout"** button next to each selected player
slot on the New Game screen (alongside the existing finish-rule/PIN affordances for
that player), opening a compact picker (same card style as the builder, but
selection-only — no editing) scoped to that player's own loadouts, defaulting to
their `is_default` loadout if one exists. Selecting a player with no loadouts yet
shows a "Build a loadout" shortcut into the Dart Builder screen instead of an empty
picker.

## 3. Stats

Per `CLAUDE.md`'s "every new calculation gets a committed test" convention, this adds
a genuinely new stat-scoping dimension, not just a new data field:

- Player Profile gets a **loadout filter** (dropdown, same interaction pattern as the
  existing game-type toggle mechanism from Game Modes step 6) that scopes averages,
  checkout %, and other existing per-game stats down to games played with a specific
  `game_players.loadout_id` — reusing the existing stats-query scope helper
  (`_scope()` in `backend/db.js`) by adding a loadout predicate alongside the
  existing game-type/practice/date-range ones, not a parallel stats pipeline.
- A **loadout comparison view** (stretch, not required for v1): side-by-side stat
  cards for two or more of a player's loadouts — same metrics computed once per
  loadout — since "which combination performs best for me" is the whole point of the
  feature and a single-loadout filter alone still requires manually flipping between
  views and remembering numbers to compare them.
- No new derived formula is being invented here (averages/checkout %/etc. already
  exist and are already tested) — the new logic needing a committed test is the
  *scoping* itself: a test proving that a game played under loadout A is correctly
  included/excluded from loadout A's/B's filtered stats.

## 4. Accessibility, security, and testing considerations

Per `CLAUDE.md`'s standing conventions:

- **Accessibility**: the builder's card-picker/drag-and-assemble interaction is
  inherently visual and needs a fully keyboard-operable equivalent from the start (
  arrow/tab through cards, Enter to select, not a pointer-only carousel), plus
  non-color ways to distinguish component shapes/materials in the picker (icon +
  text label, not color-coded swatches alone) — per
  `docs/accessibility-roadmap.md`'s standing checklist. The live-assembled dart
  preview should have a text-equivalent summary (e.g. an `aria-live` region stating
  "Barrel: [name], Shaft: [name], Flight: [name] — total Xg, Ymm") so a screen-reader
  user gets the same "what am I building" feedback a sighted user gets visually.
- **Security**: no new credential/token surface — components and loadouts are
  player-owned catalog data behind the same PIN/player-auth model already protecting
  other per-player data, nothing new to harden.
- **Testing**: the loadout total-weight/total-length derivation (sum of three
  component values × dart count) and the new stats-scoping predicate (which games
  count toward which loadout's filtered stats) both need committed, re-runnable
  `node:test` coverage in the same change that ships them — this is exactly the kind
  of "new calculation" the standing convention calls out, not a one-off manual check.

## Open questions for whoever picks this up

- Should `dart_components` support an optional photo/image upload per component (a
  real photo of the actual barrel) instead of just a generic shape icon, given how
  visual the CoD-loadout-screen framing is? Nice-to-have, not required for v1 — a
  shape+color icon per fixed enum value is a much smaller lift and still delivers the
  "assembled dart preview" feel.
- Should loadouts be shareable/exportable (e.g. copy a friend's exact spec) or kept
  strictly private per player? No cross-player sharing mechanism exists elsewhere in
  the app today, so default to private-per-player unless there's specific demand.
- Does `dart_count` ever need to be *not* uniform (e.g. modeling a mismatched
  practice set) — or is defaulting it to 3 and letting players just enter component
  weights as "per dart" values in all cases sufficient? Leaning toward the latter for
  simplicity.
