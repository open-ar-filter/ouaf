import { expect, test, type Page } from './fixtures.ts'
import type { OuafTestHook } from '../apps/playground/src/test-hook.ts'

type Snapshot = Pick<OuafTestHook, 'frames' | 'faceCounts' | 'orderedFrames' | 'error' | 'delegate' | 'lastAnchors'>

/** Plays a test clip once through the playground pipeline and returns the counters of `window.ouafTest`. */
async function playOnce(page: Page, clip: string, extra = ''): Promise<Snapshot> {
  await page.goto(`/?source=${clip}&loop=0&autostart&test${extra}`)
  await page.waitForFunction(() => (window.ouafTest?.frames ?? 0) > 0 || window.ouafTest?.error, undefined, { timeout: 60_000 })
  await page.evaluate(() => window.ouafTest!.runStepwise(0.1))
  const s = await page.evaluate(() => {
    const t = window.ouafTest!
    return { frames: t.frames, faceCounts: [...t.faceCounts], orderedFrames: t.orderedFrames, error: t.error, delegate: t.delegate, lastAnchors: t.lastAnchors }
  })
  expect(s.error).toBeNull()
  expect(s.frames).toBeGreaterThan(10)
  return s
}

const withFace = (s: Snapshot) => s.faceCounts.reduce((sum, n, faces) => sum + (faces > 0 ? (n ?? 0) : 0), 0)
const maxFaces = (s: Snapshot) => s.faceCounts.reduce((max, n, faces) => ((n ?? 0) > 0 ? faces : max), 0)

// Thresholds measured with the deterministic step-by-step run (0.1 s steps, headless Chromium, software WebGL),
// with a margin: they catch regressions, not MediaPipe's limits (3/4 profiles and small faces are often missed).

test('one face in close-up, talking: tracked, anchors in anatomical order', async ({ page }) => {
  const s = await playOnce(page, 'pesquet-talk')
  expect(withFace(s) / s.frames).toBeGreaterThan(0.4)
  expect(s.orderedFrames / withFace(s)).toBeGreaterThan(0.95)
})

test('large motion: the face is tracked while walking towards the camera', async ({ page }) => {
  const s = await playOnce(page, 'pesquet-walk')
  expect(withFace(s) / s.frames).toBeGreaterThan(0.35)
  expect(s.orderedFrames / withFace(s)).toBeGreaterThan(0.95)
})

test('occlusion and dim light: the face is still found', async ({ page }) => {
  const s = await playOnce(page, 'pesquet-closeup')
  expect(withFace(s) / s.frames).toBeGreaterThan(0.8)
})

test('fast head turn', async ({ page }) => {
  const s = await playOnce(page, 'pesquet-turn')
  expect(withFace(s) / s.frames).toBeGreaterThan(0.6)
})

test('two faces with maxFaces=4', async ({ page }) => {
  const s = await playOnce(page, 'two-faces-stacked', '&maxFaces=4')
  expect(maxFaces(s)).toBe(2)
  expect((s.faceCounts[2] ?? 0) / s.frames).toBeGreaterThan(0.5)
})

test('four faces with maxFaces=4', async ({ page }) => {
  const s = await playOnce(page, 'four-faces-grid', '&maxFaces=4')
  expect(maxFaces(s)).toBe(4)
  expect((s.faceCounts[4] ?? 0) / s.frames).toBeGreaterThan(0.5)
})

test('three faces with maxFaces=4', async ({ page }) => {
  const s = await playOnce(page, 'three-faces-grid', '&maxFaces=4')
  expect(maxFaces(s)).toBe(3)
  expect((s.faceCounts[3] ?? 0) / s.frames).toBeGreaterThan(0.5)
})

test('maxFaces=2 caps the four faces at 2', async ({ page }) => {
  const s = await playOnce(page, 'four-faces-grid', '&maxFaces=2')
  expect(maxFaces(s)).toBe(2)
})

test('maxFaces=1 keeps a single face', async ({ page }) => {
  const s = await playOnce(page, 'two-faces-stacked', '&maxFaces=1')
  expect(maxFaces(s)).toBe(1)
})

test('no face: nothing is detected', async ({ page }) => {
  const s = await playOnce(page, 'no-face')
  expect(withFace(s)).toBe(0)
})

test('mirroring flips the rendered image horizontally', async ({ page }) => {
  const snapshot = async (mirror: string) => {
    await page.goto(`/?source=pesquet-talk&autostart&test&mirror=${mirror}`)
    await page.waitForFunction(() => (window.ouafTest?.frames ?? 0) > 2 || window.ouafTest?.error)
    await page.evaluate(() => window.ouafTest!.seek(4))
    return page.evaluate(() => window.ouafTest!.thumbnail)
  }
  const plain = await snapshot('0')
  const mirrored = await snapshot('1')
  const size = Math.sqrt(plain.length)
  expect(size).toBe(16)
  const flipped = plain.map((_, i) => plain[Math.floor(i / size) * size + (size - 1 - (i % size))]!)
  const diff = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0) / a.length
  // The mirrored render matches the flipped plain one, and the image is not symmetric to begin with.
  expect(diff(mirrored, flipped)).toBeLessThan(6)
  expect(diff(mirrored, plain)).toBeGreaterThan(10)
})
