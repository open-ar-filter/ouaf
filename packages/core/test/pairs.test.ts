import { Matrix4, PerspectiveCamera } from 'three'
import { describe, expect, it } from 'vitest'
import { createFaceFrame, estimateFacePoses } from '../src/index.ts'
import { FACE_UNIT_CM, FaceAnchors, TRACKER_FOV_Y } from '../src/engine/anchor-provider.ts'
import { DEFAULT_PAIR_GRACE_MS, DEFAULT_PAIR_SEPARATE_MS, PAIR_GAP_LIMIT, PAIR_HYSTERESIS, PairContacts, PairGeometry } from '../src/expressions/pairs.ts'
import type { VideoToClip } from '../src/viewport.ts'
import { bytesPerCall } from './allocation.ts'
import { writeSyntheticFace, type SyntheticPose } from './synthetic-face.ts'

/** The whole 1280 × 720 frame is shown: video → clip without crop. */
const FULL: VideoToClip = { ax: 2, bx: -1, ay: -2, by: 1 }
const ASPECT = 16 / 9

function camera(): PerspectiveCamera {
  const c = new PerspectiveCamera(TRACKER_FOV_Y, ASPECT, 1, 10000)
  c.updateProjectionMatrix()
  return c
}

/** Measures synthetic faces placed with `poses` (ids 1, 2, …), seen on screen. */
function measure(poses: SyntheticPose[], options: { mirrored?: boolean; ids?: number[]; maxFaces?: number } = {}): PairGeometry {
  const faces = createFaceFrame(options.maxFaces ?? Math.max(2, poses.length))
  faces.count = poses.length
  poses.forEach((pose, i) => writeSyntheticFace(faces, i, pose))
  estimateFacePoses(faces)
  const cam = camera()
  const anchors = new FaceAnchors(faces, cam)
  anchors.setFrame(faces, Int32Array.from(options.ids ?? poses.map((_, i) => i + 1)), options.mirrored ?? false)
  const view = options.mirrored ? { ...FULL, ax: -2, bx: 1 } : FULL
  const g = new PairGeometry(faces.maxFaces)
  g.update(faces, anchors, cam.projectionMatrix, view, ASPECT, new Matrix4())
  return g
}

describe('pair geometry (spec §12.4)', () => {
  it('measures the distance between the head centres in face units, whatever the depth', () => {
    const near = measure([{ t: [-9, 0, -60] }, { t: [9, 0, -60] }])
    expect(near.count).toBe(2)
    expect(near.pairCount).toBe(1)
    expect([near.id[near.a[0]!], near.id[near.b[0]!]]).toEqual([1, 2])
    expect(near.distance[0]).toBeCloseTo(18 / FACE_UNIT_CM, 1)
    // Twice as far from the camera: the same distance in face units.
    const far = measure([{ t: [-18, 0, -120] }, { t: [18, 0, -120] }])
    expect(far.distance[0]).toBeCloseTo(36 / FACE_UNIT_CM, 1)
    // A turned head keeps its unit (the head frame, not the eye distance on screen).
    const turned = measure([{ t: [-9, 0, -60], yaw: 40 }, { t: [9, 0, -60] }])
    expect(turned.distance[0]).toBeCloseTo(near.distance[0]!, 0)
  })

  it('gives the gap between the face outlines: 0 when they touch or overlap', () => {
    const apart = measure([{ t: [-14, 0, -60] }, { t: [14, 0, -60] }])
    const close = measure([{ t: [-9, 0, -60] }, { t: [9, 0, -60] }])
    const overlap = measure([{ t: [-4, 0, -60] }, { t: [4, 0, -60] }])
    expect(apart.gap[0]).toBeGreaterThan(close.gap[0]!)
    expect(close.gap[0]).toBeGreaterThan(0)
    expect(overlap.gap[0]).toBe(0)
    // 10 cm further apart: the gap grows by about 10 cm in face units.
    expect(apart.gap[0]! - close.gap[0]!).toBeCloseTo(10 / FACE_UNIT_CM, 0)
    // One face in front of the other: they overlap on screen.
    expect(measure([{ t: [0, 0, -60] }, { t: [2, 0, -120] }]).gap[0]).toBe(0)
    // Far apart: a lower bound only, above the limit.
    expect(measure([{ t: [-40, 0, -60] }, { t: [40, 0, -60] }]).gap[0]).toBeGreaterThan(PAIR_GAP_LIMIT)
  })

  it('measures the same on a mirrored view, and skips faces without an id', () => {
    const plain = measure([{ t: [-9, 2, -60] }, { t: [9, -2, -60] }])
    const mirrored = measure([{ t: [-9, 2, -60] }, { t: [9, -2, -60] }], { mirrored: true })
    expect(mirrored.distance[0]).toBeCloseTo(plain.distance[0]!, 6)
    expect(mirrored.gap[0]).toBeCloseTo(plain.gap[0]!, 6)
    const three = measure([{ t: [-20, 0, -60] }, { t: [0, 0, -60] }, { t: [20, 0, -60] }])
    expect(three.pairCount).toBe(3)
    const missing = measure([{ t: [-20, 0, -60] }, { t: [0, 0, -60] }, { t: [20, 0, -60] }], { ids: [4, 0, 6] })
    expect([missing.count, missing.pairCount]).toEqual([2, 1])
    expect([missing.id[0], missing.id[1], missing.slot[1]]).toEqual([4, 6, 2])
  })
})

