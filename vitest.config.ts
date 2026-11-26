import { defineConfig } from 'vitest/config'
import { BROWSER_ONLY } from './e2e/coverage/browser-only.ts'

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
      // Code that cannot run in Node. The browser tests (e2e/) cover it: `npm run test:browser:coverage` holds
      // `BROWSER_ONLY` to the same threshold. Keep this list to such modules only.
      exclude: [
        ...BROWSER_ONLY,
        'packages/cli/src/preview/page.ts', // page of `ouaf preview`, bundled and run in headless Chromium
        'packages/cli/src/bin.ts', // process entry point of `ouaf`; its body is cli.ts, which is tested
      ],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
      reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
})
