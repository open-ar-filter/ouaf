import { describe, expect, it } from 'vitest'
import {
  CANONICAL_ANCHOR_ORIGINS,
  CANONICAL_EYE_DISTANCE,
  LANDMARK_ANCHOR_NAMES,
  LANDMARKS_STRIDE,
  cameraToVideo,
  computeAnchorMatrix,
  createFaceFrame,
  estimateFacePoses,
  liveAnchorPosition,
  mirrorMatrix,
  type FaceAnchor,
} from '../src/index.ts'
import { heapGrowth, posePoint, poseRotation, writeSyntheticFace, type SyntheticPose } from './synthetic-face.ts'

function face(pose: SyntheticPose) {
  const f = createFaceFrame(2)
  f.count = 1
  writeSyntheticFace(f, 0, pose)
  estimateFacePoses(f)
  return f
}

const column = (m: Float32Array, c: number) => [m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!]
const norm = (v: number[]) => Math.hypot(...v)
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!

describe('canonical anchors', () => {
  it('measures the face unit on the canonical model', () => {
    expect(CANONICAL_EYE_DISTANCE).toBeCloseTo(6.302, 3)
  })

  it('puts the head origin 1.5 units behind the eyes point', () => {
    const eyes = CANONICAL_ANCHOR_ORIGINS.eyes
    const head = CANONICAL_ANCHOR_ORIGINS.head
    expect(head[0]).toBe(eyes[0])
    expect(head[1]).toBe(eyes[1])
    expect(eyes[2] - head[2]).toBeCloseTo(1.5 * CANONICAL_EYE_DISTANCE)
  })

  it('has the person’s left on +x of the model', () => {
    expect(CANONICAL_ANCHOR_ORIGINS.leftEye[0]).toBeGreaterThan(0)
    expect(CANONICAL_ANCHOR_ORIGINS.rightTemple[0]).toBeLessThan(0)
    expect(CANONICAL_ANCHOR_ORIGINS.forehead[1]).toBeGreaterThan(CANONICAL_ANCHOR_ORIGINS.chin[1])
    expect(CANONICAL_ANCHOR_ORIGINS.noseTip[2]).toBeGreaterThan(CANONICAL_ANCHOR_ORIGINS.leftTemple[2])
  })
})

