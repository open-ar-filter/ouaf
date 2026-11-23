/**
 * Per-face inputs of a shader layer (spec §11.1): `ouaf_faceCount`, `ouaf_faceSize[i]` and the declared anchors
 * `ouaf_anchor_<name>[i]`, computed every frame into preallocated arrays (uniform values). Pure math, no WebGL: unit
 * tested in Node.
 *
 * Positions are in the shader's `uv` space: 0 to 1 over the image as displayed (mirroring applied, since anchor poses
 * are mirrored), origin at the bottom left, y up. Sizes are in `uv` units of the image height: the projected distance
 * between the eye centres (one face unit, spec §5.1) divided by the image height.
 */
import { Matrix4 } from 'three'
import type { AnchorProvider } from '../../engine/anchor-provider.ts'

// The helpers below take points and matrices as arrays and write their results into arrays: a fractional number
// passed to or returned from a call V8 does not inline is boxed, i.e. allocated on every frame (#149, #159).

/**
 * Writes the `uv` position of camera-space point `point[offset … offset + 2]` (x, y, z) into `out[i]`, `out[i + 1]`;
 * false behind the camera.
 */
export function projectToUv(projection: ArrayLike<number>, point: ArrayLike<number>, offset: number, out: Float32Array, i: number): boolean {
  const p = projection
  const x = point[offset]!
  const y = point[offset + 1]!
  const z = point[offset + 2]!
  const w = p[3]! * x + p[7]! * y + p[11]! * z + p[15]!
  if (!(w > 1e-6)) return false
  out[i] = ((p[0]! * x + p[4]! * y + p[8]! * z + p[12]!) / w) * 0.5 + 0.5
  out[i + 1] = ((p[1]! * x + p[5]! * y + p[9]! * z + p[13]!) / w) * 0.5 + 0.5
  return true
}

/**
 * Writes into `out[i]` the projected size of one face unit at anchor matrix `m` (column-major, objects camera space),
 * in units of the image height; 0 behind the camera. The same measure as the warp radius (`WarpPacker`).
 */
export function projectedUnit(projection: ArrayLike<number>, m: ArrayLike<number>, out: Float32Array, i: number): void {
  const p = projection
  const w = p[3]! * m[12]! + p[7]! * m[13]! + p[11]! * m[14]! + p[15]!
  if (w > 1e-6) out[i] = (Math.sqrt(m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!) * p[5]!) / (2 * w)
  else out[i] = 0
}

export class ShaderFaceInputs {
  readonly maxFaces: number
  readonly anchors: readonly string[]
  /** `ouaf_faceSize`. */
  readonly sizes: Float32Array
  /** `ouaf_anchor_<name>`, one array of `maxFaces` vec2 per declared anchor, in `anchors` order. */
  readonly positions: readonly Float32Array[]
  /** `ouaf_faceCount`. */
  count = 0
  readonly #sizes: boolean
  #m = new Matrix4()

  /** `sizes`: compute `ouaf_faceSize` (only when the shader reads it). */
  constructor(maxFaces: number, anchors: readonly string[], sizes: boolean) {
    this.maxFaces = maxFaces
    this.anchors = anchors
    this.sizes = new Float32Array(maxFaces)
    this.positions = anchors.map(() => new Float32Array(maxFaces * 2))
    this.#sizes = sizes
  }

  /**
   * Updates the inputs for the `faceCount` tracked faces (slot order). `projection` is the objects camera's
   * projection matrix (cover crop included). A face or anchor that cannot be placed reads as size 0 at (0, 0); slots
   * from `count` on are left as they are (only meaningful for `i < ouaf_faceCount`, spec §11.1).
   */
  update(anchors: AnchorProvider, faceCount: number, projection: ArrayLike<number>): void {
    const count = Math.min(faceCount, this.maxFaces)
    this.count = count
    const m = this.#m
    const e = m.elements
    for (let f = 0; f < count; f++) {
      if (this.#sizes) {
        if (anchors.face(f, 'head', 'rigid', m)) projectedUnit(projection, e, this.sizes, f)
        else this.sizes[f] = 0
      }
      for (let a = 0; a < this.anchors.length; a++) {
        const out = this.positions[a]!
        if (!anchors.face(f, this.anchors[a]!, 'auto', m) || !projectToUv(projection, e, 12, out, f * 2)) {
          out[f * 2] = 0
          out[f * 2 + 1] = 0
        }
      }
    }
  }
}
