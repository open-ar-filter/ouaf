import { describe, expect, it } from 'vitest'
import { DEFAULT_RESOLUTION_TUNING, ResolutionGovernor, type ResolutionChange, type ResolutionTuning } from '../src/engine/resolution-governor.ts'

/** Time (ms) to render one frame at this scale of the internal resolution, at time `t` (s). */
type Device = (scale: number, t: number) => number

/**
 * A 30 fps source played for `seconds`: the engine renders a frame when it is free, the frames presented while it is
 * busy are missed (as with `requestVideoFrameCallback`). Returns the changes with their time (s).
 */
function run(device: Device, seconds: number, options: { tuning?: Partial<ResolutionTuning>; fps?: number; g?: ResolutionGovernor; from?: number } = {}) {
  const g = options.g ?? new ResolutionGovernor(options.tuning)
  const period = 1000 / (options.fps ?? 30)
  const changes: Array<{ t: number; change: ResolutionChange }> = []
  let busyUntil = -Infinity
  const start = options.from ?? 0
  for (let k = Math.ceil(start / period); k * period <= start + seconds * 1000; k++) {
    const now = k * period
    if (now < busyUntil) continue
    busyUntil = now + device(g.scale, now / 1000)
    const change = g.frame(now, k)
    if (change) changes.push({ t: Math.round(now) / 1000, change })
  }
  return { g, changes, kinds: changes.map(({ change: c }) => `${c.kind} ${c.scale}`) }
}

/** Render time proportional to the pixels: `full` ms at scale 1, plus `fixed` ms whatever the size. */
const pixels = (full: number, fixed = 0): Device => (scale) => fixed + full * scale * scale

