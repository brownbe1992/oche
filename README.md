> **Note:** This project is vibe-coded using Claude. I am not a software developer.

---

# Oche

A self-hosted, per-dart darts scorer with real-time scoreboard, lifetime player statistics, and no external dependencies.

**v0.7.0**

You enter every dart individually — multiplier first, then the number — and Oche tracks everything: 501 / 301 / 170 games in any legs-and-sets format, per-player double-out or single-out rules, 3-dart averages, checkout suggestions, an [18-badge achievement system](#achievements--badges) with a per-player Badge Case, a Wordle-style [Daily Challenge](#daily-challenge), and years' worth of per-player history. All data lives in a SQLite database on your own server.

---

## Contents

- [Running with Docker](#running-with-docker)
- [Running without Docker](#running-without-docker)
- [The App](#the-app)
  - [Home](#home)
  - [New Game](#new-game)
  - [Scoring](#scoring)
  - [Achievements & Badges](#achievements--badges)
  - [Daily Challenge](#daily-challenge)
  - [Shareable Moments](#shareable-moments)
  - [Live Scoreboard](#live-scoreboard)
  - [Players](#players)
  - [Player Profile](#player-profile)
  - [Stats](#stats)
  - [Settings](#settings)
- [Admin Accounts & Player PINs](#admin-accounts--player-pins)
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

**Hero stats:** Total darts thrown · 180s · Big Fish · 9-Darters *(shown even at zero, with an empty-state prompt, since it's the rarest feat in the game)*

**Activity:** Players · Games played · Sets played · H2H legs thrown · Practice legs thrown

**Achievements:** Ton+ finishes (100+ checkouts) · 180s · Big Fish · Highest checkout ever recorded

**This week / Last game played** — legs thrown today and this week, darts thrown this week, and a summary of the most recently completed game (players, category, winner, and when).

**H2H / Practice toggle** — switches the leaderboards below between head-to-head and solo/practice stats:
- 3-dart average leaderboard
- Most Wins (win rate) — H2H only
- Most Trebleless Visits
- Ton+ Finish Rate
- Highest Checkout Ever (within that mode — the "Highest checkout ever recorded" figure in Achievements above is separate and always all-time)
- Average Pace (darts/minute) — appears once dart-timing data exists, see [Settings](#settings)

**Hall of Fame sections:**
- 🎯 **180s** — every player who has thrown a maximum, with count and most recent date
- 🐟 **Big Fish** — every 170 checkout recorded
- **Nine-Dart Finishes** — 501 completed in exactly 9 darts *("None recorded yet — you will never get this!")*

A **"View full stats glossary"** link opens a shared reference explaining every stat term used across the app.

---

### New Game

Configure a game before starting:

| Setting | Options |
|---|---|
| **Mode** | H2H (head-to-head) · Practice (solo) · 🎯 Daily Challenge |
| **Format** | 501 · 301 · 170 |
| **Legs per set** | 1 – 9 |
| **Sets per game** | 1 – 9 |
| **Players** | Select from the roster (up to 6); H2H requires 2+ |
| **Finish rule** | Double out · Single out (set per player) |

H2H mode requires at least two players selected. Practice mode can be played solo or with others and is tracked separately from H2H statistics.

Players with a PIN set show a 🔒 next to their name in the dropdown. When exactly two players are selected in H2H mode, a banner shows their all-time head-to-head record (e.g. *"H2H: Alice leads 3–0 (3 games)"*).

**Daily Challenge mode** turns New Game into today's [Daily Challenge](#daily-challenge) launcher instead of a regular match: Starting Score and Format hide (the challenge decides them), and a gold **Today's Challenge** panel shows the challenge description plus whoever is currently in the player slot's streak and results history. Selecting who's attempting it uses the exact same single "Choose player" slot as Practice mode — a PIN-protected player still needs their PIN entered, since it's the identical gate every other slot uses, not a separate picker of its own. The **Start game** button relabels to **Start Challenge** while this mode is active.

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

**Input modes** — toggle between two ways to enter darts:
- **Pad** — a grid of numbers (1–20), Bull, and Miss, with Single / Double / Treble multiplier buttons
- **🎯 Dartboard** — an interactive SVG dartboard; tap directly on the sector you hit. The multiplier ring is determined by where you tap (singles bed, doubles ring, treble ring, bull).

**Dart entry (Pad mode):**
1. Tap **Single**, **Double**, or **Treble** to set the multiplier
2. Tap a number (1–20), **Bull**, or **Miss**
   - *Double Miss* fills two dart slots; *Treble Miss* fills all three
3. After three darts (or a bust or checkout), tap **Enter turn**

**Controls:**
- **Undo dart** — remove the last dart entered in the current visit
- **Undo Last Turn** — revert the most recently committed turn and restore all dart counts and averages to their previous state
- **Enter turn** — commit the visit and advance to the next player

**Feedback:**
- Bust turns are flagged immediately in red; the turn still needs to be confirmed with Enter turn
- Checkout turns show "GAME SHOT!" in green
- The checkout suggestion updates dart-by-dart as you enter the visit

**Between legs/sets/games:** a summary panel appears before the next unit begins —
- **Practice:** *This Leg* and *This Session* columns showing darts thrown, checkouts, best visits, busts, and treble-less %
- **H2H (leg complete):** each player's leg average, game average, darts thrown this leg, and legs/sets standing
- **H2H (game over):** each player's game average, total darts thrown, and final sets/legs standing

---

### Achievements & Badges

Beyond 180s, Big Fish, and nine-darters, Oche tracks 18 achievement badges covering precision, consistency, clutch play, rivalries, and a few purely-for-fun moments every darts player recognizes. Each one flashes a full-screen overlay (with a **📤 Share** button — see [Shareable Moments](#shareable-moments)) the moment it happens, live during play, on both the controller and the [Live Scoreboard](#live-scoreboard).

| Badge | How to earn it |
|---|---|
| 🎩 **Hat Trick** | Three trebles (any numbers) in one visit, without busting |
| 🔴 **Bullseye Gauntlet** | Hit the double bull twice in one visit |
| 💨 **Where'd It Go?** | Three misses in one visit |
| 😩 **So Close...** | Throw two treble 20s, then a single 20, in one visit |
| 😅 **Ton-titled to Nothing** | Score 100+ in a visit that still busts |
| 🦉 **Night Owl** | Throw a dart between midnight and 5am |
| 🐦 **Early Bird** | Throw a dart between 5am and 7am |
| 🎯 **Metronome** | Score within 15 points of each other across 5 consecutive visits |
| 🚗 **Cruise Control** | Win a leg where no visit scored below 40 |
| ❄️ **Ice in the Veins** | Check out for 50+ on the visit right after a bust |
| 🧊 **Nerves of Steel** | Win a leg or set that was a decider — tied one leg/set short of winning it |
| 🔥 **Comeback Kid** | Win a leg after trailing your opponent's remaining score by 100+ at some point |
| 🗡️ **Giant Slayer** | Beat an opponent whose average is 15+ points higher than yours |
| 🔁 **The Rematch** | Beat someone who beat you the last time you played them |
| 🥇 **First 100+ Checkout** | Check out for 100 or more points |
| ⚔️ **Grudge Match** | Play 10+ H2H games against the same opponent |
| 🕐 **Around the Clock** | Hit every number 1–20 as a single within one session |
| 🌍 **Around the World** | Hit every dart outcome at least once, over your lifetime — 63 total: singles/doubles/trebles 1–20, outer bull, double bull, and a miss |

**Badge Case** — every player's profile ([Player Profile](#player-profile)) shows the full 18-badge roster: greyed out and desaturated if not yet earned, full color once it is. A gold counter circle appears in the top-right corner of any badge earned more than once (e.g. Hat Trick ×5) — three badges (Around the Clock, Around the World, Grudge Match) are one-time-only by nature and never show a counter beyond 1. **Hover** any badge to see how to earn it; **tap** it on a touchscreen for the same info in a popup, since hover doesn't exist on touch. Earned badges get their own **📤 Share** button.

**Around the World Progress** — a dedicated grid on the Player Profile showing exactly which of the 63 lifetime dart outcomes are still missing, alongside the Badge Case.

---

### Daily Challenge

A recurring, Wordle-style solo challenge — the same challenge for everyone on a given calendar day, picked deterministically from the date so there's no server-side randomness and nothing to configure. A new format is picked each day from a pool of six, so it isn't the same task with a different number every time:

| Format | Goal |
|---|---|
| **Checkout Sprint** | Finish a specific score (121, 170, 96, ...) in the fewest darts |
| **Speed to Zero** | A full 501 leg, fewest total darts |
| **Bullseye Gauntlet** | Most bulls (single or double) hit across 3 visits (9 darts) |
| **Steady Hand** | Score as close to 20 as possible each visit, without going over |
| **Treble Run** | Most different treble numbers hit across 3 visits (9 darts) |
| **The Long Game** | Fewest visits to get from 501 down to under 40 remaining, without busting |

**Playing it:** switch to **🎯 Daily Challenge** mode on the [New Game](#new-game) screen — see that section for how player selection and PIN protection work in this mode. Only one attempt is allowed per player per calendar day; a second attempt the same day is rejected rather than overwriting the first, matching how a real Wordle guess works.

**Home page teaser:** the Home screen always shows a **🎯 Today's Challenge** card describing today's format, with a link to New Game — it's read-only (no player picker, no Start button) and shows the same information regardless of who's using the shared screen.

**Streaks & history:** the New Game panel shows the current player's streak (consecutive days with a completed attempt) and the last 7 days as a row of colored dots (gold = completed, grey = missed or unfinished). A missed or unfinished day breaks the streak.

**Sharing:** completing a challenge offers the same **📤 Share** card as any other big moment (see [Shareable Moments](#shareable-moments)), captioned with the format and result (e.g. "Checkout Sprint — 170 in 3 darts").

---

### Shareable Moments

Big moments — a 180, a Big Fish, a nine-darter, a match win, any of the 18 [achievement badges](#achievements--badges), or a completed [Daily Challenge](#daily-challenge) — get a **📤 Share** button that generates a shareable card image entirely on-device (canvas, styled to match the app), then either opens your phone's native share sheet (to Messages, X, Instagram, Facebook, or anything else it offers) or falls back to a plain image download on browsers without share-sheet support. Nothing is ever uploaded anywhere by this button — it's the same image whether you share it or save it.

- **Where it shows up:** the achievement overlay (180/Big Fish/nine-darter/any badge) while it's flashing, the Game Over screen after a match win, the Daily Challenge result panel, a badge's entry in the **Badge Case**, and next to Best Leg Average / Fewest Darts to Finish on a **Player Profile**'s Personal Bests.
- **Card tagline** (**Settings → Shareable Moments**) — a short editable line printed on every card, defaulting to "Darts tracked via Oche — track your darts today!". Update it once you have a real website or social handle to point at.
- **Automatic Home Assistant delivery:** independent of the Share button, if a **Moment Card Webhook ID** is configured (**Settings → Smart Home Integration**), the same card is sent to your HA instance automatically as a base64-encoded image the moment it happens — useful for routing it into Discord, Telegram, or anywhere else your own HA automations already reach. Personal-best cards are share-button-only (no automatic HA delivery), since there's no live "new personal best" detection during play yet.
- Not affiliated with or posting directly to X/Instagram/Facebook's own APIs — see `docs/shareable-moments-roadmap.md` for why direct API posting isn't realistic for a personal account on any of those three platforms today.

---

### Live Scoreboard

Open **`http://<your-server>:8046/display`** on a TV or second monitor. It updates in real time via Server-Sent Events (SSE) — no refreshing needed.

**Layout presets** — pick **Full**, **Compact**, or **Minimal** from **Settings → Live Scoreboard**, or override per-screen with `?layout=compact` in the URL (handy when different screens in the same room want different densities). Checkout suggestions, achievement flashes, and the match bar always show regardless of layout — only the denser rows (dart counts, leg/game averages, and the 180/Big Fish/Bust counters) are hidden on Compact and Minimal, so a smaller screen isn't stuck showing TV-sized clutter.

**Top bar:**
- Game format and current leg/set
- 🎯 180s · 🐟 Big Fish · 💥 Busts for the current game (Full layout only)
- Live connection indicator

**Match bar** (H2H only, 2+ players) — an in-flow strip below the top bar with one row per player, showing Sets and/or Legs as bold boxed numbers (styled after broadcast dart scoreboards). The throwing player's row and stat boxes are gold-outlined.

**Checkout strip** — appears prominently below the match bar whenever the active player is on a finishing number, showing the full route in large text (e.g. `T20 → T19 → D12`). Flashes when updated after each dart.

**Player cards** (one per player):
- Remaining score
- "Darts Thrown" — **Leg / Set / Game** for H2H; **Leg / Session** for Practice (Full layout only)
- Leg average · game average (Full layout only)
- Active player's card shows each dart thrown in the current visit, plus the checkout route inline
- Bust overlay (red) and Game Shot overlay (green) flash on the active card

**Between legs:** score cards are replaced with a leg summary — average, darts thrown, and busts per player — until the next leg starts.

**Leg/Set/Game banners:** full-screen result announced when a unit ends.

**Achievement overlays:** full-screen flash for 180s (🎯), Big Fish (🐟), and nine-darters (🏆, with confetti) the moment they're scored, plus any of the 18 [achievement badges](#achievements--badges) (Hat Trick, Nerves of Steel, Around the World, and so on) — each with a **📤 Share** button (see [Shareable Moments](#shareable-moments) below).

The scoreboard is read-only and can be open on any number of screens simultaneously.

---

### Players

The Players screen shows all registered players with their current finish rule (double out / single out) and lifetime average.

Actions per player:
- **Rename** — changes the name everywhere, including all historical records
- **Delete** — permanently removes the player and all their data *(admin login required)*
- **Set finish rule** — double out or single out
- **View profile** — opens the full player profile page

Add new players from this screen. New players can optionally be given a **PIN** and a **dart weight** at creation time — see [Admin Accounts & Player PINs](#admin-accounts--player-pins).

Once any admin account exists, destructive actions (deleting a player, resetting stats) are hidden from the UI until you log in as an admin.

---

### Player Profile

Each player has a dedicated profile page with full career statistics, accessible by clicking their name anywhere in the app.

#### Tabs

**Overall** · **H2H** · **Practice** — all stats and charts filter to the selected mode.

#### Stat Bubbles

Fifteen stat bubbles are available; five (Darts Thrown, Average, 180s, Big Fish, 9 Darters) show by default and the rest live behind a "More stats" toggle. Click any bubble to display that metric in the chart below.

| Bubble | Description |
|---|---|
| **Darts Thrown** | Total individual darts thrown |
| **Average** | 3-dart average across all visits |
| **180s** | Total 180s thrown |
| **Big Fish** | Total 170 checkouts |
| **9 Darters** | 501 legs finished in exactly 9 darts |
| **Darts / Day** | Average darts thrown per day played |
| **Darts / Leg** | Average darts thrown per won leg |
| **Average Pace** | Darts thrown per minute — requires "Collect per-dart timing" in Settings |
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

#### Personal Bests

- **Best Leg Average**
- **Fewest Darts to Finish**
- **Current Win Streak**
- **Recent Form** — average of the last 10 legs, with an arrow showing the delta vs. lifetime average

#### Badge Case

The full 18-badge [achievement](#achievements--badges) roster for this player — greyed out until earned, full color once earned, with a counter for badges earned more than once. Hover (or tap on a touchscreen) any badge to see how to earn it.

#### Around the World Progress

A grid showing exactly which of the 63 lifetime dart outcomes (every number 1–20 × single/double/treble, outer bull, double bull, and a miss) this player has and hasn't hit yet — the completion criterion for the Around the World badge.

#### Top 10 Finishes

The player's ten highest checkouts — score, how many times achieved, and dates. Click any finish score to expand the most-used checkout routes for that score (e.g. the three darts you most often hit to land that 121).

#### Dart Analytics

A breakdown of how this player actually throws:

- **Most-hit sectors** — top dart landing spots ranked by frequency, with sector and multiplier
- **Treble hit rate** — for each number 1–20, how often the treble bed is hit vs. any throw at that sector
- **Checkout routes** — the most common dart sequences used on winning turns

#### Settings

- **Dart weight** — 10g through 40g; stored per-game for chart filtering
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
- Darts thrown
- H2H wins by format

Plus global leaderboards for 180s, Big Fish, and nine-dart finishes, each filterable by mode.

---

### Settings

The Settings page (accessible from the top navigation) holds app-wide configuration. Each section — **Admin accounts**, **Player PINs**, **Scoring**, **Accessibility**, **Voice Announcements**, **Shareable Moments**, **Data Collection**, **Live Scoreboard**, **Smart Home Integration**, and **Danger Zone** — is collapsed to just its header by default; click a header to expand it.

Settings require an admin login (see [Admin Accounts & Player PINs](#admin-accounts--player-pins)) — until an admin account exists, the page offers to create the first one.

#### Scoring

- **Default input** — which dart entry method a new game opens with: **Dartboard** (tap the sector you hit) or **Pad** (number grid with a multiplier selector). Either can still be switched per-session from the scoring screen itself.

#### Accessibility

- **Colorblind-friendly palette** — swaps the app's red/green double and treble colors (dartboard rings, Pad mode's Double/Treble buttons, win/bust status text, and the live scoreboard's checkout flashes and dart-class colors) for a blue/orange palette. Applies to this device and the `/display` scoreboard.

#### Voice Announcements

Spoken call-outs on the live scoreboard (`/display`) using the browser's built-in speech synthesis — no server involvement, no external service. Off by default via a master switch; each call-out below is independently toggleable once enabled:

- **Turn score** — after any ordinary turn, speaks just the score (no player name), e.g. "sixty".
- **"No Score"** — a bust or three misses, spoken at a deliberately low, disappointed tone.
- **Checkout requirement** — each time it becomes a player's turn while they're on a valid finish, "{name}, you require {score}".
- **180s** — "One! Hundred! and! Eighty!!", spoken as an escalating, drawn-out call.
- **Big Fish sound** — a short splash effect (not speech) when a leg/set/game is won on a 170 checkout.
- **Leg / Set / Game results** — PDC-style phrasing, e.g. "Game shot! And the 3rd leg, Alice!", followed by "Alice to throw first, Game On!" for the next leg.

Multi-language support is left to whatever voice/locale the browser already provides — see `docs/voice-announcements-i18n-roadmap.md` for the full i18n plan. Most browsers block audio until a user gesture, so `/display` shows a one-tap "🔊 Tap to enable voice announcements" button the first time voice is enabled.

#### Data Collection

- **Collect per-dart timing** — records the exact moment each dart is tapped, in addition to existing per-visit data. Enables the Average Pace (darts/minute) stat on the Home page and player profiles. Off by default since most setups won't need it.

#### Live Scoreboard

- **Layout** — the preset the `/display` screen uses: **Full**, **Compact**, or **Minimal** (see [Live Scoreboard](#live-scoreboard)). Can be overridden per-screen with `?layout=` in the URL.

#### Home Assistant Integration

Oche can fire webhooks to a Home Assistant instance whenever key game events occur. Set this up in HA by creating an automation with a **Webhook** trigger, then paste the webhook ID into the corresponding field in Oche.

**Configuration:**

| Field | Description |
|---|---|
| **Home Assistant URL** | Base URL of your HA instance, e.g. `http://homeassistant.local:8123` |
| **Test connection** | Sends a HEAD request to verify Oche can reach HA |

**Supported events** — configure a webhook ID for any or all of these (leave blank to skip):

| Event | Triggered when |
|---|---|
| **180** | A player scores a maximum 180 |
| **Big Fish** | A player checks out 170 |
| **Ton+ Finish** | Any checkout of 100 or more |
| **Bust** | A turn ends in a bust |
| **Nine-Darter** | A 501 leg is finished in exactly 9 darts |
| **Moment Card** | A shareable card image (180/Big Fish/Nine-Darter/match win) is generated — payload includes the image as base64 |
| **Leg Start** | A new leg begins |
| **Leg End** | A leg is won (includes winner name) |
| **Set Start** | A new set begins |
| **Set End** | A set is won (includes winner name) |
| **Game Start** | A new game begins |
| **Game End** | A game is won (includes winner name) |

**Webhook payload** (POST to `http://<ha-url>/api/webhook/<webhook-id>`):
```json
{ "player": "Name", "event": "oneeighty", "category": "501", "timestamp": 1234567890 }
```

#### Danger Zone

- **Wipe all player & game data** — permanently deletes every player, game, and stat. Admin accounts and settings are kept. Meant for clearing out test/dev data, not everyday use.

Settings are persisted in the database and survive container restarts.

---

## Admin Accounts & Player PINs

Oche supports an optional but recommended authentication layer so a shared tablet or TV can't be used to delete players, wipe stats, or play under someone else's name.

### First-run setup

The first time Settings is opened with no admin account on the server, a setup wizard prompts for a username and password to create the first admin. From then on, Settings requires logging in as an admin.

### Admin accounts

- Any number of admin accounts can exist; there must always be at least one
- Admins can access Settings, manage other admin accounts, set/reset player PINs, and perform destructive player actions (delete player, reset stats)
- Sessions are stored server-side and tracked via a cookie — logging out clears the session
- Repeated wrong login attempts lock the account out temporarily (default: 5 attempts, configurable 1–1000 in **Settings → Admin accounts**), mirroring the same protection player PINs already have

### Player PINs

- Any player can optionally be given a 4–8 digit PIN, either at creation or later from **Settings → Player PINs**
- A PIN-protected player must have their PIN entered before they can be added to a New Game slot — this stops other people from playing as you
- Players without a PIN can be picked by anyone
- Repeated wrong PIN attempts lock the player out temporarily; the lockout threshold (default: configurable 1–1000 attempts) is set in **Settings → Player PINs**
- PIN entry fields are marked to opt out of browser/extension password-manager save prompts (e.g. 1Password), since a PIN isn't a password

### What's gated behind admin login

| Action | Requires admin |
|---|---|
| Delete a player | Yes |
| Reset a player's stats | Yes |
| Wipe all player/game/stat data | Yes |
| Set or remove a player's PIN | Yes |
| Add/remove admin accounts | Yes |
| Change Home Assistant / webhook / scoreboard-layout / default-input settings | Yes |
| Verify a player's PIN to add them to a game | No — public, but rate-limited by the lockout threshold |
| Log in as an admin | No — public, but rate-limited by its own lockout threshold |
| View stats, play games, use the scoreboard | No *(unless `OCHE_REQUIRE_AUTH` is set — see below)* |

### Locking down writes for internet-exposed deployments

By default the app follows a LAN trust model: **reads and gameplay writes are open**, and
only the admin/destructive actions above require login. Player PINs are a UI convenience —
they gate the player picker, **not** the underlying API — so on an untrusted network anyone
who can reach the server could record games or edit players directly.

Set the environment variable **`OCHE_REQUIRE_AUTH=true`** to require a logged-in admin
session for **every write** (creating players/games, recording turns, badges, challenges,
and the live-scoreboard feed). Reads stay public, so the read-only scoreboard and stats
pages still work for everyone. When enabled, the app prompts for an admin login before
starting a game or changing the roster.

### Exposing this to the internet — checklist

If you're putting this somewhere reachable from the open internet (not just your LAN),
work through this list. It's also tracked in `docs/security-audit-roadmap.md`.

- **Put it behind a TLS-terminating reverse proxy.** The app itself only speaks plain HTTP.
- **Set `COOKIE_SECURE=true`** once it's served over HTTPS, so the admin session cookie
  gets the `Secure` flag.
- **Set `OCHE_REQUIRE_AUTH=true`** (see above) so every write requires a logged-in admin.
- **Set `TRUST_PROXY=true`** *only* if the reverse proxy in front of it is one you control
  and it sets `X-Forwarded-For`. This makes the built-in per-IP rate limiting (login,
  first-run setup, PIN verification, and a general per-IP request budget) use the real
  client IP instead of the proxy's. Leave it unset otherwise — trusting that header from
  an untrusted source would let a client spoof its way around the rate limiter.
- **Leave `HA_BLOCK_PRIVATE` unset** for a normal LAN-hosted Home Assistant instance (the
  default already blocks the app from being pointed at loopback or link-local/cloud-metadata
  addresses regardless). Only set it to `true` if you specifically want outbound Home
  Assistant requests restricted to non-private-network hosts too.
- **The container already runs as a non-root user** (see `Dockerfile` /
  `docker-entrypoint.sh`) and sends standard security response headers (CSP,
  `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`) — nothing to configure
  for these, just worth knowing they're on by default.
- `POST /api/ha-webhook` (the inbound trigger used to fire an already-configured Home
  Assistant webhook) is intentionally **not yet covered** by `OCHE_REQUIRE_AUTH` — see the
  open item in `docs/security-hardening-roadmap.md` before relying on it being gated.

---

## API Reference

All responses are JSON. The server runs on one port and serves both the frontend and the API.

### Health

```
GET  /api/health
```
Returns `{ ok: true }`.

### Auth & Admin Accounts

```
GET    /api/setup-required                  { required } — true until the first admin exists
POST   /api/setup                           Create the first admin   { username, password }
                                             (only while setup-required)
POST   /api/login                           Log in                   { username, password }
                                             → sets session cookie
POST   /api/logout                          Clear the session cookie
GET    /api/me                              { loggedIn, username? }
GET    /api/admins                          List admin accounts                      [admin]
POST   /api/admins                          Add an admin             { username, password } [admin]
DELETE /api/admins?id=                      Remove an admin                          [admin]
PUT    /api/admins/password                 Change an admin's password { username, password } [admin]
```

Routes marked `[admin]` require a logged-in admin session (cookie set by `/api/login`).

### Players

```
GET    /api/players                         List all players
POST   /api/players                         Add a player          { name, out, pin?, dartWeight? }
PUT    /api/players/rename                  Rename a player       { from, to }
PUT    /api/players/out                     Set finish rule       { name, out: "double"|"single" }
PUT    /api/players/dart-weight             Set dart weight       { name, weight }
GET    /api/players/dart-weights?name=      Dart weight history for a player
DELETE /api/players?name=                   Delete a player and all their data        [admin]
DELETE /api/players/stats?name=&mode=       Clear stats for a player                  [admin]
                                             mode: "h2h" | "practice" | "all"
POST   /api/players/verify-pin              Verify a player's PIN  { name, pin } (public, rate-limited)
PUT    /api/players/pin                     Set/reset a player's PIN { name, pin }    [admin]
DELETE /api/players/pin?name=               Remove a player's PIN                     [admin]
```

### Stats & Leaderboards

```
GET  /api/stats                             All player stats (full computed object)
GET  /api/summary                           Site-wide totals (darts, legs, 180s, etc.)
GET  /api/home-extra                        Home page extras: win/trebleless/ton+ leaderboards,
                                             highest checkout, last game played, today/week
                                             activity, and dart pace
GET  /api/top-finishes?mode=                Top 10 checkouts across all players
GET  /api/stats/180s?mode=                  180 leaderboard
GET  /api/stats/big-fish?mode=              Big Fish (170 checkout) leaderboard
GET  /api/stats/nine-darters?mode=          Nine-dart finish leaderboard
```

All leaderboard endpoints accept `?mode=h2h|practice` to filter by game mode. Omit for overall.

### Per-Player Stats

```
GET  /api/players/stat-bubbles?name=&mode=  All 15 stat bubble values for a player
GET  /api/players/personal-bests?name=&mode= Best leg average, fewest darts to finish,
                                             current win streak, and recent form
GET  /api/players/top-finishes?name=&mode=  Top 10 checkouts for a player
GET  /api/players/checkout-route            Most-used routes for a specific checkout score
     ?name=&score=&mode=
GET  /api/players/dart-analytics?name=&mode= Per-dart hit frequency, treble rates,
                                             and checkout route breakdown
GET  /api/players/h2h?p1=&p2=               Head-to-head record between two players
                                             (used by the New Game H2H banner)
GET  /api/players/avg-history               Metric history for the chart
     ?name=
     &metric=avg|180s|bigfish|ninedarters|treblelesspct|
              first3avg|first9avg|avg100plus|avg90minus|score140pct|180sperleg|
              dartsthrown|avgdartsperday|avgdartsperleg|pace
     &period=today|week|month|year|all|custom
     &start=YYYY-MM-DD   (required when period=custom)
     &end=YYYY-MM-DD     (required when period=custom)
     &weight=            (optional, grams — filter to a specific dart weight)
     &mode=h2h|practice  (optional)
```

### Achievements & Badges

```
POST /api/badges/award                      Award/increment a badge { player, badgeId, once }
                                             → { newlyEarned, count }
                                             once:true is idempotent (state-based badges like
                                             Around the Clock/World, Grudge Match); otherwise
                                             count increments on every call
GET  /api/players/badges?name=              This player's earned badges
                                             → [ { badge_id, count, earned_at } ]
GET  /api/players/h2h-summary               Games played and previous-match winner between two
     ?player=&opponent=&excludeGameId=       players (used by the Grudge Match/Rematch badges)
GET  /api/players/around-the-world?name=    Around the World progress
                                             → { hit: [{sector, mult}], count, total: 63 }
```

### Daily Challenge

```
POST /api/challenges/start                  Register today's attempt
                                             { player, gameId, challengeDate, format, target }
                                             → 409 if already attempted this date
POST /api/challenges/complete               Record a result { player, challengeDate, resultDarts }
                                             → 404 if no matching attempt exists
GET  /api/challenges/status                 Today's attempt, current streak, and 7-day history
     ?player=&date=YYYY-MM-DD               → { today, streak, history }
```

### Games

```
POST /api/games                             Start a game
                                             { category, legsPerSet, setsPerGame,
                                               players: [names], practice: bool }
                                             → { gameId }

POST /api/games/:id/turns                   Record a visit
                                             { player, set, leg, scored,
                                               bust, checkout, checkoutPoints,
                                               darts: [{sector, multiplier}] }

DELETE /api/games/:id/turns/last            Delete the most recently recorded turn
                                             (used by Undo Last Turn)

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

### Settings

```
GET  /api/settings                          Retrieve all settings (key/value pairs)                [admin]
PUT  /api/settings                          Update settings       { ha_url, ha_webhook_*,          [admin]
                                               pin_lockout_threshold, admin_lockout_threshold,
                                               collect_dart_timing, scoreboard_layout,
                                               default_scoring_input, … }
GET  /api/settings/dart-timing              { enabled } — public, read by every device during play
GET  /api/settings/scoreboard-layout        { layout } — public, read by the /display screen
GET  /api/settings/default-input            { input: 'pad'|'board' } — public, read at app boot
GET  /api/settings/colorblind-mode          { enabled } — public, read at app boot by both the controller and /display
GET  /api/settings/voice-announcements      { enabled, turnScore, noScore, checkoutReq, oneEighty,
                                               bigFish, matchProgress } — public, read at boot by /display
GET  /api/settings/card-tagline             { tagline } — public, read at app boot for shareable cards
POST /api/ha-test                           Test HA connectivity  { url }                        [admin]
POST /api/ha-webhook                        Fire an HA webhook    { event, player, category, … }
```

### Admin

```
POST /api/reset                             Wipe all games and turns (players kept)               [admin]
POST /api/wipe-all                          Wipe all players, games, and stats (admins kept)      [admin]
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

**Backend** — a single `http.createServer` with no npm dependencies. Uses `node:sqlite` (built into Node 22.5+) in WAL mode with foreign keys enabled. All statistics are computed from raw turn and dart data at query time — nothing is pre-aggregated, so stats are always consistent and new metrics can be added without migrations.

**Frontend** — a single HTML file with vanilla JavaScript and no build step. It requires a reachable backend at the same origin — there is no offline/local-storage fallback — so stats never split across two unsynced stores. If the backend can't be reached, the app shows a connection-error screen instead of scoring silently into the browser.

**Live scoreboard** — the controller (`index.html`) POSTs the full game state to `/api/live` after every dart and every turn. The scoreboard (`display.html`) subscribes to `/api/live/stream` (Server-Sent Events) and re-renders on every push. A 25-second heartbeat keeps the connection alive through proxies.

**Database schema:**

| Table | Purpose |
|---|---|
| `players` | Name, double/single-out preference, and dart weight |
| `games` | One row per match; includes format, category, practice flag, winner |
| `game_players` | Who played in each game; stores dart weight and out mode used |
| `turns` | Every visit: scored points, bust flag, checkout flag |
| `darts` | Every individual dart: sector, multiplier, dart number within the visit. `scored`, `is_treble`, and `is_double` are computed columns derived from sector and multiplier. |
| `timeline_events` | Leg/set/game start and end timestamps |
| `player_badges` | One row per player+badge earned, with a running count (see [Achievements & Badges](#achievements--badges)) |
| `daily_challenge_attempts` | One row per player per calendar date attempted; links to `games` via `game_id` |
| `settings` | Key/value store for app settings (e.g. Home Assistant config, PIN/admin-login lockout thresholds) |
| `admins` | Admin usernames and hashed passwords |
| `sessions` | Server-side admin login sessions, keyed by cookie token |

The `darts` table records every physical dart thrown and is the source of truth for treble rates, per-dart analytics, and checkout route history. Schema changes are applied automatically on startup using `ALTER TABLE … ADD COLUMN` or by dropping and recreating tables when the schema changes structurally — player profiles and settings are always preserved.

---

## Data Storage

All data is in a single SQLite file. With Docker it lands at `./darts_data/darts.db` on the host.

- **Migrate to a new server:** copy the `darts_data` folder across and start the container
- **Nothing leaves your network** — no cloud sync, no telemetry, no accounts (Home Assistant webhooks are outbound-only and only fire if you configure them)

### Backups

The database runs in SQLite's WAL mode, so a plain `cp` of `darts.db` while the app is
running can grab an inconsistent snapshot (recent writes can still be sitting in a
separate `-wal` file). Use the included backup script instead — it takes a real,
consistent point-in-time snapshot regardless of WAL state, using Node's built-in
`node:sqlite` backup API (no extra dependencies):

```
node backend/backup.js
```

This writes a timestamped snapshot to `darts_data/backups/` and prunes anything older
than 7 days (override with `BACKUP_RETENTION_DAYS`). Schedule it with host cron, e.g.
for a nightly backup at 3am:

```
0 3 * * * cd /path/to/oche && DARTS_DB=/path/to/darts_data/darts.db node backend/backup.js >> /var/log/oche-backup.log 2>&1
```

**To restore:** stop the container, replace `darts_data/darts.db` with the chosen
backup file (and remove any stale `darts.db-wal`/`darts.db-shm` files sitting next to
it), then restart the container.
