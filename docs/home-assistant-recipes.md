# Home Assistant Automation Recipes

Oche already fires outbound webhooks to Home Assistant on every key game event (see
the README's [Home Assistant Integration](../README.md#home-assistant-integration)
section for how to configure the URL and per-event webhook IDs in **Settings**).
Nothing below requires any change to Oche itself — these are ready-to-paste HA
automations that react to webhooks Oche is already sending. Every YAML block here has
been written and shaped after real, working automations, so they should paste
straight into HA's automation editor (**Settings → Automations & Scenes → Create
Automation → Edit in YAML**) with just the `entity_id`/`webhook_id` values swapped
for your own.

## Prerequisites

1. In Oche's **Settings → Home Assistant**, set the **Home Assistant URL** and pick a
   webhook ID for each event you want to react to (e.g. `oche_bust`, `oche_leg_start`
   — any string works, it just has to match the automation's `webhook_id` below).
2. In HA, create one automation per event with a **Webhook** trigger using that same
   ID. `local_only: true` is recommended (and used throughout this doc) since Oche
   only ever calls HA from your own LAN.
3. Every payload includes `event` and `timestamp`, plus event-specific fields
   available in templates as `{{ trigger.json.<field> }}`:

| Event | Webhook ID setting | Extra fields available |
|---|---|---|
| **180** | `ha_webhook_oneeighty` | `player`, `category` |
| **Big Fish** (170 checkout) | `ha_webhook_bigfish` | `player`, `category` |
| **Ton+ Finish** (100+ checkout) | `ha_webhook_tonplus` | `player`, `category`, `score` |
| **Bust** | `ha_webhook_bust` | `player`, `category` |
| **Nine-Darter** | `ha_webhook_ninedarter` | `player`, `category` |
| **Moment Card** | `ha_webhook_momentcard` | `player`, `category`, `momentType`, `headline`, `statLine`, `image` (base64 PNG data URL) |
| **Leg Start** | `ha_webhook_legstart` | `category`, `setNo`, `legNo` |
| **Leg End** | `ha_webhook_legend` | `player` (winner), `category`, `setNo`, `legNo` |
| **Set Start** | `ha_webhook_setstart` | `category`, `setNo` |
| **Set End** | `ha_webhook_setend` | `player` (winner), `category`, `setNo` |
| **Game Start** | `ha_webhook_gamestart` | `category`, `players` (array of names) |
| **Game End** | `ha_webhook_gameend` | `player` (winner), `category` |

Replace `light.dartboard` throughout with whatever light/light group sits over your
board. All of these assume a color-capable smart bulb; if yours is on/off only, drop
the `rgb_color`/`color_temp_kelvin` keys and use plain `light.turn_on`/`light.turn_off`.

---

## 1. Bust — flash red

```yaml
alias: Oche - Bust
description: ""
triggers:
  - trigger: webhook
    webhook_id: oche_bust
    allowed_methods:
      - POST
    local_only: true
actions:
  - repeat:
      count: 5
      sequence:
        - target:
            entity_id: light.dartboard
          data:
            rgb_color: [255, 0, 0]
            brightness_pct: 100
            transition: 0
          action: light.turn_on
        - delay: "00:00:00.25"
        - target:
            entity_id: light.dartboard
          data:
            transition: 0
          action: light.turn_off
        - delay: "00:00:00.25"
  - target:
      entity_id: light.dartboard
    data:
      color_temp_kelvin: 5000
      brightness_pct: 100
      transition: 0
    action: light.turn_on
```

## 2. Leg Start — amber countdown, then green "go"

```yaml
alias: Oche - Leg start
description: ""
triggers:
  - trigger: webhook
    webhook_id: oche_leg_start
    allowed_methods:
      - POST
    local_only: true
actions:
  - repeat:
      count: 3
      sequence:
        - target:
            entity_id: light.dartboard
          data:
            rgb_color: [255, 200, 0]
            brightness_pct: 100
            transition: 0
          action: light.turn_on
        - delay: "00:00:00.5"
        - target:
            entity_id: light.dartboard
          data:
            transition: 0
          action: light.turn_off
        - delay: "00:00:00.5"
  - target:
      entity_id: light.dartboard
    data:
      rgb_color: [0, 255, 0]
      brightness_pct: 100
      transition: 0
    action: light.turn_on
  - delay: "00:00:01"
  - target:
      entity_id: light.dartboard
    data:
      color_temp_kelvin: 5000
      brightness_pct: 100
      transition: 0
    action: light.turn_on
```

## 3. Leg End — green flash, purple afterglow

```yaml
alias: Oche - Leg end
description: ""
triggers:
  - trigger: webhook
    webhook_id: oche_leg_end
    allowed_methods:
      - POST
    local_only: true
actions:
  - repeat:
      count: 10
      sequence:
        - target:
            entity_id: light.dartboard
          data:
            rgb_color: [0, 255, 0]
            brightness_pct: 100
            transition: 0
          action: light.turn_on
        - delay: "00:00:00.25"
        - target:
            entity_id: light.dartboard
          data:
            transition: 0
          action: light.turn_off
        - delay: "00:00:00.25"
  - target:
      entity_id: light.dartboard
    data:
      rgb_color: [200, 130, 255]
      brightness_pct: 100
      transition: 0
    action: light.turn_on
```

## 4. 180 — gold strobe

```yaml
alias: Oche - 180
description: ""
triggers:
  - trigger: webhook
    webhook_id: oche_180
    allowed_methods:
      - POST
    local_only: true
actions:
  - repeat:
      count: 6
      sequence:
        - target:
            entity_id: light.dartboard
          data:
            rgb_color: [255, 170, 0]
            brightness_pct: 100
            transition: 0
          action: light.turn_on
        - delay: "00:00:00.2"
        - target:
            entity_id: light.dartboard
          data:
            transition: 0
          action: light.turn_off
        - delay: "00:00:00.2"
  - target:
      entity_id: light.dartboard
    data:
      color_temp_kelvin: 5000
      brightness_pct: 100
      transition: 0
    action: light.turn_on
```

## 5. Big Fish (170 checkout) — cyan flash + call-out

Same red/amber/green flash pattern as above, but with a spoken call-out so the room
hears it too (swap `media_player.living_room_speaker` for your own speaker). This
uses the legacy-but-still-supported `tts.google_translate_say` service since it needs
no per-install entity ID beyond the speaker itself; if your HA version's Google
Translate integration is set up as a modern `tts` entity instead, use `tts.speak`
targeting that entity with the same `message`/media-player parameters.

```yaml
alias: Oche - Big Fish
description: ""
triggers:
  - trigger: webhook
    webhook_id: oche_bigfish
    allowed_methods:
      - POST
    local_only: true
actions:
  - repeat:
      count: 8
      sequence:
        - target:
            entity_id: light.dartboard
          data:
            rgb_color: [0, 220, 255]
            brightness_pct: 100
            transition: 0
          action: light.turn_on
        - delay: "00:00:00.2"
        - target:
            entity_id: light.dartboard
          data:
            transition: 0
          action: light.turn_off
        - delay: "00:00:00.2"
  - target:
      entity_id: light.dartboard
    data:
      color_temp_kelvin: 5000
      brightness_pct: 100
      transition: 0
    action: light.turn_on
  - target:
      entity_id: media_player.living_room_speaker
    data:
      message: "{{ trigger.json.player }} hits the Big Fish! A 170 checkout!"
    action: tts.google_translate_say
```

## 6. Nine-Darter — full celebration + phone push

The rarest event Oche can fire, so this one goes further: a longer rainbow strobe,
a spoken announcement, and a push notification for anyone not standing in the room.
Swap `notify.mobile_app_your_phone` for your own device's notify service (**Settings
→ Companion App → your device** in HA tells you the exact service name).

