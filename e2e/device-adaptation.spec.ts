import { expect, test, type Page } from './fixtures.ts'

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
  // 250 ms per result: 4 Hz with everything on, still 100 ms (≤ 10 Hz) with everything dropped: below the 12 Hz floor.
  await open(page, 'maxFaces=2&throttle=250&filter=/filters/fixtures/dot-tint/')
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

  // The device frees up *later* (throttle off): the machine's own speed (the benchmark picked its faster backend).
  // Not at the hide itself: with a main-thread tracker, for its first `hiddenBaselineMs` hidden, the governor learns
  // what hiding gained, and a speed-up then is what hiding the filter freed (the flicker case, which waits for a probe).
  // The short dip with a worker tracker is the next test.
  test.setTimeout(300_000)
  await page.waitForTimeout(await page.evaluate(() => window.ouaf!.core.DEFAULT_GOVERNOR_TUNING.hiddenBaselineMs + 1000))
  await page.evaluate(() => (window.ouaf!.throttle.ms = 0))
  await page.waitForTimeout(5000)
  const hz = await page.evaluate(() => window.ouaf!.engine.performance.trackingHz)
  test.skip(hz < 22, `this machine tracks at ${hz.toFixed(1)} Hz without throttle: too slow to check the recovery`)
  // Shown again, then the capabilities come back one by one, last dropped first. Each step waits for its prediction
  // (≥ 14 Hz shown, ≥ 17 Hz with the capability), or on a slow machine for a probe (30 s): up to 4 × 31 s.
  await expect.poll(() => events(page), { ...POLL, timeout: 150_000 }).toContain('ok[]')
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

test('worker tracker: a filter hidden by a short dip is shown again within seconds (#180)', async ({ page }) => {
  // LiteRT.js in its worker: hiding the filter frees the main thread, not the tracker. Slow (250 ms per result) until
  // the hide, then the machine's own speed at once, during the 6 s the governor would otherwise spend learning what
  // hiding gained (and then predict the rate before the hide, below the floor: shown only by the 30 s probe).
  await open(page, 'backend=litert&throttle=250&filter=/filters/fixtures/dot-tint/')
  await page.evaluate(() => {
    const { engine, throttle } = window.ouaf!
    const off = engine.on('performance', (e) => {
      if (e.state !== 'unsupported') return
      off()
      throttle.ms = 0
      ;(window as { hiddenAt?: number }).hiddenAt = performance.now()
    })
  })
  await expect.poll(() => events(page), POLL).toContain('unsupported[blendshapes,resolution]')
  // Settle (1 s) + 1 s above 14 Hz, the first settled rates being still a little slow: well within 10 s, not 30 s.
  const shown = await page
    .waitForFunction(() => !window.ouaf!.engine.filters[0]!.suspended, undefined, { timeout: 10_000, polling: 250 })
    .then(() => true, () => false)
  if (!shown) {
    const rate = await page.evaluate(() => window.ouaf!.stats?.trackingHz ?? 0)
    test.skip(rate < 16, `this machine tracks at ${rate.toFixed(1)} Hz in the worker without throttle: too slow to check`)
  }
  expect(shown).toBe(true)
  const shownAfter = await page.evaluate(() => performance.now() - (window as { hiddenAt?: number }).hiddenAt!)
  console.log(`worker tracker: shown again ${(shownAfter / 1000).toFixed(1)} s after the hide`)
  expect(shownAfter).toBeLessThan(10_000)
  // Throttle off, LiteRT.js gains nothing from the analysis resolution (`sheds`): restored at once, still hidden.
  expect((await events(page)).slice(2, 5)).toEqual(['unsupported[blendshapes,resolution]', 'unsupported[blendshapes]', 'degraded[blendshapes]'])
  expect(await blue(page)).toBeLessThan(5)
})

