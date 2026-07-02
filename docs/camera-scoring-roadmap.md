# Automated Camera/ML Scoring — Design Roadmap

> Status: **not started**. This is a design doc for a future release, captured so the
> thinking isn't lost. Nothing described here exists in the app yet.
>
> This is expected to be the largest addition this project ever makes — a real
> computer-vision system, not an incremental feature. Sized and phased accordingly.

## Goal

Automatically score darts using one or two ceiling-mounted cameras and computer
vision, so a player never has to manually enter what they threw. Must support a
single-camera setup as well as the two-camera setup the primary use case is built
around. The camera hardware setup and calibration process must be fully documented,
step by step, so someone else can replicate it without prior computer-vision
experience.

## Decisions made (2026)

| Decision | Choice |
|---|---|
| Build approach | Custom computer-vision pipeline built from scratch (not an integration with an existing project like Autodarts) |
| Calibration method | Manual — user taps known reference points on a captured frame per camera |
| Confidence handling | Threshold-based: high-confidence detections auto-score; uncertain ones (low confidence or cameras disagreeing) fall back to a manual confirm/correct prompt |

## The one thing that makes this tractable at all

Every dart game in this app ultimately reduces to the same atomic event: **a dart
lands on `(sector, multiplier)`**. That's the `darts` table schema, and it's exactly
what `throwDart(sector, mult)` in `frontend/index.html` already consumes, regardless
of whether the tap came from the number pad or the SVG dartboard (see
`throwDartBoard()`). The computer-vision system's entire job, architecturally, is to
become a **third input device** producing that same event. Nothing downstream (turn
logic, stats, live scoreboard, and — per the game-modes roadmap — any future game
type's turn engine) needs to know or care that a camera produced the event instead of
a finger tap. This is the load-bearing design decision underneath everything else
here, and it means this feature is additive to the input layer, not a rework of the
scoring engine.

## Architecture: a separate vision service, not part of the Node app

Real-time video processing needs OpenCV/numpy-grade tooling Node doesn't have a
mature equivalent of. This should run as a **separate Python service** — its own
process, likely its own Docker container alongside the existing `docker-compose.yml`
service — reading the camera stream(s), running the detection pipeline, and calling a
small new endpoint on the existing Oche backend (e.g.
`POST /api/vision/dart-detected { sector, multiplier, confidence }`) whenever it
resolves a throw.

This is a deliberate, real exception to the project's current "one dependency-free
Node process" identity (see README's Architecture section) — worth stating plainly
rather than quietly introducing a second language and a dependency tree. The
alternative — reimplementing computer-vision primitives from scratch in a language
with far weaker support for it — isn't a realistic option for this scope.

**Deployment**: package the vision service behind a Docker Compose profile (or a
separate compose file, matching the existing `docker-compose.dev.yml` convention)
rather than always-on in the default `docker-compose.yml` — see
`docs/existing-app-prep-roadmap.md` item 9. Anyone who doesn't want camera scoring
should never have this service running just because they installed Oche.

**Open question**: where does the vision service run relative to the Oche backend
(same device/LAN), and does the new detection endpoint need its own auth/trust story,
or is it acceptable to trust it the same way the unauthenticated live-scoreboard
channel is trusted (LAN-scoped by design)?

## Detection pipeline (per camera)

1. **Baseline capture** — a reference frame of the board at rest, no darts in it.
2. **Change detection** — diff each new frame against the current board state to
   notice *a dart has landed* or *darts have been pulled* (end of visit → reset
   baseline for the next one).
3. **Dart tip localization** — from a ceiling-mounted oblique angle, a landed dart
   appears as a shaft/flight silhouette; the scoring point is the tip end nearest the
   board surface. Classical background-subtraction + contour detection should resolve
   this in the common case.
4. **Board-coordinate mapping** — apply that camera's calibrated homography (see
   below) to convert the pixel-space tip location into board coordinates relative to
   the bullseye.
5. **Sector/ring classification** — given board coordinates, compute sector (angle)
   and ring (single/double/treble/bull, by radius). **This reuses geometry that
   already exists in the codebase**: `buildDartboard()` in `frontend/index.html`
   already defines the exact radii (`R.bullIn`, `R.bullOut`, `R.trebleIn`,
   `R.trebleOut`, `R.doubleIn`, `R.doubleOut`) used to draw the SVG dartboard. That's
   the same math the CV classifier needs to reuse or port, not re-derive from scratch.
6. **Confidence scoring** — how close the hit is to a wire boundary, how clean the
   detected contour was, and how consistent the two cameras' independent estimates
   are with each other.

## Classical CV first, ML only where it earns its keep

Despite "machine learning" being in the feature name, the recommendation is to start
with classical computer vision (background subtraction, contour/blob detection,
geometric homography) for the whole pipeline, and reserve an actual trained model for
the one sub-problem classical CV is likely to struggle with: **dart-tip localization
once the board already has 1-2 darts in it and occlusion gets messy**. Build classical
first, measure where it actually fails, and only then evaluate whether a narrow
object-detection model is worth training — rather than assuming a full ML system is
needed end-to-end from day one.

## Two cameras: how they actually help

Each camera runs its own independent pipeline (own calibration, own homography, own
classification) rather than true stereo triangulation — simpler to build, test, and
debug independently. The payoff is at reconciliation: if both cameras agree on
`(sector, multiplier)` with reasonable individual confidence, auto-score it
immediately. If they disagree, or one camera's view is occluded by an existing dart,
that's exactly the "uncertain" case that routes to the manual confirm prompt (see
Confidence & Confirmation UX below). A single camera still works on its own — it just
loses the "two independent opinions agree" signal, so it will fall back to manual
confirmation more often near boundary cases. This gives a concrete, mechanical reason
to run two cameras beyond simple redundancy.

