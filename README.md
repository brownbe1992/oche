## NOTICE

This project is completely vibe-coded using Claude Opus 4.8. I am not a software developer.

---

# Oche

A per-dart darts scoring app with saved player profiles and lifetime statistics,
stored in a real database (SQLite) on your own server.

You enter every dart individually (single / double / treble, then the number),
it tracks 501 / 301 / 170 games with per-player double-out or single-out, and it
keeps each player's 3-dart average, 100+ checkouts, treble-less turns, and games
& legs played — across every match you play.

---

## Running it (Docker)

This is designed to run the same way as a typical Docker app on a home server
(Unraid, Synology, a Raspberry Pi, a NAS, or just a PC with Docker).

1. Put this whole folder on your server.
2. Open a terminal in the folder and run:

   ```
   docker compose up -d --build
   ```

3. Open **http://<your-server-address>:8046** in any browser (phone, tablet,
   laptop — they'll all share the same data because it lives on the server).

That's it. To update after changing files, run the same command again. To stop
it: `docker compose down`.

### Scoreboard on a second screen

There's a separate, read-only **scoreboard** page meant for a TV or monitor in
the room. Open it on that screen at:

**http://<your-server-address>:8046/display**

Use your iPad as the controller (the normal app) to enter scores, and the
scoreboard updates **in real time** — current scores, whose turn it is, the
darts thrown so far in the visit, the checkout suggestion, and leg/set
standings. When a leg, set, or match is won, the scoreboard flashes the result.

The scoreboard is a viewer only; it never changes anything. You can open it on
as many screens as you like. It needs the server running (it won't work from a
loose file), which is the normal Docker setup anyway.

If you'd rather use a different port, change the two `8046` numbers in
`docker-compose.yml` (use the same number in both halves of `"8046:8046"` to
keep things simple, e.g. `"9000:9000"` plus `PORT=9000`).

### Running without Docker

You need **Node.js version 22.5 or newer** installed. Then:

```
cd backend
npm start
```

and open http://localhost:8046. The database file will be created at
`darts-app/data/darts.db`.

---

## Where your data lives

All data is stored in a single SQLite database file. With Docker, that file is
on your server at **`darts_data/darts.db`** (the `darts_data` folder next to
`docker-compose.yml`).

**To back it up**, just copy that `darts_data` folder somewhere safe. To move to
a new server, copy the folder across. Nothing is sent to the internet — the data
stays entirely on your machine.

---

## How it's built (for the curious)

- **`frontend/index.html`** — the whole app (one file). It talks to the backend
  over a small web API. If you open this file on its own with no backend running,
  it still works as a demo and saves to your browser instead.
- **`frontend/display.html`** — the read-only scoreboard for a second screen. It
  listens for live updates from the server and just displays them.
- **`backend/server.js`** — a tiny web server (built only from Node's standard
  library) that serves the app and the API on one port.
- **`backend/db.js`** — the database layer. It defines the tables and computes
  all statistics with SQL queries.

The database is **normalized and event-based**: it stores every turn you throw,
plus the games and players, and works out the averages and counts on demand.
Because nothing is pre-totalled, the statistics can never drift out of sync, and
new kinds of stats can be added later without changing how the data is stored.

Tables: `players` (name + double/single-out preference), `games`, `game_players`
(who played in each game), and `turns` (every visit to the oche, with its score
and whether it was a checkout / bust / treble-less).

### The API, briefly

```
GET  /api/health
GET  /api/players                     list players
POST /api/players                     add a player           { name, out }
PUT  /api/players/rename              rename                 { from, to }
PUT  /api/players/out                 set finish rule        { name, out }
DEL  /api/players?name=...            delete a player
GET  /api/stats                       computed stats per player
POST /api/games                       start a game           { category, legsPerSet, setsPerGame, players }
POST /api/games/:id/turns             record one turn
POST /api/games/:id/complete          finish a game          { winner }
POST /api/reset                       clear all games/turns (players are kept)
GET  /api/live                        current live game snapshot (for the scoreboard)
GET  /api/live/stream                 live updates pushed to the scoreboard (SSE)
POST /api/live                        controller posts the current game state here
```

---

## Requirements

- Docker (recommended), **or** Node.js 22.5+.
- No other dependencies — the backend installs nothing.
