import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFaceFrame } from '../src/face.ts'
import type { FrameTracker, TrackerConfig, TrackerEnv } from '../src/engine/plugin.ts'
import { choosingFaceTracker, MAIN_THREAD_WEIGHT, type TrackerCandidate } from '../src/engine/tracker-choice.ts'
import { TrackingHub } from '../src/engine/tracking.ts'

const CONFIG: TrackerConfig = { maxFaces: 1, blendshapes: true, analysisScale: 1 }
const input = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement

afterEach(() => {
  vi.restoreAllMocks()
})

/** Fake clock of `performance.now` (ms), advanced by the fake backends. */
const clock = { now: 0 }

/** A fake backend: `ms` per call on the fake clock, synchronous or not, eager or not. */
function fake(name: string, options: { ms?: number; async?: boolean; eager?: boolean; fails?: boolean; weight?: number } = {}) {
  const calls: number[] = []
  const configs: TrackerConfig[] = []
  let opened = 0
  let disposed = 0
  let broken = false
  const tracker = (): FrameTracker => ({
    description: `${name} tracker`,
    eager: options.eager ?? false,
    track(_input, _ts, mediaTime, out) {
      calls.push(mediaTime)
      if (broken) return Promise.reject(new Error(`${name} broke`))
      out.count = 1
      out.mediaTime = mediaTime
      if (!options.async) {
        clock.now += options.ms ?? 10
        return
      }
      return Promise.resolve().then(() => void (clock.now += options.ms ?? 10))
    },
    configure: (c) => void configs.push({ ...c }),
    dispose: () => void disposed++,
  })
  const candidate: TrackerCandidate = {
    name,
    async open() {
      if (options.fails) throw new Error(`${name} unavailable`)
      opened++
      return tracker()
    },
    broken: () => broken,
    ...(options.weight ? { weight: options.weight } : {}),
  }
  return {
    candidate,
    calls,
    configs,
    get opened() {
      return opened
    },
    get disposed() {
      return disposed
    },
    breakIt: () => void (broken = true),
  }
}

function env(options: Partial<TrackerEnv> & { stored?: unknown } = {}) {
  const warnings: string[] = []
  let stored = options.stored
  return {
    env: {
      assetsBaseUrl: '/',
      warn: (m: string) => void warnings.push(m),
      ...(options.backend ? { backend: options.backend } : {}),
      store: { get: () => stored, set: (v: unknown) => void (stored = v) },
    } satisfies TrackerEnv,
    warnings,
    get stored() {
      return stored
    },
  }
}

/** Runs `n` tracking calls, awaiting each (the hub keeps one call in flight). */
async function run(tracker: FrameTracker, n: number): Promise<void> {
  const out = createFaceFrame(1)
  for (let i = 0; i < n; i++) await tracker.track(input, i + 1, i / 30, out)
}

