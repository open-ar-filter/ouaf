/**
 * Geometry of the `warp` layer (spec §6.3): where each centre lands on screen, how large it is, and how a pixel is
 * displaced. Kept free of WebGL so it runs in the unit tests; `warpSource` is the reference of the GLSL in
 * `shader.ts` (same formulas, same constants).
 *
 * Screen space here is the displayed image (mirroring included, since the anchor poses are mirrored), origin at the
 * centre, +x right, +y up, **1 unit = screen height** (like the screen frame, spec §5.2): circles stay round whatever
 * the aspect ratio.
 *
 * Every deformation is an inverse mapping (for each output pixel, the point of the input image it shows), weighted
 * by the falloff `w = (1 - r²)²` (r = distance / radius): 1 at the centre, 0 with a zero slope at the radius, so the
 * edge is seamless. Strengths stay in [-1, 1] and the formulas below never fold the image over itself in that range.
 */

export const WARP_KINDS = ['bulge', 'pinch', 'swirl', 'stretch'] as const
export type WarpKind = (typeof WARP_KINDS)[number]

/**
 * Bulge / pinch scale change at the centre for |strength| = 1: the source radius is scaled by 1 ∓ this value, so a
 * full bulge magnifies the centre 4× instead of blowing a single pixel up (1 would be singular).
 */
export const BULGE_MAX = 0.75
/** Swirl rotation at the centre for |strength| = 1, in radians (half a turn). */
export const SWIRL_MAX_ANGLE = Math.PI
/**
 * Stretch displacement at the centre for |strength| = 1, in radii. The displacement field's slope peaks at
 * 1.54 × this value (at r = 1/√3), so below 1/1.54 ≈ 0.65 the mapping stays one-to-one.
 */
export const STRETCH_MAX = 0.6
/**
 * Most centres (faces × anchors) one warp pass applies. Each centre takes two vec4 uniforms; 64 × 2 stays within
 * the 224 fragment uniform vectors every WebGL2 implementation provides.
 */
export const MAX_CENTRES = 64
/** Floats per centre in each packed array (one vec4). */
export const CENTRE_STRIDE = 4

/** Falloff of every kind: (1 - r²)² inside the radius, 0 outside. `r2` = (distance / radius)². */
export function falloff(r2: number): number {
  if (r2 >= 1) return 0
  const w = 1 - r2
  return w * w
}

/**
 * Point of the input image shown at screen point (x, y) by one centre (cx, cy) of `radius` (screen units),
 * `strength` in [-1, 1] and, for `stretch`, the unit direction (dx, dy) on screen. Writes it into out[0], out[1].
 *
 * - `bulge`: magnifies (positive strength) or shrinks (negative) the disc around the centre, up to 4× at the centre.
 * - `pinch`: the opposite of bulge (pinch with strength s = bulge with -s).
 * - `swirl`: rotates the disc, by `strength × SWIRL_MAX_ANGLE` at the centre; positive = counter-clockwise on screen.
 * - `stretch`: drags the disc along the direction (negative strength: against it), by up to STRETCH_MAX radii.
 */
export function warpSource(
  kind: WarpKind,
  x: number,
  y: number,
  cx: number,
  cy: number,
  radius: number,
  strength: number,
  dx: number,
  dy: number,
  out: Float64Array | number[],
): void {
  const ex = x - cx
  const ey = y - cy
  const w = falloff((ex * ex + ey * ey) / (radius * radius))
  switch (kind) {
    case 'bulge':
    case 'pinch': {
      const s = kind === 'bulge' ? 1 - strength * BULGE_MAX * w : 1 + strength * BULGE_MAX * w
      out[0] = cx + ex * s
      out[1] = cy + ey * s
      return
    }
    case 'swirl': {
      // The image turns by +a, so the source is the point turned by -a.
      const a = strength * SWIRL_MAX_ANGLE * w
      const c = Math.cos(a)
      const s = Math.sin(a)
      out[0] = cx + c * ex + s * ey
      out[1] = cy - s * ex + c * ey
      return
    }
    case 'stretch': {
      const t = strength * STRETCH_MAX * radius * w
      out[0] = x - dx * t
      out[1] = y - dy * t
      return
    }
  }
}

/**
 * Properties of a centre, `[radius, strength, directionX, directionY]`. Passed as an array rather than as arguments:
 * a fractional number passed to a call V8 does not inline is boxed, i.e. allocated.
 */
export type WarpProps = ArrayLike<number>

/**
 * Packs the centres of a warp pass, one frame at a time, into the uniform arrays of the shader:
 * `a[i] = (x, y, 1 / radius, strength)` and `b[i] = (dirX, dirY, 0, 0)` (screen units, unit direction). Arrays are
 * allocated once for `capacity` centres; `begin` + `addFace`/`addScreen` never allocate.
 */
