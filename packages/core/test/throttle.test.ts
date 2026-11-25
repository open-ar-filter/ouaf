import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFaceFrame } from '../src/face.ts'
import type { FaceTrackerImpl, FrameTracker, PluginApi, TrackerConfig, TrackerEnv } from '../src/engine/plugin.ts'
import { DEFAULT_THROTTLE_SHARES, throttledMs, throttlePlugin, throttleTracker, type TrackingThrottle } from '../src/engine/throttle.ts'

const FULL: TrackerConfig = { maxFaces: 2, blendshapes: true, analysisScale: 1 }
const ENV: TrackerEnv = { assetsBaseUrl: '/', warn: () => {} }
const input = { videoWidth: 64, videoHeight: 48 } as HTMLVideoElement

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('throttledMs (spec §16.2 shares)', () => {
  it('is 0 without throttling (0, negative or NaN ms)', () => {
    for (const ms of [0, -5, Number.NaN]) expect(throttledMs({ ms }, FULL, 2)).toBe(0)
  })

  it('is the full time with every capability on', () => {
    expect(throttledMs({ ms: 80 }, FULL, 2)).toBe(80)
  })

  it('saves the default share of each capability the governor dropped', () => {
    expect(throttledMs({ ms: 100 }, { ...FULL, blendshapes: false }, 2)).toBeCloseTo(100 * (1 - DEFAULT_THROTTLE_SHARES.blendshapes))
    expect(throttledMs({ ms: 100 }, { ...FULL, maxFaces: 1 }, 2)).toBeCloseTo(100 * (1 - DEFAULT_THROTTLE_SHARES.extraFaces))
    expect(throttledMs({ ms: 100 }, { ...FULL, analysisScale: 0.5 }, 2)).toBeCloseTo(100 * (1 - DEFAULT_THROTTLE_SHARES.resolution))
    expect(throttledMs({ ms: 100 }, { maxFaces: 1, blendshapes: false, analysisScale: 0.5 }, 2)).toBeCloseTo(40)
  })

  it('counts extra faces as dropped only for a tracker created for several faces', () => {
    expect(throttledMs({ ms: 100 }, { ...FULL, maxFaces: 1 }, 1)).toBe(100)
    // Whatever the number dropped, one share.
    expect(throttledMs({ ms: 100 }, { ...FULL, maxFaces: 2 }, 4)).toBeCloseTo(80)
    expect(throttledMs({ ms: 100 }, { ...FULL, maxFaces: 1 }, 4)).toBeCloseTo(80)
  })

  it('takes custom shares, the others keeping their default, and never goes below 0', () => {
    const throttle: TrackingThrottle = { ms: 100, shares: { blendshapes: 0.5 } }
    expect(throttledMs(throttle, { ...FULL, blendshapes: false }, 2)).toBeCloseTo(50)
    expect(throttledMs(throttle, { ...FULL, analysisScale: 0.5 }, 2)).toBeCloseTo(75)
    const greedy: TrackingThrottle = { ms: 100, shares: { blendshapes: 0.6, extraFaces: 0.6 } }
    expect(throttledMs(greedy, { ...FULL, maxFaces: 1, blendshapes: false }, 2)).toBe(0)
  })
})

/** A fake inner tracker: synchronous or not, with or without the optional members. */
function inner(options: { async?: boolean; optional?: boolean } = {}) {
  const log: string[] = []
  const tracker: FrameTracker = {
    description: 'inner',
    track(_i, ts, _m, out, exact) {
      log.push(`track ${ts}${exact ? ' exact' : ''}`)
      out.count = 1
      return options.async ? Promise.resolve() : undefined
    },
    configure: (c) => void log.push(`configure ${c.maxFaces} ${c.blendshapes} ${c.analysisScale}`),
    dispose: () => void log.push('dispose'),
    ...(options.optional
      ? {
          backend: { name: 'X', source: 'only' as const },
          measuring: true,
          eager: true,
          timings: { infer: 3 },
          sheds: ['blendshapes' as const],
          offMainThread: false,
          trackImage(this: FrameTracker) {
            log.push(`trackImage ${this.description}`)
          },
          reset(this: FrameTracker) {
            log.push(`reset ${this.description}`)
          },
          benchmark(this: FrameTracker) {
            log.push(`benchmark ${this.description}`)
          },
          offer: (_i: unknown, ts: number) => void log.push(`offer ${ts}`),
        }
      : {}),
  }
  const created: TrackerConfig[] = []
  const impl: FaceTrackerImpl = {
    id: 'inner-id',
    cost: { typicalMs: 7 },
    create: async (config) => {
      created.push(config)
      return tracker
    },
  }
  return { impl, tracker, log, created }
}