```yaml
alias: Oche - Nine Darter
description: ""
triggers:
  - trigger: webhook
    webhook_id: oche_ninedarter
    allowed_methods:
      - POST
    local_only: true
actions:
  - repeat:
      count: 3
      sequence:
        - target:
            entity_id: light.dartboard
          data:
            rgb_color: [255, 0, 0]
            brightness_pct: 100
            transition: 0
          action: light.turn_on
        - delay: "00:00:00.15"
        - target:
            entity_id: light.dartboard
          data:
            rgb_color: [255, 170, 0]
            brightness_pct: 100
            transition: 0
          action: light.turn_on
        - delay: "00:00:00.15"
        - target:
            entity_id: light.dartboard
          data:
            rgb_color: [0, 255, 0]
            brightness_pct: 100
            transition: 0
          action: light.turn_on
        - delay: "00:00:00.15"
        - target:
            entity_id: light.dartboard
          data:
            rgb_color: [0, 220, 255]
            brightness_pct: 100
            transition: 0
          action: light.turn_on
        - delay: "00:00:00.15"
        - target:
            entity_id: light.dartboard
          data:
            rgb_color: [200, 0, 255]
            brightness_pct: 100
            transition: 0
          action: light.turn_on
        - delay: "00:00:00.15"
  - target:
      entity_id: media_player.living_room_speaker
    data:
      message: "Nine darter! {{ trigger.json.player }} just threw a perfect leg!"
    action: tts.google_translate_say
  - target:
      entity_id: notify.mobile_app_your_phone
    data:
      title: "🏆 NINE-DARTER!"
      message: "{{ trigger.json.player }} just threw a perfect leg — come see it!"
    action: notify.mobile_app_your_phone
  - target:
      entity_id: light.dartboard
    data:
      color_temp_kelvin: 5000
      brightness_pct: 100
      transition: 0
    action: light.turn_on
```

