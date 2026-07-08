# Dart Builder / Loadout Customization — Design Roadmap

> Status (2026-07): **✅ Every item resolved — archived.** v1 is fully built and playable end-to-end — schema
> (`dart_components`/`loadouts`, `game_players.loadout_id`), component/loadout CRUD
> with closed-enum validation, game-creation integration (barrel-weight snapshot into
> `game_players.dart_weight`, `players.dart_weight` retired as a write path), PIN-gated
> default-loadout + loadout-customization actions, per-loadout stats (games/wins/darts/
> 3-dart average/180s/checkouts), a Dart Builder screen (loadout list + editor), the
> Player Profile's "Default Loadout" selector (replacing the old Dart Weight dropdown),
> and the New Game screen's "Change Loadout" picker with auto-default selection. See
> `REFERENCE.md`'s Dart Builder section for full mechanics.
>
> **One deliberate UI simplification**: the builder ships as a stacked grouped-section
> form (Barrel/Shaft/Flight/Tip sections, each a plain dropdown), not the literal
> CoD/Halo-gunsmith illustration with fanning leader-line callouts sketched below —
> functionally equivalent and inherently mobile-responsive (no wide layout to collapse),
> but visually plainer than originally envisioned.
>
> **✅ Built (2026-07): the loadout comparison view** — a "⚖️ Compare Loadouts"
> button on the loadout list screen (shown once a player has 2+ loadouts) opens
> a side-by-side stats table (components, games/wins/win%/darts/average/180s/
> checkouts) for whichever loadouts are toggled on, reusing the existing
> `getLoadoutStats()` query per loadout — no new backend work. See
> `REFERENCE.md`'s "Loadout comparison view" note for full mechanics.
>
> **✅ Built (2026-07): the accessibility icon set and the quick-add form** —
> barrel shape, barrel grip, and flight shape now get a small hand-coded icon
> per option (an accessible toggle-button group, `aria-hidden` decorative SVGs,
> not a replacement for the text label) instead of text-only dropdowns; a "⚡
> Quick Add Full Set" screen lets a whole barrel+shaft+flight+loadout be entered
> and saved in one action instead of three separate "+ New {type}" round trips.
> See `REFERENCE.md`'s matching sections for full mechanics.
>
> **Optional photo upload per component — considered, explicitly dropped
> (2026-07)**, not built and not tracked further: it was always framed as an
> *alternative* to a generic shape/grip icon set, not additive to one, and the
> icon set above now covers that need. No open items remain, so this doc moves
> to `docs/archive/` per `CLAUDE.md`'s archiving convention.

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
- **Built differently than originally sketched here**: since `length_mm` stores a
  preset *range label* (e.g. `"medium"`) rather than a raw millimeter number, there's
  no numeric value to sum across barrel+shaft+flight — a "total assembled dart
  length" figure was dropped rather than built as a meaningless range-label
  concatenation. The Dart Builder screen shows each slot's own length label instead.

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

**Original design intent** (kept for reference, not what shipped): a Dart Builder
screen styled as a CoD/Halo-style gunsmith screen, with a centered dart illustration
and labeled callouts fanning out to either side on leader lines, each callout opening
either a dropdown or a visual card picker showing an icon/diagram per option.

**What actually shipped**: a plain stacked-section form — functionally equivalent,
visually plainer, and free of the "wide layout that needs a mobile fallback" problem
entirely, since a single column has nothing to collapse.

- **Loadout Name** banner across the top (a text input), editable in place, with a
  **"Change Loadout"** button directly beneath it that opens the list of the
  player's other saved loadouts (Edit/Duplicate/Delete live in that list view, not
  cluttering the builder itself). Given how rarely players are expected to switch,
  this stays a plain button rather than a prominent always-visible switcher.
