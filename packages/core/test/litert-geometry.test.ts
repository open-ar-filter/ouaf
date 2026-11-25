import { describe, expect, it } from 'vitest'
import {
  ANCHORS,
  BLENDSHAPE_LANDMARKS,
  DETECTOR_ANCHORS,
  DETECTOR_SIZE,
  LANDMARKS_SIZE,
  decodeDetections,
  dedupeRois,
  detectionToRoi,
  landmarksToRoi,
  letterbox,
  projectLandmarks,
  roiOverlap,
} from '../src/litert/geometry.ts'
import { fixDynamicBatch } from '../src/litert/pipeline.ts'

/** Detector outputs with one anchor scoring `logit`, its box and keypoints given in detector pixels around the anchor. */
function detectorOutputs(hits: Array<{ anchor: number; logit: number; dx: number; dy: number; w: number; h: number; eyes?: [number, number, number, number] }>) {
  const regressors = new Float32Array(DETECTOR_ANCHORS * 16)
  const scores = new Float32Array(DETECTOR_ANCHORS).fill(-20)
  for (const hit of hits) {
    const r = hit.anchor * 16
    scores[hit.anchor] = hit.logit
    regressors.set([hit.dx, hit.dy, hit.w, hit.h], r)
    // Keypoints relative to the anchor: right eye, left eye, then the others at the box centre.
    const [rx, ry, lx, ly] = hit.eyes ?? [hit.dx - 10, hit.dy - 5, hit.dx + 10, hit.dy - 5]
    regressors.set([rx, ry, lx, ly], r + 4)
    for (let k = 2; k < 6; k++) regressors.set([hit.dx, hit.dy], r + 4 + k * 2)
  }
  return { regressors, scores }
}

