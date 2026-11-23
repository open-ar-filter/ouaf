import { describe, expect, it } from 'vitest'
import { cameraToVideo, createFaceFrame, estimateFacePose, estimateFacePoses, videoToCamera } from '../src/index.ts'
import { bytesPerCall } from './allocation.ts'
import { poseRotation, writeSyntheticFace, type SyntheticPose } from './synthetic-face.ts'

const POSES: SyntheticPose[] = [
  {},
  { yaw: 30, t: [5, -3, -55] },
  { pitch: -20, roll: 15, t: [-8, 6, -70] },
  { yaw: -40, pitch: 10, roll: -25, t: [12, 10, -45] },
]

describe('estimateFacePose', () => {
  it.each(POSES)('recovers a known pose from its projected landmarks (%o)', (pose) => {
    const f = createFaceFrame(1)
    f.count = 1
    writeSyntheticFace(f, 0, pose)
    expect(estimateFacePose(f, 0, f.matrices)).toBe(true)
    const M = f.matrices
    const R = poseRotation(pose)
    const s = Math.hypot(M[0]!, M[1]!, M[2]!)
    expect(s).toBeCloseTo(1, 2)
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) expect(Math.abs(M[c * 4 + r]! / s - R[c * 3 + r]!)).toBeLessThan(0.02)
    const t = pose.t ?? [0, 0, -60]
    expect(M[12]).toBeCloseTo(t[0], 0)
    expect(M[13]).toBeCloseTo(t[1], 0)
    expect(Math.abs(M[14]! - t[2]) / -t[2]).toBeLessThan(0.02)
    expect(M[15]).toBe(1)
  })

  it('writes an identity matrix and returns false without landmarks', () => {
    const f = createFaceFrame(1)
    f.count = 1
    f.matrices.fill(7)
    expect(estimateFacePose(f, 0, f.matrices)).toBe(false)
    expect(Array.from(f.matrices)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  })

  it('fills the matrix of every face, in its slot', () => {
    const f = createFaceFrame(2)
    f.count = 2
    writeSyntheticFace(f, 0, { t: [-15, 0, -60] })
    writeSyntheticFace(f, 1, { t: [15, 0, -60] })
    estimateFacePoses(f)
    expect(f.matrices[12]).toBeCloseTo(-15, 0)
    expect(f.matrices[16 + 12]).toBeCloseTo(15, 0)
  })

  it('does not allocate', () => {
    const f = createFaceFrame(1)
    f.count = 1
    writeSyntheticFace(f, 0, POSES[3]!)
    expect(bytesPerCall(() => estimateFacePose(f, 0, f.matrices))).toBeLessThan(1)
  })
})

describe('camera ↔ video', () => {
  it('maps the optical axis to the frame centre and round-trips', () => {
    const size = { width: 1280, height: 720 }
    const p = { x: 0, y: 0, z: 0 }
    cameraToVideo(size, 0, 0, -50, p)
    expect(p.x).toBeCloseTo(0.5)
    expect(p.y).toBeCloseTo(0.5)
    // +x right, +y up in camera space; video v goes down.
    cameraToVideo(size, 10, 10, -50, p)
    expect(p.x).toBeGreaterThan(0.5)
    expect(p.y).toBeLessThan(0.5)
    const u = p.x
    const v = p.y
    videoToCamera(size, u, v, -50, p)
    expect(p.x).toBeCloseTo(10)
    expect(p.y).toBeCloseTo(10)
    // Vertical field of view of 63°: the top edge of the frame at depth d is d·tan(31.5°) above the axis.
    cameraToVideo(size, 0, 50 * Math.tan((31.5 * Math.PI) / 180), -50, p)
    expect(p.y).toBeCloseTo(0)
  })
})
