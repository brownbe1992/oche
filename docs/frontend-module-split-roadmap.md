# Frontend module split — feasibility, and the shape it should take

> **Status: steps 1, 2 and 3 done (2026-07). Step 4 is a deliberate decision NOT to
> split — see "Reassessment after the db.js split" below. With step 3 shipped this
> document has no open work left; it stays in `docs/` only until step 4's decision is
> reconfirmed or acted on.**
>
> **Step 3 shipped** — one file per game type, 164 functions in 14 files (plus Bob's 27
> first, as the proof), `index.html` 17,529 → 14,112 lines. Every function moved is one
> its `GAME_TYPES` entry names; the registry entry itself stays in `index.html`, so
> there is still one place to see every mode at once. Cut per declaration, verbatim,
> and **verified rather than trusted**: all 164 are byte-identical to their pre-split
> text and the counts reconcile exactly (554 before → 390 left + 164 moved, nothing
> lost, nothing declared twice).
>
> Two safety nets came out of doing it, both from real mistakes made along the way.
> `check.js` gained **`orphan-script`**: extracting into a file with no `<script src>`
> left ten functions dead and *every existing check passed*, because `missing-handler`
> cannot see functions called from the registry by identifier rather than from an
> `on*=` attribute. And `backend/test/frontend-source.js` now returns the whole page
> scope — markup, `app.css`, and every script `index.html` loads, with the list read
> from the page's own tags. Tests that brace-match per-mode functions did not *fail*
> when those functions moved; their dynamically generated cases **stopped existing**,
> and a suite that silently shrinks still prints green. The remaining at-risk tests
> were found by matching all 187 per-mode function names against every test that reads
> `index.html`, rather than waiting for each batch to break one.
>
> This document
> exists because the measurement changed the plan: the item was filed as "split
> `index.html`'s JS into ES modules", and measuring the file says **ES modules are the
> wrong target**. The owner chose the classic-script split described below.
>
> **Shipped** — all six leaf areas extracted, ~2,330 lines, `index.html` 21,172 →
> 19,080:
>
> | File | Lines | |
> |---|---|---|
> | `frontend/js/daily-challenge.js` | 606 | format registry, attempt state, every challenge surface |
> | `frontend/js/dart-builder.js` | 535 | loadouts and the component editor |
> | `frontend/js/tournaments.js` | 453 | bracket setup, seeding, match progression |
> | `frontend/js/moments.js` | 287 | shareable cards + badge awarding |
> | `frontend/js/leagues.js` | 264 | list, setup, standings, fixtures |
> | `frontend/js/session-recap.js` | 183 | the end-of-night digest |
>
> **The last two extractions confirmed that a section banner is the wrong boundary,
> for the third time.** The "DAILY CHALLENGE" banner's region also contained
> `X01_CATEGORIES` (read by the New Game flavor select, tournament setup and
> `leagues.js`) and the `sessionBadgesShown` / `earnedBadgeCache` badge state — none of
> it challenge code. A banner marks where a topic *starts*, not where it ends. Both
> files were therefore cut **per declaration**, with the boundaries asserted in the
> extraction script rather than eyeballed, and the two intruders left where they were.
>
> Daily Challenge also had eight functions scattered across other screens' sections
> (Settings' reset control, both New Game setup steps, the profile history panel, the
> results panel). Those moved too. Splitting by screen would have left the feature with
> two homes and a newcomer asking "where does the Daily Challenge live?" needing both
> answers; the file is the answer instead.
>
> **What went wrong, and what it cost.** One line — `const LEAGUE_X01_CATEGORIES =
> X01_CATEGORIES;` in the extracted league code — is a *top-level initialiser*, so it
> runs the moment its file loads. Split files load before the main script that declares
> `X01_CATEGORIES`, so it threw `ReferenceError` and **aborted the entire file, taking
> all 15 league functions with it.** The suite went from 457/457 to failures in all 18
> checks, every message reading `X01_CATEGORIES is not defined`.
>
> Two things worth keeping from that. First, it was caught in seconds and diagnosed
> from a single distinct error string — the "verify after every step" rule did exactly
> its job, and this is why steps stay small. Second, the class of bug is now a
> **checker rule** (`load-order` in `backend/check.js`), so the next extraction cannot
> repeat it: it flags any top-level initialiser in a split file that reads a name the
> main script declares. Reading the same name from *inside a function* is fine — by
> then everything has loaded — and the check only looks at top-level initialisers for
> that reason.
>
> A second, quieter problem the same step caused: `check.js` scanned only `.html` for
> inline handlers and `getElementById` ids, so moving markup-emitting template literals
> into `.js` files silently dropped **58 handlers and 23 id lookups** from those checks.
> Coverage lost with nothing failing to announce it. Both checks now run over the page's
> whole scope — markup plus every classic script it loads — rather than over one file
> extension.

