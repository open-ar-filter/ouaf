import { describe, expect, it } from 'vitest'
import { FaceIdentityTracker, LANDMARK_COUNT, LANDMARKS_STRIDE, createFaceFrame, type FaceFrame } from '../src/index.ts'
import { heapGrowth, noise } from './synthetic-face.ts'

/** Writes a square "face" of landmarks centred on (`cx`, `cy`) (normalized), `size` wide, in slot `slot`. */
function writeBox(faces: FaceFrame, slot: number, cx: number, cy: number, size: number): void {
  const base = slot * LANDMARKS_STRIDE
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const a = (i / LANDMARK_COUNT) * 2 * Math.PI
    faces.landmarks[base + i * 3] = cx + (size / 2) * Math.cos(a)
    faces.landmarks[base + i * 3 + 1] = cy + (size / 2) * Math.sin(a) * (faces.width / faces.height)
    faces.landmarks[base + i * 3 + 2] = 0
  }
}

interface Face {
  x: number
  y: number
  size: number
}

/** Feeds the faces (in the given order) as one result at `time`; returns their ids in that order. */
function feed(tracker: FaceIdentityTracker, faces: FaceFrame, list: Face[], time: number): number[] {
  faces.count = list.length
  list.forEach((f, i) => writeBox(faces, i, f.x, f.y, f.size))
  tracker.update(faces, time)
  return list.map((_, i) => tracker.ids[i]!)
}

function frame(maxFaces: number): FaceFrame {
  const f = createFaceFrame(maxFaces)
  f.width = 1280
  f.height = 720
  return f
}

