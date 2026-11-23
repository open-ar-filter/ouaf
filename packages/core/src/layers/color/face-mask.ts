/**
 * Mask of `region: "face"` (spec §6.3): the face oval of each tracked face, drawn as a mesh in clip space with a
 * soft edge. Pure math (no WebGL), unit tested in Node.
 *
 * Per face, the mesh is a fan from the centre of the oval to the oval shrunk by `FEATHER` (mask 1), and a ring from
 * there to the oval grown by `FEATHER` (mask 1 → 0): the edge fades over ±`FEATHER` of the centre-to-contour
 * distance, so it scales with the face. The shader smooths the linear ramp.
 *
 * Landmarks (video space) are placed with the objects camera (`ObjectsView.camera`): the ray of each landmark in
 * camera space (`videoToCamera`), mirrored like the anchors when the image is, through the camera's projection, which
 * holds the cover crop. The mask therefore lines up with the video and the objects whatever the fit.
 */
import { FACE_OVAL } from '../../anchoring/face-mesh.ts'
import { videoToCameraInPlace } from '../../anchoring/face-pose.ts'
import { LANDMARKS_STRIDE, type FaceFrame } from '../../face.ts'

export { FACE_OVAL }
const N = FACE_OVAL.length

/** Half-width of the soft edge, relative to the centre-to-contour distance. */
export const FEATHER = 0.1
/** Vertices per face: the centre, the inner contour, the outer contour. */
export const MASK_VERTICES = 1 + 2 * N
/** Indices per face: the fan (N triangles) and the ring (2N triangles). */
export const MASK_INDICES = 9 * N

/** Index buffer for `maxFaces` faces (static). */
export function faceMaskIndices(maxFaces: number): Uint16Array {
  const out = new Uint16Array(maxFaces * MASK_INDICES)
  let k = 0
  for (let f = 0; f < maxFaces; f++) {
    const base = f * MASK_VERTICES
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N
      const inner = (p: number) => base + 1 + p
      const outer = (p: number) => base + 1 + N + p
      out[k++] = base
      out[k++] = inner(i)
      out[k++] = inner(j)
      out[k++] = inner(i)
      out[k++] = outer(i)
      out[k++] = outer(j)
      out[k++] = inner(i)
      out[k++] = outer(j)
      out[k++] = inner(j)
    }
  }
  return out
}

/** Mask value of each vertex for `maxFaces` faces (static): 1 at the centre and inner contour, 0 outside. */
export function faceMaskValues(maxFaces: number): Float32Array {
  const out = new Float32Array(maxFaces * MASK_VERTICES)
  for (let f = 0; f < maxFaces; f++) out.fill(1, f * MASK_VERTICES, f * MASK_VERTICES + 1 + N)
  return out
}

const ray = { x: 0, y: 0, z: 0 }

/**
 * Writes the clip-space positions (x, y) of face slot `face`'s mask vertices into `out` at vertex `MASK_VERTICES ×
 * slot`. `projection` is the objects camera's projection matrix (column-major, `camera.projectionMatrix.elements`).
 */
export function writeFaceMask(
  faces: Readonly<FaceFrame>,
  face: number,
  slot: number,
  mirrored: boolean,
  projection: ArrayLike<number>,
  out: Float32Array,
): void {
  const lm = faces.landmarks
  const o = face * LANDMARKS_STRIDE
  const p0 = projection[0]!
  const p1 = projection[1]!
  const p3 = projection[3]!
  const p4 = projection[4]!
  const p5 = projection[5]!
  const p7 = projection[7]!
  const p8 = projection[8]!
  const p9 = projection[9]!
  const p11 = projection[11]!
  const p12 = projection[12]!
  const p13 = projection[13]!
  const p15 = projection[15]!
  const v = slot * MASK_VERTICES * 2
  // Contour in clip space, stored at the inner contour's place first; centre = mean of the contour.
  let cx = 0
  let cy = 0
  for (let i = 0; i < N; i++) {
    const l = o + FACE_OVAL[i]! * 3
    ray.x = lm[l]!
    ray.y = lm[l + 1]!
    ray.z = -1
    videoToCameraInPlace(faces, ray)
    const x = mirrored ? -ray.x : ray.x
    const w = p3 * x + p7 * ray.y + p11 * ray.z + p15
    const px = (p0 * x + p4 * ray.y + p8 * ray.z + p12) / w
    const py = (p1 * x + p5 * ray.y + p9 * ray.z + p13) / w
    out[v + 2 + i * 2] = px
    out[v + 3 + i * 2] = py
    cx += px
    cy += py
  }
  cx /= N
  cy /= N
  out[v] = cx
  out[v + 1] = cy
  for (let i = 0; i < N; i++) {
    const ix = v + 2 + i * 2
    const dx = out[ix]! - cx
    const dy = out[ix + 1]! - cy
    out[ix] = cx + dx * (1 - FEATHER)
    out[ix + 1] = cy + dy * (1 - FEATHER)
    out[ix + N * 2] = cx + dx * (1 + FEATHER)
    out[ix + N * 2 + 1] = cy + dy * (1 + FEATHER)
  }
}
