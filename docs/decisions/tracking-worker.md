# Face tracking in a worker or on the main thread (#6)

Status: **accepted for mid-range Android, provisional elsewhere** (2026-11-21). An iPhone (WebGL on
`OffscreenCanvas` in workers, Safari 17+) and a high-end Android phone still have to confirm it (#95).

## Question

Run face tracking in a Web Worker (frames transferred from the page, models on an `OffscreenCanvas` in the worker),
or on the main thread next to rendering? Protocol: [`phase0-measurement-protocol.md`](phase0-measurement-protocol.md#6--tracking-in-a-worker-vs-main-thread),
page `/spikes/worker.html` (MediaPipe tasks-vision) and `mode=worker` of `/spikes/runtime.html` (our own LiteRT.js
pipeline, [`face-runtime.md`](face-runtime.md)).

## Results

**MediaPipe, Redmi Note 11S** (Helio G96, Chrome 157), clip `pesquet-closeup`, `maxFaces=1`.

Morning, CPU delegate, live panel over 10 s (first results, #6 comment), p50 / p95 ms:

| | main thread | worker · VideoFrame | worker · ImageBitmap |
|---|---|---|---|
| display fps | 12.0 | **29.0** | 28.6 |
| main-thread tracking (`track`) | 75.0 / 103.1 | **0.0 / 0.6** | 0.2 / 2.1 |
| inference | ≈ 75 | 76.8 / 136.7 | 77.8 / 141.8 |
| age of the drawn landmarks | 0 | 141.6 / 235.8 | 133.3 / 233.2 |

Afternoon, GPU delegate (runs 6a–6e, 1 min each, exports in [`data/6-worker/redmi-note-11s/`](data/6-worker/redmi-note-11s/)).
The GPU delegate was 2–3× slower that afternoon than in the morning (see [`multi-face.md`](multi-face.md)), so only
the main-thread figures compare here, not the absolute inference times:

| Run | Variant | display fps | `track` (main) | inference | result age | event-loop lag p95 | long tasks p50 |
|---|---|---|---|---|---|---|---|
| 6a | main thread | 4.9 | 198 | 198 | 0 | 323 | 205 |
| 6b | worker, VideoFrame | **28.2** | **0.0** | 282 | 433 | 9.8 | 0 |
| 6c | worker, ImageBitmap | 27.6 | 0.0 | 291 | 467 | 10.3 | 0 |
| 6d | main thread, busy host (`load=15`) | 4.6 | 193 | 193 | 0 | 353 | 214 |
| 6e | worker, busy host (`load=15`) | **28.6** | 0.0 | 265 | 433 | 16.8 | 0 |

**LiteRT.js pipeline in a worker** (W5–W9 of [`face-runtime.md`](face-runtime.md)): 29 fps on screen on the Redmi
Note 11S and the Redmi Note 14 Pro 5G, ≈ 0 ms of tracking on the main thread, results ≈ 100–130 ms old when drawn,
against 1.8 fps on screen when the same eager pipeline runs on the main thread (W10).

## Reading

- **The worker keeps the page at the display rate** whatever tracking costs: 28–29 fps against 5–12 fps on the
  main thread, with or without a busy host page (6d/6e), and it frees the event loop (lag p95 ≈ 10–17 ms against
  320–350 ms, no long tasks).
- **Inference costs the same in the worker** (morning runs, CPU): no penalty for leaving the page's WebGL context.
- **`VideoFrame` transfer is slightly better than `ImageBitmap`** (display fps, main-thread cost; result age is a
  tie across the two sessions).
- **Cost: landmarks are drawn late**, by about one tracking period (≈ 100–140 ms on these phones at 7–15 Hz). This is
  visible on fast motion; #13 (anchors, smoothing) must hide it, by interpolation (delay the image to match results)
  or prediction (extrapolate landmarks to the displayed frame).
- The decision rule of the protocol is met: on the phones, the worker keeps the camera rate with `load=15` where the
  main thread does not, and cuts the event-loop lag by an order of magnitude. Result age grows by more than one
  frame, which #13 has to absorb.

## Decision

1. **Tracking runs in a dedicated worker** by default, frames transferred as `VideoFrame` (fallback `ImageBitmap`),
   with eager scheduling (the next run starts as soon as the previous one ends, on the newest frame). The tracker
   behind `FaceTracker` is our own LiteRT.js pipeline ([`face-runtime.md`](face-runtime.md)).
2. **Main-thread fallback** where a worker cannot run the tracker (no WebGL on `OffscreenCanvas` in workers: the
   LiteRT.js pipeline falls back to 2D-canvas crops in the worker first, see [`webkit-compat.md`](webkit-compat.md)).
3. **#13 handles the result age** (interpolation or prediction), measured with the `age` column.
4. To confirm on an iPhone (Safari 17+ worker WebGL) and a high-end Android phone (#95).
