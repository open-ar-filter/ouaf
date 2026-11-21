# Default `maxFaces` per device class (#8)

Status: **proposed** for desktop, **open** for phones. The numbers below come from one desktop machine, in headless
browsers. The decision is final once an Android phone and an iPhone have run the #8 protocol in
[`phase0-measurement-protocol.md`](phase0-measurement-protocol.md#8--multi-face-cost).

## Question

The engine tracks at most `maxFaces` faces (spec 5.4). The current defaults are 2 on phones and 4 on desktop. What
does each additional face cost, what does a spare capacity cost (fewer people in view than `maxFaces`), and which
default keeps the tracking rate above the 15 Hz floor (spec 16.1)? Spec 16.2 already lets the engine lower `maxFaces`
at run time ("faces beyond the first"). The default is the capacity the engine starts with.

## Test clips

The only clip with more than two faces, `group-far`, has faces too small for MediaPipe's short-range detector. Two
clips were added (`test-media/make.sh`, from the same CC BY 4.0 Ifremer sources, see
[`test-media/README.md`](../../test-media/README.md)):

- `four-faces-grid.mp4`: four faces in a 2×2 grid, each ≈ 35–40 % of the frame width. The bottom row repeats the top
  extracts, played backwards and mirrored, so every face has a different pose at every instant.
- `three-faces-grid.mp4`: the same grid with the fourth cell replaced by underwater footage.

MediaPipe finds every face: in the step-by-step browser test (headless Chromium, software WebGL), `four-faces-grid`
gives 4 faces on 32 frames out of 32 with `maxFaces=4`, never more than 4 with `maxFaces=8` (no false positive), and
`three-faces-grid` gives 3 faces on 24 frames out of 32 (2 on the others). Both clips are in `e2e/tracking.spec.ts`.

The landmark model runs on a fixed 256×256 crop of each face, so the face size does not change its cost: one face of
the grid (8a) costs the same as the close-up of `pesquet-closeup` (8h). Chromium GPU: 14.1 against 14.0 ms. Chromium
CPU: 15.0 against 15.1 ms.

## Method (desktop)

- Machine: Linux laptop, Intel Core Ultra 9 275HX (24 cores), **integrated** Intel Arc GPU (Arrow Lake, Mesa), on AC power.
  The discrete GPU was not used.
- Browsers, driven by Playwright 1.65, **headless**:
  - Chromium 159 (headless shell), hardware WebGL through ANGLE on EGL (`--use-angle=gl-egl --enable-gpu
    --ignore-gpu-blocklist`). Renderer: `ANGLE (Intel, Mesa Intel(R) Graphics (ARL), OpenGL ES 3.2)`.
  - Firefox 159, hardware WebGL. Renderer: `Mesa Intel(R) Graphics (ARL)`.
- MediaPipe tasks-vision 1.2.3, blendshapes on, 720×1280 clips at 30 fps, looping. Each run opens the playground URL
  of the protocol, waits 3 s, presses **Record** on the performance panel (Manual), stops after **40 s** and presses
  **Export**.
- Another agent was running browser benchmarks on the same machine during the session. The driver waited until no
  other Playwright browser was running before each run, and redid any run that one started during. Two Chromium runs
  that never got a quiet window were redone later.
- Raw exports: [`data/8-multi-face/`](data/8-multi-face/), one file per run, prefixed with the browser (44 files).
  Statistics per number of faces come from the `faces` and `trackingMs` sample columns.

**These are not device numbers.** The browsers were headless, on a high-end laptop CPU with an integrated GPU. A
mid-range laptop is probably 2× slower, and a phone 5–7× slower (see below). The ratios (cost of each additional
face, cost of a spare capacity) are what should carry over to devices. The absolute times do not.

## Results

`trackingMs` p50 / p95 (time spent in `FaceTracker.detect` per frame: MediaPipe detector, landmarks and blendshapes
for every face), over the samples with that number of faces, and frame rate of the run.

| Faces tracked | Run | Chromium GPU | Chromium CPU | Firefox GPU | Firefox CPU |
|---|---|---|---|---|---|
| 0, detector only | 8d `no-face`, capacity 4 | 6.9 / 11.7 · 30 fps | 7.6 / 11.3 · 30 fps | 10 / 13 · 24 fps | 13 / 16 · 25 fps |
| 1 | 8a `four-faces-grid`, capacity 1 | 14.1 / 24.9 · 30 fps | 15.1 / 19.2 · 30 fps | 16 / 22 · 24 fps | 20 / 25 · 24 fps |
| 2 | 8b `four-faces-grid`, capacity 2 | 23.7 / 30.0 · 30 fps | 24.8 / 28.1 · 30 fps | 27 / 37 · 24 fps | 28 / 35 · 25 fps |
| 3 (capacity 4) | 8e `three-faces-grid` | 32.6 / 42.7 · 28 fps | 30.2 / 31.5 · 30 fps | 44 / 54 · 22 fps | 41 / 42 · 24 fps |
| 4 | 8c `four-faces-grid`, capacity 4 | 35.6 / 48.6 · **26 fps** | 36.1 / 37.3 · **27 fps** | 50 / 61 · **19 fps** | 47 / 49 · **20 fps** |

**Spare capacity**: the same faces under different `maxFaces`. This is the usual case, one person in front of the
camera with the default capacity.

| Faces in view | Capacity | Run | Chromium GPU | Chromium CPU | Firefox GPU | Firefox CPU |
|---|---|---|---|---|---|---|
| 0 | 1 / 4 | `no-face` / 8d | 7.0 / 6.9 | 7.9 / 7.6 | 10 / 10 | 12 / 13 |
| 1 | 1 | 8h `pesquet-closeup` | 14.0 | 15.2 | 17 | 18 |
| 1 | 2 | 8i | 19.2 | 18.0 | 21 | 21 |
| 1 | 4 | 8j | 19.5 | 17.9 | 22 | 20 |
| 2 | 2 | 8g `two-faces-stacked` | 23.2 | 24.3 | 27 | 28 |
| 2 | 4 | 8f | 27.7 | 22.7 | 38 | 33 |
| 4 (2 tracked) | 2 | 8b `four-faces-grid` | 23.7 | 24.8 | 27 | 28 |

(p50 in ms over the samples with that number of faces; p95 are in the exports.)

Rendering takes 0.4–1 ms in every run and does not depend on the number of faces.

## Reading

- **Each face adds a fixed amount.** In Chromium, a face adds about 6–10 ms on this machine (both delegates); in
  Firefox about 8–12 ms. Four faces cost ≈ 2.4–2.5× one face in Chromium and ≈ 2.4–3× in Firefox. The detector
  alone costs 7–13 ms.
- **Four faces exceed the frame budget even here.** At 36 ms (Chromium) to 47–50 ms (Firefox) per frame, the
  rate falls to 26–27 fps in Chromium and 19–20 fps in Firefox. That is still above the 15 Hz floor, but only on a
  fast laptop CPU.
- **A spare capacity costs a few ms, the same for 2 and 4.** With one face, raising `maxFaces` from 1 to 2 adds
  3–5 ms (+17–37 %). Raising it from 2 to 4 adds nothing measurable (19.2 against 19.5 ms in Chromium GPU). With two
  faces, a capacity of 4 instead of 2 adds 0–5 ms in Chromium and 5–11 ms in Firefox. That cost looks like the
  detector looking for more faces. Faces in view beyond the capacity cost nothing (8b against 8g: 23.7 against
  23.2 ms).
- So **a capacity of 4 instead of 2 costs nothing while one person is in view**. The extra cost only appears when
  3–4 people are actually tracked, and spec 16.2 can then lower `maxFaces`.
- **Delegates**: GPU and CPU give the same p50 on this integrated GPU. CPU has the tighter p95 (37 against 49 ms with
  four faces in Chromium). Firefox is 15–40 % slower than Chromium with either delegate. MediaPipe's wasm build is the
  same in both, so the gap comes from the browsers (wasm, WebGL, access to the video frame).
- Firefox headless stays at ≈ 24–25 fps even with 10 ms of tracking per frame. That is a limit of the headless
  setup, not of tracking: compare its `trackingMs`, not its fps.

## Context: phones

The only phone result so far is in #9. On a Redmi Note 11S (Helio G96, Mali-G57, Android Chrome) with MediaPipe,
**one face** costs ≈ 75–100 ms per frame: 92 ms with the camera and 108 ms on `pesquet-closeup` with the GPU delegate,
96 ms with the CPU delegate. That is ≈ 9–10 Hz, **already below the 15 Hz floor with one face**. Those runs used
`maxFaces=2`. If the desktop ratios hold:

- capacity 1 instead of 2 would save ≈ 15–27 % with one person, roughly 100 → 75–85 ms;
- two faces would cost ≈ 1.7× one face (≈ 160–180 ms, ≈ 6 Hz), and four faces ≈ 2.5× (≈ 250 ms, 4 Hz).

The LiteRT.js pipeline of [`face-runtime.md`](face-runtime.md) brings one face to ≈ 50–60 ms on that phone, about
15–19 Hz. That leaves no room for a second face either. On mid-range phones, multi-face is out of reach for now.
Spec 16.2 drops to one face, and dropping the spare capacity is itself worth ≈ 15–27 %. These are extrapolations: the
phone runs (8a–8d, 8h–8j) must measure them.

## Proposal

- **Desktop: keep `maxFaces = 4`.** With one or two people in view, it costs the same as 2 (see the spare capacity
  table). With four people it stays above the floor on this laptop (≥ 19 fps). On a slower desktop, spec 16.2 lowers
  it when the rate falls.
- **Phones: undecided until the phone runs.** On the only measured phone, even one face is below the floor, so the
  default matters less than the adaptation: spec 16.2 brings `maxFaces` to 1 within the first seconds. Two candidate
  rules for the maintainer's runs to settle:
  - keep 2 if 8i ≈ 8h on phones (no cost for the spare capacity);
  - otherwise default to 1 on phones, and let a host or filter ask for more, if 8h saves ≥ 15 % against 8i (as on
    desktop). A capacity of 1 means a second person is never picked up unless the engine raises it again, so this
    trades multi-face support for tracking rate on the devices that need it most.

## Next

1. Run the #8 protocol (8a–8j, then 8a–8d and 8j with `&delegate=CPU`) on an Android mid-range phone and an iPhone,
   and add the results here.
2. Decide the phone default from 8h vs 8i, and confirm the desktop default on a mid-range laptop (headed browser,
   real camera, Chrome, Firefox, Safari).
3. Engine (phase 1): apply the default per device class, and make spec 16.2's "faces beyond the first" also cover
   the spare capacity (go down to `maxFaces = 1` while a single face is in view, since a spare slot costs 15–27 %),
   if the phones confirm that cost.
