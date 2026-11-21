import { defineConfig, devices } from '@playwright/test'

// Browser tests (#77): drive the playground on the committed test clips, without a camera.
// Requires the face model: `npm run fetch-models`.
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'https://localhost:5173',
    ignoreHTTPSErrors: true,
    ...devices['Desktop Chrome'],
    launchOptions: {
      // Software WebGL (SwiftShader) when no GPU is available, e.g. in CI.
      args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    command: 'npm run dev',
    url: 'https://localhost:5173',
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
