# Home Assistant "Recipe Book" — Documentation Roadmap

> Status: **not started**. Unlike the other roadmap docs, this isn't a code project —
> it's a documentation gap. Flagging it here so it doesn't get lost, and because it
> came up directly while reviewing what would make the app feel special with close to
> zero engineering effort.

## Goal

The Home Assistant webhook integration already lets Oche fire a webhook on a bust, a
180, a checkout, a leg/set/game start or end (see the README's Home Assistant
Integration section and `backend/db.js`'s `fireHaWebhook`). Most users probably don't
realize that means things like "flash the room lights red on a bust" or "play a sound
on a checkout" are **already fully possible today**, with zero new Oche code — they
just need example Home Assistant automations to copy.

## Why this belongs in the roadmap

This is the cheapest possible way to make the app feel more special: no new feature,
just better documentation of power that already shipped. It's also a good candidate
for a quick win to knock out independent of anything else in this batch, since it
requires no implementation planning at all — just writing the guide.

## What the guide should cover

A new README section or standalone doc with copy-pasteable Home Assistant automation
examples, such as:

- Flash smart lights a specific color on a bust (red), a 180 (gold), or a game win
  (a celebratory color loop).
- Play a sound/announcement via a smart speaker on a checkout or leg win (HA's
  `tts.speak` or media-player service, triggered from the webhook automation).
- Send a notification (phone push via the HA app, or a Discord/Slack webhook chained
  from HA) when a nine-darter happens, for players who aren't in the room to see it
  live.
- A "game night" scene — dim/warm the lights automatically when a `game_start` webhook
  fires, restore normal lighting on `game_end`.

## Suggested approach

Since this needs no design decisions, the most direct path is simply to write and
test a handful of real HA automations against a running Oche instance, then document
the exact YAML/automation-editor steps — this is a "just go build it" item whenever
someone has a Home Assistant instance handy to verify the examples actually work,
rather than something requiring further design work first.
