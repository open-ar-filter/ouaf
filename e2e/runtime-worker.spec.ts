import { expect, test, type Page } from '@playwright/test'
import type { Analysis } from './spike83.ts'

/**
 * Spike #83 (`/spikes/runtime.html`): the detector crop on WebGL2 (`detcrop=gpu`) and the LiteRT.js pipeline in a
 * worker (`mode=worker`).
 *
 * - GPU letterbox: same detector ROI and landmarks as the 2D-canvas letterbox;
 * - worker: wasm threads work inside it (the worker is cross-origin isolated, pthreads are started), same landmarks
 *   as the main-thread pipeline, tracking keeps running;
 * - fallbacks: a non-isolated page gets one thread in the worker with a warning; a worker that cannot load leaves the
 *   pipeline on the main thread with a warning.
 */

const CLIP = 'pesquet-talk'
/** Frontal frames of the clip. */
const FRAMES = [2, 4]

async function open(page: Page, query: string) {
  await page.goto(`/spikes/runtime.html?source=${CLIP}&autostart&${query}`)
  await page.waitForFunction(() => (window.__spike83?.runs ?? 0) > 5 || /unavailable|failed/.test(window.__spike83?.runtime ?? ''), undefined, {
    timeout: 60_000,
  })
  expect(await page.evaluate(() => window.__spike83!.runtime)).toMatch(/^ready: LiteRT\.js wasm/)
}

async function analyse(page: Page): Promise<Analysis[]> {
  const out: Analysis[] = []
  for (const at of FRAMES) {
    const a = await page.evaluate((s) => window.__spike83!.analyse(s), at)
    expect(a.found, `face found at ${at} s`).toBe(true)
    out.push(a)
  }
  return out
}

/** Mean landmark distance between two analyses, as a fraction of the detector ROI size (≈ 1.5× the face). */
function landmarkDistance(a: Analysis, b: Analysis): number {
  let sum = 0
  const n = a.landmarks.length / 3
  for (let i = 0; i < n; i++) sum += Math.hypot(a.landmarks[i * 3]! - b.landmarks[i * 3]!, a.landmarks[i * 3 + 1]! - b.landmarks[i * 3 + 1]!)
  return sum / n / a.detectorRoi!.size
}

test('detector crop on WebGL2: same detector ROI and landmarks as the 2D canvas', async ({ page, context }) => {
  await open(page, 'threads=1&crop=gpu&detcrop=gpu')
  const gpu = await analyse(page)
  const other = await context.newPage()
  try {
    await open(other, 'threads=1&crop=gpu&detcrop=canvas')
    const canvas = await analyse(other)
    gpu.forEach((g, i) => {
      const c = canvas[i]!
      const a = g.detectorRoi!
      const b = c.detectorRoi!
      console.log(`${FRAMES[i]} s: ROI Δcentre ${Math.hypot(a.cx - b.cx, a.cy - b.cy).toFixed(2)} px, Δsize ${(a.size - b.size).toFixed(2)} px, landmarks ${(landmarkDistance(g, c) * 100).toFixed(3)} %`)
      // Measured for a 420–515 px ROI: ≤ 0.4 px of centre, ≤ 1.4 px of size, landmarks ≤ 0.1 % (hardware GL);
      // ≤ 3 px, ≤ 5 px, ≤ 0.2 % with SwiftShader (CI).
      expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeLessThan(b.size * 0.02)
      expect(Math.abs(a.size - b.size)).toBeLessThan(b.size * 0.02)
      expect(Math.abs(a.rotation - b.rotation)).toBeLessThan(0.05)
      expect(landmarkDistance(g, c)).toBeLessThan(0.01)
    })
  } finally {
    await other.close()
  }
})

test('worker: threads inside the worker, same landmarks as the main thread', async ({ page, context }) => {
  const cores = await page.evaluate(() => navigator.hardwareConcurrency)
  const threads = Math.max(1, Math.min(4, cores))
  await open(page, `threads=${threads}&crop=gpu&mode=worker`)
  const s = await page.evaluate(() => ({ mode: window.__spike83!.mode, worker: window.__spike83!.worker, warnings: window.__spike83!.warnings }))
  expect(s.mode).toBe('worker')
  expect(s.warnings).toEqual([])
  expect(s.worker!.crossOriginIsolated).toBe(true)
  expect(s.worker!.options).toMatchObject({ threads, crop: 'gpu', detectorCrop: 'gpu' })
  // XNNPACK's thread pool: `threads - 1` pthreads per compiled model.
  if (threads > 1) expect(s.worker!.pthreads).toBeGreaterThanOrEqual(threads - 1)

  // Tracking keeps running in the worker while the page renders.
  const before = await page.evaluate(() => ({ frames: window.__spike83!.frames, runs: window.__spike83!.runs }))
  await page.waitForTimeout(2000)
  const after = await page.evaluate(() => ({ frames: window.__spike83!.frames, runs: window.__spike83!.runs }))
  expect(after.frames - before.frames).toBeGreaterThan(10)
  expect(after.runs - before.runs).toBeGreaterThan(5)

  const worker = await analyse(page)
  const other = await context.newPage()
  try {
    await open(other, `threads=${threads}&crop=gpu`)
    expect(await other.evaluate(() => window.__spike83!.mode)).toBe('main')
    const main = await analyse(other)
    worker.forEach((w, i) => {
      const d = landmarkDistance(w, main[i]!)
      console.log(`${FRAMES[i]} s: worker vs main thread, landmarks ${(d * 100).toFixed(3)} % of the ROI`)
      // Measured: 0.000 % on frontal frames, hardware GL and SwiftShader (the worker gets a VideoFrame, the main
      // thread reads the video element; borderline profile frames can differ in presence).
      expect(d).toBeLessThan(0.01)
    })
  } finally {
    await other.close()
  }
})

test('worker on a page that is not cross-origin isolated: one thread, with a warning', async ({ page }) => {
  await open(page, 'coi=0&threads=4&crop=gpu&mode=worker')
  const s = await page.evaluate(() => ({ isolated: crossOriginIsolated, mode: window.__spike83!.mode, worker: window.__spike83!.worker, warnings: window.__spike83!.warnings }))
  expect(s.isolated).toBe(false)
  expect(s.mode).toBe('worker')
  expect(s.worker!.crossOriginIsolated).toBe(false)
  expect(s.worker!.options.threads).toBe(1)
  expect(s.warnings.join(' ')).toMatch(/not cross-origin isolated/)
  expect(await page.locator('#status').textContent()).toContain('⚠')
})

test('worker that cannot load: the pipeline stays on the main thread, with a warning', async ({ page }) => {
  await page.route(/litert\.worker/, (route) => route.abort())
  await open(page, 'threads=1&crop=gpu&mode=worker')
  const s = await page.evaluate(() => ({ mode: window.__spike83!.mode, warnings: window.__spike83!.warnings }))
  expect(s.mode).toBe('main')
  expect(s.warnings.join(' ')).toMatch(/worker unavailable/)
})
