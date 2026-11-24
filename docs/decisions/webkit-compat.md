# WebKit compatibility of the phase 0 pages (desktop proxy, #9)

Status: **desktop proxy only**. We have no iPhone and no Mac yet, so the phase 0 pages (#6, #7, #8, #83) were run in
Playwright's WebKit on Linux to find the API gaps and bugs that would show up in Safari before a device session.
These are functional checks (does it load, find faces, fall back with a message), not performance numbers.

**Caveat.** Playwright's WebKit on Linux is a Linux port of WebKit (headless: the WPE port, `WPEWebProcess`; headed:
WebKitGTK), not iOS Safari: different GPU stack (Mesa through GStreamer GL and ANGLE here, Metal on iOS), different
media stack and codecs (GStreamer), and its own feature flags. It claims to be Safari 27.2 on macOS
(`Version/27.2 Safari/605.1.15`) and masks the WebGL renderer as "Apple GPU". A pass here means that the code path and
the APIs it uses exist in current WebKit; a failure is either a WebKit behaviour (likely in Safari too) or a gap of
this build (marked as such). Nothing here says how an iPhone behaves or performs: the iPhone runs of the protocol
still decide.

## Setup (2026-11-21)

- Playwright 1.65.1, WebKit 27.2 (Playwright build v2388, the Ubuntu 24.04 fallback build; `npx playwright install
  webkit`, no extra system package needed on this machine), headless, page served by `npx vite --port 5288` from
  `apps/playground`.
- Host: Intel Arrow Lake iGPU + NVIDIA RTX 5080 laptop, NVIDIA proprietary driver 595. **Host quirk:** with the NVIDIA
  EGL driver, the WebKit web process dies (SIGFPE in `libnvidia-eglcore`, from `gst_gl_framebuffer_attach`) as soon
  as a page reads a video frame (`drawImage`, `texImage2D`, `createImageBitmap` of a `<video>`). Every run below forces
  Mesa (the Intel iGPU): `__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json`. Not a Safari
  issue, but anyone repeating these runs on an NVIDIA machine needs it.
- Test clips with `?source=<clip>&autostart` wherever the page supports it. The camera-only page (`gl-share.html`) and
  the camera variants of the other pages use a camera stand-in: an init script replaces `getUserMedia` with a
  `canvas.captureStream(30)` of a test clip (`pesquet-talk`, `pesquet-closeup`) drawn on a rendered canvas.
  WebKit's own mock camera (Playwright `permissions: ['camera']`) gives a 640×480 track that never starts playing in
  a `<video>` in this build, so it is not usable.

## What the browser offers

| Feature | Page | Dedicated worker |
|---|---|---|
| WebGL2 / WebGL | yes / yes | **no / no** (on `OffscreenCanvas`) |
| `OffscreenCanvas` 2D, `bitmaprenderer` | yes | yes |
| `EXT_color_buffer_float`, `OES_texture_float_linear`, `EXT_float_blend` | yes | — |
| `VideoFrame` (from a `<video>`), `createImageBitmap` | yes | yes |
| `requestVideoFrameCallback` | yes | — |
| WebGPU (`navigator.gpu`) | no | no |
| `crossOriginIsolated`, `SharedArrayBuffer` (runtime page, COOP/COEP) | yes | yes (see the fixes) |
| JSPI (`WebAssembly.Suspending`) | yes | — |
| H.264 test clips | play | — |
| `navigator.hardwareConcurrency` | 8 (on a 24-thread machine: WebKit caps it) | — |

