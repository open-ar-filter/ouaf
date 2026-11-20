import { describe, expect, it } from 'vitest'
import { RollingStats, createDistribution, createFrameSample, percentileOfSorted, summarizeInto } from '../src/index.ts'

/** Feeds `count` frames `stepMs` apart, starting at `start`. */
function feed(stats: RollingStats, start: number, count: number, stepMs: number, fill: { trackingMs?: (i: number) => number } = {}) {
  const s = createFrameSample()
  for (let i = 0; i < count; i++) {
    s.now = start + i * stepMs
    s.mediaTime = s.now / 1000
    s.trackingMs = fill.trackingMs?.(i) ?? 10
    s.renderMs = 2
    s.faces = 1
    stats.record(s)
  }
  return start + (count - 1) * stepMs
}

describe('percentileOfSorted', () => {
  it('interpolates between the closest ranks', () => {
    const v = [1, 2, 3, 4]
    expect(percentileOfSorted(v, 4, 0)).toBe(1)
    expect(percentileOfSorted(v, 4, 0.5)).toBe(2.5)
    expect(percentileOfSorted(v, 4, 1)).toBe(4)
    expect(percentileOfSorted([7], 1, 0.95)).toBe(7)
    expect(percentileOfSorted(v, 0, 0.5)).toBeNaN()
  })

  it('summarizeInto sorts the prefix and fills the distribution', () => {
    const scratch = new Float64Array([5, 1, 3, 99])
    const d = summarizeInto(scratch, 3, createDistribution())
    expect(d).toEqual({ mean: 3, p50: 3, p95: 4.8, max: 5 })
    expect(scratch[3]).toBe(99)
    expect(summarizeInto(scratch, 0, createDistribution()).mean).toBeNaN()
  })
})

describe('RollingStats', () => {
  it('computes fps and frame time from consecutive samples', () => {
    const stats = new RollingStats({ windowMs: 1000 })
    feed(stats, 0, 26, 40) // 0..1000 ms
    const snap = stats.compute()
    expect(snap.samples).toBe(26)
    expect(snap.fps).toBe(25)
    expect(snap.frameMs.p50).toBe(40)
    expect(snap.frameMs.p95).toBe(40)
    expect(snap.trackingMs.mean).toBe(10)
    expect(snap.renderMs.p95).toBe(2)
    expect(snap.faces).toBe(1)
  })

  it('reports p50/p95 of the tracking time', () => {
    const stats = new RollingStats({ windowMs: 10_000 })
    feed(stats, 0, 100, 10, { trackingMs: (i) => i + 1 }) // 1..100
    const snap = stats.compute()
    expect(snap.trackingMs.p50).toBeCloseTo(50.5)
    expect(snap.trackingMs.p95).toBeCloseTo(95.05)
    expect(snap.trackingMs.max).toBe(100)
  })

  it('only keeps the samples inside the window', () => {
    const stats = new RollingStats({ windowMs: 1000 })
    feed(stats, 0, 50, 100, { trackingMs: (i) => (i < 30 ? 100 : 5) }) // last at 4900 ms
    const snap = stats.compute()
    // Samples from 3900 to 4900 ms.
    expect(snap.samples).toBe(11)
    expect(snap.trackingMs.max).toBe(5)
    expect(snap.fps).toBeCloseTo(10)
  })

  it('empties the window once frames stop, when given the current time', () => {
    const stats = new RollingStats({ windowMs: 1000 })
    const last = feed(stats, 0, 10, 33)
    expect(stats.compute(undefined, last + 500).samples).toBeGreaterThan(0)
    const snap = stats.compute(undefined, last + 1001)
    expect(snap.samples).toBe(0)
    expect(snap.fps).toBeNaN()
    expect(snap.frameMs.p95).toBeNaN()
    expect(snap.faces).toBeNaN()
  })

  it('wraps around its capacity', () => {
    const stats = new RollingStats({ windowMs: 100_000, capacity: 8 })
    feed(stats, 0, 20, 10, { trackingMs: (i) => i })
    expect(stats.size).toBe(8)
    const snap = stats.compute()
    expect(snap.samples).toBe(8)
    expect(snap.trackingMs.max).toBe(19)
    expect(snap.trackingMs.p50).toBe(15.5) // 12..19
  })

  it('does not count a gap as a frame time', () => {
    const stats = new RollingStats({ windowMs: 100_000 })
    feed(stats, 0, 10, 20)
    stats.markGap()
    feed(stats, 5000, 10, 20)
    const snap = stats.compute()
    expect(snap.samples).toBe(20)
    expect(snap.frameMs.max).toBe(20)
    expect(snap.fps).toBeCloseTo(50)
  })

  it('reset() forgets everything', () => {
    const stats = new RollingStats()
    feed(stats, 0, 10, 20)
    stats.reset()
    expect(stats.size).toBe(0)
    expect(stats.compute().samples).toBe(0)
    feed(stats, 1000, 2, 20)
    expect(stats.compute().frameMs.max).toBe(20)
  })

  it('writes into the snapshot it is given', () => {
    const stats = new RollingStats()
    feed(stats, 0, 3, 20)
    const out = stats.compute()
    expect(stats.compute(out)).toBe(out)
  })

  it('validates its options', () => {
    expect(() => new RollingStats({ capacity: 1 })).toThrow(RangeError)
    expect(() => new RollingStats({ windowMs: 0 })).toThrow(RangeError)
  })
})