describe('computeAnchorMatrix', () => {
  const pose: SyntheticPose = { yaw: 25, pitch: -10, roll: 12, t: [4, -2, -55] }

  it('orients every anchor like the head, with the face unit as scale', () => {
    const f = face(pose)
    const R = poseRotation(pose)
    const m = new Float32Array(16)
    for (const anchor of ['head', ...LANDMARK_ANCHOR_NAMES] as FaceAnchor[]) {
      expect(computeAnchorMatrix(f, 0, anchor, 'auto', false, m)).toBe(true)
      for (let c = 0; c < 3; c++) {
        const axis = column(m, c)
        expect(norm(axis) / CANONICAL_EYE_DISTANCE).toBeCloseTo(1, 2)
        expect(dot(axis, [R[c * 3]!, R[c * 3 + 1]!, R[c * 3 + 2]!]) / norm(axis)).toBeGreaterThan(0.999)
      }
      expect([m[3], m[7], m[11], m[15]]).toEqual([0, 0, 0, 1])
    }
  })

  it('places rigid origins at the posed canonical points', () => {
    const f = face(pose)
    const m = new Float32Array(16)
    for (const anchor of ['head', 'noseTip', 'leftTemple', 'chin'] as FaceAnchor[]) {
      computeAnchorMatrix(f, 0, anchor, 'rigid', false, m)
      const expected = posePoint(pose, CANONICAL_ANCHOR_ORIGINS[anchor])
      // The pose fit is approximate in depth (≈ 1 %), like MediaPipe's.
      for (let i = 0; i < 3; i++) expect(Math.abs(m[12 + i]! - expected[i]!), anchor).toBeLessThan(0.02 * -expected[2]!)
    }
  })

  it('projects anchors onto their landmarks on screen', () => {
    const f = face(pose)
    const m = new Float32Array(16)
    const p = { x: 0, y: 0, z: 0 }
    const live = { x: 0, y: 0, z: 0 }
    for (const anchor of LANDMARK_ANCHOR_NAMES) {
      for (const follow of ['rigid', 'expression'] as const) {
        computeAnchorMatrix(f, 0, anchor, follow, false, m)
        cameraToVideo(f, m[12]!, m[13]!, m[14]!, p)
        liveAnchorPosition(f, 0, anchor, live)
        expect(Math.abs(p.x - live.x) * f.width, `${anchor} ${follow}`).toBeLessThan(2)
        expect(Math.abs(p.y - live.y) * f.height, `${anchor} ${follow}`).toBeLessThan(2)
      }
    }
  })

  it('follows the live landmarks with expression, the head pose only with rigid', () => {
    const f = face({})
    const rigid = new Float32Array(16)
    const expression = new Float32Array(16)
    computeAnchorMatrix(f, 0, 'chin', 'rigid', false, rigid)
    computeAnchorMatrix(f, 0, 'chin', 'expression', false, expression)
    expect(expression[13]).toBeCloseTo(rigid[13]!, 0)
    // Open the jaw: only the chin landmark moves (the pose fit does not use it).
    f.landmarks[152 * 3 + 1] = f.landmarks[152 * 3 + 1]! + 0.05
    estimateFacePoses(f)
    const rigid2 = new Float32Array(16)
    computeAnchorMatrix(f, 0, 'chin', 'rigid', false, rigid2)
    computeAnchorMatrix(f, 0, 'chin', 'expression', false, expression)
    expect(rigid2[13]).toBeCloseTo(rigid[13]!, 3)
    expect(expression[13]).toBeLessThan(rigid[13]! - 1)
    // `auto` resolves to `expression` for the chin, to `rigid` for the nose tip.
    const auto = new Float32Array(16)
    computeAnchorMatrix(f, 0, 'chin', 'auto', false, auto)
    expect(auto).toEqual(expression)
    // The head has no landmarks: always rigid.
    computeAnchorMatrix(f, 0, 'head', 'expression', false, expression)
    computeAnchorMatrix(f, 0, 'head', 'rigid', false, auto)
    expect(expression).toEqual(auto)
  })

  it('reads the requested face', () => {
    const f = createFaceFrame(2)
    f.count = 2
    writeSyntheticFace(f, 0, { t: [-15, 0, -60] })
    writeSyntheticFace(f, 1, { t: [15, 0, -60] })
    estimateFacePoses(f)
    const m = new Float32Array(16)
    computeAnchorMatrix(f, 1, 'noseTip', 'expression', false, m)
    expect(m[12]).toBeGreaterThan(10)
    computeAnchorMatrix(f, 0, 'noseTip', 'expression', false, m)
    expect(m[12]).toBeLessThan(-10)
  })

  it('frontal face: +x to the image right (the person’s left), +y up, +z to the camera', () => {
    const f = face({})
    const m = new Float32Array(16)
    computeAnchorMatrix(f, 0, 'eyes', 'rigid', false, m)
    expect(m[0]! / CANONICAL_EYE_DISTANCE).toBeCloseTo(1, 2)
    expect(m[5]! / CANONICAL_EYE_DISTANCE).toBeCloseTo(1, 2)
    expect(m[10]! / CANONICAL_EYE_DISTANCE).toBeCloseTo(1, 2)
    const left = new Float32Array(16)
    computeAnchorMatrix(f, 0, 'leftEye', 'rigid', false, left)
    expect(left[12]).toBeGreaterThan(m[12]!)
  })

  it('mirrors by conjugation: positions flip, the frame keeps its handedness, +x stays the screen right', () => {
    const f = face(pose)
    const m = new Float32Array(16)
    const mm = new Float32Array(16)
    computeAnchorMatrix(f, 0, 'leftEye', 'rigid', false, m)
    computeAnchorMatrix(f, 0, 'leftEye', 'rigid', true, mm)
    expect(mm[12]).toBeCloseTo(-m[12]!)
    expect(mm[13]).toBeCloseTo(m[13]!)
    expect(mm[14]).toBeCloseTo(m[14]!)
    const det = (a: Float32Array) => {
      const [x, y, z] = [column(a, 0), column(a, 1), column(a, 2)]
      return x[0]! * (y[1]! * z[2]! - y[2]! * z[1]!) - x[1]! * (y[0]! * z[2]! - y[2]! * z[0]!) + x[2]! * (y[0]! * z[1]! - y[1]! * z[0]!)
    }
    expect(Math.sign(det(mm))).toBe(Math.sign(det(m)))
    expect(det(mm)).toBeGreaterThan(0)
    expect(Array.from(mirrorMatrix(mm, new Float32Array(16)))).toEqual(Array.from(m))
    // Frontal and mirrored: the frame's +x still points to the screen right; the left eye is now on the left.
    const g = face({})
    computeAnchorMatrix(g, 0, 'eyes', 'rigid', true, mm)
    expect(mm[0]).toBeGreaterThan(0)
    const leftEye = new Float32Array(16)
    computeAnchorMatrix(g, 0, 'leftEye', 'rigid', true, leftEye)
    expect(leftEye[12]).toBeLessThan(mm[12]!)
  })

  it('returns false with an identity matrix for a missing face or an invalid pose', () => {
    const f = face({})
    const m = new Float32Array(16).fill(3)
    expect(computeAnchorMatrix(f, 1, 'head', 'auto', false, m)).toBe(false)
    expect(Array.from(m)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    f.matrices.fill(0, 0, 16)
    for (let i = 0; i < 16; i += 5) f.matrices[i] = 1
    expect(computeAnchorMatrix(f, 0, 'head', 'auto', false, m)).toBe(false)
  })

  it('does not allocate', () => {
    const f = face(pose)
    const m = new Float32Array(16)
    expect(f.landmarks.length).toBe(2 * LANDMARKS_STRIDE)
    expect(heapGrowth(() => computeAnchorMatrix(f, 0, 'mouth', 'expression', true, m))).toBeLessThan(32 * 1024)
  })
})