describe('throttleTracker', () => {
  it('keeps the inner id and cost, and creates the inner tracker with the same config', async () => {
    const { impl, created } = inner()
    const wrapped = throttleTracker(impl, { ms: 10 })
    expect(wrapped.id).toBe('inner-id')
    expect(wrapped.cost).toEqual({ typicalMs: 7 })
    expect('cost' in throttleTracker({ id: 'bare', create: impl.create }, { ms: 1 })).toBe(false)
    await wrapped.create(FULL, ENV)
    expect(created).toEqual([FULL])
  })

  it('holds a result back until the simulated time has passed since the call', async () => {
    vi.useFakeTimers()
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { impl, log } = inner({ async: true })
    const t = await throttleTracker(impl, { ms: 50 }).create(FULL, ENV)
    let done = false
    const pending = t.track(input, 1, 0, createFaceFrame(2), true)
    expect(pending).toBeInstanceOf(Promise)
    void (pending as Promise<void>).then(() => void (done = true))
    expect(log).toEqual(['track 1 exact']) // the real tracker runs at once
    now += 20 // the inner result came after 20 ms: 30 ms are left
    await vi.advanceTimersByTimeAsync(29)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it('does not wait when the inner tracker already took longer than the simulated time', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { impl } = inner()
    const throttle = { ms: 30 }
    const t = await throttleTracker(impl, throttle).create(FULL, ENV)
    const out = createFaceFrame(2)
    // Synchronous inner tracker, yet a promise: the result is delivered asynchronously.
    const pending = t.track(input, 1, 0, out)
    now = 100
    await expect(pending).resolves.toBeUndefined()
    expect(out.count).toBe(1)
  })

  it('passes results through untouched without throttling, and reads `ms` on every frame', async () => {
    const { impl, log } = inner()
    const throttle = { ms: 0 }
    const t = await throttleTracker(impl, throttle).create(FULL, ENV)
    expect(t.track(input, 1, 0, createFaceFrame(2))).toBeUndefined()
    expect(t.description).toBe('inner')
    throttle.ms = 40
    expect(t.track(input, 2, 0, createFaceFrame(2))).toBeInstanceOf(Promise)
    expect(t.description).toBe('inner, throttled to 40 ms')
    expect(log).toEqual(['track 1', 'track 2'])
  })

  it('describes the time left once the governor drops capabilities (configure)', async () => {
    const { impl, log } = inner()
    const t = await throttleTracker(impl, { ms: 100 }).create(FULL, ENV)
    t.configure({ maxFaces: 1, blendshapes: false, analysisScale: 1 })
    expect(log).toEqual(['configure 1 false 1'])
    expect(t.description).toBe('inner, throttled to 65 ms')
  })

  it('without optional members, has none of them', async () => {
    const { impl } = inner()
    const throttle = { ms: 0 }
    const t = await throttleTracker(impl, throttle).create(FULL, ENV)
    expect(t.trackImage).toBeUndefined()
    expect(t.reset).toBeUndefined()
    expect(t.benchmark).toBeUndefined()
    expect(t.backend).toBeUndefined()
    expect(t.measuring).toBeUndefined()
    expect(t.eager).toBe(false)
    expect(t.timings).toBeUndefined()
    expect(t.sheds).toBeUndefined()
    expect(t.offMainThread).toBe(false)
    expect(() => t.offer!(input, 1, 0)).not.toThrow()
    // Throttled, the simulated time is a timer that hiding the filters does not shorten.
    throttle.ms = 20
    expect(t.offMainThread).toBe(true)
  })

  it('forwards the optional members bound to the inner tracker', async () => {
    const { impl, log } = inner({ optional: true })
    const throttle = { ms: 0 }
    const t = await throttleTracker(impl, throttle).create(FULL, ENV)
    void t.trackImage!(input, 0, createFaceFrame(2))
    void t.reset!()
    t.benchmark!()
    expect(log).toEqual(['trackImage inner', 'reset inner', 'benchmark inner'])
    expect(t.backend).toEqual({ name: 'X', source: 'only' })
    expect(t.measuring).toBe(true)
    expect(t.timings).toEqual({ infer: 3 })
    // Not throttled: the inner scheduling and sheds.
    expect(t.eager).toBe(true)
    expect(t.sheds).toEqual(['blendshapes'])
    expect(t.offMainThread).toBe(false)
    t.offer!(input, 5, 0)
    expect(log.at(-1)).toBe('offer 5')
    // Throttled: results come on frame ticks, every capability has a cost, no frames offered.
    throttle.ms = 20
    expect(t.eager).toBe(false)
    expect(t.sheds).toBeUndefined()
    t.offer!(input, 6, 0)
    expect(log.at(-1)).toBe('offer 5')
    t.dispose()
    expect(log.at(-1)).toBe('dispose')
  })
})

describe('throttlePlugin', () => {
  it('registers the throttled version of the given tracker', async () => {
    const { impl, log } = inner()
    const registered: FaceTrackerImpl[] = []
    const plugin = throttlePlugin({ ms: 25 }, impl)
    expect(plugin.name).toBe('tracking-throttle')
    expect(plugin.version).toBe('1.0.0')
    plugin.setup!({ registerTracker: (t: FaceTrackerImpl) => void registered.push(t) } as unknown as PluginApi)
    expect(registered).toHaveLength(1)
    expect(registered[0]!.id).toBe('inner-id')
    const t = await registered[0]!.create(FULL, ENV)
    expect(t.description).toBe('inner, throttled to 25 ms')
    void t.track(input, 3, 0, createFaceFrame(2))
    expect(log).toEqual(['track 3'])
  })

  it('wraps the built-in face tracker by default', () => {
    const registered: FaceTrackerImpl[] = []
    throttlePlugin({ ms: 1 }).setup!({ registerTracker: (t: FaceTrackerImpl) => void registered.push(t) } as unknown as PluginApi)
    expect(registered[0]!.id).toBe('face')
  })
})
