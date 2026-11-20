import { describe, expect, it } from 'vitest'
import { BLENDSHAPE_COUNT, BLENDSHAPE_NAMES, LANDMARKS_STRIDE, MATRIX_STRIDE, blendshapeIndex, createFaceFrame } from '../src/index.ts'

describe('FaceFrame', () => {
  it('has 52 blendshapes, _neutral first', () => {
    expect(BLENDSHAPE_COUNT).toBe(52)
    expect(BLENDSHAPE_NAMES[0]).toBe('_neutral')
    expect(new Set(BLENDSHAPE_NAMES).size).toBe(52)
    expect(blendshapeIndex('jawOpen')).toBe(25)
  })

  it('preallocates every array for maxFaces', () => {
    const f = createFaceFrame(4)
    expect(f.count).toBe(0)
    expect(f.landmarks.length).toBe(4 * LANDMARKS_STRIDE)
    expect(f.blendshapes.length).toBe(4 * BLENDSHAPE_COUNT)
    expect(f.matrices.length).toBe(4 * MATRIX_STRIDE)
  })

  it('rejects invalid capacities', () => {
    expect(() => createFaceFrame(0)).toThrow(RangeError)
    expect(() => createFaceFrame(1.5)).toThrow(RangeError)
  })
})
