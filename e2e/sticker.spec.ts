import { expect, test, type Page } from './fixtures.ts'

/**
 * Sticker layer (#20) on `/engine.html`: `filters/fixtures/sticker-screen/` lays stickers out on the screen (no face
 * needed, so pixel positions are known) on the `no-face` clip; `filters/fixtures/sticker/` attaches them to a face.
 */

const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }

type RGB = [number, number, number]

/**
 * Colors of the canvas as displayed (screenshot decoded by the browser) at points of the screen frame (spec §5.2:
 * origin at the centre, +y up, 1 unit = screen height), each averaged over 3 × 3 pixels.
 */
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

test('screen stickers: image formats, blend modes, packed-alpha video, spritesheet', async ({ page }) => {
  await page.goto('/engine.html?source=no-face&autostart&filter=/filters/fixtures/sticker-screen/')
  await page.waitForFunction(() => (window.ouaf?.engine.filters.length ?? 0) > 0 && (window.ouaf?.frames ?? 0) > 0 || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])

  const points = {
    png: [-0.2, 0.3], webp: [-0.1, 0.3], jpeg: [0, 0.3], avif: [0.1, 0.3], svg: [0.2, 0.3],
    normal: [-0.18, 0.1], add: [-0.06, 0.1], multiply: [0.06, 0.1], screen: [0.18, 0.1],
    videoCentre: [-0.12, -0.2], videoCorner: [-0.12 - 0.083, -0.2 + 0.083], sheet: [0.12, -0.2],
  } as const
  const names = Object.keys(points) as Array<keyof typeof points>
  const sample = async () => {
    const colors = await colorsAt(page, names.map((n) => points[n]))
    return Object.fromEntries(names.map((n, i) => [n, colors[i]!])) as Record<keyof typeof points, RGB>
  }

  const expected: Array<[keyof typeof points, RGB, number]> = [
    ['png', [255, 0, 255], 10],
    ['webp', [0, 255, 255], 10],
    ['jpeg', [255, 128, 0], 16],
    ['avif', [128, 255, 0], 16],
    ['svg', [255, 255, 0], 10],
    // Mid-gray (0.5) over mid-gray, on sRGB-encoded values: normal 0.5, add 1, multiply 0.25, screen 0.75.
    ['normal', [128, 128, 128], 6],
    ['add', [255, 255, 255], 6],
    ['multiply', [64, 64, 64], 6],
    ['screen', [192, 192, 192], 6],
    // Packed alpha: the color half's blue inside the mask's disc, the white background outside it.
    ['videoCentre', [0, 0, 255], 40],
    ['videoCorner', [255, 255, 255], 20],
  ]
  await expect
    .poll(async () => {
      const s = await sample()
      const wrong = expected.filter(([n, c, t]) => !near(s[n], c, t)).map(([n]) => `${n}: ${s[n].join(',')}`)
      return wrong
    }, POLL)
    .toEqual([])

  // The spritesheet alternates red and green frames at 4 fps.
  const seen = new Set<string>()
  await expect
    .poll(async () => {
      const c = (await sample()).sheet
      if (near(c, [255, 0, 0], 30)) seen.add('red')
      if (near(c, [0, 255, 0], 30)) seen.add('green')
      return [...seen].sort()
    }, POLL)
    .toEqual(['green', 'red'])
})

