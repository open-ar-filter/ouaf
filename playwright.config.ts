import { defineConfig, devices } from '@playwright/test'

// Browser tests (#77): drive the playground on the committed test clips, without a camera.
// Requires the face model: `npm run fetch-models`.
// `OUAF_PORT=5199 npm run test:browser` uses another port (e.g. while a dev server runs on 5173).
const port = Number(process.env.OUAF_PORT) || 5173

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // Reference images (e2e/demos.spec.ts) are the same for every platform: they are compared with a tolerance.
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}{ext}',
  use: {
    baseURL: `https://localhost:${port}`,
    ignoreHTTPSErrors: true,
    ...devices['Desktop Chrome'],
    launchOptions: {
      // Software WebGL (SwiftShader) when no GPU is available, e.g. in CI.
      args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    command: `npm run dev -w @ouaf/playground -- --port ${port} --strictPort`,
    url: `https://localhost:${port}`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
