import { describe, expect, it } from 'vitest'
import { instanceCount, parseFacesSelector, selectFaces, type FacesSelector } from '../src/layers/faces.ts'
import { bytesPerCall } from './allocation.ts'

describe('faces selector', () => {
  const out = new Int32Array(4)
  const run = (faces: FacesSelector, count: number, ids: number[], sizes: number[], ok?: number[], room = out) =>
    [...room.subarray(0, selectFaces(faces, count, ids, sizes, room, ok))]

  it('parses `faces`, `all` by default', () => {
    expect(parseFacesSelector(undefined)).toBe('all')
    expect(parseFacesSelector('first')).toBe('first')
    expect(parseFacesSelector('largest')).toBe('largest')
    expect(parseFacesSelector(2)).toBe(2)
    expect(parseFacesSelector(0)).toBe('all')
    expect(parseFacesSelector(1.5)).toBe('all')
  })

  it('sizes the instances for `faces`', () => {
    expect(instanceCount('all', 4)).toBe(4)
    expect(instanceCount('first', 4)).toBe(1)
    expect(instanceCount('largest', 4)).toBe(1)
    expect(instanceCount(2, 4)).toBe(2)
    expect(instanceCount(9, 4)).toBe(4)
  })

  it('selects every face, the oldest, the largest, or the n oldest', () => {
    const ids = [7, 3, 9, 5]
    const sizes = [0.1, 0.3, 0.2, 0.05]
    expect(run('all', 4, ids, sizes)).toEqual([0, 1, 2, 3])
    expect(run('all', 2, ids, sizes)).toEqual([0, 1])
    expect(run('first', 4, ids, sizes)).toEqual([1]) // id 3
    expect(run('largest', 4, ids, sizes)).toEqual([1])
    expect(run(2, 4, ids, sizes)).toEqual([1, 3]) // ids 3, 5
    expect(run(16, 4, ids, sizes)).toEqual([1, 3, 0, 2])
    expect(run('first', 0, ids, sizes)).toEqual([])
    expect(run('largest', 0, ids, sizes)).toEqual([])
  })

  it('puts slots without an id yet after the identified faces, in slot order', () => {
    const ids = [0, 4, 0, 2]
    expect(run(4, 4, ids, [0, 0, 0, 0])).toEqual([3, 1, 0, 2])
    expect(run('first', 3, ids, [0, 0, 0])).toEqual([1])
    expect(run('first', 1, ids, [0])).toEqual([0])
  })

  it('skips the slots whose anchor is not available', () => {
    const ids = [5, 2, 9, 0]
    const sizes = [0.1, 0.3, 0.9, 0.2]
    const ok = [1, 1, 0, 1]
    expect(run('all', 4, ids, sizes, ok)).toEqual([0, 1, 3])
    expect(run('first', 4, ids, sizes, ok)).toEqual([1])
    expect(run(3, 4, ids, sizes, ok)).toEqual([1, 0, 3])
    expect(run('largest', 4, ids, sizes, ok)).toEqual([1]) // slot 2 is larger but has no anchor
    expect(run('largest', 4, ids, sizes, [0, 0, 0, 0])).toEqual([])
  })

  it('keeps the lowest slot on a size tie and writes at most out.length slots', () => {
    expect(run('largest', 3, [1, 2, 3], [0.2, 0.2, 0.1])).toEqual([0])
    const two = new Int32Array(2)
    expect(run('all', 4, [1, 2, 3, 4], [0, 0, 0, 0], undefined, two)).toEqual([0, 1])
    expect(run(4, 4, [4, 3, 2, 1], [0, 0, 0, 0], undefined, two)).toEqual([3, 2])
  })

  it('does not allocate', () => {
    const ids = new Int32Array([7, 3, 0, 5])
    const sizes = new Float64Array([0.1, 0.3, 0.2, 0.05])
    const ok = new Uint8Array([1, 1, 1, 0])
    expect(bytesPerCall(() => selectFaces(3, 4, ids, sizes, out, ok))).toBeLessThan(1)
  })
})