describe('FaceIdentityTracker', () => {
  it('gives each new face a new id and keeps it while it moves', () => {
    const t = new FaceIdentityTracker({ maxFaces: 2 })
    const f = frame(2)
    const [a] = feed(t, f, [{ x: 0.3, y: 0.5, size: 0.2 }], 0)
    expect(a).toBe(1)
    expect(Array.from(t.entered.subarray(0, t.enteredCount))).toEqual([1])
    for (let i = 1; i < 30; i++) expect(feed(t, f, [{ x: 0.3 + i * 0.005, y: 0.5, size: 0.2 }], i / 15)).toEqual([1])
    expect(t.enteredCount).toBe(0)
    expect(t.leftCount).toBe(0)
  })

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('keeps stable ids when two faces cross, whatever order they are reported in (seed %i)', (seed) => {
    const t = new FaceIdentityTracker({ maxFaces: 2 })
    const f = frame(2)
    const rnd = noise(seed)
    // Two faces sweep across each other in 2 s at ≈ 15 Hz with irregular intervals and jitter.
    let time = 0
    let ids: number[] = []
    for (let i = 0; i <= 30; i++) {
      const s = i / 30
      const a = { x: 0.2 + 0.6 * s + 0.003 * rnd(), y: 0.5 + 0.003 * rnd(), size: 0.22 }
      const b = { x: 0.8 - 0.6 * s + 0.003 * rnd(), y: 0.52 + 0.003 * rnd(), size: 0.2 }
      const swapped = rnd() > 0
      const got = feed(t, f, swapped ? [b, a] : [a, b], time)
      const [idA, idB] = swapped ? [got[1]!, got[0]!] : got
      if (i === 0) ids = [idA!, idB!]
      expect([idA, idB], `step ${i}`).toEqual(ids)
      time += (1 + 0.3 * rnd()) / 15
    }
    expect(new Set(ids).size).toBe(2)
  })

  it('keeps the id of a face hidden behind the other while they cross (grace delay)', () => {
    const t = new FaceIdentityTracker({ maxFaces: 2 })
    const f = frame(2)
    let ids: number[] = []
    for (let i = 0; i <= 30; i++) {
      const s = i / 30
      const a = { x: 0.2 + 0.6 * s, y: 0.5, size: 0.2 }
      const b = { x: 0.8 - 0.6 * s, y: 0.5, size: 0.2 }
      const time = i / 15
      if (i >= 13 && i <= 17) {
        // Only the front face is tracked for 5 results (≈ 330 ms).
        const [idA] = feed(t, f, [a], time)
        expect(idA).toBe(ids[0])
        expect(t.leftCount).toBe(0)
        continue
      }
      const got = feed(t, f, [b, a], time)
      if (i === 0) ids = [got[1]!, got[0]!]
      expect([got[1], got[0]], `step ${i}`).toEqual(ids)
    }
  })

  it('ends a face after the grace delay; when the person comes back they get a new id', () => {
    const t = new FaceIdentityTracker({ maxFaces: 1, graceMs: 500 })
    const f = frame(1)
    const face = { x: 0.5, y: 0.5, size: 0.2 }
    expect(feed(t, f, [face], 0)).toEqual([1])
    feed(t, f, [], 0.1)
    feed(t, f, [], 0.4)
    expect(t.leftCount).toBe(0)
    // Back within the delay, at the same place: same id.
    expect(feed(t, f, [face], 0.45)).toEqual([1])
    feed(t, f, [], 0.6)
    feed(t, f, [], 1.2)
    expect(Array.from(t.left.subarray(0, t.leftCount))).toEqual([1])
    expect(t.trackId(t.tracks[0]!)).toBe(0)
    // Back at the very same place after the delay: new id (positions only, no recognition).
    expect(feed(t, f, [face], 1.3)).toEqual([2])
    expect(Array.from(t.entered.subarray(0, t.enteredCount))).toEqual([2])
  })

  it('starts a new id for a face that appears far from the face it replaces', () => {
    const t = new FaceIdentityTracker({ maxFaces: 1 })
    const f = frame(1)
    expect(feed(t, f, [{ x: 0.2, y: 0.5, size: 0.15 }], 0)).toEqual([1])
    expect(feed(t, f, [{ x: 0.8, y: 0.5, size: 0.15 }], 1 / 15)).toEqual([2])
    // The first face is still in its grace delay: the pool holds both.
    expect(t.leftCount).toBe(0)
  })

  it('does not match a face that changes size abruptly', () => {
    const t = new FaceIdentityTracker({ maxFaces: 1 })
    const f = frame(1)
    feed(t, f, [{ x: 0.5, y: 0.5, size: 0.1 }], 0)
    expect(feed(t, f, [{ x: 0.5, y: 0.5, size: 0.4 }], 1 / 15)).toEqual([2])
  })

  it('drops the oldest lost face when the pool is full', () => {
    const t = new FaceIdentityTracker({ maxFaces: 1, capacity: 1 })
    const f = frame(1)
    feed(t, f, [{ x: 0.2, y: 0.5, size: 0.15 }], 0)
    expect(feed(t, f, [{ x: 0.8, y: 0.5, size: 0.15 }], 0.1)).toEqual([2])
    expect(Array.from(t.left.subarray(0, t.leftCount))).toEqual([1])
  })

  it('ends every face when time goes backwards (a clip that loops or seeks back)', () => {
    const t = new FaceIdentityTracker({ maxFaces: 1 })
    const f = frame(1)
    const face = { x: 0.5, y: 0.5, size: 0.2 }
    feed(t, f, [face], 5)
    expect(feed(t, f, [face], 0)).toEqual([2])
    expect(Array.from(t.left.subarray(0, t.leftCount))).toEqual([1])
    expect(Array.from(t.entered.subarray(0, t.enteredCount))).toEqual([2])
    t.reset()
    expect(Array.from(t.left.subarray(0, t.leftCount))).toEqual([2])
  })

  it('does not allocate per result', () => {
    const t = new FaceIdentityTracker({ maxFaces: 4 })
    const f = frame(4)
    f.count = 4
    for (let i = 0; i < 4; i++) writeBox(f, i, 0.15 + i * 0.23, 0.5, 0.15)
    let time = 0
    expect(
      heapGrowth(() => {
        time += 1 / 15
        t.update(f, time)
      }, 2000),
    ).toBeLessThan(32 * 1024)
    expect(Array.from(t.ids)).toEqual([1, 2, 3, 4])
  })
})
