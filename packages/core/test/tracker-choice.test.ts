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

describe('choosingFaceTracker: edge cases', () => {
  /** A candidate over a hand-made tracker. */
  function custom(name: string, tracker: () => FrameTracker, extra: Partial<TrackerCandidate> = {}): TrackerCandidate {
    return { name, open: async () => tracker(), ...extra }
  }

  it('refuses to start without candidates, and keeps the cost when given', async () => {
    const impl = choosingFaceTracker({ id: 'face', cost: { typicalMs: 15 }, candidates: () => [] })
    expect(impl.id).toBe('face')
    expect(impl.cost).toEqual({ typicalMs: 15 })
    expect('cost' in choosingFaceTracker({ id: 'x', candidates: () => [] })).toBe(false)
    await expect(impl.create(CONFIG, env().env)).rejects.toThrow('No face tracker is available in this browser.')
  })

  it('gives the candidates the configuration, and the last error as the cause when none starts', async () => {
    const seen: TrackerConfig[] = []
    const cause = new Error('CPU unavailable')
    const impl = choosingFaceTracker({
      id: 'face',
      candidates: (config) => {
        seen.push(config)
        return [fake('GPU', { fails: true }).candidate, { name: 'CPU', open: () => Promise.reject(cause) }]
      },
    })
    const e = env()
    const error = await impl.create(CONFIG, e.env).catch((err: unknown) => err)
    expect(seen).toEqual([CONFIG])
    expect((error as Error).message).toBe('No face tracker could start (GPU, CPU).')
    expect((error as Error).cause).toBe(cause)
    expect(e.warnings).toEqual(['The GPU face tracker could not start; trying CPU: GPU unavailable', 'The CPU face tracker could not start: CPU unavailable'])
  })

  it('a forced backend that cannot start falls back to the others, without measuring', async () => {
    const lite = fake('LiteRT', { fails: true })
    const cpu = fake('CPU')
    const gpu = fake('GPU')
    const e = env({ backend: 'LITERT' })
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, cpu.candidate, gpu.candidate] }).create(CONFIG, e.env)
    expect(t.backend).toEqual({ name: 'CPU', source: 'only' })
    t.benchmark!()
    expect(t.measuring).toBe(false)
    expect(gpu.opened).toBe(0)
  })

  it('a cached choice without times, or a single candidate, is not measured', async () => {
    const ua = navigator.userAgent
    const cpu = fake('CPU')
    const lite = fake('LiteRT')
    const cached = await choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, cpu.candidate] }).create(
      CONFIG,
      env({ stored: { backend: 'CPU', userAgent: ua, at: '' } }).env,
    )
    expect(cached.backend).toEqual({ name: 'CPU', source: 'cached' })
    expect(cached.description).toBe('CPU tracker (cached)')
    const only = await choosingFaceTracker({ id: 'face', candidates: () => [cpu.candidate] }).create(CONFIG, env().env)
    expect(only.backend).toEqual({ name: 'CPU', source: 'only' })
    expect(only.description).toBe('CPU tracker (only)')
  })

  it('while measuring: describes the candidates, hides timings, configures them all and forwards offers to the last', async () => {
    const offers: string[] = []
    const configs: Record<string, TrackerConfig[]> = { LiteRT: [], CPU: [] }
    const make = (name: string, eager: boolean) => (): FrameTracker => ({
      description: `${name} tracker`,
      eager,
      timings: { [name]: 1 },
      sheds: [name === 'LiteRT' ? 'resolution' : 'blendshapes'],
      track(_i, _t, _m, out) {
        out.count = 1
      },
      offer: (_i, ts) => void offers.push(`${name} ${ts}`),
      configure: (c) => void configs[name]!.push(c),
      dispose: () => {},
    })
    const lite = custom('LiteRT', make('LiteRT', true), { label: (t) => `LiteRT.js (${t.description})` })
    const cpu = custom('CPU', make('CPU', false))
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite, cpu], benchmark: { warmup: 0, samples: 2 } }).create(
      CONFIG,
      env().env,
    )
    expect(t.description).toBe('LiteRT.js (LiteRT tracker) (pending)')
    expect(t.timings).toEqual({ LiteRT: 1 })
    expect(t.sheds).toEqual(['resolution'])
    t.offer!(input, 1, 0)
    expect(offers).toEqual(['LiteRT 1'])
    t.benchmark!()
    expect(t.description).toBe('LiteRT.js (LiteRT tracker) (measuring LiteRT, CPU)')
    await vi.waitFor(() => expect(configs.CPU).toHaveLength(1)) // both configured when the benchmark starts
    expect(t.timings).toBeUndefined()
    const next: TrackerConfig = { maxFaces: 1, blendshapes: false, analysisScale: 0.5 }
    t.configure(next)
    expect(configs.LiteRT!.at(-1)).toEqual(next)
    expect(configs.CPU!.at(-1)).toEqual(next)
    // Blocks: LiteRT first, then CPU; the scheduling follows the tracker of the last call.
    const out = createFaceFrame(1)
    await t.track(input, 1, 0, out)
    await t.track(input, 2, 0, out)
    expect(t.eager).toBe(true)
    await t.track(input, 3, 0, out)
    expect(t.eager).toBe(false)
    t.offer!(input, 4, 0)
    expect(offers).toEqual(['LiteRT 1', 'CPU 4'])
  })

  it('without a measured candidate opening, the backend is the only one, with a warning', async () => {
    const lite = fake('LiteRT')
    let cpuOpens = 0
    const cpu: TrackerCandidate = {
      name: 'CPU',
      open: async () => {
        cpuOpens++
        throw new Error('no wasm')
      },
    }
    const e = env()
    // The CPU opens for create's order check only when it is first: LiteRT starts, CPU fails when measured.
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, cpu] }).create(CONFIG, e.env)
    t.benchmark!()
    await vi.waitFor(() => expect(t.measuring).toBe(false))
    expect(cpuOpens).toBe(1)
    expect(t.backend).toEqual({ name: 'LiteRT', source: 'only' })
    expect(e.warnings).toEqual(['Could not open the CPU face tracker to measure it: no wasm'])
  })

  it('closes a tracker opened for a benchmark that was disposed or aborted meanwhile', async () => {
    const lite = fake('LiteRT')
    let release!: () => void
    const late = fake('CPU')
    const cpu: TrackerCandidate = {
      name: 'CPU',
      open: () => new Promise<FrameTracker>((resolve) => (release = () => void late.candidate.open(CONFIG, env().env).then(resolve))),
    }
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, cpu] }).create(CONFIG, env().env)
    t.benchmark!()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    t.dispose()
    release()
    await vi.waitFor(() => expect(late.disposed).toBe(1))
    expect(lite.disposed).toBe(1)
    t.benchmark!() // disposed: nothing
    expect(t.measuring).toBe(true) // the aborted run never finished; it is simply gone
  })

  it('a still image stops the benchmark and uses trackImage, or track without one', async () => {
    const calls: string[] = []
    const lite = custom('LiteRT', () => ({
      description: 'lite',
      track: () => void calls.push('lite track'),
      trackImage: () => void calls.push('lite trackImage'),
      configure: () => void calls.push('lite configure'),
      dispose: () => void calls.push('lite dispose'),
    }))
    const cpu = fake('CPU')
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite, cpu.candidate] }).create(CONFIG, env().env)
    t.benchmark!()
    await vi.waitFor(() => expect(cpu.opened).toBe(1))
    await t.trackImage!(input, 0, createFaceFrame(1))
    expect(t.measuring).toBe(false)
    expect(cpu.disposed).toBe(1)
    expect(calls).toContain('lite trackImage')
    expect(calls.at(-2)).toBe('lite configure') // back to its own configuration

    const plain = await choosingFaceTracker({ id: 'face', candidates: () => [cpu.candidate] }).create(CONFIG, env().env)
    await plain.trackImage!(input, 2.5, createFaceFrame(1))
    expect(cpu.calls.at(-1)).toBe(2.5)
    expect(await plain.reset!()).toBeUndefined() // no reset of its own
  })

  it('an error of a tracker that is not broken is the caller’s, sync or async', async () => {
    const sync = custom('A', () => ({
      description: 'a',
      track() {
        throw new Error('sync failure')
      },
      trackImage() {
        throw new Error('image failure')
      },
      configure: () => {},
      dispose: () => {},
    }))
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [sync] }).create(CONFIG, env().env)
    const out = createFaceFrame(1)
    out.count = 1
    await expect(t.track(input, 1, 0, out)).rejects.toThrow('sync failure')
    expect(out.count).toBe(0) // no face for a failed frame
    await expect(t.trackImage!(input, 0, out)).rejects.toThrow('image failure')

    const asyncFail = custom('B', () => ({
      description: 'b',
      track: () => Promise.reject(new Error('async failure')),
      trackImage: () => Promise.reject(new Error('async image failure')),
      configure: () => {},
      dispose: () => {},
    }))
    const u = await choosingFaceTracker({ id: 'face', candidates: () => [asyncFail] }).create(CONFIG, env().env)
    await expect(u.track(input, 1, 0, out)).rejects.toThrow('async failure')
    await expect(u.trackImage!(input, 0, out)).rejects.toThrow('async image failure')
  })

  it('a broken tracker with no candidate left rejects with its error', async () => {
    const lite = fake('LiteRT', { async: true })
    const cpu = fake('CPU', { fails: true })
    // CPU failed to start before LiteRT did: nothing is left to switch to.
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [cpu.candidate, lite.candidate] }).create(CONFIG, env().env)
    lite.breakIt()
    await expect(t.track(input, 1, 0, createFaceFrame(1))).rejects.toThrow('LiteRT broke')
    expect(lite.disposed).toBe(1)
  })

  it('when every replacement fails to open, says so with warnings', async () => {
    const lite = fake('LiteRT', { async: true })
    const gpu: TrackerCandidate = { name: 'GPU', open: () => Promise.reject(new Error('GPU lost')) }
    const e = env({ backend: 'litert' })
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, gpu] }).create(CONFIG, e.env)
    lite.breakIt()
    const error = await (t.track(input, 1, 0, createFaceFrame(1)) as Promise<void>).catch((err: unknown) => err)
    expect((error as Error).message).toBe('No face tracker could start.')
    expect(((error as Error).cause as Error).message).toBe('GPU lost')
    expect(e.warnings).toEqual(['The LiteRT face tracker failed (LiteRT broke); switching to GPU.', 'The GPU face tracker could not start: GPU lost'])
  })

  it('a replacement that opens after dispose is closed', async () => {
    const lite = fake('LiteRT', { async: true })
    const cpu = fake('CPU')
    let release!: () => void
    const slow: TrackerCandidate = {
      name: 'CPU',
      open: () => new Promise<FrameTracker>((resolve) => (release = () => void cpu.candidate.open(CONFIG, env().env).then(resolve))),
    }
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, slow] }).create(CONFIG, env({ backend: 'litert' }).env)
    lite.breakIt()
    const switching = t.track(input, 1, 0, createFaceFrame(1))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    t.dispose()
    release()
    await switching
    expect(cpu.disposed).toBe(1)
  })

  it('a candidate that breaks while it is measured is dropped, and the current tracker is kept', async () => {
    const lite = fake('LiteRT', { async: true })
    const cpu = fake('CPU', { async: true })
    const e = env()
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, cpu.candidate], benchmark: { warmup: 0, samples: 1 } }).create(
      CONFIG,
      e.env,
    )
    t.benchmark!()
    await vi.waitFor(() => expect(cpu.opened).toBe(1))
    const out = createFaceFrame(1)
    await t.track(input, 1, 0, out) // LiteRT's block
    cpu.breakIt()
    await t.track(input, 2, 0, out) // CPU's block: it breaks
    expect(out.count).toBe(0)
    expect(t.measuring).toBe(false)
    expect(t.backend).toEqual({ name: 'LiteRT', source: 'only' })
    expect(cpu.disposed).toBe(1)
    expect(e.warnings).toEqual(['The CPU face tracker failed while it was measured: CPU broke'])
    // Not measured again on a later live source.
    t.benchmark!()
    expect(t.measuring).toBe(false)
    await t.track(input, 3, 0, out)
    expect(out.count).toBe(1)
  })

  it('the current tracker breaking while measured is replaced by the next one', async () => {
    const lite = fake('LiteRT', { async: true })
    const cpu = fake('CPU', { async: true })
    const e = env()
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, cpu.candidate], benchmark: { warmup: 0, samples: 1 } }).create(
      CONFIG,
      e.env,
    )
    t.benchmark!()
    await vi.waitFor(() => expect(cpu.opened).toBe(1))
    lite.breakIt()
    await t.track(input, 1, 0, createFaceFrame(1))
    expect(t.backend).toEqual({ name: 'CPU', source: 'only' })
    expect(e.warnings).toEqual(['The LiteRT face tracker failed (LiteRT broke); switching to CPU.'])
    // The CPU tracker measured was closed by the abort; a new one took over.
    expect(cpu.opened).toBe(2)
  })

  it('dispose closes every tracker of a benchmark in progress', async () => {
    const lite = fake('LiteRT')
    const cpu = fake('CPU')
    const gpu = fake('GPU')
    const t = await choosingFaceTracker({ id: 'face', candidates: () => [lite.candidate, cpu.candidate, gpu.candidate] }).create(CONFIG, env().env)
    t.benchmark!()
    await vi.waitFor(() => expect(gpu.opened).toBe(1))
    await vi.waitFor(() => expect(t.timings).toBeUndefined())
    t.dispose()
    expect([lite.disposed, cpu.disposed, gpu.disposed]).toEqual([1, 1, 1])
  })
})
