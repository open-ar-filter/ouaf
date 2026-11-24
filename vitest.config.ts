import { defineConfig } from 'vitest/config'

// Unit tests only; browser tests live in e2e/ and run with Playwright (`npm run test:browser`).
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // For the allocation tests (packages/core/test/allocation.ts): V8 optimizes and sweeps the heap on the main
    // thread, at points set by the code rather than by the machine's load, so that they measure the same on every run.
    globalSetup: ['vitest.global-setup.ts'],
    execArgv: ['--no-concurrent-recompilation', '--no-concurrent-sweeping'],
    // `npm run test:coverage`: V8 coverage of the package sources, below 80 % of lines, statements, functions or
    // branches the run fails. Reports go to coverage/ (gitignored). The coverage counters allocate, so the allocation
    // tests skip themselves in that run (packages/core/test/allocation.ts).
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // Code that cannot run in Node: it holds a WebGL context, decodes with WebCodecs, runs in a Worker or an iframe,
      // or is a page loaded in Chromium. The browser tests (e2e/) cover it; keep this list to such modules only.
      exclude: [
        'packages/core/src/engine/engine.ts', // creates the compositor, hence a WebGLRenderer, in its constructor
        'packages/core/src/engine/compositor.ts', // three.js WebGLRenderer and render targets
        'packages/core/src/litert/pipeline.ts', // LiteRT.js models on WebGPU / Wasm, in the tracking worker
        'packages/core/src/litert/face.worker.ts', // the tracking worker itself
        'packages/core/src/litert/gpu-crop.ts', // WebGL2 crops on an OffscreenCanvas
        'packages/core/src/offline-video.ts', // WebCodecs VideoDecoder
        'packages/core/src/script/sandbox.ts', // sandboxed iframe running a Worker
        'packages/cli/src/preview/page.ts', // page of `ouaf preview`, bundled and run in headless Chromium
        'packages/cli/src/bin.ts', // process entry point of `ouaf`; its body is cli.ts, which is tested
      ],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
      reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
})
