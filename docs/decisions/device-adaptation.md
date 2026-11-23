# Device adaptation in the reference engine (#90)

Status: **implemented, to be measured on phones** (2026-11-23). Spec §16 says what an engine must do; this records
how the reference engine does it and the numbers chosen. Thresholds are in `DEFAULT_GOVERNOR_TUNING`
(`packages/core/src/engine/governor.ts`), the geometric mapping in `GEOMETRY_CALIBRATION`
(`packages/core/src/expressions/geometry.ts`).

## Tracking rate

`TrackingHub.rateHz`: completed results per second over a 3 s sliding window, apart from the rendering frame rate
(`EngineStats.fps`). The governor restarts the window at each change, so that each decision is made on the rate of the
current configuration. `TrackingHub.pipelineMs` is the mean time from a frame's submission to its result: what one
result costs, whatever the camera's frame rate (which caps the rate: with a 30 fps camera, rates snap to 30, 15,
10 Hz, see `face-runtime.md`).

## Governor

Driven by the engine on every rendered frame of a live source (at most every 100 ms), only while a face filter is
enabled and tracking runs; file sources (image, offline video, `pushFrame`) are never governed.

| Rule | Value | Why |
|---|---|---|
| Settle after each change | 1 s | MediaPipe reconfigures asynchronously; the rate window needs a few results |
| Drop the next optional capability | settled rate < 16 Hz | 1 Hz of margin above the floor, so that the filter is not hidden when a drop is enough |
| Hide the face filters | < 15 Hz for 3 s, nothing left to drop | spec §16.3 |
| Show them again | predicted rate > 18 Hz for 1 s | spec §16.3; doubled after each quick re-hide |
| Restore the last capability dropped | predicted rate ≥ 20 Hz for 5 s | 4 Hz above the drop level; doubled when it had to be dropped again within 10 s |
| Probe | 30 s, doubling to 10 min | when the measured rate is high but the prediction says no |
| Pause | > 1.5 s between frames | a background tab: the measure restarts |

**Predictions.** Dropping a capability records what it gained as a ratio of pipeline times (after / before);
restoring it is predicted by adding that share of the current pipeline time to the current period:
`1000 / (period + pipeline × (1 / ratio − 1))`. A ratio rather than milliseconds, so that a gain measured while the
device was loaded (heat, another tab) still holds once it frees up; pipeline times rather than rates, because the
camera caps the rate (30 Hz with a pipeline of 8 ms says nothing about what 5 more ms cost). Showing hidden filters is
predicted from the rates before and after hiding (rendering competes with tracking on the main thread, which pipeline
times do not show). A prediction can be wrong when the load changed while it was measured: hence the slow probes.

**Capabilities** (spec §16.2), dropped in this order when the stack can do without them:

1. Blendshapes, unless an enabled filter sets `requires.blendshapes`. Bindings take their `default`, scripts get no
   `blendshapes`, expression events come from the landmark geometry (below). The MediaPipe tracker keeps computing
   them: switching them needs a graph rebuild (`setOptions`) that stalled the main thread for about a second on the
   desktop, for no measurable gain (#83: 35.6 against 35.7 ms on the CPU delegate). Our LiteRT.js tracker will skip
   the model.
2. Extra faces, when `maxFaces` > 1: the tracker looks for the faces tracked at that moment (at least one).
   MediaPipe: `numFaces` through `setOptions` (one stall per transition, rare thanks to the hysteresis).
3. Analysis resolution: the frame is drawn at half size into a canvas before tracking (landmarks are normalized, so
   nothing else changes). Its gain with MediaPipe is not measured on phones yet.

Face filters are **suspended** while hidden (`FilterHandle.suspended`): not drawn, no events, no script calls;
tracking keeps running. Filters without face tracking keep rendering. `engine.on('performance')` fires at each change
of state or dropped list, `engine.performance` gives the current one.

## Expression events from the landmark geometry

Six measures, each a ratio of 3D landmark distances divided by a rigid length (scale-free), mapped linearly onto the
blendshape scale between a "0" and a "1" value. Fitted (least mean absolute error) on face 0 of the test clips
`pesquet-talk`, `pesquet-walk`, `pesquet-turn` and `two-faces-stacked`, |yaw| < 35° (≈ 180 frames), against
MediaPipe's blendshapes of the same frames (fixtures: `packages/core/test/fixtures/geometry/`, recorded by
`e2e/record-geometry.spec.ts`):

