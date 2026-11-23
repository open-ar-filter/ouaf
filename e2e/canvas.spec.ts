import { expect, test, type Page } from '@playwright/test'

/**
 * Canvas layer (#25) on `/engine.html`, in the real script sandbox: `filters/fixtures/canvas-screen/` lays canvases
 * out on the screen (no face needed, so pixel positions are known) on the `no-face` clip.
 */

const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }

type RGB = [number, number, number]
type Drawn = { id: string; n: number; time?: number }

declare global {
  interface Window {
    drawn?: Drawn[]
  }
}

/** Colors of the canvas as displayed at points of the screen frame (origin at the centre, +y up, 1 = screen height). */
async function colorsAt(page: Page, points: ReadonlyArray<readonly [number, number]>): Promise<RGB[]> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(
    async ([bytes, pts]) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]))
      const c = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      return pts.map(([x, y]) => {
        const px = Math.round(c.width / 2 + x * c.height)
        const py = Math.round(c.height / 2 - y * c.height)
        const sum: [number, number, number] = [0, 0, 0]
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const i = ((py + dy) * c.width + (px + dx)) * 4
            for (let k = 0; k < 3; k++) sum[k]! += d[i + k]!
          }
        }
        return sum.map((v) => Math.round(v / 9)) as [number, number, number]
      })
    },
    [png.toString('base64'), points] as const,
  )
}

const near = (c: RGB, expected: RGB, tolerance: number) => c.every((v, i) => Math.abs(v - expected[i]!) <= tolerance)

const drawn = (page: Page, id: string) => page.evaluate((id) => window.drawn!.filter((d) => d.id === id), id)

