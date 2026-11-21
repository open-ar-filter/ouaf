# Face tracking runtime: MediaPipe tasks-vision or our own pipeline on LiteRT.js (#83)

Status: **proposed**. The desktop numbers below are clear-cut, and the Redmi Note 11S confirms the lead once the
crop runs on the GPU (2026-11-21, below). The decision is final once an iPhone and a high-end Android phone have
run the R1–R9 protocol in [`phase0-measurement-protocol.md`](phase0-measurement-protocol.md#83--face-models-on-another-runtime).

## Question

MediaPipe FaceLandmarker costs 75–100 ms per frame on a mid-range Android phone (≈ 10 Hz), CPU delegate slightly
faster than GPU. `@mediapipe/tasks-vision` 1.2.3 ships one single-threaded wasm build (one core of eight) and a
WebGL GPU path. Do the same models run faster on a runtime that uses several cores (wasm threads) or WebGPU, and what
would our own pipeline cost to build and maintain?

## What was built

- `npm run fetch-models` now also extracts the three TFLite models of `face_landmarker.task` (a plain zip archive):
  `face_detector.tflite` (BlazeFace short range, 128×128 → 896 anchors), `face_landmarks_detector.tflite`
  (256×256 crop → 478 × xyz in crop pixels, plus a face presence logit) and `face_blendshapes.tflite` (146 of the
  points, xy in frame pixels → 52 scores). Licence: Apache-2.0 (MediaPipe model cards for BlazeFace, Face Mesh V2
  and Blendshape V2); the models stay downloaded at setup time, not committed.
- Runtime: **LiteRT.js** (`@litertjs/core` 2.6.0, Apache-2.0, Google's TFLite for the web). It loads `.tflite`
  files directly (no conversion), with XNNPACK on wasm (single-threaded, threaded and JSPI builds) and a WebGPU
  delegate. ONNX Runtime Web was not prototyped: it needs a tflite → ONNX conversion (tf2onnx, a TensorFlow
  install), and its CPU path is the same XNNPACK; it stays the fallback if LiteRT.js disappoints on devices.
- Our own pipeline (`apps/playground/src/spikes/runtime/`): the geometry MediaPipe's graph does around the models
  (SSD anchors and box decoding, weighted NMS, rotated square ROI from the eyes, ROI tracked from the previous
  frame's landmarks so the detector only runs when the face is lost, rotated crop on a 2D canvas or, with
  `crop=gpu`, on WebGL2 (`gpu-crop.ts`: only the 256×256 crop is read back), projection back to frame pixels).
  About 550 lines with the page.
- Page `/spikes/runtime.html`: LiteRT.js (`threads=N`, `accel=webgpu`, `crop=gpu`, `schedule=eager`) or MediaPipe
  (`runtime=mediapipe`) on the same clip, same performance panel and export, a **tracking rate** (`track Hz`:
  completed runs per second, apart from the rendering frame rate) and a **Check vs MediaPipe** button that runs both
  on one paused frame and draws both sets of points.

Two LiteRT.js quirks found on the way, both handled in the spike:

- the landmark model declares a dynamic batch (`[-1, 256, 256, 3]`) and LiteRT.js refuses any input tensor that
  does not match the declared shape exactly: the signature is rewritten to a batch of 1 in the model bytes at load
  time;
- on WebGPU, reading an output back fails ("Asyncify is not defined") unless the JSPI build is loaded, and the
  blendshapes model is only partly supported by the GPU delegate (59 of 182 operations fall back to wasm, which
  also needs JSPI). JSPI ships in Chrome 137+; check other browsers before relying on it (the page says when it is
  missing).

## Correctness

Check vs MediaPipe (IMAGE mode, CPU) on `pesquet-talk` and `pesquet-closeup`, desktop: mean landmark distance
**1.8–2.5 % of the face size** on frontal frames (max 5–8 %), up to ≈ 5 % on strong profiles where MediaPipe's
own detector-based ROI and our tracked ROI differ most. The points overlap visually. Blendshapes: mean |Δ| 0.02–0.05,
worst single score 0.1–0.35 (brows, squint); the blendshapes model is sensitive to small landmark differences, to be
checked visually with expressions on the playground before relying on it. In profile, MediaPipe IMAGE mode sometimes
finds no face where our ROI tracking keeps it.

## Results (desktop, preliminary)

Headless Chromium on Linux, **4 cores, no GPU** (WebGL and WebGPU are software: SwiftShader), clip
`pesquet-closeup` (720×1280, 30 fps), 20 s per run, one face. `pipeline` = frame → result, ms.

| Variant | pipeline p50 / p95 | detector (when it runs) | crop | landmarks | blendshapes | results/s (clip: 30) |
|---|---|---|---|---|---|---|
| MediaPipe GPU (software WebGL) | 67.4 / 92.6 | | | | | 10 |
| MediaPipe CPU | 35.7 / 44.7 | | | | | 15 |
| MediaPipe CPU, `blendshapes=0` | 35.6 / 47.3 | | | | | 15 |
| LiteRT.js wasm, 1 thread | **19.4** / 27.0 | 8.7 | 4.0 | 12.9 | 2.3 | 30 |
| LiteRT.js wasm, 1 thread, not isolated (`coi=0`) | 20.3 / 28.7 | 9.8 | 4.2 | 13.5 | 2.4 | 30 |
| LiteRT.js wasm, 2 threads | 14.4 / 18.4 | 7.6 | 3.9 | 8.4 | 1.9 | 30 |
| LiteRT.js wasm, 4 threads | **12.4** / 16.6 | 7.8 | 4.0 | 6.6 | 1.7 | 30 |
| LiteRT.js wasm, 4 threads, `blendshapes=0` | 11.7 / 14.9 | 7.5 | 3.9 | 7.7 | — | 30 |
| LiteRT.js wasm, 4 threads, `detect=always` | 15.8 / 21.0 | 7.3 | 1.1 | 5.6 | 1.7 | 30 |
| LiteRT.js WebGPU (software Vulkan) | 166 / 200 | 49 | 4.3 | 119 | 44 | 5 |

Reading:

- **Same models, single thread, half the time**: LiteRT.js on one thread does the whole face pipeline in ≈ 19 ms where
  MediaPipe CPU takes ≈ 36 ms. The spike does not isolate where MediaPipe loses the difference (its graph overhead:
  image conversions, smoothing, the geometry pipeline for the transformation matrix; or an older XNNPACK in its
  build); what matters is that the gain needs **no cross-origin isolation** (`coi=0`: same figures).
- **Threads** add a further 35 % (2 threads) to 55 % (4 threads) on the landmark model, the dominant cost.
  Crop (4 ms, canvas readback and float conversion) and detector (rare, ≈ 8 ms) do not scale with threads.
- `blendshapes=0` saves ≈ 2 ms here (and nothing measurable inside MediaPipe CPU).
- WebGPU numbers here only prove that the path works (software Vulkan); real GPUs decide (R7 on devices). The
  readback of each output (`read`) is a GPU sync point per model and would dominate on slow GPUs.
- If the phone keeps the same ratio, 75–100 ms with MediaPipe would become ≈ 40–50 ms single-threaded and
  ≈ 25–30 ms with 4 threads: the 20–30 Hz the phone needs. To be confirmed (R3, R5).

## Results (Redmi Note 11S)

`2201117SY`: Helio G96 (MT6781, 2× Cortex-A76 + 6× Cortex-A55), Mali-G57 MC2, Android, Chrome 157, 2026-11-21.
Not the full R1–R9 protocol yet: 2–15 s windows, one session, battery temperature 31 → 35 °C. Tracking rate =
completed runs per second; when every frame is analysed (`dropped` = 0) it equals the rendering frame rate.

**Front camera** (720×1280), measured by hand:

| Variant | tracking | pipeline p50 / p95 | crop | landmarks | blendshapes |
|---|---|---|---|---|---|
| MediaPipe GPU | 7.1 Hz | 133.6 / 157.7 | | | |
| MediaPipe CPU | 11.5 Hz | 67.5 / 80.1 | | | |
| LiteRT.js wasm, 4 threads (2 runs) | 10.3–11.3 Hz | 85.0–93.1 | 37.8–44.9 | 39.4–41.1 | 7.6–8.1 |
| LiteRT.js WebGPU | ≈ 6 Hz (2 frames in 3 dropped) | 142.7 / 249.9 | 49.8 | 61.0 | 19.6 |
| LiteRT.js wasm, 4 threads, `crop=gpu` | 16.5 Hz | 57.4 / 66.5 | **14.4** | 36.0 | 6.7 |
| … `crop=gpu&blendshapes=0` | ≈ 17 Hz | 50.5 / 69.6 | 14.6 | 35.6 | — |
| … 1 thread, `crop=gpu&blendshapes=0` | ≈ 17 Hz | 49.5 / 66.9 | 13.2 | 35.5 | — |

**Clip `pesquet-closeup`** (720×1280, 30 fps), Chrome driven over USB (DevTools protocol), 15 s per variant:

| Variant | tracking | pipeline p50 | crop | landmarks |
|---|---|---|---|---|
| MediaPipe GPU | 4.8 Hz | 173 | | |
| MediaPipe CPU | 7.5 Hz | 102 | | |
| LiteRT.js wasm, 4 threads | 11.2 Hz | 85 | 35.3 | 39.0 |
| LiteRT.js wasm, 4 threads, `crop=gpu` (4 runs) | **14.7–16.9 Hz** | 53–63 | 19.7–29.0 | 23.8–32.4 |
| … `crop=gpu&blendshapes=0` | **19.3 Hz** | 44.5 | 20.4 | 23.4 |
| LiteRT.js wasm, 1 thread, `crop=gpu` | 11.2 Hz | 83 | 30.4 | 45.4 |
| any of the above with `schedule=eager` | 14–22 Hz | 42–71 | | 20–35 |

With `schedule=eager`, rendering drops to ≈ 1 fps (see below). The WebGPU readback (`read`) alone is 48.9 ms.

Reading:

- **The canvas crop was half the pipeline on the phone** (38–45 ms against 4 ms on desktop): with
  `willReadFrequently` the canvas lives on the CPU, so `drawImage(video)` pulls the whole 720×1280 frame back from
  the GPU and resamples it in software. The WebGL2 crop reads back only the 256×256 crop: 13–29 ms (the readback
  waits for the GPU, plus the float conversion). It gives the same landmarks as the canvas crop against MediaPipe
  (0.6 % and 1.2 % mean distance of the face size on two clip frames, desktop).
- **LiteRT.js with `crop=gpu` is ≈ 1.6–1.9× MediaPipe CPU** with 4 threads (pipeline 53–63 ms against 102 ms on the
  clip), and ≈ 1.2–1.4× on a single thread (83 against 102 ms on the clip; 49.5 ms without blendshapes against
  67.5 ms on the camera). The single-threaded lead is below the ≥ 1.5× set in the recommendation: on this phone,
  most of the gain needs threads, hence cross-origin isolation.
- **Threads**: 4 threads beat 1 on the clip (≈ 15.5 Hz against 11.2 Hz), not in the hand-measured camera runs
  (landmarks 35.6 against 35.5 ms). Run-to-run variance is large: the landmark model's p50 ranges from 20 to 57 ms
  for the same variant, probably which core (A76 or A55) the work lands on, and heat. Decisions on threads need
  5-minute recordings.
- **Both GPU paths are ≈ 2× slower than CPU** on this Mali-G57: MediaPipe GPU, and LiteRT.js WebGPU (slower
  inference plus ≈ 49 ms of output readback). WebGPU is not worth it here; the backend has to be chosen by
  measuring (#90).
- **Tracking snaps to display ticks**: runs start on frame callbacks, which come on 16.7 ms ticks, so a sequential
  pipeline settles on 1000 / (16.7 n) Hz: 50 ms → 20 Hz, 66.7 ms → 15 Hz.
- **`schedule=eager`** (next run as soon as one ends, on the latest frame) lifts tracking to 20–22 Hz when the
  pipeline is ≈ 42–50 ms, but **starves rendering on the main thread** (≈ 1 fps), even when yielding one rendering
  step between runs: a LiteRT.js run keeps the main thread busy throughout, not only during the crop. The gain
  needs the pipeline in a worker (#6).
- Against the device adaptation rules of #90 (15 Hz floor, shown again above 18 Hz): LiteRT.js 4 threads with
  `crop=gpu` sits at ≈ 15–17 Hz with blendshapes and ≈ 19 Hz without. The filter is shown, and dropping
  blendshapes, the first optional capability, gives the margin. MediaPipe (≤ 11.5 Hz) is below the floor on this phone.

## What our own pipeline would need (cost estimate)

Already in the spike: detection and decoding, NMS, detection → ROI, ROI tracking from landmarks, crop/warp, landmark
projection, blendshapes input. Missing for production:

| Piece | Effort | Notes |
|---|---|---|
| Multi-face (`maxFaces` > 1) | S–M | one ROI per face, detector when fewer faces than `maxFaces` are tracked (MediaPipe's policy), batch or loop the landmark model |
| Facial transformation matrix | M | MediaPipe's geometry pipeline (`geometry_pipeline_metadata_landmarks.binarypb`: canonical face mesh and Procrustes weights, also in the `.task`); a weighted Procrustes fit, ≈ 200 lines |
| Landmark / ROI smoothing | S | MediaPipe smooths the ROI between frames; #13 (anchors, smoothing) does landmark filtering on our side anyway |
| Crop on the GPU | S | done for the landmark crop (`crop=gpu`, WebGL2, decisive on the phone); the detector's letterbox still goes through the canvas (38–58 ms on the phone when the face is lost) |
| Worker | S–M | the pipeline is already asynchronous; runs in the #6 worker (OffscreenCanvas / WebGL2 crop). Needed on the phone: a run keeps the main thread busy, so rendering and tracking cannot be decoupled on the main thread (`schedule=eager`) |
| Tests | M | golden landmarks on the test clips (#77) against MediaPipe, unit tests for the geometry |
| Payload | — | LiteRT.js wasm ≈ 11 MB (3.1 MB gzip) per build, vs 14.7 MB (4.2 MB gzip) for MediaPipe's vision wasm; only one LiteRT build is downloaded (chosen at load) |

Rough total: two to three weeks to replace MediaPipe tasks-vision behind the same interface, then the maintenance
of ≈ 1000 lines of geometry that MediaPipe used to own (models and their I/O layout are versioned with the `.task`
file, which is pinned by SHA-256).

## `FaceTracker` interface

Unchanged either way. `detect()` is synchronous and LiteRT.js runs are asynchronous, so a LiteRT tracker writes
the latest completed result into `out` and starts the next run, exactly like the worker variant of #6 (results one
frame behind at most, frames skipped while a run is in flight). The delegate field maps to `CPU` (wasm) or `GPU`
(WebGPU).

## Cross-origin isolation (COOP/COEP) for host pages

Wasm threads need `SharedArrayBuffer`, i.e. a **cross-origin isolated** page: `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) on the top-level document.
For a library embedded in other people's pages this is the host's decision, not ours:

- every cross-origin subresource of the host page must send CORP or CORS headers (`require-corp`), or is loaded
  without credentials (`credentialless`, Chrome 96+ and Firefox 119+; check Safari): ads, analytics, third-party
  images and fonts can break;
- `same-origin` COOP cuts `window.opener` with cross-origin popups: OAuth and payment popups that talk back to the
  opener break;
- inside an iframe (H5P #59, LMS, CMS embeds), isolation requires the **whole frame tree** to be isolated plus
  `allow="cross-origin-isolated"` on the iframe: in practice unavailable to an embedded filter;
- the playground can isolate only the pages that need it (done here with per-path headers in `vite.config.ts`).

Consequence: threads must be an **opt-in bonus**. The engine detects `crossOriginIsolated` and loads the threaded
build when it is true, the single-threaded build otherwise. The single-threaded build still beats MediaPipe (≈ 2×
on desktop, ≈ 1.2–1.4× on the Redmi Note 11S with `crop=gpu`), so the default case does not depend on isolation;
on that phone, though, isolation is worth ≈ 1.3–1.5× more and decides whether the 15 Hz floor of #90 is met.

## Recommendation (pending device runs)

1. Run R1–R9 on an iPhone and a high-end Android phone, and 5-minute recordings on the Redmi Note 11S. The Redmi
   confirms a lead with the crop on the GPU: ≈ 1.6–1.9× with 4 threads, but only ≈ 1.2–1.4× single-threaded, below
   the ≥ 1.5× aimed at. If the other devices keep a clear lead, **move face tracking to our own pipeline on
   LiteRT.js**, behind the unchanged `FaceTracker`. Crop on the GPU, threads when the host page is cross-origin
   isolated, and WebGPU only where it measures faster than wasm: not on the Redmi (JSPI required, Chrome only for
   now).
2. Keep MediaPipe tasks-vision as the fallback implementation until the transformation matrix, multi-face and the
   golden tests are in place.
3. If the phones do not confirm the gain, keep MediaPipe tasks-vision and close this path; the spike page stays as
   the benchmark for future LiteRT.js or MediaPipe releases.
