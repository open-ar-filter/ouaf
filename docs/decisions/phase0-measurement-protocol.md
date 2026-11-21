# Phase 0 measurement protocol

How to run the phase 0 spikes (#6, #7, #8, #83) on real devices so that one measurement session feeds every decision
(#9). Results and decisions go in `docs/decisions/` next to this file, raw exports in `docs/decisions/data/`.

## Devices

| Class | Device | Browser |
|---|---|---|
| Desktop | Linux laptop, Core Ultra 9 275HX, Intel iGPU (headless runs only so far) | Chrome, Firefox; WebKit as a Safari proxy ([`webkit-compat.md`](webkit-compat.md)) |
| Android mid-range | Redmi Note 11S (Helio G96), Redmi Note 14 Pro 5G (Dimensity 7300) | Chrome 157 |
| Android high-end | wanted: #95 | Chrome |
| iPhone | wanted: #95 | Safari |

Before the iPhone session: [`webkit-compat.md`](webkit-compat.md) lists what the pages do in desktop WebKit (Playwright
on Linux, a proxy for Safari, not a device result) and what remains to be checked on the iPhone.

## General rules

- `npm run fetch-models` once, then `npm run dev`; open the `Network: https://…` URL on the device.
- Index of the spike pages: `/spikes/`.
- Plug the phone in or note the battery level; close other apps; same lighting for every run (good light: low light
  halves the front camera frame rate).
- Prefer the test clips (`?source=<clip>&autostart`) over a live face: same input on every device, reproducible.
  Live-camera runs are still needed for the camera capture cost and low light.
- The live panel averages over the last 2 s: with a looping clip this window may hold the part without a face.
  Read it with `&window=10` (or longer), or rely on recordings, whose summary covers the whole run. **Copy** puts
  the live figures on the clipboard as text.
- Every run uses the performance panel: pick the duration, **Record**, keep a face in view, then **Export**. The file
  name already contains the device, the page and the URL options.
- Short runs: 1 minute. Sustained runs (thermal throttling): 10 minutes.

## #8 — Multi-face cost

Goal: choose the default `maxFaces` per device class. Decision: [`multi-face.md`](multi-face.md).

The runs use the [test clips](../../test-media/README.md) (`?source=`), so every device analyses exactly the same
faces and nobody has to stand in front of the camera; `&autostart` starts playback without a tap. 8a–8c play the same
clip (`four-faces-grid`: four faces in a 2×2 grid) and only change `maxFaces`, so the number of tracked faces is the
only difference between them.

| Run | URL | Faces tracked | Duration |
|---|---|---|---|
| 8a | `/?source=four-faces-grid&autostart&window=10&maxFaces=1` | 1 (of 4 in view) | 1 min |
| 8b | `/?source=four-faces-grid&autostart&window=10&maxFaces=2` | 2 (of 4) | 1 min |
| 8c | `/?source=four-faces-grid&autostart&window=10&maxFaces=4` | 4 | 1 min |
| 8d | `/?source=no-face&autostart&window=10&maxFaces=4` | 0 (detector cost alone) | 1 min |
| 8e | `/?source=three-faces-grid&autostart&window=10&maxFaces=4` | 3 (capacity 4) | 1 min |
| 8f | `/?source=two-faces-stacked&autostart&window=10&maxFaces=4` | 2 (capacity 4) | 1 min |
| 8g | `/?source=two-faces-stacked&autostart&window=10&maxFaces=2` | 2 (reference for 8f) | 1 min |
| 8h | `/?source=pesquet-closeup&autostart&window=10&maxFaces=1` | 1 (capacity 1) | 1 min |
| 8i | `/?source=pesquet-closeup&autostart&window=10&maxFaces=2` | 1 (capacity 2) | 1 min |
| 8j | `/?source=pesquet-closeup&autostart&window=10&maxFaces=4` | 1 (capacity 4) | 1 min |

- Then 8a–8d and 8j again with `&delegate=CPU` to compare delegates.
- `maxFaces` is a capacity: while fewer faces than `maxFaces` are tracked, MediaPipe also looks for new ones. 8a–8c
  fill the capacity (cost per tracked face), 8d is the detector alone, and 8e–8j show what a spare capacity costs
  (8f against 8g: same two faces, capacity 4 or 2; 8h–8j: one person, the usual case, under each candidate default).
- If time is short on a phone, run 8a–8d, 8h and 8j first (GPU, then CPU).
- MediaPipe only finds faces that are large enough (selfie distance): the faces of `group-far` (≈ 12 % of the frame
  width) are not detected. The faces of `four-faces-grid` are ≈ 35–40 % of the frame width; all four are found.
- Look at `trackingMs` p50/p95 and fps for each number of faces; the `faces` column of the export tells which
  samples had how many faces (the clips loop every 3.1 s and a face can be lost for a few frames at the loop point).

## #6 — Tracking in a Worker vs main thread

Goal: decide whether tracking runs in a Web Worker (MediaPipe on an `OffscreenCanvas`, frames transferred from the
page) or on the main thread with the GPU delegate. Decision: [`tracking-worker.md`](tracking-worker.md).

Page: `/spikes/worker.html` (links on `/spikes/`). Options: `mode=main|worker` (default `worker`),
`transfer=videoframe|bitmap` (worker: `new VideoFrame(video)` or `createImageBitmap(video)`, default `videoframe`),
`load=N` (N ms of synthetic main-thread work per frame: a busy host page), plus `maxFaces` (default 2) and
`delegate=CPU` as on the main page, and `source=<clip>&autostart` to play a test clip instead of the camera. The links
at the top of the page switch variant and keep the other options. Run 6a–6e on `&source=pesquet-closeup&autostart&window=10`
(same input on every device), then 6a and 6b once with the camera for the capture cost and `cameraLatencyMs`.

| Run | URL | Duration |
|---|---|---|
| 6a | `/spikes/worker.html?mode=main&maxFaces=1` | 1 min |
| 6b | `/spikes/worker.html?mode=worker&transfer=videoframe&maxFaces=1` | 1 min |
| 6c | `/spikes/worker.html?mode=worker&transfer=bitmap&maxFaces=1` | 1 min |
| 6d | `/spikes/worker.html?mode=main&maxFaces=1&load=15` | 1 min |
| 6e | `/spikes/worker.html?mode=worker&maxFaces=1&load=15` (transfer of 6b or 6c, whichever is better) | 1 min |

- One face in view, still, same light. Pick **Manual** or stop after a minute (the presets are 5 and 10 minutes).
- Before each run, check the **Tracker** row: `ready: worker, GPU, videoframe` (or `CPU` after a fallback, which is a
  result in itself) and the **Warnings** row. If 6b fails on a browser (no `VideoFrame`, or it cannot be uploaded in
  the worker), note the message and use 6c.
- Keep a run going for more than a minute once per browser: the **MediaPipe metrics** row must read `blocked …`
  (the worker is covered by the CSP header; `sent` means the metrics left the device).
- On iPhone, the worker variant needs WebGL on `OffscreenCanvas` in workers (Safari 17+); on older versions it falls
  back to CPU or fails, note which (desktop WebKit has no WebGL in workers and fails with
  `ModuleFactory not set`, see [`webkit-compat.md`](webkit-compat.md)).

What to look at (live panel, then `summary.columns` in the export; columns in `docs/perf/session-format.md`):

- **Frame rate**: `fps` (and `missed`: camera frames the page never saw because the main thread was busy).
- **Main-thread cost**: `track` = `trackingMs` (main: `detect`; worker: capture + post + receive, expected well
  under 1 ms for `videoframe`; `bitmap` adds `captureMs`). This is what the worker variant saves.
- **Main-thread availability**: `lagMs` p95/max and `longTaskMs` (Chromium only): what a host page loses to tracking.
- **Inference**: `inferenceMs` in the worker vs on the main thread (a worker may be slower: no shared GPU context,
  frame upload in the worker, contention with the page).
- **Latency**: `latencyMs` (frame → results on the main thread), `cameraLatencyMs` where available (Chromium), and
  `resultAgeMs`: in worker mode the landmarks drawn are one frame (or more) behind the video; check visually whether
  the lag is noticeable when moving the head.
- **Dropped frames**: `dropped` sum / samples = frames not tracked because the worker was busy (results are reused).
- **Busy host** (6d vs 6e): with `load=15` the main-thread variant should lose fps and accumulate `missed` frames,
  the worker variant should keep the camera rate with stale results instead.

Decision rule: the worker variant is worth its complexity if, on the phones, it keeps fps at the camera rate with
`load=15` where the main thread does not, or cuts `lagMs` p95 noticeably, without raising `latencyMs` / `resultAgeMs`
by more than about one frame.

## #7 — Shared WebGL context (GPU-side masks)

Goal: confirm (or not) that a MediaPipe segmentation mask can feed the WebGL2 renderer without any CPU readback when
both share one context, and what the WebGPU alternative costs (#7 decision). Decision: [`gl-share.md`](gl-share.md).

Page: `/spikes/gl-share.html`. Camera → ImageSegmenter (selfie segmenter, VIDEO mode, confidence mask) → three.js
render that blurs and tints the background behind the person. The panel shows, besides the usual cells, `seg`,
`xfer`, `upload` (p50/p95 ms), `rb/fr` (readbacks per frame), `mask rd/fr` and `sync/fr`; the banner turns red when
the current frame did a readback. Columns and fields of the export: see `docs/perf/session-format.md`.

| Run | URL | Duration |
|---|---|---|
| 7a | `/spikes/gl-share.html?path=shared` | 1 min |
| 7b | `/spikes/gl-share.html?path=cpu` | 1 min |
| 7c | `/spikes/gl-share.html?path=webgpu` | 1 min |
| 7d | `/spikes/gl-share.html?path=webgpu&copy=readback` | 1 min |
| 7e | `/spikes/gl-share.html?path=shared&face=shared` (bonus: face tracking in the same context) | 1 min |

- One person in view, upper body, for the whole run (the mask is meaningless without one).
- In each run: **Start camera**, **Record**, then press **Check alignment** once (its verdict is logged as a `note`
  event): it must say `top-first … (correct)` with a mean |Δ| near 0. Before 7a, open `?path=shared&view=mask` and
  `?path=cpu&view=mask` and check by eye that the pink silhouette sits on the person (move a hand to the edge).
- 7c/7d only where WebGPU exists (Chrome desktop and Android, Safari 26+); elsewhere the page says why it cannot run:
  note it. On dual-GPU laptops add `&gpu=low-power` (the WebGPU adapter on the same GPU as WebGL).
- Firefox and Safari: run 7a and 7b at least (7a is the case that has to work everywhere).
- What to compare: `rb/fr` (must be 0.00 in 7a), `pipelineMs` p50/p95 (whole frame on the main thread), fps, then
  `transferMs` / `uploadMs` per path. `segmentationMs` only covers the submission of the GPU work: in 7b the
  readback waits for it, so its cost shows up in `transferMs` there.
- If a run fails (black canvas, error in the status row), note the browser and the message; `?path=shared&reset=after`
  and `?reset=none` show what the GL state handling is for (`none` is expected to break the render).

Preliminary results, desktop only, **headless Chrome 158** on Linux (fake camera playing a 1280×720 30 fps clip made
from a public-domain NASA portrait; hardware GL through ANGLE/EGL on the integrated Intel GPU, WebGPU on the same GPU
with `gpu=low-power`), 20 s per run, p50 (ms):

| Variant | fps | pipeline p50/p95 | seg | transfer | upload | render | readbacks/frame |
|---|---|---|---|---|---|---|---|
| `shared` | 30 | 1.2 / 1.7 | 0.8 | 0.0 | — | 0.4 | 0 |
| `cpu` | 30 | 11.1 / 18.7 | 0.9 | 9.5 | 0.3 | 0.4 | 1 (3.7 MB) + 1 mask read |
| `webgpu` (canvas copy) | 30 | 11.6 / 21.4 | 0.8 | 0.0 | 10.3 | 0.5 | 0 |
| `webgpu&copy=readback` | 30 | 12.4 / 19.2 | 0.8 | 10.8 | 0.2 | 0.5 | 1 (3.7 MB) + 1 mask read |
| `shared&delegate=CPU` | 30 | 11.5 / 14.0 | 10.7 | 0.3 | — | 0.5 | 1 (3.7 MB: the video frame, read back for the CPU model) |
| `shared&face=shared` (close-up clip, 1 face) | 30 | 11.3 / 14.6 | 0.7 (+10.8 face) | 0.0 | — | 0.3 | 2 (5.8 kB: landmarks) |

These are not device numbers (headless, a desktop iGPU, the camera capping at 30 fps): the device runs above decide.

## #83 — Face models on another runtime

Goal: find out whether MediaPipe's own face models (detector, 478 landmarks, blendshapes, extracted from
`face_landmarker.task` by `npm run fetch-models`) run faster on LiteRT.js, with several wasm threads or WebGPU, than in
MediaPipe tasks-vision 1.2.3 (single-threaded wasm, WebGL GPU delegate). Decision: [`face-runtime.md`](face-runtime.md).

Page: `/spikes/runtime.html`, served cross-origin isolated (COOP `same-origin`, COEP `require-corp`) so that wasm
threads exist; the **Isolation** row must read `crossOriginIsolated yes`. Options: `runtime=litert|mediapipe`,
`accel=wasm|webgpu`, `threads=N` (default min(4, cores); `threads=1` loads the single-threaded build),
`delegate=CPU|GPU` (MediaPipe), `blendshapes=0`, `detect=always` (detector on every frame), `coi=0` (page served
without isolation), and for LiteRT.js:

- `crop=gpu`: both crops on WebGL2, only the crops read back (256×256 landmark crop, 128×128 detector letterbox);
- `detcrop=canvas|gpu`: the detector letterbox alone (default: as `crop`). `crop=gpu&detcrop=canvas` is the variant
  measured on the Redmi Note 11S on 2026-11-21, before the letterbox moved to WebGL2;
- `mode=worker` (or `worker=1`): detection, landmarks and blendshapes in a dedicated worker, crops on an
  OffscreenCanvas there, frames transferred as `VideoFrame` (`transfer=bitmap`: `ImageBitmap`) as in #6. The page
  only captures, renders and reads the results. Falls back with a warning (**Warnings** row, in red): one thread
  when the worker is not cross-origin isolated, 2D-canvas crops without WebGL2 on OffscreenCanvas, the main thread
  when the worker cannot start;
- `schedule=eager`: the next run starts when the previous one ends instead of on the next frame callback. On the main
  thread it starves rendering (≈ 1 fps on the Redmi); in a worker it starts right away when a frame newer than the
  analysed one has been presented, otherwise on the next frame callback.

The links at the top switch variant and keep the other options. All runs on
`&source=pesquet-closeup&autostart&window=10`, one minute each:

| Run | URL | What |
|---|---|---|
| R1 | `/spikes/runtime.html?runtime=mediapipe` | reference, GPU delegate |
| R2 | `…?runtime=mediapipe&delegate=CPU` | reference, CPU delegate |
| R3 | `…?threads=1` | LiteRT.js, single-threaded wasm (works without isolation) |
| R4 | `…?threads=2` | LiteRT.js, 2 threads |
| R5 | `…?threads=4` | LiteRT.js, 4 threads |
| R6 | `…?threads=6` (8-core phones) | LiteRT.js, more threads: does it still scale? |
| R7 | `…?accel=webgpu` | LiteRT.js, WebGPU (Chrome desktop and Android, Safari 26+) |
| R8 | best of R3–R7 `&blendshapes=0` | blendshapes cost |
| R9 | best of R3–R7 `&detect=always` | detector cost on every frame |

- Read `pipeline` p50/p95 (frame → result), the per-stage cells (`detect`, `crop`, `lmk`, `bs`, `read`) and fps. With
  LiteRT.js the run is asynchronous: a frame arriving while the previous one is analysed is skipped (`drop/fr`), so
  fps stays at the clip rate while results lag; compare `pipeline`, not fps.
- Once per device, with a face in view, press **Check vs MediaPipe** (LiteRT variants): the mean landmark distance
  should stay within a few % of the face size. MediaPipe runs in IMAGE mode for that check and can miss a face in
  profile ("MediaPipe found no face"): press again on a frontal frame.
- On the phone, watch whether `pipeline` drifts over a 10-minute run with the best variant (threads heat several
  cores at once).
- iPhone: R3, R5 and R7 (WebGPU only on Safari 26+); note any page error.

### GPU crops and worker (W1–W10)

After the Redmi Note 11S runs (`face-runtime.md`): the detector letterbox on WebGL2, and the pipeline in a worker so
that rendering keeps the display rate while tracking runs as fast as it can. Same clip and options
(`&source=pesquet-closeup&autostart&window=10`), one minute each; W2 and W6 also as 5-minute recordings, with and
without blendshapes, on the clip and on the camera (drop `source` and `autostart`).

| Run | URL | What |
|---|---|---|
| W1 | `/spikes/runtime.html?threads=4&crop=gpu&detcrop=canvas` | reference: the Redmi's best variant of 2026-11-21 |
| W2 | `…?threads=4&crop=gpu` | detector letterbox on WebGL2 too |
| W3 | `…?threads=4&crop=gpu&detcrop=canvas&detect=always` | letterbox cost on every frame, canvas |
| W4 | `…?threads=4&crop=gpu&detect=always` | same, WebGL2: compare `dcrop` with W3 |
| W5 | `…?threads=4&crop=gpu&mode=worker` | pipeline in a worker, runs on frame callbacks |
| W6 | `…?threads=4&crop=gpu&mode=worker&schedule=eager` | worker, next run as soon as a newer frame exists |
| W7 | W6 `&blendshapes=0` | blendshapes cost in the worker |
| W8 | W6 with `threads=1` | single thread in the worker (no isolation needed) |
| W9 | W6 `&transfer=bitmap` | ImageBitmap instead of VideoFrame |
| W10 | `…?threads=4&crop=gpu&schedule=eager` | main-thread eager, for comparison with W6 (expected: rendering collapses) |

- Before each worker run, check the **Runtime** row (`… in a worker (videoframe) · worker crossOriginIsolated yes`),
  the **Warnings** row (empty) and the **Face** row (`N pthreads in the worker`: at least 3 with 4 threads). Note any
  fallback: it is a result in itself.
- **Rendering vs tracking**: `fps` is the display rate (clip or camera frames rendered), `track Hz` the completed
  runs per second. In W5–W9, `fps` must stay at the clip or camera rate whatever `track Hz` is; `track` (main-thread
  tracking time) should read ≈ 0 (capture + post + result handling only).
- **Pipeline**: `pipeline`, `crop`, `lmk`, `bs`, `read` against W2 (a worker run may be slower: no shared GPU context,
  contention with the page); `xfer` = run time seen by the page minus the worker's (capture, transfer, messages).
- **Detector crop**: `dcrop` (and `detect`) when the face is lost; the hand passing in front of the face in the clip
  makes the detector run. W3 vs W4 measures it on every frame. On the Redmi the canvas letterbox cost 38–58 ms.
- **Latency**: `latency` (frame → result on the main thread) and `age` (age of the landmarks drawn). With
  `schedule=frame` a run starts on a frame callback, so a pipeline just above a display tick loses a frame; eager runs
  do not wait for the tick. Check visually that the landmarks do not trail more than in W2.
- `drop/fr`: frames never analysed. Expected > 0 whenever the pipeline is slower than the frame interval.

Decision rule: the worker variant is worth it on the phone if W6 keeps `fps` at the clip or camera rate with a
`track Hz` above W2's (≥ 15 Hz with blendshapes, the floor of #90; ≥ 18 Hz to show the filter again), without `age`
growing by more than about one frame. The GPU letterbox is kept if `dcrop` in W4 is well below W3 and the landmarks
still match MediaPipe (**Check vs MediaPipe** once on W2 and once on W6).

## Levers on slow devices

First device result (2026-11-21, Redmi Note 11S, Android Chrome, one face present): tracking ≈ 92 ms with the camera
and ≈ 108 ms on `pesquet-closeup` with the GPU delegate (≈ 9 fps), ≈ 96 ms with the CPU delegate; rendering 1–2 ms.
MediaPipe is the whole cost. Variants to measure on each slow device (`&window=10`, one face):

| Run | URL | Lever |
|---|---|---|
| L1 | `/?source=pesquet-closeup&autostart&window=10` | reference (GPU) |
| L2 | `…&delegate=CPU` | CPU delegate |
| L3 | `…&blendshapes=0` | no blendshapes model |
| L4 | `/?source=pesquet-closeup-360&autostart&window=10` | half-resolution input |
| L5 | `/?source=pesquet-closeup-360&autostart&window=10&blendshapes=0&delegate=CPU` | all combined |

## Sustained runs

On each phone: 10 minutes on the default page (`/`), and 10 minutes on the variant chosen by #6.
