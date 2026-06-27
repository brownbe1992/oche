> **Note:** This project is vibe-coded using Claude. I am not a software developer.

---

# Oche

A self-hosted, per-dart darts scorer with real-time scoreboard, lifetime player statistics, and no external dependencies.

You enter every dart individually — multiplier first, then the number — and Oche tracks everything: 501 / 301 / 170 games in any legs-and-sets format, per-player double-out or single-out rules, 3-dart averages, checkout suggestions, hall-of-fame moments, and years' worth of per-player history. All data lives in a SQLite database on your own server.

---

## Contents

- [Running with Docker](#running-with-docker)
- [Running without Docker](#running-without-docker)
- [The App](#the-app)
  - [Home](#home)
  - [New Game](#new-game)
  - [Scoring](#scoring)
  - [Live Scoreboard](#live-scoreboard)
  - [Players](#players)
  - [Player Profile](#player-profile)
  - [Stats](#stats)
- [API Reference](#api-reference)
- [Architecture](#architecture)
- [Data Storage](#data-storage)

---

## Running with Docker

```bash
docker compose up -d --build
```

Then open **`http://<your-server>:8046`** in any browser. Every device on your network shares the same data automatically.

To stop: `docker compose down`. To update after changing files, re-run the same command.

The database is persisted in `./darts_data/darts.db` next to `docker-compose.yml`. Back it up by copying that folder.

### Dev environment

A separate compose file runs on port **8056** with its own isolated database:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

### Port

Change the port by editing `docker-compose.yml` — update both sides of `"8046:8046"` and the `PORT=` env var to the same number.

---

## Running without Docker

Requires **Node.js 22.5 or newer** (uses the built-in `node:sqlite` module).

```bash
node backend/server.js
```

Open `http://localhost:8046`. The database is created at the path in the `DARTS_DB` environment variable (defaults to `/data/darts.db`).

---

## The App

### Home

The landing page shows a live snapshot of all-time activity:

**Overview bubbles**
- Total darts thrown
- 180s thrown
- Big Fish (170 checkouts)
- Nine-dart finishes
- Ton+ finishes (100+ checkouts)
- Sets played
- Legs played
- Practice legs thrown

**H2H Leaderboard** — ranked stats across all head-to-head games:
- 3-dart average
- Top finish
- 180s
- Big Fish
- Treble-less visit percentage
- Wins (legs, sets, games by format)

**Practice Mode Leaderboard** — same stats for solo/practice sessions.

**Hall of Fame sections:**
- 🎯 **180s** — every player who has thrown a maximum, with count
- 🐟 **Big Fish** — every 170 checkout recorded
- **Nine-Dart Finishes** — 501 completed in exactly 9 darts *("None recorded yet — you will never get this!")*

---

### New Game

Configure a game before starting:

| Setting | Options |
|---|---|
| **Mode** | H2H (head-to-head) · Practice (solo) |
| **Format** | 501 · 301 · 170 |
| **Legs per set** | 1 – 9 |
| **Sets per game** | 1 – 9 |
| **Players** | Select from the roster (up to 6); H2H requires 2+ |
| **Finish rule** | Double out · Single out (set per player) |

H2H mode requires at least two players selected. Practice mode can be played solo or with others and is tracked separately from H2H statistics.

---

### Scoring

The scoring screen is optimised for touchscreen entry on a tablet. Everything fits on screen without scrolling, and all sizes scale dynamically to the device's viewport.

**Player cards** — shown at the top for every player in the game:
- Remaining score (large)
- Darts thrown this leg
- Leg average · game average
- Leg/set standing
- Active player is highlighted in gold with a "▸ throwing" tag
- Checkout route appears inline below the score when the player is on a finishing number

**Dart entry:**
1. Tap **Single**, **Double**, or **Treble** to set the multiplier
2. Tap a number (1–20), **Bull**, or **Miss**
   - *Double Miss* fills two dart slots; *Treble Miss* fills all three
3. After three darts (or a bust or checkout), tap **Enter turn**

**Controls:**
- **Undo dart** — remove the last dart entered
- **Miss** — register a missed dart (respects the current multiplier as a repeat count)
- **Enter turn** — commit the visit and advance to the next player

**Feedback:**
- Bust turns are flagged immediately in red; the turn still needs to be confirmed with Enter turn
- Checkout turns show "GAME SHOT!" in green
- The checkout suggestion updates dart-by-dart as you enter the visit

**Between legs/sets/games:** a summary card shows each player's leg average, darts thrown, and busts before the next leg begins.

---

### Live Scoreboard

Open **`http://<your-server>:8046/display`** on a TV or second monitor. It updates in real time via Server-Sent Events (SSE) — no refreshing needed.

**Top bar:**
- Game format and current leg/set
- 🎯 180s · 🐟 Big Fish · 💥 Busts for the current game (updates live)
- Live connection indicator

**Checkout strip** — appears prominently below the top bar whenever the active player is on a finishing number, showing the full route in large text (e.g. `T20 → T19 → D12`). Flashes when updated after each dart.

**Player cards** (one per player):
- Remaining score
- Darts thrown this leg
- Leg average · game average · leg/set standing
- Active player's card shows each dart thrown in the current visit
- Bust overlay (red) and Game Shot overlay (green) flash on the active card

**Between legs:** score cards are replaced with a leg summary — average, darts thrown, and busts per player — until the next leg starts.

**Leg/Set/Game banners:** full-screen result announced when a unit ends.

**Achievement overlays:** full-screen flash for 180s (🎯) and Big Fish (🐟) the moment they're scored.

**Score panel** (bottom-right): legs or sets won per player — hidden in practice mode.

The scoreboard is read-only and can be open on any number of screens simultaneously.

---

### Players

The Players screen shows all registered players with their current finish rule (double out / single out) and lifetime average.

Actions per player:
- **Rename** — changes the name everywhere, including all historical records
- **Delete** — permanently removes the player and all their data
- **Set finish rule** — double out or single out
- **View profile** — opens the full player profile page

Add new players from this screen.

---

### Player Profile

Each player has a dedicated profile page with full career statistics, accessible by clicking their name anywhere in the app.

#### Tabs

**Overall** · **H2H** · **Practice** — all stats and charts filter to the selected mode.

#### Stat Bubbles

Eleven stat bubbles across the top of the profile. Click any bubble to display that metric in the chart below.

| Bubble | Description |
|---|---|
| **Average** | 3-dart average across all visits |
| **180s** | Total 180s thrown |
| **Big Fish** | Total 170 checkouts |
| **9 Darters** | 501 legs finished in exactly 9 darts |
| **Trebleless %** | Percentage of visits without hitting a treble |
| **1st 3 AVG** | Average of the first visit of each leg |
| **1st 9 AVG** | Average of the first three visits of each leg |
| **100+ AVG** | Percentage of legs with a 100+ average |
| **90- AVG** | Percentage of legs with a 90 or lower average |
| **140/Leg** | Percentage of opening visits scoring 140 or more |
| **180s/Leg** | Ratio of 180s to total legs played |

#### Chart

A line chart showing the selected metric over time. Filters:

- **Period:** Today · Week · Month · Year · All time · Custom date range
- **Dart weight:** filter to games thrown with a specific dart weight (if recorded)

#### Top 10 Finishes

The player's ten highest checkouts — score, last date achieved.

#### Settings

- **Dart weight** — 15g through 30g; stored per-game for chart filtering
- **Clear stats** — reset H2H stats, Practice stats, or all stats (with confirmation)

---

### Stats

A summary table of all players showing:
- Legs, sets, games played
- 3-dart average
- Treble-less percentage
- Ton+ finishes (100+ checkouts)
- 180s
- Big Fish
- H2H wins by format

Plus global leaderboards for 180s, Big Fish, and nine-dart finishes, each filterable by mode.

---

## API Reference

All responses are JSON. The server runs on one port and serves both the frontend and the API.

### Health

```
GET  /api/health
```
Returns `{ ok: true }`.

### Players

```
GET    /api/players                         List all players
POST   /api/players                         Add a player          { name, out }
PUT    /api/players/rename                  Rename a player       { from, to }
PUT    /api/players/out                     Set finish rule       { name, out: "double"|"single" }
PUT    /api/players/dart-weight             Set dart weight       { name, weight }
GET    /api/players/dart-weights?name=      Dart weight history for a player
DELETE /api/players?name=                   Delete a player and all their data
DELETE /api/players/stats?name=&mode=       Clear stats for a player
                                             mode: "h2h" | "practice" | "all"
```

### Stats & Leaderboards

```
GET  /api/stats                             All player stats (full computed object)
GET  /api/summary                           Site-wide totals (darts, legs, 180s, etc.)
GET  /api/top-finishes?mode=                Top 10 checkouts across all players
GET  /api/stats/180s?mode=                  180 leaderboard
GET  /api/stats/big-fish?mode=              Big Fish (170 checkout) leaderboard
GET  /api/stats/nine-darters?mode=          Nine-dart finish leaderboard
```

All leaderboard endpoints accept `?mode=h2h|practice` to filter by game mode. Omit for overall.

### Per-Player Stats

```
GET  /api/players/stat-bubbles?name=&mode=  All 11 stat bubble values for a player
GET  /api/players/top-finishes?name=&mode=  Top 10 checkouts for a player
GET  /api/players/avg-history               Metric history for the chart
     ?name=
     &metric=avg|180s|bigfish|ninedarters|treblelesspct|
              first3avg|first9avg|avg100plus|avg90minus|score140pct|180sperleg
     &period=today|week|month|year|all|custom
     &start=YYYY-MM-DD   (required when period=custom)
     &end=YYYY-MM-DD     (required when period=custom)
     &weight=            (optional, grams — filter to a specific dart weight)
     &mode=h2h|practice  (optional)
```

### Games

```
POST /api/games                             Start a game
                                             { category, legsPerSet, setsPerGame,
                                               players: [names], practice: bool }
                                             → { gameId }

POST /api/games/:id/turns                   Record a visit
                                             { player, set, leg, scored,
                                               trebleLess, bust, checkout,
                                               checkoutPoints }

POST /api/games/:id/complete                Mark a game finished    { winner }

POST /api/games/:id/events                  Record a timeline event
                                             { type: "leg_start"|"leg_end"|
                                                      "set_start"|"set_end"|
                                                      "game_start"|"game_end",
                                               setNo, legNo }
```

### Live Scoreboard

```
GET  /api/live                              Current game snapshot (JSON)
POST /api/live                              Push a new snapshot (sent by the controller)
GET  /api/live/stream                       SSE stream — scoreboard subscribes here
```

The live state is held in memory only — it is never written to the database. On reconnect the scoreboard receives the latest snapshot immediately.

### Admin

```
POST /api/reset                             Wipe all games and turns (players kept)
```

---

## Architecture

```
oche/
├── backend/
│   ├── server.js      Dependency-free HTTP server (Node built-ins only)
│   └── db.js          SQLite schema, migrations, and all stat queries
├── frontend/
│   ├── index.html     The entire app — one self-contained HTML file
│   └── display.html   Read-only live scoreboard for a second screen
├── docker-compose.yml
├── docker-compose.dev.yml   Dev instance on port 8056
└── Dockerfile
```

**Backend** — a single `http.createServer` with no npm dependencies. Uses `node:sqlite` (built into Node 22.5+) in WAL mode with foreign keys enabled. All statistics are computed from raw turn data at query time — nothing is pre-aggregated, so stats are always consistent and new metrics can be added without migrations.

**Frontend** — a single HTML file with vanilla JavaScript and no build step. In API mode it talks to the backend; if opened directly as a file with no server it falls back to in-memory + localStorage so it still works as a demo.

**Live scoreboard** — the controller (`index.html`) POSTs the full game state to `/api/live` after every dart and every turn. The scoreboard (`display.html`) subscribes to `/api/live/stream` (Server-Sent Events) and re-renders on every push. A 25-second heartbeat keeps the connection alive through proxies.

**Database schema:**

| Table | Purpose |
|---|---|
| `players` | Name and double/single-out preference |
| `games` | One row per match; includes format, category, practice flag, winner |
| `game_players` | Who played in each game; stores dart weight used |
| `turns` | Every visit: score, bust flag, treble-less flag, checkout flag |
| `timeline_events` | Leg/set/game start and end timestamps |

Schema changes are applied with `ALTER TABLE ... ADD COLUMN` wrapped in try/catch — idempotent, so the database auto-migrates on startup without wiping data.

---

## Data Storage

All data is in a single SQLite file. With Docker it lands at `./darts_data/darts.db` on the host.

- **Backup:** copy the `darts_data` folder
- **Migrate to a new server:** copy the folder across and start the container
- **Nothing leaves your network** — no cloud sync, no telemetry, no accounts
