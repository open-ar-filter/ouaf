import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FaceFrame } from '../src/face.ts'
import type { FaceTrackerImpl, FrameTracker, LandmarkModifier, TrackerConfig } from '../src/engine/plugin.ts'
import { TRACKING_RATE_WINDOW_MS, TrackingHub } from '../src/engine/tracking.ts'

const input = { videoWidth: 64, videoHeight: 48 } as HTMLVideoElement

afterEach(() => {
  vi.restoreAllMocks()
})

/** A fake tracker that finds `faces` faces; `mode` picks synchronous results, pending ones (resolved by hand) or failures. */
function fakeTracker(options: { faces?: number; mode?: 'sync' | 'manual' | 'throw' | 'reject' } = {}) {
  const log: string[] = []
  const configs: TrackerConfig[] = []
  const resolvers: Array<{ resolve: () => void; reject: (e: unknown) => void }> = []
  let disposed = 0
  const state = { faces: options.faces ?? 1, mode: options.mode ?? 'sync' }
  const tracker: FrameTracker = {
    description: 'fake',
    backend: { name: 'fake', source: 'only' },
    timings: { infer: 2 },
    sheds: ['resolution'],
    offMainThread: true,
    measuring: false,
    track(_i, ts, mediaTime, out, exact) {
      log.push(`track ${ts}${exact ? ' exact' : ''}`)
      out.count = state.faces
      out.mediaTime = mediaTime
      if (state.mode === 'throw') throw new Error('track threw')
      if (state.mode === 'reject') return Promise.reject(new Error('track rejected'))
      if (state.mode === 'manual') return new Promise<void>((resolve, reject) => resolvers.push({ resolve, reject }))
    },
    trackImage(_i, mediaTime, out) {
      log.push(`trackImage ${mediaTime}`)
      out.count = state.faces
      out.mediaTime = mediaTime
      return Promise.resolve()
    },
    reset() {
      log.push('reset')
    },
    benchmark() {
      log.push('benchmark')
    },
    configure: (c) => void configs.push({ ...c }),
    dispose: () => void disposed++,
  }
  return {
    tracker,
    log,
    configs,
    resolvers,
    state,
    get disposed() {
      return disposed
    },
  }
}

function hub(impl: FaceTrackerImpl | undefined, options: { maxFaces?: number; modifiers?: LandmarkModifier[] } = {}) {
  const errors: unknown[] = []
  const h = new TrackingHub({
    impl,
    env: { assetsBaseUrl: '/', warn: () => {} },
    maxFaces: options.maxFaces ?? 2,
    modifiers: options.modifiers ?? [],
    onError: (e) => void errors.push(e),
  })
  return { hub: h, errors }
}

function implOf(tracker: FrameTracker, created: TrackerConfig[] = []): FaceTrackerImpl {
  return {
    id: 'fake',
    create: async (config) => {
      created.push({ ...config })
      return tracker
    },
  }
}

const FACE = { face: true, blendshapes: false }