- **Barrel / Shaft / Flight sections**, each a labeled group with a `<select>` of
  that player's existing components of that type, plus a "+ New {type}" button that
  opens a modal to create one on the fly (fields shown per type are driven entirely
  by `GET /api/dart-components/options`). **✅ Built (2026-07)**: the modal's
  barrel-shape, barrel-grip, and flight-shape fields are now an icon-button group
  instead of a plain `<select>` — see the accessibility note in section 4.
  A **Tip Texture** section (smooth/grooved) sits alongside them as a plain
  dropdown on the loadout itself, not a component.
- Below the three slots + tip texture: **this loadout's stats** (see "Stats" below)
  — scroll-down content on the same screen, not a separate page, appearing once the
  loadout has been saved (has an id).
- **✅ Built (2026-07): a "quick-add full set" one-shot entry form** — a "⚡ Quick
  Add Full Set" button on the loadout list opens a single screen with the
  loadout name plus every barrel/shaft/flight field (name, length, weight/type,
  material, shape/grip) and one Save button, instead of three separate "+ New"
  modal round trips followed by a fourth loadout-save step. No new backend
  endpoint — it's client-side orchestration of the same `createComponent()` ×3
  + `createLoadout()` calls the normal flow already makes, just sequenced
  behind one button. See `REFERENCE.md`'s matching section for full mechanics.

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
  Profile page, exactly as designed. **Built as its own query** (`getLoadoutStats()`
  in `backend/db.js`) rather than reusing `_scope()`: `_scope()` composes game-level
  dimensions (mode, game type), but a loadout selection lives on `game_players` (a
  per-player-per-game attribute, same shape as `dart_weight`/`out_mode`), so scoping
  by it needs a `game_players` join keyed on `(game_id, player_id)`, not another
  string appended to `_scope()`'s WHERE clause. Returns games played, wins, darts
  thrown, 3-dart average, 180 count, and checkout count — X01-scoped where relevant,
  same formulas `getPlayerStatBubbles()` already uses. No "checkout %" metric exists
  elsewhere in the codebase to reuse, so it wasn't invented here either — a plain
  checkout count is what shipped.
- A **loadout comparison view** (stretch, not required for v1) — **✅ Built
  (2026-07)**: a third `dartBuilderView` state (`'compare'`), reached from a
  "⚖️ Compare Loadouts" button on the loadout list screen (shown once a player
  has 2+ loadouts). No new backend query was needed — it calls the existing
  `getLoadoutStats()` once per loadout (in parallel), caches the results for
  the screen visit, and renders a side-by-side table (components, games, wins,
  win %, darts thrown, 3-dart average, 180s, checkouts) for whichever loadouts
  are toggled on. Every loadout is selected by default; toggling one on/off
  only re-renders from the cache, never re-fetches, since there's no way to
  mutate a loadout from within the compare screen itself. Win % is the one new
  presentational figure (`wins/gamesPlayed*100`, rounded) — deliberately not
  given its own committed test, the same untested-arithmetic treatment the
  roster page's existing win-rate chip already gets, since `wins`/`gamesPlayed`
  themselves are already covered by `getLoadoutStats()`'s own test coverage.
  Verified end-to-end with Playwright: two loadouts with genuinely different
  recorded games (a win vs. a loss, different darts/averages/180s/checkouts)
  render correct, distinct figures per column, and toggling a column off then
  back on correctly removes/restores it.
- No new derived formula was invented here (averages/180-count/etc. already exist
  and are already tested) — the new logic needing a committed test was the
  *scoping* itself: `backend/test/dart-builder.test.js`'s "getLoadoutStats —
  scoping" suite proves a game played under loadout A is correctly included in A's
  stats and excluded from B's, plus a regression test for a game with zero turns
  recorded still counting toward `gamesPlayed` (an early bug caught during
  end-to-end verification, fixed before shipping — see that same test file).

## 4. Accessibility, security, and testing considerations

Per `CLAUDE.md`'s standing conventions:

- **Accessibility — ✅ built (2026-07)**: the shipped builder uses plain
  `<select>` dropdowns rather than a card-picker/carousel for most fields, so
  full keyboard operability came for free (native `<select>` is
  keyboard-accessible by default) — no bespoke arrow/tab handling was needed.
  The one real standing gap — terms like "torpedo," "knurled," or "kite"
  aren't self-explanatory by name alone (`docs/accessibility-roadmap.md`'s
  checklist) — is now closed for the three fields it named (barrel shape,
  barrel grip, flight shape): each is an icon-button group instead of a plain
  `<select>`, built as a real accessible toggle-group (`role="group"`,
  per-button `aria-pressed`, the same pattern the Custom Cricket number picker
  already uses), not a native-select replacement that would have risked
  regressing keyboard support to gain the visual — every icon is
  `aria-hidden="true"` and each button's own text label is the accessible
  name, so meaning is never conveyed by the icon alone. Shaft's "Type" field
  (fixed/spinning) was never named in the gap and stays a plain `<select>`.
- **Security**: no new credential/token surface, but a new PIN-gated action: for a
  PIN-protected player, both **setting/changing their Default Loadout** (on the
  Player Profile page) and **opening the Dart Builder screen to customize their
  loadouts/components** (create, edit, or delete a component or loadout) require
  that player's PIN — reusing the existing `withPinCheck()` mechanism already used
  to gate PIN-protected players at New Game/tournament-match start (see
  `REFERENCE.md`'s "PIN gate" note), not a new check mechanism. Players without a
  PIN keep today's no-PIN-required behavior, same as every other PIN-gated action
  in the app. The loadout comparison view (built 2026-07) needed no separate
  gating decision — it's reachable only from inside the already-PIN-gated Dart
  Builder screen (the "🎯 Manage Loadouts" entry point above), so it inherits
  that same PIN check rather than needing one of its own; it's read-only (no
  mutating action of its own), consistent with only the two entry points above
  being the actual PIN-gated *actions*.
- **Testing**: the new stats-scoping predicate (which games count toward which
  loadout's filtered stats) needed committed, re-runnable `node:test` coverage in
  the same change that shipped it — this is exactly the kind of "new calculation"
  the standing convention calls out, not a one-off manual check. Built:
  `backend/test/dart-builder.test.js`'s "getLoadoutStats — scoping" suite proves a
  game played under loadout A is included in A's stats and excluded from B's.

## Open questions for whoever picks this up

- **Resolved for v1**: shape/grip/material/length-range dropdowns are a strictly
  closed enum (`getDartComponentOptions()` in `backend/db.js` is the single source
  of truth both client and server validate against) — no "Other" free-text escape
  hatch. Revisit if a real player's dart genuinely doesn't fit any listed option;
  the enum lists (`BARREL_SHAPES`/`BARREL_GRIPS`/`BARREL_MATERIALS`/etc. in
  `backend/db.js`) aren't claimed to be exhaustive, just a reasonable v1 set.
- Should `dart_components` support an optional photo/image upload per component (a
  real photo of the actual barrel) instead of just a generic shape/grip icon, given how
  visual the gunsmith-style framing is? **Resolved: dropped (2026-07)** — it was
  framed as an *alternative* to a generic icon set, not additive to one, and the
  icon set built alongside this decision (see section 4) already meets the need
  the photo idea was reaching for. Not tracked further.
- Should loadouts be shareable/exportable (e.g. copy a friend's exact spec) or kept
  strictly private per player? No cross-player sharing mechanism exists elsewhere in
  the app today, so default to private-per-player unless there's specific demand.
  Still open, not tracked as a separate item (no design work started).
- Does `dart_count` ever need to be *not* uniform (e.g. modeling a mismatched
  practice set) — or is defaulting it to 3 sufficient? Shipped as 3-default,
  informational/display-only (not a stat multiplier) — no evidence yet this needs
  revisiting.
