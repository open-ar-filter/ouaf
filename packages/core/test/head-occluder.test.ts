import { describe, expect, it } from 'vitest'
import {
  CANONICAL_FACE,
  FACE_MESH_TRIANGLES,
  FACE_MESH_VERTICES,
  FACE_OVAL,
  cameraToVideo,
  computeAnchorMatrix,
  createFaceFrame,
  estimateFacePoses,
  writeFaceMesh,
  type FaceFrame,
} from '../src/index.ts'
import {
  DEPTH_TOLERANCE,
  HEAD_CENTER,
  HEAD_RADII,
  OCCLUDER_VERTICES,
  SKIRT_RINGS,
  headOccluderIndices,
  writeHeadOccluder,
} from '../src/layers/model/occluder.ts'
import { heapGrowth, posePoint, writeSyntheticFace, type SyntheticPose } from './synthetic-face.ts'

const POSES: SyntheticPose[] = [
  {},
  { yaw: 40, t: [5, -3, -55] },
  { yaw: -60, pitch: 10, t: [-8, 6, -70] },
  { pitch: -20, roll: 15, t: [12, 10, -45] },
]

/** A face at `pose`, its landmarks the canonical points the synthetic face uses (`writeSyntheticFace`). */
function faceAt(pose: SyntheticPose): FaceFrame {
  const faces = createFaceFrame(1)
  faces.count = 1
  writeSyntheticFace(faces, 0, pose)
  estimateFacePoses(faces)
  return faces
}

/** The canonical point behind landmark `i` in `writeSyntheticFace` (it repeats the subset for the others). */
const SUBSET = Object.keys(CANONICAL_FACE).map(Number)
const syntheticPoint = (i: number) => CANONICAL_FACE[CANONICAL_FACE[i] ? i : SUBSET[i % SUBSET.length]!]!