describe('TrackingHub: starting and configuring (spec §4.1, §16.2)', () => {
  it('has no face and no tracker info before a filter needs tracking', () => {
    const { hub: h } = hub(implOf(fakeTracker().tracker))
    expect(h.active).toBe(false)
    expect(h.faces.count).toBe(0)
    expect(h.description).toBeUndefined()
    expect(h.backend).toBeUndefined()
    expect(h.timings).toBeUndefined()
    expect(h.sheds).toBeUndefined()
    expect(h.offMainThread).toBe(false)
    expect(h.measuring).toBe(false)
    expect(h.starting).toBeUndefined()
    expect(h.config).toEqual({ maxFaces: 2, blendshapes: false, analysisScale: 1 })
    expect(h.configVersion).toBe(0)
    expect(Number.isNaN(h.pipelineMs)).toBe(true)
    expect(h.rateHz).toBe(0)
  })

  it('fails clearly when a filter needs the face and no tracker plugin is installed', async () => {
    const { hub: h } = hub(undefined)
    await expect(h.setNeeds(FACE)).rejects.toThrow('A filter requires face tracking but no face tracker plugin is installed.')
    // Not needed: no tracker required.
    await expect(h.setNeeds({ face: false, blendshapes: false })).resolves.toBeUndefined()
  })

  it('starts the tracker with the union of the needs, clamped to the engine limits', async () => {
    const fake = fakeTracker()
    const created: TrackerConfig[] = []
    const { hub: h } = hub(implOf(fake.tracker, created), { maxFaces: 3 })
    await h.setNeeds({ face: true, blendshapes: true, maxFaces: 9.7, analysisScale: 0.01 })
    expect(created).toEqual([{ maxFaces: 3, blendshapes: true, analysisScale: 0.1 }])
    expect(h.active).toBe(true)
    expect(h.configVersion).toBe(1)
    expect(h.description).toBe('fake')
    expect(h.backend).toEqual({ name: 'fake', source: 'only' })
    expect(h.timings).toEqual({ infer: 2 })
    expect(h.sheds).toEqual(['resolution'])
    expect(h.offMainThread).toBe(true)
    expect(h.measuring).toBe(false)

    // Same needs: nothing to do.
    await h.setNeeds({ face: true, blendshapes: true, maxFaces: 3, analysisScale: 0.05 })
    expect(fake.configs).toEqual([])
    expect(h.configVersion).toBe(1)
    // Fewer faces, a finer analysis (at most 1), at least one face.
    await h.setNeeds({ face: true, blendshapes: true, maxFaces: 0, analysisScale: 4 })
    expect(fake.configs).toEqual([{ maxFaces: 1, blendshapes: true, analysisScale: 1 }])
    expect(h.configVersion).toBe(2)
    expect(h.config).toEqual({ maxFaces: 1, blendshapes: true, analysisScale: 1 })
  })

  it('keeps the tracker warm when no filter needs it, without a face meanwhile', async () => {
    const fake = fakeTracker()
    const { hub: h } = hub(implOf(fake.tracker))
    await h.setNeeds(FACE)
    h.submit(input, 0, 0)
    expect(h.faces.count).toBe(1)
    await h.setNeeds({ face: false, blendshapes: false })
    expect(h.active).toBe(false)
    expect(h.faces.count).toBe(0)
    h.submit(input, 1, 0)
    expect(fake.log).toEqual(['benchmark', 'track 0'])
    expect(fake.disposed).toBe(0)
    await h.setNeeds(FACE)
    expect(h.faces.count).toBe(1) // the last result again, at once
  })

  it('applies needs that changed while the tracker was starting', async () => {
    const fake = fakeTracker()
    let release!: () => void
    const impl: FaceTrackerImpl = { id: 'slow', create: () => new Promise((resolve) => (release = () => resolve(fake.tracker))) }
    const { hub: h } = hub(impl)
    const first = h.setNeeds(FACE)
    expect(h.starting).toBeInstanceOf(Promise)
    const second = h.setNeeds({ face: true, blendshapes: true })
    release()
    await Promise.all([first, second])
    expect(fake.configs).toEqual([{ maxFaces: 2, blendshapes: true, analysisScale: 1 }])
    expect(h.starting).toBeUndefined()
  })

  it('reports a tracker that cannot start, and tries again on the next need', async () => {
    let attempts = 0
    const fake = fakeTracker()
    const impl: FaceTrackerImpl = {
      id: 'flaky',
      create: async () => {
        if (attempts++ === 0) throw new Error('no model')
        return fake.tracker
      },
    }
    const { hub: h } = hub(impl)
    await expect(h.setNeeds(FACE)).rejects.toThrow('no model')
    expect(h.active).toBe(false)
    await h.setNeeds(FACE)
    expect(h.active).toBe(true)
    expect(attempts).toBe(2)
  })

  it('disposes a tracker that finishes starting after the hub was disposed, and ignores later needs', async () => {
    const fake = fakeTracker()
    let release!: () => void
    const impl: FaceTrackerImpl = { id: 'slow', create: () => new Promise((resolve) => (release = () => resolve(fake.tracker))) }
    const { hub: h } = hub(impl)
    const starting = h.setNeeds(FACE)
    h.dispose()
    release()
    await starting
    expect(fake.disposed).toBe(1)
    expect(h.active).toBe(false)
    await h.setNeeds(FACE)
    h.dispose() // twice: once
    expect(fake.disposed).toBe(1)
  })

  it('disposes the running tracker once', async () => {
    const fake = fakeTracker()
    const { hub: h } = hub(implOf(fake.tracker))
    await h.setNeeds(FACE)
    h.dispose()
    h.dispose()
    expect(fake.disposed).toBe(1)
    expect(h.active).toBe(false)
  })
})

