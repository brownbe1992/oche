# Shareable Moments — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.

## Goal

Turn a big moment — a personal best, a 180, a nine-darter, a match win — into a
shareable image a player can screenshot or send to a group chat, without building any
social/online infrastructure. This is entirely client-side image generation (canvas or
SVG rendered to PNG), reusing the celebratory culture the app already has via its
achievement overlays.

## Why this matters

Organic sharing is one of the cheapest forms of "making the app feel special" —
someone posting a screenshot of a nine-darter card to a group chat does more for the
app's word-of-mouth than almost any in-app feature, and it costs nothing in
infrastructure since it never touches a server.

## Design

- **Trigger points**: personal bests (best leg average, fewest darts to finish —
  already computed via `getPersonalBests` in `backend/db.js`), any achievement
  overlay event (180, Big Fish, nine-darter), and match/game completion (win, final
  score, format).
- **Generation mechanism**: build the card as an off-screen canvas or SVG, styled to
  match the app's existing dark/gold visual identity (same palette already used
  throughout `frontend/index.html` and `display.html`), then export via
  `canvas.toBlob()`/`toDataURL()` — no server round-trip, no image-processing
  dependency.
- **Sharing mechanism**: use the Web Share API (`navigator.share()`) where available
  (mobile browsers, and this pairs naturally with the mobile-app roadmap's webview
  wrapper) falling back to a plain "save image" download link on desktop browsers
  that don't support it.
- **Match recap card**: a slightly larger version of the same mechanism — a
  post-game summary card (winner, score, top stat of the match) shown on the
  Game Over screen with a "Share" button, extending the stat panel already added
  there.
- **Player Profile "Moments" section**: a lightweight gallery of a player's own
  generated moments (or just the underlying events, regenerable on demand) — not a
  hard requirement for v1, but a natural place for these to live persistently rather
  than only appearing transiently on the achievement overlay.

## Open questions for whoever picks this up

- Should generated cards be cached/stored anywhere (e.g. as a blob in the database)
  or always regenerated on demand from existing stat data — storage adds complexity
  and disk usage for something that's cheap to recompute.
- Visual design of the card itself (what's the right amount of information vs. visual
  impact) probably needs a few real iterations against actual achievement data before
  it feels right — worth prototyping early rather than over-specifying in this doc.
