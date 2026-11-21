import { describe, expect, it } from 'vitest'
import { OneEuroBank } from '../src/index.ts'
import { heapGrowth, noise } from './synthetic-face.ts'

const PARAMS = { minCutoff: 1, beta: 0.5, dCutoff: 1 }
const ONE = [1]

/** Runs a one-channel filter over `samples` taken at `times`; returns the outputs. */
function run(params: typeof PARAMS, times: number[], samples: number[]): number[] {
  const bank = new OneEuroBank(1, params)
  const out = new Float64Array(1)
  return samples.map((v, i) => {
    bank.filter([v], 0, out, 0, times[i]!, ONE)
    return out[0]!
  })
}

const std = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
}

describe('OneEuroBank', () => {
  it('passes the first sample through and holds a constant', () => {
    const times = Array.from({ length: 30 }, (_, i) => i / 15)
    expect(run(PARAMS, times, times.map(() => 3))).toEqual(times.map(() => 3))
  })

  it('attenuates jitter at rest', () => {
    const rnd = noise(1)
    const times = Array.from({ length: 300 }, (_, i) => i / 15)
    const raw = times.map(() => 0.01 * rnd())
    const filtered = run(PARAMS, times, raw)
    expect(std(filtered.slice(30))).toBeLessThan(0.5 * std(raw.slice(30)))
  })

  it('lags less on fast motion than at rest (adaptive cutoff)', () => {
    const times = Array.from({ length: 60 }, (_, i) => i / 15)
    const ramp = times.map((t) => 2 * t)
    const lagAdaptive = ramp.at(-1)! - run({ ...PARAMS, beta: 4 }, times, ramp).at(-1)!
    const lagFixed = ramp.at(-1)! - run({ ...PARAMS, beta: 0 }, times, ramp).at(-1)!
    expect(lagAdaptive).toBeGreaterThan(0)
    expect(lagAdaptive).toBeLessThan(0.3 * lagFixed)
  })

  it('handles a variable time step: irregular samples of a ramp track it like regular ones', () => {
    const rnd = noise(2)
    const regular = Array.from({ length: 60 }, (_, i) => i / 15)
    // 15 Hz on average with ±40 % jitter of the interval.
    const irregular = [0]
    for (let i = 1; i < 60; i++) irregular.push(irregular[i - 1]! + (1 + 0.4 * rnd()) / 15)
    const lag = (times: number[]) => {
      const out = run(PARAMS, times, times.map((t) => 2 * t))
      return 2 * times.at(-1)! - out.at(-1)!
    }
    expect(lag(irregular)).toBeCloseTo(lag(regular), 1)
  })

  it('ignores a sample that is not newer and keeps the previous output', () => {
    const out = run(PARAMS, [0, 0.1, 0.1, 0.05], [0, 1, 5, 9])
    expect(out[2]).toBe(out[1])
    expect(out[3]).toBe(out[1])
  })

  it('scales the speed per channel, and restarts after reset', () => {
    const bank = new OneEuroBank(2, PARAMS)
    const out = new Float64Array(2)
    bank.filter([0, 0], 0, out, 0, 0, [1, 100])
    bank.filter([1, 1], 0, out, 0, 0.1, [1, 100])
    // Channel 1 sees a 100× faster speed: higher cutoff, closer to the sample.
    expect(out[1]).toBeGreaterThan(out[0]!)
    bank.reset()
    bank.filter([7, 8], 0, out, 0, 0.2, [1, 1])
    expect(Array.from(out)).toEqual([7, 8])
  })

  it('predicts along the filtered speed', () => {
    const bank = new OneEuroBank(1, PARAMS)
    const out = new Float64Array(1)
    for (let i = 0; i < 60; i++) bank.filter([i / 15], 0, out, 0, i / 15, ONE)
    const predicted = new Float64Array(1)
    bank.predict(0.1, predicted, 0)
    expect(bank.speed[0]).toBeCloseTo(1, 1)
    expect(predicted[0]! - out[0]!).toBeCloseTo(0.1, 1)
  })

  it('reads and writes at offsets without allocating', () => {
    const bank = new OneEuroBank(1434, PARAMS)
    const src = new Float32Array(1434 * 2).fill(0.5)
    const dst = new Float32Array(1434 * 2)
    const scale = new Float64Array([1, 2, 1])
    let t = 0
    expect(
      heapGrowth(() => {
        t += 1 / 15
        bank.filter(src, 1434, dst, 1434, t, scale)
      }, 1000),
    ).toBeLessThan(32 * 1024)
    expect(dst[1434]).toBeCloseTo(0.5)
    expect(dst[0]).toBe(0)
  })
})
