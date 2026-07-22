Status: Not started — design + migration plan drafted, per the owner's explicit
"do not make any changes" instruction for the audit itself. Nothing in this
document has been implemented; `backend/db.js`'s live schema is untouched.

# Database normalization audit + 3NF redesign + migration plan

## 0. Verdict up front

**The schema, as it stands today, is already in third normal form in the
classical/practical sense.** Every table's non-key attributes depend on the
whole key and nothing but the key, once you separate two things that look
alike but aren't:

- **Legitimate per-row facts that happen to duplicate a value elsewhere at
  the moment they're written**, e.g. `game_players.dart_weight`/`out_mode`/
  `start_score`/`loadout_id`, `games.player_count`, `tournaments.player_count`.
  These are historical snapshots — "what was true about this participation/
  game at the moment it happened" — not derived values that must always
  track another table's *current* state. This is the same textbook pattern
  as `order_items.price_at_purchase` in a catalog with prices that change
  over time: storing it isn't a normalization bug, it's the only way to keep
  history honest once the source value can drift. Several of these are
  already deliberately engineered this way and documented as such in
  `db.js`'s own comments (see `player_count`'s comment: recomputing it live
  would let deleting a participant retroactively reclassify a finished H2H
  game as solo).
- **Two genuinely redundant, derivable-from-another-table caches**:
  `turns.checkout_points` and the `category` column on `games`/`tournaments`/
  `leagues` (for X01 rows, where it duplicates `config.startingScore`). These
  *are* the textbook "materialized aggregate" shape 3NF purism forbids, but
  they're deliberate, already-labeled performance caches (`turns.checkout_points`:
  "kept as performance cache for ton+/Big Fish queries"), never independently
  writable after creation, so they can never drift from the value they cache.
- **One real structural finding**: `games.config` (and `leagues`/`tournaments`
  reusing `category` for two unrelated meanings depending on `game_type`) is a
  JSON blob whose keys vary by `game_type` — `startingScore` for X01,
  `mode`/`pinnedTarget` for Checkout Trainer, `targets` for Halve-It,
  `numbers` for Killer, `rounds` for Gauntlet, and so on. That's a repeating/
  variant group packed into one `TEXT` column — a genuine 1NF violation under
  strict relational theory, not just a cache.

Given the instruction to redesign if any part isn't in 3NF: **Section 3 below
is the full strict redesign**, covering all three finding categories,
including the two that are debatable engineering tradeoffs rather than bugs.
Section 4 is the migration plan for it, written so it can run with zero data
loss and a clean rollback. **Recommendation: implement Section 3.1
(drop the two dead-weight cache/duplicate columns) — it's cheap, safe, and
removes a real (if low-risk) drift surface. Hold off on Section 3.2 (splitting
`config` into per-game-type tables) until asked** — it's the correct
textbook answer, but it is a large, invasive rewrite of most read paths in
`db.js` (every `json_extract(g.config, ...)` call site, ~40+ of them) for a
benefit that is purely theoretical purity: `config` is never independently
queried by anything outside this app, never hand-edited, and every write goes
through `createGame()`'s single choke point already. This tradeoff is spelled
out fully in 3.2 so the owner can decide with full information instead of me
deciding it for them.

## 1. Methodology

Audited every `CREATE TABLE` and `ALTER TABLE ... ADD COLUMN` statement in
`backend/db.js` (lines 56–608, the full schema block — 25 tables, 2 of them
column-only extended by 30+ `ALTER TABLE` migrations already baked into the
same file), then, for every column that looked like it could be derived from
another table, traced every read site (`json_extract`, the relevant
`db.prepare` calls) to check (a) whether the value is actually recomputed
anywhere at read time from the "source" data (making the stored column truly
redundant) or (b) whether it's a write-once fact frozen at creation that
`db.js`'s own comments explicitly say must stay frozen even after the source
data changes (making it a legitimate distinct attribute, not a violation).
No schema or data changes were made — this file is the complete output of
that audit.