/** A geometry with the given pairs of ids and gaps, written by hand. */
function gaps(pairs: Array<[number, number, number]>): PairGeometry {
  const g = new PairGeometry(4)
  const ids = [...new Set(pairs.flatMap(([a, b]) => [a, b]))]
  g.count = ids.length
  ids.forEach((id, i) => (g.id[i] = id))
  g.pairCount = pairs.length
  pairs.forEach(([a, b, gap], q) => {
    g.a[q] = ids.indexOf(a)
    g.b[q] = ids.indexOf(b)
    g.gap[q] = gap
    g.distance[q] = 2
  })
  return g
}

const names = (out: ReturnType<PairContacts['update']>) => Array.from({ length: out.count }, (_, i) => `${out.items[i]!.name}:${out.items[i]!.a}-${out.items[i]!.b}`)

describe('pair contacts (spec §13)', () => {
  it('fires pairContact once when the outlines touch, pairSeparate once they are apart for a while', () => {
    const c = new PairContacts(4)
    expect(names(c.update(0, gaps([[1, 2, 0.5]])))).toEqual([])
    expect(c.contact[0]).toBe(0)
    expect(names(c.update(33, gaps([[1, 2, 0]])))).toEqual(['pairContact:1-2'])
    expect(c.contact[0]).toBe(1)
    expect(names(c.update(66, gaps([[1, 2, 0]])))).toEqual([])
    // Within the hysteresis: still in contact.
    expect(names(c.update(100, gaps([[1, 2, PAIR_HYSTERESIS / 2]])))).toEqual([])
    expect(c.contact[0]).toBe(1)
    // Apart, but not for long enough yet: a jitter.
    expect(names(c.update(133, gaps([[1, 2, 0.3]])))).toEqual([])
    expect(c.contact[0]).toBe(1)
    expect(names(c.update(166, gaps([[1, 2, 0]])))).toEqual([])
    expect(names(c.update(200, gaps([[1, 2, 0.3]])))).toEqual([])
    expect(names(c.update(200 + DEFAULT_PAIR_SEPARATE_MS, gaps([[1, 2, 0.3]])))).toEqual(['pairSeparate:1-2'])
    expect(c.contact[0]).toBe(0)
  })

  it('applies the manifest tuning, follows pairs by id, keeps a contact through a tracking gap, ends it when a face left', () => {
    const c = new PairContacts(4, { pairContact: { threshold: 0.2, minDurationMs: 50 }, pairSeparate: { minDurationMs: 0 } })
    expect(names(c.update(0, gaps([[1, 2, 0.15], [1, 3, 1]])))).toEqual([])
    expect(names(c.update(60, gaps([[1, 2, 0.15], [1, 3, 1]])))).toEqual(['pairContact:1-2'])
    // The faces swap places in the frame: the same pair.
    expect(names(c.update(90, gaps([[2, 1, 0.15], [1, 3, 1]])))).toEqual([])
    expect(c.contact[0]).toBe(1)
    expect(names(c.update(120, gaps([[2, 1, 0.2 + PAIR_HYSTERESIS + 0.01], [1, 3, 1]])))).toEqual(['pairSeparate:2-1'])
    expect(names(c.update(150, gaps([[1, 3, 0]])))).toEqual([])
    expect(names(c.update(200, gaps([[1, 3, 0]])))).toEqual(['pairContact:1-3'])
    // Face 3 is not tracked for a moment: still in contact when it comes back.
    expect(names(c.update(230, gaps([])))).toEqual([])
    expect(names(c.update(230 + DEFAULT_PAIR_GRACE_MS, gaps([[1, 3, 0]])))).toEqual([])
    expect(c.contact[0]).toBe(1)
    // Then it leaves: the contact ends after the grace delay of the face ids.
    expect(names(c.update(800, gaps([])))).toEqual([])
    expect(names(c.update(800 + DEFAULT_PAIR_GRACE_MS + 1, gaps([])))).toEqual(['pairSeparate:1-3'])
  })

  it('forgets the contacts without events when time goes back or on reset', () => {
    const c = new PairContacts(2)
    expect(names(c.update(0, gaps([[1, 2, 0]])))).toEqual(['pairContact:1-2'])
    expect(names(c.update(-10, gaps([[1, 2, 0]])))).toEqual(['pairContact:1-2']) // a new run
    c.reset()
    expect(names(c.update(0, gaps([[1, 2, 1]])))).toEqual([])
  })
})

describe('pairs: allocation', () => {
  it('measures pairs and steps contacts without allocating per frame', () => {
    const faces = createFaceFrame(3)
    faces.count = 3
    writeSyntheticFace(faces, 0, { t: [-12, 0, -60] })
    writeSyntheticFace(faces, 1, { t: [0, 0, -60] })
    writeSyntheticFace(faces, 2, { t: [12, 0, -60] })
    estimateFacePoses(faces)
    const cam = camera()
    const anchors = new FaceAnchors(faces, cam)
    anchors.setFrame(faces, Int32Array.of(1, 2, 3), false)
    const g = new PairGeometry(3)
    const c = new PairContacts(3)
    const m = new Matrix4()
    const t = new Float64Array(1)
    const frame = () => {
      g.update(faces, anchors, cam.projectionMatrix, FULL, ASPECT, m)
      t[0] = t[0]! + 33
      c.update(t[0]!, g)
    }
    expect(bytesPerCall(frame)).toBeLessThan(1)
  })
})
