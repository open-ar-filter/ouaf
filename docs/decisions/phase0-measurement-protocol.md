# Phase 0 measurement protocol

How to run the phase 0 spikes (#6, #7, #8) on real devices so that one measurement session feeds every decision
(#9). Results and decisions go in `docs/decisions/` next to this file, raw exports in `docs/decisions/data/`.

## Devices

| Class | Device | Browser |
|---|---|---|
| Desktop | (fill in) | Chrome, Firefox, Safari |
| Android mid-range | (fill in) | Chrome |
| iPhone | (fill in) | Safari |

## General rules

- `npm run fetch-models` once, then `npm run dev`; open the `Network: https://…` URL on the device.
- Index of the spike pages: `/spikes/`.
- Plug the phone in or note the battery level; close other apps; same lighting for every run (good light: low light
  halves the front camera frame rate).
- Every run uses the performance panel: pick the duration, **Record**, keep a face in view, then **Export**. The file
  name already contains the device, the page and the URL options.
- Short runs: 1 minute. Sustained runs (thermal throttling): 10 minutes.

## #8 — Multi-face cost

Goal: choose the default `maxFaces` per device class.

| Run | URL | Faces in view | Duration |
|---|---|---|---|
| 8a | `/?maxFaces=1` | 1 | 1 min |
| 8b | `/?maxFaces=2` | 1, then 2 | 1 min |
| 8c | `/?maxFaces=4` | 1, then 4 | 1 min |

- Extra faces: other people, or printed photos / faces shown on another screen (MediaPipe tracks them).
- Look at `trackingMs` p50/p95 and fps for each number of faces; the `faces` column of the export tells which
  samples had how many faces.
- Also run 8a with `&delegate=CPU` to compare delegates.

## #6 — Tracking in a Worker vs main thread

Goal: decide whether tracking runs in a Web Worker (MediaPipe on an `OffscreenCanvas`, frames transferred from the
page) or on the main thread with the GPU delegate.

Page: `/spikes/worker.html` (links on `/spikes/`). Options: `mode=main|worker` (default `worker`),
`transfer=videoframe|bitmap` (worker: `new VideoFrame(video)` or `createImageBitmap(video)`, default `videoframe`),
`load=N` (N ms of synthetic main-thread work per frame: a busy host page), plus `maxFaces` (default 2) and
`delegate=CPU` as on the main page. The links at the top of the page switch variant and keep the other options.

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
  back to CPU or fails, note which.

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

To be completed with the #7 spike.

## Sustained runs

On each phone: 10 minutes on the default page (`/`), and 10 minutes on the variant chosen by #6.
