# Dart Builder / Loadout Customization — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

## Goal

A "custom loadout" builder — visually closer to a shooter game's weapon-customization
screen (Call of Duty/Halo "gunsmith"-style: pick a barrel, pick a shaft, pick a flight,
see the assembled dart, save it as a loadout) than to a settings form. The point isn't
cosmetic: it lets a player build several concrete dart configurations (different
weights, lengths, barrel shapes, shaft/flight combos), save each as a named loadout,
pick one before a game in a couple of taps, and then see stats broken out **per
loadout** — so "which combination of components actually performs best for me" has a
real, data-backed answer instead of a guess.

Expected usage pattern, which shapes several decisions below: this is not a feature
players are expected to flip between constantly. Darts ultimately comes down to feel,
which can't be quantified — once someone finds a combination that works, they rarely
deviate from it. The feature is mainly for (a) newer players experimenting to find
what works, and (b) anyone who's just bought a new set and wants to see how they
perform with it. Infrequent switching is a feature of the design, not a gap to solve
with a prominent switcher UI.

## Relationship to the existing `dart_weight` field

The app currently has a single-number `players.dart_weight` column (grams only, set
via the Add/Edit Player modal's "Dart Weight" dropdown — `dartWeightOptions()` in
`frontend/index.html`, individual gram values 10g–40g), snapshotted per-game into
`game_players.dart_weight`, and already usable as a stat-history filter (`weight`
query param on `/api/players/:name/history`, `backend/server.js`).

This feature **retires that standalone picker entirely** rather than keeping it as a
fallback. Once the Dart Builder ships, weight is only ever set as an attribute of a
barrel component inside a loadout — the "Dart Weight" dropdown on the player
profile/Add-Player modal goes away. Concretely:

- `players.dart_weight` stops being editable anywhere in the UI. The column itself
  (and any value a player already had set) is left alone in the database rather than
  migrated — existing data is allowed to sit orphaned, unread by any new code path.
  No backfill into an auto-generated "legacy loadout." This is a deliberate choice: a
  migration that fabricates a loadout out of a lone weight number would invent data
  (a fake barrel/shaft/flight) that never existed.
- `game_players.dart_weight` keeps its existing column and snapshot role, but going
  forward it's only populated when a loadout with a barrel selected is resolved at
  game creation — sourced from that loadout's `barrel.weight_g` (the barrel's
  per-dart weight, same 10g–40g value space as today, just entered once on the
  component instead of picked per-game). Games with no loadout selected simply leave
  it `NULL`, same as any player who never sets a weight today.
- The existing `weight` stat-history filter keeps working unchanged for historical
  games that already have a snapshotted value — this only affects how *new* values get
  written going forward, not how old ones are read.
- **No forced loadout requirement.** A player can start and play any game without ever
  building a loadout, exactly as today. Loadouts are additive, not a gate.

## 1. Data model

New tables, additive to the existing schema — no changes to `games`, `turns`, or
`darts`. Per `CLAUDE.md`'s standing convention, a loadout is a **context that gets
tagged onto a game via its own table with a `game_id` FK** — never a new column
bolted onto `games` itself.

**`dart_components`** — the catalog of individual parts a player has entered (barrels
they own, shaft styles, flight styles). Not shared/global; each row belongs to one
player, since real dart sets and preferences are personal. Tip is deliberately **not**
a component type here — see "Tip" below.

`id, player_id, type ('barrel'|'shaft'|'flight'), name, length_mm, weight_g, material,
shape, grip, notes, created_at`

Per-type field reference (this is the real-world variation list worked out for this
doc — all dropdown-driven, not free text, except where noted):

