# iOS/Android App — Design Roadmap

> Status: **not started** (the native app itself). One prerequisite from the build
> order below — the phone-responsive CSS pass — is done; see item 1. This is
> otherwise a design doc for a future release, captured so the thinking isn't lost.

## Goal

A native iOS/Android app that's mostly a front end — optimized for phone screen sizes
and platform feel — pointing at the URL or IP of a self-hosted Oche instance the user
already runs, with support for connecting over HTTPS.

## Decisions made (2026)

| Decision | Choice |
|---|---|
| Build approach | Hybrid webview wrapper (e.g. Capacitor) around the existing web frontend, not a cross-platform or fully native rewrite |
| Connection security | Support plain HTTP (LAN) and self-signed HTTPS, with explicit warnings — don't require CA-trusted HTTPS |
| TLS termination | Document a reverse proxy in front of Oche (e.g. Caddy) as the supported path to HTTPS; no native TLS termination added to `server.js` |

## The core mechanism

Rather than bundling the web app's assets inside the native binary, the app points
its WebView at the **live remote URL** the user configures — the phone navigates to
`https://<their-server>/` the same way a desktop browser would, instead of shipping a
frozen copy of `frontend/index.html` inside the app. Capacitor supports this via its
remote-URL config (normally used for dev live-reload, equally valid as a production
pattern here).

This has two real, non-cosmetic consequences worth designing around:

1. **The app almost never needs an app-store update for UI changes.** Every feature
   and fix shipped to the web frontend is live for every phone the moment it loads —
   there's no bundled copy to go stale. Updates are only needed for native-shell-level
   changes (permissions, plugin versions, OS compatibility).
2. **No CORS work needed on the backend.** Since the WebView navigates to the server's
   own origin (rather than an app-bundled origin making cross-origin API calls),
   everything — including every `fetch()`/SSE call the page makes — stays same-origin.
   This is part of why "load the full remote URL" beats "bundle local assets and call
   a remote API" as the architecture here.

## First-run flow

A native "Server Setup" screen (has to be native — there's no webview content yet):
enter the server's URL or IP, "Test connection" (reuse the existing
`GET /api/health`), save it locally, then load that address into a full-screen
WebView for everything else. Since the WebView then owns the whole screen, there needs
to be a persistent native affordance to get back to "change server" later — a small
native header/tab bar wrapping the webview, or a pull-down gesture — rather than
losing that control once the web UI takes over.

## Connection security: the genuinely tricky part

Supporting both plain HTTP and self-signed HTTPS (per the decision above) runs into
real platform constraints worth documenting precisely:

- **iOS App Transport Security (ATS)** blocks cleartext HTTP and untrusted
  certificates by default, and — importantly — **ATS exceptions are declared
  statically at build time**, not per-connection at runtime. Since the server address
  isn't known until the user types it in, the app can't add a narrow exception for
  just that one domain. In practice this means shipping with a broad
  `NSAllowsArbitraryLoads` exception and doing the safety net at the *app* level
  instead of relying on the OS to enforce it per-server.
- **Android** needs the equivalent network security config
  (`cleartextTrafficPermitted`) to permit cleartext for arbitrary hosts, for the same
  reason.
- **Self-signed HTTPS certificates are a separate problem from cleartext.** Even with
  ATS loosened, a WebView will still hard-fail on a certificate that doesn't chain to
  a trusted root — which is exactly what a typical self-hosted reverse-proxy setup
  uses. The right UX (matching "explicit warnings, don't block") is to intercept the
  platform's SSL-error callback (`WKNavigationDelegate` on iOS,
  `WebViewClient.onReceivedSslError` on Android) and show an interstitial — "This
  server's certificate isn't verified — trust it?" — the same pattern browsers use for
  self-signed certs, not a silent pass-through.
- **Recommendation beyond a bare accept/reject prompt**: remember the specific
  certificate after the user accepts it once (trust-on-first-use, the same model SSH
  uses for host keys) rather than accepting *any* certificate that server ever
  presents. A blind "always trust this server" would quietly defeat the point of the
  warning if the certificate changed later (e.g. an actual MITM).

## Remote access

Given this app's self-hosted, nothing-leaves-your-network design (see the README's
Data Storage section), the recommended path for playing away from home is a
**WireGuard-based VPN (e.g. Tailscale)**, not a publicly-exposed HTTPS endpoint. If the
phone is on the same Tailscale network as the server, it's reachable exactly like it
is on the home LAN — no certificates, no reverse proxy, no public exposure. For anyone
who specifically wants a public-facing address instead, the doc should also cover a
reverse-proxy setup (e.g. Caddy, for automatic Let's Encrypt certs), consistent with
the "reverse proxy handles TLS" decision above.

## Native affordances worth the (small) extra effort

A pure webview shell risks both a mediocre feel and real app-store review friction —
Apple in particular has historically pushed back on apps perceived as thin
remote-content wrappers with no native value. A few low-effort additions address both
at once:

- Haptic feedback on dart-entry taps (small native bridge call).
- Biometric unlock (Face ID / Android biometric) as a convenience gate in front of the
  Settings webview, instead of typing the admin password on a phone every time.
- A native **"Scoreboard Mode"** toggle that points the WebView at `/display` instead
  of `/` — useful for mounting a spare phone as a mini scoreboard.

## What doesn't need to change

No backend API changes are anticipated beyond what already exists
(`GET /api/health` for the connection test). This is genuinely "mostly a front end" —
the work is native packaging, responsive CSS, and the TLS/trust handling above.

## Suggested build order

1. ~~**Phone-optimized responsive CSS** on the existing web app (New Game, Scoring,
   Player Profile, Settings)~~ ✅ **Done**, ahead of the native wrapper as planned —
   see `docs/existing-app-prep-roadmap.md` item 8 for what was found and fixed.
2. **Capacitor scaffold** (iOS + Android) with the native Server Setup screen +
   remote-URL WebView.
3. **ATS/cleartext config + self-signed cert trust-prompt** (the flexible-TLS work
   above).
4. **Native chrome**: change-server access, haptics, biometric unlock.
5. **Scoreboard Mode** toggle.
6. **Distribution decision**: App Store/Play Store listing vs. simpler
   self-distribution (sideloaded APK on Android, TestFlight on iOS) — a real open
   question, since public store listing brings review risk a private/community tool
   may not need.
7. *(Stretch)* multiple saved server profiles (useful if playing at more than one
   Oche-hosting location), local-network auto-discovery (mDNS) instead of manual IP
   entry, home-screen widget.

## Open questions for whoever picks this up

- App Store / Play Store listing vs. sideload/TestFlight-only distribution — changes
  packaging and review-risk considerations significantly.
- Exact self-signed-certificate trust UX on each platform (interstitial wording,
  where the trusted-certificate list is stored/managed, how a user revokes trust for a
  server later).
- Whether multiple saved server profiles are worth the complexity given this app is
  typically a single-household tool.
