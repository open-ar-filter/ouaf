# Shared WebGL context with MediaPipe: GPU-side masks (#7)

Status: **accepted** (2026-11-21): WebGL2 first, with the segmentation sharing the renderer's context. Confirmed on
desktop Chrome (headless), a Redmi Note 11S and WebKit (desktop proxy); an iPhone run (float texture filtering) is
still wanted (#95).

## Question

WebGL2 was chosen partly because MediaPipe masks could stay on the GPU when MediaPipe and the renderer share one
context. Does a segmentation mask reach the renderer as a texture without any CPU readback, and what would a WebGPU
renderer pay instead? Protocol and page: [`phase0-measurement-protocol.md`](phase0-measurement-protocol.md#7--shared-webgl-context-gpu-side-masks),
`/spikes/gl-share.html` (ImageSegmenter, selfie segmenter → three.js background blur).

## Results

**Redmi Note 11S** (Helio G96, Mali-G57, Chrome 157), camera, segmentation only:

| Path | fps | frame p50 / p95 (ms) | segmentation (ms) | mask transfer (ms) | readbacks per frame |
|---|---|---|---|---|---|
| `shared` (mask stays on the GPU) | **22.0** | **33.4** / 83.3 | 7.0 / 10.4 | 0 | **0** |
| `cpu` (mask read back, uploaded again) | 14.9 | 66.7 / 93.3 | 6.6 / 8.6 | **80 / 100** | 1 |
| `shared&face=shared` (face landmarks on the same context, GPU) | 4.8 | | 196 / 236 (face + segmentation) | 0.1 | 0 |

**Desktop** (headless Chrome, Intel iGPU, 30 fps fake camera; p50 ms): `shared` 1.2 ms per frame and 0 readbacks;
`cpu` 11.1 ms (9.5 ms of readback); WebGPU renderer 11.6 ms (10.3 ms to copy the mask into WebGPU) or 12.4 ms with a
readback. Details in the protocol.

**WebKit** (desktop proxy, [`webkit-compat.md`](webkit-compat.md)): `shared` works with 0 readbacks and a correct
alignment check; `cpu` works (R32F mask, `OES_texture_float_linear` present); WebGPU is not available.

## Reading

- **The zero-readback shared path works on a real phone and it matters**: the mask round trip through the CPU costs
  ≈ 80 ms per frame on the Redmi (waiting for the GPU, then copying), a third of the frame rate, for the same
  segmentation cost.
- Small models are fast through WebGL on that phone (segmentation ≈ 7 ms), unlike the face landmarker (75–200 ms):
  web GPU inference is not slow in itself.
- **Face tracking should not share the renderer's context.** Running the face landmarker on the GPU next to
  segmentation and rendering drops the Redmi to 4.8 fps. Face tracking runs in a worker on the CPU instead
  ([`tracking-worker.md`](tracking-worker.md), [`face-runtime.md`](face-runtime.md)), so both processors work in
  parallel.
- A WebGPU renderer would pay ≈ 10 ms per frame on desktop just to bring the mask over (more on phones), the cost the
  shared WebGL2 context avoids.

## Decision

1. **WebGL2 stays the first renderer**, and segmentation (and any GPU-side MediaPipe output such as masks) runs on
   **the renderer's own context**: the mask is used as a texture with no readback.
2. **Face tracking runs elsewhere**: in a worker on the CPU (our LiteRT.js pipeline), not on the shared context.
3. **WebGPU remains exploratory** (#62): it would need GPU-side interop with the segmentation to compete.
4. To confirm on an iPhone (float texture filtering, Safari) (#95).
