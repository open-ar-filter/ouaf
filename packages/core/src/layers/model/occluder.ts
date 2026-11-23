/**
 * The head occluder of `occlusion: "head"` (spec §6.3): an invisible head that only writes depth, drawn before the
 * other objects, so the parts of a model behind the head (the back of a hat brim, the far temple of glasses) are not
 * drawn.
 *
 * It is fitted to each tracked face, rebuilt every frame (`writeHeadOccluder`):
 * - **Front and sides**: the face mesh (`anchoring/face-mesh.ts`), MediaPipe's canonical triangles over the face
 *   landmarks placed in camera space, from the forehead to the chin and out to the temples and the jaw. It follows
 *   the face's own shape and expression, so it is as wide as the head at the temples (an ellipsoid is narrow there).
 * - **Depth tolerance**: every vertex of the face mesh is moved back along its camera ray by `DEPTH_TOLERANCE`, so
 *   the occluder covers exactly the face as seen in the image, but content less deep than that behind the face
 *   surface is still drawn: what is placed on the face (stickers, the front and the nose pads of glasses), and the
 *   temples of glasses where they touch the side of the head. Moving the vertices along the face normals instead
 *   would shrink the outline of the face, and show what is behind its edge.
 * - **Back of the head**: a skirt from the contour of the face mesh to the back of an ellipsoid of an average adult
 *   head in the `head` anchor frame (`HEAD_CENTER`, `HEAD_RADII`; about 15 cm wide, 23 cm high, 19 cm deep): from
 *   each contour vertex, `SKIRT_RINGS` points along the meridian of the ellipsoid through it, down to the back pole.
 *   The occluder is closed, and in front of the ears it is no wider than the face, so the near temple of glasses
 *   stays visible up to the ear.
 *
 * When the landmarks of a face are not usable (`writeFaceMesh`), the ellipsoid itself, placed on the `head` anchor,
 * stands in for that face.
 */
import { BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Matrix4, Mesh, MeshBasicMaterial, Quaternion, SphereGeometry, Vector3 } from 'three'
import { FACE_MESH_TRIANGLES, FACE_MESH_VERTICES, FACE_OVAL, writeFaceMesh } from '../../anchoring/face-mesh.ts'
import type { FaceFrame } from '../../face.ts'

/** Centre of the head ellipsoid in the `head` frame (face units). */
export const HEAD_CENTER: readonly [number, number, number] = [0, 0.1, -0.1]
/** Semi-axes of the head ellipsoid (face units): half width, half height, half depth. */
export const HEAD_RADII: readonly [number, number, number] = [1.15, 1.75, 1.4]
/**
 * How far the face mesh is moved back along the camera rays (face units, ≈ 1.3 cm). It covers the error of the
 * tracked depth (MediaPipe's relative z) and the content that touches the face. Measured with the temples of the
 * `glasses` demo, which open from x = ±0.92 at the hinges to ±1.2 face units near the ear (the tracked heads of the
 * test clips are ≈ ±1.25 there), on the turned head of `pesquet-turn` (`e2e/occlusion.spec.ts`): the straight part
 * of the near temple keeps 0.8 to 1 of the length it has without occlusion (0.91 to 1 with 0.35, 0.69 to 1 with
 * 0.15, 0.6 to 1 with 0), and on most frames it reaches the ear whole; below 0.2 its end near the ear is cut first,
 * then breaks up. No pixel of the far temple shows over the face oval at any of these values. Narrower temples (the
 * demo's were ±1.04 before #150) run up to 2.5 cm inside the tracked head before the ear and need ≈ 0.35.
 */
export const DEPTH_TOLERANCE = 0.2
/** Rings of the skirt between the contour of the face and the back pole of the ellipsoid. */
export const SKIRT_RINGS = 5
/** Vertices of a head occluder: the face mesh, the skirt rings, the back pole. */
export const OCCLUDER_VERTICES = FACE_MESH_VERTICES + FACE_OVAL.length * SKIRT_RINGS + 1

/** Drawn before every other object of the scene (three sorts opaque objects by `renderOrder` first). */
export const OCCLUDER_RENDER_ORDER = -1000

