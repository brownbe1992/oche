# Voice Announcements — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

## Goal

Spoken call-outs on the live scoreboard — "One-eighty!", "Game shot!", a player's
running score after each turn — the way a real tournament caller or an electronic
dartboard would announce a throw. High delight, essentially zero infrastructure: the
browser's built-in Speech Synthesis API (`window.speechSynthesis`) handles this
entirely client-side, no backend, no external service, no new dependency.

## Why this fits `display.html` specifically

The live scoreboard already has a real "celebration culture" — full-screen achievement
overlays with confetti for nine-darters, flash banners for leg/set/game results. Voice
is a natural extension of that same instinct, and it's the cheapest of all the ideas
in this batch of roadmap docs to actually build.

## Design

- **What gets announced**: turn score (e.g. "one-forty"), busts, checkouts/"Game
  shot," 180s, Big Fish, and leg/set/game-won announcements. Reuses data already
  flowing through the existing live snapshot (`liveSnapshot()` in
  `frontend/index.html`) — no new data collection needed.
- **Where it runs**: `display.html`, since that's the "TV in the room" experience
  voice output is for — not the controller/scoring screen, which is usually held by
  whoever's about to throw and doesn't need score numbers read back at them
  mid-visit.
- **Toggle**: a Settings option (new "Voice Announcements" section, same pattern as
  Live Scoreboard/Scoring/Data Collection), off by default. Consider a volume/voice
  selection using whatever voices `speechSynthesis.getVoices()` exposes on the
  device — this varies a lot by OS/browser, so the UI should gracefully handle "no
  voices available" rather than assuming a specific one exists.
- **Timing/interruption handling**: needs a small announcement queue so overlapping
  events (a 180 that's also a leg-winning checkout) don't talk over each other —
  queue and speak sequentially rather than firing multiple `speak()` calls at once.
- **Layout independence**: this should work regardless of which scoreboard layout
  preset (Full/Compact/Minimal) is active, since it's audio, not a visual density
  concern — the two systems are orthogonal.

## Open questions for whoever picks this up

- Should turn-by-turn score be announced every visit, or only for noteworthy ones
  (180s, checkouts, busts) with plain scores left silent to avoid being annoying
  during a long, slow match?
- Multi-language support depends entirely on what voices the device/browser already
  provides — is that good enough, or does this eventually need real i18n for
  wording/phrasing (not just voice selection)?
