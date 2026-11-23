import { expect, test, type Page } from '@playwright/test'

/**
 * Scripts (#26) on `/engine.html`, in the real sandbox (sandboxed iframe, CSP, Worker): host messages reach the
 * script, its `.set()` / `.animate()` drive a color layer, `f.emit` reaches the host, the sandbox blocks the ways out,
 * an endless loop is stopped by the watchdog while rendering goes on, and a busy page does not stop a script that
 * answers (#158).
 */

const FILTER = '/filters/fixtures/script-grade/'
const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }

declare global {
  interface Window {
    received?: Array<[string, unknown]>
    /** Busy-page test: frames sent to the script sandbox (`{ t: 'frame' }` on a `MessagePort`). */
    scriptFrames?: number
  }
}

async function open(page: Page): Promise<void> {
  await page.goto(`/engine.html?source=pesquet-talk&autostart&filter=${FILTER}`)
  await page.waitForFunction(() => ((window.ouaf?.frames ?? 0) > 0 && (window.ouaf?.engine.filters.length ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, {
    timeout: 60_000,
  })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
  // Collect what the script emits.
  await page.evaluate(() => {
    window.received = []
    const handle = window.ouaf!.engine.filters[0]!
    for (const name of ['ready', 'tinted', 'probed']) handle.on(`filter:${name}`, (data) => window.received!.push([name, data]))
  })
}

const send = (page: Page, name: string, data?: unknown) =>
  page.evaluate(([name, data]) => window.ouaf!.engine.filters[0]!.send(name as string, data), [name, data] as const)

const received = (page: Page, name: string) => page.evaluate((name) => window.received!.filter(([n]) => n === name).map(([, d]) => d), name)

/** Mean channels of the canvas as displayed. */
async function sample(page: Page): Promise<{ r: number; g: number; b: number; chroma: number }> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))]))
    const c = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let r = 0
    let g = 0
    let b = 0
    let chroma = 0
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]!
      g += d[i + 1]!
      b += d[i + 2]!
      chroma += Math.max(d[i]!, d[i + 1]!, d[i + 2]!) - Math.min(d[i]!, d[i + 1]!, d[i + 2]!)
    }
    const n = d.length / 4
    return { r: r / n, g: g / n, b: b / n, chroma: chroma / n }
  }, png.toString('base64'))
}

test('host messages reach the script, whose set and animate drive the layers, and f.emit reaches the host', async ({ page }) => {
  await open(page)
  // Before any message: the color layer is neutral, the image keeps its colors.
  await expect.poll(async () => (await sample(page)).chroma > 8, POLL).toBe(true)

  await send(page, 'tint', '#ff0000')
  // Black and white, then a red tint (green and blue × 0): a red image.
  await expect.poll(async () => {
    const s = await sample(page)
    return s.r > 20 && s.g < 3 && s.b < 3
  }, POLL).toBe(true)
  await expect.poll(() => received(page, 'tinted'), POLL).toEqual([1])

  // Fading the layer's opacity out brings the original image back.
  await send(page, 'fade', 300)
  await expect.poll(async () => (await sample(page)).chroma > 8, POLL).toBe(true)
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})

test('the sandbox blocks every way out, and makes no request', async ({ page }) => {
  await open(page)
  const requests: string[] = []
  page.on('request', (r) => requests.push(r.url()))
  await send(page, 'probe')
  await expect.poll(() => received(page, 'probed'), POLL).toHaveLength(1)
  const [results] = (await received(page, 'probed')) as Array<Record<string, string>>
  expect(Object.entries(results!).filter(([, v]) => v !== 'blocked')).toEqual([])
  expect(Object.keys(results!)).toHaveLength(12)
  // The probes' requests never left the sandbox (the page itself keeps playing the clip: ignore media ranges).
  expect(requests.filter((u) => !u.includes('/test-media/'))).toEqual([])
})

test('an endless loop is stopped by the watchdog; rendering never stops', async ({ page }) => {
  await open(page)
  await send(page, 'tint', '#ff0000')
  await expect.poll(() => received(page, 'tinted'), POLL).toEqual([1])
  const before = await page.evaluate(() => window.ouaf!.frames)
  await send(page, 'loop')
  await expect.poll(() => page.evaluate(() => window.ouaf!.errors), POLL).toEqual([expect.stringMatching(/script was stopped: it did not answer a frame within 1000 ms/)])
  // The page kept rendering (stats count frames every second), and the layer keeps what the script set.
  await expect.poll(() => page.evaluate(() => window.ouaf!.frames), POLL).toBeGreaterThan(before + 30)
  const s = await sample(page)
  expect(s.r > 20 && s.g < 3 && s.b < 3).toBe(true)
  // The script stays stopped: messages are ignored.
  await send(page, 'tint', '#00ff00')
  await page.waitForTimeout(500)
  expect(await received(page, 'tinted')).toEqual([1])
})

/**
 * #158: the `stress` demo (every layer type on 4 faces, a script that receives every landmark and draws two canvases
 * at 30 and 15 fps) on a busy page: 4 × CDP CPU throttling of the page, software WebGL, frames pushed one after the
 * other as in the demo test (`e2e/demos.spec.ts`), each one tracked and rendered in a long task.
 *
 * The script never loops: it is never stopped, and it answers each frame before the next one is rendered, so that
 * every frame reaches it (one frame in flight: a frame rendered while the script is busy is not sent). Before #158
 * its canvases were GPU-backed and each `transferToImageBitmap` waited on the GPU process, busy with the engine's
 * rendering: 250 ms per draw here (less than half of the frames reached the script), about 1 s with 2 cores, which
 * tripped the watchdog on CI.
 */
test('a busy page does not stop a script that answers: the stress demo under CPU throttling', async ({ page }) => {
  test.slow()
  await page.addInitScript(() => {
    window.scriptFrames = 0
    const post = MessagePort.prototype.postMessage as (this: MessagePort, ...args: unknown[]) => void
    MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]) {
      if ((args[0] as { t?: unknown } | null)?.t === 'frame') window.scriptFrames!++
      return post.apply(this, args)
    } as typeof MessagePort.prototype.postMessage
  })
  await page.goto('/engine.html?maxFaces=4')
  await page.waitForFunction(() => !!window.ouaf)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const result = await page.evaluate(async () => {
    const { engine, core } = window.ouaf!
    await engine.addFilter('/filters/stress/')
    const source = await core.OfflineVideoSource.open('/test-media/four-faces-grid.mp4')
    let pushed = 0
    for (; pushed < 20; pushed++) {
      const frame = await source.read()
      if (!frame) break
      await engine.pushFrame(frame.image, frame.time)
      frame.close()
      // Time for the script to answer before the next frame, much less than a GPU-bound draw took before #158.
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    source.dispose()
    return { pushed, sent: window.scriptFrames!, errors: window.ouaf!.errors, warnings: window.ouaf!.warnings }
  })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  console.log(`stress under 4× CPU throttling: ${result.sent} of ${result.pushed} frames reached the script`)
  expect(result.errors).toEqual([])
  expect(result.warnings).toEqual([])
  expect(result.pushed).toBe(20)
  // It kept up (a little slack for a hiccup of a CI runner).
  expect(result.sent).toBeGreaterThanOrEqual(18)
})
