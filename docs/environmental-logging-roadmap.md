# Environmental Data Logging — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

## Goal

Optionally log ambient temperature and humidity (sourced from Home Assistant) against
every turn recorded, so 3-dart average can later be compared across different
environmental conditions. Niche feature, off by default, manually enabled in Settings.

## Decisions made (2026)

| Decision | Choice |
|---|---|
| Polling scope | Only while a game is actively in progress (starts on game start, stops on game end/abandon) — no background polling when idle |
| Analysis presentation | Both: bucketed averages (table/bar chart by range) **and** a scatter plot (temp/humidity vs. 3-dart average) |

## Why this is a bigger shift than it first looks

The existing Home Assistant integration (`db.js`'s `fireHaWebhook`) is **outbound only**
— Oche POSTs to HA webhooks when events happen, and HA's webhook trigger needs no
authentication. Pulling sensor data *from* HA is the opposite direction and requires
Home Assistant's REST API (`GET /api/states/<entity_id>`), authenticated with a
**Long-Lived Access Token** sent as a Bearer header.

That token is a meaningfully sensitive credential — HA long-lived tokens are typically
scoped to the whole account, not limited to reading two sensors — so it needs more
careful handling than the existing plain `ha_url` setting:

- Store it server-side only, in the `settings` table like other HA config.
- **Never** return it in `GET /api/settings` — that endpoint currently returns all
  settings as-is; this field needs to be redacted/write-only, similar in spirit to how
  player PINs are hashed rather than stored/returned in plaintext.
- The poll itself must happen in `db.js`/`server.js`, never client-side in
  `index.html` — exposing the token to the browser would defeat the point of keeping
  it server-side.

## Polling strategy

Rather than querying HA on every single turn (adds network latency to the scoring
loop, and hammers HA for values that barely change dart-to-dart), the backend polls HA
on a fixed interval (~30–60s, TBD) **only while a game is in progress**, caching the
latest reading in memory (similar in spirit to the existing in-memory `liveState` used
for the live scoreboard channel). Every turn recorded during that window is tagged
with whatever the most recent cached reading is. Many consecutive turns will share a
reading between polls — that's fine, since temperature/humidity don't meaningfully
change turn-to-turn.

Polling starts on game start (`POST /api/games`) and stops on game end/abandon, so
there's zero background chatter to the user's HA instance when nobody's playing.

## Data model

New table, fully additive — no changes to `turns`:

**`turn_conditions`** — `turn_id (FK → turns, ON DELETE CASCADE), temperature, humidity, recorded_at`

Kept separate from `turns` rather than adding nullable columns there, matching how the
`darts` table was split out on its own rather than bloating an existing table — this
feature is niche/opt-in and should cost nothing for installs that never enable it.

## Settings

New "Environmental Logging" section (nested under/near the existing Home Assistant
Integration section):

- **Enable environmental logging** — off by default.
- **Temperature entity ID** — e.g. `sensor.living_room_temperature`.
- **Humidity entity ID** — e.g. `sensor.living_room_humidity`.
- **Home Assistant API token** — write-only field, masked, never returned by
  `GET /api/settings`.
- **Test connection** — mirrors the existing `POST /api/ha-test` pattern, but actually
  fetches both entities' current state and shows the live reading (e.g. "21.4°C, 47%
  humidity") to confirm the entity IDs and token work before relying on it during play.

## Analysis UI

- **Bucketed averages** — groups turns into temperature ranges (e.g. <15°, 15-20°,
  20-25°, 25°+) and humidity ranges, shows 3-dart average per bucket as a table/bar
  chart. Reuses the existing stat-bubble/leaderboard rendering patterns already in the
  codebase — the cheaper of the two views to build.
- **Scatter plot** — individual turns or legs plotted with temperature (or humidity)
  on one axis and 3-dart average on the other. This is a genuinely new chart type; the
  app's current chart (`avg-history` / `STAT_DEFS`-driven) is time-series only, so this
  needs its own small charting routine rather than reusing the line-chart code.
- Both live as a new "Conditions" section on the player profile page, only rendered
  once a player has at least one turn with recorded conditions — same gating pattern
  already used for Personal Bests and Dart Analytics.

## Practical caveats

- **No backfill** — only captures data going forward from whenever it's enabled;
  there's no way to retroactively know the conditions during past games.
- **Fail-open** — if HA is unreachable mid-game, turns are just recorded without a
  `turn_conditions` row. The scoring loop must never wait on or fail because of this.
- **Single location assumption** — one global temp entity + one global humidity
  entity, matching the app's existing single-instance-per-location design. Not worth
  over-engineering for multiple boards/rooms unless that becomes a real ask.

## Suggested build order

1. Settings + token storage (write-only, redacted on read) + `POST /api/ha-env-test`
   connection check — no data collection yet, just prove the HA read path works and
   the token stays server-side.
2. Backend polling loop (game-start/game-end triggered) + `turn_conditions` table +
   tagging turns on write.
3. Bucketed-average analysis view on the player profile.
4. Scatter plot view.

## Open questions for whoever picks this up

- Polling interval: is 30–60s the right cadence, or should it be configurable?
- Should bucket boundaries (temperature/humidity ranges) be fixed, or
  admin-configurable in Settings?
- Fahrenheit vs Celsius — read directly from whatever unit HA reports, or normalize /
  let the user choose a display unit?