describe('LiteRT.js face geometry (MediaPipe graph calculators)', () => {
  it('has the 896 SSD anchors of BlazeFace short range: 16×16×2 then 8×8×6, normalized centres', () => {
    expect(ANCHORS.length).toBe(DETECTOR_ANCHORS * 2)
    expect([ANCHORS[0], ANCHORS[1], ANCHORS[2], ANCHORS[3]]).toEqual([0.5 / 16, 0.5 / 16, 0.5 / 16, 0.5 / 16])
    // First anchor of the 8×8 layers.
    expect([ANCHORS[512 * 2], ANCHORS[512 * 2 + 1]]).toEqual([0.5 / 8, 0.5 / 8])
    expect([ANCHORS[895 * 2], ANCHORS[895 * 2 + 1]]).toEqual([7.5 / 8, 7.5 / 8])
  })

  it('letterboxes the frame into the square detector input, centred', () => {
    expect(letterbox(720, 1280)).toEqual({ scale: DETECTOR_SIZE / 1280, offsetX: (DETECTOR_SIZE - 72) / 2, offsetY: 0 })
    expect(letterbox(640, 480)).toEqual({ scale: DETECTOR_SIZE / 640, offsetX: 0, offsetY: 16 })
  })

  it('decodes a detection back to frame pixels, through the letterbox', () => {
    // Anchor 512 + 3 * 6: cell (3, 0) of the 8×8 layers, centre (3.5 / 8, 0.5 / 8) of the input.
    const anchor = 512 + 3 * 6
    const { regressors, scores } = detectorOutputs([{ anchor, logit: 4, dx: 8, dy: 24, w: 32, h: 40 }])
    const box = letterbox(720, 1280)
    const [d, ...rest] = decodeDetections(regressors, scores, box)
    expect(rest).toEqual([])
    expect(d!.score).toBeCloseTo(1 / (1 + Math.exp(-4)), 6)
    const cx = (3.5 / 8) * DETECTOR_SIZE + 8
    const cy = (0.5 / 8) * DETECTOR_SIZE + 24
    const toFrame = (v: number, offset: number) => (v - offset) / box.scale
    expect(d!.xMin + d!.width / 2).toBeCloseTo(toFrame(cx, box.offsetX), 3)
    expect(d!.yMin + d!.height / 2).toBeCloseTo(toFrame(cy, box.offsetY), 3)
    expect(d!.width).toBeCloseTo(32 / box.scale, 3)
    expect(d!.height).toBeCloseTo(40 / box.scale, 3)
    // Eyes level: no rotation; the ROI is 1.5× the long side.
    const roi = detectionToRoi(d!)
    expect(roi.rotation).toBeCloseTo(0, 6)
    expect(roi.size).toBeCloseTo(1.5 * (40 / box.scale), 3)
  })

  it('drops low scores and merges overlapping detections, weighted by score (weighted NMS)', () => {
    const { regressors, scores } = detectorOutputs([
      { anchor: 600, logit: 3, dx: 0, dy: 0, w: 40, h: 40 },
      { anchor: 601, logit: 1, dx: 4, dy: 0, w: 40, h: 40 }, // same cell, overlaps
      { anchor: 650, logit: 2, dx: 0, dy: 0, w: 20, h: 20 }, // elsewhere
      { anchor: 700, logit: -1, dx: 0, dy: 0, w: 40, h: 40 }, // score 0.27: dropped
    ])
    const box = { scale: 1, offsetX: 0, offsetY: 0 }
    const out = decodeDetections(regressors, scores, box)
    expect(out).toHaveLength(2)
    const s3 = 1 / (1 + Math.exp(-3))
    const s1 = 1 / (1 + Math.exp(-1))
    expect(out[0]!.score).toBeCloseTo(s3, 6)
    // Centre x averaged: anchors 600 and 601 share a centre, offsets 0 and 4.
    const cx = ANCHORS[600 * 2]! * DETECTOR_SIZE
    expect(out[0]!.xMin + out[0]!.width / 2).toBeCloseTo(cx + (4 * s1) / (s1 + s3), 3)
  })

  it('drops a candidate whose score is NaN', () => {
    const { regressors, scores } = detectorOutputs([
      { anchor: 600, logit: 3, dx: 0, dy: 0, w: 40, h: 40 },
      { anchor: 650, logit: 2, dx: 0, dy: 0, w: 20, h: 20 },
    ])
    scores[650] = Number.NaN
    const out = decodeDetections(regressors, scores, { scale: 1, offsetX: 0, offsetY: 0 })
    expect(out).toHaveLength(1)
    expect(out[0]!.score).toBeCloseTo(1 / (1 + Math.exp(-3)), 6)
  })

  it('takes the ROI rotation from the eyes (y down, clockwise)', () => {
    const { regressors, scores } = detectorOutputs([{ anchor: 600, logit: 4, dx: 0, dy: 0, w: 40, h: 40, eyes: [-10, -10, 10, 10] }])
    const [d] = decodeDetections(regressors, scores, { scale: 1, offsetX: 0, offsetY: 0 })
    expect(detectionToRoi(d!).rotation).toBeCloseTo(Math.PI / 4, 6)
  })

  it('projects the landmark model output back to the frame, and tracks the ROI from the landmarks', () => {
    const roi = { cx: 300, cy: 400, size: 200, rotation: 0.3 }
    // A square face mesh in crop pixels: its box is the middle half of the crop, eyes level in the crop.
    const count = 478
    const raw = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      raw[i * 3] = 64 + ((i * 37) % 129)
      raw[i * 3 + 1] = 64 + ((i * 61) % 129)
      raw[i * 3 + 2] = i % 7
    }
    raw.set([64, 100, 0], 33 * 3)
    raw.set([192, 100, 0], 263 * 3)
    raw.set([64, 64, 0], 0)
    raw.set([192, 192, 0], 3)
    const out = new Float32Array(count * 3)
    projectLandmarks(raw, roi, count, out)
    // The crop centre lands on the ROI centre; z is scaled like x.
    const k = roi.size / LANDMARKS_SIZE
    const p = new Float32Array(3 * 3)
    projectLandmarks(Float32Array.of(128, 128, 0, 128 + 10, 128, 7, 128, 128 + 10, 0), roi, 3, p)
    expect([p[0], p[1]]).toEqual([expect.closeTo(300, 4), expect.closeTo(400, 4)])
    expect([p[3]! - 300, p[4]! - 400]).toEqual([expect.closeTo(10 * k * Math.cos(0.3), 4), expect.closeTo(10 * k * Math.sin(0.3), 4)])
    expect([p[6]! - 300, p[7]! - 400]).toEqual([expect.closeTo(-10 * k * Math.sin(0.3), 4), expect.closeTo(10 * k * Math.cos(0.3), 4)])
    expect(p[5]).toBeCloseTo(7 * k, 5)
    // Next ROI: same rotation, centred on the mesh's box, 1.5× its side (half the crop: 100 px).
    const next = landmarksToRoi(out, count)
    expect(next.rotation).toBeCloseTo(0.3, 5)
    expect(next.cx).toBeCloseTo(300, 3)
    expect(next.cy).toBeCloseTo(400, 3)
    expect(next.size).toBeCloseTo(1.5 * 128 * k, 3)
  })

  it('feeds the blendshapes model the 146 landmarks of MediaPipe, irises included', () => {
    expect(BLENDSHAPE_LANDMARKS).toHaveLength(146)
    expect(new Set(BLENDSHAPE_LANDMARKS).size).toBe(146)
    expect(BLENDSHAPE_LANDMARKS.slice(-10)).toEqual([468, 469, 470, 471, 472, 473, 474, 475, 476, 477])
  })
})