## 2. Full table inventory and normal-form classification

| Table | 1NF | 2NF | 3NF | Notes |
|---|---|---|---|---|
| `players` | ✅ | ✅ | ✅ | `pin_hash`/`pin_salt`/`pin_fail_count`/`pin_locked_until` are all independently-dependent facts about the player row, not derived from each other. |
| `games` | ⚠️ | ✅ | ⚠️ | `config` (JSON, 1NF finding, §3.2); `category` duplicates `config.startingScore` for X01 (§3.1); `player_count` is a legitimate frozen snapshot, not a violation. |
| `game_players` | ✅ | ✅ | ✅ | Composite PK `(game_id, player_id)`; every column (`out_mode`, `dart_weight`, `loadout_id`, `start_score`, `dnf`) is a genuine fact about *this* participation, fully dependent on the whole composite key — snapshotting a player's settings here is correct 2NF/3NF, not a violation (a player's live `dart_weight` can change after the game; this column intentionally does not track that). |
| `turns` | ✅ | ✅ | ⚠️ | `checkout_points` is a derivable cache (§3.1); everything else (`scored`, `bust`, `checkout`, `leg_won`, `target_score`, `declared_unsolvable`, `affected_player_id`, `declared_hit`) is a genuine per-turn fact, not derivable from other turns/darts. |
| `darts` | ✅ | ✅ | ✅ | `scored`/`is_treble`/`is_double` are SQLite `GENERATED ALWAYS ... STORED` columns computed only from `sector`/`multiplier` **in the same row** — a persisted computed column with a same-row-only dependency isn't a normalization violation (SQLite guarantees it can never drift), it's the engine doing the "derive it instead of duplicating it" work for us. |
| `timeline_events`, `server_errors`, `settings`, `admins`, `sessions` | ✅ | ✅ | ✅ | `settings` is a deliberate generic key/value store (app config), not an entity to normalize further — there's no multi-column record here to split. |
| `player_badges` | ✅ | ✅ | ✅ | `UNIQUE(player_id, badge_id)`; `count`/`earned_at` both depend on that pair. `badge_id` is a natural-key string (defined in code, not a DB-stored lookup table) — fine, same pattern as any enum-as-text column. |
| `daily_challenge_attempts` | ✅ | ✅ | ✅ | `target`/`result_darts`/`completed` all depend on the specific attempt (`id`), not on each other. |
| `tournaments` | ⚠️ | ✅ | ⚠️ | Same `category` overload as `games` (§3.1). `player_count` is frozen-by-design (bracket shape depends on it) — not a violation, same reasoning as `games.player_count`. |
| `tournament_players`, `tournament_rounds` | ✅ | ✅ | ✅ | — |
| `tournament_matches` | ✅ | ✅ | ✅ | `is_bye` looked at first like it might be redundant with `player1_id`/`player2_id` nullability, but it isn't: both slots can also be legitimately `NULL` while a match is *waiting* on a previous round's winner (not yet a bye, not yet fillable) — `is_bye` captures information nullability alone can't. |
| `leagues` | ⚠️ | ✅ | ⚠️ | Same `category` overload (§3.1). |
| `league_players`, `league_fixtures`, `saved_games` | ✅ | ✅ | ✅ | — |
| `dart_components` | ✅ | ✅ | ✅ | `type` gates which of `length_mm`/`weight_g`/`material`/`shape`/`grip` are meaningful (e.g. `grip` only applies to barrels) — a "single table, multiple subtypes" design smell some schemas split into `barrels`/`shafts`/`flights` tables, but every column is still independently dependent on `id` alone, so it's not a 2NF/3NF violation, just a stylistic option. Noted, not changed. |
| `loadouts`, `ghost_races`, `player_uuid_aliases`, `marathon_sessions`, `marathon_session_legs` | ✅ | ✅ | ✅ | `ghost_races.result` is *usually* derivable by comparing `human_darts`/`ghost_darts`, but ties/edge cases mean it can encode a decision the raw counts don't — left as-is, not a confirmed violation. |

