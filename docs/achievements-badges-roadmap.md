# Expanded Achievements & Badges — Design Roadmap

> Status: **fully shipped**. Every badge in the candidate list is built and tested
> end-to-end (`frontend/index.html`'s `enterTurn()`/`onLegWon()`, `showAchievement()`/
> `ACH_LABELS` in both `index.html` and `display.html`, the `player_badges` table in
> `backend/db.js`, a Badge Case section on the Player Profile page, and an Around the
> World progress grid). All six suggested-build-order steps are live, including the
> two late additions Double Trouble and Busted Maximum:
> 1. Milestones: first 100+ checkout, Grudge Match, Around the Clock, Around the World.
> 2. Simple recurring: Hat Trick, Bullseye Gauntlet, Double Trouble, Where'd It Go?,
>    Ton-titled to Nothing, Busted Maximum, So Close..., Night Owl/Early Bird.
> 3. Consistency: Metronome, Cruise Control.
> 4. Social/H2H: Giant Slayer, Grudge Match, The Rematch (`getH2HSummary()` in
>    `backend/db.js`, comparing lifetime averages already cached client-side).
> 5. Mental Game/Clutch: Ice in the Veins, Nerves of Steel, Comeback Kid — with two
>    deliberate simplifications instead of guessing exact thresholds: Comeback Kid
>    fires on "trailing by 100+ at any point in the leg" rather than strictly at the
>    literal midpoint, and Nerves of Steel's "decider" check is legs/sets tied one
>    short of the winning threshold entering the leg/set.
> 6. Completionist: Around the Clock (per-session, per-player) and Around the World
>    (lifetime, `getAroundTheWorldProgress()`'s `SELECT DISTINCT sector, multiplier`
>    query) — the progress view is a compact hit/miss grid rather than a full
>    dartboard-shaped heatmap, a deliberate scope simplification from the "ideally"
>    phrasing in the Design section below.
>
> The Badge Case now shows the full 20-badge roster (not just milestones) with a
> count per badge — `player_badges` grew a `count` column, and every recurring
> badge (previously celebrated live but never persisted) now also gets a
> fire-and-forget `awardRecurringBadge()` call so its occurrences are counted.
> State-based badges whose trigger condition stays true forever once crossed
> (Around the Clock, Around the World, Grudge Match) still use `once:true`
> (INSERT OR IGNORE) so re-checking an already-true condition doesn't inflate
> their count — everything else increments on every genuine occurrence. Unearned
> badges render greyscale/dimmed; earned ones show a gold counter circle when
> count > 1.
>
> **Undo Last Turn now revokes any badge that turn awarded**, not just the
> client-side tracking state fixed earlier. A new `revokeBadge()`/`POST
> /api/badges/revoke` (`backend/db.js`, `backend/server.js`) decrements a badge's
> count by one (deleting the row at 0) — symmetric to `awardBadge()`. Each turn's
> undo snapshot carries a `badgeReverts` list, populated by a new
> `trackBadgeForUndo(snap, player, badgeId)` helper called wherever a badge is
> actually awarded; `undoLastTurn()` fires a revoke for everything in that list.
> The tricky part was the once-badges' async award confirmations (Around the
> Clock/World, Grudge Match, First 100+ Checkout) racing against undo — they
> capture the snapshot reference *before* the await, and a `snap.voided` flag
> (set the moment undo runs) makes a late-arriving award self-correct with an
> immediate revoke instead of registering into a revert list nobody will read
> again, regardless of which one — the undo click or the award confirmation —
> happens first.
>
> **Fixed:** a single turn earning more than one badge now shows and broadcasts
> every one of them in sequence via a display queue, instead of the last one
> clobbering the rest — see `docs/simultaneous-achievements-roadmap.md` for the
> design and what shipped. The live overlay also now shows a plain-language
> explanation (`BADGE_INFO[...].desc`) and the shareable moment card folds in the
> real occurrence count once the award API confirms it — `docs/next-session-plan.md`
> item 1.

## Goal