test('no flicker when hiding the filter is what frees the device: no re-show before the slow probe', async ({ page }) => {
  // The pattern seen on the Redmi Note 11S (main-thread tracker): drawing the filter (85 ms of main-thread work per
  // frame here) keeps tracking below the 12 Hz floor; hiding it frees the main thread and tracking climbs above 14 Hz.
  await open(page, 'adapt=1&filter=/filters/fixtures/busy/')
  // On the phone the rate climbed over a few seconds after the hide: tracking stays slow (70 ms) for 2.5 s after it.
  await page.evaluate(() => {
    const { engine, throttle } = window.ouaf!
    const off = engine.on('performance', (e) => {
      if (e.state !== 'unsupported') return
      off()
      throttle.ms = 70
      setTimeout(() => (throttle.ms = 0), 2500)
    })
  })
  await expect.poll(() => events(page), POLL).toContain('unsupported[blendshapes,resolution]')
  const hz = async () => (await page.evaluate(() => window.ouaf!.engine.performance.trackingHz))
  // Hidden: the rate climbs above 14 Hz (unless this machine is too slow even then).
  await page.waitForTimeout(8000)
  const hidden = await hz()
  test.skip(hidden <= 14, `this machine tracks at ${hidden.toFixed(1)} Hz even with the filter hidden`)
  // Seen live: shown again 9 s after the hide, hidden again 6 s later. Now only the probe, 30 s after the hide.
  await page.waitForTimeout(16_000)
  expect(await events(page)).toEqual(['degraded[blendshapes]', 'degraded[blendshapes,resolution]', 'unsupported[blendshapes,resolution]'])
  expect(await page.evaluate(() => window.ouaf!.engine.filters[0]!.suspended)).toBe(true)
})

test('a filter that requires blendshapes never loses them: it is hidden instead', async ({ page }) => {
  await open(page, 'throttle=200&filter=/filters/fixtures/blendshapes-required/')
  await expect.poll(() => events(page), POLL).toContain('unsupported[resolution]')
  // One face (maxFaces=1): no extra faces to drop; blendshapes are required.
  expect(await events(page)).toEqual(['degraded[resolution]', 'unsupported[resolution]'])
})

test('with blendshapes dropped, expression events come from the landmark geometry', async ({ page }) => {
  // 100 ms per result: at most 10 Hz, below the 13 Hz drop level. Each drop saves a share (15 %, 20 %, 25 %): 85 ms
  // without blendshapes (still below 13 Hz), 65 ms also without the extra faces (15 Hz: above it; at the clip's 30 fps
  // a little jitter can push it to 10 Hz, then the resolution goes too: 40 ms, 25–30 Hz). Either way the filter stays
  // shown above the 12 Hz floor, its events from the geometry.
  await open(page, 'maxFaces=2&throttle=100&filter=/filters/fixtures/dot-tint/')
  await expect.poll(async () => (await events(page)).some((e) => e.startsWith('degraded[blendshapes,extraFaces')), POLL).toBe(true)
  await expect.poll(() => page.evaluate(() => window.ouaf!.engine.performance.state), POLL).toBe('degraded')
  const before = await page.evaluate(() => window.ouaf!.events.length)
  // pesquet-talk (8 s, looping) has blinks at about 1.9, 3.0 and 6.9 s.
  await expect.poll(() => page.evaluate((n) => window.ouaf!.events.slice(n).filter((e) => e.name === 'blink').length, before), { ...POLL, timeout: 30_000 }).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.ouaf!.engine.performance.state)).toBe('degraded')
  expect(await page.evaluate(() => window.ouaf!.engine.performance.dropped[0])).toBe('blendshapes')
})

test('?signals: peaks of the last 1.5 s, and blink counts that match the events the engine fired', async ({ page }) => {
  await open(page, 'signals&filter=/filters/fixtures/dot-tint/')
  const read = () =>
    page.evaluate(() => ({
      rows: [...document.querySelectorAll('.ouaf-perf table tr')].map((tr) => [...tr.children].map((c) => c.textContent ?? '')),
      blinks: window.ouaf!.events.filter((e) => e.name === 'blink').length,
    }))
  let panel = await read()
  const row = (name: string) => panel.rows.find((r) => r[0] === name)!
  // pesquet-talk has blinks at about 1.9, 3.0 and 6.9 s (looping). The table is refreshed 4 times a second, and shows
  // "—" while no face is tracked (the clip has cuts): wait for a counted blink and a face.
  await expect
    .poll(async () => {
      panel = await read()
      return Number(row('blink')[1]) > 0 && row('eyeClosedLeft').slice(1).every((cell) => !Number.isNaN(Number(cell)))
    }, POLL)
    .toBe(true)
  // Signal rows: now and peak for each source, as numbers; a peak is at least the value now.
  for (const cell of row('eyeClosedLeft').slice(1)) expect(Number(cell)).not.toBeNaN()
  expect(Number(row('eyeClosedLeft')[2])).toBeGreaterThanOrEqual(Number(row('eyeClosedLeft')[1]) - 1e-9)
  // Blendshapes available (no throttle): the engine's blinks are counted under "engine (bs+geo)".
  const blink = row('blink')
  expect(Number(blink[1])).toBeGreaterThan(0)
  expect(Number(blink[1])).toBeLessThanOrEqual(panel.blinks)
  expect(Number(blink[2])).toBe(0)
})