## 3. Redesign to strict 3NF

### 3.1 Drop the two genuinely redundant columns (recommended — low cost, low risk)

**`turns.checkout_points`** — always equal to the `scored` value of the
checkout-marked dart in that turn's `darts` rows. Replace every read site
(ton+/Big Fish/toughest-checkout queries, `q(...checkout_points...)` in
`getPlayerStatBubbles()` and friends) with the equivalent
`(SELECT d.scored FROM darts d WHERE d.turn_id = t.id ORDER BY d.dart_no DESC LIMIT 1)`
subquery, or a `checkout_darts` covering index if that subquery shows up in
`EXPLAIN QUERY PLAN` as a hot path. Drop the column.

**`games.category` / `tournaments.category` / `leagues.category`** for X01
rows — duplicates `CAST(json_extract(config,'$.startingScore') AS TEXT)`.
Two options, in order of preference:
1. Keep `category` only for non-X01 game types (Cricket's two label strings,
   which have no equivalent `config` field to derive from) and compute the
   X01 label at read time wherever it's displayed — mechanical but touches
   every `category` display site.
2. Leave `category` as a generated column:
   `category TEXT GENERATED ALWAYS AS (CASE WHEN game_type='x01' THEN CAST(json_extract(config,'$.startingScore') AS TEXT) ELSE <stored label> END)` —
   not possible as a single clean `GENERATED` expression for the non-X01 case
   without a second real column to fall back to, so this collapses back to
   option 1 in practice.
Given `docs/code-quality-roadmap.md` item 41 already closed the write-side
risk (every `GAME_TYPES` entry now derives its own `category` value instead
of a fallthrough ternary that could silently write garbage), the remaining
exposure here is purely "two columns instead of one," not "wrong values" —
lower urgency than `checkout_points`.

### 3.2 Split `games.config` into per-game-type tables (textbook-correct, NOT recommended to actually run without a separate go-ahead)

Strict 1NF says a column can't hold a value whose internal shape varies row
to row. `config` currently does, keyed off `game_type`. The fully-normalized
form is one child table per game type that *uses* `config`, each with a
proper `game_id` FK, only the columns that type actually needs, and NOT NULL
where the field is mandatory for that type:

```sql
CREATE TABLE x01_game_config (
  game_id        INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  starting_score INTEGER NOT NULL
);
CREATE TABLE checkout_trainer_config (
  game_id       INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL,
  pinned_target INTEGER
);
CREATE TABLE halve_it_config (
  game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  targets TEXT NOT NULL   -- still JSON: an ordered list is a genuine repeating
                          -- group 3NF has no flat-column answer for; this is
                          -- the one place a JSON column is the correct
                          -- normalized-adjacent choice, not a violation —
                          -- see "Where JSON is fine" below.
);
CREATE TABLE killer_config (
  game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  numbers TEXT NOT NULL   -- same reasoning: per-player assigned-number map.
);
CREATE TABLE gauntlet_config (
  game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  rounds  TEXT NOT NULL
);
-- ...and one more per remaining config-bearing game_type (dead_man_walking,
-- pressure_chamber's card generation seed, etc. — every case currently
-- reached via json_extract(g.config, ...) in db.js).
```

