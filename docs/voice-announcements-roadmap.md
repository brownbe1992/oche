# Voice Announcements — Design Roadmap

> Status: **✅ Done**. Shipped on the live scoreboard (`frontend/display.html`) with
> the master + 6 individually-toggleable call-out types described below (Turn score,
> No Score, Checkout requirement, 180s, Big Fish sound, Leg/Set/Game results), a
> sequential announcement queue mixing speech and a synthesized sound effect, and
> escalating-pitch word chunks for the 180 call-out. Verified end-to-end with a real
> running server and browser automation covering every call-out and toggle
> combination. Multi-language support was deliberately left to whatever voice/locale
> the browser already provides — see `docs/voice-announcements-i18n-roadmap.md` for
> what a real i18n implementation would need beyond that.

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

## What shipped

Six independently-toggleable call-out types (Settings → Voice Announcements, off by
default via a master switch, each sub-toggle on by default once the master is
enabled):

- **Turn score** — after any non-bust, non-winning turn, speaks just the score with
  no player name (e.g. "sixty").
- **"No Score"** — a bust *or* three misses (any turn that scored zero without
  winning) speaks "No Score" at a deliberately low pitch (0.65) and slowed rate
  (0.85) for a genuinely deflated tone — the closest a pitch/rate-only API (no real
  "emotion" parameter exists in the standard Web Speech API) can get to
  disappointment.
- **Checkout requirement** — each time it becomes a player's turn while they're
  sitting on a valid finish, announces "{name}, you require {score}" — repeating
  every eligible turn, the way a real caller reminds the room, not just the first
  time.
- **180s** — "One! Hundred! and! Eighty!!" queued as four separate utterances with
  escalating pitch (0.95 → 1.5) and slowing rate (0.85 → 0.65), simulating the
  drawn-out hype-announcer effect the standard API can't do within a single
  utterance (no mid-utterance pitch bending, no reliable vowel elongation).
- **Big Fish sound** — not speech at all: a short splash/flop effect synthesized
  procedurally with the Web Audio API (filtered decaying noise bursts) rather than a
  licensed recorded sound file, keeping the feature dependency-free. Plays after the
  win announcement when the winning checkout was specifically 170.
- **Leg/Set/Game results** — follows PDC referee phrasing: "Game shot! And the
  {ordinal} leg, {winner}!" (leg win), "...and the {ordinal} set, {winner}!" (set
  win, ordinal per-set not match-wide), or "...and the match, {winner}!" (game win).
  Also covers the next leg's opening call, "{starter} to throw first, Game On!",
  since both are part of the same match-progression narration.

## Architecture

- **New live-snapshot fields** (`frontend/index.html`'s `liveSnapshot()`): one-shot
  `lastTurnEvent`, `matchResult`, and `legStart` objects (cleared immediately after
  being sent, same pattern as the existing `achievement` field), plus a persistent
  `checkoutTarget` + `turnSeq` pair so the scoreboard can tell "still the same pending
  turn" apart from "a fresh turn just began" without re-announcing. A winning turn's
  `lastTurnEvent.win` suppresses the plain Turn score/No Score/180 call-outs for that
  turn, since `matchResult` narrates it instead — real callers say "Game shot!", not
  "you scored 40, game shot!".
- **A sequential announcement queue** (`display.html`) mixing speech utterances and
  the synthesized sound effect, processing one at a time via each utterance's `onend`
  (or the sound's fixed duration) so overlapping events — a Big Fish checkout that
  also wins the leg — don't talk over each other.
- **Toggle plumbing**: `voice_enabled` (master) + 6 sub-toggle settings, same
  public-read/admin-write pattern as `scoreboard_layout`/`colorblind_mode`, read once
  at `/display` boot.
- **Autoplay handling**: since `/display` is typically left open on a TV with nobody
  touching it, and most browsers block audio until a user gesture, a small one-tap
  "🔊 Tap to enable voice announcements" button appears (only when voice is enabled)
  to unlock both `speechSynthesis` and the `AudioContext` up front.

## Open questions for whoever picks this up

- Whether a real recorded splash sound file should replace the synthesized Big Fish
  effect eventually — the code is structured so that's a small swap (replace
  `playBigFishSplash()`'s body), not a redesign.
- See `docs/voice-announcements-i18n-roadmap.md` for the full set of open questions
  around real multi-language support.
