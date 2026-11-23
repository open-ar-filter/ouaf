/**
 * Head pose from the landmarks: a port of MediaPipe's face geometry pipeline (`geometry_pipeline.cc`,
 * Apache-2.0), so that every tracker yields the same facial transformation matrix, including ours, which outputs
 * landmarks only (docs/decisions/face-runtime.md).
 *
 * Camera space (shared with the renderer): camera at the origin, +x right, +y up, looking down -z (faces have a
 * negative z), centimetres, perspective with a vertical field of view of `FACE_CAMERA_FOV_Y_DEG` over the whole
 * analysed frame. Not mirrored. This is MediaPipe's metric space, so its own matrices are in the same space.
 *
 * The matrix maps the canonical face model (`canonical-face.ts`) to camera space: `p_camera = M · p_canonical`,
 * 4×4 column-major, a similarity (rotation × uniform scale ≈ 1, then translation).
 */
import { LANDMARKS_STRIDE, MATRIX_STRIDE, type FaceFrame } from '../face.ts'
import { CANONICAL_FACE, PROCRUSTES_BASIS } from './canonical-face.ts'

/** Vertical field of view of the camera assumed by the face geometry (MediaPipe's convention), degrees. */
export const FACE_CAMERA_FOV_Y_DEG = 63
/** Near plane of that camera (cm). Only matters to the pose fit (MediaPipe uses 1). */
export const FACE_CAMERA_NEAR = 1

const TAN_HALF_FOV = Math.tan((FACE_CAMERA_FOV_Y_DEG * Math.PI) / 360)
/** Landmarks of the face mesh proper (the irises, 468–477, are not part of the canonical model). */
const MESH_LANDMARKS = 468

const N = PROCRUSTES_BASIS.length
const BASIS_INDEX = new Int32Array(N)
const BASIS_WEIGHT = new Float64Array(N)
const CANONICAL = new Float64Array(N * 3)
for (let i = 0; i < N; i++) {
  const [index, weight] = PROCRUSTES_BASIS[i]!
  const c = CANONICAL_FACE[index]!
  BASIS_INDEX[i] = index
  BASIS_WEIGHT[i] = weight
  CANONICAL[i * 3] = c[0]
  CANONICAL[i * 3 + 1] = c[1]
  CANONICAL[i * 3 + 2] = c[2]
}

// Scratch buffers (module-level: the fit is synchronous and never re-entered).
const projected = new Float64Array(N * 3)
const metric = new Float64Array(N * 3)
const fit = new Float64Array(13) // rotation (9, column-major), scale, translation (3)
const quat = new Float64Array(4)
const nMat = new Float64Array(16)
const vMat = new Float64Array(16)
/**
 * `unproject`'s depth offset and scale: passed through an array, since V8 boxes (allocates) a fractional number passed
 * to a call it does not inline.
 */
const unprojectBy = new Float64Array(2)

/**
 * Writes into `out` (16 floats from `outOffset`) the facial transformation matrix of face `face` of `faces`, and
 * returns true; returns false (and writes an identity matrix) when the face has no usable landmarks.
 * Allocation-free.
 */
export function estimateFacePose(
  faces: Readonly<FaceFrame>,
  face: number,
  out: Float32Array,
  outOffset = face * MATRIX_STRIDE,
): boolean {
  const aspect = faces.width > 0 && faces.height > 0 ? faces.width / faces.height : 1
  const top = FACE_CAMERA_NEAR * TAN_HALF_FOV
  const right = top * aspect
  const xScale = 2 * right
  const yScale = 2 * top
  const L = faces.landmarks
  const base = face * LANDMARKS_STRIDE

  // ProjectXY: normalized image coordinates (y down) → near plane (y up); z keeps the scale of x.
  let depthOffset = 0
  for (let i = 0; i < MESH_LANDMARKS; i++) depthOffset += L[base + i * 3 + 2]!
  depthOffset = (depthOffset * xScale) / MESH_LANDMARKS
  for (let i = 0; i < N; i++) {
    const o = base + BASIS_INDEX[i]! * 3
    projected[i * 3] = L[o]! * xScale - right
    projected[i * 3 + 1] = (1 - L[o + 1]!) * yScale - top
    projected[i * 3 + 2] = L[o + 2]! * xScale
  }

  // 1st iteration: the projected points with z flipped give the scale of the face on the near plane.
  for (let i = 0; i < N; i++) {
    metric[i * 3] = projected[i * 3]!
    metric[i * 3 + 1] = projected[i * 3 + 1]!
    metric[i * 3 + 2] = -projected[i * 3 + 2]!
  }
  if (!solveSimilarity(metric)) return identity(out, outOffset)
  const scale1 = fit[9]!
  // 2nd iteration: unproject with that scale, refine it.
  unprojectBy[0] = depthOffset
  unprojectBy[1] = scale1
  unproject()
  if (!solveSimilarity(metric)) return identity(out, outOffset)
  // Final: unproject with the total scale and fit the pose.
  unprojectBy[1] = scale1 * fit[9]!
  unproject()
  if (!solveSimilarity(metric)) return identity(out, outOffset)

  const s = fit[9]!
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) out[outOffset + c * 4 + r] = fit[c * 3 + r]! * s
    out[outOffset + c * 4 + 3] = 0
  }
  out[outOffset + 12] = fit[10]!
  out[outOffset + 13] = fit[11]!
  out[outOffset + 14] = fit[12]!
  out[outOffset + 15] = 1
  return true
}

