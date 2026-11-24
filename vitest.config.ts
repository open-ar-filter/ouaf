import { defineConfig } from 'vitest/config'

// Unit tests only; browser tests live in e2e/ and run with Playwright (`npm run test:browser`).
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // For the allocation tests (packages/core/test/allocation.ts): V8 optimizes and sweeps the heap on the main
    // thread, at points set by the code rather than by the machine's load, so that they measure the same on every run.
    globalSetup: ['vitest.global-setup.ts'],
    execArgv: ['--no-concurrent-recompilation', '--no-concurrent-sweeping'],
    // `npm run test:coverage`: V8 coverage of the package sources reached by the unit tests (the browser-only code,
    // covered by e2e/, shows up as uncovered). Reports go to coverage/ (gitignored). The coverage counters allocate, so the
    // allocation tests skip themselves in that run (packages/core/test/allocation.ts).
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
})