## Why the file is worth splitting

`frontend/index.html` is 21,172 lines, of which **18,623 (87%) are JavaScript in a
single `<script>` block**. Everything below is measured, not estimated:

| | |
|---|---|
| top-level declarations | **909** — 678 functions, 231 bindings |
| internal references between them | **3,902** (mean 4.3 per declaration) |
| mutable top-level bindings | **87** |
| inline `on*=` handler attributes | **335**, calling **180** distinct top-level names |

One scope holds all 909 names. There is no encapsulation anywhere: any function can
reach any other function and assign any of the 87 mutable bindings. The practical costs
are navigability (finding the code that owns a behaviour), reviewability (a diff gives
no signal about blast radius), and the standing risk that two names collide — which is
legal JavaScript and silently keeps the later one, the reason `backend/check.js`'s
`duplicate-function` check exists.

## Why ES modules are the wrong target

Two blockers, both measured empirically in a browser rather than reasoned about.

### 1. All 335 inline handlers break — silently

An `on*=` attribute resolves its names against the **global object**, at click time.
Module scope is not global scope. A minimal reproduction (two modules, one inline
handler calling an exported function):

```
{"inlineHandler":"HANDLER BROKEN: fromA undefined","pageErrors":[]}
```

Note `pageErrors: []`. **Nothing throws.** The handler evaluates, finds `undefined`, and
produces a wrong result. `node --check` cannot see it, the backend suite cannot see it,
and any check that doesn't click that exact control cannot see it. 335 attributes across
180 distinct names would all fail at once, and the app would look like it had simply
stopped responding to taps.

Fixing this means either explicitly re-exporting all 180 names onto `window` (which
gives up the encapsulation the split was for), or converting all 335 attributes to
`addEventListener` wiring (a large, separate, individually-verifiable job).

### 2. 87 mutable bindings, and the biggest is assigned from everywhere

An exported `let` is a **live binding**: importers may read it, and may not assign it.
That is a hard language rule, not a style preference. The fan-in on the mutable state:

| binding | referenced by |
|---|---|
| `game` | **356** declarations |
| `setup` | 114 |
| `stats` | 94 |
| `mult` | 34 |
| `roster` | 33 |
| `currentPlayer` | 30 |

`game` alone is touched by 356 of 909 declarations, and is assigned (`game = null`,
`game = {...}`) from many of them. Under ES modules every one of those assignments from
another module is an error. Making it legal means moving all 87 bindings behind a state
object or setter functions — a mechanical rewrite of thousands of sites, done *before*
any file is actually split, with no intermediate state that is testable.

## What to do instead: multiple classic `<script src>` files

Classic scripts **share one global scope**, including top-level `let`/`const`. Verified
in a browser, with an inline handler and a cross-file assignment:

```
{"title":"B sees set-by-b / const-a / A:set-by-b","errors":[]}
```

`b.js` assigned a `let` declared in `a.js`, `a.js` observed the new value, and an inline
`onclick` called a function from a third file. This is the same semantics the file has
today, just spread across files.

**What this buys:** navigability (a named file per area), reviewable diffs, per-file
`node --check`, git history per area, and a real place for a new feature to live. All of
it with **no build step, no bundler, no dependency** — the same promise `scoring.js`
already keeps.

**What it does not buy, stated plainly:** encapsulation. It is still one namespace, just
in more files. Nothing stops file 7 reaching into file 2. That is a real limitation and
the honest reason to call this a *split*, not a *modularisation*.

**Why it is still worth doing:** the encapsulation ES modules would give is worth less
here than it looks, because the 87 shared mutable bindings are the actual coupling — and
they would survive any module boundary as a shared state object anyway. The split gets
the navigability now; the encapsulation stays available later, incrementally, per area,
once the handler and state work is done on its own terms.

## Suggested order

Each step is independently shippable and independently verifiable. Nothing here needs
the next step to be worth doing.