WebGL in workers: Safari 17+ is documented to support WebGL on `OffscreenCanvas`, including in workers; this build
has none, so the worker variants that need it (#6 worker, #83 GPU crops in the worker) cannot be judged here.

## Matrix

| Page / variant | Result | Messages, notes |
|---|---|---|
| **Main page** `/?source=pesquet-closeup&autostart` (GPU) | ✅ | Face found on 54/61 frames, anchors in order. GPU delegate works, slower than CPU in this build (not a Safari figure). |
| `…&delegate=CPU` | ✅ | Face found on 265/301 frames. |
| `/?source=four-faces-grid&autostart&maxFaces=4` (GPU, CPU) | ✅ | 4 faces on 27/30 (GPU) and 165/173 (CPU) frames. |
| Main page with a camera | ✅ after fix | Hung at "Camera: opening…" before the fix (hidden `<video>`, see below). |
| **#6** `/spikes/worker.html?…&mode=main` | ✅ | `ready: main, GPU`, 1 face; also with the camera stand-in after the fix. |
| `mode=worker&transfer=videoframe` | ❌ (build gap) | `Tracker: unavailable: Error: ModuleFactory not set.` Worker console: `Creating a context with WebGL 2 failed … Fall back on WebGL 1`, then `StartGraph failed: INTERNAL: Service "kGpuService" …`. No WebGL in workers (above). |
| `mode=worker&transfer=bitmap` | ❌ (build gap) | Same. With `&delegate=CPU`: `unavailable: TypeError: undefined is not an object (evaluating 'GLctx.activeTexture')` (MediaPipe needs WebGL even on CPU). `VideoFrame` and `ImageBitmap` transfers themselves work (#83 worker below). |
| **#7** `/spikes/gl-share.html?path=shared` | ✅ after fix | Mask `720×1280, WebGLTexture`, readbacks 0/frame. Alignment: `top-first (mean \|Δ\| direct 0.0000, flipped 0.2157; … RGBA/FLOAT). Shader flip off (correct).` Before the fix: stuck at "opening the camera…". |
| `path=cpu` | ✅ after fix | Mask `→ Float32Array → R32F` with linear filtering (`OES_texture_float_linear` present); alignment `top-first … (correct)`. |
| `path=webgpu` | ❌ expected | `pipeline unavailable: WebGPU is not available in this browser (navigator.gpu missing).` |
| `path=shared&face=shared` (and `face=own`) | ✅ after fix | 1 face tracked on the shared canvas (and on its own context with `face=own`); alignment `top-first … (correct)`. |
| `path=shared&reset=none` | ❌ expected | Breaks as designed: `WebGL: INVALID_OPERATION: texImage2D: no texture`, `glDrawElements: Must have element array buffer bound`. |
| **#83** `/spikes/runtime.html` (removed in #165) isolation | ✅ | `crossOriginIsolated yes · SharedArrayBuffer yes · 8 cores · WebGPU no`. |
| `threads=1`, `threads=4` | ✅ | Face tracked; landmark model 6.4 ms on 1 thread, 2.9 ms on 4 (9 pthreads started). |
| `crop=gpu`, `detcrop=gpu` (main thread) | ✅ | Same detector ROI as the 2D canvas within 0.6 px, landmarks within 0.07 % of the ROI. |
| **Check vs MediaPipe** (LiteRT ×4, `crop=gpu`) | ✅ | `landmarks: mean 0.7 %, max 1.9 % of the face size` (frontal, 2 s of `pesquet-talk`); 1.8 % / 12.4 % on the 4 s frame (head turned). Same in the worker. |
| `mode=worker` (`videoframe`, `bitmap`, `schedule=eager`, `threads=1`) | ✅ after fix, ⚠ crops | Threads work in the worker (`worker crossOriginIsolated yes`, 9 pthreads), landmarks identical to the main thread (≤ 0.005 %). With `crop=gpu` it falls back, with the warning shown: `worker: no WebGL2 on OffscreenCanvas in this worker: crops on a 2D canvas instead`. Before the fix: `worker unavailable (the LiteRT.js worker failed to load): the pipeline runs on the main thread`. |
| `coi=0&mode=worker&threads=4` | ✅ after fix | `the worker is not cross-origin isolated: 4 threads requested, 1 used`. Before the fix: `worker unavailable (worker: Can't find variable: SharedArrayBuffer)`, then `unavailable: threads need a cross-origin isolated page`. |
| `accel=webgpu` | ❌ expected | `unavailable: model compilation failed (webgpu): WebGPU was requested but no WebGPU device is set in the environment.` (the misleading "run `npm run fetch-models`" hint after it is removed). |
| `runtime=mediapipe` (GPU, CPU) | ✅ | `ready: MediaPipe GPU` / `CPU`, 1 face. |

## Fixes made (WebKit behaviours, likely in Safari too)

1. **Camera on a hidden `<video>`** (main page, #6, #7). WebKit never starts a camera stream in a `<video>` that is
   not rendered: `play()` stays pending with `readyState` 0 when the element is `display: none` or detached (a file
   source plays fine). The three pages open the camera on a `hidden` video; it now stays rendered (2×2 px,
   transparent) while hidden, as `runtime.html` already did. Whether iOS Safari behaves the same with a real camera
   is to be checked, but the fix costs nothing elsewhere.
2. **COEP on the modules of a worker** (#83 `mode=worker`, dev server). WebKit checks the embedder policy of every
   module a worker imports, not only of the worker script: `Refused to load '…/litert-pipeline.ts' worker because of
   Cross-Origin-Embedder-Policy`. The dev server now sends COOP/COEP/CORP on worker imports (`Sec-Fetch-Dest:
   worker` from a module). The build bundles each worker into one script, so it was not affected (checked with
   `vite preview`). Removed with the spike in #165: no playground page is cross-origin isolated any more (wasm
   threads for the engine's tracker: #169).
3. **`crossOriginIsolated` in a worker of a non-isolated page.** WebKit reports `true` there (from the worker
   script's own headers) while `SharedArrayBuffer` is missing, so the worker tried the threaded build. The worker now
   requires both before using threads.
4. **Seek, then analyse** (`__spike83.bench()` / `analyse()`, used by the browser tests). WebKit fires `seeked`
   before the new frame can be drawn, so the first run analysed the previous frame (no face found). They now also
   wait for the frame callback of the seeked frame.

## Browser tests under WebKit

With the fixes and the Mesa workaround, `npx playwright test` with a WebKit project passes 16 of 17 tests; the
failing one, *worker: threads inside the worker, same landmarks as the main thread*, expects GPU crops in the worker
and gets the 2D-canvas fallback warning (no WebGL in workers in this build). The same test with `crop=canvas`
passes. No WebKit project is added to CI: on this build the suite does not pass cleanly, and the result depends on
the host GL driver.

## To check on an iPhone

- WebGL on `OffscreenCanvas` in a worker (#6 `mode=worker`, #83 worker GPU crops): untestable here, needed by both
  worker variants. Note the **Tracker** / **Warnings** rows.
- WebGPU (#7 `path=webgpu`, #83 `accel=webgpu`): absent here; expected only on Safari 26+.
- The camera on the main page, #6 and #7 (fix 1): it opens, and frames keep coming.
- wasm threads in the page and in the worker (`9 pthreads in the worker`), and that the `coi=0` fallback shows its
  warning.
- MediaPipe GPU delegate vs CPU on the Metal-backed WebGL: here the GPU delegate works but is the slower one.