describe('TrackingHub: live frames (submit)', () => {
  it('double-buffers results and runs the landmark modifiers on each new one', async () => {
    const fake = fakeTracker()
    const seen: FaceFrame[] = []
    const modifier: LandmarkModifier = { id: 'm', modify: (f) => void seen.push(f) }
    const { hub: h } = hub(implOf(fake.tracker), { modifiers: [modifier] })
    await h.setNeeds(FACE)
    h.submit(input, 0, 0.5)
    const front = h.faces
    expect(front.mediaTime).toBe(0.5)
    expect(seen).toEqual([front])
    h.submit(input, 33, 0.6)
    expect(h.faces).not.toBe(front) // swapped
    expect(h.faces.mediaTime).toBe(0.6)
    expect(h.results).toBe(2)
  })

  it('starts the tracker benchmark on the first live frame only, and again after a new source', async () => {
    const fake = fakeTracker()
    const { hub: h } = hub(implOf(fake.tracker))
    await h.setNeeds(FACE)
    h.submit(input, 0, 0)
    h.submit(input, 1, 0)
    expect(fake.log.filter((l) => l === 'benchmark')).toHaveLength(1)
    h.clear()
    h.submit(input, 2, 0)
    expect(fake.log.filter((l) => l === 'benchmark')).toHaveLength(2)
  })

  it('reports a tracker that throws or rejects, and stays usable', async () => {
    const fake = fakeTracker({ mode: 'throw' })
    const { hub: h, errors } = hub(implOf(fake.tracker))
    await h.setNeeds(FACE)
    h.submit(input, 0, 0)
    expect(errors.map((e) => (e as Error).message)).toEqual(['track threw'])
    fake.state.mode = 'reject'
    h.submit(input, 1, 0)
    await vi.waitFor(() => expect(errors).toHaveLength(2))
    expect((errors[1] as Error).message).toBe('track rejected')
    expect(h.results).toBe(0)
    fake.state.mode = 'sync'
    h.submit(input, 2, 0)
    expect(h.results).toBe(1)
  })

  it('skips frames while a call is in flight (not eager) and drops a result from before clear()', async () => {
    const fake = fakeTracker({ mode: 'manual' })
    const { hub: h } = hub(implOf(fake.tracker))
    await h.setNeeds(FACE)
    h.submit(input, 0, 1)
    h.submit(input, 33, 2) // busy, not eager: skipped
    expect(fake.log).toEqual(['benchmark', 'track 0'])
    h.clear() // new source: the call in flight is from the old one
    expect(h.results).toBe(1)
    fake.resolvers.shift()!.resolve()
    await vi.waitFor(() => expect(fake.resolvers).toHaveLength(0))
    await Promise.resolve()
    expect(h.faces.count).toBe(0)
    expect(h.results).toBe(1)
    // Idle again: the next frame is tracked.
    h.submit(input, 66, 3)
    expect(fake.log.at(-1)).toBe('track 66')
  })
})

