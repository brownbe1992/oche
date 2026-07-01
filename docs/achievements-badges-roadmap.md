# Expanded Achievements & Badges — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

## Goal

Extend the existing 180/Big Fish/nine-darter achievement-overlay pattern
(`display.html`'s `ACH_LABELS`/`showAchievement()`) to a broader set of milestones —
mostly content work on top of infrastructure that's already built, not a new system.

## Why this is cheap

The hard part — a full-screen celebration overlay with confetti, achievement-specific
styling, and live-scoreboard integration — already exists and already works for three
achievement types. Adding more is primarily a matter of defining new trigger
conditions and labels, not new plumbing.

## Candidate badges (beyond the existing three)

- **Win streaks** — 5/10/20 consecutive wins, using data already available via the
  existing win-rate leaderboard queries in `getHomeExtra`.
- **First 100+ checkout**, **first 50+ average leg**, **century club** (lifetime
  100+ checkouts reaching a round number) — milestone badges rather than per-game
  achievements, shown once on first occurrence rather than every recurrence.
- **Perfect leg variants beyond the nine-darter** — e.g. an 11-dart or 12-dart 501 leg
  as a "notable" tier below the full nine-darter celebration, using a smaller/lighter
  overlay treatment so the nine-darter still feels uniquely special (avoid diluting
  the app's biggest existing celebration by treating everything the same way).
- **Cricket/Baseball-specific badges** (once those game modes exist per the
  game-modes roadmap) — e.g. Cricket's "9 marks in one visit" as that mode's 180
  equivalent, keeping the badge system extensible per game type from the start rather
  than hardcoded to X01 achievements.

## Design

- A **badges/milestones section** on the Player Profile, alongside Personal Bests —
  a simple earned/not-yet-earned grid, similar in spirit to achievement systems in
  most games, but modest in scope (no points/leveling system needed, just recognition).
- Milestone badges (first-occurrence-only) need a way to check "has this player
  already earned this" without re-triggering the celebration every time the
  underlying stat condition remains true — likely a small `player_badges` table
  (`player_id, badge_id, earned_at`) rather than deriving "already earned" from a
  potentially expensive live query every time.
- Tiered severity in the overlay treatment (routine vs. rare vs. legendary) should be
  deliberate, not just "give everything confetti" — the nine-darter's dedicated mega
  celebration exists precisely because it's the rarest thing in the game; new badges
  shouldn't crowd that out.

## Open questions for whoever picks this up

- Should badges be purely cosmetic/celebratory, or eventually tie into other roadmap
  items (e.g. seeding advantage in tournament mode, shareable-moment card triggers)?
- Full badge list and exact thresholds are a content decision better made once the
  Cricket/Baseball roadmap's own achievements are defined, so the whole system is
  designed for multiple game types from day one rather than retrofitted.
