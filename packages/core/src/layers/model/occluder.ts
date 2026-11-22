/**
 * The head occluder of `occlusion: "head"` (spec §6.3): an invisible head that only writes depth, drawn before the
 * other objects, so the parts of a model behind the head (the back of a hat brim, the far temple of glasses) are not
 * drawn.
 *
 * The head is an ellipsoid in the `head` anchor frame (spec Appendix D: origin 1.5 face units behind the eyes, 1 unit
 * = the distance between the eye centres), sized on an average adult head (about 15 cm wide, 23 cm high, 19 cm
 * deep). Its front stays a little behind the face surface, so content placed on the face (stickers, the front of
 * glasses) is never hidden by it. PROVISIONAL: a head mesh fitted to the tracked landmarks may replace it.
 */
import { Matrix4, Mesh, MeshBasicMaterial, Quaternion, SphereGeometry, Vector3 } from 'three'

/** Centre of the ellipsoid in the `head` frame (face units). */
export const HEAD_CENTER: readonly [number, number, number] = [0, 0.1, -0.1]
/** Semi-axes of the ellipsoid (face units): half width, half height, half depth. */
export const HEAD_RADII: readonly [number, number, number] = [1.15, 1.75, 1.4]

/** Drawn before every other object of the scene (three sorts opaque objects by `renderOrder` first). */
export const OCCLUDER_RENDER_ORDER = -1000

/** Geometry and material shared by the occluders of a layer. */
export class HeadOccluders {
  readonly geometry = new SphereGeometry(1, 24, 16)
  readonly material = new MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true })
  readonly #local = new Matrix4().compose(new Vector3(...HEAD_CENTER), new Quaternion(), new Vector3(...HEAD_RADII))

  constructor() {
    this.material.name = 'ouaf:head-occluder'
  }

  create(): Mesh {
    const mesh = new Mesh(this.geometry, this.material)
    mesh.name = 'head-occluder'
    mesh.renderOrder = OCCLUDER_RENDER_ORDER
    mesh.matrixAutoUpdate = false
    mesh.frustumCulled = false
    mesh.visible = false
    return mesh
  }

  /** Places `mesh` for a face whose `head` anchor matrix is `head`. */
  place(mesh: Mesh, head: Matrix4): void {
    mesh.matrix.multiplyMatrices(head, this.#local)
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