| Signal | Measure | 0 → 1 | Pearson r | Mean abs. error |
|---|---|---|---|---|
| eyeClosed (L / R) | lid opening / eye width | 0.30 → 0 | 0.83 / 0.79 | 0.12 / 0.11 |
| jawOpen | inner lip gap / outer eye corners | 0.04 → 0.95 | 0.55 | 0.02 |
| smile | mouth corners above the lip centre / eye corners | 0.012 → 0.08 | 0.85 | 0.11 |
| browRaise | inner brows above the inner eye corners / eye corners | 0.265 → 0.45 | 0.65 | 0.01 |
| pucker | mouth width / eye corners | 0.50 → 0.38 | 0.67 | 0.04 |

Events with the default thresholds: 8 of the 10 blendshape blinks and 3 of the 4 smiles fire from the geometry within
250 ms (at 30 Hz and at 15 Hz), with 5 extra blinks (smiles narrow the eyes). The clips do not reach the thresholds of
`mouthOpen` (jawOpen ≤ 0.3 on those frames), `eyebrowRaise` or `kiss`: those mappings are extrapolated, their "1" set
from typical proportions (a full eyebrow raise ≈ 15 % of the eye distance, a pucker ≈ 40 % of the mouth width). The
engine page shows both sources side by side (`/engine.html?signals`) to check them on a real face.

## Backend benchmark (spec §16.4)

Built-in MediaPipe tracker: without a cached choice, it starts on the GPU delegate (with the CPU as fallback) and, on
the first frames of a **live** source, opens the CPU delegate too; the two take turns on successive frames, 3 results
each left out, then 12 each measured (the synchronous `detect` call). The lower median wins, on frames with a face
when each backend has at least 6 of them. The loser is closed. During the benchmark (≈ 1–2 s at 15–30 Hz) the
governor waits. A file source stops it (its results must not depend on timing); it runs again on the next live
source.

Cache: `localStorage`, key `ouaf:tracker-backend:<engine version>:<tracker id>`, value `{ backend, measuredMs,
userAgent, at }`; ignored when the browser's user agent changed. Never transmitted (§15, `docs/privacy.md`).
`EngineOptions.trackerBackend` forces a backend.

Headless Chromium with a software GPU (SwiftShader), desktop: GPU 65–80 ms, CPU 20–23 ms per frame → CPU. The
Redmi Note 11S measured by hand in #83 (MediaPipe: GPU ≈ 134 ms, CPU ≈ 67 ms) should also pick the CPU.

## Frame budget (#34)

`EngineStats.frameMs` is the engine's own main-thread time per frame (layers, rendering submission), now without the
tracker's; `trackMs` is a main-thread tracker's time per frame, `frameMsMax` the worst frame of the second. A warning
fires once per stack change when `frameMs` exceeds half the frame interval for 3 s in a row.

## Testing without a slow device

`throttlePlugin({ ms })` (`/engine.html?throttle=<ms>`, and a slider in the page's panel) holds each tracking result
back to `ms`, less 15 % without blendshapes, 20 % without extra faces, 25 % at the reduced resolution. Browser test:
`e2e/device-adaptation.spec.ts`.

## To measure on phones

Redmi Note 11S and a high-end phone (#90, #95): the backend chosen, the governor's transitions on the camera (no
flicker around the thresholds), the cost of a MediaPipe `setOptions` stall, and the gain of the reduced analysis
resolution.