const CONTOUR = FACE_OVAL.length
const POLE = OCCLUDER_VERTICES - 1
const ring = (j: number, i: number) => (j === 0 ? FACE_OVAL[i]! : FACE_MESH_VERTICES + (j - 1) * CONTOUR + i)

/** Index buffer of a head occluder: the face mesh triangles, then the skirt, wound like them (static). */
export function headOccluderIndices(): Uint16Array {
  const out = new Uint16Array(FACE_MESH_TRIANGLES.length + CONTOUR * (2 * SKIRT_RINGS + 1) * 3)
  out.set(FACE_MESH_TRIANGLES)
  let k = FACE_MESH_TRIANGLES.length
  for (let i = 0; i < CONTOUR; i++) {
    const n = (i + 1) % CONTOUR
    for (let j = 0; j < SKIRT_RINGS; j++) {
      out[k++] = ring(j, i)
      out[k++] = ring(j + 1, n)
      out[k++] = ring(j + 1, i)
      out[k++] = ring(j, i)
      out[k++] = ring(j, n)
      out[k++] = ring(j + 1, n)
    }
    out[k++] = ring(SKIRT_RINGS, i)
    out[k++] = ring(SKIRT_RINGS, n)
    out[k++] = POLE
  }
  return out
}

const [CX, CY, CZ] = HEAD_CENTER
const [RX, RY, RZ] = HEAD_RADII
/** Landmarks of the outer eye corners, to reject a degenerate mesh. */
const EYE_A = 33 * 3
const EYE_B = 263 * 3

/**
 * Writes into `out` (3 floats per vertex, `OCCLUDER_VERTICES` vertices) the positions of the head occluder of face
 * slot `face`, in the objects camera space (cm, mirrored when `mirrored`, like the anchors), and returns true. `head`
 * is the face's `head` anchor matrix as displayed (`AnchorProvider.face(face, 'head', 'rigid')`, column-major).
 * Returns false when the face's landmarks are not usable (`writeFaceMesh`, or a mesh whose eyes are not about a
 * face unit apart); `out` is then partly written. Allocation-free.
 */
export function writeHeadOccluder(faces: Readonly<FaceFrame>, face: number, mirrored: boolean, head: ArrayLike<number>, out: Float32Array): boolean {
  if (!writeFaceMesh(faces, face, out)) return false
  // The head frame: columns 0–2 are its axes times the face unit (cm), column 3 its origin.
  const ax = head[0]!, ay = head[1]!, az = head[2]!
  const bx = head[4]!, by = head[5]!, bz = head[6]!
  const cx = head[8]!, cy = head[9]!, cz = head[10]!
  const tx = head[12]!, ty = head[13]!, tz = head[14]!
  const unit2 = ax * ax + ay * ay + az * az
  const unit = Math.sqrt(unit2)
  if (!(unit > 1e-6)) return false
  if (mirrored) for (let i = 0; i < FACE_MESH_VERTICES; i++) out[i * 3] = -out[i * 3]!
  // The outer eye corners are ≈ 1.4 face units apart on the canonical face: far from it, the mesh is not a face.
  const ex = out[EYE_A]! - out[EYE_B]!, ey = out[EYE_A + 1]! - out[EYE_B + 1]!, ez = out[EYE_A + 2]! - out[EYE_B + 2]!
  const eyes = Math.sqrt(ex * ex + ey * ey + ez * ez) / unit
  if (!(eyes > 0.5 && eyes < 4)) return false

  // Depth tolerance: each vertex moves away from the camera (at the origin) along its ray.
  const back = DEPTH_TOLERANCE * unit
  for (let i = 0; i < FACE_MESH_VERTICES; i++) {
    const o = i * 3
    const x = out[o]!, y = out[o + 1]!, z = out[o + 2]!
    const f = 1 + back / Math.sqrt(x * x + y * y + z * z)
    out[o] = x * f
    out[o + 1] = y * f
    out[o + 2] = z * f
  }

  // Skirt: from each contour vertex, along the meridian of the ellipsoid through it (ellipsoid coordinates: polar
  // angle α from the front pole, longitude θ around the head's z axis), to the back pole.
  for (let i = 0; i < CONTOUR; i++) {
    const o = FACE_OVAL[i]! * 3
    const dx = out[o]! - tx, dy = out[o + 1]! - ty, dz = out[o + 2]! - tz
    // Head frame (face units), then the ellipsoid's unit sphere.
    const qx = ((ax * dx + ay * dy + az * dz) / unit2 - CX) / RX
    const qy = ((bx * dx + by * dy + bz * dz) / unit2 - CY) / RY
    const qz = ((cx * dx + cy * dy + cz * dz) / unit2 - CZ) / RZ
    const r = Math.sqrt(qx * qx + qy * qy + qz * qz)
    const alpha = r > 1e-6 ? Math.acos(Math.max(-1, Math.min(1, qz / r))) : 0
    const theta = Math.atan2(qy, qx)
    const cosT = Math.cos(theta)
    const sinT = Math.sin(theta)
    for (let j = 1; j <= SKIRT_RINGS; j++) {
      const a = alpha + ((Math.PI - alpha) * j) / (SKIRT_RINGS + 1)
      const s = Math.sin(a)
      const lx = CX + RX * s * cosT
      const ly = CY + RY * s * sinT
      const lz = CZ + RZ * Math.cos(a)
      const v = ring(j, i) * 3
      out[v] = tx + ax * lx + bx * ly + cx * lz
      out[v + 1] = ty + ay * lx + by * ly + cy * lz
      out[v + 2] = tz + az * lx + bz * ly + cz * lz
    }
  }
  const lz = CZ - RZ
  out[POLE * 3] = tx + ax * CX + bx * CY + cx * lz
  out[POLE * 3 + 1] = ty + ay * CX + by * CY + cy * lz
  out[POLE * 3 + 2] = tz + az * CX + bz * CY + cz * lz
  return true
}