describe('choosingFaceTracker (spec §16.4)', () => {
  it('starts on the first candidate, then measures them one after the other on live frames and keeps the fastest', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
    const lite = fake('LiteRT', { ms: 20, async: true, eager: true })
    const gpu = fake('GPU', { ms: 40, weight: MAIN_THREAD_WEIGHT })
    const cpu = fake('CPU', { ms: 19, weight: MAIN_THREAD_WEIGHT })
    const e = env()
    const impl = choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, gpu.candidate, cpu.candidate], benchmark: { warmup: 1, samples: 3 } })
    const t = await impl.create(CONFIG, e.env)
    expect([lite.opened, gpu.opened, cpu.opened]).toEqual([1, 0, 0])
    expect(t.backend).toEqual({ name: 'LiteRT', source: 'pending' })
    expect(t.eager).toBe(true)

    t.benchmark!()
    expect(t.measuring).toBe(true)
    await vi.waitFor(() => expect(gpu.opened + cpu.opened).toBe(2))
    const out = createFaceFrame(1)
    const order: string[] = []
    for (let i = 0; t.measuring && i < 50; i++) {
      const before = [lite.calls.length, gpu.calls.length, cpu.calls.length]
      await t.track(input, i + 1, i / 30, out)
      order.push(['LiteRT', 'GPU', 'CPU'][[lite.calls.length, gpu.calls.length, cpu.calls.length].findIndex((n, k) => n > before[k]!)]!)
    }
    // Blocks: warm-up + samples of each, one backend after the other.
    expect(order.slice(-12)).toEqual([...Array(4).fill('LiteRT'), ...Array(4).fill('GPU'), ...Array(4).fill('CPU')])
    // CPU is 1 ms faster than LiteRT.js but on the main thread: not 15 % faster, LiteRT.js wins.
    expect(t.backend).toEqual({ name: 'LiteRT', source: 'measured', measuredMs: { LiteRT: 20, GPU: 40, CPU: 19 } })
    expect([gpu.disposed, cpu.disposed, lite.disposed]).toEqual([1, 1, 0])
    expect(e.stored).toMatchObject({ backend: 'LiteRT', measuredMs: { LiteRT: 20, GPU: 40, CPU: 19 } })
    expect(t.description).toBe('LiteRT tracker (measured: LiteRT 20.0 ms, GPU 40.0 ms, CPU 19.0 ms)')
    expect(e.warnings).toEqual([])
  })

  it('a main-thread backend clearly faster wins', async () => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
    const lite = fake('LiteRT', { ms: 30, async: true })
    const cpu = fake('CPU', { ms: 20, weight: MAIN_THREAD_WEIGHT })
    const impl = choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, cpu.candidate], benchmark: { warmup: 0, samples: 2 } })
    const t = await impl.create(CONFIG, env().env)
    t.benchmark!()
    await vi.waitFor(() => expect(cpu.opened).toBe(1))
    const out = createFaceFrame(1)
    for (let i = 0; t.measuring && i < 20; i++) {
      await t.track(input, i + 1, 0, out)
    }
    expect(t.backend?.name).toBe('CPU')
    expect(lite.disposed).toBe(1)
  })

  it('uses the cached choice, or the forced one (any case), without measuring', async () => {
    const lite = fake('LiteRT')
    const cpu = fake('CPU')
    const candidates = () => [lite.candidate, cpu.candidate]
    const impl = choosingFaceTracker({ id: 'face', candidates })
    const ua = navigator.userAgent
    const cached = await impl.create(CONFIG, env({ stored: { backend: 'CPU', measuredMs: { CPU: 5, LiteRT: 9 }, userAgent: ua, at: '' } }).env)
    expect(cached.backend).toEqual({ name: 'CPU', source: 'cached', measuredMs: { CPU: 5, LiteRT: 9 } })
    expect(cached.description).toBe('CPU tracker (cached: CPU 5.0 ms, LiteRT 9.0 ms)')
    cached.benchmark!()
    expect(cached.measuring).toBe(false)

    const forced = await impl.create(CONFIG, env({ backend: 'litert' }).env)
    expect(forced.backend).toEqual({ name: 'LiteRT', source: 'forced' })
    expect(forced.description).toBe('LiteRT tracker (forced)')

    const e = env({ backend: 'NPU' })
    const unknown = await impl.create(CONFIG, e.env)
    expect(unknown.backend).toEqual({ name: 'LiteRT', source: 'pending' })
    expect(e.warnings).toEqual(['Unknown or unavailable face tracker backend "NPU" (here: LiteRT, CPU); choosing it by measuring.'])
  })

  it('skips a candidate that cannot start, with a warning', async () => {
    const lite = fake('LiteRT', { fails: true })
    const gpu = fake('GPU')
    const cpu = fake('CPU', { fails: true })
    const e = env()
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, gpu.candidate, cpu.candidate] }).create(CONFIG, e.env)
    expect(t.backend).toEqual({ name: 'GPU', source: 'pending' })
    expect(e.warnings).toEqual(['The LiteRT face tracker could not start; trying GPU: LiteRT unavailable'])
    // The benchmark has nothing left to compare once CPU fails too.
    t.benchmark!()
    await vi.waitFor(() => expect(t.measuring).toBe(false))
    expect(t.backend).toEqual({ name: 'GPU', source: 'only' })
    await expect(choosingFaceTracker({ id: 'x', candidates: () => [lite.candidate] }).create(CONFIG, e.env)).rejects.toThrow('No face tracker could start (LiteRT).')
  })

  it('stops measuring when a file source starts, and measures again on the next live one', async () => {
    const lite = fake('LiteRT', { async: true })
    const cpu = fake('CPU')
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, cpu.candidate] }).create(CONFIG, env().env)
    t.benchmark!()
    await vi.waitFor(() => expect(cpu.opened).toBe(1))
    await run(t, 2)
    await t.reset!()
    expect(t.measuring).toBe(false)
    expect(cpu.disposed).toBe(1)
    t.benchmark!()
    expect(t.measuring).toBe(true)
    await vi.waitFor(() => expect(cpu.opened).toBe(2))
  })

  it('replaces a broken tracker (its worker died) by the next candidate', async () => {
    const lite = fake('LiteRT', { async: true })
    const cpu = fake('CPU')
    const e = env({ backend: 'litert' })
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, cpu.candidate] }).create(CONFIG, e.env)
    await run(t, 1)
    lite.breakIt()
    const out = createFaceFrame(1)
    out.count = 1
    await t.track(input, 10, 1, out) // no error: the frame has no face, and CPU takes over
    expect(out.count).toBe(0)
    expect(e.warnings).toEqual(['The LiteRT face tracker failed (LiteRT broke); switching to CPU.'])
    expect(t.backend).toEqual({ name: 'CPU', source: 'only' })
    await t.track(input, 11, 1.1, out)
    expect(out.count).toBe(1)
    expect(cpu.calls).toEqual([1.1])
  })
})

describe('TrackingHub: eager trackers (docs/decisions/tracking-worker.md)', () => {
  it('submits the newest missed frame as soon as the call in flight completes', async () => {
    const resolvers: Array<() => void> = []
    const calls: number[] = []
    let eager = true
    const tracker: FrameTracker = {
      description: 'worker',
      get eager() {
        return eager
      },
      track(_i, _t, mediaTime, out) {
        calls.push(mediaTime)
        out.count = 1
        return new Promise<void>((resolve) => resolvers.push(resolve))
      },
      configure: () => {},
      dispose: () => {},
    }
    const hub = new TrackingHub({ impl: { id: 'w', create: async () => tracker }, env: { assetsBaseUrl: '/', warn: () => {} }, maxFaces: 1, modifiers: [], onError: () => {} })
    await hub.setNeeds({ face: true, blendshapes: true })
    hub.submit(input, 0, 0)
    hub.submit(input, 33, 0.033) // busy: remembered
    hub.submit(input, 66, 0.066) // busy: the newest one replaces it
    expect(calls).toEqual([0])
    resolvers.shift()!()
    await vi.waitFor(() => expect(calls).toEqual([0, 0.066]))
    resolvers.shift()!()
    await vi.waitFor(() => expect(hub.results).toBe(2))
    expect(calls).toEqual([0, 0.066]) // nothing missed meanwhile
    // Not eager: frames that come while busy are skipped.
    eager = false
    hub.submit(input, 100, 0.1)
    hub.submit(input, 133, 0.133)
    resolvers.shift()!()
    await vi.waitFor(() => expect(hub.results).toBe(3))
    expect(calls).toEqual([0, 0.066, 0.1])
  })
})
