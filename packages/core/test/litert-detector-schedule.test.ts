import { describe, expect, it } from 'vitest'
import { DETECTOR_RETRIES, DetectorSchedule } from '../src/litert/detector-schedule.ts'

describe('DetectorSchedule (LiteRT.js, several faces)', () => {
  it('runs on every frame without a face, at most every interval with some, never with all', () => {
    const s = new DetectorSchedule(500)
    expect(s.due(0, 2, 0)).toBe(true)
    s.ran(0)
    expect(s.due(0, 2, 10)).toBe(true) // no face: every frame
    s.ran(10)
    expect(s.due(1, 2, 100)).toBe(false) // a face missing: wait
    expect(s.due(1, 2, 509)).toBe(false)
    expect(s.due(1, 2, 510)).toBe(true)
    expect(s.due(2, 2, 10_000)).toBe(false) // all found
    s.reset()
    expect(s.due(1, 2, 0)).toBe(true)
  })

  it('looks again on the next frames after a detection the landmark model did not confirm, three times at most', () => {
    const s = new DetectorSchedule(500)
    s.ran(0)
    let retries = 0
    let now = 0
    // Every face it finds is rejected.
    for (s.unconfirmed(); s.due(1, 2, now + 10); s.unconfirmed()) {
      now += 10
      s.ran(now)
      retries++
    }
    expect(retries).toBe(DETECTOR_RETRIES)
    // Then back to the interval, with a new series of retries after it.
    expect(s.due(1, 2, 200)).toBe(false)
    expect(s.due(1, 2, 540)).toBe(true)
    s.ran(540)
    s.unconfirmed()
    expect(s.due(1, 2, 550)).toBe(true)
  })

  it('a confirmed detection ends the retries', () => {
    const s = new DetectorSchedule(500)
    s.ran(0)
    s.unconfirmed()
    expect(s.due(1, 2, 10)).toBe(true)
    s.ran(10) // this one finds the face
    expect(s.due(1, 2, 20)).toBe(false)
    // Several faces rejected after one run count as one retry.
    s.ran(600)
    s.unconfirmed()
    s.unconfirmed()
    s.ran(610)
    s.ran(620)
    expect(s.due(1, 2, 630)).toBe(false)
  })
})
