# Project conventions for Claude

These are binding conventions for this codebase, adopted deliberately and meant to
persist across every session — not just suggestions to reconsider each time.

## Architecture conventions

### New game "contexts" link into `games` via their own table — never a new boolean column on `games`

`games` is the universal record of "a match was played." When a future feature needs
to track that a game belongs to some larger context (a tournament match, a league
game, an online session, or anything similar), that context gets its **own table with
a `game_id` foreign key pointing at `games`** — never a new `is_tournament`/`is_online`
-style boolean bolted directly onto the `games` table itself.

This is already the shape used by `docs/tournament-mode-roadmap.md`
(`tournament_matches.game_id`) and `docs/league-mode-roadmap.md`
(`games.league_id`, nullable FK). Apply the same pattern to any other future context
(online multiplayer, or anything not yet designed) rather than adding a fourth or
fifth boolean flag to `games` — `games` already has `practice`; it should not
accumulate `is_online`, `is_tournament`, etc. one feature at a time.

Full rationale: `docs/existing-app-prep-roadmap.md`, item 3.

## Roadmap docs

`docs/*.md` holds design roadmaps for features that are planned but not yet built —
tournament mode, additional game types, camera/ML scoring, a mobile app, online
multiplayer, and others (see `wishlist` at the repo root for the full index). When
implementing something described in one of these docs, update that doc's status
inline (and any other doc referencing the same work) to reflect what's done, rather
than leaving it silently out of date.