**Where JSON is still fine even under this redesign**: `halve_it_config.targets`
and `killer_config.numbers` are *ordered lists*/*maps keyed by a value that
isn't itself a table row* — genuine repeating groups that 3NF's flat-column
model has no answer for without an unbounded number of extra join tables
(`halve_it_target_rounds(game_id, round_no, sector, ring)`, which is more
"correct" still and is the actual textbook answer if taken all the way).
Whether to go that far is a judgment call, not a normalization requirement —
noted here so the choice is explicit rather than silently stopping halfway.

**Why this is not recommended to actually build right now:**
- `config` has exactly one writer (`createGame()`) and is only ever read via
  `json_extract()` — there is no drift risk from a second write path, unlike
  the classic "JSON blob edited from two places" failure mode 1NF violations
  usually protect against in real incidents.
- The migration touches roughly 40 read call sites across `db.js`
  (every `json_extract(g.config, ...)` occurrence) plus every place that
  constructs `config` at game creation (one per `GAME_TYPES` entry, per item
  41's own registry). That's a much larger, much higher-regression-risk
  change than anything else in this document, for a benefit that is purely
  theoretical (schema purity) rather than a fixed bug or measured
  performance win.
- CLAUDE.md's own standing convention is "don't add complexity beyond what's
  needed" / "don't design for hypothetical future requirements" — a config
  shape that already works, has one writer, and has never caused a
  reported data-integrity bug is exactly the case that convention argues
  against rewriting speculatively.

If a future concrete need arises (e.g. wanting to query "all games with
`targets` containing sector 20" efficiently, which `json_extract` can't index
today), §3.2 is the correct direction to reach for then — this document just
avoids doing it now as a solution in search of a problem.

## 4. Migration plan (zero data loss)

This plan covers §3.1 only (the recommended piece). If §3.2 is ever
greenlit separately, it needs its own migration plan sized to that much
larger blast radius — sketched at the end of this section for completeness,
not meant to be executed as part of this pass.

### 4.1 Pre-migration safety net

1. Call the existing `createBackup()` (`backend/backup-lib.js`) to snapshot
   `data/darts.db` before touching anything — this is the same mechanism
   Settings' "Backup now" button already uses, so it's a tested path, not a
   new one invented for this migration.
2. Keep that backup until step 4.4's verification passes. Do **not** delete
   or prune it automatically as part of the migration script — a human
   confirms the migration is good, then normal backup retention (`docs/`-
   documented `BACKUP_RETENTION_DAYS`) takes back over.

### 4.2 Migrate `turns.checkout_points` off

Since the value already exists in `darts` for every historical row (the
checkout dart's `scored` is generated from `sector`/`multiplier`, which have
been recorded since the `darts` table existed), **no backfill is needed at
all** — this is a pure "stop reading/writing a column" migration with zero
data movement:

1. Add the replacement subquery (or a `checkout_darts` view, if `EXPLAIN
   QUERY PLAN` shows the correlated subquery form is too slow at real data
   volumes — profile before assuming either way) to every current
   `checkout_points` read site: `getPlayerStatBubbles()`'s Big Fish/toughest
   checkout queries, any Personal Bests query referencing it, and CSV
   export (`backend/test/db.export-csv.test.js` already has fixtures
   exercising this column — the same fixtures double as the test that the
   subquery form returns identical values).
2. Ship that change and run the full test suite (currently 1268 tests) —
   every existing assertion that reads `checkout_points`-derived stats must
   produce byte-identical results before and after, since the subquery is
   mathematically the same value, not a new formula.
3. Only once every read site is migrated and tests are green: drop the
   `insertTurn` statement's `checkout_points` parameter and the column
   itself via `ALTER TABLE turns DROP COLUMN checkout_points;` (SQLite
   3.35+ supports `DROP COLUMN` directly — confirm the Node `node:sqlite`
   build in use supports it before relying on it; if not, the standard
   SQLite fallback is: create `turns_new` without the column, `INSERT INTO
   turns_new SELECT <every column except checkout_points> FROM turns;`, drop
   `turns`, rename `turns_new` to `turns`, recreate `idx_turns_player`/
   `idx_turns_game`, all inside one transaction).
4. This step is fully reversible up to the `DROP COLUMN`: the column is
   never trusted for anything until every reader is switched, so a
   half-migrated state is inert, not corrupting.

### 4.3 Migrate `games.category`/`tournaments.category`/`leagues.category` duplication

Since `category` already holds the correct value for every existing row
(item 41 guarantees this going forward; historical rows were written by the
same "starting score as a string" logic before item 41 existed, so they
already agree with `config.startingScore` too — spot-check this assumption
in step 1 below before trusting it for the whole table):

1. Run a one-time read-only reconciliation query before changing anything:
   `SELECT id, category, json_extract(config,'$.startingScore') AS cfg FROM games WHERE game_type='x01' AND category != CAST(json_extract(config,'$.startingScore') AS TEXT);`
   Any row this returns is a **pre-existing data-integrity issue**
   independent of this migration (the two columns already disagree) — those
   specific rows need a human decision (which value is actually correct?)
   before the migration proceeds, not an automatic pick-one.
2. Once that query returns zero rows: repoint every X01 `category` display
   site to read `config.startingScore` instead (mirrors 4.2's "migrate
   readers first" ordering).
3. Cricket/other non-X01 rows keep `category` as their only source (no
   `config` equivalent exists for them) — no column removal for those game
   types, since there's nothing to deduplicate there.
4. `tournaments`/`leagues` are both **always** X01-or-Cricket in the same
   shape `games` uses (see their own schema comments) — apply the identical
   reconciliation-then-repoint sequence to each independently, since they're
   separate tables with separate historical write paths that could in
   principle have drifted independently even if `games` didn't.

### 4.4 Verification

1. Full `node --test` suite green (currently 1268 tests) after each of 4.2
   and 4.3 — before AND after the column drop in each, not just at the end.
2. A row-count and checksum comparison between the pre-migration backup and
   the live DB for every table NOT touched by this migration (`players`,
   `darts`, `game_players`, etc.) — confirms the migration script touched
   only what it said it would.
3. Manually re-run the reconciliation query from 4.3 step 1 post-migration
   (should now be structurally impossible, since the column is gone) as a
   final sanity check that nothing silently reintroduced the duplicate.

### 4.5 Rollback

Because 4.2/4.3 never delete source data (darts rows, config JSON) — only a
cache/duplicate column derived from it — rollback at any point before the
final `DROP COLUMN`/table-rebuild step is simply "stop deploying the new
code," since the old column is still present and correct throughout. After
the drop, rollback is restoring the pre-migration backup taken in 4.1 (same
restore flow Settings' "Restore backup" already exercises) — by construction
that backup predates any destructive step, so it always contains a fully
intact, un-migrated database.

### 4.6 (Sketch only, not sized for execution) §3.2's migration shape

Would need, per game type: (1) add the new child table, (2) backfill every
existing `games` row's relevant `config` keys into it in a single
transaction (a straightforward `INSERT INTO x01_game_config SELECT id,
CAST(json_extract(config,'$.startingScore') AS INTEGER) FROM games WHERE
game_type='x01'` per type), (3) migrate every one of the ~40 read call
sites to join the new table instead of `json_extract`, (4) migrate the ~14
`GAME_TYPES`-registry `category`/construction call sites that build `config`
today to insert into the new table(s) instead, (5) only then drop `config`
itself. Steps 3–4 are the real cost — each is a small, mechanical, but
individually-verifiable change, multiplied by every game type, which is why
this is deliberately left unscheduled rather than estimated as "one PR."

## 5. Open questions for the owner

1. Approve running §3.1 (checkout_points + category dedup) as a standalone
   follow-up change? It's the only piece of this document recommended for
   near-term execution.
2. Is §3.2 (splitting `config` into per-game-type tables) wanted at all, ever
   — or is the current single-writer JSON blob an acceptable permanent
   design given it has never caused a real bug? If wanted, it should be
   scheduled as its own dedicated, separately-tracked effort given its size,
   not bundled with §3.1.