/** Edges of `indices` (first `triangles` triangles) as "a,b" → number of triangles using a → b. */
function directedEdges(indices: ArrayLike<number>, triangles = indices.length / 3): Map<string, number> {
  const edges = new Map<string, number>()
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const key = `${indices[t * 3 + k]},${indices[t * 3 + ((k + 1) % 3)]}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  return edges
}

type V3 = [number, number, number]
const vertex = (out: Float32Array, i: number): V3 => [out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!]

/** Triangles of the occluder crossed by the segment from `p` to the camera (at the origin). */
function crossings(out: Float32Array, indices: Uint16Array, p: V3): number {
  let n = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = vertex(out, indices[t]!), b = vertex(out, indices[t + 1]!), c = vertex(out, indices[t + 2]!)
    // Möller–Trumbore, direction p → origin, t in (0, 1).
    const d: V3 = [-p[0], -p[1], -p[2]]
    const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const h: V3 = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]]
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2]
    if (Math.abs(det) < 1e-12) continue
    const s: V3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
    const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det
    if (u < 0 || u > 1) continue
    const q: V3 = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]]
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det
    if (v < 0 || u + v > 1) continue
    const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det
    if (tt > 1e-6 && tt < 1) n++
  }
  return n
}

/** A point given in the `head` frame (face units), in camera space. */
function headPoint(head: Float32Array, x: number, y: number, z: number): V3 {
  return [0, 1, 2].map((r) => head[r]! * x + head[4 + r]! * y + head[8 + r]! * z + head[12 + r]!) as V3
}

describe('face mesh', () => {
  it("is MediaPipe's canonical mesh: 898 triangles over the 468 face landmarks, one contour, one orientation", () => {
    expect(FACE_MESH_TRIANGLES.length).toBe(898 * 3)
    const used = new Set(FACE_MESH_TRIANGLES)
    expect([used.size, Math.min(...used), Math.max(...used)]).toEqual([FACE_MESH_VERTICES, 0, FACE_MESH_VERTICES - 1])
    const edges = directedEdges(FACE_MESH_TRIANGLES)
    // Each edge once per direction: inner edges have both, contour edges one; no edge twice the same way.
    expect([...edges.values()].every((n) => n === 1)).toBe(true)
    const contour = [...edges.keys()].filter((e) => !edges.has(e.split(',').reverse().join(',')))
    // The contour is FACE_OVAL, run backwards (FACE_OVAL turns clockwise seen from the front).
    expect(contour.sort()).toEqual(FACE_OVAL.map((v, i) => `${FACE_OVAL[(i + 1) % FACE_OVAL.length]},${v}`).sort())
  })

  it.each(POSES)('places each landmark on its camera ray, at the depth of the head pose (%o)', (pose) => {
    const faces = faceAt(pose)
    const out = new Float32Array(FACE_MESH_VERTICES * 3)
    expect(writeFaceMesh(faces, 0, out)).toBe(true)
    const M = faces.matrices
    const video = { x: 0, y: 0, z: 0 }
    let ray = 0
    let fitted = 0
    let truth = 0
    for (let i = 0; i < FACE_MESH_VERTICES; i++) {
      const o = vertex(out, i)
      // Lines up with the image: projected back, the vertex is the landmark.
      cameraToVideo(faces, o[0], o[1], o[2], video)
      ray = Math.max(ray, Math.abs(video.x - faces.landmarks[i * 3]!), Math.abs(video.y - faces.landmarks[i * 3 + 1]!))
      // Close to the canonical point placed by the fitted pose (the synthetic depths are not exactly MediaPipe's).
      const c = syntheticPoint(i)
      const q = [0, 1, 2].map((r) => M[r]! * c[0] + M[4 + r]! * c[1] + M[8 + r]! * c[2] + M[12 + r]!)
      fitted = Math.max(fitted, Math.hypot(o[0] - q[0]!, o[1] - q[1]!, o[2] - q[2]!))
      const p = posePoint(pose, c)
      truth = Math.max(truth, Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]) / -p[2])
    }
    expect(ray).toBeLessThan(1e-6)
    expect(fitted).toBeLessThan(0.5) // cm
    expect(truth).toBeLessThan(0.02) // relative to the distance, like the pose itself (face-pose.test.ts)
  })

  it('needs a tracked face with a pose in front of the camera', () => {
    const out = new Float32Array(FACE_MESH_VERTICES * 3)
    const faces = faceAt({})
    expect(writeFaceMesh(faces, 1, out)).toBe(false) // no such slot
    faces.count = 0
    expect(writeFaceMesh(faces, 0, out)).toBe(false)
    faces.count = 1
    faces.matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) // the identity a tracker writes without a pose
    expect(writeFaceMesh(faces, 0, out)).toBe(false)
    const nan = faceAt({})
    nan.landmarks[5] = Number.NaN
    expect(writeFaceMesh(nan, 0, out)).toBe(false)
  })
})

describe('head occluder', () => {
  const indices = headOccluderIndices()

  it('is closed: the face mesh and a skirt to the back pole, every edge shared by two triangles', () => {
    expect(indices.length).toBe((898 + FACE_OVAL.length * (2 * SKIRT_RINGS + 1)) * 3)
    expect(Math.max(...indices)).toBe(OCCLUDER_VERTICES - 1)
    const edges = directedEdges(indices)
    expect([...edges.values()].every((n) => n === 1)).toBe(true)
    expect([...edges.keys()].every((e) => edges.has(e.split(',').reverse().join(',')))).toBe(true)
  })

  it.each(POSES)('moves the face back along the camera rays; the skirt follows the back of the head (%o)', (pose) => {
    const faces = faceAt(pose)
    const head = new Float32Array(16)
    expect(computeAnchorMatrix(faces, 0, 'head', 'rigid', false, head)).toBe(true)
    const unit = Math.hypot(head[0]!, head[1]!, head[2]!)
    const mesh = new Float32Array(FACE_MESH_VERTICES * 3)
    writeFaceMesh(faces, 0, mesh)
    const out = new Float32Array(OCCLUDER_VERTICES * 3)
    expect(writeHeadOccluder(faces, 0, false, head, out)).toBe(true)

    for (const i of [1, 10, 33, 152, 234, 454]) {
      const p = vertex(mesh, i)
      const q = vertex(out, i)
      expect(Math.hypot(...q) - Math.hypot(...p)).toBeCloseTo(DEPTH_TOLERANCE * unit, 3)
      const dir = Math.hypot(...p) * Math.hypot(...q)
      expect((p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) / dir).toBeCloseTo(1, 6) // same ray
    }
    // Skirt and pole: on the head ellipsoid, each ring further back than the previous one.
    const toHead = (p: V3): V3 => {
      const d = [p[0] - head[12]!, p[1] - head[13]!, p[2] - head[14]!]
      return [0, 1, 2].map((c) => (head[c * 4]! * d[0]! + head[c * 4 + 1]! * d[1]! + head[c * 4 + 2]! * d[2]!) / unit ** 2) as V3
    }
    const onEllipsoid = (h: V3) => Math.hypot(...h.map((v, k) => (v - HEAD_CENTER[k]!) / HEAD_RADII[k]!))
    for (let i = 0; i < FACE_OVAL.length; i++) {
      let z = toHead(vertex(out, FACE_OVAL[i]!))[2]
      for (let j = 1; j <= SKIRT_RINGS; j++) {
        const h = toHead(vertex(out, FACE_MESH_VERTICES + (j - 1) * FACE_OVAL.length + i))
        expect(onEllipsoid(h)).toBeCloseTo(1, 4)
        expect(h[2]).toBeLessThan(z)
        z = h[2]
      }
    }
    const pole = toHead(vertex(out, OCCLUDER_VERTICES - 1))
    pole.forEach((v, k) => expect(v).toBeCloseTo([HEAD_CENTER[0], HEAD_CENTER[1], HEAD_CENTER[2] - HEAD_RADII[2]][k]!, 4))
  })

  it.each(POSES)('hides what is inside the head, not what is in front of the face or just under its surface (%o)', (pose) => {
    const faces = faceAt(pose)
    const head = new Float32Array(16)
    computeAnchorMatrix(faces, 0, 'head', 'rigid', false, head)
    const out = new Float32Array(OCCLUDER_VERTICES * 3)
    writeHeadOccluder(faces, 0, false, head, out)
    // The centre of the head and the back of the skull: behind the occluder.
    expect(crossings(out, indices, headPoint(head, 0, 0, -0.3))).toBeGreaterThan(0)
    expect(crossings(out, indices, headPoint(head, 0, 0.5, -1.2))).toBeGreaterThan(0)
    // In front of the nose tip, and 1 cm under the skin of the nose tip: drawn.
    const tip = posePoint(pose, CANONICAL_FACE[1]!)
    const camera = Math.hypot(...tip)
    for (const depth of [-3, 1]) {
      const f = 1 + depth / camera
      expect(crossings(out, indices, [tip[0] * f, tip[1] * f, tip[2] * f])).toBe(0)
    }
  })

  it('mirrors with the image, like the anchors', () => {
    const faces = faceAt(POSES[2]!)
    const head = new Float32Array(16)
    const plain = new Float32Array(OCCLUDER_VERTICES * 3)
    computeAnchorMatrix(faces, 0, 'head', 'rigid', false, head)
    writeHeadOccluder(faces, 0, false, head, plain)
    const mirrored = new Float32Array(OCCLUDER_VERTICES * 3)
    computeAnchorMatrix(faces, 0, 'head', 'rigid', true, head)
    expect(writeHeadOccluder(faces, 0, true, head, mirrored)).toBe(true)
    for (let i = 0; i < OCCLUDER_VERTICES; i++) {
      expect(mirrored[i * 3]).toBeCloseTo(-plain[i * 3]!, 3)
      expect(mirrored[i * 3 + 1]).toBeCloseTo(plain[i * 3 + 1]!, 3)
      expect(mirrored[i * 3 + 2]).toBeCloseTo(plain[i * 3 + 2]!, 3)
    }
  })

  it('works for every face slot, and gives up on landmarks that are not a face', () => {
    const faces = createFaceFrame(2)
    faces.count = 2
    writeSyntheticFace(faces, 0, { t: [-15, 0, -60] })
    writeSyntheticFace(faces, 1, { t: [15, 0, -60] })
    estimateFacePoses(faces)
    const head = new Float32Array(16)
    const out = new Float32Array(OCCLUDER_VERTICES * 3)
    computeAnchorMatrix(faces, 1, 'head', 'rigid', false, head)
    expect(writeHeadOccluder(faces, 1, false, head, out)).toBe(true)
    expect(out[1 * 3]).toBeGreaterThan(5) // landmark 1, the nose tip of the face on the right
    // Every landmark at one point (a tracker without landmarks), with a valid pose: not a face.
    faces.landmarks.fill(0.5, 0, FACE_MESH_VERTICES * 3)
    computeAnchorMatrix(faces, 0, 'head', 'rigid', false, head)
    expect(writeHeadOccluder(faces, 0, false, head, out)).toBe(false)
  })

  it('does not allocate', () => {
    const faces = faceAt(POSES[1]!)
    const head = new Float32Array(16)
    computeAnchorMatrix(faces, 0, 'head', 'rigid', true, head)
    const out = new Float32Array(OCCLUDER_VERTICES * 3)
    expect(heapGrowth(() => writeHeadOccluder(faces, 0, true, head, out))).toBeLessThan(32 * 1024)
  })
})
