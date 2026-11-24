import { Matrix4, PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { computeAnchorMatrix, createFaceFrame, estimateFacePoses } from '../src/index.ts'
import { CANONICAL_EYE_DISTANCE } from '../src/anchoring/anchor-matrix.ts'
import { FACE_UNIT_CM, FaceAnchors, SCREEN_PLANE_DEPTH_CM, TRACKER_FOV_Y } from '../src/engine/anchor-provider.ts'
import { FACE_CAMERA_FOV_Y_DEG } from '../src/anchoring/face-pose.ts'
import { writeSyntheticFace } from './synthetic-face.ts'

function camera(fov = 50, aspect = 16 / 9): PerspectiveCamera {
  const c = new PerspectiveCamera(fov, aspect, 0.1, 1000)
  c.updateProjectionMatrix()
  return c
}

function trackedFace() {
  const faces = createFaceFrame(2)
  faces.count = 1
  writeSyntheticFace(faces, 0, { yaw: 15, pitch: 5, roll: -8, t: [2, 1, -50] })
  estimateFacePoses(faces)
  return faces
}

describe('FaceAnchors (spec §5)', () => {
  it('exposes the face unit and camera constants of the anchoring math', () => {
    expect(FACE_UNIT_CM).toBe(CANONICAL_EYE_DISTANCE)
    expect(TRACKER_FOV_Y).toBe(FACE_CAMERA_FOV_Y_DEG)
    expect(SCREEN_PLANE_DEPTH_CM).toBeGreaterThan(0)
  })

  it('writes the matrix of computeAnchorMatrix for a tracked face', () => {
    const faces = trackedFace()
    const anchors = new FaceAnchors(createFaceFrame(1), camera())
    anchors.setFrame(faces, Int32Array.of(7), false)
    const out = new Matrix4()
    expect(anchors.face(0, 'forehead', 'auto', out)).toBe(true)
    const expected = new Float32Array(16)
    computeAnchorMatrix(faces, 0, 'forehead', 'auto', false, expected)
    expect(out.elements).toEqual(Array.from(expected))
  })

  it('mirrors the poses of a mirrored source', () => {
    const faces = trackedFace()
    const anchors = new FaceAnchors(faces, camera())
    const plain = new Matrix4()
    const mirrored = new Matrix4()
    anchors.setFrame(faces, Int32Array.of(1), false)
    anchors.face(0, 'leftEye', 'rigid', plain)
    anchors.setFrame(faces, Int32Array.of(1), true)
    anchors.face(0, 'leftEye', 'rigid', mirrored)
    // M' = S·M·S: the translation's x flips, y and z stay.
    expect(mirrored.elements[12]).toBeCloseTo(-plain.elements[12]!)
    expect(mirrored.elements[13]).toBeCloseTo(plain.elements[13]!)
    expect(mirrored.elements[14]).toBeCloseTo(plain.elements[14]!)
  })

  it('returns false and leaves out unchanged for an unknown anchor, an untracked slot, or an inherited key', () => {
    const faces = trackedFace()
    const anchors = new FaceAnchors(faces, camera())
    anchors.setFrame(faces, Int32Array.of(1), false)
    const out = new Matrix4().makeTranslation(1, 2, 3)
    const before = [...out.elements]
    expect(anchors.face(0, 'tail', 'auto', out)).toBe(false)
    // Not an own key of the anchor table: no prototype lookup.
    expect(anchors.face(0, 'toString', 'auto', out)).toBe(false)
    expect(anchors.face(1, 'forehead', 'auto', out)).toBe(false) // slot 1 is empty (count = 1)
    expect(out.elements).toEqual(before)
  })

  it('places the screen frame at the screen plane, 1 unit = the visible height there', () => {
    const cam = camera(60)
    const anchors = new FaceAnchors(createFaceFrame(1), cam)
    const out = new Matrix4()
    anchors.screen(out)
    const h = 2 * SCREEN_PLANE_DEPTH_CM * Math.tan((60 * Math.PI) / 360)
    expect(out.elements[0]).toBeCloseTo(h)
    expect(out.elements[5]).toBeCloseTo(h)
    expect(out.elements[10]).toBeCloseTo(h)
    expect(out.elements[14]).toBe(-SCREEN_PLANE_DEPTH_CM)
    // The top centre of the screen frame (0, 0.5) projects to the top edge of the view.
    const top = new Vector3(0, 0.5, 0).applyMatrix4(out).project(cam)
    expect(top.x).toBeCloseTo(0)
    expect(top.y).toBeCloseTo(1)
    // A narrower field of view: a smaller visible height.
    const narrow = new Matrix4()
    new FaceAnchors(createFaceFrame(1), camera(30)).screen(narrow)
    expect(narrow.elements[5]).toBeLessThan(h)
  })

  it('gives the stable id of a slot, 0 outside the tracked faces', () => {
    const faces = createFaceFrame(3)
    faces.count = 2
    const anchors = new FaceAnchors(faces, camera())
    expect(anchors.id(0)).toBe(0) // no ids yet
    anchors.setFrame(faces, Int32Array.of(4, 9, 12), false)
    expect(anchors.id(0)).toBe(4)
    expect(anchors.id(1)).toBe(9)
    expect(anchors.id(2)).toBe(0) // beyond count
    expect(anchors.id(-1)).toBe(0)
    // Ids shorter than the faces: 0.
    anchors.setFrame(faces, [5], false)
    expect(anchors.id(1)).toBe(0)
  })
})
