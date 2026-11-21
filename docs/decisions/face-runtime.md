# Face tracking runtime: MediaPipe tasks-vision or our own pipeline on LiteRT.js (#83)

Status: **proposed**. The desktop numbers below are clear-cut; the decision is final once the Redmi Note 11S (and
an iPhone) have run the R1–R9 protocol in [`phase0-measurement-protocol.md`](phase0-measurement-protocol.md#83--face-models-on-another-runtime).

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
  frame's landmarks so the detector only runs when the face is lost, rotated crop on a 2D canvas, projection back
  to frame pixels). About 450 lines with the page.
- Page `/spikes/runtime.html`: LiteRT.js (`threads=N`, `accel=webgpu`) or MediaPipe (`runtime=mediapipe`) on the
  same clip, same performance panel and export, and a **Check vs MediaPipe** button that runs both on one paused
  frame and draws both sets of points.

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

## What our own pipeline would need (cost estimate)

Already in the spike: detection and decoding, NMS, detection → ROI, ROI tracking from landmarks, crop/warp, landmark
projection, blendshapes input. Missing for production:

| Piece | Effort | Notes |
|---|---|---|
| Multi-face (`maxFaces` > 1) | S–M | one ROI per face, detector when fewer faces than `maxFaces` are tracked (MediaPipe's policy), batch or loop the landmark model |
| Facial transformation matrix | M | MediaPipe's geometry pipeline (`geometry_pipeline_metadata_landmarks.binarypb`: canonical face mesh and Procrustes weights, also in the `.task`); a weighted Procrustes fit, ≈ 200 lines |
| Landmark / ROI smoothing | S | MediaPipe smooths the ROI between frames; #13 (anchors, smoothing) does landmark filtering on our side anyway |
| Crop on the GPU | M | the 4 ms canvas readback is the next cost after inference; a WebGL/WebGPU crop feeding a GPU tensor (WebGPU) or a smaller readback (wasm) |
| Worker | S | the pipeline is already asynchronous; runs in the #6 worker unchanged (OffscreenCanvas crop) |
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
build when it is true, the single-threaded build otherwise. The single-threaded build already beats MediaPipe, so
the default case does not depend on isolation.

## Recommendation (pending device runs)

1. Run R1–R9 on the Redmi Note 11S and an iPhone. If LiteRT.js single-threaded keeps a clear lead there (≥ 1.5×),
   **move face tracking to our own pipeline on LiteRT.js**, behind the unchanged `FaceTracker`, with threads when
   the host page is cross-origin isolated and WebGPU only if R7 beats wasm on phones (JSPI required, Chrome only for
   now).
2. Keep MediaPipe tasks-vision as the fallback implementation until the transformation matrix, multi-face and the
   golden tests are in place.
3. If the phones do not confirm the gain, keep MediaPipe tasks-vision and close this path; the spike page stays as
   the benchmark for future LiteRT.js or MediaPipe releases.
