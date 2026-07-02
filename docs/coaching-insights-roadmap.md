# Coaching Insights — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

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

## Open questions for whoever picks this up

- How many turns/legs of data should be required before an insight is considered
  statistically meaningful enough to show (avoiding a false "weakness" flagged from a
  tiny sample)?
- Should insights be purely descriptive text, or paired with a "Practice this" button
  that pre-configures a Practice-mode session targeting the specific weakness (e.g.
  starting score chosen to require the checkout route being practiced)?
