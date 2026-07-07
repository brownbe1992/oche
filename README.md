> **Note:** This project is vibe-coded using Claude. I am not a software developer.

---

# Oche

A self-hosted, per-dart darts scorer with real-time scoreboard, lifetime player statistics, and no external dependencies.

**v0.11.2**

You enter every dart individually — multiplier first, then the number — and Oche tracks everything: 501 / 301 / 170 / 101 games in any legs-and-sets format, per-player double-out or single-out rules, 3-dart averages, checkout suggestions, a [46-badge achievement system](#achievements--badges) with a per-player Badge Case, a Wordle-style [Daily Challenge](#daily-challenge), and years' worth of per-player history. A second game type, [Cricket](#new-game) (classic or fully customizable targets), is now playable alongside X01 with full stats parity — its own dedicated scoring screen, live scoreboard, stat bubbles/Personal Bests/achievements, and Home page leaderboards. A [👻 Ghost mode](#new-game) lets you race a dart-by-dart replay of one of your own past won legs. A solo [Doubles Practice mode](#new-game) lets you drill any double(s) you choose, with its own stat bubbles and Personal Bests. A solo [Just Chuckin' It mode](#new-game) is completely freeform, unscored practice — just throwing dart after dart, with heatmap-heavy stats and 18 laddered milestone achievements. All data lives in a SQLite database on your own server.

> Looking for exact stat formulas, achievement trigger conditions, the full database schema, or how a feature works internally (e.g. to debug it)? See **[REFERENCE.md](REFERENCE.md)** — the technical reference manual, kept up to date alongside this README.

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
- [Reference Manual](REFERENCE.md) — exact stat formulas, achievement trigger conditions, full DB schema, and internals
- [Home Assistant Automation Recipes](docs/home-assistant-recipes.md) — copy-pasteable automations built on the webhooks below

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

Requires **Node.js 22.13 or newer** (uses the built-in `node:sqlite` module — it exists as of 22.5.0, but stays behind an experimental flag this project doesn't pass until 22.13.0).

```bash
node backend/server.js
```

Open `http://localhost:8046`. The database is created at the path in the `DARTS_DB` environment variable. Without Docker and with `DARTS_DB` unset it defaults to `data/darts.db` next to the repo (`backend/../data/darts.db`); the Docker image sets `DARTS_DB=/data/darts.db` instead.

---

## The App

### Home

The landing page shows a live snapshot of all-time activity:

**Hero stats:** Total darts thrown · 180s · Big Fish · 9-Darters *(shown even at zero, with an empty-state prompt, since it's the rarest feat in the game)*

**Activity:** Players · Games played *(completed H2H matches — practice, solo, and Daily Challenge sessions don't count as games)* · Sets played · H2H legs thrown · Practice legs thrown

**Achievements:** Ton+ finishes (100+ checkouts) · 180s · Big Fish · Highest checkout ever recorded

**This week / Last game played** — legs thrown today and this week, darts thrown this week, and a summary of the most recently completed game (players, category, winner, and when).

**H2H / Practice toggle** — switches the leaderboards below between head-to-head and solo/practice stats. A second game-type toggle — **X01 / Cricket / Doubles Practice** — switches the leaderboards between each game type's own stat vocabulary. (Just Chuckin' It isn't on this toggle — it has no win/opponent-based stats to rank on a leaderboard; its stats are Player Profile-only.)

**X01 leaderboards:**
- 3-dart average leaderboard
- Most Wins (win rate) — H2H only
- Fewest Trebleless Visits (lowest trebleless rate first — fewer is better)
- Ton+ Finish Rate
- Highest Checkout Ever (within that mode — the "Highest checkout ever recorded" figure in Achievements above is separate and always all-time)
- Average Pace (darts/minute) — appears once dart-timing data exists, see [Settings](#settings)

**X01 Hall of Fame sections:**
- 🎯 **180s** — every player who has thrown a maximum, with count and most recent date
- 🐟 **Big Fish** — every 170 checkout recorded
- **Nine-Dart Finishes** — 501 completed in exactly 9 darts *("None recorded yet — you will never get this!")*

**Cricket leaderboards** (switching the toggle to Cricket):
- Marks Per Round (MPR) leaderboard — minimum 5 rounds played, so one lucky visit can't top the board
- Most Cricket Wins (win rate) — H2H only

**Cricket Hall of Fame sections:**
- 🎯 **9 Marks** — every player who's scored the maximum 9 marks in one visit, with count and most recent date
- 🏆 **Perfect Leg** — every leg closed in the fewest darts physically possible for that match's target set *("None recorded yet — you will never get this!")*

**Doubles Practice leaderboards** (switching the toggle to Doubles Practice — no mode param, since this game type is always solo):
- Doubles % leaderboard — minimum 5 rounds played, so one lucky round can't top the board
- Best Round — each player's own best single round (most doubles hit; a tie is broken by fewest darts)

A **"View full stats glossary"** link opens a shared reference explaining every stat term used across the app.

---

### New Game

Configure a game before starting:

| Setting | Options |
|---|---|
| **Game** | X01 · Cricket |
| **Mode** | H2H (head-to-head) · Practice (solo) · 🎯 Daily Challenge · 👻 Ghost |
| **Practice type** (Practice only) | Practice · Doubles Practice · Just Chuckin' It |
| **Format (X01)** | 501 · 301 · 170 · 101 (dropdown) |
| **Targets (Cricket)** | Classic (15–20, Bull) · Custom (any 7 numbers) |
| **Legs per set** | 1 – 9 |
| **Sets per game** | 1 – 9 |
| **Players** | Select from the roster (up to 6); H2H requires 2+ |
| **Finish rule (X01)** | Double out · Single out (set per player) |

H2H mode requires at least two players selected. Practice mode can be played solo or with others and is tracked separately from H2H statistics.

Players with a PIN set show a 🔒 next to their name in the dropdown. When exactly two players are selected in H2H mode, a banner shows their all-time head-to-head record (e.g. *"H2H: Alice leads 3–0 (3 games)"*).

**Cricket** is a second game type alongside X01. Choosing **Classic** locks the targets to the standard 15, 16, 17, 18, 19, 20, and Bull. Choosing **Custom** reveals a 1–20-plus-Bull picker — pick any numbers you like, but always exactly 7 (the same count as classic); Start is blocked until exactly 7 are checked, with a running "N of 7 selected" count and a one-tap "Start from classic" fill-in. Once a Cricket game begins, the scoring screen and live scoreboard both switch to Cricket's own marks/closed/points display — the X01 Pad and Dartboard input screens are never shown during a Cricket game, and there's no per-game choice between them the way there is for X01. See [Scoring](#scoring) below and `REFERENCE.md` for the exact marks/points rules. Cricket has its own stat bubbles (MPR, 9 Marks, Win Rate, Games Played, Darts Thrown, Darts/Won Leg), Personal Bests, 2 achievements (9 Marks and Perfect Leg), and its own Home page leaderboard set (Marks Per Round, Most Cricket Wins, 9 Marks, Perfect Leg) — a game-type toggle on both the Home page and the Player Profile switches between it and every other game type.

**Daily Challenge mode** turns New Game into today's [Daily Challenge](#daily-challenge) launcher instead of a regular match: Starting Score and Format hide (the challenge decides them), and a gold **Today's Challenge** panel shows the challenge description plus whoever is currently in the player slot's streak and results history. Selecting who's attempting it uses the exact same single "Choose player" slot as Practice mode — a PIN-protected player still needs their PIN entered, since it's the identical gate every other slot uses, not a separate picker of its own. The **Start game** button relabels to **Start Challenge** while this mode is active. Daily Challenge is X01-only — the Game-type choice is hidden and forced back to X01 whenever this mode is selected.

**👻 Ghost mode** races a replay of one of your own past legs — literally your prior self, thrown dart-by-dart from a leg you actually won, not a simulated opponent. Choosing it shows a gold **Race a past leg** panel listing that player's past won legs (date, category, average, darts used) once a player is picked — the same single-player slot as Practice mode. You can also jump straight into this from a **👻** button next to **Best Leg Average** on a [Player Profile](#player-profile)'s Personal Bests, which preselects that specific leg. The ghost throws back automatically right after each of your own turns (not at the leg's real historical pace) — its card on the scoring screen and Live Scoreboard is labeled **"👻 Ghost (date)"**. Ghost mode is X01-only, always exactly one leg, and always tracked as practice: your own darts record normally, but nothing is recorded for the ghost, and it can never trigger a head-to-head badge like Comeback Kid or Giant Slayer.

**Doubles Practice mode** is a solo drill for practicing specific doubles — choose one or more from a 1–20-plus-Bull picker (any number, no fixed count), then throw. All selected doubles stay **live at once** — you choose which one to aim at each dart, not a forced rotation. A **round** keeps going, however many darts it takes, until one of two things happens: a single or treble lands on one of your target numbers ("so close" — right number, wrong ring), or a double lands on a number that isn't one of your targets ("wrong double"). A genuine miss elsewhere on the board doesn't end anything — just keep throwing. When a round ends, **Start next round** resets the tally and keeps the same targets. The scoring screen and Live Scoreboard show the live target set, this round's hit count and darts-thrown, and the running doubles percentage; there's no numeric score, no opponent, and no Enter-turn step — every dart commits the instant it's thrown. See [Player Profile](#player-profile) for its own stat bubbles (Doubles %, Darts/Round, Doubles Hit/Round) and Personal Bests (longest round, most doubles in a round), reachable via the same game-type toggle. Undo Last Dart is supported, one dart deep.

**Just Chuckin' It** is completely freeform, unscored practice — no starting score, no bust, no win, no opponent, just throwing dart after dart until you press **End game**. Selecting it on the [New Game](#new-game) page shows a short explanation of what it's for. The point is pure warm-up/muscle-memory reps without any game pressure at all. Every dart commits instantly (no Enter-turn step, same as Doubles Practice), and there's undo support for the last dart. Its stats are heatmap-heavy on purpose: [Player Profile](#player-profile) gets a non-interactive dartboard heatmap shaded by how often you hit each region (with exact counts on hover), plus 8 stat bubbles (Darts Thrown, Three-Dart Average, 180s, Treble/Bull/Double %, Sessions Played, Avg Darts/Session), a 2-field Personal Bests (longest session, most trebles in a session), and 19 achievements (18 laddered milestones plus its own 180! — see [Achievements & Badges](#achievements--badges)) so there's always another one within reach. Darts thrown in this mode count toward your lifetime/daily/weekly total darts thrown (the one deliberate exception) but never toward any X01/Cricket/Doubles Practice stat, average, or leaderboard.

The **Live Scoreboard** shows a live dartboard heatmap for this mode too, gradually filling in as the session progresses (a separate, shorter-lived dataset from the lifetime one on the Player Profile), alongside a running darts-thrown counter and three-dart average — side by side on a wide screen, stacked on a narrow one.

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
- **Pad** — a grid of numbers (1–20), Bull, and Miss, with Single / Double / Treble multiplier buttons. This is the app's **accessible input path**: ordinary focusable buttons that work the same for keyboard, switch, and screen-reader users, with no visual dartboard shape or precise tap-target aiming required.
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

**Cricket's scoring screen is entirely different** — there's no Pad/Dartboard
choice, no checkout hints, and no bust concept:
- **Scorecard** is a traditional chalkboard-style table, not per-player cards —
  one row per target number (highest to lowest, Bull last) and one column per
  player. Each cell shows a slash (1 mark), an X (2 marks), or a circled X (3+
  marks/closed — the circle is the non-color-only closed signal, never color
  alone), plus a running points total in a footer row.
- **Dart entry** — the same Single/Double/Treble multiplier selector as X01, then
  tap directly on one of the 7 in-play target buttons (or **Miss**). A closed
  number stays tappable — real cricket still lets you score on a number you've
  closed as long as an opponent hasn't closed it too, so it's never disabled for
  that reason, only once all 3 darts of the visit are thrown.
- **Scoring**: hitting a number you haven't closed just builds toward closing it
  (3 marks — single=1, double=2, treble=3); the closing marks themselves are
  worth 0 points. Any marks beyond what was needed to close, in the same visit
  or a later one, score points (the number's value × marks) *if at least one
  opponent hasn't closed that number yet*.
- **Winning**: first to close all 7 numbers while strictly ahead on points wins
  the leg. Closing everything without the lead doesn't end the leg — you keep
  throwing (and can still score against anyone still open on a number you've
  closed) until you take the lead or an opponent closes out ahead of you.

---

### Achievements & Badges

Beyond 180s, Big Fish, and nine-darters, Oche tracks 22 X01 achievement badges covering precision, consistency, clutch play, rivalries, and a few purely-for-fun moments every darts player recognizes, plus 2 Cricket-specific badges, 3 Daily Challenge badges, and 19 Just Chuckin' It badges (18 laddered milestones plus its own 180!). Each one flashes a full-screen overlay (with a **📤 Share** button — see [Shareable Moments](#shareable-moments)) the moment it happens, live during play, on both the controller and the [Live Scoreboard](#live-scoreboard).

| Badge | How to earn it |
|---|---|
| 🎩 **Hat Trick** | Three trebles (any numbers) in one visit, without busting |
| 🔴 **Bullseye Gauntlet** | Hit the double bull twice in one visit |
| 👯 **Double Trouble** | Check out with the last two darts of the visit both landing on doubles — dart 1 of a 3-dart visit can be anything |
| 💨 **Where'd It Go?** | Three misses in one visit |
| 😩 **So Close...** | Throw two treble 20s, then a single 20, in one visit |
| 😅 **Ton-titled to Nothing** | Score 100+ in a visit that still busts |
| 💥 **Busted Maximum** | Throw three treble 20s (a genuine 180) on a visit that still busts |
| 🤦 **No Cigar** | Bust a double-out visit whose darts sum to exactly the score you needed — just not on a double |
| 🪜 **Staircase Finish** | Check out in exactly three darts by halving the target twice: single, single, then double — e.g. 32 down to 16, down to 8, then double 4 |
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

**Cricket's 2 badges** (its own analogs of 180 and the nine-darter):

| Badge | How to earn it |
|---|---|
| 🎯 **9 Marks** | Score 9 marks in one Cricket visit — three trebles, the maximum possible |
| 🏆 **Perfect Leg** | Close every Cricket number using the fewest darts physically possible for that match |

**Daily Challenge's 3 badges** (see [Daily Challenge](#daily-challenge)):

| Badge | How to earn it |
|---|---|
| 🔥 **Challenge Streak: Week** | Complete the Daily Challenge 7 days in a row |
| 🏆 **Challenge Streak: Month** | Complete the Daily Challenge 30 days in a row |
| 🗓️ **Full Rotation** | Complete every Daily Challenge format at least once |

**Just Chuckin' It's 19 badges** — 18 laddered milestones (3 tracks — a lot to earn, starting early and often, exactly as requested; see [Just Chuckin' It](#new-game)) plus its own **180!** badge:

| Ladder | Tiers (threshold — label) |
|---|---|
| Lifetime Darts Thrown | 100 Warming Up 🔥 · 500 In the Groove 🎯 · 1,000 Getting Serious 💪 · 2,500 Dedicated 📈 · 5,000 Grinder ⚙️ · 10,000 Iron Arm 🦾 · 25,000 Practice Makes Perfect 🏹 · 50,000 Machine 🤖 · 100,000 Legend of the Oche 👑 |
| Darts in a Single Session | 100 Solid Session ⏱️ · 250 Marathon Session 🏃 · 500 Endurance Test 🧗 · 1,000 Iron Session 🔋 |
| Lifetime Trebles Hit | 10 First Trebles 🎯 · 50 Treble Trouble 💥 · 100 Treble Century 💯 · 500 Treble Master 🌟 · 1,000 Treble Legend 🐐 |

| Badge | How to earn it |
|---|---|
| 🎯 **180!** | Three darts, sixty each — assuming 3 darts per turn (the same convention as the ladders above), since Just Chuckin' It otherwise has no turn boundary at all |

**Badge Case** — every player's profile ([Player Profile](#player-profile)) shows the full 46-badge roster, grouped into X01/Cricket/Daily Challenge/Just Chuckin' It sections: greyed out and desaturated if not yet earned, full color once it is. A gold counter circle appears in the top-right corner of any badge earned more than once (e.g. Hat Trick ×5, or 180! after a second 180 in the same session) — 4 X01 badges (Around the Clock, Around the World, Grudge Match, First 100+ Checkout), Full Rotation, and all 18 Just Chuckin' It milestones are one-time-only by nature and never show a counter beyond 1. **Hover** any badge to see how to earn it; **tap** it on a touchscreen for the same info in a popup, since hover doesn't exist on touch. Earned badges get their own **📤 Share** button.

**Around the World Progress** — a dedicated grid on the Player Profile showing exactly which of the 63 lifetime dart outcomes are still missing, alongside the Badge Case.

**Every badge a turn earns actually shows.** A single leg-winning visit can genuinely earn more than one badge at once — a decider leg won after a big comeback against a stronger opponent, for example, is Comeback Kid *and* Nerves of Steel *and* Giant Slayer all at once. Each one flashes in turn, back to back, with its own overlay and its own moment card, instead of only the last one clobbering the rest. Two pairs are deliberately treated as the same story wearing two labels rather than double-firing: a busted three-treble-20 shows **Busted Maximum**, not also the more generic Ton-titled to Nothing; hitting the double bull twice shows **Bullseye Gauntlet**, not also Double Trouble.

**What the overlay tells you** — every flash names the badge, who earned it, and a plain-language line explaining how (the same text as the Badge Case tooltip above). Recurring badges' shareable moment card also folds in the running count once it's confirmed ("Earned 5× total"), without delaying the flash itself waiting on that confirmation.

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

**Playing it:** switch to **🎯 Daily Challenge** mode on the [New Game](#new-game) screen — see that section for how player selection and PIN protection work in this mode. Only one attempt is allowed per player per calendar day — the app checks before starting and refuses a second attempt outright (and the server independently rejects duplicates), matching how a real Wordle guess works. An admin can reset a player's attempt from **Settings → Daily Challenge**, which deletes the attempt *and every stat recorded during it* so the player can retake that day's challenge cleanly.

**Home page teaser:** the Home screen always shows a **🎯 Today's Challenge** card describing today's format, with a link to New Game — it's read-only (no player picker, no Start button) and shows the same information regardless of who's using the shared screen.

**Streaks & history:** the New Game panel shows the current player's streak (consecutive days with a completed attempt) and the last 7 days as a row of colored dots (gold = completed, grey = missed or unfinished). A missed or unfinished day breaks the streak.

**Sharing:** completing a challenge offers the same **📤 Share** card as any other big moment (see [Shareable Moments](#shareable-moments)), captioned with the format and result (e.g. "Checkout Sprint — 170 in 3 darts"). Beating your own best-ever result for that format also patches a gold "New personal best!" banner onto the results screen.

**Player Profile history:** every [Player Profile](#player-profile) has its own **Daily Challenge** tab (alongside Overall/H2H/Practice) showing the lifetime completion record (played, completed, current streak, longest-ever streak), a best-result line for each of the six formats, the full attempt-by-attempt log, and the Badge Case.

**Badges:** completing challenges 7 and 30 days in a row earns **Challenge Streak: Week** and **Challenge Streak: Month**; completing all six formats at least once earns **Full Rotation** — see [Achievements & Badges](#achievements--badges).

---

### Shareable Moments

Big moments — a 180, a Big Fish, a nine-darter, a match win, any of the 22 [achievement badges](#achievements--badges), an [On This Day](#player-profile) flashback, or a completed [Daily Challenge](#daily-challenge) — get a **📤 Share** button that generates a shareable card image entirely on-device (canvas, styled to match the app), then either opens your phone's native share sheet (to Messages, X, Instagram, Facebook, or anything else it offers) or falls back to a plain image download on browsers without share-sheet support. Nothing is ever uploaded anywhere by this button — it's the same image whether you share it or save it.

- **Where it shows up:** the achievement overlay (180/Big Fish/nine-darter/any badge) while it's flashing, the Game Over screen after a match win, the Daily Challenge result panel, a badge's entry in the **Badge Case**, and next to Best Leg Average / Fewest Darts to Finish on a **Player Profile**'s Personal Bests.
- **Card tagline** (**Settings → Shareable Moments**) — a short editable line printed on every card, defaulting to "Darts tracked via Oche — track your darts today!". Update it once you have a real website or social handle to point at.
- **Automatic Home Assistant delivery:** independent of the Share button, if a **Moment Card Webhook ID** is configured (**Settings → Smart Home Integration**), the same card is sent to your HA instance automatically as a base64-encoded image the moment it happens — useful for routing it into Discord, Telegram, or anywhere else your own HA automations already reach. Personal-best cards are share-button-only (no automatic HA delivery), since there's no live "new personal best" detection during play yet.
- Not affiliated with or posting directly to X/Instagram/Facebook's own APIs — see `docs/archive/shareable-moments-roadmap.md` for why direct API posting isn't realistic for a personal account on any of those three platforms today.

---

### Live Scoreboard

Open **`http://<your-server>:8046/display`** on a TV or second monitor. It updates in real time via Server-Sent Events (SSE) — no refreshing needed.

**Layout presets** — pick **Full**, **Compact**, or **Minimal** from **Settings → Live Scoreboard**, or override per-screen with `?layout=compact` in the URL (handy when different screens in the same room want different densities). Checkout suggestions, achievement flashes, and the match bar always show regardless of layout — only the denser rows (dart counts, leg/game averages, and the 180/Big Fish/Bust counters) are hidden on Compact and Minimal, so a smaller screen isn't stuck showing TV-sized clutter.

**Portrait and landscape** — the scoreboard automatically detects which orientation the screen is in and reshapes itself: landscape keeps the usual side-by-side player cards, while portrait (e.g. a tablet or spare phone mounted upright) stacks every player's card in a single full-width column instead of squeezing them into narrow side-by-side cells. Rotating the device mid-match updates the layout immediately, without waiting for the next dart or turn.

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

**Cricket games** replace the per-player cards with a single traditional
chalkboard-style scorecard table spanning the whole screen — one row per
target number (highest to lowest, Bull last), one column per player, marks
shown as a slash (1), an X (2), or a circled X (3+/closed — never color alone),
plus a points footer row. The currently-throwing player's column is
highlighted, and the grid always shows this table in a single column
regardless of player count or screen orientation.

**Between legs:** score cards are replaced with a leg summary — average, darts thrown, and busts per player (points and numbers closed, for Cricket) — until the next leg starts.

**Leg/Set/Game banners:** full-screen result announced when a unit ends.

**Achievement overlays:** full-screen flash for 180s (🎯), Big Fish (🐟), and nine-darters (🏆, with confetti) the moment they're scored, plus any of the 22 [achievement badges](#achievements--badges) (Hat Trick, Nerves of Steel, Around the World, and so on) — each with a **📤 Share** button (see [Shareable Moments](#shareable-moments) below). If a single turn or leg genuinely earns more than one badge at once, every one of them shows and shares in sequence instead of only the last one — see [Achievements & Badges](#achievements--badges) below.

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

**Overall** · **H2H** · **Practice** — all stats and charts filter to the selected mode. A second game-type toggle sits just above the stat bubbles — **X01 / Cricket / Doubles Practice / Just Chuckin' It** — switches the bubbles, chart, and Personal Bests section between each game type's own stat vocabulary (X01's 15 stats, Cricket's 6, Doubles Practice's 3, or Chuckin's 6 — see below). The Home page's leaderboards cover X01, Cricket, and Doubles Practice — Just Chuckin' It doesn't have a competitive leaderboard shape to show there (no wins, no opponent), so it's Player Profile-only.

#### Stat Bubbles

Fifteen X01 stat bubbles are available; five (Darts Thrown, Average, 180s, Big Fish, 9 Darters) show by default and the rest live behind a "More stats" toggle. Click any bubble to display that metric in the chart below.

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
| **1st 3 AVG** | Average of the first visit of each leg (501/301 only) |
| **1st 9 AVG** | Average of the first three visits of each leg (501/301 only) |
| **100+ AVG** | Percentage of legs with a 100+ average |
| **90- AVG** | Percentage of legs with a 90 or lower average |
| **140/Leg** | Percentage of opening visits scoring 140 or more |
| **180s/Leg** | Ratio of 180s to total legs played |

Switching the toggle above to **Cricket** shows Cricket's own 6 stat bubbles instead:

| Bubble | Description |
|---|---|
| **MPR** | Marks Per Round — total marks scored ÷ rounds played, Cricket's direct analog of 3-dart average |
| **9 Marks** | Visits where all 3 darts scored the maximum 9 marks (three trebles) |
| **Win Rate** | Percentage of H2H Cricket games won |
| **Games Played** | Cricket games played |
| **Darts Thrown** | Darts thrown in Cricket games specifically |
| **Darts / Won Leg** | Average darts thrown per won Cricket leg |

Switching to **Doubles Practice** shows its own 3 stat bubbles instead:

| Bubble | Description |
|---|---|
| **Doubles %** | Doubles hit ÷ every dart ever thrown in this mode, lifetime |
| **Darts / Round** | Average darts thrown per round |
| **Doubles Hit / Round** | Average doubles hit per round |

Switching to **Just Chuckin' It** shows its own 8 stat bubbles instead, plus a dartboard heatmap section below the chart:

| Bubble | Description |
|---|---|
| **Darts Thrown** | Total individual darts thrown in this mode, lifetime |
| **Three-Dart Average** | Standard 3-dart average across every dart thrown, lifetime — same formula as X01, assuming 3 darts per turn |
| **180s** | Count of 180s thrown (3 consecutive darts, treated as a turn, all landing as treble 20) |
| **Treble %** | Percentage of darts that landed as a treble |
| **Bull %** | Percentage of darts that landed on the bull (single or double) |
| **Double %** | Percentage of darts that landed as a double |
| **Sessions Played** | Number of Just Chuckin' It sessions played |
| **Avg Darts / Session** | Average darts thrown per session |

#### Chart

A line chart showing the selected metric over time. Filters:

- **Period:** Today · Week · Month · Year · All time · Custom date range
- **Dart weight:** filter to games thrown with a specific dart weight (if recorded)

#### Personal Bests

- **Best Leg Average**
- **Fewest Darts to Finish**
- **Current Win Streak**
- **Recent Form** — average of the last 10 legs, with an arrow showing the delta vs. lifetime average

On the Cricket toggle, this section shows **Best Leg MPR**, **Fewest Darts to Close**, **Current Win Streak**, and **Recent Form** (MPR-based) instead — the same shape, keyed off the turn that won each Cricket leg rather than an X01 checkout.

On the Doubles Practice toggle, this section shows just **Best Round (Darts)** and **Best Round (Doubles Hit)** — no win-streak/recent-form fields, since this mode has no win condition. On the Just Chuckin' It toggle, it shows **Best Session (Darts)** and **Best Session (Trebles)**, the same deliberately-smaller 2-field shape.

#### Badge Case

The full 46-badge [achievement](#achievements--badges) roster for this player, grouped into an **X01** section (22 badges), a **Cricket** section (2 badges), a **Daily Challenge** section (3 badges), and a **Just Chuckin' It** section (19 badges) — greyed out until earned, full color once earned, with a counter for badges earned more than once. Hover (or tap on a touchscreen) any badge to see how to earn it.

#### On This Day

When this player did something notable — a 180, a 170 checkout, or any 100+ checkout — on today's exact calendar date in a past year, a flashback card shows it ("3 years ago today — a 180, 501") with its own **📤 Share** button. Only appears when there's something to show.

#### Daily Challenge (tab)

Its own tab on the Player Profile (alongside Overall/H2H/Practice), covering this player's lifetime [Daily Challenge](#daily-challenge) record: total attempts vs. completions, current streak, longest-ever streak, a best-result line for each of the six formats, the full attempt-by-attempt log (date, format, result or "Not finished"), and the Badge Case.

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

The Settings page (accessible from the top navigation) holds app-wide configuration, grouped into four tabs: **Account & Access**, **Gameplay & Display**, **Integrations**, and **Admin & Danger Zone**. Each section — **Admin accounts**, **Player PINs**, **Scoring**, **Accessibility**, **Voice Announcements**, **Shareable Moments**, **Data Collection**, **Live Scoreboard**, **Smart Home Integration**, **Daily Challenge**, **Server Errors**, **Backups**, **Data Export**, and **Danger Zone** — is collapsed to just its header by default; click a header to expand it.

Settings require an admin login (see [Admin Accounts & Player PINs](#admin-accounts--player-pins)) — until an admin account exists, the page offers to create the first one.

#### Scoring

- **Default input** — which dart entry method a new game opens with: **Dartboard** (tap the sector you hit) or **Pad** (number grid with a multiplier selector). Either can still be switched per-session from the scoring screen itself. **Pad is the app's accessible input path** — plain focusable buttons, no dartboard shape or precise tapping required — worth setting as the default for a low-vision or motor-impaired player.

#### Accessibility

- **Colorblind-friendly palette** — swaps the app's red/green double and treble colors (dartboard rings, Pad mode's Double/Treble buttons, win/bust status text, and the live scoreboard's checkout flashes and dart-class colors) for a blue/orange palette. Applies to this device and the `/display` scoreboard.
- **Screen-reader announcements** — always on, no setting needed. A visually-hidden live region announces the result of every committed turn ("Alice scores 60, 201 remaining." / "Alice busts, stays on 140." / "Alice checks out with 40. Leg won.") and every achievement badge as it flashes, using the same explanation text as the Badge Case tooltip. Deliberately limited to committed turn results and achievements, not every intermediate dart tap, so it doesn't talk over itself.

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

See [`docs/home-assistant-recipes.md`](docs/home-assistant-recipes.md) for a set of
ready-to-paste HA automations built on these webhooks — flashing lights on a bust/180/
checkout, spoken call-outs, a "game night" lighting scene, phone push notifications,
and posting moment cards to Discord.

#### Daily Challenge

- **Reset a player's attempt** — pick a player and a challenge date (defaults to today) and reset that attempt: the attempt record **and every stat recorded during it** (the game, turns, and darts) are deleted, so the player can retake that day's challenge with a clean slate. Badges earned during the wiped attempt are kept. Admin-only, with a confirmation dialog spelling out exactly what gets deleted.

#### Server Errors

Shows the most recent server-side failures (up to 500, newest first) — the same record kept for a self-hosted setup that doesn't have shell/`docker logs` access. Only genuine server errors (5xx) appear here; ordinary mistakes like a bad login or an invalid PIN don't. Click **Refresh** to pull the latest.

#### Data Export

- **Export all data** — downloads a complete JSON export of every player, game, and stat in the database. Admin-only; there's no per-player export and nothing export-related appears on a player's own page. Excludes admin accounts, sessions, app settings, and player PINs.

#### Danger Zone

- **Wipe all player & game data** — permanently deletes every player, game, and stat. Admin accounts and settings are kept. Meant for clearing out test/dev data, not everyday use.

Settings are persisted in the database and survive container restarts.

---

## Admin Accounts & Player PINs

Oche follows a zero-trust default: **every write requires a logged-in admin**, even on your own home LAN — not just the destructive/admin-only actions below.

### First-run setup

The first time you open the app with no admin account yet, a welcome screen offers to create one. Because every write requires admin login by default, this isn't optional busywork — skipping it means no players can be added and no games can be started until an account exists (you'll see the same prompt again the next time you try). Viewing stats and the live scoreboard never require a login, with or without an admin account.

Once created, that admin's session lasts 30 days per device/browser — a household typically only needs to log in once on whichever device actually runs the scoreboard, not on every device that views it.

Settings itself has its own equivalent gate: opening it with no admin account yet asks you to create one there instead, if you didn't already from the welcome screen.

### Admin accounts

- Any number of admin accounts can exist; there must always be at least one
- Admins can access Settings, manage other admin accounts, set/reset player PINs, and perform destructive player actions (delete player, reset stats)
- Sessions are stored server-side and tracked via a cookie — logging out clears the session
- Repeated wrong login attempts trigger a progressive backoff, not a hard lockout: the first few (default 3, configurable) cost no delay at all, then each further consecutive failure doubles the wait (default base 2s, capped at 15 min) before the next attempt is allowed — a real admin is never permanently locked out, only ever made to wait a little longer, and the correct password always works the instant the wait has elapsed. Tune the grace/base/max values in **Settings → Admin accounts**

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
| Reset a player's Daily Challenge attempt (and wipe its recorded stats) | Yes |
| Wipe all player/game/stat data | Yes |
| Set or remove a player's PIN | Yes |
| Add/remove admin accounts | Yes |
| Change Home Assistant / webhook / scoreboard-layout / default-input settings | Yes |
| Download/delete a backup, change retention, take an on-demand backup | Yes |
| Restore the database from a backup | **Yes, plus your admin password again** — an active session alone isn't enough for this one |
| Verify a player's PIN to add them to a game | No — public, but rate-limited by both the lockout threshold and a per-IP request budget |
| Log in as an admin | No — public, but rate-limited by both its own progressive backoff and a per-IP request budget |
| View stats, watch the live scoreboard | No — always public, regardless of the setting below |
| Add a player, start a game, record turns, everything else that writes | **Yes, by default** — see below |

### Zero-trust by default: opting back into open-LAN behavior

Every write (creating players/games, recording turns, badges, challenges, and the
live-scoreboard feed) requires a logged-in admin session by default — even on a
network you fully trust. Reads always stay public, so the read-only scoreboard and
stats pages work for everyone with no login needed to just watch.

Set the environment variable **`OCHE_REQUIRE_AUTH=false`** to opt back into the old
LAN-trust behavior instead: reads *and* gameplay writes both open, and only the
admin/destructive actions in the table above still require login. Only do this on a
network you fully trust (no untrusted devices, no internet exposure) — player PINs
are a UI convenience, not real authentication. They gate the player picker, **not**
the underlying API, so with `OCHE_REQUIRE_AUTH=false` anyone who can reach the server
could record games or edit players directly.

### Exposing this to the internet — checklist

If you're putting this somewhere reachable from the open internet (not just your LAN),
work through this list. It's also tracked in `docs/security-audit-roadmap.md`.

- **Put it behind a TLS-terminating reverse proxy.** The app itself only speaks plain HTTP.
- **Set `COOKIE_SECURE=true`** once it's served over HTTPS, so the admin session cookie
  gets the `Secure` flag.
- **Leave `OCHE_REQUIRE_AUTH` at its default (`true`)** — every write already requires a
  logged-in admin with no configuration needed.
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
  Assistant webhook) uses the same admin-login gate as every other write endpoint above —
  nothing extra to configure for it either.

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
GET    /api/auth-config                     { requireAuth } — the effective OCHE_REQUIRE_AUTH
                                             value (true by default; read at app boot to know
                                             if writes need a login)
POST   /api/setup                           Create the first admin   { username, password }
                                             (only while setup-required)
POST   /api/login                           Log in                   { username, password }
                                             → sets session cookie
POST   /api/logout                          Clear the session cookie
GET    /api/me                              { loggedIn, username? }
GET    /api/admins                          List admin accounts                      [admin]
POST   /api/admins                          Add an admin             { username, password } [admin]
DELETE /api/admins?id=                      Remove an admin                          [admin]
PUT    /api/admins/password                 Change an admin's password { id, password } [admin]
GET    /api/errors?limit=                   Recent server-side 5xx failures (default 100, max 500) [admin]
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
GET  /api/stats/cricket-9marks?mode=        Cricket 9-marks-in-one-visit leaderboard
GET  /api/stats/cricket-mpr?mode=           Cricket Marks Per Round leaderboard (min. 5 rounds)
GET  /api/stats/cricket-wins                Cricket win-rate leaderboard (H2H only, no mode param)
GET  /api/stats/cricket-perfect-leg?mode=   Cricket "closed in the fewest possible darts" leaderboard
GET  /api/stats/doubles-practice-accuracy   Doubles % leaderboard (no mode param — always practice)
GET  /api/stats/doubles-practice-best-round Doubles Practice best-single-round leaderboard (no mode param)
```

All leaderboard endpoints accept `?mode=h2h|practice` to filter by game mode. Omit for overall. The
two Doubles Practice endpoints above never take a `mode` param — the game type is always solo
practice, so there's no H2H side to split against (same reasoning as `cricket-wins` above, just the
opposite polarity).

### Per-Player Stats

```
GET  /api/players/stat-bubbles?name=&mode=  All 15 stat bubble values for a player.
     &gameType=cricket                      Pass gameType=cricket for Cricket's 6 stat bubbles
                                             (MPR, 9 Marks, Win Rate, Games Played, Darts
                                             Thrown, Darts/Won Leg) instead of X01's 15.
     &gameType=doubles_practice             Pass gameType=doubles_practice for Doubles
                                             Practice's 3 stat bubbles (Doubles %, Darts/Round,
                                             Doubles Hit/Round) instead.
     &gameType=chuckin                      Pass gameType=chuckin for Just Chuckin' It's 8
                                             stat bubbles (Darts Thrown, Three-Dart Average,
                                             180s, Treble/Bull/Double %, Sessions Played,
                                             Avg Darts/Session) instead.
GET  /api/players/personal-bests?name=&mode= Best leg average, fewest darts to finish,
                                             current win streak, and recent form.
     &gameType=cricket                      Pass gameType=cricket for Cricket's Personal Bests
                                             (best leg MPR, fewest darts to close, win streak,
                                             recent/lifetime MPR) instead.
     &gameType=doubles_practice             Pass gameType=doubles_practice for Doubles
                                             Practice's Personal Bests (longest round by darts,
                                             most doubles hit in a round) instead.
     &gameType=chuckin                      Pass gameType=chuckin for Just Chuckin' It's
                                             Personal Bests (longest session by darts, most
                                             trebles hit in a session) instead.
GET  /api/players/chuckin-heatmap?name=&mode= Per-(sector,multiplier) hit counts for Just
                                             Chuckin' It, feeding the Player Profile's dartboard
                                             heatmap → [ { sector, multiplier, hits } ]
GET  /api/players/top-finishes?name=&mode=  Top 10 checkouts for a player
GET  /api/players/checkout-route            Most-used routes for a specific checkout score
     ?name=&score=&mode=
GET  /api/players/dart-analytics?name=&mode= Per-dart hit frequency, treble rates,
                                             and checkout route breakdown
GET  /api/players/h2h?p1=&p2=               Head-to-head record between two players
                                             (used by the New Game H2H banner)
GET  /api/players/ghost-legs?name=&limit=   X01 legs this player has won, most recent
                                             first (Ghost Opponent's leg picker)
GET  /api/players/ghost-script              A specific past leg's dart-by-dart replay
     ?gameId=&setNo=&legNo=&name=           script — 404 if that player didn't win it
GET  /api/players/avg-history               Metric history for the chart
     ?name=
     &metric=avg|180s|bigfish|ninedarters|treblelesspct|
              first3avg|first9avg|avg100plus|avg90minus|score140pct|180sperleg|
              dartsthrown|avgdartsperday|avgdartsperleg|pace|
              cricketmpr|cricket9marks|cricketwinpct|cricketgames|
              cricketdartsthrown|cricketavgdartsperleg|
              doublespracticepct|doublespracticedartsperround|
              doublespracticehitsperround|
              chuckindartsthrown|chuckinavg|chuckin180s|chuckintreblepct|
              chuckinbullpct|chuckindoublepct|chuckinsessions|
              chuckinavgdartspersession
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
POST /api/badges/revoke                     Reverse one occurrence of a badge { player, badgeId }
                                             → { count } — decrements the count, deleting the
                                             row at 0 (used by Undo Last Turn)
GET  /api/players/badges?name=              This player's earned badges
                                             → [ { badge_id, count, earned_at } ]
GET  /api/players/h2h-summary               Games played and previous-match winner between two
     ?player=&opponent=&excludeGameId=       players (used by the Grudge Match/Rematch badges)
GET  /api/players/around-the-world?name=    Around the World progress
                                             → { hit: [{sector, mult}], count, total: 63 }
GET  /api/players/on-this-day               Most notable thing this player did on today's exact
     ?name=&tz=                             calendar date in a past year (180 > 170 checkout >
                                             100+ checkout, in that priority order)
                                             → { type, year, yearsAgo, statLine } | null
```

### Daily Challenge

```
POST /api/challenges/start                  Register today's attempt
                                             { player, gameId, challengeDate, format, target }
                                             → 409 if already attempted this date
POST /api/challenges/complete               Record a result { player, challengeDate, resultDarts }
                                             → { ok, isPersonalBest } — 404 if no matching attempt
GET  /api/challenges/status                 Today's attempt, current streak, and 7-day history
     ?player=&date=YYYY-MM-DD               → { today, streak, history }
GET  /api/challenges/history                Lifetime completion record, best result per format,
     ?player=&date=YYYY-MM-DD               and the full attempt-by-attempt log
                                             → { played, completed, currentStreak, longestStreak,
                                                  bestByFormat, attempts }
DELETE /api/challenges/attempt              Reset a player's attempt for a date — deletes the    [admin]
     ?player=&date=YYYY-MM-DD               attempt AND the game/turns/darts recorded during it,
                                             unlocking a retake of that day's challenge
```

### Games

```
POST /api/games                             Start a game
                                             { category, legsPerSet, setsPerGame,
                                               players: [{ name, out }], practice: 0|1,
                                               gameType: "x01"|"cricket"|"doubles_practice"|
                                                         "chuckin" (default "x01"),
                                               config: { startingScore } for x01,
                                                       { numbers: [7 sectors] } for cricket,
                                                       { doubles: [sectors] } for doubles_practice,
                                                       {} for chuckin }
                                             → { gameId }

POST /api/games/:id/turns                   Record a visit
                                             { player, set, leg, scored,
                                               bust, checkout, checkoutPoints, legWon,
                                               darts: [{sector, multiplier}] }
                                             legWon marks the turn that won the leg —
                                             set by Cricket (which has no checkout
                                             mechanism); X01 omits it and keeps using
                                             checkout for its own Personal Bests.

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
                                               pin_lockout_threshold, admin_lockout_grace,
                                               admin_lockout_base_seconds, admin_lockout_max_seconds,
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

### Backups

```
GET  /api/backups                           List backups + current retention -> {backups,retentionDays} [admin]
POST /api/backups                           Take an on-demand backup now -> {ok,backup}                  [admin]
PUT  /api/backups/retention                 {days} -> {ok,retentionDays,pruned}                          [admin]
GET  /api/backups/download                  (?name=...) streams the backup file                          [admin]
DEL  /api/backups                           (?name=...) delete one backup                                [admin]
POST /api/backups/restore                   {name,password} restore from an existing backup;             [admin]
                                             re-verifies the admin password independent of the session
POST /api/backups/upload-restore            Raw .db file body, X-Admin-Password header; validates        [admin]
                                             the file (header + integrity check) before staging it,
                                             same restore as above. Capped at 500MB.
```

### Data Export

```
GET  /api/export-all                        Streams a full-database JSON export as a download            [admin]
                                             (excludes admins/sessions/settings/server_errors and
                                             all player PIN/credential columns)
```

---

## Architecture

```
oche/
├── backend/
│   ├── server.js    Dependency-free HTTP server (Node built-ins only)
│   ├── db.js        SQLite schema, migrations, and all stat queries
│   ├── auth.js      Password/PIN hashing, session tokens, cookie helpers
│   ├── netguard.js  Outbound-request egress guard (blocks loopback/link-local)
│   ├── backup.js    Stand-alone WAL-safe backup script (see Backups)
│   ├── backup-lib.js  Shared backup/restore mechanics (used by backup.js and server.js)
│   └── admin-recovery.js  Stand-alone admin password reset / lockout-clear CLI
├── frontend/
│   ├── index.html    The entire app — one self-contained HTML file
│   └── display.html  Read-only live scoreboard for a second screen
├── docker-compose.yml
├── docker-compose.dev.yml        Dev instance on port 8056
├── docker-compose.portainer.yml  No-build variant for Portainer/Unraid
├── docker-entrypoint.sh          Fixes /data ownership, then drops to non-root
└── Dockerfile
```

**Backend** — a single `http.createServer` with no npm dependencies. Uses `node:sqlite` (built into Node 22.13+) in WAL mode with foreign keys enabled. All statistics are computed from raw turn and dart data at query time — nothing is pre-aggregated, so stats are always consistent and new metrics can be added without migrations. Every write endpoint is rate-limited per IP, and outbound requests (Home Assistant) are checked against `netguard.js` before connecting — see [Admin Accounts & Player PINs](#admin-accounts--player-pins) for the full security posture.

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

**Or manage it all from the app:** **Settings → Admin & Danger Zone → Backups** lets
you download existing backups, change the retention window, take an on-demand backup
(useful if you haven't set up host cron yet), and restore from either an existing
backup or an uploaded `.db` file — no shell access needed. An uploaded file is checked
(header + integrity check) before anything is replaced, and restoring always asks for
your admin password again, even though you're already logged in, since it replaces the
entire database. Either restore path stages the file and then tells you to restart the
container — it doesn't restart itself, so nothing takes effect until you do.

**Or let a container do the scheduling for you, if you'd rather not touch host
cron at all:** an opt-in `backups` service is already defined in
`docker-compose.yml`, disabled by default. Enable it with:

```
docker compose --profile backups up -d
```

It reuses the same image and `./darts_data` volume as the main `darts` service —
no separate setup — and runs `backend/backup.js` once immediately, then every 24h,
using the same retention setting as everywhere else (Settings → Backups, or
`BACKUP_RETENTION_DAYS`). This is a simple loop, not a wall-clock-pinned schedule
(it won't land on exactly 3am the way the cron recipe above does) — use host cron
instead if that precision matters to you.

### Data Export

**Settings → Admin & Danger Zone → Data Export** lets an admin download a complete JSON
export of every player, game, and stat in the database with one click — it's your data,
and you can always take it with you. This is admin-only: there is no per-player export
and no export entry point anywhere on a player's own page. The export never includes
admin accounts, sessions, app settings, or any player's PIN.

### Admin Account Recovery

If you've forgotten the admin password — or an admin account is stuck in its login
lockout — with no other admin able to log in to fix it, use `backend/admin-recovery.js`.
It's a standalone script with direct filesystem/container access, the same trust
boundary every other sensitive operation on a self-hosted install already assumes
(editing `docker-compose.yml`, reading the raw `darts.db` file). It's safe to run
while the container keeps serving normally — no need to stop it first.

Via Docker (most self-hosters' primary path):

```
docker exec -it oche node backend/admin-recovery.js list
```

Or directly on the host, pointing `DARTS_DB` at the live database file:

```
DARTS_DB=/path/to/darts_data/darts.db node backend/admin-recovery.js list
```

**Subcommands:**

```
list                          Prints every admin's username, creation date, and
                               current lockout status.
reset-password <username>     Sets a new password AND clears any lockout — a
                               locked-out admin can log in again immediately with
                               the new password, not just once the lock naturally
                               expires.
clear-lockout <username>      Clears a stuck lockout without changing the
                               password at all, for "I remember my password fine,
                               I just got locked out."
```

**Entering the new password**: avoid passing it as a plain argument (it would leak
into shell history and `ps` output) — pipe it in instead, the same way `htpasswd`/
`openssl passwd -stdin` do:

```
echo -n 'newpassword' | docker exec -i oche node backend/admin-recovery.js reset-password alice
```

Piping still leaves the echoed value in your *own* shell's history unless you're
careful (e.g. prefix the command with a space, if your shell is configured to skip
history for space-prefixed commands). Running the command with no piped input at
all drops into an interactive, masked prompt instead (asked twice, since a masked
prompt gives no visual feedback to catch a typo) — useful when running it directly
inside an interactive `docker exec -it` session.

There's deliberately no way to create a brand-new admin from scratch with this
script — that's what the first-run setup wizard (when zero admins exist) and
Settings → Admin Accounts (once logged in) are for. This is recovery of an
*existing* account only.