Extend the existing 180/Big Fish/nine-darter achievement-overlay pattern
(`frontend/index.html`'s `showAchievement()`, `display.html`'s `ACH_LABELS`) to a much
broader, more varied set of badges — mostly content work on top of infrastructure
that's already built, not a new system. The explicit design goal is **variety of
shape, not just variety of name**: a badge list that's just "hit N of stat X" at
increasing thresholds (10 180s, 50 180s, 100 180s...) turns into one long grind
wearing different hats. Every badge below is picked to test a genuinely different
thing — precision, nerve, consistency, history, or just a good story — so a player's
badge case feels like a varied collection, not a leaderboard in disguise.

## Why this is cheap

The hard part — a full-screen celebration overlay with confetti, achievement-specific
styling, and live-scoreboard integration — already exists and already works for three
achievement types. Adding more is primarily a matter of defining new trigger
conditions and labels, not new plumbing. Every badge below is checked against data
`backend/db.js` already stores (`turns`, `darts`, `game_players.dart_weight`,
`created_at` timestamps) — none require new data collection, only new queries or
in-session logic.

## Two firing behaviors, not one

- **Recurring celebrations** — fun every time they happen (like 180/Big Fish today).
  Fires the achievement overlay live, during play, no persistence needed beyond what
  already exists.
