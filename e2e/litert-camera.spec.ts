import { expect, test } from './fixtures.ts'

/**
 * The LiteRT.js tracker on a camera (#165): its worker reads the frames straight from the camera's track
 * (`MediaStreamTrackProcessor`), or through the `<video>` with `?frames=element`. Chromium's fake camera (a synthetic
 * pattern, no face): what is checked is the path taken and that frames flow, not the faces.
 */
test.use({
  permissions: ['camera'],
  launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
})

for (const [query, frames] of [
  ['', 'camera track'],
  ['&frames=element', 'VideoFrame'],
] as const) {
  test(`camera frames reach the worker: ${frames}`, async ({ page }) => {
    await page.goto(`/engine.html?backend=litert&adapt=0&filter=/filters/fixtures/dot-tint/${query}`)
    await page.waitForFunction(() => !!window.ouaf)
    await page.click('#start')
    await expect
      .poll(() => page.evaluate(() => window.ouaf!.stats?.tracker ?? ''), { timeout: 60_000, intervals: [250, 500, 1000] })
      .toBe(`LiteRT.js wasm in a worker, WebGL2 crops read back async, ${frames} (forced)`)
    await expect.poll(() => page.evaluate(() => window.ouaf!.stats?.trackingHz ?? 0), { timeout: 30_000 }).toBeGreaterThan(5)
    expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
    expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])
  })
}
