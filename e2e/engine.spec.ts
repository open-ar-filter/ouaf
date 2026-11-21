import { expect, test, type Page } from '@playwright/test'

/**
 * Engine skeleton (#11, #12, #17) through its public API, on `/engine.html` with the playground's test plugin:
 * a filter folder is loaded over HTTP, tracked faces drive an object layer, a param drives a pass layer, and the
 * plugin and error paths behave as specified.
 */

const FIXTURE = '/filters/fixtures/dot-tint/'

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/engine.html?${query}`)
  await page.waitForFunction(() => ((window.ouaf?.stats?.faces ?? 0) > 0 && (window.ouaf?.stats?.trackingHz ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
}

/** Mean color and count of pure-green pixels of the canvas as displayed (screenshot decoded by the browser). */
async function sample(page: Page): Promise<{ r: number; g: number; b: number; green: number }> {
  const png = await page.locator('#canvas').screenshot()
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
    const c = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let r = 0
    let g = 0
    let b = 0
    let green = 0
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]!
      g += d[i + 1]!
      b += d[i + 2]!
      if (d[i + 1]! > 200 && d[i]! < 80 && d[i + 2]! < 80) green++
    }
    const n = d.length / 4
    return { r: r / n, g: g / n, b: b / n, green }
  }, [...png])
}

test('a filter folder is tracked, drawn and driven by its params', async ({ page }) => {
  await open(page, `source=pesquet-closeup&autostart&filter=${FIXTURE}`)
  const state = await page.evaluate(() => {
    const { engine, stats } = window.ouaf!
    const f = engine.filters[0]!
    return { ids: engine.filters.map((h) => h.id), params: f.params, stats }
  })
  expect(state.ids).toEqual(['dot-tint'])
  expect(state.params).toEqual({ tint: 1 })
  expect(state.stats?.trackingHz).toBeGreaterThan(0)

  // Yellow tint (color stage) removes blue everywhere; the green dot (objects stage) survives it.
  const tinted = await sample(page)
  expect(tinted.b).toBeLessThan(5)
  expect(tinted.green).toBeGreaterThan(50)

  // The param reaches the pass on the next frames; at 0 the pass is inactive (fast path, no render target).
  const changes: unknown[] = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const f = window.ouaf!.engine.filters[0]!
        const seen: unknown[] = []
        f.on('paramChange', (c) => {
          seen.push(c)
          resolve(seen)
        })
        f.setParam('tint', 0, { transition: 0 })
      }),
  )
  expect(changes).toEqual([{ name: 'tint', value: 0, previous: 1 }])
  await page.waitForTimeout(300)
  const plain = await sample(page)
  expect(plain.b).toBeGreaterThan(20)
  expect(plain.green).toBeGreaterThan(50)
})

test('stack operations and API errors', async ({ page }) => {
  await open(page, `source=pesquet-closeup&autostart&filter=${FIXTURE}`)
  const result = await page.evaluate(async () => {
    const { engine, memorySource, core } = window.ouaf!
    const base = { ouaf: '1', name: 'T', version: '1.0.0', license: 'CC0-1.0', requires: {} }
    const errorOf = async (p: Promise<unknown>) => {
      try {
        await p
        return 'no error'
      } catch (e) {
        return e instanceof core.OuafError ? e.code : String(e)
      }
    }
    const out: Record<string, unknown> = {}
    out.invalid = await errorOf(engine.addFilter(memorySource({ manifest: { ...base, id: 'bad', layers: [{ type: 'text', anchor: 'nose' }] } })))
    out.plugin = await errorOf(engine.addFilter(memorySource({ manifest: { ...base, id: 'p', requires: { plugins: ['mood@^1'] }, layers: [] } })))
    out.engine = await errorOf(engine.addFilter(memorySource({ manifest: { ...base, id: 'e', engine: '^2', layers: [] } })))
    out.param = (() => {
      try {
        engine.filters[0]!.setParam('tint', 5)
        return 'no error'
      } catch (e) {
        return e instanceof core.OuafError ? e.code : String(e)
      }
    })()
    out.afterErrors = engine.filters.map((f) => f.id)

    const a = await engine.addFilter(memorySource({ manifest: { ...base, id: 'a', requires: { plugins: ['playground@^1'] }, layers: [{ type: 'playground:tint', color: '#ff0000', amount: 0 }] } }))
    const b = await engine.addFilter(memorySource({ manifest: { ...base, id: 'b', layers: [] } }))
    out.added = engine.filters.map((f) => f.id)
    b.moveTo(0)
    out.moved = engine.filters.map((f) => `${f.id}:${f.index}`)
    a.remove()
    out.removed = [engine.filters.map((f) => f.id), a.removed]
    const swapped = await engine.setFilters([memorySource({ manifest: { ...base, id: 'c', layers: [] } })])
    out.swapped = [swapped.map((f) => f.id), engine.filters.map((f) => f.id)]
    out.keepOnFailure = await errorOf(engine.setFilters([memorySource({ manifest: { ...base, id: 'bad', layers: [{ type: 'nope' }] } })]))
    out.kept = engine.filters.map((f) => f.id)
    return out
  })
  expect(result).toEqual({
    invalid: 'invalid-manifest',
    plugin: 'missing-plugin',
    engine: 'incompatible-engine',
    param: 'invalid-param',
    afterErrors: ['dot-tint'],
    added: ['dot-tint', 'a', 'b'],
    moved: ['b:0', 'dot-tint:1', 'a:2'],
    removed: [['b', 'dot-tint'], true],
    swapped: [['c'], ['c']],
    keepOnFailure: 'invalid-manifest',
    kept: ['c'],
  })
})

test('params animate over their transition and presets apply', async ({ page }) => {
  await open(page, `source=pesquet-closeup&autostart&filter=${FIXTURE}`)
  // A 4 s transition (longer than a software-rendered screenshot takes): partway through, blue is partly back.
  await page.evaluate(() => window.ouaf!.engine.filters[0]!.applyPreset('none', { transition: 4000 }))
  await page.waitForTimeout(1000)
  const during = await sample(page)
  await page.waitForTimeout(4000)
  const after = await sample(page)
  expect(during.b).toBeGreaterThan(3)
  expect(during.b).toBeLessThan(after.b - 3)
  expect(await page.evaluate(() => window.ouaf!.engine.filters[0]!.params)).toEqual({ tint: 0 })
})

test('bindings drive layer properties from tracking data', async ({ page }) => {
  // No filter yet, so no tracking: wait for the first stats only.
  await page.goto('/engine.html?source=pesquet-closeup&autostart')
  await page.waitForFunction(() => window.ouaf?.stats !== undefined, undefined, { timeout: 60_000 })
  // faces.count mapped to [0, 1]: full yellow tint while a face is tracked, none without (default 0).
  await page.evaluate(async () => {
    const { engine, memorySource } = window.ouaf!
    await engine.addFilter(
      memorySource({
        manifest: {
          ouaf: '1', id: 'bound', name: 'Bound', version: '1.0.0', license: 'CC0-1.0',
          requires: { face: true, plugins: ['playground@^1'] },
          layers: [{ type: 'playground:tint', color: '#ffff00', amount: { bind: 'faces.count', range: [0, 1], to: [0, 1], default: 0 } }],
        },
      }),
    )
  })
  await expect.poll(async () => (await sample(page)).b, { timeout: 30_000 }).toBeLessThan(5)
})