describe('ROI association (several faces)', () => {
  const roi = (cx: number, cy: number, size: number, rotation = 0) => ({ cx, cy, size, rotation })

  it('measures the overlap of two ROIs as the IoU of their squares, rotation aside', () => {
    expect(roiOverlap(roi(100, 100, 50), roi(100, 100, 50, 0.4))).toBe(1)
    // Shifted by half a side: 25×50 in common, 2 × 2500 − 1250 in all.
    expect(roiOverlap(roi(100, 100, 50), roi(125, 100, 50))).toBeCloseTo(1250 / 3750, 9)
    expect(roiOverlap(roi(100, 100, 50), roi(200, 100, 50))).toBe(0)
    // Nested: the small one's area over the large one's.
    expect(roiOverlap(roi(100, 100, 100), roi(100, 100, 50))).toBeCloseTo(0.25, 9)
  })

  it('drops the ROIs that overlap an earlier one by more than half, keeping the order', () => {
    const items = [
      { id: 'a', roi: roi(100, 100, 50) },
      { id: 'b', roi: roi(300, 100, 50) },
      { id: 'a2', roi: roi(105, 102, 52) },
      { id: 'c', roi: roi(125, 100, 50) }, // overlaps `a` by a third only: another face
      { id: 'b2', roi: roi(300, 100, 48) },
    ]
    expect(dedupeRois(items, (i) => i.roi).map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(items).toHaveLength(3)
  })
})

describe('fixDynamicBatch', () => {
  it('rewrites the dynamic batch of the input signature to 1, once, and leaves other models alone', () => {
    const header = Uint8Array.of(1, 2, 3, 4)
    const signature = new Uint8Array(Int32Array.of(4, -1, 256, 256, 3).buffer)
    const model = new Uint8Array([...header, ...signature, ...signature])
    const fixed = fixDynamicBatch(model, [256, 256, 3])
    expect(fixed).not.toBe(model)
    expect([...new Int32Array(fixed.slice(4).buffer)]).toEqual([4, 1, 256, 256, 3, 4, -1, 256, 256, 3])
    // The original bytes are untouched.
    expect([...new Int32Array(model.slice(4, 24).buffer)]).toEqual([4, -1, 256, 256, 3])
    const other = new Uint8Array(new Int32Array([4, 1, 128, 128, 3]).buffer)
    expect(fixDynamicBatch(other, [256, 256, 3])).toBe(other)
  })
})
