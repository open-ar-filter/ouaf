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

To be completed with the #6 spike.

## #7 — Shared WebGL context (GPU-side masks)

Goal: confirm (or not) that a MediaPipe segmentation mask can feed the WebGL2 renderer without any CPU readback when
both share one context, and what the WebGPU alternative costs (#7 decision).

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

## Sustained runs

On each phone: 10 minutes on the default page (`/`), and 10 minutes on the variant chosen by #6.
