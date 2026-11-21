import { describe, expect, it } from 'vitest'
import {
  FaceIdentityTracker,
  FaceSmoother,
  LANDMARK_COUNT,
  LANDMARKS_STRIDE,
  computeAnchorMatrix,
  createFaceFrame,
  liveAnchorPosition,
  type FaceFrame,
} from '../src/index.ts'
import { heapGrowth, noise, shiftFace, writeSyntheticFace, type SyntheticPose } from './synthetic-face.ts'

function setup(maxFaces = 2, options = {}) {
  const identity = new FaceIdentityTracker({ maxFaces })
  const smoother = new FaceSmoother(identity, options)
  const raw = createFaceFrame(maxFaces)
  const smoothed = createFaceFrame(maxFaces)
  const predicted = createFaceFrame(maxFaces)
  const step = (time: number) => {
    raw.mediaTime = time
    identity.update(raw, time)
    smoother.update(raw, time, smoothed)
  }
  return { identity, smoother, raw, smoothed, predicted, step }
}

function addNoise(faces: FaceFrame, face: number, rnd: () => number, amount: number): void {
  const base = face * LANDMARKS_STRIDE
  for (let i = 0; i < LANDMARK_COUNT * 3; i++) faces.landmarks[base + i] = faces.landmarks[base + i]! + amount * rnd()
}

const std = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
}

describe('FaceSmoother', () => {
  it('steadies the landmarks and the pose of a face at rest', () => {
    const { raw, smoothed, step } = setup(1)
    const rnd = noise(4)
    const pose: SyntheticPose = { yaw: 10, t: [2, 1, -50] }
    const rawX: number[] = []
    const outX: number[] = []
    const outTz: number[] = []
    const rawTz: number[] = []
    const m = new Float32Array(16)
    for (let i = 0; i < 90; i++) {
      raw.count = 1
      writeSyntheticFace(raw, 0, pose)
      addNoise(raw, 0, rnd, 0.002)
      step(i / 15)
      if (i < 15) continue
      rawX.push(raw.landmarks[1 * 3]!)
      outX.push(smoothed.landmarks[1 * 3]!)
      outTz.push(smoothed.matrices[14]!)
      computeAnchorMatrix(raw, 0, 'head', 'rigid', false, m) // raw has no fitted pose: invalid
      rawTz.push(m[14]!)
    }
    expect(std(outX)).toBeLessThan(0.5 * std(rawX))
    // The smoothed frame carries a fitted pose, close to the true depth.
    expect(Math.abs(outTz.at(-1)! + 50)).toBeLessThan(1)
    expect(std(outTz)).toBeLessThan(0.3)
    expect(rawTz.every((z) => z === 0)).toBe(true)
  })

  it('keeps each face’s filter with its identity when the tracker swaps the slots', () => {
    const { raw, smoothed, step, identity } = setup(2)
    const left: SyntheticPose = { t: [-15, 0, -60] }
    const right: SyntheticPose = { t: [15, 0, -60] }
    const p = { x: 0, y: 0, z: 0 }
    const q = { x: 0, y: 0, z: 0 }
    for (let i = 0; i < 30; i++) {
      raw.count = 2
      const swapped = i % 2 === 1
      writeSyntheticFace(raw, 0, swapped ? right : left)
      writeSyntheticFace(raw, 1, swapped ? left : right)
      step(i / 15)
      for (let slot = 0; slot < 2; slot++) {
        // Output slot = input slot, smoothed with its own face's history: no blending between the two faces.
        liveAnchorPosition(raw, slot, 'noseTip', p)
        liveAnchorPosition(smoothed, slot, 'noseTip', q)
        expect(Math.abs(p.x - q.x), `step ${i} slot ${slot}`).toBeLessThan(1e-4)
      }
      expect(identity.ids[0]).toBe(swapped ? 2 : 1)
    }
  })

  it('restarts the filter for a new id', () => {
    const { raw, smoothed, step } = setup(1)
    raw.count = 1
    writeSyntheticFace(raw, 0, { t: [-15, 0, -60] })
    for (let i = 0; i < 10; i++) step(i / 15)
    // The face leaves; another one appears elsewhere after the grace delay.
    raw.count = 0
    step(1)
    raw.count = 1
    writeSyntheticFace(raw, 0, { t: [15, 0, -60] })
    step(2)
    expect(Array.from(smoothed.landmarks.subarray(0, LANDMARKS_STRIDE))).toEqual(Array.from(raw.landmarks.subarray(0, LANDMARKS_STRIDE)))
  })

  it('predicts a moving face to the displayed time, within the cap', () => {
    const { raw, smoothed, predicted, step, smoother } = setup(1)
    // Moves right at 0.3 frame widths per second, tracked at 15 Hz.
    const speed = 0.3
    let time = 0
    for (let i = 0; i < 30; i++) {
      time = i / 15
      raw.count = 1
      writeSyntheticFace(raw, 0, { t: [0, 0, -60] })
      shiftFace(raw, 0, speed * time, 0)
      step(time)
    }
    const truthAt = (t: number) => {
      const truth = createFaceFrame(1)
      truth.count = 1
      writeSyntheticFace(truth, 0, { t: [0, 0, -60] })
      shiftFace(truth, 0, speed * t, 0)
      return truth.landmarks[1 * 3]!
    }
    // Drawn 100 ms after the result.
    smoother.predict(smoothed, time + 0.1, predicted)
    const errSmoothed = Math.abs(smoothed.landmarks[3]! - truthAt(time + 0.1))
    const errPredicted = Math.abs(predicted.landmarks[3]! - truthAt(time + 0.1))
    expect(errPredicted).toBeLessThan(0.3 * errSmoothed)
    expect(predicted.matrices[14]).toBeLessThan(0)
    expect(predicted.count).toBe(1)
    // Capped: 1 s later predicts no further than 100 ms.
    const capped = createFaceFrame(1)
    smoother.predict(smoothed, time + 1, capped)
    expect(capped.landmarks[3]).toBeCloseTo(predicted.landmarks[3]!, 6)
    // Disabled, or a time before the result: a copy of the smoothed result.
    smoother.maxPredictionMs = 0
    smoother.predict(smoothed, time + 0.1, capped)
    expect(capped.landmarks[3]).toBeCloseTo(smoothed.landmarks[3]!, 6)
    smoother.maxPredictionMs = 100
    smoother.predict(smoothed, time - 1, capped)
    expect(capped.landmarks[3]).toBeCloseTo(smoothed.landmarks[3]!, 6)
  })

  it('does not allocate per result or per rendered frame', () => {
    const { raw, smoothed, predicted, step, smoother } = setup(2)
    raw.count = 2
    writeSyntheticFace(raw, 0, { yaw: 10, t: [-15, 0, -60] })
    writeSyntheticFace(raw, 1, { yaw: -10, t: [15, 0, -60] })
    let time = 0
    expect(
      heapGrowth(() => {
        time += 1 / 15
        step(time)
        smoother.predict(smoothed, time + 0.05, predicted)
      }, 300),
    ).toBeLessThan(32 * 1024)
  })
})
