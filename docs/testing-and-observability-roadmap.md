# Testing & Observability — Design Roadmap & Standing Checklist

> Status: **not started**. Like `docs/accessibility-roadmap.md`, this is partly a
> concrete near-term fix (server-side error logging) and partly a standing practice
> for every future feature (test coverage for core logic) — see `CLAUDE.md` for the
> binding cross-reference.
>
> **Size**: the observability fix is **trivial** (minutes, one line). Testing is
> **Medium** — the real cost is a small refactor-for-testability step, not the tests
> themselves; a useful initial slice is a session or two of work, full coverage is an
> ongoing practice rather than a single project. **Usefulness**: high for both —
> observability is a trivial fix for real value, and testing protects every future
> roadmap item, especially the higher-risk refactors already planned (item 10, the
> X01-to-plugin refactor).

## Goal

Give the project a regression safety net as more features land on top of it, and
give a self-hosting admin some visibility when something breaks — without
introducing new dependencies, matching the project's existing "dependency-free"
identity.

## The evidence (this session's audit)

- **Zero automated tests exist in the repo** — no test files, no test script in
  `backend/package.json`. Every verification this session (and prior sessions) has
  been manual: spinning up a real server on a scratch database and driving it with a
  headless browser.
- **Server errors are never logged server-side.** The top-level `catch` in
  `backend/server.js` sends the error to the client (`send(res, err.status || 500,
  { error: err.message })`) but never calls `console.error` or anything similar. If a
  request 500s, the only record of it is whatever the client happened to see — an
  admin running this at home has no way to know something broke unless a player
  reports it.

## A. Automated testing

- **Use Node's built-in `node:test` + `node:assert`** — no new dependency, already
  available given `engines: { node: ">=22.5.0" }`. Keeps the project's stated
  "dependency-free" identity intact rather than introducing Jest/Mocha/etc.
- **Highest-value, lowest-effort first target**: the pure scoring logic in
  `frontend/index.html` — `evaluateVisit()` (bust/checkout rules) and the checkout
  route calculator (`coFinish2`/`coFinish3`/`checkoutHint()`). Zero DOM dependency,
  and the highest-stakes code in the app for correctness. The real cost here isn't
  writing the tests — it's that these functions live inside one giant inline
  `<script>` today with nothing exported, so step one is making them reachable from a
  test file (e.g. a small extracted module the page also loads via `<script src>`).
  That's a refactor-for-testability step, not new behavior.
- **Second target**: `backend/db.js`'s query functions (`computeStats`, `getSummary`,
  etc.), using the same technique already used manually throughout this project's
  sessions — point `DARTS_DB` at a scratch file, seed known games/turns/darts, assert
  the computed stats match hand-calculated expected values.
- **Not aiming for exhaustive coverage in v1.** The goal is a safety net around the
  highest-risk shared logic (scoring rules, checkout math, core stat queries) — not
  100% coverage. `docs/existing-app-prep-roadmap.md` item 10 (the X01-to-plugin
  refactor) is the ideal moment to extend this further: that refactor needs to prove
  the new plugin abstraction behaves identically to today's inline X01 logic, and a
  test suite is exactly how you'd prove that rather than eyeballing it.

## B. Observability

- **Trivial, immediate fix**: add `console.error` (with a timestamp) to the top-level
  `catch` block in `server.js` so a self-hoster can see something in `docker logs`
  when a request fails — currently there's nothing to see at all.
- **Longer-term, not urgent**: a rotating log file or a "recent errors" view in
  Settings. Likely overkill for a personal/small-household deployment where `docker
  logs` is already sufficient once the fix above exists — kept as a "keep in mind"
  item rather than a committed build step.

## Suggested build order

1. **(Trivial)** Add server-side error logging to the top-level `catch` in
   `server.js` — a few minutes, no design needed.
2. Introduce `node:test` as the runner; extract `evaluateVisit()`/checkout math into
   a testable form and write the first suite against it.
3. Add a `db.js` integration-test suite using scratch databases.
4. Add `npm test` to `backend/package.json`, and revisit coverage each time a major
   roadmap item lands, starting with item 10 (the X01 plugin refactor).

## Standing practice going forward

New features should get test coverage for their core logic as they're built — not
retrofitted later, and not replaced by manual verification alone once a real test
runner exists. See `CLAUDE.md` for the binding version of this statement.

## Open questions for whoever picks this up

- Whether to extract the frontend's pure logic into real ES modules now (bigger,
  cleaner change) vs. a minimal shim just for testability (smaller, uglier) — the
  item 10 refactor is a natural moment to decide this properly rather than
  pre-empting it here.
- Whether CI (even something as simple as a GitHub Actions workflow running `npm
  test` on push) is worth adding once a real test suite exists — no code prerequisite,
  just needs a suite worth running first.
