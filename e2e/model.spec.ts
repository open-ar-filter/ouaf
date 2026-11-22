import { expect, test, type Page } from '@playwright/test'

/**
 * Model layer (#21) on `/engine.html`: `filters/fixtures/model-screen/` lays models out on the screen (no face needed,
 * so pixel positions are known) on the `no-face` clip; `filters/fixtures/model/` attaches them to a face.
 */

const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }

type RGB = [number, number, number]

/** The canvas as displayed (screenshot decoded in the page): RGB at points of the screen frame, 3 × 3 averaged. */
async function colorsAt(page: Page, points: ReadonlyArray<readonly [number, number]>): Promise<RGB[]> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(
    async ([bytes, pts]) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
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
    [[...png], points] as const,
  )
}

/** Number of pixels of the canvas that `test` accepts. */
async function countPixels(page: Page, test: string): Promise<number> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(
    async ([bytes, body]) => {
      const accept = new Function('r', 'g', 'b', `return ${body}`) as (r: number, g: number, b: number) => boolean
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
      const c = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (accept(d[i]!, d[i + 1]!, d[i + 2]!)) n++
      return n
    },
    [[...png], test] as const,
  )
}

const near = (c: RGB, expected: RGB, tolerance: number) => c.every((v, i) => Math.abs(v - expected[i]!) <= tolerance)
const magenta = (c: RGB) => c[0] - c[1] > 40 && c[2] - c[1] > 40

test('screen models: GLB, Draco, meshopt, sRGB output with and without a pass, fit, animation, shapes', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (r) => requests.push(new URL(r.url()).pathname))
  await page.goto('/engine.html?source=no-face&autostart&filter=/filters/fixtures/model-screen/')
  await page.waitForFunction(() => ((window.ouaf?.engine.filters.length ?? 0) > 0 && (window.ouaf?.frames ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])
  // The Draco decoder comes from the engine's assets folder, nowhere else.
  expect(requests.filter((p) => p.startsWith('/draco/'))).toEqual(['/draco/draco_wasm_wrapper.js', '/draco/draco_decoder.wasm'])

  const points = {
    red: [-0.15, 0.3], green: [0, 0.3], blue: [0.15, 0.3], gray: [-0.15, 0.12],
    fitLeft: [0.05, 0.12], fitRight: [0.15, 0.12], fitOutside: [0.23, 0.12],
  } as const
  const names = Object.keys(points) as Array<keyof typeof points>
  const sample = async () => {
    const colors = await colorsAt(page, names.map((n) => points[n]))
    return Object.fromEntries(names.map((n, i) => [n, colors[i]!])) as Record<keyof typeof points, RGB>
  }
  // Unlit materials: the canvas gets the sRGB encoding of the linear base color (0.2158605 → 128).
  const expected: Array<[keyof typeof points, RGB, number]> = [
    ['red', [255, 0, 0], 6],
    ['green', [0, 255, 0], 6],
    ['blue', [0, 0, 255], 6],
    ['gray', [128, 128, 128], 3],
    ['fitLeft', [128, 128, 128], 3],
    ['fitRight', [128, 128, 128], 3],
  ]
  const check = async () => {
    const s = await sample()
    const wrong = expected.filter(([n, c, t]) => !near(s[n], c, t)).map(([n]) => `${n}: ${s[n].join(',')}`)
    if (near(s.fitOutside, [128, 128, 128], 3)) wrong.push(`fitOutside: ${s.fitOutside.join(',')} (the cube is wider than its fit)`)
    return wrong
  }
  await expect.poll(check, POLL).toEqual([])

  // The same colors when a pass is active (objects drawn into an sRGB render target, then copied).
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.setParam('contrast', 0.001, { transition: 0 }))
  await expect.poll(check, POLL).toEqual([])
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.setParam('contrast', 0, { transition: 0 }))

  // Procedural shapes, lit magenta; torus and ring sampled on their band.
  const shapes: Array<readonly [number, number]> = [
    [-0.24, -0.3], [-0.16, -0.3], [-0.08, -0.3 + 0.4 * 0.06], [0, -0.3 + 0.4 * 0.06], [0.08, -0.3], [0.16, -0.3], [0.24, -0.3],
  ]
  await expect.poll(async () => (await colorsAt(page, shapes)).map((c, i) => (magenta(c) ? 'ok' : `${i}: ${c.join(',')}`)), POLL).toEqual(Array(7).fill('ok'))

  // The yellow cube's `lift` animation moves it up 0.12 screen heights and back every 2 s.
  const seen = new Set<string>()
  await expect
    .poll(async () => {
      const [low, high] = await colorsAt(page, [[-0.15, -0.12], [-0.15, 0.04]])
      if (near(low!, [255, 255, 0], 10) && !near(high!, [255, 255, 0], 60)) seen.add('low')
      if (near(high!, [255, 255, 0], 10) && !near(low!, [255, 255, 0], 60)) seen.add('high')
      return [...seen].sort()
    }, { timeout: 30_000, intervals: [150] })
    .toEqual(['high', 'low'])
})

test('a model on the face: head occlusion hides what is behind the head, not what is in front', async ({ page }) => {
  await page.goto('/engine.html?source=pesquet-closeup&autostart&filter=/filters/fixtures/model/')
  await page.waitForFunction(() => ((window.ouaf?.stats?.faces ?? 0) > 0 && (window.ouaf?.stats?.trackingHz ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])

  // Emissive spheres: magenta inside the head, green in front of the nose.
  const MAGENTA = 'r > 180 && b > 180 && g < 100'
  const GREEN = 'g > 180 && r < 120 && b < 120'
  const shot = async (name: string) => process.env.SHOTS && (await page.locator('#canvas').screenshot({ path: `shots/model-${name}.png` }))

  // With occlusion: the sphere inside the head is hidden, the one in front of the face is drawn.
  await expect
    .poll(async () => {
      const [magenta, green] = [await countPixels(page, MAGENTA), await countPixels(page, GREEN)]
      return magenta < 20 && green > 300 ? 'ok' : `magenta ${magenta}, green ${green}`
    }, POLL)
    .toBe('ok')
  await shot('occluded')

  // Without any occluder, the same sphere shows over the face.
  await page.evaluate(() => {
    const f = window.ouaf!.engine.filters[0]!
    f.setParam('occluded', false)
    f.setParam('plain', true)
  })
  await expect.poll(() => countPixels(page, MAGENTA), POLL).toBeGreaterThan(2000)
  await shot('plain')
})
