import { describe, expect, it } from 'vitest'
import { BOXED_NUMBER, bytesPerCall } from './allocation.ts'

describe('bytesPerCall (allocation test helper)', () => {
  it('reads below 1 byte per call for a function that does not allocate', () => {
    const state = new Float64Array(1)
    const step = (x: number) => Math.sqrt(x * x + 1) // a number returned through a call: boxed until inlined
    expect(bytesPerCall(() => void (state[0] = step(state[0]! + 0.37) % 1))).toBeLessThan(1)
  })

  it('reads a boxed number per call', () => {
    // A field that has held a string can hold any value: a fractional number stored there is boxed.
    const holder: { v: unknown } = { v: 'any' }
    holder.v = 0
    const fn = () => void (holder.v = ((holder.v as number) + 0.37) % 1)
    expect(bytesPerCall(fn)).toBeGreaterThanOrEqual(BOXED_NUMBER)
  })

  it('reads one small object per call', () => {
    const keep: object[] = [] // escapes: V8 cannot remove the allocation
    let i = 0
    expect(bytesPerCall(() => void (keep[i++ & 63] = { i }))).toBeGreaterThanOrEqual(BOXED_NUMBER)
  })

  it('reads a function that allocates a lot, collections inside the windows included', () => {
    const keep: number[][] = []
    let i = 0
    // An array of 128 elements (on the heap, unlike a typed array's data): 1074 bytes a call, 5 MB a window, several
    // young-generation collections per window. Under load the measure can read up to about 10 % low (see the helper).
    const fn = () => void (keep[i++ & 7] = new Array<number>(128).fill(i))
    expect(bytesPerCall(fn, { warmup: 1000 })).toBeGreaterThan(800)
  })
})
