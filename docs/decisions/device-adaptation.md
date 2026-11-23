# Device adaptation in the reference engine (#90)

Status: **implemented, to be measured on phones** (2026-11-23). Spec §16 says what an engine must do; this records
how the reference engine does it and the numbers chosen. Thresholds are in `DEFAULT_GOVERNOR_TUNING`
(`packages/core/src/engine/governor.ts`), the geometric mapping in `GEOMETRY_CALIBRATION`
(`packages/core/src/expressions/geometry.ts`).

## Thresholds

The first version used a 15 Hz floor (shown again above 18 Hz, drop below 16, restore at 20). With our LiteRT.js
tracker in a worker (#166), the Redmi Note 11S tracks at 16–18 Hz and the user judged that "the glasses follow well"
at that rate: smoothing and prediction between results (#13) fill the gaps. 15 Hz left no margin, so the floor is now
12 Hz, shown again above 14 Hz, drop below 13 Hz, restore at ≥ 17 Hz predicted (same delays and probes). Snap's
"15 FPS floor" is a rendering frame rate, not a tracking rate: rendering stays at the camera's rate here whatever the
tracking rate.

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
| Drop the next optional capability | settled rate < 13 Hz | 1 Hz of margin above the floor, so that the filter is not hidden when a drop is enough |
| Hide the face filters | < 12 Hz for 3 s, nothing left to drop | spec §16.3 |
| Show them again | predicted rate *with the filters shown* > 14 Hz for 1 s | spec §16.3; doubled after each quick re-hide |
| Restore the last capability dropped | predicted rate ≥ 17 Hz for 5 s | 4 Hz above the drop level; doubled when it had to be dropped again within 10 s |
| Tracker warm-up | first 1 s after the governor starts | its first results are slower (7.4 Hz for a worker tracker's first results on the Redmi) |
| Faces | showing and restoring judge only the results with the faces of the drop or hide (rate from their intervals, their pipeline time); none in the window: no decision, timers kept | without a face MediaPipe runs only its detector (Redmi: 11 → 23 Hz); the test clips lose the face at cuts and profiles, so a time-based gate blocked recovery |
| Probe | 30 s, doubling to 10 min | when the measured rate is high but the prediction says no |
| Pause | > 1.5 s between frames | a background tab: the measure restarts |

**Predictions.** Dropping a capability records what it gained as a ratio of pipeline times (after / before);
restoring it is predicted by adding that share of the current pipeline time to the current period:
`1000 / (period + pipeline × (1 / ratio − 1))`. A ratio rather than milliseconds, so that a gain measured while the
device was loaded (heat, another tab) still holds once it frees up; pipeline times rather than rates, because the
camera caps the rate (30 Hz with a pipeline of 8 ms says nothing about what 5 more ms cost). A prediction can be
wrong when the load changed while it was measured: hence the slow probes.

**Showing hidden filters.** Hiding them frees the main thread (rendering, scripts), so the rate measured while they
are hidden is not the rate they would get. The Redmi Note 11S showed it live (`/engine.html?filter=/filters/glasses/`,
camera, MediaPipe CPU on the main thread): hidden at 13.2 Hz, the rate climbed to 23.5 Hz once hidden, the filter was
shown again 9 s later and hidden again 6 s after that. The first version predicted the shown rate from a ratio
measured 1 s after the hide, while the rate was still climbing. Now the governor first measures, for 6 s
(`hiddenBaselineMs`), the rate and pipeline time once hidden; after that the shown rate is predicted as the rate just
before hiding, scaled by how much faster tracking got since then (rate or pipeline time, whichever says more). In the
Redmi case that stays at 13.2 Hz: only the probes (30 s, then 60 s, 120 s… up to 10 min, each showing the filter for
3 s at most) try again. The same holds for results with fewer faces than when the filter was hidden (or a
capability dropped): seen on the Redmi with MediaPipe forced (hidden at 13.1 Hz, shown again 8 s later at 23.1 Hz
with no face in view, MediaPipe running only its detector). Such a rate still counts towards dropping. A real gain (another load ends) still shows the filters within seconds. Reproduced by
`DeviceGovernor` unit tests and by `e2e/device-adaptation.spec.ts` (fixture `busy`: a layer that blocks the main
thread 85 ms per frame). The doubling after a failed show did apply on the phone (the delay went from 1 s to 2 s), but
a doubled 1 s delay cannot prevent a flicker that the prediction lets through.

The root cause on that phone is the main-thread MediaPipe tracker (8–12 Hz there). The decision of #83 / #6 (our
LiteRT.js pipeline in a worker: 15–18 Hz on the same phone, rendering at 29 fps whatever the tracking rate) is not in
the engine yet.

**Capabilities** (spec §16.2), dropped in this order when the stack can do without them:

1. Blendshapes, unless an enabled filter sets `requires.blendshapes`. Bindings take their `default`, scripts get no
   `blendshapes`, expression events come from the landmark geometry (below). The MediaPipe tracker keeps computing
   them: switching them needs a graph rebuild (`setOptions`) that stalled the main thread for about a second on the
   desktop, for no measurable gain (#83: 35.6 against 35.7 ms on the CPU delegate). The LiteRT.js tracker skips the
   model (≈ 1–6 ms).
2. Extra faces, when `maxFaces` > 1: the tracker looks for the faces tracked at that moment (at least one).
   MediaPipe: `numFaces` through `setOptions` (one stall per transition, rare thanks to the hysteresis).
3. Analysis resolution: the frame is drawn at half size into a canvas before tracking (landmarks are normalized, so
   nothing else changes). Its gain with MediaPipe is not measured on phones yet. The LiteRT.js tracker ignores it (its
   crops come from the full frame on the GPU), and says so (`FrameTracker.sheds`: blendshapes only): the governor does
   not spend a step on it.

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
| eyeClosed (L / R), absolute | lid opening (5 pairs) / eye width | 0.30 → 0 | 0.82 / 0.77 | 0.11 / 0.14 |
| jawOpen | inner lip gap / outer eye corners | 0.04 → 0.95 | 0.54 | 0.02 |
| smile | mouth corners above the lip centre / eye corners | 0.012 → 0.08 | 0.85 | 0.11 |
| browRaise | inner brows above the inner eye corners / eye corners | 0.265 → 0.45 | 0.66 | 0.01 |
| pucker | mouth width / eye corners | 0.50 → 0.38 | 0.67 | 0.04 |

**Eyes: adaptive open-eye baseline.** The absolute eye mapping missed blinks live: the eyelid opening varies a lot
between people, and a blink seen at 12 Hz is often caught half-closed. What the engine uses is `GeometrySignals`:
per face and eye, an open-eye baseline that follows the opening up quickly (τ 300 ms) and down slowly (τ 15 s), a
running upper envelope, restarted for a new face or after 1 s without it; the closure `1 − opening / baseline` maps
0.2 → 0 and 0.7 → 1, less 0.2 × the smile signal (`EYE_BASELINE`, chosen on a plateau of a small grid search). It is
fed the **raw** tracking result: the smoothed landmarks the first version read blunt a blink that lasts one or two
results (and the calibration was made on raw landmarks).

| Blinks (30 and 15 Hz pooled, ±250 ms) | Hits / 19 blendshape blinks | Extra blinks | r / MAE vs eyeBlink |
|---|---|---|---|
| Absolute, 3 lid pairs (first version) | 15 | 8 | 0.79 / 0.12 |
| Baseline, 5 lid pairs (now) | 13 | 3 | 0.76 / 0.21 |

The two blinks lost are blendshape crossings of 0.5 while the person looks down (`pesquet-walk` 3.5–6.3 s, pitch
−30 to −40°), where the eyeBlink score itself stays at 0.5–0.8 for seconds: the baseline removes that sustained
lowering on purpose, hence the larger MAE. Compensating the pitch helped one configuration only (overfitting); not
kept. The clips have one person: the baseline's main gain, other people's eye shapes, is for live tests to confirm
(`/engine.html?signals`).

**Blinks with blendshapes, at low tracking rates.** Live (webcam, full light, ≈ 30 Hz tracking), MediaPipe's
`eyeBlink` peaked at about 0.6 on full blinks for one person, borderline for the default 0.5. On the clips, the peak of
min(left, right) per reference blink (blendshape blinks at 30 Hz), sampled from the raw results at every phase:

| Rate | Source | Median peak | ≥ 0.5 | ≥ 0.4 | ≥ 0.35 |
|---|---|---|---|---|---|
| 30 Hz | blendshapes / geometry | 0.59 / 0.74 | 100 % / 91 % | 100 % / 100 % | 100 % / 100 % |
| 15 Hz | blendshapes / geometry | 0.59 / 0.69 | 82 % / 73 % | 86 % / 82 % | 91 % / 82 % |
| 10 Hz | blendshapes / geometry | 0.54 / 0.63 | 73 % / 70 % | 85 % / 79 % | 94 % / 82 % |

So a blink seen at 10–15 Hz is often caught half-closed, whatever the source. What the clips say about the fixes
tried (clear reference blinks hit, extra blinks; the three blendshape "blinks" while the person looks down are left
out of the hits), at 30 / 15 / 10 Hz:

| Option | Hits | Extra |
|---|---|---|
| Blendshapes, threshold 0.5 (unchanged default) | 8/8, 10/16, 19/24 | 0, 0, 0 |
| Blendshapes, threshold 0.4 | 7/8, 10/16, 15/24 | 3, 6, 7 |
| Blendshapes, threshold 0.35 | 7/8, 12/16, 16/24 | 7, 6, 15 |
| Blendshapes, detector calibration on, threshold 0.4 | 6/8, 10/16, 17/24 | 1, 0, 0 |
| Blendshapes normalised per face (open / closed envelopes) | at best 6/8, 10/16, 15/24 | 1, 0, 0, plus winks |
| Geometry (mapping 0.2 → 0, 0.7 → 1); 0.6 or 0.5 for the "1" end | 7/8, 10/16, 17/24 | 1, 2, 1; more with a lower "1" |
| **Each eye: max(blendshape, geometry)** | **8/8, 12/16, 20/24** | **0, 0, 0** (no wink either) |

Lowering the threshold or normalising the blendshapes adds false blinks while the person looks down (the score stays
at 0.3–0.8 for seconds); a more sensitive geometric mapping only adds false blinks. The engine therefore keeps the
default threshold (0.5) and, while blendshapes are available, gives the blink and wink detectors each eye's **larger**
value of the blendshape score and the geometric closure (`maxEyeSignals`): it catches the blinks a low `eyeBlink`
misses (the live case) and more blinks at 15 and 10 Hz, with no extra event on the clips. Bindings and scripts keep
the raw blendshapes. Caveat: the reference blinks are blendshape crossings themselves; labelling the clips by eye was
tried but the person mostly looks down and moves, and the eye crops are too small to tell a blink from lowered lids.
The engine page's `?signals` panel shows each signal's peak over 1.5 s and counts the blinks and winks the engine
fired, and those each source alone would fire, to measure this live.

Smiles with the default thresholds: 3 of the 4 blendshape smiles fire from the geometry within 250 ms (at 30 Hz and
at 15 Hz), with extra smile / smileEnd pairs around the threshold. The clips do not reach the thresholds of
`mouthOpen` (jawOpen ≤ 0.3 on those frames), `eyebrowRaise` or `kiss`: those mappings are extrapolated, their "1" set
from typical proportions (a full eyebrow raise ≈ 15 % of the eye distance, a pucker ≈ 40 % of the mouth width). The
engine page shows both sources side by side (`/engine.html?signals`) to check them on a real face.

## Backend benchmark (spec §16.4)

Built-in tracker (`defaultFaceTracker`, #165): three backends, our LiteRT.js pipeline in a worker (`LiteRT`) and
MediaPipe's `GPU` and `CPU` delegates on the main thread (any `maxFaces`: LiteRT.js tracks several faces since #165's
second PR). Without a cached choice it starts on LiteRT.js (MediaPipe GPU, then CPU, if it cannot start) and, on the first
frames of a **live** source, opens the others; then each backend runs on consecutive frames, one after the other,
3 results left out, then 12 measured (time from the call to its result). The lowest median wins, on frames with a face
when each backend has at least 6 of them; MediaPipe's medians are multiplied by `MAIN_THREAD_WEIGHT` (1.15) for the
decision, since its time is also taken from rendering. The others are closed, MediaPipe's WebGL contexts lost at
once (`WEBGL_lose_context`) rather than at garbage collection. During the benchmark (≈ 2 s) the
governor waits. A file source stops it (its results must not depend on timing); it runs again on the next live
source. A tracker that breaks while running (the worker died) is replaced by the next one that opens.

Measured one after the other rather than in turns: in turns, MediaPipe's GPU delegate left work on the GPU that the
worker's crops waited for, and the worker lost its eager scheduling (LiteRT.js measured 45–49 ms per result instead of
17–20 on the desktop). The trade-off: a change of content or load during the 2 s affects the backends unequally (on
`pesquet-talk` LiteRT.js is measured on the first second, without a face, with the detector on every frame).

Cache: `localStorage`, key `ouaf:tracker-backend:<engine version>:<tracker id>` (`face` for the built-in tracker),
value `{ backend, measuredMs, userAgent, at }`; ignored when the browser's user agent changed. Never transmitted (§15,
`docs/privacy.md`). `EngineOptions.trackerBackend` forces a backend (`litert`, `GPU`, `CPU`, any case; on
`/engine.html`: `?backend=`).

Headless Chromium with a software GPU (SwiftShader), desktop: GPU 65–80 ms, CPU 20–23 ms per frame → CPU. The
Redmi Note 11S measured by hand in #83 (MediaPipe: GPU ≈ 134 ms, CPU ≈ 67 ms) should also pick the CPU among
MediaPipe's delegates, and LiteRT.js in a worker (≈ 55–70 ms per result in #83's W8 runs) overall. Desktop (#165,
`pesquet-talk`): LiteRT 32–48, GPU 44–52, CPU 17–20 ms → MediaPipe CPU. Redmi Note 11S (#165, camera): LiteRT 55.0,
GPU 101.0, CPU 66.3 ms → LiteRT.js.

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
flicker around the thresholds), the cost of a MediaPipe `setOptions` stall, the gain of the reduced analysis
resolution, and blinks from the geometry on several people.

First live run (Redmi Note 11S, `glasses`, camera): MediaPipe CPU chosen from the cache (88.3 against 102.9 ms on the
GPU), tracking 12.3 Hz with 75.5 ms of tracking per frame, blendshapes and resolution dropped, then the flicker
described above (fixed), and blinks poorly detected from the geometry (reworked above).
