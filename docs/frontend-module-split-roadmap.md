# Frontend module split — feasibility, and the shape it should take

> **Status: prep done (2026-07), not started.** This document exists because the
> measurement changed the plan. The item was filed as "split `index.html`'s 18,623
> lines of JS into ES modules"; measuring the file says **ES modules are the wrong
> target**, and a different split gets most of the benefit at a fraction of the risk.
> Nothing has been moved yet.

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
2. **Extract the leaf areas** — the ones with the lowest fan-in to the rest: Dart
   Builder / Loadouts, Shareable Moments, Tournament Mode, Session Recap. Each already
   has its own section banner in the file.
3. **Extract the per-mode game logic**, one file per game type, driven by the
   `GAME_TYPES` registry that already isolates them behind a common interface.
4. **What is left is the core**: `game`/`setup`/`stats` and the turn loop. Leave it as
   one file. It is the part with genuine 356-way coupling, and splitting it is where the
   risk lives with the least to gain.

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
