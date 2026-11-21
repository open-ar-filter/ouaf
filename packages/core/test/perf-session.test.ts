import { describe, expect, it } from 'vitest'
import {
  PERF_SESSION_FORMAT,
  PERF_SESSION_VERSION,
  SessionRecorder,
  createFrameSample,
  stringifySession,
  type PipelineInfo,
  type SessionRecorderOptions,
} from '../src/index.ts'

const INFO: PipelineInfo = { delegate: undefined, videoWidth: 1280, videoHeight: 720, renderWidth: 640, renderHeight: 360, maxFaces: 2 }

/** Recorder on a fake clock; `frame()` advances the clock and records a sample at that time. */
function setup(options: SessionRecorderOptions = {}) {
  let now = 1000
  const rec = new SessionRecorder({ clock: () => now, wallClock: () => Date.UTC(2026, 10, 21, 12, 0, 0), ...options })
  const sample = createFrameSample()
  return {
    rec,
    advance(ms: number) {
      now += ms
    },
    get now() {
      return now
    },
    frame(stepMs: number, values: { trackingMs?: number; renderMs?: number; faces?: number } = {}) {
      now += stepMs
      sample.now = now
      sample.mediaTime = now / 1000
      sample.trackingMs = values.trackingMs ?? 10
      sample.renderMs = values.renderMs ?? 2
      sample.faces = values.faces ?? 1
      rec.record(sample)
    },
  }
}

