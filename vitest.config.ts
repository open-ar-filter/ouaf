import { defineConfig } from 'vitest/config'

// Unit tests only; browser tests live in e2e/ and run with Playwright (`npm run test:browser`).
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // For the allocation tests (packages/core/test/allocation.ts): V8 optimizes and sweeps the heap on the main
    // thread, at points set by the code rather than by the machine's load, so that they measure the same on every run.
    execArgv: ['--no-concurrent-recompilation', '--no-concurrent-sweeping'],
  },
})