**Placement recommendation** (to be validated against real hardware): position the two
cameras roughly perpendicular to each other around the board's central axis, so
whichever one gets occluded by an existing dart is likely to be the one the other
camera can still see clearly.

## Manual calibration flow

A new admin-facing "Camera Setup" wizard in Settings:

1. Confirm the camera feed is visible.
2. Capture a still frame of the empty board.
3. Tap known landmarks on that frame (bullseye center, a couple of sector-boundary
   wire intersections).
4. Compute the homography from those points.
5. Overlay the computed sector/ring grid on the live feed so the setup can be visually
   confirmed against the real board before accepting.
6. Repeat per camera.

## Confidence & confirmation UX

The vision service's output becomes a third input mode alongside the existing
Pad/Dartboard tabs on the scoring screen. High-confidence, camera-agreeing detections
score instantly, the same as a tap. Anything below the confidence threshold (or
cameras disagreeing) pauses with a lightweight confirm/correct prompt before it's
recorded — reusing the app's existing modal pattern (`uiConfirm`-style in
`frontend/index.html`). Manual Pad/Dartboard entry always remains available as a
fallback if the vision system misfires or is temporarily unavailable — this falls out
for free from the existing input-mode tab structure.

## Camera hardware & setup — documentation requirements

This is explicitly called out as a first-class deliverable, not an afterthought. The
actual step-by-step guide (exact photos, measurements, part numbers) can't be written
speculatively in a planning doc — it needs to be written by whoever builds and tests
this, ideally *while* setting up their own two-camera rig, so it's accurate rather than
theoretical. What it must cover once written:

- **Camera type** — IP/PoE cameras with an RTSP stream are the practical
  recommendation for a permanent ceiling install (power + data over one cable, no USB
  runs across a ceiling). Raspberry Pi camera modules are a cheaper alternative if the
  vision service runs on a Pi mounted nearby.
- **Resolution/frame rate** — since detection is a before/after diff rather than
  flight-path tracking, a moderate frame rate (15-30fps) at 1080p is a reasonable
  starting target, but needs real-world validation, not just an assumption.
- **Mounting geometry** — ceiling height above the board, distance out from the wall,
  and angle needed to resolve sector angles precisely while staying ceiling-mounted. A
  real, photographed example rig is the single most valuable thing this guide can
  contain, and can only be produced from an actual build.
- **Two-camera placement** — see placement recommendation above.
- **Lighting** — consistent, even, shadow-free illumination is likely the single
  biggest practical failure point for background-subtraction-based detection. Flagging
  this now so it gets its own explicit setup guidance and troubleshooting section,
  rather than becoming a mystery when detection is unreliable.
- **Compute** — running two simultaneous OpenCV pipelines at a good frame rate may be
  more than a Raspberry Pi comfortably handles; a small dedicated mini PC might be the
  more reliable target device. Needs real benchmarking.
- **Network** — wired local network for camera streams strongly preferred over Wi-Fi,
  for latency and reliability.

## Suggested build order

Given the scale, this needs more phases than any other roadmap item:

1. **Hardware proof of concept** — get a live video feed from one camera into a
   script; no scoring logic yet.
2. **Calibration UI + geometry math** — homography computation, sector/ring
   classification validated against known points (reusing `buildDartboard()`'s
   existing radii).
3. **Motion detection** — reliably detect "a dart landed" / "darts were pulled" on one
   camera.
4. **End-to-end single-camera pipeline** — real dart lands → detected → classified →
   confirmed/auto-scored → flows into the existing `throwDart()` path.
5. **Confidence thresholding + confirm UX.**
6. **Second camera + agreement-based reconciliation.**
7. **Write the Camera Setup Guide**, verified against a real two-camera rig as it's
   built — not written speculatively beforehand.
8. **(Stretch)** evaluate whether a narrow trained model improves tip localization in
   heavy-occlusion cases beyond classical CV's ceiling.

## Accessibility, security, and testing considerations

- **Accessibility — this is a genuine accessibility win worth designing for
  explicitly, not just a scoring convenience.** Automatic dart detection removes the
  need to physically operate the tap-to-score UI at all, which is a real path to
  playing for anyone who has difficulty with the touchscreen/pad input specifically
  — the same "which input path is actually the accessible one" question
  `docs/accessibility-roadmap.md` already raises about Pad vs. dartboard input
  applies here even more directly. Worth stating as an explicit goal of this
  feature, not an incidental side effect, since it should shape priorities (e.g.
  reliable confirm/correction UX matters more than shaving latency).
- **Security**: the detection endpoint's auth/trust story is already flagged as an
  open question below — resolve it the same way the rest of the security audit did
  for other new surfaces (`docs/security-hardening-roadmap.md`'s standing
  checklist): does this endpoint accept write-capable input that needs the same
  gating as a manual `throwDart()` call, and if the vision service runs as a
  separate process/container, does it need its own credential rather than trusting
  network position alone?
- **Testing**: the homography computation and sector/ring classification are pure
  geometry math with known-correct answers (a calibration point should map to a
  specific sector) — exactly the kind of core logic worth real test coverage per
  `docs/testing-and-observability-roadmap.md`, verified against fixed calibration
  fixtures rather than only against a live camera during development.

## Open questions for whoever picks this up

- Where does the vision service run relative to the Oche backend, and does the new
  detection endpoint need its own auth/trust story?
- Exact compute target (Raspberry Pi vs. mini PC) — needs real benchmarking with two
  live OpenCV pipelines running concurrently.
- How does the system handle a dart that bounces out or misses the board entirely —
  does "no dart detected within N seconds of a throw" need explicit handling, or does
  it just rely on the player manually entering a miss when that happens?
