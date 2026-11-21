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
- Prefer the test clips (`?source=<clip>&autostart`) over a live face: same input on every device, reproducible.
  Live-camera runs are still needed for the camera capture cost and low light.
- Every run uses the performance panel: pick the duration, **Record**, keep a face in view, then **Export**. The file
  name already contains the device, the page and the URL options.
- Short runs: 1 minute. Sustained runs (thermal throttling): 10 minutes.

## #8 — Multi-face cost

Goal: choose the default `maxFaces` per device class.

The runs use the [test clips](../../test-media/README.md) (`?source=`), so every device analyses exactly the same
faces and nobody has to stand in front of the camera; `&autostart` starts playback without a tap.

| Run | URL | Faces | Duration |
|---|---|---|---|
| 8a | `/?source=pesquet-talk&autostart&maxFaces=1` | 1 | 1 min |
| 8b | `/?source=two-faces-stacked&autostart&maxFaces=2` | 2 | 1 min |
| 8c | `/?source=two-faces-stacked&autostart&maxFaces=4` | 2 (capacity 4) | 1 min |
| 8d | `/?source=no-face&autostart&maxFaces=4` | 0 (detector cost alone) | 1 min |

- MediaPipe only finds faces that are large enough (selfie distance): the faces of `group-far` (≈ 12 % of the frame
  width) are not detected. More than 2 simultaneous faces needs a dedicated clip if 4 faces is to be measured.
- Look at `trackingMs` p50/p95 and fps for each number of faces; the `faces` column of the export tells which
  samples had how many faces.
- Also run 8a with `&delegate=CPU` to compare delegates.

## #6 — Tracking in a Worker vs main thread

To be completed with the #6 spike.

## #7 — Shared WebGL context (GPU-side masks)

To be completed with the #7 spike.

## Sustained runs

On each phone: 10 minutes on the default page (`/`), and 10 minutes on the variant chosen by #6.