export class WarpPacker {
  readonly capacity: number
  readonly a: Float32Array
  readonly b: Float32Array
  /** Centres packed this frame. */
  count = 0
  #p: ArrayLike<number> = IDENTITY
  #aspect = 1
  /**
   * Scratch: screen x, y of the centre (0, 1) and of the direction point (2, 3). Numbers go through a typed array
   * rather than return values, so V8 never boxes them (no allocation per frame).
   */
  #s = new Float64Array(4)

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.min(MAX_CENTRES, Math.floor(capacity)))
    this.a = new Float32Array(this.capacity * CENTRE_STRIDE)
    this.b = new Float32Array(this.capacity * CENTRE_STRIDE)
  }

  /**
   * Starts a frame: `projection` is the objects camera's projection matrix (column-major, cover crop included), the
   * render size gives the aspect ratio.
   */
  begin(projection: ArrayLike<number>, width: number, height: number): void {
    this.count = 0
    this.#p = projection
    this.#aspect = width > 0 && height > 0 ? width / height : 1
  }

  /**
   * Adds a centre at a face anchor. `anchor` is the anchor matrix (column-major, objects camera space in cm, 1 unit =
   * the eye distance: `AnchorProvider.face`); `props` is `[radius, strength, directionX, directionY]` (`WarpProps`),
   * radius in face units and direction in the anchor frame, so both follow the head (distance, rotation). Returns
   * false when nothing was added (no room, behind the camera, no effect).
   */
  addFace(anchor: ArrayLike<number>, props: WarpProps): boolean {
    const radius = props[0]!
    const strength = props[1]!
    const dirX = props[2]!
    const dirY = props[3]!
    if (this.count >= this.capacity || !(radius > 0) || strength === 0 || strength !== strength) return false
    const m = anchor
    const s = this.#s
    const x = m[12]!
    const y = m[13]!
    const z = m[14]!
    if (!this.#project(x, y, z, 0)) return false
    // Size on screen of one face unit at that depth: the anchor scale (cm per unit) through the vertical focal length.
    const p = this.#p
    const w = p[3]! * x + p[7]! * y + p[11]! * z + p[15]!
    const r = (radius * Math.sqrt(m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!) * p[5]!) / (2 * w)
    if (!(r > 1e-6)) return false

    let dx = 0
    let dy = 0
    const len = Math.sqrt(dirX * dirX + dirY * dirY)
    if (len > 0) {
      // Direction in the anchor frame → camera space (cm), then the screen offset of a point a tenth of a unit along
      // it: the exact on-screen direction, perspective included.
      const e = 0.1 / len
      const qx = x + (m[0]! * dirX + m[4]! * dirY) * e
      const qy = y + (m[1]! * dirX + m[5]! * dirY) * e
      const qz = z + (m[2]! * dirX + m[6]! * dirY) * e
      if (this.#project(qx, qy, qz, 2)) {
        dx = s[2]! - s[0]!
        dy = s[3]! - s[1]!
        const l = Math.sqrt(dx * dx + dy * dy)
        if (l > 1e-9) {
          dx /= l
          dy /= l
        } else {
          dx = 0
          dy = 0
        }
      }
    }
    this.#push(s[0]!, s[1]!, r, strength, dx, dy)
    return true
  }

  /**
   * Adds a centre at the screen frame (`anchor: "screen"`, spec §5.2): the centre of the screen, `radius` in screen
   * heights, `direction` on screen.
   */
  addScreen(props: WarpProps): boolean {
    const radius = props[0]!
    const strength = props[1]!
    const dirX = props[2]!
    const dirY = props[3]!
    if (this.count >= this.capacity || !(radius > 0) || strength === 0 || strength !== strength) return false
    const len = Math.sqrt(dirX * dirX + dirY * dirY)
    this.#push(0, 0, radius, strength, len > 0 ? dirX / len : 0, len > 0 ? dirY / len : 0)
    return true
  }

  /**
   * Writes into `out[index]` the projected size (screen heights) of one face unit at `anchor`, 0 behind the camera:
   * ranks faces by size on screen.
   */
  unitSize(anchor: ArrayLike<number>, out: Float64Array, index: number): void {
    const m = anchor
    const p = this.#p
    const w = p[3]! * m[12]! + p[7]! * m[13]! + p[11]! * m[14]! + p[15]!
    out[index] = w > 1e-6 ? (Math.sqrt(m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!) * p[5]!) / (2 * w) : 0
  }

  /** Screen position of camera-space point (x, y, z) into the scratch at `i`; false behind the camera. */
  #project(x: number, y: number, z: number, i: number): boolean {
    const p = this.#p
    const w = p[3]! * x + p[7]! * y + p[11]! * z + p[15]!
    if (!(w > 1e-6)) return false
    const s = this.#s
    s[i] = ((p[0]! * x + p[4]! * y + p[8]! * z + p[12]!) / w) * 0.5 * this.#aspect
    s[i + 1] = ((p[1]! * x + p[5]! * y + p[9]! * z + p[13]!) / w) * 0.5
    return true
  }

  #push(x: number, y: number, radius: number, strength: number, dx: number, dy: number): void {
    const i = this.count++ * CENTRE_STRIDE
    const a = this.a
    const b = this.b
    a[i] = x
    a[i + 1] = y
    a[i + 2] = 1 / radius
    a[i + 3] = strength < -1 ? -1 : strength > 1 ? 1 : strength
    b[i] = dx
    b[i + 1] = dy
    b[i + 2] = 0
    b[i + 3] = 0
  }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
