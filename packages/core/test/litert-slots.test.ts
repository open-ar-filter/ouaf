import { describe, expect, it } from 'vitest'
import type { Roi } from '../src/litert/geometry.ts'
import { DetectorSchedule, FaceSlots, roiOverlap } from '../src/litert/slots.ts'

const roi = (cx: number, cy: number, size = 100): Roi => ({ cx, cy, size, rotation: 0 })

describe('roiOverlap', () => {
  it('is the intersection over union of the ROI squares', () => {
    expect(roiOverlap(roi(0, 0), roi(0, 0))).toBe(1)
    expect(roiOverlap(roi(0, 0), roi(200, 0))).toBe(0)
    // Half of each square overlaps: 5000 / 15000.
    expect(roiOverlap(roi(0, 0), roi(50, 0))).toBeCloseTo(1 / 3, 6)
  })
})

describe('FaceSlots (multi-face)', () => {
  it('fills free slots with new detections, best first, up to the faces wanted', () => {
    const slots = new FaceSlots(3)
    const added = slots.addDetections([roi(100, 100), roi(400, 100), roi(700, 100)], 2)
    expect(added.map((s) => s.index)).toEqual([0, 1])
    expect(slots.count).toBe(2)
  })

  it('does not take a detection of a face it already tracks for a new face', () => {
    const slots = new FaceSlots(2)
    slots.addDetections([roi(100, 100)], 2)
    // The same face, detected a little off, and a new one.
    const added = slots.addDetections([roi(110, 95), roi(500, 100)], 2)
    expect(added.map((s) => s.roi)).toEqual([roi(500, 100)])
    expect(slots.active.map((s) => s.roi!.cx)).toEqual([100, 500])
  })

  it('keeps each face in its slot as faces move and cross: no swap', () => {
    const slots = new FaceSlots(2)
    const [a, b] = slots.addDetections([roi(100, 100), roi(500, 100)], 2)
    // Twenty results: A moves right and B left, they cross at x = 300 (A passes in front, higher in the frame).
    for (let k = 1; k <= 20; k++) {
      slots.track(a!, roi(100 + 20 * k, 100 - 2 * k, 100), 0.9)
      slots.track(b!, roi(500 - 20 * k, 100 + 2 * k, 100), 0.9)
      expect(slots.dedup()).toEqual([])
    }
    expect(a!.roi!.cx).toBe(500)
    expect(b!.roi!.cx).toBe(100)
    expect(slots.active.map((s) => s.index)).toEqual([0, 1])
  })

  it('frees the slot of a face lost; the other keeps its slot', () => {
    const slots = new FaceSlots(2)
    const [a, b] = slots.addDetections([roi(100, 100), roi(500, 100)], 2)
    slots.track(a!, undefined, 0.1)
    expect(slots.active).toEqual([b])
    // A new face takes the free slot.
    expect(slots.addDetections([roi(500, 100), roi(900, 100)], 2).map((s) => s.index)).toEqual([0])
  })

  it('merges two ROIs that converged on one face, keeping the more confident', () => {
    const slots = new FaceSlots(3)
    const [a, b, c] = slots.addDetections([roi(100, 100), roi(400, 100), roi(800, 100)], 3)
    slots.track(a!, roi(300, 100), 0.7)
    slots.track(b!, roi(310, 105), 0.95)
    slots.track(c!, roi(800, 100), 0.9)
    expect(slots.dedup()).toEqual([a])
    expect(slots.active).toEqual([b, c])
  })

  it('drops the extra faces beyond the limit (governor), the first slots first kept', () => {
    const slots = new FaceSlots(4)
    slots.addDetections([roi(100, 100), roi(400, 100), roi(700, 100), roi(1000, 100)], 4)
    slots.track(slots.slots[1]!, undefined, 0)
    slots.limit(2)
    expect(slots.active.map((s) => s.index)).toEqual([0, 2])
  })

  it('extrapolates the next ROI from consecutive results only', () => {
    const slots = new FaceSlots(1)
    const [a] = slots.addDetections([roi(100, 100)], 1)
    expect(slots.predict(a!)).toEqual(roi(100, 100))
    slots.track(a!, roi(110, 100), 0.9)
    expect(slots.predict(a!)).toEqual(roi(120, 100))
    slots.track(a!, roi(400, 100), 0.9, false) // not consecutive (a detection): no velocity
    expect(slots.predict(a!)).toEqual(roi(400, 100))
  })
})

describe('DetectorSchedule', () => {
  it('runs on every frame without a face, at most every interval with some, never with all', () => {
    const s = new DetectorSchedule(500)
    expect(s.due(0, 2, 0)).toBe(true)
    s.ran(0)
    expect(s.due(0, 2, 10)).toBe(true) // no face: every frame
    s.ran(10)
    expect(s.due(1, 2, 100)).toBe(false) // a slot empty: wait
    expect(s.due(1, 2, 510)).toBe(true)
    expect(s.due(2, 2, 10_000)).toBe(false) // all found
    s.reset()
    expect(s.due(1, 2, 0)).toBe(true)
  })

  it('looks again on the next frames after a detection the landmark model did not confirm, three times at most', () => {
    const s = new DetectorSchedule(500)
    s.ran(0, true)
    expect(s.due(1, 2, 10)).toBe(true)
    s.ran(10, true)
    s.ran(20, true)
    expect(s.due(1, 2, 30)).toBe(true)
    s.ran(30, true) // a fourth unconfirmed detection in a row: back to the interval
    expect(s.due(1, 2, 40)).toBe(false)
    expect(s.due(1, 2, 530)).toBe(true)
    s.ran(530, false)
    expect(s.due(1, 2, 540)).toBe(false)
  })
})
