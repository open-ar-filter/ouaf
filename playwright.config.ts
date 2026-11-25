import { defineConfig, devices } from '@playwright/test'

// Browser tests (#77): drive the playground on the committed test clips, without a camera.
// Requires the face model: `npm run fetch-models`.
// `OUAF_PORT=5199 npm run test:browser` uses another port (e.g. while a dev server runs on 5173).
const port = Number(process.env.OUAF_PORT) || 5173

export default defineConfig({
  testDir: 'e2e',
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
        launchOptions: {
          // Software WebGL (SwiftShader) when no GPU is available, e.g. in CI.
          args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
        },
      },
    },
    // The malicious filters (#27) also run on the other engines: `npm run test:security`.
    {
      name: 'firefox',
      testMatch: 'evil.spec.ts',
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
