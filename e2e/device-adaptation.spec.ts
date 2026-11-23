import { expect, test, type Page } from '@playwright/test'

/**
 * Device adaptation (#90, spec §16) on `/engine.html`, with tracking slowed down by the page's throttle
 * (`?throttle=<ms>`, `throttlePlugin`): the governor drops the optional capabilities in order, hides the face filters
 * (raw camera) below the floor, emits `performance` events, and shows / restores everything once tracking is fast
 * again; the tracker's backend is measured on the first live frames and cached (spec §16.4).
 *
 * The throttle's cost model: each result takes `ms`, less 15 % without blendshapes, 20 % without extra faces, 25 % at
 * the reduced analysis resolution. The clip plays at 30 fps, so the tracking rate snaps to 30, 15, 10… Hz.
 */

const POLL = { timeout: 60_000, intervals: [250, 500, 1000] }

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/engine.html?source=pesquet-talk&autostart&${query}`)
  await page.waitForFunction(() => ((window.ouaf?.frames ?? 0) > 0 && (window.ouaf?.engine.filters.length ?? 0) > 0) || (window.ouaf?.errors.length ?? 0) > 0, undefined, {
    timeout: 60_000,
  })
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
}

/** `performance` events so far, as `state[dropped,…]`. */
const events = (page: Page) => page.evaluate(() => window.ouaf!.performance.map((e) => `${e.state}[${e.dropped.join(',')}]`))

/** Mean blue level (0–255) of the next rendered frame: the yellow tint of `dot-tint` takes the blue out. */
const blue = (page: Page) =>
  page.evaluate(async () => {
    const bitmap = await createImageBitmap(await window.ouaf!.engine.snapshot())
    const canvas = new OffscreenCanvas(32, 32)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0, 32, 32)
    const data = ctx.getImageData(0, 0, 32, 32).data
    let sum = 0
    for (let i = 2; i < data.length; i += 4) sum += data[i]!
    return sum / (data.length / 4)
  })

test('slow tracking: capabilities dropped in order, then the face filter hidden; all back once tracking is fast', async ({ page }) => {
  // 200 ms per result: 5 Hz with everything on, still 80 ms (≤ 12.5 Hz) with everything dropped: below the floor.
  await open(page, 'maxFaces=2&throttle=200&filter=/filters/fixtures/dot-tint/')
  await expect.poll(() => events(page), POLL).toContain('unsupported[blendshapes,extraFaces,resolution]')
  expect(await events(page)).toEqual([
    'degraded[blendshapes]',
    'degraded[blendshapes,extraFaces]',
    'degraded[blendshapes,extraFaces,resolution]',
    'unsupported[blendshapes,extraFaces,resolution]',
  ])
  expect(await page.evaluate(() => window.ouaf!.engine.filters[0]!.suspended)).toBe(true)
  // Raw camera image: no yellow tint.
  expect(await blue(page)).toBeGreaterThan(20)
  expect(await page.evaluate(() => window.ouaf!.engine.performance.state)).toBe('unsupported')

  // Throttle off: the machine's own speed (the benchmark picked its faster backend). Shown again above 18 Hz, then the
  // capabilities come back one by one, last dropped first, if the machine has room for them (≥ 20 Hz predicted).
  await page.evaluate(() => (window.ouaf!.throttle.ms = 0))
  await page.waitForTimeout(5000)
  const hz = await page.evaluate(() => window.ouaf!.engine.performance.trackingHz)
  test.skip(hz < 22, `this machine tracks at ${hz.toFixed(1)} Hz without throttle: too slow to check the recovery`)
  await expect.poll(() => events(page), { ...POLL, timeout: 90_000 }).toContain('ok[]')
  expect((await events(page)).slice(4)).toEqual([
    'degraded[blendshapes,extraFaces,resolution]',
    'degraded[blendshapes,extraFaces]',
    'degraded[blendshapes]',
    'ok[]',
  ])
  expect(await page.evaluate(() => window.ouaf!.engine.filters[0]!.suspended)).toBe(false)
  expect(await blue(page)).toBeLessThan(5)
  expect(await page.evaluate(() => window.ouaf!.errors)).toEqual([])
})

test('a filter that requires blendshapes never loses them: it is hidden instead', async ({ page }) => {
  await open(page, 'throttle=200&filter=/filters/fixtures/blendshapes-required/')
  await expect.poll(() => events(page), POLL).toContain('unsupported[resolution]')
  // One face (maxFaces=1): no extra faces to drop; blendshapes are required.
  expect(await events(page)).toEqual(['degraded[resolution]', 'unsupported[resolution]'])
})

test('with blendshapes dropped, expression events come from the landmark geometry', async ({ page }) => {
  // 40 ms per result: 15 Hz, below the drop level; 34 ms without blendshapes, 24 ms also without the resolution:
  // the governor stops dropping once the rate is back above 16 Hz, and the filter stays shown.
  await open(page, 'throttle=40&filter=/filters/fixtures/dot-tint/')
  await expect.poll(() => events(page), POLL).toContain('degraded[blendshapes]')
  const before = await page.evaluate(() => window.ouaf!.events.length)
  // pesquet-talk (8 s, looping) has blinks at about 1.9, 3.0 and 6.9 s.
  await expect.poll(() => page.evaluate((n) => window.ouaf!.events.slice(n).filter((e) => e.name === 'blink').length, before), { ...POLL, timeout: 30_000 }).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.ouaf!.engine.performance.state)).toBe('degraded')
  expect(await page.evaluate(() => window.ouaf!.engine.performance.dropped[0])).toBe('blendshapes')
})

test('adaptation can be turned off', async ({ page }) => {
  await open(page, 'filter=/filters/fixtures/dot-tint/&adapt=0&throttle=200')
  await page.waitForTimeout(8000)
  expect(await events(page)).toEqual([])
  expect(await page.evaluate(() => window.ouaf!.engine.performance.state)).toBe('ok')
})

test('the tracker backend is measured on the first live frames, cached on the device, or forced', async ({ page }) => {
  const tracker = () => page.evaluate(() => window.ouaf!.stats?.tracker ?? '')
  await open(page, 'filter=/filters/fixtures/dot-tint/')
  await expect.poll(tracker, POLL).toMatch(/^MediaPipe (CPU|GPU) \(measured: (GPU|CPU) [\d.]+ ms, (GPU|CPU) [\d.]+ ms\)/)
  const stored = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith(window.ouaf!.core.BACKEND_STORE_PREFIX)))
  expect(stored).toHaveLength(1)
  const [key, value] = stored[0]!
  expect(key).toBe('ouaf:tracker-backend:1.0.0:mediapipe')
  const choice = JSON.parse(value) as { backend: string; measuredMs: Record<string, number>; userAgent: string }
  expect(Object.keys(choice.measuredMs).sort()).toEqual(['CPU', 'GPU'])
  expect(choice.backend).toBe(choice.measuredMs.CPU! <= choice.measuredMs.GPU! ? 'CPU' : 'GPU')
  expect(await tracker()).toContain(`MediaPipe ${choice.backend} (measured`)

  // Next start: the cached choice, no benchmark.
  await open(page, 'filter=/filters/fixtures/dot-tint/')
  await expect.poll(tracker, POLL).toContain(`MediaPipe ${choice.backend} (cached: `)
  // Forced by the host.
  const other = choice.backend === 'CPU' ? 'GPU' : 'CPU'
  await open(page, `filter=/filters/fixtures/dot-tint/&backend=${other}`)
  await expect.poll(tracker, POLL).toBe(`MediaPipe ${other} (forced), main thread`)
  // `?backend=measure` forgets the choice: measured again.
  await open(page, 'filter=/filters/fixtures/dot-tint/&backend=measure')
  await expect.poll(tracker, POLL).toContain('(measured: ')
})