- **One-time milestones** — earned once, then live permanently in a "badge case."
  These need a small `player_badges` table (`player_id, badge_id, earned_at`) so
  "already earned" is a cheap lookup rather than re-deriving from a potentially
  expensive live query every time, and so the celebration doesn't re-fire every time
  the underlying condition remains true (e.g. lifetime 180 count staying above a
  threshold forever after the first time it's crossed).

Each badge below is tagged **[recurring]** or **[milestone]**.

## Candidate badges

### Precision & Skill
*Uses `getDartAnalytics`'s sector/treble data, or straightforward new queries over
`darts`/`turns` — no new data collection.*

- **Hat Trick** *(recurring)* — three trebles in one visit, any numbers. Distinct from
  180 specifically (three T20s) — this rewards treble *consistency* on any numbers,
  not just luck landing on the biggest one.
- **Bullseye Gauntlet** *(recurring)* — double bull (50) twice in one visit.
- **Double Trouble** *(recurring)* — check out on a visit where the
  **last two darts thrown were both doubles**, any numbers (they don't have to match
  each other or each be the finishing double specifically) — e.g. a 2-dart finish of
  D5, D12, or a 3-dart D16, D9, D10. Dart 1 of a 3-dart visit is irrelevant and doesn't
  need to be a double itself — a total miss, a single, or a treble on dart 1 all still
  qualify as long as darts 2 and 3 are both doubles; the achievement is about the
  *consecutive doubles run ending the leg*, not "every dart in the visit." A single-dart
  double-out checkout does **not** qualify — "consecutive" requires at least two.
  Detection: `_d.length>=2 && _d[_d.length-2].isDouble && _d[_d.length-1].isDouble` on
  the winning visit — no new data needed.
- **Around the Clock** *(milestone)* — every number 1–20 hit as a single at least once
  within a single session. A completionist checklist, not a skill ceiling.
- **Around the World** *(milestone, the big one)* — hit *every* dart outcome at least
  once, lifetime: all 20 numbers × single/double/treble (60 combinations), plus outer
  bull (25) and inner/double bull (50), plus a miss — **63 distinct outcomes total**.
  This is a genuine long-term collection goal, not a single-session task, and is
  worth a dedicated progress view rather than a simple earned/not-earned flag — see
  Design below.

### Mental Game & Clutch
*Needs reconstructing running score/context from `turns` within a leg — real but
moderate query work, not trivial. Worth prototyping the exact thresholds against real
play data rather than guessing.*

- **Ice in the Veins** *(recurring)* — a 50+ checkout on the very next visit after a
  bust earlier in the same leg.
- **Nerves of Steel** *(recurring)* — win the deciding leg of a set, or the deciding
  set of a match (the final leg of a Bo5/Bo7 specifically, not just any win).
- **Comeback Kid** *(recurring)* — win a leg after trailing by 100+ points at the
  midpoint of the leg.

### Consistency
*A genuinely different skill than "biggest single score" — rewards steady play, which
nothing else in the badge list currently celebrates.*

- **Metronome** *(recurring)* — five consecutive visits all within 15 points of each
  other.
- **Cruise Control** *(recurring)* — an entire leg with no visit scoring below 40.

### Social / H2H
*Uses `getH2HRecord` plus a lifetime-average comparison — both already computable
from existing stats.*

- **Giant Slayer** *(recurring)* — beat an opponent whose lifetime average is 15+
  points higher than yours.
- **Grudge Match** *(milestone)* — face the same opponent 10+ times. A history
  milestone, not a skill badge — recognizes a real rivalry.
- **The Rematch** *(recurring)* — beat someone who beat you the last time you played
  them.

### Novelty & Humor
*Deliberately light and self-deprecating — these are the ones that make a badge case
fun to show off rather than just another leaderboard. Every darts player recognizes
these moments immediately.*

- **Where'd It Go?** *(recurring)* — three misses in one visit. Pairs naturally with
  the "No Score" voice callout already shipped (`docs/voice-announcements-roadmap.md`).
- **Ton-titled to Nothing** *(recurring)* — score 100+ in a visit that still ends in a
  bust.
- **Busted Maximum** *(recurring)* — throw three treble 20s (a genuine
  180) but the visit still busts. Ton-titled to Nothing already catches any 100+ bust
  generically, but a busted maximum is its own specific, extra-painful story worth
  celebrating on its own — a real 180 still happened, it just didn't count for
  scoring. Detection: `_d.length===3 && _d.every(d=>d.sector===20 && d.mult===3) &&
  ev.bust` — checked *before* the generic Ton-titled to Nothing condition so this
  more specific case wins.
- **So Close...** *(recurring)* — open a leg with two treble 20s, then land a single
  20 on the third dart (140 instead of the 180 that was right there). An extremely
  specific, extremely relatable choke moment — exactly the kind of "good story" badge
  this list is trying to have more of.
- **Night Owl** / **Early Bird** *(recurring)* — a leg played after midnight / before
  7am, using the `created_at` timestamps already stored on every turn.

### Milestones (round numbers, first occurrences)
*(milestone)* — first 100+ checkout, first sub-10-dart leg, and lifetime round-number
totals (50th 180, 100th Big Fish, etc.). The most "traditional" badge shape in this
list, deliberately kept to a small share of the total roster rather than the whole
system, per the design goal above.

## Design

- **A "Badge Case" section on the Player Profile**, alongside Personal Bests — an
  earned/not-yet-earned grid. Modest in scope: recognition, not points or leveling.
  Every earned badge gets a **Share** button for free, since the card-generation
  engine from `docs/shareable-moments-roadmap.md` already exists and already builds
  arbitrary icon/headline/player/stat-line cards.
- **Around the World gets its own progress view**, not just a grid cell — e.g. "47/63
  outcomes hit," ideally visualized as a dartboard-shaped heatmap (reusing
  `buildDartboard()`'s existing geometry from `frontend/index.html`) showing which of
  the 63 outcomes are still missing. The completion query itself is just `SELECT
  DISTINCT sector, multiplier FROM darts WHERE ...player...` — no new schema, matching
  the app's "nothing pre-aggregated" philosophy — but the *progress UI* is genuinely
  more work than any other badge here, so it should be scoped and estimated
  separately from the rest of the list rather than assumed to be "just another badge."
- **Tiered severity in the overlay treatment is deliberate.** The nine-darter's
  dedicated mega-celebration (confetti, full-screen, extended duration) exists
  precisely because it's the rarest thing in the game. New badges — even fun ones
  like Hat Trick or So Close — get a lighter, smaller treatment so the app's biggest
  moment doesn't get crowded out by treating everything the same way.
- **Extensibility per game type from day one.** Once Cricket/Baseball exist (per
  `docs/game-modes-roadmap.md`), they need their own badge vocabulary (e.g. Cricket's
  "9 marks in one visit" as that mode's 180-equivalent) rather than every badge being
  implicitly X01-only. The `player_badges` table's `badge_id` should be a free-form
  string key from day one (not an enum tied to X01 concepts) so this doesn't require
  a schema change later.

## Planned: notifications and shareable cards should explain the badge and show the count

*(planned, not yet built)* Today `showAchievement()` only shows an icon and the
badge's name (e.g. "Hat Trick! 🎩") — a player who doesn't already know what each
badge means gets no explanation, live or on the shared image, and neither surface
shows how many times they've earned it. Two things to add, to both the live overlay
and the shareable moment card:

1. **What you did** — a plain-language explanation of the trigger condition.
   `BADGE_INFO[type].desc` (added for the Badge Case's hover/tap tooltips) already
   has exactly this text ("Three trebles (any numbers) in one visit, without
   busting.", etc.) — reuse it as-is rather than maintaining a second copy. This is
   *in addition to* the existing per-instance `statLine` some badges already pass to
   `fireMomentCard()` (e.g. Giant Slayer's "Beat a 87.4 average"), not a replacement
   for it — the generic description explains the badge, the stat line captures what
   was special about *this* instance.
2. **How many times** — the award response already returns `{ newlyEarned, count }`
   (`POST /api/badges/award`) and is simply discarded today. Thread it through to
   both surfaces: "5th Hat Trick" on the overlay, and either a text line or a small
   corner counter on the card (visually consistent with the Badge Case's gold
   counter circle). One-time milestones (Around the Clock/World, Grudge Match) always
   show `count === 1` — "First time!" reads better there than a numeric count.

**The plumbing problem to solve**: the live overlay currently fires *before* the
award network round-trip resolves (so the celebration isn't delayed by a network
call), via `showAchievement(type, player)` — a 2-argument function with no way to
carry a count that doesn't exist yet. `awardRecurringBadge()` is fire-and-forget for
the same reason. Fixing this without reintroducing a delay means:

- Show the overlay/card immediately with the description (always known synchronously
  — no network dependency), then patch the count in a moment later once the award
  response lands (typically near-instant on a LAN) — an in-place DOM text update, not
  a re-render.
- `awardRecurringBadge()` needs to return its promise (or accept a callback) so
  call sites that want the resolved count can react to it, while revocation-tracking
  and other current callers that don't care keep working unchanged.
- The once-badges (Around the Clock/World, Grudge Match, First 100+ Checkout) already
  have the award response in scope at the point they call `showAchievement()` inside
  their `.then()` — trivial to pass `count` through immediately for these, no
  patch-in-place needed.

No new backend work required — `count` is already in the API response, this is
entirely frontend plumbing (`showAchievement()`'s signature, the overlay's DOM in
both `index.html` and `display.html`, and `buildMomentCard()`'s layout).

## Suggested build order

1. `player_badges` table + the small number of milestone badges that are cheap wins
   (first 100+ checkout, first sub-10-dart leg, round-number lifetime totals) —
   proves the earned/not-earned mechanism before anything fancier.
2. The straightforward recurring badges that need no new query complexity (Hat
   Trick, Bullseye Gauntlet, Where'd It Go?, Ton-titled to Nothing, So Close..., Night
   Owl/Early Bird) — all detectable from a single turn's dart rows, the same way 180
   detection already works in `enterTurn()`.
3. Consistency badges (Metronome, Cruise Control) — need a leg's full visit sequence,
   still no cross-leg/cross-game complexity.
4. Social/H2H badges (Giant Slayer, Grudge Match, The Rematch) — need the existing
   `getH2HRecord` plus a lifetime-average lookup.
5. Mental Game/Clutch badges (Ice in the Veins, Nerves of Steel, Comeback Kid) — need
   real prototyping against actual play data to pick sensible thresholds (is "trailing
   by 100 at the midpoint" the right bar? needs testing, not guessing).
6. Around the Clock, then Around the World — the two completionist badges, with
   Around the World's dartboard-heatmap progress view as its own scoped sub-project
   given the extra UI work involved.

## Open questions for whoever picks this up

- Exact thresholds for the Mental Game/Clutch category (how big a deficit counts as
  a "comeback"?) should be validated against real play data, not fixed arbitrarily in
  this doc.
- Should badges eventually tie into other roadmap items (tournament seeding,
  achievement-triggered voice announcements) or stay purely cosmetic/celebratory —
  purely cosmetic is the simpler, safer v1 scope.
- Whether Around the World's progress view is worth building before or after the
  rest of the badge list, given it's meaningfully more UI work than everything else
  combined.