test('adaptation can be turned off', async ({ page }) => {
  await open(page, 'filter=/filters/fixtures/dot-tint/&adapt=0&throttle=200')
  await page.waitForTimeout(8000)
  expect(await events(page)).toEqual([])
  expect(await page.evaluate(() => window.ouaf!.engine.performance.state)).toBe('ok')
})

test('the tracker backend is measured on the first live frames, cached on the device, or forced', async ({ page }) => {
  const tracker = () => page.evaluate(() => window.ouaf!.stats?.tracker ?? '')
  const label = (backend: string) => (backend === 'LiteRT' ? 'LiteRT.js wasm in a worker, WebGL2 crops read back async, VideoFrame' : `MediaPipe ${backend}, main thread`)
  await open(page, 'filter=/filters/fixtures/dot-tint/')
  // LiteRT.js in a worker against MediaPipe's GPU and CPU delegates (#165).
  await expect.poll(tracker, POLL).toMatch(/ \(measured: (LiteRT|GPU|CPU) [\d.]+ ms, (LiteRT|GPU|CPU) [\d.]+ ms, (LiteRT|GPU|CPU) [\d.]+ ms\)$/)
  const stored = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith(window.ouaf!.core.BACKEND_STORE_PREFIX)))
  expect(stored).toHaveLength(1)
  const [key, value] = stored[0]!
  expect(key).toBe('ouaf:tracker-backend:1.0.0:face')
  const choice = JSON.parse(value) as { backend: string; measuredMs: Record<string, number>; userAgent: string }
  expect(Object.keys(choice.measuredMs).sort()).toEqual(['CPU', 'GPU', 'LiteRT'])
  // The fastest, MediaPipe (main thread) weighted by MAIN_THREAD_WEIGHT.
  const weight = await page.evaluate(() => window.ouaf!.core.MAIN_THREAD_WEIGHT)
  const score = (name: string) => choice.measuredMs[name]! * (name === 'LiteRT' ? 1 : weight)
  expect(choice.backend).toBe(['LiteRT', 'GPU', 'CPU'].reduce((best, name) => (score(name) < score(best) ? name : best)))
  console.log(`backend benchmark: ${JSON.stringify(choice.measuredMs)} → ${choice.backend}`)
  expect(await tracker()).toBe(`${label(choice.backend)} (measured: ${Object.entries(choice.measuredMs).map(([n, v]) => `${n} ${v.toFixed(1)} ms`).join(', ')})`)

  // Next start: the cached choice, no benchmark.
  await open(page, 'filter=/filters/fixtures/dot-tint/')
  await expect.poll(tracker, POLL).toContain(`${label(choice.backend)} (cached: `)
  // Forced by the host.
  const other = choice.backend === 'CPU' ? 'GPU' : 'CPU'
  await open(page, `filter=/filters/fixtures/dot-tint/&backend=${other}`)
  await expect.poll(tracker, POLL).toBe(`${label(other)} (forced)`)
  await open(page, 'filter=/filters/fixtures/dot-tint/&backend=litert')
  await expect.poll(tracker, POLL).toBe(`${label('LiteRT')} (forced)`)
  // `?backend=measure` forgets the choice: measured again.
  await open(page, 'filter=/filters/fixtures/dot-tint/&backend=measure')
  await expect.poll(tracker, POLL).toContain('(measured: ')
})
