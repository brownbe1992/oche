# Coaching Insights — Design Roadmap

> **Archived** — fully shipped, kept here for design-rationale history. See
> `docs/open-roadmap-items.md` for the live completion tracker across all roadmaps.

> Status: **✅ Done**. All four candidate insights below are built:
> `getCoachingInsights(name, mode)` in `backend/db.js`, `GET
> /api/players/coaching-insights`, and a "Coaching Insights" section on the Player
> Profile (X01 tab only) right after Personal Bests. Committed test coverage in
> `backend/test/coaching-insights.test.js` (positive + below-threshold-negative case
> per insight). Exact formulas/thresholds documented in `REFERENCE.md`'s "Coaching
> Insights" subsection (§3). Both open questions below are resolved: **Strict**
> sample thresholds (chosen over Moderate/Lenient), and the "Practice this" button
> **deferred** — insights ship as plain descriptive text only in this pass.

## Goal

Turn the data already being collected into actionable practice guidance, instead of
just descriptive stats. The Player Profile's Dart Analytics section already computes
most-hit sectors, treble hit rate per number, and the most-used checkout routes for
each finish — nobody currently translates that into "here's what to actually
practice." This needs **no new data collection at all**, only new analysis and
presentation of tables that already exist (`getDartAnalytics`, `getCheckoutRoutes` in
`backend/db.js`).

## Why this is a real differentiator

Most casual dart-tracking tools (including the dartslytics.com-style sites referenced
in the project's own wishlist) show you numbers. Very few tell you what to do about
them. This is achievable with the data already on hand and doesn't require the
scale/infrastructure of any of the other roadmap items.

## Candidate insights (derivable from existing tables)

- **Weak number identification** — compare treble hit-rate across all 20 numbers
  (already computed per-number in Dart Analytics); surface the worst 2-3 explicitly:
  "Your treble-20 accuracy (41%) is well below your average (58%) — this is worth
  focused practice."
- **Checkout route inefficiency** — compare a player's most-used route for a given
  finish against a more efficient standard route (e.g. always going for `20-20-20`
  when `T20-T20-D20` finishes faster) and suggest the better path, using the existing
  checkout-hint math (`checkoutHint()` in `frontend/index.html`) as the source of
  truth for what the "optimal" route actually is.
- **Bust pattern analysis** — if a player busts disproportionately on odd-number
  finishes (a well-known dart-strategy issue — doubling out is naturally biased toward
  even numbers), flag it specifically, since this is a common, well-understood, fixable
  habit.
- **Form trend callouts** — the existing "Recent Form" delta (last 10 legs vs.
  lifetime average, already shown in Personal Bests) could be extended into a plain-
  language note: "Your average has dropped 4.2 over your last 10 legs — a sign of
  fatigue, or just a rough patch?"

## Where this lives

A new "Coaching" section on the Player Profile page, alongside Personal Bests and
Dart Analytics — reads naturally as "here's what your numbers mean," positioned right
next to "here are your numbers." Could also surface a single top insight as a
homepage callout for the currently-viewed player, but the profile page is the more
natural home given it's where the underlying analytics already live.

## Accessibility, security, and testing considerations

Not yet addressed anywhere in this doc, per `CLAUDE.md`'s standing conventions:

- **Testing**: insight computation (weak-number detection, bust-pattern analysis,
  whatever the final candidate list settles on) is pure, deterministic logic over
  existing tables — a natural fit for real test coverage per
  `docs/testing-and-observability-roadmap.md`, and arguably more important here than
  most features, since a wrong "coaching" insight actively misleads a player about
  their own game rather than just displaying a wrong number.
- **Accessibility**: the new Coaching section needs the same review as any other
  profile-page addition — don't rely on color alone to distinguish a "strength" vs.
  "weakness" callout, per `docs/accessibility-roadmap.md`'s standing checklist.
- **Security**: no new credential/token surface — reads existing turn/dart data
  already scoped to the profile the viewer is already allowed to see.

## Open questions — resolved

- **Sample-size threshold**: **Strict** was chosen over Moderate/Lenient — every
  insight requires roughly double the initially-proposed "moderate" sample (40 darts
  per number, 10 uses of a checkout score, 20 attempts per bust-parity side, 20
  lifetime legs for form trend) before it's shown at all. See `REFERENCE.md` for the
  exact numbers.
- **"Practice this" button**: **deferred**, not built in this pass. Insights ship as
  plain descriptive text only. A follow-up item could add a practice-session deep
  link once the insight logic itself has been in real use for a while.