/** Writes the facial transformation matrix of every face of `faces` into `faces.matrices`. */
export function estimateFacePoses(faces: FaceFrame): void {
  for (let f = 0; f < faces.count; f++) estimateFacePose(faces, f, faces.matrices)
}

/** MoveAndRescaleZ + UnprojectXY + ChangeHandedness, from `projected` into `metric`, by `unprojectBy`. */
function unproject(): void {
  const depthOffset = unprojectBy[0]!
  const scale = unprojectBy[1]!
  for (let i = 0; i < N; i++) {
    const z = (projected[i * 3 + 2]! - depthOffset + FACE_CAMERA_NEAR) / scale
    metric[i * 3] = (projected[i * 3]! * z) / FACE_CAMERA_NEAR
    metric[i * 3 + 1] = (projected[i * 3 + 1]! * z) / FACE_CAMERA_NEAR
    metric[i * 3 + 2] = -z
  }
}

function identity(out: Float32Array, o: number): false {
  for (let i = 0; i < 16; i++) out[o + i] = i % 5 === 0 ? 1 : 0
  return false
}

/**
 * Weighted similarity fit `target ≈ s·R·canonical + t` over the Procrustes basis (MediaPipe's
 * `SolveWeightedOrthogonalProblem`). The rotation is found with Horn's quaternion method (largest eigenvector of a
 * 4×4 symmetric matrix), which is the same optimum as the SVD solution and never yields a reflection.
 * Writes `fit`; returns false on degenerate input.
 */
function solveSimilarity(target: Float64Array): boolean {
  let total = 0
  let cx = 0, cy = 0, cz = 0, tx = 0, ty = 0, tz = 0
  for (let i = 0; i < N; i++) {
    const w = BASIS_WEIGHT[i]!
    total += w
    cx += w * CANONICAL[i * 3]!
    cy += w * CANONICAL[i * 3 + 1]!
    cz += w * CANONICAL[i * 3 + 2]!
    tx += w * target[i * 3]!
    ty += w * target[i * 3 + 1]!
    tz += w * target[i * 3 + 2]!
  }
  cx /= total; cy /= total; cz /= total
  tx /= total; ty /= total; tz /= total

  // S_ab = Σ w · c'_a · t'_b (centred canonical a, centred target b); den = Σ w |c'|².
  let sxx = 0, sxy = 0, sxz = 0, syx = 0, syy = 0, syz = 0, szx = 0, szy = 0, szz = 0, den = 0
  for (let i = 0; i < N; i++) {
    const w = BASIS_WEIGHT[i]!
    const ax = CANONICAL[i * 3]! - cx
    const ay = CANONICAL[i * 3 + 1]! - cy
    const az = CANONICAL[i * 3 + 2]! - cz
    const bx = target[i * 3]! - tx
    const by = target[i * 3 + 1]! - ty
    const bz = target[i * 3 + 2]! - tz
    sxx += w * ax * bx; sxy += w * ax * by; sxz += w * ax * bz
    syx += w * ay * bx; syy += w * ay * by; syz += w * ay * bz
    szx += w * az * bx; szy += w * az * by; szz += w * az * bz
    den += w * (ax * ax + ay * ay + az * az)
  }
  if (!(den > 0) || !Number.isFinite(sxx + syy + szz + sxy + syz + szx)) return false

  // Horn (1987): the optimal rotation is the unit quaternion (w, x, y, z) maximizing qᵀ·N·q.
  const n = nMat
  n[0] = sxx + syy + szz; n[1] = syz - szy; n[2] = szx - sxz; n[3] = sxy - syx
  n[5] = sxx - syy - szz; n[6] = sxy + syx; n[7] = szx + sxz
  n[10] = -sxx + syy - szz; n[11] = syz + szy
  n[15] = -sxx - syy + szz
  n[4] = n[1]; n[8] = n[2]; n[12] = n[3]; n[9] = n[6]; n[13] = n[7]; n[14] = n[11]
  largestEigenvector4(n, quat)
  const qw = quat[0]!, qx = quat[1]!, qy = quat[2]!, qz = quat[3]!
  // Rotation matrix, column-major.
  const r = fit
  r[0] = 1 - 2 * (qy * qy + qz * qz); r[1] = 2 * (qx * qy + qw * qz); r[2] = 2 * (qx * qz - qw * qy)
  r[3] = 2 * (qx * qy - qw * qz); r[4] = 1 - 2 * (qx * qx + qz * qz); r[5] = 2 * (qy * qz + qw * qx)
  r[6] = 2 * (qx * qz + qw * qy); r[7] = 2 * (qy * qz - qw * qx); r[8] = 1 - 2 * (qx * qx + qy * qy)

  // s = Σ w (R c')·t' / Σ w |c'|² = trace(R·S) / den, with S as above (S_ab, a source, b target).
  const num =
    r[0]! * sxx + r[3]! * syx + r[6]! * szx +
    r[1]! * sxy + r[4]! * syy + r[7]! * szy +
    r[2]! * sxz + r[5]! * syz + r[8]! * szz
  const s = num / den
  if (!(s > 0)) return false
  r[9] = s
  r[10] = tx - s * (r[0]! * cx + r[3]! * cy + r[6]! * cz)
  r[11] = ty - s * (r[1]! * cx + r[4]! * cy + r[7]! * cz)
  r[12] = tz - s * (r[2]! * cx + r[5]! * cy + r[8]! * cz)
  return true
}