describe('ResolutionGovernor (spec §16.5)', () => {
  it('leaves a device that keeps up alone', () => {
    const { g, changes } = run(pixels(20), 60)
    expect(changes).toEqual([])
    expect(g.scale).toBe(1)
    expect(g.missed).toBe(0)
  })

  it('lowers the resolution until every frame is rendered, trying the next level when one shows no gain', () => {
    // 50 ms at full size and 36 ms at 0.85 both take two 33 ms periods (half the frames missed); 24.5 ms at 0.7: one.
    const { g, kinds, changes } = run(pixels(50), 12)
    expect(kinds).toEqual(['drop 0.85', 'drop 0.7'])
    // Over budget for 2 s (1 s windows), then the drop settles 1 s and is judged for 2 s.
    expect(changes[0]!.t).toBeGreaterThanOrEqual(2)
    expect(changes[0]!.t).toBeLessThan(3.1)
    expect(changes[1]!.t - changes[0]!.t).toBeCloseTo(3, 0)
    expect(g.scale).toBe(0.7)
    expect(g.missed).toBe(0)
  })

  it('then tries the higher level again now and then, waiting twice as long after each failure', () => {
    const { g, kinds, changes } = run(pixels(50), 400)
    expect(kinds.slice(2, 6)).toEqual(['restore 0.85', 'drop 0.7', 'restore 0.85', 'drop 0.7'])
    const restores = changes.filter((c) => c.change.kind === 'restore').map((c) => c.t)
    // After the drop's settle and judgement (3 s): 5 s below the restore threshold, then 10, 20, 40, 80, capped at 120.
    const waits = restores.map((r) => r - Math.max(...changes.filter((c) => c.t < r).map((c) => c.t)) - 3)
    expect(waits.length).toBeGreaterThanOrEqual(5)
    expect(waits.map((w) => Math.round(w / 5) * 5)).toEqual([5, 10, 20, 40, 80, 120].slice(0, waits.length))
    expect(g.scale).toBeLessThan(1)
  })

  it('does not go below the last level', () => {
    const { g, kinds } = run(pixels(400), 120)
    expect(kinds.filter((k) => k.startsWith('drop'))).toEqual(['drop 0.85', 'drop 0.7', 'drop 0.6', 'drop 0.5'])
    expect(g.scale).toBe(0.5)
  })

  it('takes back a drop that did not help (main thread bound), and waits longer before each new try', () => {
    // 60 ms per frame whatever the size: the pixels are not the bottleneck.
    const { g, kinds, changes } = run(pixels(0, 60), 200)
    // Two levels tried (`trialLevels`), then back to full resolution.
    expect(kinds.slice(0, 6)).toEqual(['drop 0.85', 'drop 0.7', 'undo 1', 'drop 0.85', 'drop 0.7', 'undo 1'])
    expect(g.scale).toBe(1)
    // Blocked 30 s, then 60 s.
    const at = changes.map((c) => c.t)
    expect(at[3]! - at[2]!).toBeGreaterThanOrEqual(30)
    expect(at[3]! - at[2]!).toBeLessThan(34)
    expect(at[6]! - at[5]!).toBeGreaterThanOrEqual(59.9)
  })

  it('keeps a drop that helped without reaching the goal, and goes on; undoes only the useless part', () => {
    // 100 ms of pixels + 20 ms fixed: 120 ms (4 periods) at full size, 92 (3) at 0.85, 69 (3) at 0.7, 56 (2) at 0.6,
    // 45 (2) at 0.5: 0.6 is the lowest level worth it.
    const { g, kinds } = run(pixels(100, 20), 30)
    expect(kinds).toEqual(['drop 0.85', 'drop 0.7', 'drop 0.6', 'drop 0.5', 'undo 0.6'])
    expect(g.scale).toBe(0.6)
  })

  it('restores the resolution once the load is gone, one level at a time', () => {
    const heavy = (t: number) => (t < 30 ? 50 : 10)
    const { g, kinds, changes } = run((scale, t) => heavy(t) * scale * scale, 120)
    const after = changes.filter((c) => c.t >= 30)
    expect(kinds.at(-1)).toBe('restore 1')
    expect(after.every((c) => c.change.kind === 'restore')).toBe(true)
    // Back to full resolution within the (doubled) restore delay.
    expect(changes.at(-1)!.t).toBeLessThan(30 + 2 * 5 + 2 * 1.5)
    expect(g.scale).toBe(1)
  })

  it('spends little time over budget on a device that keeps up only at the lower level', () => {
    // 40 ms at full size (1 frame in 2), 29 ms at 0.85.
    const { g, kinds, changes } = run(pixels(40), 600)
    expect(kinds.slice(0, 3)).toEqual(['drop 0.85', 'restore 1', 'drop 0.85'])
    // Each failed restore costs about 3 s at full size (judged over budget for 2 s, then the drop).
    const restores = changes.filter((c) => c.change.kind === 'restore').length
    expect(restores).toBeLessThanOrEqual(8)
    expect((restores * 3) / 600).toBeLessThan(0.05)
    expect(g.scale).toBe(0.85)
  })

  it('measures nothing without presented frames', () => {
    const g = new ResolutionGovernor()
    for (let now = 0; now < 10_000; now += 100) expect(g.frame(now, undefined)).toBeUndefined()
    expect(g.missed).toBeNaN()
  })

  it('restarts the measure after a pause, and when the frame counter goes back (a new video)', () => {
    const g = new ResolutionGovernor()
    // Each frame skips 2 of 3 frames: missed, but never for long enough between pauses.
    let presented = 0
    for (let round = 0; round < 10; round++) {
      const base = round * 4000
      for (let now = base; now < base + 1900; now += 100) expect(g.frame(now, (presented += 3))).toBeUndefined()
    }
    expect(g.scale).toBe(1)
    // Over budget for 1.5 s, then a new video (its counter starts again from 0), over budget for 1.5 s: no drop.
    for (let now = 50_000; now < 51_500; now += 100) expect(g.frame(now, (presented += 3))).toBeUndefined()
    presented = 0
    for (let now = 51_500; now < 53_000; now += 100) expect(g.frame(now, (presented += 3))).toBeUndefined()
    expect(g.scale).toBe(1)
    // Then long enough: dropped.
    let change
    for (let now = 53_000; now < 56_000 && !change; now += 100) change = g.frame(now, (presented += 3))
    expect(change).toEqual({ kind: 'drop', scale: 0.85 })
  })

  it('pause() and reset()', () => {
    const { g } = run(pixels(50), 12)
    expect(g.scale).toBeLessThan(1)
    g.pause()
    // Paused frames do not count; the next one restarts the measure.
    expect(g.frame(1_000_000, 1)).toBeUndefined()
    g.reset()
    expect(g.scale).toBe(1)
    expect(g.missed).toBeNaN()
  })

  it('ignores the frames of the settle time after a change', () => {
    const { changes } = run(pixels(50), 20)
    // Each drop is judged over settle + judge (3 s), so drops are at least 3 s apart.
    for (let i = 1; i < changes.length; i++) expect(changes[i]!.t - changes[i - 1]!.t).toBeGreaterThanOrEqual(DEFAULT_RESOLUTION_TUNING.settleMs / 1000 + DEFAULT_RESOLUTION_TUNING.judgeMs / 1000 - 0.05)
  })

  it('checks its levels', () => {
    expect(() => new ResolutionGovernor({ levels: [] })).toThrow(RangeError)
    expect(() => new ResolutionGovernor({ levels: [0.9, 0.5] })).toThrow(RangeError)
    expect(() => new ResolutionGovernor({ levels: [1, 0.5, 0.7] })).toThrow(RangeError)
    expect(() => new ResolutionGovernor({ levels: [1, 0] })).toThrow(RangeError)
    expect(new ResolutionGovernor({ levels: [1] }).scale).toBe(1)
  })
})
