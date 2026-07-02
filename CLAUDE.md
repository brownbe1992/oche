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

### Accessibility is a standing design concern, not a one-off pass

Every new feature (in this codebase or any `docs/*.md` roadmap) should consider
keyboard/focus order, color-only signals, and screen-reader announcements as part of
its own design — not bolted on afterward. Colorblind mode is the first concrete fix,
but it isn't the whole of it.

Full checklist, current gaps, and priority order: `docs/accessibility-roadmap.md`.

### Every new feature considers its security surface, not just its own function

Any feature that adds a new credential, token, or secret (an API key, a webhook
token, TURN credentials, anything similar) should ask up front whether it needs
write-only handling (never returned to the client) and whether whatever verifies it
needs brute-force protection — the same standard already applied to admin logins and
player PINs.

Full checklist and current gaps: `docs/security-hardening-roadmap.md`.

### New features get test coverage for their core logic, not just manual verification

Once a real test runner exists (see `docs/testing-and-observability-roadmap.md`), new
features touching scoring/stats logic should add tests for that logic as part of
building it — not defer it, and not rely solely on manual/Playwright verification the
way this project has so far.

Full plan and current status: `docs/testing-and-observability-roadmap.md`.

## Roadmap docs

`docs/*.md` holds design roadmaps for features that are planned but not yet built —
tournament mode, additional game types, camera/ML scoring, a mobile app, online
multiplayer, and others (see `wishlist` at the repo root for the full index). When
implementing something described in one of these docs, update that doc's status
inline (and any other doc referencing the same work) to reflect what's done, rather
than leaving it silently out of date.

## Reference manual — `REFERENCE.md` must be kept current

`REFERENCE.md` (repo root) is the **specification** — the single authoritative
statement of what the app is *supposed* to do: every stat's precise formula, every
achievement's exact trigger condition, the full database schema, the full API
surface, and the internal mechanics behind every feature (the achievement queue,
Daily Challenge streak logic, security model, and so on). It exists so a question
like "how is this stat calculated" or "why did this badge fire" or "how do I fix
this" always has one authoritative place to look, instead of needing to re-derive
the answer from the code every time.

**Use it to find bugs: when auditing or debugging, cross-reference the code
against `REFERENCE.md` — a mismatch is a bug signal, and the presumption is that
the document describes the intent.** If the code deviates from the documented
behavior, the code has a bug — fix the code, not the doc. (The Average Pace
bubble bug was found exactly this way: the spec said the bubble shows
darts/minute; the code could never display it.) Only update `REFERENCE.md` when
the deviation is a deliberate, intended behavior change — and then it must be
updated **in the same change** that altered the behavior, not as a followup.

**Any change that touches a stat formula, an achievement/badge condition, the
database schema, an API endpoint's request/response shape, or how a feature
mechanically works must update the relevant section of `REFERENCE.md` in the same
change** — not as a followup, not left for later. This is the same standing
discipline as the roadmap-docs convention above, applied to "how the shipped app
is supposed to work" instead of "what's planned." The spec and the code must never
be left disagreeing for a future session to reconcile.

`README.md` stays the user-facing "what it does and how to run it" doc; `REFERENCE.md`
is the "how it works internally, and how to debug it" doc. Both need updating when a
user-visible feature changes; only `REFERENCE.md` needs updating for internal-only
changes (e.g. a formula fix that doesn't change what the stat is called or how it's used).
