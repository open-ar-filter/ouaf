/**
 * The geometry MediaPipe's face landmarker graph does around its three models (docs/decisions/face-runtime.md): SSD
 * anchors and decoding of the face detector (BlazeFace short range), weighted non-maximum suppression, the rotated
 * square region of interest (ROI) fed to the landmark model, and the ROI tracked from one frame's landmarks to the
 * next. Coordinates are in pixels of the analysed frame unless stated otherwise. Ported from the #83 spike.
 *
 * References (MediaPipe graphs and calculators, Apache-2.0): `face_detection_short_range.pbtxt` (anchors, decoding),
 * `face_detection_front_detection_to_roi`, `face_landmarks_to_roi`, `tensors_to_detections_calculator`,
 * `non_max_suppression_calculator` (weighted), `rect_transformation_calculator` (scale 1.5, square long side).
 */

/** Detector input size (square). */
export const DETECTOR_SIZE = 128
/** Landmark model input size (square). */
export const LANDMARKS_SIZE = 256
export const DETECTOR_ANCHORS = 896
const DETECTOR_COORDS = 16
const MIN_SCORE = 0.5
const NMS_OVERLAP = 0.3
/** Logits are clipped before the sigmoid (`score_clipping_thresh`). */
const SCORE_CLIP = 100
/** ROI = landmark (or detection) box enlarged 1.5×, square on its long side. */
const ROI_SCALE = 1.5

/** Detector anchors, `x, y` normalized centers (anchor size fixed to 1): 16×16×2 then 8×8×6. */
export const ANCHORS: Float32Array = (() => {
  const out = new Float32Array(DETECTOR_ANCHORS * 2)
  let i = 0
  // Strides 8, 16, 16, 16: the last three layers share an 8×8 feature map, 2 anchors each.
  for (const [cells, perCell] of [
    [16, 2],
    [8, 6],
  ] as const) {
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        for (let a = 0; a < perCell; a++) {
          out[i++] = (x + 0.5) / cells
          out[i++] = (y + 0.5) / cells
        }
      }
    }
  }
  if (i !== DETECTOR_ANCHORS * 2) throw new Error(`anchor count ${i / 2}`)
  return out
})()

export interface Detection {
  score: number
  /** Box in frame pixels. */
  xMin: number
  yMin: number
  width: number
  height: number
  /** 6 keypoints in frame pixels, `x, y` pairs: right eye, left eye, nose tip, mouth, right ear, left ear. */
  keypoints: Float32Array
}

/** Square rotated region: center and side in frame pixels, rotation in radians (y down, clockwise). */
export interface Roi {
  cx: number
  cy: number
  size: number
  rotation: number
}

/**
 * Where the frame lands in the letterboxed detector input: the frame is scaled to fit `DETECTOR_SIZE` keeping its
 * aspect ratio, centered, black borders.
 */
export interface Letterbox {
  scale: number
  offsetX: number
  offsetY: number
}

export function letterbox(width: number, height: number, size = DETECTOR_SIZE): Letterbox {
  const scale = size / Math.max(width, height)
  return { scale, offsetX: (size - width * scale) / 2, offsetY: (size - height * scale) / 2 }
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-Math.max(-SCORE_CLIP, Math.min(SCORE_CLIP, x))))

/** Decodes the detector outputs into frame-pixel detections, after weighted NMS. */
export function decodeDetections(regressors: Float32Array, scores: Float32Array, box: Letterbox): Detection[] {
  const candidates: Detection[] = []
  const toX = (v: number) => (v * DETECTOR_SIZE - box.offsetX) / box.scale
  const toY = (v: number) => (v * DETECTOR_SIZE - box.offsetY) / box.scale
  for (let i = 0; i < DETECTOR_ANCHORS; i++) {
    const score = sigmoid(scores[i] ?? -Infinity)
    if (score < MIN_SCORE) continue
    const r = i * DETECTOR_COORDS
    const ax = ANCHORS[i * 2]!
    const ay = ANCHORS[i * 2 + 1]!
    const cx = regressors[r]! / DETECTOR_SIZE + ax
    const cy = regressors[r + 1]! / DETECTOR_SIZE + ay
    const w = regressors[r + 2]! / DETECTOR_SIZE
    const h = regressors[r + 3]! / DETECTOR_SIZE
    const keypoints = new Float32Array(12)
    for (let k = 0; k < 6; k++) {
      keypoints[k * 2] = toX(regressors[r + 4 + k * 2]! / DETECTOR_SIZE + ax)
      keypoints[k * 2 + 1] = toY(regressors[r + 5 + k * 2]! / DETECTOR_SIZE + ay)
    }
    const xMin = toX(cx - w / 2)
    const yMin = toY(cy - h / 2)
    candidates.push({ score, xMin, yMin, width: toX(cx + w / 2) - xMin, height: toY(cy + h / 2) - yMin, keypoints })
  }
  return weightedNms(candidates)
}

function iou(a: Detection, b: Detection): number {
  const x0 = Math.max(a.xMin, b.xMin)
  const y0 = Math.max(a.yMin, b.yMin)
  const x1 = Math.min(a.xMin + a.width, b.xMin + b.width)
  const y1 = Math.min(a.yMin + a.height, b.yMin + b.height)
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  const union = a.width * a.height + b.width * b.height - inter
  return union > 0 ? inter / union : 0
}

