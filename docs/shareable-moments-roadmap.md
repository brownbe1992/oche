# Shareable Moments — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.
>
> Includes a researched design for social media integration (Home Assistant webhook
> + direct-to-platform sharing for X/Twitter, Instagram, and Facebook) — see
> "Social media integration" below. The platform-specific constraints there are real,
> current API policy, not engineering guesses (Instagram and Facebook in particular
> have hard platform restrictions, not just friction).

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

## Social media integration

Two separate mechanisms, not one — they solve different problems and have very
different constraints:

### 1. Home Assistant webhook (recommended default for anyone who already has HA)

The card is generated client-side exactly as designed above, then base64-encoded and
POSTed straight to the admin's own Home Assistant instance — the same
browser-to-HA webhook mechanism already used for every other event (`oneeighty`,
`bigfish`, etc. — see `backend/db.js`'s `fireHaWebhook()` and the README's Home
Assistant Integration section), just with a new configurable webhook ID
(`ha_webhook_moment_card`, same Settings pattern as the existing HA event toggles)
and a payload that carries the actual image data:

```json
{ "event": "moment_card", "player": "Alice", "momentType": "nine_darter",
  "image": "data:image/png;base64,iVBORw0KG...", "timestamp": 1234567890 }
```

- **Zero new infrastructure on Oche's side** — no server round-trip, no image
  hosting, no new credential to protect. The browser already talks directly to the
  user's own HA instance for every other webhook; this is the same trust boundary,
  just a bigger payload.
- **Fires automatically**, same as the existing HA event webhooks — the admin's own
  HA automation on the receiving end decides what to do with the image (post it to a
  Discord/Telegram channel via HA's own integrations, save it to a NAS, trigger a
  notification, whatever). Oche doesn't need to know or care what happens downstream
  — that's exactly the point of routing through HA rather than building bespoke
  platform integrations.
- **Payload size**: a PNG sized for social sharing (roughly 1080×1080 or 1200×630)
  typically base64-encodes to somewhere in the tens-to-low-hundreds of KB — trivial
  for a local-network POST, no chunking or special handling needed.

### 2. Direct-to-platform sharing (for people without Home Assistant)

This is where the platforms' own policies matter a lot, and they're **not** equally
accommodating. Researched current state (all three confirmed via each platform's own
current developer documentation, not assumed):

| Platform | Automated posting via public API? | Why / what's actually possible |
|---|---|---|
| **X (Twitter)** | Technically yes, but **real ongoing cost** | As of a February 2026 pricing change, X's API has **no free tier for new developer apps** — posting is pay-per-use (~$0.015/post, ~$0.20/post if it contains a link), with the old free/Basic tiers only available to pre-existing subscribers. Any auto-post feature means the *admin* registers their own X developer app, completes OAuth once, and accepts that X bills *them* per post — this can never be something Oche offers "for free" the way the HA webhook can. |
| **Instagram** | **No**, not for a personal account | Personal Instagram accounts are excluded from the Graph API entirely — only Business/Creator accounts (linked to a Facebook Page) can publish via API, and even then Meta requires app review (their own documented timeline: 2–4 weeks per permission) before an app can publish on behalf of any account beyond the developer's own test account. There is no legitimate path to "auto-post to your personal Instagram" today. |
| **Facebook** | **No**, not to a personal profile | Posting to personal profile timelines was removed from the Graph API back in v3.0 (2018, post–Cambridge Analytica) and has never returned — the Graph API only publishes to Pages now, never personal timelines. |

Given that, the realistic, honest design is:

- **The Web Share API mechanism already designed above (`navigator.share()` with
  files) is the correct primary path for all three platforms**, not a fallback. It
  opens the device's native share sheet, which already includes X, Instagram, and
  Facebook as targets on any phone with those apps installed — zero API keys, zero
  cost, zero App Review, and it's the *only* realistic way onto Instagram or Facebook
  from a personal account at all. It's user-confirmed by nature (the OS share sheet
  requires a tap), which is the right default for anything posting on a player's
  behalf to a public platform anyway.
- **Instagram Stories specifically** has a documented app-to-app share intent
  (a URL scheme a native app can invoke to open "share to your Story" pre-filled with
  an image) that's a nicer one-tap experience than the generic share sheet — but it
  only works from an actual installed native app, not a website. Worth revisiting
  once `docs/mobile-app-roadmap.md`'s native wrapper exists; not achievable from
  `frontend/index.html` as a plain web page.
- **An optional, clearly opt-in "auto-post to X" tier** for admins who want it badly
  enough to accept the cost: bring-your-own X developer app + OAuth credentials
  (stored write-only, same standing convention as every other credential in
  `docs/security-hardening-roadmap.md`), a Settings toggle per moment type (mirroring
  the granular per-event-type toggle pattern already established for voice
  announcements), and — deliberately — **prompt-before-posting as the default
  behavior**, not silent auto-post. Firing an HA webhook to the admin's own private
  automation is one thing; silently posting to a public platform on someone's behalf,
  at a real per-post cost, is a different risk profile and should default to a
  confirmation step even when the feature is enabled.
- **Instagram and Facebook get no bespoke API integration** — not because it's not
  worth building, but because there's no legitimate API to build it against for a
  personal account. Revisit only if Meta's policy changes, or if there's ever a
  real case for a Page-based "Darts Night" Facebook Page rather than personal
  profiles (a different, narrower use case than what's being asked for here).

## Open questions for whoever picks this up

- Should generated cards be cached/stored anywhere (e.g. as a blob in the database)
  or always regenerated on demand from existing stat data — storage adds complexity
  and disk usage for something that's cheap to recompute.
- Visual design of the card itself (what's the right amount of information vs. visual
  impact) probably needs a few real iterations against actual achievement data before
  it feels right — worth prototyping early rather than over-specifying in this doc.
- Which moment types should trigger the HA webhook by default once built — likely
  all of them with per-type toggles (personal bests, achievements, match completion),
  matching the granularity already established for voice announcements, but worth
  confirming against real usage rather than assuming.
- Whether X's pay-per-use pricing ever becomes cheap enough, or a free tier
  reappears, to reconsider making that integration more prominent — pricing policy is
  entirely outside this project's control and worth rechecking before committing
  real engineering time to it.
