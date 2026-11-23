import { expect, test, type Page } from '@playwright/test'

/**
 * Content properties bound to params (#140) on `/engine.html`: `filters/fixtures/content/` lays screen layers out on
 * the `no-face` clip (pixel positions are known): a sticker whose `src` follows a `select` param, one that shows the
 * host's file (an `asset` param), one whose `src` the script sets, a model and a font chosen by `select` params, and a
 * color layer whose LUT a `select` param and the script choose.
 */

const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }
const FILTER = '/filters/fixtures/content/'

type RGB = [number, number, number]

interface ParamErrorInfo {
  name: string
  reason: string | undefined
  param: string | undefined
  message: string
}

declare global {
  interface Window {
    paramErrors?: ParamErrorInfo[]
  }
}

/** The canvas as displayed (screenshot decoded in the page): RGB at points of the screen frame, 3 × 3 averaged. */
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

/** Mean chroma (max − min channel) of the canvas below y = −0.15 (the graded clip, no layer there). */
async function chromaBelow(page: Page): Promise<number> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]))
    const c = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const top = Math.round(c.height / 2 + 0.15 * c.height)
    const d = ctx.getImageData(0, top, c.width, c.height - top).data
    let chroma = 0
    for (let i = 0; i < d.length; i += 4) chroma += Math.max(d[i]!, d[i + 1]!, d[i + 2]!) - Math.min(d[i]!, d[i + 1]!, d[i + 2]!)
    return chroma / (d.length / 4)
  }, png.toString('base64'))
}

/** Yellow pixels (the text layer) in the right half of the canvas, between y = −0.05 and 0.15. */
async function yellowText(page: Page): Promise<number> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]))
    const c = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const y0 = Math.round(c.height / 2 - 0.15 * c.height)
    const d = ctx.getImageData(Math.round(c.width / 2), y0, Math.round(c.width / 2), Math.round(0.2 * c.height)).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i]! > 200 && d[i + 1]! > 200 && d[i + 2]! < 90) n++
    return n
  }, png.toString('base64'))
}

const near = (c: RGB, expected: RGB, tolerance: number) => c.every((v, i) => Math.abs(v - expected[i]!) <= tolerance)

const STYLED = [-0.2, 0.3] as const
const LOGO = [0, 0.3] as const
const SCRIPTED = [0.2, 0.3] as const
const MODEL = [-0.15, 0.05] as const

async function open(page: Page): Promise<void> {
  await page.goto(`/engine.html?source=no-face&autostart&filter=${FILTER}`)
  await page.waitForFunction(() => ((window.ouaf?.engine.filters.length ?? 0) > 0 && (window.ouaf?.frames ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, {
    timeout: 60_000,
  })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
  await page.evaluate(() => {
    window.paramErrors = []
    window.ouaf!.engine.on('error', (e) => {
      const p = e as Error & { reason?: string; param?: string }
      window.paramErrors!.push({ name: p.name, reason: p.reason, param: p.param, message: p.message })
    })
  })
}

const setParam = (page: Page, name: string, value: unknown) =>
  page.evaluate(([name, value]) => window.ouaf!.engine.filters[0]!.setParam(name as string, value), [name, value] as const)

/** Sets the `logo` asset param to a file made in the page: a PNG of `color`, or the bytes given. */
const setLogo = (page: Page, file: { color: string } | { bytes: number[]; name: string; type: string }) =>
  page.evaluate(async (file) => {
    let blob: Blob
    if ('color' in file) {
      const c = new OffscreenCanvas(32, 32)
      const ctx = c.getContext('2d')!
      ctx.fillStyle = file.color
      ctx.fillRect(0, 0, 32, 32)
      blob = new File([await c.convertToBlob({ type: 'image/png' })], 'logo.png', { type: 'image/png' })
    } else blob = new File([new Uint8Array(file.bytes)], file.name, { type: file.type })
    window.ouaf!.engine.filters[0]!.setParam('logo', blob)
  }, file)

/** A PNG header claiming 5000 × 5000 px: refused from its header, before decoding (spec §10.4, §15). */
function hugePngHeader(): number[] {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(5000), ...be32(5000), 8, 6, 0, 0, 0, 0, 0, 0, 0]
}

test('a select param chooses the sticker, the model and the font among the filter\'s own assets', async ({ page }) => {
  await open(page)
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])
  const sample = async () => {
    const [styled, model] = await colorsAt(page, [STYLED, MODEL])
    return { styled: styled!, model: model! }
  }
  await expect.poll(async () => {
    const s = await sample()
    return near(s.styled, [255, 0, 0], 12) && near(s.model, [255, 0, 0], 12)
  }, POLL).toBe(true)
  const sans = await yellowText(page)
  expect(sans).toBeGreaterThan(100)

  await setParam(page, 'style', 'green')
  await setParam(page, 'shape', 'gray')
  await setParam(page, 'font', 'mono')
  await expect.poll(async () => {
    const s = await sample()
    return near(s.styled, [0, 255, 0], 12) && near(s.model, [128, 128, 128], 12)
  }, POLL).toBe(true)
  // Another font draws other glyphs: the yellow area changes.
  await expect.poll(async () => Math.abs((await yellowText(page)) - sans) > sans * 0.05, POLL).toBe(true)
  expect(await page.evaluate(() => window.paramErrors)).toEqual([])
})