- **Barrel**
  - `length_mm` — preset **ranges** in a dropdown (not individual millimeter values).
  - `weight_g` — individual gram values, reusing the *exact* existing 10g–40g list
    from `dartWeightOptions()` verbatim (same dropdown component, same options, just
    living on the barrel component instead of the player record). Individual values,
    not ranges — precise enough to correlate a stat change with a specific weight
    swap (e.g. did checkout % change after going from 22g to 24g).
  - `material` — dropdown: brass, nickel-silver, and tungsten split by purity
    (Tungsten 80% / 90% / 95% / 97%) as separate options rather than one generic
    "Tungsten" bucket, since purity is the single biggest lever serious players tune
    (higher % = thinner barrel for the same weight).
  - `shape` — dropdown, pure silhouette only: straight / torpedo / ton (list not
    necessarily exhaustive — open question below on additional shapes and on
    enum-vs-escape-hatch generally).
  - `grip` — new field, split out from shape: smooth / knurled / ringed. Shape
    (silhouette) and grip (surface texture) are different physical properties that
    get conflated in casual dart talk, but need separate dropdowns.
  - Both `shape` and `grip` need a **visual example per option** in the UI (icon or
    small diagram) — "torpedo" vs. "ton", or "knurled" vs. "ringed", aren't
    self-explanatory from a text label alone to most players.
- **Shaft**
  - `length_mm` — preset ranges in a dropdown, same convention as barrel length.
  - `material` — dropdown: nylon, aluminum, titanium, polycarbonate, carbon fiber.
  - `type` (stored in the `shape` column, but conceptually "type" not "shape" — fixed
    vs. spinning is a mechanical behavior, not a silhouette): fixed / spinning.
  - No `weight_g` in practice — shaft weight is negligible and not part of how shafts
    are marketed/compared, so this stays `NULL` on shaft rows.
- **Flight**
  - `length_mm` / `shape` — dropdown: standard / slim / kite / pear (shape and
    height/profile reduce to the same choice for flights).
  - `material` — dropdown: standard polyester film, fabric/nylon-reinforced.
  - Ply (single/double) is **not** a structured field — it affects durability, not
    performance, and is a level of detail below what's worth its own dropdown. Players
    who care can note it in `notes`.
  - No `weight_g` in practice, same reasoning as shafts.
- **Tip** — no `tip` row in `dart_components` at all, and no `type` (steel/soft-tip)
  tracking in v1 — steel vs. soft-tip changes the whole board/game, not just a
  loadout, consistent with the rest of the app's steel-tip assumption. **Tip texture**
  (smooth / grooved) is tracked, but as a plain enum column directly on `loadouts`
  (see below) rather than its own component type — there isn't a meaningful catalog of
  reusable, named "tip parts" the way there is for barrels/shafts/flights, just one
  attribute of the assembled loadout.

**`loadouts`** — a saved, named combination of exactly one component per type (plus
tip texture and an optional dart-count override, since real sets are usually 3
identical darts but the builder shouldn't hard-code that assumption away).

`id, player_id, name, barrel_id, shaft_id, flight_id, tip_texture, dart_count,
is_default, created_at, updated_at`

- `barrel_id` / `shaft_id` / `flight_id` — FKs into `dart_components`, each nullable
  individually (a loadout can be saved "in progress" with a barrel picked but no
  flight yet — matches how a loadout screen in a game lets you leave slots empty),
  but the loadout can't be *selected* for a game until all three are filled (validated
  at selection time, not at save time).
- `tip_texture` — `'smooth' | 'grooved'`, nullable.
- `dart_count` — defaults to `3`. Mainly informational/display (showing "this is a set
  of 3"), not a multiplier fed into the weight stat — the weight used for
  `game_players.dart_weight` and stat filtering is always the **per-dart** barrel
  weight (`barrel.weight_g`), matching the existing 10g–40g per-dart convention;
  darts are never described by a summed set weight.
- `is_default` — one loadout per player can be flagged as the one pre-selected by
  default on the New Game screen, so a player who only ever throws one set of darts
  never has to actively pick a loadout at all.
- Total assembled dart length (barrel + shaft + flight `length_mm`, tip-to-flight-end)
  is a derived display value at render time, not stored — the usual "compute from raw
  data" preference already used elsewhere in this app (see the league-mode roadmap's
  identical reasoning for `league_players` tallies).

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
Loadouts"), styled as a CoD/Halo-style gunsmith screen:

- **Loadout Name** banner across the top, editable in place, with a **"Change
  Loadout"** button directly beneath it that opens the list of the player's other
  saved loadouts to switch between (Duplicate/Delete live in that list view, not
  cluttering the builder itself). Given how rarely players are expected to switch,
  this stays a plain button rather than a prominent always-visible switcher.
- A **centered dart illustration**, assembled live from the currently-selected
  components, with labeled callouts fanning out to either side on leader lines —
  flight-side callouts (Flight Material, Flight Shape, Shaft Length, Shaft Material,
  Shaft Type) grouped toward the flight end of the drawing, barrel/tip-side callouts
  (Barrel Length, Barrel Shape, Barrel Grip, Barrel Weight, Barrel Material, Tip
  Texture) grouped toward the point — the physical component ordering along the dart
  and the visual grouping of fields match.
- Each callout opens a dropdown (or, for barrel shape/grip and flight shape, a
  visual card picker showing the icon/diagram for each option, per the accessibility
  note below) scoped to that player's own saved components of that type, plus a "+"
  to add a new one inline.
- **Responsive behavior**: the side-callout layout assumes a wide frame. Below a
  mobile breakpoint, fall back to a single stacked column (dart image on top, all
  fields below it in one list) rather than trying to compress side callouts onto a
  phone screen.
- Below the builder: **this loadout's stats** (see "Stats" below) — scroll-down
  content on the same screen, not a separate page.
- **Quick-add full set**: a one-shot alternate entry form — one product name plus all
  barrel/shaft/flight/tip fields on a single screen — that creates all three
  underlying `dart_components` rows and the loadout itself in one save. This exists
  specifically to reduce the friction of the common case where someone bought a
  complete, unmodified set (e.g. a specific retail dart model) and just needs to type
  in its spec once rather than build it as three separate "add component" steps.

**Player Profile integration**: the profile page's existing "Dart Weight" row is
replaced by a **"Default Loadout"** selector — a dropdown of that player's saved
loadouts, picking one flags it `is_default` (same flag the New Game screen's
auto-selection reads). This is the only place `is_default` is set; the builder
screen itself doesn't duplicate a "Set as default" control. A PIN-protected
player's Default Loadout selector — and the Dart Builder screen generally — is
gated behind that player's PIN (see "Security" below).

**New Game integration**: a **"Change Loadout"** button next to each selected player
slot on the New Game screen (alongside the existing finish-rule/PIN affordances for
that player), opening a compact picker (same card style as the builder, but
selection-only — no editing) scoped to that player's own loadouts, defaulting to
their `is_default` loadout if one exists. Selecting a player with no loadouts yet
shows a "Build a loadout" shortcut into the Dart Builder screen instead of an empty
picker. Not selecting a loadout at all remains a fully valid, ungated path.

## 3. Stats

Per `CLAUDE.md`'s "every new calculation gets a committed test" convention, this adds
a genuinely new stat-scoping dimension, not just a new data field — but scoped more
narrowly than originally sketched:

- Loadout-specific stats live **only on the Dart Builder screen, for the loadout
  currently selected/open** — not as a general filter dropdown added to the Player
  Profile page. Opening a loadout shows that loadout's own averages, checkout %, and
  other existing per-game stats, scoped to games played with that
  `game_players.loadout_id`, by reusing the existing stats-query scope helper
  (`_scope()` in `backend/db.js`) with a loadout predicate alongside the existing
  game-type/practice/date-range ones, not a parallel stats pipeline.