test('a video made by `ouaf pack-alpha` shows its transparency in a sticker', async ({ page }) => {
  // assets/ring.mp4 (make-sticker-assets.sh): `ouaf pack-alpha` of a WebM VP9 with alpha, 0.14 high, over a white
  // square. Source: a red disc on blue; alpha 1 for r < 0.3 (relative to the height), 0.5 up to 0.42, 0 outside.
  await page.goto('/engine.html?source=no-face&autostart&filter=/filters/fixtures/sticker-screen/')
  await page.waitForFunction(() => (window.ouaf?.engine.filters.length ?? 0) > 0 && (window.ouaf?.frames ?? 0) > 0 || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])

  const y = -0.38
  const points: Array<[string, readonly [number, number], RGB, number]> = [
    ['opaque centre: the color', [0, y], [255, 0, 0], 30],
    ['half-transparent ring: color and white mixed', [0.36 * 0.14, y], [255, 128, 128], 30],
    ['transparent corner: the white below, no blue', [0.06, y + 0.06], [255, 255, 255], 20],
  ]
  await expect
    .poll(async () => {
      const colors = await colorsAt(page, points.map(([, p]) => p))
      return points.flatMap(([name, , e, t], i) => (near(colors[i]!, e, t) ? [] : [`${name}: ${colors[i]!.join(',')}`]))
    }, POLL)
    .toEqual([])
})

test('face stickers follow the tracked face', async ({ page }) => {
  await page.goto('/engine.html?source=pesquet-closeup&autostart&filter=/filters/fixtures/sticker/')
  await page.waitForFunction(() => ((window.ouaf?.stats?.faces ?? 0) > 0 && (window.ouaf?.stats?.trackingHz ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])

  // The magenta disc on the nose tip: present while the face is tracked, gone with the layer hidden.
  const magenta = async () => {
    const png = await page.locator('#canvas').screenshot()
    return page.evaluate(async (bytes) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]))
      const c = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i]! > 200 && d[i + 1]! < 80 && d[i + 2]! > 200) n++
      return n
    }, png.toString('base64'))
  }
  await expect.poll(magenta, POLL).toBeGreaterThan(50)
})

test('KTX2 stickers (#177): RGBA8, ETC1S and UASTC, sRGB values as they are, straight alpha premultiplied', async ({ page }) => {
  // filters/fixtures/sticker-ktx2/ (make-ktx2-assets.ts): rings of side 0.18 over black squares. A ring is magenta,
  // opaque for r < 0.3 of its side, half transparent up to 0.42, transparent outside, where its color is green.
  await page.goto('/engine.html?source=no-face&autostart&filter=/filters/fixtures/sticker-ktx2/')
  await page.waitForFunction(() => (window.ouaf?.engine.filters.length ?? 0) > 0 && (window.ouaf?.frames ?? 0) > 0 || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])

  // ETC1S is lossy: wider tolerances. Whatever GPU format the Basis files are transcoded to, the values stay sRGB.
  const rings: Array<[string, number, number, number, number]> = [['RGBA8', -0.15, 0.1, 0.18, 0], ['ETC1S', 0.15, 0.1, 0.18, 16]]
  const points = rings.flatMap(([name, x, y, side, lossy]): Array<[string, readonly [number, number], RGB, number]> => [
    [`${name} opaque centre`, [x, y], [255, 0, 255], 20 + lossy],
    [`${name} half-transparent ring: magenta over black`, [x + 0.36 * side, y], [128, 0, 128], 24 + lossy],
    [`${name} transparent corner: black, no green`, [x + 0.07, y + 0.07], [0, 0, 0], 12 + lossy],
  ])
  points.push(['UASTC (Zstandard) image', [-0.15, -0.2], [48, 96, 192], 12])
  await expect
    .poll(async () => {
      const colors = await colorsAt(page, points.map(([, p]) => p))
      return points.flatMap(([name, , e, t], i) => (near(colors[i]!, e, t) ? [] : [`${name}: ${colors[i]!.join(',')}`]))
    }, POLL)
    .toEqual([])

  // The UASTC spritesheet alternates its red and green frames at 4 fps.
  const seen = new Set<string>()
  await expect
    .poll(async () => {
      const [c] = await colorsAt(page, [[0.15, -0.2]])
      if (near(c!, [255, 0, 0], 30)) seen.add('red')
      if (near(c!, [0, 255, 0], 30)) seen.add('green')
      return [...seen].sort()
    }, POLL)
    .toEqual(['green', 'red'])
})
