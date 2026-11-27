import { defineConfig, devices } from '@playwright/test'

// Browser tests (#77): drive the playground on the committed test clips, without a camera.
// Requires the face model: `npm run fetch-models`.
// `OUAF_PORT=5199 npm run test:browser` uses another port (e.g. while a dev server runs on 5173).
const port = Number(process.env.OUAF_PORT) || 5173

export default defineConfig({
  testDir: 'e2e',
  // `OUAF_COVERAGE=1` (`npm run test:browser:coverage`): the tests record the engine code they run (e2e/coverage/).
  globalSetup: './e2e/coverage/global-setup.ts',
  timeout: 120_000,
  // Tests still run one at a time (one worker), but CI shards (`--shard`) split them per test rather than per file.
  fullyParallel: true,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // Reference images (e2e/demos.spec.ts) are the same for every platform: they are compared with a tolerance.
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}{ext}',
  use: {
    baseURL: `https://localhost:${port}`,
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // The full Chromium (new headless), not Playwright's default `chromium-headless-shell`: like desktop Chrome, it
        // runs the script sandbox's iframe in a process of its own, which the heap bomb of e2e/evil.spec.ts needs (#181).
        channel: 'chromium',
        launchOptions: {
          // Software WebGL (SwiftShader) when no GPU is available, e.g. in CI.
          args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
        },
      },
    },
    // The malicious filters (#27, e2e/evil.spec.ts) run on the three engines with `npm run test:security`, and only
    // there: `npm run test:browser` leaves that file out (`--grep-invert`), so that CI does not run it twice on Chromium.
    // The export and the other outputs (#137, e2e/export.spec.ts, e2e/outputs.spec.ts) also run on Firefox, in the
    // Firefox job of the same suite: its encoders differ (no H.264 on Linux, though `isConfigSupported` says yes), and
    // with a GPU it swaps red and blue drawing a WebGL canvas into a 2D `<canvas>`.
    {
      name: 'firefox',
      testMatch: ['evil.spec.ts', 'export.spec.ts', 'outputs.spec.ts'],
      use: {
        ...devices['Desktop Firefox'],
        // Headless Firefox has no WebGL on Linux: there it runs headed, under `xvfb-run` without a display (CI).
        headless: process.platform !== 'linux',
        launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true, 'media.autoplay.default': 0 } },
      },
    },
    { name: 'webkit', testMatch: 'evil.spec.ts', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `npm run dev -w @ouaf/playground -- --port ${port} --strictPort`,
    url: `https://localhost:${port}`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