describe('SessionRecorder', () => {
  it('ignores samples unless recording', () => {
    const s = setup()
    s.frame(16)
    expect(s.rec.state).toBe('idle')
    expect(s.rec.count).toBe(0)
    s.rec.start()
    s.frame(16)
    s.rec.stop()
    s.frame(16)
    expect(s.rec.count).toBe(1)
    expect(s.rec.state).toBe('stopped')
    expect(s.rec.stopReason).toBe('manual')
  })

  it('exports a versioned document with raw columns relative to the start', () => {
    const s = setup()
    s.rec.setInfo(INFO)
    s.rec.start()
    s.frame(10, { trackingMs: 12.3456, renderMs: 1.004, faces: 2 })
    s.frame(20)
    s.advance(5)
    s.rec.stop()
    const doc = s.rec.export({ device: { userAgent: 'test' }, app: { name: 'test' } })
    expect(doc.format).toBe(PERF_SESSION_FORMAT)
    expect(doc.version).toBe(PERF_SESSION_VERSION)
    expect(doc.startedAt).toBe('2026-11-21T12:00:00.000Z')
    expect(doc.durationMs).toBe(35)
    expect(doc.stopReason).toBe('manual')
    expect(doc.app).toEqual({ name: 'test' })
    expect(doc.device).toEqual({ userAgent: 'test' })
    expect(doc.pipeline).toEqual({ ...INFO, delegate: null })
    expect(doc.samples).toEqual({
      t: [10, 30],
      mediaTime: [1.01, 1.03],
      trackingMs: [12.35, 10],
      renderMs: [1, 2],
      faces: [2, 1],
    })
    expect(doc.summary.samples).toBe(2)
    expect(doc.summary.fps).toBe(50)
    expect(doc.summary.frameMs.p50).toBe(20)
    expect(doc.summary.faces).toBe(1.5)
  })

  it('stops by itself when the buffers are full and keeps the data', () => {
    const s = setup({ capacity: 3 })
    s.rec.start()
    for (let i = 0; i < 5; i++) s.frame(10)
    expect(s.rec.count).toBe(3)
    expect(s.rec.full).toBe(true)
    expect(s.rec.state).toBe('stopped')
    expect(s.rec.stopReason).toBe('full')
    const doc = s.rec.export()
    expect(doc.events).toEqual([{ t: 40, type: 'full' }])
    expect(doc.samples.t).toEqual([10, 20, 30])
    expect(doc.durationMs).toBe(40)
  })

  it('enforces the duration limit from samples and from update()', () => {
    const s = setup()
    s.rec.start({ maxDurationMs: 100 })
    for (let i = 0; i < 20; i++) s.frame(10)
    expect(s.rec.state).toBe('stopped')
    expect(s.rec.stopReason).toBe('duration')
    expect(s.rec.count).toBe(9)
    expect(s.rec.export().durationMs).toBe(100)

    s.rec.start({ maxDurationMs: 100 })
    s.frame(10)
    s.advance(500) // camera stopped: no more samples
    expect(s.rec.elapsedMs).toBe(100)
    expect(s.rec.update()).toBe('stopped')
    expect(s.rec.stopReason).toBe('duration')
    expect(s.rec.export().durationMs).toBe(100)
  })

  it('excludes hidden periods and pipeline changes from frame times', () => {
    const s = setup()
    s.rec.setInfo(INFO)
    s.rec.start()
    for (let i = 0; i < 5; i++) s.frame(20)
    s.rec.event({ type: 'visibility', state: 'hidden' })
    s.advance(3000)
    s.rec.event({ type: 'visibility', state: 'visible' })
    for (let i = 0; i < 5; i++) s.frame(20)
    s.rec.setInfo({ ...INFO, delegate: 'GPU' })
    s.rec.setInfo({ ...INFO, delegate: 'GPU' }) // unchanged: not logged twice
    s.advance(1000)
    for (let i = 0; i < 5; i++) s.frame(20)
    s.rec.stop()
    const doc = s.rec.export()
    expect(doc.summary.samples).toBe(15)
    expect(doc.summary.frameMs.max).toBe(20)
    expect(doc.summary.fps).toBe(50)
    expect(doc.summary.hiddenMs).toBe(3000)
    expect(doc.events.map((e) => e.type)).toEqual(['visibility', 'visibility', 'pipeline'])
    expect(doc.events[2]).toMatchObject({ type: 'pipeline', pipeline: { delegate: 'GPU' } })
    expect(doc.pipeline?.delegate).toBeNull()
  })

  it('counts a page still hidden at the end', () => {
    const s = setup()
    s.rec.start()
    s.advance(100)
    s.rec.event({ type: 'visibility', state: 'hidden' })
    s.advance(400)
    s.rec.stop()
    expect(s.rec.export().summary.hiddenMs).toBe(400)
  })

  it('uses the first info set during a recording as the start pipeline', () => {
    const s = setup()
    s.rec.start()
    s.rec.setInfo(INFO)
    const doc = s.rec.export()
    expect(doc.pipeline).toEqual({ ...INFO, delegate: null })
    expect(doc.events).toEqual([])
  })

  it('computes per-interval statistics', () => {
    const s = setup({ intervalMs: 1000 })
    s.rec.start()
    // 1st second at 50 fps / 10 ms tracking, then 25 fps / 30 ms tracking (throttling).
    for (let i = 0; i < 49; i++) s.frame(20, { trackingMs: 10 })
    s.frame(20, { trackingMs: 10 }) // t = 1000 → second interval
    for (let i = 0; i < 25; i++) s.frame(40, { trackingMs: 30 })
    s.advance(500)
    s.rec.stop()
    const doc = s.rec.export()
    expect(doc.intervalMs).toBe(1000)
    expect(doc.intervals.map((i) => [i.startMs, i.durationMs, i.samples])).toEqual([
      [0, 1000, 49],
      [1000, 1000, 25],
      [2000, 500, 1],
    ])
    expect(doc.intervals[0]?.fps).toBe(50)
    expect(doc.intervals[0]?.trackingMs.p95).toBe(10)
    expect(doc.intervals[1]?.trackingMs.p50).toBe(30)
    expect(doc.intervals[1]?.fps).toBe(25.51) // 24 × 40 ms + the 20 ms frame at t = 1000
    expect(doc.intervals[2]?.fps).toBe(25)
  })

  it('reports null statistics without data', () => {
    const s = setup()
    s.rec.start()
    s.advance(10)
    s.rec.stop()
    const doc = s.rec.export()
    expect(doc.summary.fps).toBeNull()
    expect(doc.summary.frameMs).toEqual({ mean: null, p50: null, p95: null, p99: null, max: null })
    expect(doc.intervals).toHaveLength(1)
  })

  it('caps the event log', () => {
    const s = setup({ maxEvents: 2 })
    s.rec.start()
    for (let i = 0; i < 5; i++) s.rec.event({ type: 'note', message: String(i) })
    s.rec.stop()
    const doc = s.rec.export()
    expect(doc.events).toHaveLength(2)
    expect(doc.summary.droppedEvents).toBe(3)
  })

  it('start() discards the previous recording', () => {
    const s = setup()
    s.rec.start()
    s.frame(10)
    s.rec.event({ type: 'note', message: 'x' })
    s.rec.stop()
    s.rec.start()
    expect(s.rec.count).toBe(0)
    expect(s.rec.export().events).toEqual([])
  })

  it('holds 10 minutes at 60 fps by default', () => {
    expect(new SessionRecorder().capacity).toBeGreaterThanOrEqual(10 * 60 * 60)
  })

  it('has no extra columns or statistics by default', () => {
    const s = setup()
    s.rec.start()
    s.frame(10)
    s.rec.stop()
    const doc = s.rec.export()
    expect(Object.keys(doc.samples)).toEqual(['t', 'mediaTime', 'trackingMs', 'renderMs', 'faces'])
    expect(doc.summary.extra).toBeUndefined()
    expect(doc.intervals[0]?.extra).toBeUndefined()
  })

  it('records extra columns, with NaN for missing values excluded from their statistics', () => {
    const s = setup({ extraColumns: ['segmentationMs', 'readPixels'], intervalMs: 25 })
    const sample = createFrameSample()
    const extra = new Float64Array(2)
    sample.extra = extra
    s.rec.start()
    const at = (stepMs: number, seg: number, reads: number) => {
      s.advance(stepMs)
      sample.now = s.now
      extra[0] = seg
      extra[1] = reads
      s.rec.record(sample)
    }
    at(10, 4.567, 0)
    at(10, NaN, 2)
    at(10, 8, NaN)
    s.rec.record({ ...sample, now: s.now + 10, extra: undefined }) // no extra values at all
    s.rec.stop()
    const doc = s.rec.export()
    expect(doc.samples.segmentationMs).toEqual([4.57, NaN, 8, NaN])
    expect(doc.samples.readPixels).toEqual([0, 2, NaN, NaN])
    expect(doc.summary.extra?.segmentationMs).toEqual({ mean: 6.283, p50: 6.283, p95: 7.828, p99: 7.966, max: 8 })
    expect(doc.summary.extra?.readPixels?.mean).toBe(1)
    expect(doc.intervals[0]?.extra?.segmentationMs?.max).toBe(4.567) // t = 10 and 20 ms
    expect(doc.intervals[1]?.extra?.segmentationMs?.max).toBe(8) // t = 30 and 40 ms
    expect(doc.intervals[1]?.extra?.readPixels?.mean).toBeNull()
    // NaN is exported as null.
    expect(JSON.parse(stringifySession(doc)).samples.segmentationMs).toEqual([4.57, null, 8, null])
  })

  it('rejects invalid extra column names', () => {
    expect(() => new SessionRecorder({ extraColumns: ['renderMs'] })).toThrow(RangeError)
    expect(() => new SessionRecorder({ extraColumns: ['a', 'a'] })).toThrow(RangeError)
    expect(() => new SessionRecorder({ extraColumns: [''] })).toThrow(RangeError)
  })
})

describe('stringifySession', () => {
  it('round-trips through JSON.parse, one column per line', () => {
    const s = setup()
    s.rec.setInfo(INFO)
    s.rec.start()
    for (let i = 0; i < 3; i++) s.frame(16.7)
    s.rec.event({ type: 'wakeLock', state: 'acquired' })
    s.rec.stop()
    const doc = s.rec.export({ device: { userAgent: 'ua', screen: { width: 390, height: 844 } } })
    const text = stringifySession(doc)
    expect(JSON.parse(text)).toEqual(doc)
    const lines = text.split('\n')
    expect(lines.some((l) => l.startsWith('    "t": [16.7,33.4,50.1]'))).toBe(true)
    expect(lines.some((l) => l === '    {"t":50.1,"type":"wakeLock","state":"acquired"}')).toBe(true)
  })
})
