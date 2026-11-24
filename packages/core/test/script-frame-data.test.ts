import { Camera, Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'
import type { AnchorProvider } from '../src/engine/anchor-provider.ts'
import type { FaceBindingData } from '../src/bindings/face-data.ts'
import { BLENDSHAPE_NAMES, LANDMARK_COUNT, LANDMARKS_STRIDE, createFaceFrame, type FaceFrame } from '../src/face.ts'
import { FrameDataBuilder, landmarksToDisplay, type FrameDataSource } from '../src/script/frame-data.ts'

/** Binding data whose readers give `value(path, face)`; `missing` paths resolve to nothing. */
function bindingData(value: (path: string, face: number) => number, missing: readonly string[] = [], blendshapes = true) {
  const resolved: string[] = []
  const data = {
    blendshapes,
    resolve(path: string) {
      resolved.push(path)
      if (missing.includes(path)) return undefined
      if (path === 'face.size' && missing.includes('size:string')) return { type: 'string', perFace: true, read: () => 'x' }
      return { type: 'number', perFace: true, read: (face: number, out: Float64Array, i: number) => void (out[i] = value(path, face)) }
    },
  }
  return { data: data as unknown as FaceBindingData, resolved }
}

/** Face slot i has id `ids[i]` (0: no face); anchor `noseTip` sits at (0.5·i, 0.5, -1), `chin` is never visible. */
function anchorsFor(ids: readonly number[]): AnchorProvider {
  return {
    face: (face, anchor, _follow, m) => (anchor === 'chin' ? false : (m.makeTranslation(0.5 * face, 0.5, -1), true)),
    screen: (m) => void m.identity(),
    id: (face) => ids[face] ?? 0,
  }
}

function source(faces: FaceFrame, ids: readonly number[], data: FaceBindingData): FrameDataSource {
  const camera = new Camera()
  camera.projectionMatrix.copy(new Matrix4().makeScale(0.5, 0.5, 1))
  return { faces, anchors: anchorsFor(ids), bindingData: data, camera, videoToClip: { ax: 2, bx: -1, ay: -2, by: 1 }, aspect: 1 }
}

describe('script frame data (spec §12.4, §15.2)', () => {
  const pose = (path: string, face: number) => ({ 'face.pose.yaw': 10, 'face.pose.pitch': 20, 'face.pose.roll': 30, 'face.size': 0.25 })[path]! + face

  it('gives only the id and index of each tracked face without uses, and skips slots without an id', () => {
    const faces = createFaceFrame(3)
    faces.count = 3
    const { data } = bindingData(pose)
    const built = new FrameDataBuilder([], ['noseTip']).build(source(faces, [4, 0, 9], data))
    expect(built).toEqual([{ id: 4, index: 0 }, { id: 9, index: 2 }])
  })

  it('reads pose and size for face.pose, through readers resolved once', () => {
    const faces = createFaceFrame(2)
    faces.count = 2
    const { data, resolved } = bindingData(pose)
    const builder = new FrameDataBuilder(['face.pose'], [])
    const src = source(faces, [1, 2], data)
    expect(builder.build(src)).toEqual([
      { id: 1, index: 0, pose: { yaw: 10, pitch: 20, roll: 30 }, size: 0.25 },
      { id: 2, index: 1, pose: { yaw: 11, pitch: 21, roll: 31 }, size: 1.25 },
    ])
    builder.build(src)
    expect(resolved).toEqual(['face.pose.yaw', 'face.pose.pitch', 'face.pose.roll', 'face.size'])
  })

  it('gives NaN for a value it has no number reader for', () => {
    const faces = createFaceFrame(1)
    faces.count = 1
    const { data } = bindingData(pose, ['face.pose.pitch', 'size:string'])
    const [face] = new FrameDataBuilder(['face.pose'], []).build(source(faces, [1], data))
    expect(face!.pose).toEqual({ yaw: 10, pitch: NaN, roll: 30 })
    expect(face!.size).toBeNaN()
  })

  it('gives the blendshapes by name (without _neutral), unless they are dropped', () => {
    const faces = createFaceFrame(2)
    faces.count = 2
    const n = BLENDSHAPE_NAMES.length
    for (let k = 0; k < n; k++) faces.blendshapes[n + k] = k / 100 // face slot 1
    const { data } = bindingData(pose)
    const [, second] = new FrameDataBuilder(['face.blendshapes'], []).build(source(faces, [1, 2], data))
    expect(Object.keys(second!.blendshapes!)).toEqual(BLENDSHAPE_NAMES.slice(1))
    expect(second!.blendshapes!.browDownLeft).toBeCloseTo(0.01)
    expect(second!.blendshapes![BLENDSHAPE_NAMES[n - 1]!]).toBeCloseTo((n - 1) / 100)
    expect(second!.pose).toBeUndefined() // not in uses

    const dropped = bindingData(pose, [], false).data
    const [face] = new FrameDataBuilder(['face.blendshapes'], []).build(source(faces, [1], dropped))
    expect(face).toEqual({ id: 1, index: 0 })
  })

  it('projects the anchors to normalized display space, y down, leaving out the ones not found', () => {
    const faces = createFaceFrame(2)
    faces.count = 2
    const { data } = bindingData(pose)
    const built = new FrameDataBuilder(['face.anchors'], ['noseTip', 'chin']).build(source(faces, [1, 2], data))
    // Projection scales by 0.5: (0, 0.5) → clip (0, 0.25) → display (0.5, 0.375); (0.5, 0.5) → (0.625, 0.375).
    expect(built.map((f) => f.anchors)).toEqual([{ noseTip: [0.5, 0.375] }, { noseTip: [0.625, 0.375] }])
  })

  it('gives the landmarks of each face in display space for face.landmarks', () => {
    const faces = createFaceFrame(2)
    faces.count = 2
    faces.landmarks.set([0.25, 0.75, 0.1], LANDMARKS_STRIDE) // landmark 0 of face slot 1
    const { data } = bindingData(pose)
    const [first, second] = new FrameDataBuilder(['face.landmarks'], []).build(source(faces, [1, 2], data))
    expect(first!.landmarks).toBeInstanceOf(Float32Array)
    expect(first!.landmarks!.length).toBe(LANDMARK_COUNT * 3)
    expect([...second!.landmarks!.subarray(0, 3)].map((x) => +x.toFixed(4))).toEqual([0.25, 0.75, 0.1])
  })
})

describe('landmarksToDisplay', () => {
  it('maps video coordinates through the view, mirroring included, and scales z like x', () => {
    const faces = createFaceFrame(1)
    faces.landmarks.set([0.2, 0.3, 0.5, 1, 0, -0.5])
    const round = (a: Float32Array) => [...a.subarray(0, 6)].map((x) => +x.toFixed(4))
    // Not mirrored, the video spans the view: x and y unchanged, z × 1.
    expect(round(landmarksToDisplay(faces, 0, { ax: 2, bx: -1, ay: -2, by: 1 }))).toEqual([0.2, 0.3, 0.5, 1, 0, -0.5])
    // Mirrored: x flips.
    expect(round(landmarksToDisplay(faces, 0, { ax: -2, bx: 1, ay: -2, by: 1 }))).toEqual([0.8, 0.3, 0.5, 0, 0, -0.5])
    // Cropped (cover): the video is twice the view's width, centred (x = 0.2 is off screen); z scales with x.
    expect(round(landmarksToDisplay(faces, 0, { ax: 4, bx: -2, ay: -2, by: 1 }))).toEqual([-0.1, 0.3, 1, 1.5, 0, -1])
  })
})
