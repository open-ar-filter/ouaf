import { expect, test } from '@playwright/test'

/**
 * Pairs of faces (spec §12.4, §13) with real tracking: `frame.pairs` and the `pairContact` / `pairSeparate` events,
 * through the script sandbox (fixture `script-pairs`, contact threshold 1 face unit).
 *
 * The faces are two copies of one frame of a licensed test clip (`pesquet-talk-360`, a crop around the face) drawn
 * side by side into a canvas and given to `engine.pushFrame` (file regime): far apart, then close, then far apart
 * again. Each position is held for a while so that tracking settles.
 */

type Pair = [a: number, b: number, distance: number, contact: boolean]

test('frame.pairs measures the faces, and pairContact / pairSeparate fire as they come close and move apart', async ({ page }) => {
  await page.goto('/engine.html?maxFaces=2')
  await page.waitForFunction(() => !!window.ouaf)
  const result = await page.evaluate(async () => {
    const { engine, core } = window.ouaf!
    const handle = await engine.addFilter('/filters/fixtures/script-pairs/')
    const received: { phase: number; pairs: Pair[] }[] = []
    const events: Array<[string, number, number]> = []
    let phase = 0
    handle.on('filter:pairs', (d) => received.push({ phase, pairs: (d as { pairs: Pair[] }).pairs }))
    handle.on('filter:event', (d) => events.push(d as [string, number, number]))
    const source = await core.OfflineVideoSource.open('/test-media/pesquet-talk-360.mp4')
    let frame = (await source.read())!
    while (frame.time < 2.5) {
      frame.close()
      frame = (await source.read())!
    }
    const canvas = new OffscreenCanvas(640, 360)
    const ctx = canvas.getContext('2d')!
    const image = frame.image as CanvasImageSource
    // Phases: the second copy's left edge (px); the first copy is at 0. Each copy is 300 px wide.
    const offsets = [330, 140, 330]
    const lengths = [20, 20, 40]
    let time = 0
    for (phase = 0; phase < offsets.length; phase++) {
      for (let i = 0; i < lengths[phase]!; i++) {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, 640, 360)
        ctx.drawImage(image, 0, 0, 360, 300, 0, 20, 300, 250)
        ctx.drawImage(image, 0, 0, 360, 300, offsets[phase]!, 20, 300, 250)
        await engine.pushFrame(canvas, time)
        time += 1 / 30
      }
    }
    frame.close()
    source.dispose()
    // The answer to the last frame is applied with the next one (spec §12.1).
    await engine.pushFrame(canvas, time)
    const byPhase = (p: number) => received.filter((r) => r.phase === p).map((r) => r.pairs)
    return { pairs: [byPhase(0), byPhase(1), byPhase(2)], events, errors: window.ouaf!.errors, warnings: window.ouaf!.warnings }
  })
  expect(result.errors).toEqual([])
  expect(result.warnings).toEqual([])
  const [far, close, apart] = result.pairs.map((phase) => phase.flat())
  // Both faces are found in each phase (the frames where only one is tracked have no pair).
  for (const phase of [far, close, apart]) expect(phase!.length).toBeGreaterThan(5)
  const distances = (pairs: Pair[]) => pairs.map((p) => p[2])
  // Head centres about 6 face units apart, then about 2: the faces are about 2 face units wide.
  expect(Math.min(...distances(far!))).toBeGreaterThan(4.5)
  expect(Math.max(...distances(close!.slice(5)))).toBeLessThan(3)
  // Contact: never while far apart; while close, once settled; never at the end.
  expect(far!.some((p) => p[3])).toBe(false)
  expect(close!.slice(5).every((p) => p[3])).toBe(true)
  expect(apart!.slice(-5).every((p) => !p[3])).toBe(true)
  // One contact, then one separation, of the same two faces.
  expect(result.events.map((e) => e[0])).toEqual(['pairContact', 'pairSeparate'])
  expect(new Set(result.events[0]!.slice(1))).toEqual(new Set(result.events[1]!.slice(1)))
})
