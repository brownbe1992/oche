# Voice Announcements — Full i18n / Multi-Language Roadmap

> Status: **not started**. Voice announcements themselves shipped with multi-language
> support deliberately left to the browser (see `docs/voice-announcements-roadmap.md`)
> — whatever `speechSynthesis` voice/locale the device already has installed is what
> speaks, and all phrase text is hardcoded English. This doc designs what a *real*
> i18n implementation would need on top of that, for whoever picks it up later.
>
> **Size: Medium-High.** The code changes are moderate (a resource-bundle loader,
> locale-aware ordinal/number formatting, voice-selection logic); the real bottleneck
> is translation content — idiomatic darts-caller phrasing per language, not a
> mechanical string translation.

## Why "leave it to the browser" isn't the same as i18n

The shipped version works today because `SpeechSynthesisUtterance` just reads
whatever text string it's given using the OS/browser's already-configured default
voice — if that voice is, say, German, it'll pronounce the (still-English) text with
German phonetics, which sounds wrong rather than actually speaking German. Real
multi-language support means the *phrase content itself* changes per language, and the
voice used to speak it is chosen to match — two different problems, both unsolved by
"let the browser handle it."

## What's hardcoded today that would need to change

All of this lives in `frontend/display.html`'s voice-announcement engine
(`handleVoiceEvents`, `announce180`, `ordinal`):

- **Phrase templates**: `"No Score"`, `"${player}, you require ${score}"`,
  `"Game shot! And the ${ordinal} leg/set, ${winner}!"`, `"Game shot! And the match,
  ${winner}!"`, `"${starter} to throw first, Game On!"` — all hardcoded English
  strings with inline interpolation.
- **The 180 escalation**: hardcoded as the 4 English words "One" / "Hundred" / "and" /
  "Eighty!", each with its own pitch/rate. A different language's equivalent
  announcer phrase won't necessarily have 4 natural word-chunks, or even exist as a
  established caller tradition at all.
- **`ordinal(n)`**: English-only suffix logic (1st/2nd/3rd/4th). Other languages
  don't just swap a suffix — German, Spanish, French, etc. all have entirely
  different ordinal-formation rules (some don't concatenate a suffix onto the digits
  at all).
- **Number pronunciation**: turn scores and checkout numbers are passed as raw
  digits and left to the TTS engine to pronounce — this mostly works, but isn't
  guaranteed to produce the *phrase structure* a native speaker would actually use
  (e.g. "one hundred and eighty" is an English-specific construction, not a literal
  pattern that holds in other languages).

## Design

- **A `voice_language` setting** (Settings → Voice Announcements), independent of the
  browser/OS locale — an admin picks which language the announcements are phrased in,
  defaulting to English (the only language with content initially).
- **A JSON resource-bundle per supported language** (e.g.
  `frontend/locales/voice-en.json`, `frontend/locales/voice-de.json`), loaded
  client-side based on `voice_language` — keeping the zero-new-dependency,
  zero-backend-involvement identity intact (a plain fetched JSON file, not an i18n
  framework like i18next). Each bundle defines the phrase templates above as
  parameterized strings (e.g. `"{winner} requires {score}"`), plus a `oneEightyChunks`
  array of `{text, pitch, rate}` objects so the escalation effect is itself authored
  per-language rather than assumed to always be 4 English words.
- **Locale-aware ordinals**: use `Intl.PluralRules(locale, {type:'ordinal'})` (a
  standard, already-available browser API — no new dependency) to get the correct
  ordinal *category* for a number in the target locale, combined with a small
  per-locale suffix/word map in each resource bundle. Not a generic library problem —
  just needs real per-language data, which is exactly the translation-content
  bottleneck called out above.
- **Voice selection matching the phrase language**: set `SpeechSynthesisUtterance.lang`
  to the selected language's BCP-47 code, and prefer a `speechSynthesis.getVoices()`
  entry matching that `lang` if one exists on the device — falling back to the
  system default (with a Settings-visible warning) if the OS has no voice installed
  for the chosen language, rather than silently mispronouncing it.
- **Number-to-words stays a browser responsibility, scoped per-language**: still
  don't hand-roll number-to-words conversion — `SpeechSynthesisUtterance` with the
  correct `lang` set will pronounce digits reasonably in that language's convention.
  The resource bundle's job is just getting the surrounding sentence structure right,
  not replacing the engine's own number pronunciation.

## Suggested build order

1. Extract today's English phrases into a `voice-en.json` resource bundle — no
   behavior change, pure refactor, proves the parameterization is sufficient before
   any other language exists.
2. `voice_language` setting + resource-bundle loader + `lang`/voice-matching logic.
3. `Intl.PluralRules`-based ordinal formatting, still English-only content, to prove
   the mechanism before real translation work starts.
4. Recruit real translation review (not machine translation) for a second language —
   idiomatic darts-caller phrasing, not literal string translation, matters here.
5. Repeat per additional language, as demand and translation help materializes.

## Open questions for whoever picks this up

- Which second language to prioritize — likely whichever the project's actual
  non-English user base first asks for, rather than guessing in advance.
- Whether the 180 escalation effect's *shape* (word-by-word pitch ramp) even
  translates well to every language's phrase, or whether some languages need a
  fundamentally different escalation pattern (e.g. syllable-based rather than
  word-based) — needs real native-speaker input, not just a translated string.
- Whether `voice_language` should default to matching the browser's own `navigator.language`
  when a bundle for it exists, rather than always defaulting to English.