/** Weighted NMS: overlapping candidates are averaged, weighted by score (box and keypoints). */
function weightedNms(candidates: Detection[]): Detection[] {
  candidates.sort((a, b) => b.score - a.score)
  const out: Detection[] = []
  let rest = candidates
  while (rest.length > 0) {
    const top = rest[0]!
    const cluster = rest.filter((d) => iou(top, d) > NMS_OVERLAP)
    rest = rest.filter((d) => iou(top, d) <= NMS_OVERLAP)
    let total = 0
    const merged: Detection = { score: top.score, xMin: 0, yMin: 0, width: 0, height: 0, keypoints: new Float32Array(12) }
    for (const d of cluster) {
      total += d.score
      merged.xMin += d.xMin * d.score
      merged.yMin += d.yMin * d.score
      merged.width += d.width * d.score
      merged.height += d.height * d.score
      for (let k = 0; k < 12; k++) merged.keypoints[k]! += d.keypoints[k]! * d.score
    }
    merged.xMin /= total
    merged.yMin /= total
    merged.width /= total
    merged.height /= total
    for (let k = 0; k < 12; k++) merged.keypoints[k]! /= total
    out.push(merged)
  }
  return out
}

/** ROI of a detection: rotation from the eyes (keypoints 0 → 1), box center, 1.5× its long side. */
export function detectionToRoi(d: Detection): Roi {
  const rotation = Math.atan2(d.keypoints[3]! - d.keypoints[1]!, d.keypoints[2]! - d.keypoints[0]!)
  return {
    cx: d.xMin + d.width / 2,
    cy: d.yMin + d.height / 2,
    size: Math.max(d.width, d.height) * ROI_SCALE,
    rotation,
  }
}

/**
 * ROI for the next frame from this frame's landmarks (`x, y, z` per landmark, frame pixels): rotation from the eye
 * corners (33 → 263), box of the landmarks in the rotated frame, 1.5× its long side.
 */
export function landmarksToRoi(landmarks: Float32Array, count: number): Roi {
  const rotation = Math.atan2(landmarks[263 * 3 + 1]! - landmarks[33 * 3 + 1]!, landmarks[263 * 3]! - landmarks[33 * 3]!)
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  let u0 = Infinity
  let u1 = -Infinity
  let v0 = Infinity
  let v1 = -Infinity
  for (let i = 0; i < count; i++) {
    const x = landmarks[i * 3]!
    const y = landmarks[i * 3 + 1]!
    // Into the face's own axes (rotation by -rotation).
    const u = x * cos + y * sin
    const v = -x * sin + y * cos
    if (u < u0) u0 = u
    if (u > u1) u1 = u
    if (v < v0) v0 = v
    if (v > v1) v1 = v
  }
  const cu = (u0 + u1) / 2
  const cv = (v0 + v1) / 2
  return { cx: cu * cos - cv * sin, cy: cu * sin + cv * cos, size: Math.max(u1 - u0, v1 - v0) * ROI_SCALE, rotation }
}

/**
 * Maps the landmark model output (`x, y, z` in `LANDMARKS_SIZE` pixels of the ROI crop) to frame pixels, in place
 * into `out`. `z` is scaled like `x` (MediaPipe's convention, before normalization by the frame width).
 */
export function projectLandmarks(raw: Float32Array, roi: Roi, count: number, out: Float32Array): void {
  const cos = Math.cos(roi.rotation)
  const sin = Math.sin(roi.rotation)
  const k = roi.size / LANDMARKS_SIZE
  for (let i = 0; i < count; i++) {
    const u = (raw[i * 3]! - LANDMARKS_SIZE / 2) * k
    const v = (raw[i * 3 + 1]! - LANDMARKS_SIZE / 2) * k
    out[i * 3] = roi.cx + u * cos - v * sin
    out[i * 3 + 1] = roi.cy + u * sin + v * cos
    out[i * 3 + 2] = raw[i * 3 + 2]! * k
  }
}

/**
 * The 146 landmarks the blendshapes model reads, in its input order (`kLandmarksSubsetIdxs` of MediaPipe's
 * `face_blendshapes_graph.cc`).
 */
export const BLENDSHAPE_LANDMARKS: readonly number[] = [
  0, 1, 4, 5, 6, 7, 8, 10, 13, 14, 17, 21, 33, 37, 39, 40, 46, 52, 53, 54, 55, 58, 61, 63, 65, 66, 67, 70, 78, 80, 81, 82, 84, 87,
  88, 91, 93, 95, 103, 105, 107, 109, 127, 132, 133, 136, 144, 145, 146, 148, 149, 150, 152, 153, 154, 155, 157, 158, 159, 160,
  161, 162, 163, 168, 172, 173, 176, 178, 181, 185, 191, 195, 197, 234, 246, 249, 251, 263, 267, 269, 270, 276, 282, 283, 284,
  285, 288, 291, 293, 295, 296, 297, 300, 308, 310, 311, 312, 314, 317, 318, 321, 323, 324, 332, 334, 336, 338, 356, 361, 362,
  365, 373, 374, 375, 377, 378, 379, 380, 381, 382, 384, 385, 386, 387, 388, 389, 390, 397, 398, 400, 402, 405, 409, 415, 454,
  466, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477,
]
if (BLENDSHAPE_LANDMARKS.length !== 146) throw new Error(`blendshape subset: ${BLENDSHAPE_LANDMARKS.length} landmarks, expected 146`)
