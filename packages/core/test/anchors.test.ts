import { describe, expect, it } from 'vitest'
import {
  ANCHOR_DEFAULT_FOLLOW,
  LANDMARK_ANCHORS,
  LANDMARK_ANCHOR_NAMES,
  LANDMARK_COUNT,
  LANDMARKS_STRIDE,
  createFaceFrame,
  liveAnchorPosition,
} from '../src/index.ts'

describe('anchor mapping', () => {
  it('uses valid landmark indices', () => {
    for (const name of LANDMARK_ANCHOR_NAMES) {
      for (const i of LANDMARK_ANCHORS[name]) {
        expect(Number.isInteger(i) && i >= 0 && i < LANDMARK_COUNT, `${name}: ${i}`).toBe(true)
      }
    }
  })

  it('has a default follow mode for head and every landmark anchor', () => {
    expect(Object.keys(ANCHOR_DEFAULT_FOLLOW).sort()).toEqual(['head', ...LANDMARK_ANCHOR_NAMES].sort())
    expect(ANCHOR_DEFAULT_FOLLOW.chin).toBe('expression')
    expect(ANCHOR_DEFAULT_FOLLOW.eyes).toBe('rigid')
  })

  it('pairs left and right anchors', () => {
    for (const name of LANDMARK_ANCHOR_NAMES.filter((n) => n.startsWith('left'))) {
      expect(LANDMARK_ANCHOR_NAMES).toContain(name.replace('left', 'right'))
    }
  })
})

describe('liveAnchorPosition', () => {
  it('averages the landmarks of the requested face', () => {
    const f = createFaceFrame(2)
    f.count = 2
    const set = (face: number, i: number, x: number, y: number, z: number) => {
      f.landmarks.set([x, y, z], face * LANDMARKS_STRIDE + i * 3)
    }
    set(1, 13, 0.4, 0.6, -0.02)
    set(1, 14, 0.6, 0.8, 0.02)
    set(0, 13, 9, 9, 9)
    const p = liveAnchorPosition(f, 1, 'mouth', { x: 0, y: 0, z: 0 })
    expect(p.x).toBeCloseTo(0.5)
    expect(p.y).toBeCloseTo(0.7)
    expect(p.z).toBeCloseTo(0)
  })
})