/**
 * Eigenvector of the largest eigenvalue of the symmetric 4×4 matrix `a` (row-major, destroyed), by cyclic Jacobi
 * rotations. Writes a unit vector into `out`.
 */
function largestEigenvector4(a: Float64Array, out: Float64Array): void {
  const v = vMat
  for (let i = 0; i < 16; i++) v[i] = i % 5 === 0 ? 1 : 0
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 4; q++) off += a[p * 4 + q]! * a[p * 4 + q]!
    if (off < 1e-30) break
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 4; q++) {
        const apq = a[p * 4 + q]!
        if (Math.abs(apq) < 1e-300) continue
        const theta = (a[q * 4 + q]! - a[p * 4 + p]!) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        // A ← Jᵀ·A·J on rows/columns p and q.
        for (let k = 0; k < 4; k++) {
          const akp = a[k * 4 + p]!
          const akq = a[k * 4 + q]!
          a[k * 4 + p] = c * akp - s * akq
          a[k * 4 + q] = s * akp + c * akq
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p * 4 + k]!
          const aqk = a[q * 4 + k]!
          a[p * 4 + k] = c * apk - s * aqk
          a[q * 4 + k] = s * apk + c * aqk
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k * 4 + p]!
          const vkq = v[k * 4 + q]!
          v[k * 4 + p] = c * vkp - s * vkq
          v[k * 4 + q] = s * vkp + c * vkq
        }
      }
    }
  }
  let best = 0
  for (let i = 1; i < 4; i++) if (a[i * 5]! > a[best * 5]!) best = i
  let norm = 0
  for (let k = 0; k < 4; k++) norm += v[k * 4 + best]! * v[k * 4 + best]!
  norm = Math.sqrt(norm)
  for (let k = 0; k < 4; k++) out[k] = v[k * 4 + best]! / norm
}

/** Projects a camera-space point (cm) to video space (`x`, `y` normalized, y down, unmirrored; `z` = camera z). */
export function cameraToVideo(
  faces: Readonly<Pick<FaceFrame, 'width' | 'height'>>,
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number; z: number },
) {
  const aspect = faces.width > 0 && faces.height > 0 ? faces.width / faces.height : 1
  const d = -z * TAN_HALF_FOV
  out.x = 0.5 + x / (2 * d * aspect)
  out.y = 0.5 - y / (2 * d)
  out.z = z
  return out
}

/** Camera-space point on the ray through video-space (`u`, `v`) at camera depth `z` (< 0). */
export function videoToCamera(
  faces: Readonly<Pick<FaceFrame, 'width' | 'height'>>,
  u: number,
  v: number,
  z: number,
  out: { x: number; y: number; z: number },
) {
  out.x = u
  out.y = v
  out.z = z
  videoToCameraInPlace(faces, out)
  return out
}

/**
 * `videoToCamera` in place: `p.x`, `p.y` hold the video-space point and `p.z` the camera depth (< 0), replaced by the
 * camera-space point. For the per-frame loops: it takes no fractional argument, which V8 would box (allocate) at a
 * call it does not inline.
 */
export function videoToCameraInPlace(faces: Readonly<Pick<FaceFrame, 'width' | 'height'>>, p: { x: number; y: number; z: number }): void {
  const aspect = faces.width > 0 && faces.height > 0 ? faces.width / faces.height : 1
  const d = -p.z * TAN_HALF_FOV
  p.x = (2 * p.x - 1) * d * aspect
  p.y = (1 - 2 * p.y) * d
}