1. **Load-order safety net first.** `backend/check.js` already reports every inline
   handler naming a function that does not exist (`missing-handler`). Extend it to also
   assert that every one of the 180 handler-called names is declared in *some* loaded
   file, and that the `<script src>` list in `index.html` matches the files on disk. This
   is what makes the rest safe to do at all.
2. ✅ **Done.** **Extract the leaf areas** — the ones with the lowest fan-in to the
   rest: Dart Builder / Loadouts, Shareable Moments, Tournament Mode, Leagues, Session
   Recap, Daily Challenge. ~~Each already has its own section banner in the file.~~
   **That last sentence was wrong, and it is the one thing to carry into step 3**: a
   banner marks where a topic starts, not where it ends. Three of the six extractions
   found unrelated declarations inside the banner's region. Cut per declaration, and
   assert the boundaries in the script that does the cutting.
3. ✅ **Done.** **Extract the per-mode game logic**, one file per game type, driven by
   the `GAME_TYPES` registry that already isolates them behind a common interface.
   The per-declaration discipline from step 2 held: classification came from the
   registry's own keys, and the extractor asserted that every requested name resolved
   to exactly one top-level declaration and that no two spans overlapped, so a shared
   comment block could not be claimed twice.
4. **What is left is the core**: `game`/`setup`/`stats` and the turn loop. Leave it as
   one file. It is the part with genuine 356-way coupling, and splitting it is where the
   risk lives with the least to gain.

## Reassessment after the db.js split (2026-07)

`backend/db.js` was split the same month, four leaf modules out of 10,100 lines
(`tournaments.js`, `leagues.js`, `marathon.js`, `coaching.js`). That is the closest
comparable exercise this codebase has, and it sharpens the case here in both
directions. The conclusion is unchanged — **do step 3, do not do step 4** — but the
reasons are now better evidenced than when they were first written.

**What transfers: measure the boundary, never trust the banner.** The db.js split
picked its four sections by building a call graph in both directions *with comments
stripped*, and only cutting sections with zero inbound calls. The naive scan
disagreed badly — nearly every apparent inbound edge was a section's name appearing
in a comment. That is the same lesson step 2 here learned the hard way three times
("a banner marks where a topic starts, not where it ends"), arrived at independently.
Step 3 should do the same thing: measure each mode's inbound edges from the turn loop
before cutting, not read the banners.

**What does NOT transfer, and it is the important half.** The db.js modules are real
Node modules, so the split produced something a file split here structurally cannot:
an **enforceable dependency contract**. Each leaf is a factory taking exactly what it
needs, and `check.js`'s new `leaf-missing-dep` rule fails the build when a leaf names
something it was never given. The equivalent rule cannot be written for
`frontend/js/` — those are classic scripts sharing one global scope, so there is no
"missing dependency" to detect. Every name is still in scope for every file, forever.

So the honest framing for step 3 is narrower than it was for db.js: it buys
navigability ("where does Cricket's scoring live?" gets one answer), reviewable
diffs, and per-file `node --check`. It buys **no** encapsulation and no enforced
contract. That was already stated above; the db.js comparison is what makes the size
of the difference concrete, and it is worth knowing before anyone starts, so the
result is not mistaken for architecture it does not have.

**Current sizes** (after the CSS moved to `frontend/app.css`): `index.html` is 17,697
lines, of which ~16,578 are JavaScript — 576 top-level functions, 69 mutable
top-level `let`s, 284 inline handler attributes. The per-mode turn-commit and
leg/set-progression blocks step 3 targets are roughly 900-1,400 of those lines. Even
done perfectly, the core stays around 15,000 lines, which is the point of step 4:
that part is not a filing problem, and moving it would trade a real risk for a small
gain.

## Verification

The suites already in place are what make this safe, and they are the reason to do it
now rather than earlier:

- **442 verify-ui assertions** driving the real app in a real browser — the only thing
  that can catch a handler that silently stopped resolving.
- **1,672 backend tests** (unaffected by frontend file layout, but they pin the API the
  frontend talks to).
- **`backend/check.js`** — `missing-handler` is precisely the check this work needs, and
  it was built during the same maintenance pass for exactly this reason.

A split step that leaves all three green has not changed behaviour. A split step that
cannot be made green should be reverted rather than debugged forward — the file layout
is not worth a behaviour change.
