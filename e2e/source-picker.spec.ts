import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from './fixtures.ts'

/**
 * The source picker of the playground (#36): a test clip, a camera (Chromium's fake one) or a video file, picked
 * before Start or switched live; the filters stay on, `?source=` follows.
 */
test.use({
  permissions: ['camera'],
  launchOptions: { args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
})

const source = (page: Page) => page.evaluate(() => window.ouaf!.source)
const query = (page: Page) => new URL(page.url()).search
/** Frames rendered since `since`: the engine keeps drawing on the new source. */
const framesAfter = async (page: Page) => {
  const before = await page.evaluate(() => window.ouaf!.frames)
  await expect.poll(() => page.evaluate(() => window.ouaf!.frames), { timeout: 15_000 }).toBeGreaterThan(before)
}

test('the picker switches a running page from clip to clip, to the camera and to a video file', async ({ page }) => {
  await page.goto('/engine.html?source=pesquet-talk&autostart&filter=/filters/glasses/')
  await expect.poll(() => source(page), { timeout: 60_000 }).toBe('test-media/pesquet-talk.mp4')
  await expect.poll(() => page.evaluate(() => window.ouaf!.engine.filters.length), { timeout: 60_000 }).toBe(1)
  // The clips of test-media/.
  await expect(page.locator('#source-picker option[value="no-face"]')).toBeAttached()
  await expect(page.locator('#source-picker')).toHaveValue('pesquet-talk')

  await page.locator('#source-picker').selectOption('two-faces')
  await expect.poll(() => source(page), { timeout: 30_000 }).toBe('test-media/two-faces.mp4')
  expect(query(page)).toBe('?source=two-faces&autostart&filter=/filters/glasses/')
  // One <video>, playing the new clip; the stack is untouched.
  expect(await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => `${v.id} ${v.src.split('/').at(-1)}`))).toEqual(['video two-faces.mp4'])
  expect(await page.evaluate(() => window.ouaf!.engine.filters.map((f) => f.id))).toEqual(['glasses'])
  await framesAfter(page)

  await page.locator('#source-picker').selectOption('camera')
  await expect.poll(() => source(page), { timeout: 30_000 }).toBe('camera (front)')
  expect(query(page)).toBe('?autostart&filter=/filters/glasses/')
  await page.locator('#source-picker').selectOption('camera-back')
  await expect.poll(() => source(page), { timeout: 30_000 }).toBe('camera (back)')
  expect(query(page)).toBe('?source=camera-back&autostart&filter=/filters/glasses/')
  await framesAfter(page)

  await page.locator('#source-file').setInputFiles({ name: 'mine.mp4', mimeType: 'video/mp4', buffer: await readFile('test-media/no-face.mp4') })
  await expect.poll(() => source(page), { timeout: 30_000 }).toBe('mine.mp4 (a file)')
  await expect(page.locator('#source-picker')).toHaveValue('file')
  // A file is not kept in the URL: it keeps the source it had.
  expect(query(page)).toBe('?source=camera-back&autostart&filter=/filters/glasses/')
  await framesAfter(page)
  expect(await page.evaluate(() => document.querySelectorAll('video').length)).toBe(1)
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})

test('a source picked before Start is the one Start opens', async ({ page }) => {
  await page.goto('/engine.html?filter=/filters/glasses/')
  await expect(page.locator('#source-picker')).toHaveValue('camera')
  await expect(page.locator('#source-picker option[value="no-face"]')).toBeAttached()
  await page.locator('#source-picker').selectOption('no-face')
  expect(query(page)).toBe('?source=no-face&filter=/filters/glasses/')
  expect(await source(page)).toBeUndefined()
  await page.locator('#start').click()
  await expect.poll(() => source(page), { timeout: 60_000 }).toBe('test-media/no-face.mp4')
  await expect.poll(() => page.evaluate(() => window.ouaf!.engine.filters.length), { timeout: 60_000 }).toBe(1)
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})
