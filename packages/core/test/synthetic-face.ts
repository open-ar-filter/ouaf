/**
 * Synthetic faces for the anchoring tests: the canonical face model subset placed with a known pose and projected
 * with the face camera, written as MediaPipe-style landmarks. No image of anyone is involved.
 */
import { CANONICAL_FACE, FACE_CAMERA_FOV_Y_DEG, LANDMARK_COUNT, LANDMARKS_STRIDE, type FaceFrame } from '../src/index.ts'

export interface SyntheticPose {
  /** Degrees: yaw around +y, pitch around +x, roll around +z (applied roll, then pitch, then yaw). */
  yaw?: number
  pitch?: number
  roll?: number
  /** Translation (cm, camera space: the face is at negative z). */
  t?: readonly [number, number, number]
}

const D = Math.PI / 180

/** Rotation matrix (column-major 3×3) of a pose: R = Ry · Rx · Rz. */
export function poseRotation(pose: SyntheticPose): number[] {
  const [cy, sy] = [Math.cos((pose.yaw ?? 0) * D), Math.sin((pose.yaw ?? 0) * D)]
  const [cx, sx] = [Math.cos((pose.pitch ?? 0) * D), Math.sin((pose.pitch ?? 0) * D)]
  const [cz, sz] = [Math.cos((pose.roll ?? 0) * D), Math.sin((pose.roll ?? 0) * D)]
  const Ry = [cy, 0, -sy, 0, 1, 0, sy, 0, cy]
  const Rx = [1, 0, 0, 0, cx, sx, 0, -sx, cx]
  const Rz = [cz, sz, 0, -sz, cz, 0, 0, 0, 1]
  return mul3(Ry, mul3(Rx, Rz))
}

function mul3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9).fill(0)
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) out[c * 3 + r]! += a[k * 3 + r]! * b[c * 3 + k]!
  return out
}

/** Camera-space position (cm) of canonical landmark `index` under `pose`. */
export function posePoint(pose: SyntheticPose, p: readonly [number, number, number]): [number, number, number] {
  const R = poseRotation(pose)
  const t = pose.t ?? [0, 0, -60]
  return [
    R[0]! * p[0] + R[3]! * p[1] + R[6]! * p[2] + t[0],
    R[1]! * p[0] + R[4]! * p[1] + R[7]! * p[2] + t[1],
    R[2]! * p[0] + R[5]! * p[1] + R[8]! * p[2] + t[2],
  ]
}

const SUBSET = Object.keys(CANONICAL_FACE).map(Number)

/**
 * Writes face `face` of `faces` as seen under `pose` (frame size from `faces.width/height`, 1280×720 if unset).
 * Landmarks outside the canonical subset repeat subset points, so the bounding box and the mean depth stay those of
 * the face.
 */
export function writeSyntheticFace(faces: FaceFrame, face: number, pose: SyntheticPose): void {
  if (!faces.width || !faces.height) {
    faces.width = 1280
    faces.height = 720
  }
  const aspect = faces.width / faces.height
  const tan = Math.tan((FACE_CAMERA_FOV_Y_DEG * D) / 2)
  const zc = (pose.t ?? [0, 0, -60])[2]
  const base = face * LANDMARKS_STRIDE
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const index = CANONICAL_FACE[i] ? i : SUBSET[i % SUBSET.length]!
    const [x, y, z] = posePoint(pose, CANONICAL_FACE[index]!)
    const d = -z * tan
    faces.landmarks[base + i * 3] = 0.5 + x / (2 * d * aspect)
    faces.landmarks[base + i * 3 + 1] = 0.5 - y / (2 * d)
    // MediaPipe's z: relative depth, smaller = closer, in the scale of x.
    faces.landmarks[base + i * 3 + 2] = -(z - zc) / (2 * -zc * tan * aspect)
  }
}

/** Moves every landmark of face `face` by (`du`, `dv`) in normalized image units. */
export function shiftFace(faces: FaceFrame, face: number, du: number, dv: number): void {
  const base = face * LANDMARKS_STRIDE
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    faces.landmarks[base + i * 3] = faces.landmarks[base + i * 3]! + du
    faces.landmarks[base + i * 3 + 1] = faces.landmarks[base + i * 3 + 1]! + dv
  }
}

/** Deterministic pseudo-random numbers in [-1, 1) (tests must not depend on Math.random). */
export function noise(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return (s / 2 ** 32) * 2 - 1
  }
}

/**
 * Steady-state heap growth (bytes) over `iterations` calls of `fn`. Unoptimized code boxes numbers on the heap,
 * so the measure is taken over several rounds and the best one kept (an allocating `fn` allocates in all of them);
 * within a round, the median of several windows, since a garbage collection inside a window makes it shrink.
 * One small object per call shows as ≥ 100 KB.
 */
export function heapGrowth(fn: () => void, iterations = 5000): number {
  let best = Infinity
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 5000; i++) fn()
    const growth: number[] = []
    for (let w = 0; w < 5; w++) {
      const before = process.memoryUsage().heapUsed
      for (let i = 0; i < iterations; i++) fn()
      growth.push(process.memoryUsage().heapUsed - before)
    }
    best = Math.min(best, growth.sort((a, b) => a - b)[2]!)
  }
  return best
}