describe('TrackingHub: file sources (track, resetTracker)', () => {
  it('waits for the tracker to start, then tracks the frame exactly', async () => {
    const fake = fakeTracker()
    let release!: () => void
    const impl: FaceTrackerImpl = { id: 'slow', create: () => new Promise((resolve) => (release = () => resolve(fake.tracker))) }
    const { hub: h } = hub(impl)
    void h.setNeeds(FACE)
    const tracked = h.track(input, 40, 1.5)
    release()
    await tracked
    expect(fake.log).toEqual(['track 40 exact'])
    expect(h.faces.mediaTime).toBe(1.5)
  })

  it('tracks a still image with trackImage, and waits for the call in flight first', async () => {
    const fake = fakeTracker({ mode: 'manual' })
    const { hub: h } = hub(implOf(fake.tracker))
    await h.setNeeds(FACE)
    h.submit(input, 0, 0)
    let done = false
    const still = h.track(input, 10, 2, true).then(() => void (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    expect(fake.log).toEqual(['benchmark', 'track 0'])
    fake.resolvers.shift()!.resolve()
    await still
    expect(fake.log).toEqual(['benchmark', 'track 0', 'trackImage 2'])
    expect(h.faces.mediaTime).toBe(2)
  })

  it('falls back to an exact track for a still image without trackImage', async () => {
    const fake = fakeTracker()
    delete (fake.tracker as { trackImage?: unknown }).trackImage
    const { hub: h } = hub(implOf(fake.tracker))
    await h.setNeeds(FACE)
    await h.track(input, 5, 0, true)
    expect(fake.log).toEqual(['track 5 exact'])
  })

  it('never rejects: failures go to onError and leave the previous result', async () => {
    const fake = fakeTracker()
    const { hub: h, errors } = hub(implOf(fake.tracker))
    await h.setNeeds(FACE)
    await h.track(input, 1, 1)
    fake.state.mode = 'throw'
    await expect(h.track(input, 2, 2)).resolves.toBeUndefined()
    fake.state.mode = 'reject'
    await expect(h.track(input, 3, 3)).resolves.toBeUndefined()
    expect(errors.map((e) => (e as Error).message)).toEqual(['track threw', 'track rejected'])
    expect(h.faces.mediaTime).toBe(1)
  })

  it('does nothing when tracking is not needed, failed to start or the hub is disposed', async () => {
    const fake = fakeTracker()
    const failing: FaceTrackerImpl = { id: 'x', create: () => Promise.reject(new Error('nope')) }
    const { hub: h } = hub(failing)
    const starting = h.setNeeds(FACE).catch(() => {})
    await h.track(input, 1, 0) // waits for the failed start, then has no tracker
    await starting
    const { hub: idle } = hub(implOf(fake.tracker))
    await idle.track(input, 1, 0)
    await idle.setNeeds(FACE)
    idle.dispose()
    await idle.track(input, 2, 0)
    expect(fake.log).toEqual([])
  })

  it('resets the tracker after the call in flight, and reports a reset failure', async () => {
    const fake = fakeTracker({ mode: 'manual' })
    const { hub: h, errors } = hub(implOf(fake.tracker))
    // No tracker yet: nothing to reset.
    await expect(h.resetTracker()).resolves.toBeUndefined()
    await h.setNeeds(FACE)
    h.submit(input, 0, 0)
    const reset = h.resetTracker()
    await Promise.resolve()
    expect(fake.log).toEqual(['benchmark', 'track 0'])
    fake.resolvers.shift()!.resolve()
    await reset
    expect(fake.log.at(-1)).toBe('reset')
    fake.tracker.reset = () => Promise.reject(new Error('reset failed'))
    await h.resetTracker()
    expect(errors.map((e) => (e as Error).message)).toEqual(['reset failed'])
  })

  it('waits for a starting tracker before resetting it', async () => {
    const fake = fakeTracker()
    let release!: () => void
    const impl: FaceTrackerImpl = { id: 'slow', create: () => new Promise((resolve) => (release = () => resolve(fake.tracker))) }
    const { hub: h } = hub(impl)
    void h.setNeeds(FACE)
    const reset = h.resetTracker()
    release()
    await reset
    expect(fake.log).toEqual(['reset'])
  })
})

describe('TrackingHub: tracking rate (spec §16.1)', () => {
  /** A hub on a synchronous tracker and a mocked clock; each result takes `cost` ms. */
  async function timed(faces = 1) {
    const clock = { now: 0 }
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
    const fake = fakeTracker({ faces })
    const cost = { ms: 5 }
    const track = fake.tracker.track.bind(fake.tracker)
    fake.tracker.track = (...args) => {
      clock.now += cost.ms
      return track(...args)
    }
    const { hub: h } = hub(implOf(fake.tracker))
    await h.setNeeds(FACE)
    /** One frame every `interval` ms. */
    const frames = (n: number, interval: number) => {
      for (let i = 0; i < n; i++) {
        clock.now += interval - cost.ms
        h.submit(input, clock.now, 0)
      }
    }
    return { h, clock, fake, cost, frames }
  }

  it('measures results per second and the time per result over the window', async () => {
    const { h, frames } = await timed()
    frames(1, 20)
    expect(h.rateHz).toBe(0) // fewer than two results
    expect(h.pipelineMs).toBe(5)
    frames(10, 20)
    // 11 results, the first completed at 20 ms; the window ends at the last submit (215 ms).
    expect(h.rateHz).toBeCloseTo((10 * 1000) / (215 - 20))
    expect(h.pipelineMs).toBe(5)
  })

  it('forgets results older than the window', async () => {
    const { h, frames } = await timed()
    frames(20, 10) // 100 Hz for 200 ms
    frames(Math.ceil(TRACKING_RATE_WINDOW_MS / 100) + 2, 100) // then 10 Hz for longer than the window
    expect(h.rateHz).toBeCloseTo(10, 0)
  })

  it('restarts the window: only results completed since count', async () => {
    const { h, frames, clock } = await timed()
    frames(10, 10)
    h.restartRate(clock.now + 1)
    expect(h.rateHz).toBe(0)
    expect(Number.isNaN(h.pipelineMs)).toBe(true)
    frames(5, 50)
    // Results at 150…350 ms, the last submit at 345 ms.
    expect(h.rateHz).toBeCloseTo((4 * 1000) / (345 - 150))
  })

  it('keeps the most recent results in a ring buffer', async () => {
    const { h, frames, cost } = await timed()
    frames(300, 5) // more than its capacity, every 5 ms
    cost.ms = 1
    frames(50, 5)
    // The window spans the last 256 results only: 206 of 5 ms, then 50 of 1 ms.
    expect(h.pipelineMs).toBeCloseTo((206 * 5 + 50 * 1) / 256, 5)
    expect(h.rateHz).toBeCloseTo(200, 0)
    expect(h.results).toBe(350)
  })

  it('rateWithFaces: rate and pipeline time of the results that found enough faces', async () => {
    const { h, frames, fake, cost } = await timed()
    const out = new Float64Array(2)
    h.rateWithFaces(1, out)
    expect(Number.isNaN(out[0]!)).toBe(true)
    expect(Number.isNaN(out[1]!)).toBe(true)
    // No face: fast (detector only).
    fake.state.faces = 0
    cost.ms = 1
    frames(5, 10)
    h.rateWithFaces(1, out)
    expect(Number.isNaN(out[0]!)).toBe(true)
    expect(Number.isNaN(out[1]!)).toBe(true)
    h.rateWithFaces(0, out) // every result
    expect(out[0]).toBeCloseTo(100)
    expect(out[1]).toBe(1)
    // With a face: slower.
    fake.state.faces = 1
    cost.ms = 8
    frames(5, 20)
    h.rateWithFaces(1, out)
    expect(out[0]).toBeCloseTo(50)
    expect(out[1]).toBe(8)
    // One result with two faces: its interval is from the result before it, whatever that one found.
    fake.state.faces = 2
    frames(1, 25)
    h.rateWithFaces(2, out)
    expect(out[0]).toBeCloseTo(40)
    expect(out[1]).toBe(8)
  })
})