## 7. Game Start / Game End — a "game night" scene

Dims the room to a warm, low scoring-friendly light when a game begins, restores
normal lighting when it ends — a nice ambience touch that needs no per-turn logic at
all, just the two bookend events. Uses whichever room lights you actually play under,
not just the board light.

```yaml
alias: Oche - Game start (game night scene)
description: ""
triggers:
  - trigger: webhook
    webhook_id: oche_gamestart
    allowed_methods:
      - POST
    local_only: true
actions:
  - target:
      entity_id: light.living_room
    data:
      color_temp_kelvin: 2700
      brightness_pct: 50
      transition: 2
    action: light.turn_on
  - target:
      entity_id: light.dartboard
    data:
      color_temp_kelvin: 5000
      brightness_pct: 100
      transition: 0
    action: light.turn_on
```

```yaml
alias: Oche - Game end (restore lighting + winner celebration)
description: ""
triggers:
  - trigger: webhook
    webhook_id: oche_gameend
    allowed_methods:
      - POST
    local_only: true
actions:
  - repeat:
      count: 6
      sequence:
        - target:
            entity_id: light.dartboard
          data:
            rgb_color: [0, 255, 0]
            brightness_pct: 100
            transition: 0
          action: light.turn_on
        - delay: "00:00:00.3"
        - target:
            entity_id: light.dartboard
          data:
            rgb_color: [200, 130, 255]
            brightness_pct: 100
            transition: 0
          action: light.turn_on
        - delay: "00:00:00.3"
  - target:
      entity_id: media_player.living_room_speaker
    data:
      message: "{{ trigger.json.player }} wins the game!"
    action: tts.google_translate_say
  - target:
      entity_id: light.living_room
    data:
      color_temp_kelvin: 4000
      brightness_pct: 100
      transition: 2
    action: light.turn_on
  - target:
      entity_id: light.dartboard
    data:
      color_temp_kelvin: 5000
      brightness_pct: 100
      transition: 0
    action: light.turn_on
```

## 8. Moment Card → Discord post

The `momentcard` event fires whenever a shareable card (180/Big Fish/Nine-Darter/
match win) is generated, with `headline` and `statLine` fields ready to drop straight
into a chat message — zero extra setup beyond a
[Discord notify integration](https://www.home-assistant.io/integrations/discord/)
already configured in HA (`notify.discord`, or whatever you named it):

```yaml
alias: Oche - Moment card to Discord
description: ""
triggers:
  - trigger: webhook
    webhook_id: oche_momentcard
    allowed_methods:
      - POST
    local_only: true
actions:
  - target:
      entity_id: notify.discord
    data:
      message: "🎯 {{ trigger.json.headline }} — {{ trigger.json.player }} ({{ trigger.json.statLine }})"
    action: notify.discord
```

The same `momentcard` payload also includes the generated card image itself as a
base64 PNG data URL (`trigger.json.image`), so a fancier version that posts the actual
image is possible in principle — but Discord's HA integration expects a file path or
hosted URL, not an inline data URL, so getting the image itself into the message
needs a way to write that base64 string out to a file first (a `shell_command` or
`python_script` that decodes it, output to somewhere under `/config/www/`). That's a
genuinely separate, HA-setup-specific step rather than a copy-paste automation, so
it's left as a "for whoever wants to go further" note rather than a recipe here — the
text-only version above already gets the moment into Discord instantly with no extra
plumbing.

## Adapting these further

- **Ton+ Finish** (`ha_webhook_tonplus`) carries a `score` field — e.g.
  `"{{ trigger.json.player }} checks out {{ trigger.json.score }}!"` in a `tts.speak`
  step makes a nice, cheap addition to recipe #5's pattern for any 100+ finish, not
  just the exact 170 Big Fish case.
- **Set Start/End** (`ha_webhook_setstart`/`ha_webhook_setend`) fire the same shape of
  payload as Leg Start/End with a `setNo` instead of `legNo` — recipes #2 and #3 can
  be duplicated verbatim onto those webhook IDs for a bigger flash/pause between sets
  than between individual legs, if you want the distinction.
- All of the flash-pattern recipes above (`repeat.count`, colors, delays) are trivial
  to retune — fewer/more repeats, a different `rgb_color`, or a longer/shorter
  `delay` are all safe to change without touching anything else in the automation.