test('an asset param shows the host\'s file; a file that fails the checks is refused and the previous one is kept', async ({ page }) => {
  await open(page)
  const logo = async () => (await colorsAt(page, [LOGO]))[0]!
  // No file yet (optional): the layer is hidden.
  await expect.poll(async () => near(await logo(), [255, 0, 255], 40), POLL).toBe(false)

  await setLogo(page, { color: '#ff00ff' })
  await expect.poll(async () => near(await logo(), [255, 0, 255], 12), POLL).toBe(true)
  expect(await page.evaluate(() => (window.ouaf!.engine.filters[0]!.params.logo as File).name)).toBe('logo.png')

  // Too large, read from its header: refused with an InvalidParamError; the magenta logo stays.
  await setLogo(page, { bytes: hugePngHeader(), name: 'huge.png', type: 'image/png' })
  await expect.poll(() => page.evaluate(() => window.paramErrors!.length), POLL).toBe(1)
  const [huge] = await page.evaluate(() => window.paramErrors!)
  expect(huge).toMatchObject({ name: 'InvalidParamError', reason: 'content', param: 'logo' })
  expect(huge!.message).toMatch(/"huge\.png" is 5000×5000 px: images are limited to 4096 px per side/)
  // Text declared as a PNG: its content decides.
  await setLogo(page, { bytes: [...new TextEncoder().encode('not an image')], name: 'fake.png', type: 'image/png' })
  await expect.poll(() => page.evaluate(() => window.paramErrors!.length), POLL).toBe(2)
  const [, fake] = await page.evaluate(() => window.paramErrors!)
  expect(fake).toMatchObject({ name: 'InvalidParamError', reason: 'content', param: 'logo' })
  expect(fake!.message).toMatch(/"fake\.png": its content is text, not an image this parameter accepts/)
  await page.waitForTimeout(300)
  expect(near(await logo(), [255, 0, 255], 12)).toBe(true)
  expect(await page.evaluate(() => (window.ouaf!.engine.filters[0]!.params.logo as File).name)).toBe('logo.png')

  // Another valid file replaces it; removing the file (optional param) hides the layer.
  await setLogo(page, { color: '#00ffff' })
  await expect.poll(async () => near(await logo(), [0, 255, 255], 12), POLL).toBe(true)
  await setParam(page, 'logo', null)
  await expect.poll(async () => near(await logo(), [0, 255, 255], 40), POLL).toBe(false)
  expect(await page.evaluate(() => window.ouaf!.warnings)).toEqual([])
})

test('the params panel gives an asset param a file picker', async ({ page }) => {
  await open(page)
  const png = await page.evaluate(async () => {
    const c = new OffscreenCanvas(16, 16)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ff00ff'
    ctx.fillRect(0, 0, 16, 16)
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
    return btoa(String.fromCharCode(...bytes))
  })
  const picker = page.locator('#params input[type=file]')
  await expect(picker).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp,image/svg+xml')
  await picker.setInputFiles({ name: 'mine.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  await expect.poll(async () => near((await colorsAt(page, [LOGO]))[0]!, [255, 0, 255], 12), POLL).toBe(true)
  await expect(page.locator('#params')).toContainText('mine.png')
})

test('a script sets src and lut to declared assets, and null restores the manifest value', async ({ page }) => {
  await open(page)
  const scripted = async () => (await colorsAt(page, [SCRIPTED]))[0]!
  const send = (name: string, data: unknown) =>
    page.evaluate(([name, data]) => window.ouaf!.engine.filters[0]!.send(name as string, data), [name, data] as const)

  await expect.poll(async () => near(await scripted(), [0, 0, 255], 12), POLL).toBe(true)
  await send('src', 'red')
  await expect.poll(async () => near(await scripted(), [255, 0, 0], 12), POLL).toBe(true)
  await send('src', null)
  await expect.poll(async () => near(await scripted(), [0, 0, 255], 12), POLL).toBe(true)

  // The LUT: "noir" (from the select param) leaves no color; the script's "invert" brings colors back; null restores noir.
  await setParam(page, 'grade', 'noir')
  await expect.poll(() => chromaBelow(page), POLL).toBeLessThan(4)
  await send('lut', 'invert')
  await expect.poll(() => chromaBelow(page), POLL).toBeGreaterThan(10)
  await send('lut', null)
  await expect.poll(() => chromaBelow(page), POLL).toBeLessThan(4)

  // A name that is not a declared asset of the right kind: ignored with a warning, the sticker unchanged.
  await send('src', 'invert')
  await expect.poll(() => page.evaluate(() => window.ouaf!.warnings), POLL).toEqual([
    expect.stringMatching(/\.set\(\{ src: "invert" \}\) on layer "scripted": no asset named "invert" is declared in "assets" as an image, spritesheet or video; ignored/),
  ])
  expect(near(await scripted(), [0, 0, 255], 12)).toBe(true)
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})
