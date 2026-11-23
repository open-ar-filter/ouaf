# Face tracking runtime: MediaPipe tasks-vision or our own pipeline on LiteRT.js (#83)

Status: **accepted for mid-range Android, provisional elsewhere** (2026-11-21). Two mid-range Android phones (Redmi
Note 11S, Redmi Note 14 Pro 5G) ran the W runs of the
[protocol](phase0-measurement-protocol.md#83--face-models-on-another-runtime): our own pipeline on LiteRT.js, **in a
worker, single-threaded, crops on the GPU**, tracks at ≈ 15–18 Hz while the page keeps rendering at 29 fps, against
≈ 8–10 Hz for MediaPipe tasks-vision. An iPhone and a high-end Android phone still have to confirm it (#95).
**In the engine** since #165, one face for now: see [In the engine](#in-the-engine-165).

## In the engine (#165)

`@ouaf/core` runs the pipeline of this spike in production form (`packages/core/src/litert/`): `face.worker.ts` (the
worker: LiteRT.js single-threaded wasm, WebGL2 crops on an `OffscreenCanvas` with a 2D-canvas fallback, the geometry
of `geometry.ts`), `tracker.ts` (page side: `VideoFrame` transfer, `ImageBitmap` where missing, result buffers
transferred back and forth, the transformation matrix fitted to the landmarks with `estimateFacePose`, MediaPipe's
geometry pipeline). The built-in tracker (`defaultFaceTracker`, `engine/builtin.ts`) chooses between it and MediaPipe's
GPU and CPU delegates by measuring them ([`device-adaptation.md`](device-adaptation.md#backend-benchmark-spec-164)).

- **Eager scheduling** (`FrameTracker.eager`, `TrackingHub`): a live frame that comes while the worker is busy is
  submitted as soon as the result arrives. Without it a run that spans a frame tick misses it: 15.8 Hz on the desktop
  below, 28 Hz with it.
- **A frame queued in the worker** (`FrameTracker.offer`): that frame is also posted at once, and the worker starts
  it as soon as its run ends (one frame waiting at most; a newer one replaces it). Without it the worker waited for
  its result to reach the page and the next frame to come back: ≈ 25–30 ms on a busy main thread (desktop, main thread
  throttled 4× over CDP: 13–14.5 Hz without the queue, 15–16.4 Hz with it). The next call takes that frame's result.
- **Camera frames read in the worker** (`frames: 'track'`, default): from the camera's track through a
  `MediaStreamTrackProcessor` whose stream is transferred to the worker, where it exists (Chromium) and the frames
  match the `<video>` (same size, no rotation metadata; otherwise back to the `<video>` with a warning). Why: turning
  a `<video>`'s frame into a texture in the worker (`texImage2D(VideoFrame)`) waits for the page's main thread: for a
  hardware-decoded clip, 17 ms on an idle desktop, 55–63 ms with the main thread throttled 4× (the readback after it:
  2 ms). With Chromium's fake camera both paths upload in ≈ 1 ms and track at 30 Hz even throttled 4×: what the
  phone's camera costs is to be measured (`?frames=element` compares).
- **Per-step timings** (`FrameTracker.timings`, `EngineStats.trackerTimings`, `pipelineMs`, a line of the engine
  page's panel): capture, hand-off to the worker, queue, worker idle, run (detect, upload, crop, landmarks,
  blendshapes), hand-off back, result, total; and the period (1000 / Hz) against the pipeline time.
- **Redmi Note 11S with these timings** (camera, `glasses`, blendshapes dropped; battery at 3 %, display 14–16 fps, so
  absolute numbers are pessimistic): 13.2–15.2 Hz, period 66–76 ms = the worker's run, 56–73 ms: crop 14.5–23 ms
  (upload 0.1–0.2 ms: the readback waits for the GPU) and landmarks 38–50 ms; blendshapes 6.8 ms when on. 2D-canvas
  crops are slower (crop 38–41 ms); the camera track and the `<video>`'s `VideoFrame` give the same rate.
- **Async readback** (`readback: 'async'`, `?readback=async`, opt-in until the phone confirms it): the crop of
  frame N is read back into a pixel buffer (PBO and fence) while the landmark model runs on frame N − 1, so that the
  worker does not wait for the GPU. Results are one frame late (the worker says which frame a result describes, and
  the page gives its media time), and frame N's ROI is extrapolated from the two previous results. On the desktop the
  readback is 1–2 ms and the time is in the frame's upload (`texImage2D(VideoFrame)` 47–60 ms for a clip, ≈ 22 ms for
  the fake camera, main thread throttled 4×), which it does not hide.
- **Loading LiteRT.js in a module worker**: one shim left of the three. Its loader runs the Emscripten script with
  `importScripts`, which throws in module workers: the worker fetches the script (the build LiteRT.js would pick) and
  replaces `importScripts` during the load by an indirect `eval` of it; `Module.locateFile` (Emscripten's own hook)
  points at the `.wasm`. No pthreads, so no `Worker` wrapper. A classic worker would need no shim, but bundlers
  (Vite in dev) only serve module workers with imports.
- **One face**: with `maxFaces` > 1 only MediaPipe is a candidate (multi-face is the next step of #165).
- Blendshapes are skipped while the engine does not want them (governor, spec §16.2; checked by a browser test: the
  model's time falls to 0); the analysis resolution is ignored (crops come from the full frame on the GPU), so the
  tracker tells the governor not to drop it (`FrameTracker.sheds`).
- LiteRT.js logs "Failed to create default WebGPU device" in the worker where there is no WebGPU adapter: its
  environment always tries one; harmless.

Desktop (headless Chromium 159, Linux, NVIDIA RTX 5080 laptop, clip `pesquet-closeup` / `pesquet-talk`, 2026-11-23):

| | per result (ms, median) | tracking (engine) | main-thread tracking per frame |
|---|---|---|---|
| LiteRT.js worker, WebGL2 crops (crop 9, landmarks 6–9, blendshapes 1.2) | 16.6 standalone, 20–33 in the engine | 26–28 Hz | 0.01 ms |
| … without eager scheduling | | 15.8 Hz | 0.02 ms |
| … 2D-canvas crops | | 29 Hz | 0.04 ms |
| MediaPipe CPU | 17–20 | | 17–20 ms |
| MediaPipe GPU | 43–52 | | 43–52 ms |

Same results as MediaPipe (`e2e/litert-tracker.spec.ts`, every third frame of four clips, VIDEO mode): median
landmark distance 0.6–1.2 % of the face size (90th percentile 1.0–2.5 %), blendshapes 0.01–0.02 mean |Δ|, the matrix
within 1.1–1.8° and 0.5–0.9 cm (median), and both find a face on 90–100 % of the same frames. `estimateFacePose` on
MediaPipe's own landmarks gives MediaPipe's matrix exactly (≤ 0.01 cm).

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
  `crop=gpu`, on WebGL2 (`gpu-crop.ts`: one frame upload per run, only the 256×256 crop and the 128×128 detector
  letterbox are read back), projection back to frame pixels). About 550 lines with the page.
- A worker variant (`mode=worker`, `litert.worker.ts`, ≈ 370 lines with the page side and the messages): the whole
  pipeline runs in a dedicated worker, crops on an OffscreenCanvas there, frames transferred as `VideoFrame` (or
  `ImageBitmap`) with a result buffer, as in #6. LiteRT.js's threaded build works from a worker: the worker script is served with the
  same COEP header as the page, so `crossOriginIsolated` holds inside it, and the pthreads are nested workers. Three
  shims are needed for LiteRT.js 2.6.0's loader in a module worker (`importScripts` replaced by a synchronous fetch
  evaluated globally, `Module.locateFile` for the `.wasm`, and `Worker` wrapped so that the pthreads load the
  Emscripten script rather than the worker's own). Fallbacks, each with a visible warning: one thread when the
  worker is not isolated, canvas crops without WebGL2 on OffscreenCanvas, main thread when the worker cannot start.
- Page `/spikes/runtime.html`: LiteRT.js (`threads=N`, `accel=webgpu`, `crop=gpu`, `detcrop`, `mode=worker`,
  `schedule=eager`) or MediaPipe (`runtime=mediapipe`) on the same clip, same performance panel and export, a
  **tracking rate** (`track Hz`: completed runs per second, apart from the rendering frame rate), latency and result
  age, and a **Check vs MediaPipe** button that runs both on one paused frame and draws both sets of points.

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

## Results (desktop, GPU detector crop and worker)

Desktop check of the two follow-ups of the Redmi runs, before the phone runs (W1–W10 of the protocol). Headless
Chromium 159 (Playwright) on Linux, Intel Core Ultra 9 275HX (24 cores), **hardware WebGL** (ANGLE on OpenGL, Intel
Arrow Lake iGPU), clip `pesquet-closeup` (720×1280, 30 fps), 15 s per variant after 3 s of warm-up, 2026-11-21.
p50 / p95 in ms; `main` = main-thread tracking time per frame (`track` in the overlay); `age` = age of the landmarks
drawn.

| Variant | track Hz | display fps | pipeline | dcrop | crop | lmk | bs | main | xfer | latency | age |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ×4, canvas crops (main thread) | 29.9 | 29.9 | 11.0 / 15.5 | 6.6 | 6.8 | 3.4 | 0.8 | 7.1 | | 11.5 | 33 |
| ×4, `crop=gpu&detcrop=canvas` (W1) | 29.9 | 29.9 | 9.0 / 12.7 | 6.6 | 3.4 | 4.5 | 0.9 | 3.5 | | 9.6 | 33 |
| ×4, `crop=gpu` (W2) | 29.9 | 29.9 | 8.6 / 12.5 | 2.5 | 3.2 | 4.4 | 0.8 | 3.3 | | 9.3 | 33 |
| … `schedule=eager` (W10) | 29.9 | 29.9 | 8.8 / 12.8 | 3.2 | 3.0 | 4.6 | 0.8 | 3.1 | | 9.3 | 33 |
| … `mode=worker` (W5) | 29.9 | 29.9 | 9.1 / 12.9 | 3.5 | 3.9 | 3.9 | 0.9 | **0.0** | 0.4 | 9.6 | 33 |
| … `mode=worker&transfer=bitmap` | 29.7 | 29.8 | 9.8 / 13.3 | 3.6 | 3.8 | 4.0 | 0.8 | 0.5 | 0.9 | 10.4 | 33 |
| … `mode=worker&schedule=eager` (W6) | 29.8 | 29.8 | 9.9 / 13.5 | 4.0 | 4.1 | 4.3 | 0.8 | **0.0** | 0.4 | 10.4 | 33 |
| ×1, `crop=gpu` (main thread) | 29.8 | 29.8 | 17.0 / 20.9 | 2.4 | 2.9 | 12.1 | 1.5 | 3.1 | | 17.6 | 33 |
| ×1, `crop=gpu&mode=worker` | **26.5** (11 % dropped) | 29.9 | 13.3 / 18.6 | 3.5 | 3.9 | 7.2 | 1.1 | 0.0 | 0.4 | 14.0 | 50 |
| ×1, `crop=gpu&mode=worker&schedule=eager` (W8) | **29.9** | 29.9 | 12.8 / 16.6 | 3.1 | 3.9 | 7.1 | 1.2 | 0.0 | 0.3 | 13.6 | 50 |
| ×4, `crop=gpu&detcrop=canvas&detect=always` (W3) | 29.9 | 29.9 | 14.6 / 18.7 | **6.3** / 8.1 | 2.6 | 3.1 | 0.8 | 6.3 | | 15.6 | 33 |
| ×4, `crop=gpu&detect=always` (W4) | 29.9 | 29.9 | 10.9 / 15.0 | **2.6** / 3.5 | 2.0 | 3.5 | 0.8 | 2.6 | | 11.5 | 33 |
| … `mode=worker&schedule=eager` | 29.9 | 29.9 | 11.3 / 15.7 | 3.4 / 4.3 | 1.5 | 3.5 | 0.8 | 0.1 | 0.4 | 12.0 | 33 |

Reading:

- **Correctness.** The WebGL2 letterbox gives the same detector ROI as the canvas one (≤ 0.4 px of centre, ≤ 1.4 px
  of size for a 420–515 px ROI; ≤ 3 px / 5 px with SwiftShader) and the same landmarks (≤ 0.1 % of the ROI) on
  `pesquet-talk`. One bilinear tap per pixel is what the canvas does: averaging 4² taps moved the ROI rotation by up
  to 0.15 rad on a hard frame, so the letterbox keeps one tap. The worker gives **identical** landmarks to the main
  thread on frontal frames (0.000 %), with `VideoFrame` and with `ImageBitmap`; Check vs MediaPipe reads the same
  (0.6 % and 1.6–1.8 % mean of the face size at 2 s and 4 s of `pesquet-talk`, main thread and worker). Covered by
  `e2e/runtime-worker.spec.ts`.
- **Detector crop on the GPU: 6.3 → 2.6 ms** on every frame here (`detect=always`), the detector stage 7.8 → 4.6 ms.
  The phone's canvas letterbox cost 38–58 ms, the same software path as the landmark crop before `crop=gpu` (whose
  cost fell from ≈ 40 to ≈ 14 ms there); the GPU version should bring a lost face back several frames sooner.
- **Threads in the worker work**: 4 threads in the worker start the same 9 pthreads (3 models × 3) as on the main
  thread and the landmark model runs at the main thread's speed (3.9 against 4.4 ms; 7.1 ms on one thread).
- **Main-thread cost drops to ≈ 0** (capture + post + result handling: < 0.1 ms with `VideoFrame`, 0.5 ms with
  `ImageBitmap`), against 2.6–7.1 ms per frame on the main thread (the synchronous part of a run: crops and their
  float conversion). The transfer round trip (`xfer`) costs 0.3–0.4 ms with `VideoFrame`, 0.9 ms with `ImageBitmap`.
- **Tick alignment shows up even here.** Frame callbacks of a 30 fps clip come every 16.7 or 50 ms rather than
  every 33 ms (vsync jitter: 41 of 89 intervals at 16.7 ms in worker mode). With `schedule=frame` a run that lasts
  more than 16.7 ms then misses the next frame: one thread in the worker (13.3 ms p50, 18.6 p95) analyses only
  26.5 frames per second. `schedule=eager` in the worker starts the pending frame as soon as the run ends and
  tracks every frame (29.9 Hz), with the main thread still free. This is the gain the phone needs (20–22 Hz
  measured with eager runs on the main thread, which then rendered at ≈ 1 fps).
- What the desktop cannot show: every variant tracks the 30 fps clip at its full rate, so the rendering/tracking
  decoupling has to be measured on the phone (W5–W10). Results are one frame old when drawn (`age` 33 ms: the result
  of frame N is drawn with frame N+1), 50 ms when a run spans a tick.

## Results (phones: worker, GPU detector crop, threads)

Raw exports: [`data/83-face-runtime/`](data/83-face-runtime/) (one JSON per run, named after the run id). Driven over
USB (raw CDP), clip `pesquet-closeup`, 1 min per run after 5 s of warm-up unless noted, 2026-11-21, battery
36–38 °C. p50 in ms; `lmk` = landmarks model, `bs` = blendshapes model; tracking = completed runs per second,
display = rendered frames per second.

**Redmi Note 14 Pro 5G** (`24090RA29G`: Dimensity 7300, 4× Cortex-A78 + 4× Cortex-A55, Mali-G615 MC2, Chrome 157):

| Run | Variant | tracking | display | pipeline | lmk | bs |
|---|---|---|---|---|---|---|
| R1 | MediaPipe GPU | 9.3 Hz | 9.3 | 80 | | |
| R2 | MediaPipe CPU | 10.3 Hz | 10.3 | 68 | | |
| R3 | LiteRT ×1, `crop=gpu` | 17.2 Hz | 17.2 | 52 | 34 | 5.7 |
| R5 | LiteRT ×4, `crop=gpu` | 18.3 Hz | 18.2 | 49 | 19 | 15 |
| R6 | LiteRT ×6, `crop=gpu` | 14.8 Hz | 14.7 | 64 | 38 | 9.4 |
| R7 | LiteRT WebGPU | 7.4 Hz | 23.5 | 122 | 58 | 31 (read 51) |
| W1 | ×4, `crop=gpu&detcrop=canvas` | 16.6 Hz | 16.5 | 54 | 22 | 16 |
| W2 | ×4, `crop=gpu` | 24.9 Hz | 24.9 | 32 | 19 | 4.8 |
| W3 | ×4, `detcrop=canvas&detect=always` | 10.9 Hz | 10.9 | 85 | 14 | 16 |
| W4 | ×4, `detect=always` | 13.0 Hz | 13.0 | 72 | 17 | 13 |
| W5 | ×4, worker | 9.3 Hz | 29.2 | 81 | 40 | 21 |
| W6 | ×4, worker, eager | 13.1 Hz | 29.3 | 74 | 37 | 21 |
| W7 | ×4, worker, eager, no blendshapes | 22.0 Hz | 29.4 | 42 | 25 | |
| W8 | **×1, worker, eager** | **18.4 Hz** | **29.5** | 53 | 31 | 5.8 |
| W9 | ×4, worker, eager, `transfer=bitmap` | 12.6 Hz | 29.5 | 78 | 36 | 19 |
| W10 | ×4, main thread, eager | 22.8 Hz | **1.8** | 44 | 16 | 13 |

**Redmi Note 11S** (device described in the Redmi Note 11S section above):

| Run | Variant | tracking | display | pipeline | lmk | bs |
|---|---|---|---|---|---|---|
| W2 | ×4, `crop=gpu` (main thread) | 13.3 Hz | 13.3 | 69 | 38 | 6.3 |
| W5 | ×4, worker | 11.4 Hz | 29.0 | 65 | 24 | 4.4 |
| W6 | ×4, worker, eager | 16.4 Hz | 29.0 | 59 | 24 | 4.6 |
| W7 | ×4, worker, eager, no blendshapes | 16.6 Hz | 29.0 | 56 | 25 | |
| W8 | ×1, worker, eager | 14.3 Hz | 29.1 | 67 | 33 | 5.7 |
| W6, 5 min | ×4, worker, eager | **8.8 Hz** | 29.2 | 113 | 70 | 15 |
| W8, 5 min | **×1, worker, eager** | **14.6 Hz** | 29.1 | 68 | 32 | 5.6 |
| W8, 10 min | ×1, worker, eager | 13.8 Hz (14.1 → 13.4 Hz minute by minute) | 29.0 | 67 | 36 | 6.0 |

Reading:

- **The worker decouples rendering from tracking on both phones**: 29 fps on screen whatever the tracking rate, and
  ≈ 0 ms of tracking work on the main thread. Eager scheduling on the main thread instead (W10) tracks fast but
  renders at 1.8 fps. Results drawn are ≈ 100–130 ms old (`age`), against 50–60 ms on the main thread: the cost of
  not blocking, to be hidden by interpolation or prediction (#13).
- **One thread beats four in the worker.** On the Note 14 Pro, W8 (×1) tracks at 18.4 Hz against 13.1 Hz for W6
  (×4): with 4 threads, landmarks and blendshapes run ≈ 2× slower in the worker than single-threaded, probably
  because the threads, rendering and video decoding compete for the 4 big cores. On the Note 11S, W6 leads W8 over
  one minute (16.4 against 14.3 Hz) but collapses to 8.8 Hz over 5 minutes (landmarks 24 → 70 ms), while W8 holds
  14.6 Hz. Six threads are already slower than four on the main thread (R6).
- **Sustained (10 min, Note 11S, W8)**: the display stays at 29 fps and tracking drifts by ≈ 5 % (14.1 → 13.4 Hz,
  landmarks 33 → 37 ms, battery 29 → 33 °C), with no collapse.
- **GPU detector crop**: the letterbox costs 4–6 ms less on the GPU (W3 → W4 on the Note 14 Pro, 19 → 13 ms). The
  jump from W1 to W2 (16.6 → 24.9 Hz) comes mostly from blendshapes running 3× faster in W2: run-to-run variance,
  not the crop.
- **WebGPU** stays the slowest path on both phones (output readback ≈ 50 ms).
- **Against the 15 Hz floor of #90**: the Note 14 Pro is above it with blendshapes (18.4 Hz); the Note 11S sits just
  below (14.6 Hz) and needs blendshapes dropped, the first optional capability. MediaPipe is below the floor on
  both phones.
- Variance is large between runs and sessions (the same variant moves by ±30 % across sessions on the Note 11S,
  and MediaPipe's GPU delegate on that phone measured 2–3× slower in the afternoon than in the morning, see
  [`multi-face.md`](multi-face.md)). The decision rests on the 5-minute runs and on the effects that hold on both
  phones.

## What our own pipeline would need (cost estimate)

Already in the spike: detection and decoding, NMS, detection → ROI, ROI tracking from landmarks, crop/warp, landmark
projection, blendshapes input. Missing for production:

| Piece | Effort | Notes |
|---|---|---|
| Multi-face (`maxFaces` > 1) | S–M | one ROI per face, detector when fewer faces than `maxFaces` are tracked (MediaPipe's policy), batch or loop the landmark model |
| Facial transformation matrix | M | MediaPipe's geometry pipeline (`geometry_pipeline_metadata_landmarks.binarypb`: canonical face mesh and Procrustes weights, also in the `.task`); a weighted Procrustes fit, ≈ 200 lines |
| Landmark / ROI smoothing | S | MediaPipe smooths the ROI between frames; #13 (anchors, smoothing) does landmark filtering on our side anyway |
| Crop on the GPU | — | done in the spike for both crops (`crop=gpu`: landmark crop and detector letterbox on WebGL2, decisive on the phone for the landmark crop; letterbox 6.3 → 2.6 ms on desktop, phone pending) |
| Worker | S | done in the spike (`mode=worker`): threads, WebGL2 crops and eager scheduling inside a worker, same landmarks. Left for production: LiteRT.js's loader needs three shims in a module worker (see above), to be replaced by an upstream fix or a classic worker build; `FaceTracker` integration as in #6 |
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

Consequence: threads must be an **opt-in bonus**. Where `crossOriginIsolated` is true, the startup benchmark of #90
may try the threaded build and keep it only if it measures faster; the single-threaded build is the default. The single-threaded build still beats MediaPipe (≈ 2×
on desktop, ≈ 1.2–1.4× on the Redmi Note 11S with `crop=gpu`), so the default case does not depend on isolation;
on the main thread of that phone, isolation was worth ≈ 1.3–1.5× more. In a worker it is not: a single thread
was faster than four on both phones (see the phone results above), so isolation is not needed for the floor.

## Recommendation

1. **Move face tracking to our own pipeline on LiteRT.js, in a worker**, behind the unchanged `FaceTracker`:
   single-threaded wasm (no cross-origin isolation needed, so no constraint on host pages), crops on WebGL2 in the
   worker (`OffscreenCanvas`, canvas fallback where missing: see [`webkit-compat.md`](webkit-compat.md)), eager
   scheduling, `VideoFrame` transfer (`ImageBitmap` as fallback). Threads stay an option for the startup benchmark
   of #90 to try where isolation exists, not the default: they did not win on either phone. WebGPU only if the
   benchmark measures it faster, which it was not on any device so far.
2. Keep MediaPipe tasks-vision as the fallback implementation until the transformation matrix, multi-face and the
   golden tests are in place.
3. Confirm on an iPhone and a high-end Android phone (#95). If they contradict it, the `FaceTracker` interface
   keeps MediaPipe available per device through the benchmark of #90.