- A **loadout comparison view** (stretch, not required for v1): side-by-side stat
  cards for two or more of a player's loadouts, reachable from the Dart Builder
  screen's loadout list rather than the Player Profile — since "which combination
  performs best for me" is the whole point of the feature and a single-loadout view
  alone still requires manually flipping between screens and remembering numbers to
  compare them.
- No new derived formula is being invented here (averages/checkout %/etc. already
  exist and are already tested) — the new logic needing a committed test is the
  *scoping* itself: a test proving that a game played under loadout A is correctly
  included/excluded from loadout A's/B's filtered stats.

## 4. Accessibility, security, and testing considerations

Per `CLAUDE.md`'s standing conventions:

- **Accessibility**: the builder's card-picker/drag-and-assemble interaction is
  inherently visual and needs a fully keyboard-operable equivalent from the start
  (arrow/tab through cards, Enter to select, not a pointer-only carousel), plus
  non-color ways to distinguish component shapes/materials/grips in the picker (icon +
  text label, not color-coded swatches alone) — per
  `docs/accessibility-roadmap.md`'s standing checklist. Barrel shape, barrel grip, and
  flight shape specifically need a visual diagram/icon per option (not just an enum
  text label), since terms like "torpedo," "knurled," or "kite" aren't
  self-explanatory by name to most players. The live-assembled dart preview should
  have a text-equivalent summary (e.g. an `aria-live` region stating "Barrel: [name],
  Shaft: [name], Flight: [name], Tip: [texture] — total Xmm") so a screen-reader user
  gets the same "what am I building" feedback a sighted user gets visually.
- **Security**: no new credential/token surface, but a new PIN-gated action: for a
  PIN-protected player, both **setting/changing their Default Loadout** (on the
  Player Profile page) and **opening the Dart Builder screen to customize their
  loadouts/components** (create, edit, or delete a component or loadout) require
  that player's PIN — reusing the existing `withPinCheck()` mechanism already used
  to gate PIN-protected players at New Game/tournament-match start (see
  `REFERENCE.md`'s "PIN gate" note), not a new check mechanism. Players without a
  PIN keep today's no-PIN-required behavior, same as every other PIN-gated action
  in the app. Read-only viewing of a loadout's stats from elsewhere (e.g. a
  loadout comparison view reached some other way) is not in scope for this gate —
  only the two mutating entry points above are.
- **Testing**: the loadout total-length derivation (sum of three component
  `length_mm` values) and the new stats-scoping predicate (which games count toward
  which loadout's filtered stats) both need committed, re-runnable `node:test`
  coverage in the same change that ships them — this is exactly the kind of "new
  calculation" the standing convention calls out, not a one-off manual check.

## Open questions for whoever picks this up

- Are the listed barrel shapes (straight/torpedo/ton) and grips (smooth/knurled/
  ringed) exhaustive enough, or are there other commonly-sold variants worth adding
  before this ships?
- Should shape/grip/material dropdowns be a strictly closed enum, or should each have
  an implicit "Other" that falls through to a free-text value? Real dart components
  occasionally deviate from common presets (obscure/boutique brands, discontinued
  shapes), and a fully closed dropdown risks a player not being able to enter their
  actual dart. Unresolved — needs a decision before the enum lists are finalized.
- Should `dart_components` support an optional photo/image upload per component (a
  real photo of the actual barrel) instead of just a generic shape/grip icon, given how
  visual the gunsmith-style framing is? Nice-to-have, not required for v1 — a
  shape+icon per fixed enum value is a much smaller lift and still delivers the
  "assembled dart preview" feel.
- Should loadouts be shareable/exportable (e.g. copy a friend's exact spec) or kept
  strictly private per player? No cross-player sharing mechanism exists elsewhere in
  the app today, so default to private-per-player unless there's specific demand.
- Does `dart_count` ever need to be *not* uniform (e.g. modeling a mismatched
  practice set) — or is defaulting it to 3 sufficient? Leaning toward the latter for
  simplicity, since it's now informational/display only, not a stat multiplier.
