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

Full rationale: `docs/open-roadmap-items.md`'s completion ledger, "context tables link
into `games` via FK" entry.

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

### Every new calculation gets a permanent, committed test in the same change

Any time a new stat formula, achievement/badge trigger condition, or other
calculation is added or changed (X01, Cricket, or any future game type), it needs a
committed, re-runnable automated test proving the math — not a one-off manual or
Playwright check that gets thrown away once the session ends. This is what closes
the exact gap that let bugs like the backwards trebleless leaderboard or the
missing `OPENING_CATS` filter sit undetected for a while: the only verification
was a person eyeballing numbers once, with nothing left behind to catch the same
mistake creeping back in later.

If `docs/testing-and-observability-roadmap.md`'s Part B (a real `node:test` runner)
doesn't exist yet when this comes up, build the minimal version needed to hold this
one test rather than skipping it — don't wait for a separate, dedicated session to
"do testing properly" first. Every new calculation extends the same suite from then
on, so it only ever grows.

Full plan and current status: `docs/testing-and-observability-roadmap.md`.

## Roadmap docs

`docs/*.md` holds design roadmaps for features that are planned but not yet built —
tournament mode, additional game types, camera/ML scoring, a mobile app, online
multiplayer, and others (see `wishlist` at the repo root for the full index). When
implementing something described in one of these docs, update that doc's status
inline (and any other doc referencing the same work) to reflect what's done, rather
than leaving it silently out of date.

`docs/open-roadmap-items.md` is the **central completion tracker** across every doc
in `docs/` — the one place to check what's done and what's outstanding without
opening each doc individually. Update it in the same change that finishes or
advances any roadmap doc's work, the same discipline as keeping the doc's own status
header current.

**No item on that tracker is ever "Partially Completed."** If a roadmap doc ships
part of its design and defers the rest (a "v1"/"v2" split, a numbered build-order
step left undone, or any other genuinely separable piece of work), split it into
separate, independently-tracked items on `docs/open-roadmap-items.md` instead —
each one cleanly Done or Not started. This applies to the tracker's entries, not to
a roadmap doc's own prose status header, which can still describe nuance in full
sentences.

When every item in a roadmap doc is genuinely done, move it to `docs/archive/`
(`git mv`, preserving history) and fix every cross-reference to its old path in the
same change (other roadmap docs, `README.md`, `REFERENCE.md`, `wishlist`) — don't
leave a doc sitting in `docs/` claiming "done" indefinitely, and don't leave dangling
`docs/whatever.md` references pointing at a path that no longer exists. Archived docs
stay linkable and keep their design rationale; they just stop competing with the
still-open roadmaps for attention. A roadmap doc whose split-out items on
`docs/open-roadmap-items.md` are a mix of Done and Not-started stays in `docs/` —
only archive a doc once every item split out from it is Done.

## Version numbers require explicit confirmation before bumping

`backend/package.json`'s `version` field (mirrored in `README.md`'s `**vX.Y.Z**`
line) must never be bumped as a side effect of other work, and never proposed with
an assumed next value — always ask the user which version to use and wait for
their explicit confirmation before editing either file. This applies even when the
user has already asked for "a version bump" in general terms; confirm the specific
number, since the next logical version isn't always obvious from git history alone.

## Standing security-review methodology

When the owner asks for a "risk assessment" or "security risk assessment" of Oche,
follow the methodology in `docs/security/AI Risk Assessment Prompt.md` verbatim —
same threat model, review areas, report structure, finding format, and metadata —
unless they explicitly say otherwise. That document is the owner's canonical process,
version-controlled on purpose. The most recent output lives alongside it
(`docs/security/oche-internet-exposure-risk-assessment.md`). If a future request
conflicts with the stored methodology, ask which version to use before proceeding
rather than guessing.

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