/** The occluder of one face slot. */
export interface HeadOccluder {
  /** Fitted to the face (`writeHeadOccluder`), in camera space. */
  readonly mesh: Mesh
  /** The head ellipsoid on the `head` anchor, when the face's landmarks are not usable. */
  readonly fallback: Mesh
}

/** Geometry and material shared by the occluders of a layer. */
export class HeadOccluders {
  readonly material = new MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true, side: DoubleSide })
  readonly #ellipsoid = new SphereGeometry(1, 24, 16)
  readonly #index = new BufferAttribute(headOccluderIndices(), 1)
  readonly #geometries: BufferGeometry[] = []
  readonly #local = new Matrix4().compose(new Vector3(...HEAD_CENTER), new Quaternion(), new Vector3(...HEAD_RADII))

  constructor() {
    this.material.name = 'ouaf:head-occluder'
  }

  create(): HeadOccluder {
    const geometry = new BufferGeometry()
    geometry.setIndex(this.#index)
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(OCCLUDER_VERTICES * 3), 3).setUsage(DynamicDrawUsage))
    this.#geometries.push(geometry)
    const mesh = this.#mesh(geometry, 'head-occluder')
    const fallback = this.#mesh(this.#ellipsoid, 'head-occluder-ellipsoid')
    return { mesh, fallback }
  }

  #mesh(geometry: BufferGeometry, name: string): Mesh {
    const mesh = new Mesh(geometry, this.material)
    mesh.name = name
    mesh.renderOrder = OCCLUDER_RENDER_ORDER
    mesh.matrixAutoUpdate = false
    mesh.frustumCulled = false
    mesh.visible = false
    return mesh
  }

  /**
   * Shows `occluder` for face slot `face` of `faces`, whose `head` anchor matrix (as displayed) is `head`: fitted to
   * the face, or the ellipsoid when its landmarks are not usable.
   */
  place(occluder: HeadOccluder, faces: Readonly<FaceFrame>, face: number, mirrored: boolean, head: Matrix4): void {
    const position = occluder.mesh.geometry.getAttribute('position') as BufferAttribute
    const fitted = writeHeadOccluder(faces, face, mirrored, head.elements, position.array as Float32Array)
    occluder.mesh.visible = fitted
    occluder.fallback.visible = !fitted
    if (fitted) position.needsUpdate = true
    else occluder.fallback.matrix.multiplyMatrices(head, this.#local)
  }

  hide(occluder: HeadOccluder): void {
    occluder.mesh.visible = false
    occluder.fallback.visible = false
  }

  dispose(): void {
    for (const g of this.#geometries) g.dispose()
    this.#ellipsoid.dispose()
    this.material.dispose()
  }
}
