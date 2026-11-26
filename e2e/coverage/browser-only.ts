/**
 * Package sources that cannot run in Node: they hold a WebGL context, decode with WebCodecs, or run in a Worker or
 * behind a sandboxed iframe. The unit coverage leaves them out (vitest.config.ts); the browser tests answer for them,
 * and their coverage there is held to `BROWSER_THRESHOLD` (report.ts). Keep this list to such modules only.
 */
export const BROWSER_ONLY = [
  'packages/core/src/engine/engine.ts', // creates the compositor, hence a WebGLRenderer, in its constructor
  'packages/core/src/engine/compositor.ts', // three.js WebGLRenderer and render targets
  'packages/core/src/litert/pipeline.ts', // LiteRT.js models on WebGPU / Wasm, in the tracking worker
  'packages/core/src/litert/face.worker.ts', // the tracking worker itself
  'packages/core/src/litert/gpu-crop.ts', // WebGL2 crops on an OffscreenCanvas
  'packages/core/src/offline-video.ts', // WebCodecs VideoDecoder
  'packages/core/src/script/sandbox.ts', // sandboxed iframe running a Worker
]

/** Least coverage of `BROWSER_ONLY` taken together, in % of lines, statements, functions and branches. */
export const BROWSER_THRESHOLD = 80