test('canvases drawn by the script: orientation, f.asset, invalidate(), fps, premultiplied alpha', async ({ page }) => {
  await page.goto('/engine.html?source=no-face&autostart&filter=/filters/fixtures/canvas-screen/')
  await page.waitForFunction(() => ((window.ouaf?.engine.filters.length ?? 0) > 0 && (window.ouaf?.frames ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, {
    timeout: 60_000,
  })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
  await page.evaluate(() => {
    window.drawn = []
    window.ouaf!.engine.filters[0]!.on('filter:drawn', (d) => window.drawn!.push(d as Drawn))
  })

  const points = {
    topLeft: [-0.25, 0.25], topRight: [-0.15, 0.25], bottomLeft: [-0.25, 0.15], bottomRight: [-0.15, 0.15],
    swatch: [0.2, 0.2], ticker: [0, -0.2], black: [0, -0.2 - 0.06],
  } as const
  const names = Object.keys(points) as Array<keyof typeof points>
  const sample = async () => {
    const colors = await colorsAt(page, names.map((n) => points[n]))
    return Object.fromEntries(names.map((n, i) => [n, colors[i]!])) as Record<keyof typeof points, RGB>
  }
  const check = (expected: Array<[keyof typeof points, RGB, number]>) =>
    expect
      .poll(async () => {
        const s = await sample()
        return expected.filter(([n, c, t]) => !near(s[n], c, t)).map(([n]) => `${n}: ${s[n].join(',')}`)
      }, POLL)
      .toEqual([])

  await check([
    // y down in the canvas, mirroring off: what is drawn at the top left shows at the top left.
    ['topLeft', [255, 0, 0], 10],
    ['topRight', [0, 255, 0], 10],
    ['bottomLeft', [0, 0, 255], 10],
    ['bottomRight', [255, 255, 0], 10], // f.asset('star'), an SVG asset
    ['swatch', [0, 255, 255], 10],
    // Half-transparent white over the black sticker: blended premultiplied, a mid-gray (not white).
    ['ticker', [128, 128, 128], 12],
    ['black', [0, 0, 0], 10],
  ])

  // fps 0: drawn once (before the listener was attached), then only after invalidate().
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.send('color', '#ff00ff'))
  await check([['swatch', [255, 0, 255], 10]])
  expect(await drawn(page, 'swatch')).toEqual([{ id: 'swatch', n: 2 }])

  // fps 4: about 4 draws per second of media time, never closer than 1/4 s.
  const before = (await drawn(page, 'ticker')).length
  await page.waitForTimeout(2000)
  const ticks = await drawn(page, 'ticker')
  expect(ticks.length - before).toBeGreaterThanOrEqual(5)
  expect(ticks.length - before).toBeLessThanOrEqual(10)
  for (let i = 1; i < ticks.length; i++) {
    const gap = ticks[i]!.time! - ticks[i - 1]!.time!
    if (gap > 0) expect(gap).toBeGreaterThanOrEqual(0.25 - 1e-6) // a negative gap is the clip looping
  }
  expect(await drawn(page, 'quads')).toEqual([])
  expect(await drawn(page, 'swatch')).toHaveLength(1)
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})

/**
 * Upload cost (#25): the time per rendered frame with one square canvas redrawn at 30 fps, by size. Reported as
 * annotations (headless Chromium: the numbers only compare sizes on the machine that runs the test).
 */
test('upload cost of a canvas redrawn at 30 fps, by size', async ({ page }) => {
  test.slow()
  await page.goto('/engine.html?source=no-face&autostart')
  await page.waitForFunction(() => (window.ouaf?.frames ?? 0) > 0, undefined, { timeout: 60_000 })
  const results: Record<string, number> = {}
  for (const size of [0, 128, 512, 1024, 2048]) {
    const ms = await page.evaluate(async (size) => {
      const { engine, memorySource } = window.ouaf!
      await engine.setFilters([])
      if (size > 0) {
        const code = `export default { draw: { c(ctx, f, frame) { ctx.fillStyle = 'hsl(' + Math.round(frame.time * 360) + ', 80%, 50%)'; ctx.fillRect(0, 0, ${size}, ${size}) } } }`
        await engine.addFilter(
          memorySource({
            manifest: {
              ouaf: '1', id: `upload-${size}`, name: 'upload', version: '1.0.0', license: 'CC0-1.0', requires: {},
              layers: [{ id: 'c', type: 'canvas', width: size, height: size, fps: 30, anchor: 'screen', size: 0.3 }],
              script: { entry: 'script.js', draw: ['c'] },
            },
            files: { 'script.js': code },
          }),
        )
      }
      // Two stats periods to settle, then the mean of the next three.
      const periods: number[] = []
      await new Promise<void>((resolve) => {
        const off = engine.on('stats', (s) => {
          periods.push(s.frameMs)
          if (periods.length === 5) {
            off()
            resolve()
          }
        })
      })
      return periods.slice(2).reduce((a, b) => a + b, 0) / 3
    }, size)
    results[size === 0 ? 'none' : `${size}²`] = ms
  }
  for (const [size, ms] of Object.entries(results)) test.info().annotations.push({ type: 'frame ms', description: `${size}: ${ms.toFixed(2)} ms` })
  console.log(`canvas upload, ms per frame: ${JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Number(v.toFixed(2))])))}`)
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})

type Drawing = { id: string; font: string; width: number; hash: number; aspect: number }

/**
 * Fonts of the filter in canvases and `frame.aspect` (#150, spec §12.4, §12.6), with `filters/fixtures/canvas-fonts/`:
 * the same words drawn in the declared font asset "title" (a built-in font under a name of the filter) and in an
 * undeclared family (the platform's fallback). The script reports a hash of each image and the measured width.
 */
async function fontDrawings(page: Page, query = ''): Promise<{ draws: Drawing[]; aspects: number[]; size: [number, number] }> {
  await page.goto(`/engine.html?source=no-face&autostart${query}`)
  await page.waitForFunction(() => (window.ouaf?.frames ?? 0) > 0 || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  return page.evaluate(async () => {
    const draws: Drawing[] = []
    const aspects: number[] = []
    const handle = await window.ouaf!.engine.addFilter('/filters/fixtures/canvas-fonts/')
    handle.on('filter:drawn', (d) => void draws.push(d as Drawing))
    handle.on('filter:aspect', (a) => void aspects.push(a as number))
    const until = async (test: () => boolean) => {
      for (let i = 0; i < 200 && !test(); i++) await new Promise((r) => setTimeout(r, 50))
    }
    await until(() => draws.length >= 2 && aspects.length > 0)
    handle.send('redraw')
    await until(() => draws.length >= 4)
    const canvas = document.getElementById('canvas') as HTMLCanvasElement
    return { draws, aspects, size: [canvas.width, canvas.height] as [number, number] }
  })
}

test('a canvas draws text with the filter’s declared font, by its asset name', async ({ page }) => {
  const { draws } = await fontDrawings(page)
  expect(await page.evaluate(() => [window.ouaf!.errors, window.ouaf!.warnings])).toEqual([[], []])
  const declared = draws.filter((d) => d.id === 'declared')
  const fallback = draws.filter((d) => d.id === 'fallback')
  expect(declared).toHaveLength(2)
  expect(fallback).toHaveLength(2)
  expect(declared[0]!.font).toBe('28px title')
  // The declared font is not the fallback: other glyph widths and other pixels.
  expect(Math.abs(declared[0]!.width - fallback[0]!.width)).toBeGreaterThan(2)
  expect(declared[0]!.hash).not.toBe(fallback[0]!.hash)
  // Stable: the same image at every draw, and in another page (the reference screenshots of canvases rely on it).
  expect(declared[1]!.hash).toBe(declared[0]!.hash)
  const again = await fontDrawings(page)
  expect(again.draws.find((d) => d.id === 'declared')!.hash).toBe(declared[0]!.hash)
})

test('frame.aspect is the displayed width / height', async ({ page }) => {
  const { draws, aspects, size } = await fontDrawings(page)
  const expected = size[0] / size[1]
  expect(expected).toBeCloseTo(720 / 1280, 3) // the clip's own frame, 9:16
  expect(aspects).toEqual([expected])
  expect(draws.every((d) => d.aspect === expected)).toBe(true)
})
