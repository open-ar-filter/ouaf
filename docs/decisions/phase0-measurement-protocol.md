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

To be completed with the #7 spike.

## Sustained runs

On each phone: 10 minutes on the default page (`/`), and 10 minutes on the variant chosen by #6.
