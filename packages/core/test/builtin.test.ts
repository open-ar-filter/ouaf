import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFaceFrame, type Delegate, type FaceFrame, type FaceTracker, type RunningMode } from '../src/face.ts'
import type { FaceTrackerOptions } from '../src/face-tracker.ts'
import type { FaceTrackerImpl, FrameTracker, PluginApi, TrackerConfig, TrackerEnv } from '../src/engine/plugin.ts'

// MediaPipe and the LiteRT.js worker cannot run in Node: the tracker factories are replaced by fakes.
const mocks = vi.hoisted(() => ({
  createFaceTracker: vi.fn<(options: FaceTrackerOptions) => Promise<FaceTracker>>(),
  openLiteRtTracker: vi.fn<(...args: unknown[]) => Promise<FrameTracker>>(),
}))
vi.mock('../src/face-tracker.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/face-tracker.ts')>()),
  createFaceTracker: mocks.createFaceTracker,
}))
vi.mock('../src/litert/tracker.ts', () => ({ openLiteRtTracker: mocks.openLiteRtTracker }))

const { builtinPlugins, createDefaultFaceTracker, defaultFaceTracker, facePlugin, mediaPipeFaceTracker, MediaPipeFrameTracker } = await import(
  '../src/engine/builtin.ts'
)

const CONFIG: TrackerConfig = { maxFaces: 2, blendshapes: false, analysisScale: 1 }
const input = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement

/** A fake MediaPipe tracker on `delegate`, logging its calls. */
function fakeMediaPipe(delegate: Delegate, options: { mode?: RunningMode; reconfigure?: () => Promise<void> } = {}) {
  const log: string[] = []
  let mode: RunningMode = options.mode ?? 'VIDEO'
  let numFaces = 2
  const tracker = {
    delegate,
    maxFaces: 2,
    blendshapes: true,
    get numFaces() {
      return numFaces
    },
    get runningMode() {
      return mode
    },
    detect(source: unknown, ts: number, mediaTime: number, out: FaceFrame) {
      log.push(`detect ${ts} ${source === input ? 'input' : 'canvas'}`)
      out.count = 1
      out.mediaTime = mediaTime
      out.width = 1
      out.height = 1
    },
    async detectImage(_s: unknown, mediaTime: number, out: FaceFrame) {
      log.push(`detectImage ${mediaTime}`)
      out.count = 1
    },
    async setRunningMode(m: RunningMode) {
      log.push(`mode ${m}`)
      mode = m
    },
    async resetState() {
      log.push('resetState')
    },
    async reconfigure(o: { numFaces?: number }) {
      log.push(`reconfigure ${o.numFaces}`)
      if (options.reconfigure) await options.reconfigure()
      numFaces = o.numFaces ?? numFaces
    },
    dispose() {
      log.push('dispose')
    },
  }
  return { tracker: tracker as FaceTracker, log }
}

function env(options: { backend?: string; stored?: unknown } = {}) {
  const warnings: string[] = []
  const causes: unknown[] = []
  let stored = options.stored
  const e: TrackerEnv = {
    assetsBaseUrl: 'https://cdn.test/ouaf/',
    warn: (m, cause) => {
      warnings.push(m)
      causes.push(cause)
    },
    ...(options.backend !== undefined ? { backend: options.backend } : {}),
    store: { get: () => stored, set: (v) => void (stored = v) },
  }
  return {
    env: e,
    warnings,
    causes,
    get stored() {
      return stored
    },
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  mocks.createFaceTracker.mockReset()
  mocks.openLiteRtTracker.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mediaPipeFaceTracker.create (spec §16.4)', () => {
  it('opens MediaPipe with the files under assetsBaseUrl, blendshapes always on', async () => {
    mocks.createFaceTracker.mockImplementation(async (o) => fakeMediaPipe(o.delegate!).tracker)
    const e = env()
    const t = await mediaPipeFaceTracker.create(CONFIG, e.env)
    const options = mocks.createFaceTracker.mock.calls[0]![0]
    expect(options).toMatchObject({
      maxFaces: 2,
      wasmBaseUrl: 'https://cdn.test/ouaf/mediapipe/wasm/',
      modelUrl: 'https://cdn.test/ouaf/models/face_landmarker.task',
      blendshapes: true,
      delegate: 'GPU',
    })
    // Its warnings go to the engine.
    options.onWarning!('slow')
    expect(e.warnings).toEqual(['slow'])
    // GPU first, the CPU to be measured against it on a live source.
    expect(t.backend).toEqual({ name: 'GPU', source: 'pending' })
    expect(t.description).toBe('MediaPipe GPU (pending), main thread')
    t.benchmark!()
    expect(t.measuring).toBe(true)
    expect(t.description).toBe('MediaPipe GPU (measuring CPU and GPU), main thread')
    await flush()
    expect(mocks.createFaceTracker.mock.calls.map((c) => c[0].delegate)).toEqual(['GPU', 'CPU'])
  })

  it('takes the backend forced by the host, in any case', async () => {
    mocks.createFaceTracker.mockImplementation(async (o) => fakeMediaPipe(o.delegate!).tracker)
    const t = await mediaPipeFaceTracker.create(CONFIG, env({ backend: 'cpu' }).env)
    expect(mocks.createFaceTracker.mock.calls[0]![0].delegate).toBe('CPU')
    expect(t.backend).toEqual({ name: 'CPU', source: 'forced' })
    expect(t.description).toBe('MediaPipe CPU (forced), main thread')
    t.benchmark!()
    expect(t.measuring).toBe(false)
  })

  it('warns about an unknown backend and measures instead', async () => {
    mocks.createFaceTracker.mockImplementation(async (o) => fakeMediaPipe(o.delegate!).tracker)
    const e = env({ backend: 'litert' })
    const t = await mediaPipeFaceTracker.create(CONFIG, e.env)
    expect(e.warnings).toEqual(['Unknown tracker backend "litert" (MediaPipe: CPU or GPU): choosing it by measuring.'])
    expect(t.backend).toEqual({ name: 'GPU', source: 'pending' })
  })

  it('starts on the cached delegate, with or without its measured times', async () => {
    mocks.createFaceTracker.mockImplementation(async (o) => fakeMediaPipe(o.delegate!).tracker)
    const ua = navigator.userAgent
    const t = await mediaPipeFaceTracker.create(CONFIG, env({ stored: { backend: 'CPU', measuredMs: { CPU: 9, GPU: 12 }, userAgent: ua, at: '' } }).env)
    expect(mocks.createFaceTracker.mock.calls[0]![0].delegate).toBe('CPU')
    expect(t.backend).toEqual({ name: 'CPU', source: 'cached', measuredMs: { CPU: 9, GPU: 12 } })
    expect(t.description).toBe('MediaPipe CPU (cached: CPU 9.0 ms, GPU 12.0 ms), main thread')
    const bare = await mediaPipeFaceTracker.create(CONFIG, env({ stored: { backend: 'GPU', userAgent: ua, at: '' } }).env)
    expect(bare.backend).toEqual({ name: 'GPU', source: 'cached' })
    expect(bare.description).toBe('MediaPipe GPU (cached), main thread')
  })

  it('without a GPU (MediaPipe fell back to the CPU) there is nothing to compare', async () => {
    mocks.createFaceTracker.mockImplementation(async () => fakeMediaPipe('CPU').tracker)
    const t = await mediaPipeFaceTracker.create(CONFIG, env().env)
    expect(t.backend).toEqual({ name: 'CPU', source: 'only' })
    // A cached GPU choice that now falls back to the CPU is not reported as cached either.
    const ua = navigator.userAgent
    const fell = await mediaPipeFaceTracker.create(CONFIG, env({ stored: { backend: 'GPU', userAgent: ua, at: '' } }).env)
    expect(fell.backend).toEqual({ name: 'CPU', source: 'only' })
  })
})

describe('MediaPipeFrameTracker', () => {
  const ENV = () => env().env

  it('defaults to the tracker delegate as the only backend', () => {
    const t = new MediaPipeFrameTracker(fakeMediaPipe('GPU').tracker, CONFIG, ENV())
    expect(t.backend).toEqual({ name: 'GPU', source: 'only' })
    expect(t.description).toBe('MediaPipe GPU (only), main thread')
    // Blendshapes are always computed: dropping them would gain nothing.
    expect(t.sheds).toEqual(['extraFaces', 'resolution'])
    t.benchmark() // nothing to measure
    expect(t.measuring).toBe(false)
  })

  it('switches back to VIDEO mode once after a still image, then tracks', async () => {
    const mp = fakeMediaPipe('GPU', { mode: 'IMAGE' })
    const t = new MediaPipeFrameTracker(mp.tracker, CONFIG, ENV())
    const out = createFaceFrame(2)
    const pending = t.track(input, 5, 0.1, out)
    expect(pending).toBeInstanceOf(Promise)
    await pending
    expect(mp.log).toEqual(['mode VIDEO', 'detect 5 input'])
    expect(t.track(input, 6, 0.2, out)).toBeUndefined() // synchronous from now on
    expect(out.mediaTime).toBe(0.2)
  })

  it('tracks still images and resets through the MediaPipe tracker', async () => {
    const mp = fakeMediaPipe('GPU')
    const t = new MediaPipeFrameTracker(mp.tracker, CONFIG, ENV())
    await t.trackImage(input, 3, createFaceFrame(2))
    await t.reset()
    expect(mp.log).toEqual(['detectImage 3', 'resetState'])
  })

  it('reconfigures the number of faces only when it changes; a track meanwhile waits for it', async () => {
    let release!: () => void
    const mp = fakeMediaPipe('GPU', { reconfigure: () => new Promise((resolve) => (release = resolve)) })
    const t = new MediaPipeFrameTracker(mp.tracker, CONFIG, ENV())
    t.configure({ ...CONFIG, blendshapes: true }) // same number of faces: nothing to rebuild
    expect(mp.log).toEqual([])
    t.configure({ ...CONFIG, maxFaces: 1 })
    await flush()
    expect(mp.log).toEqual(['reconfigure 1'])
    const tracked = t.track(input, 1, 0, createFaceFrame(2))
    expect(tracked).toBeInstanceOf(Promise)
    await flush()
    expect(mp.log).toEqual(['reconfigure 1'])
    release()
    await tracked
    expect(mp.log).toEqual(['reconfigure 1', 'mode VIDEO', 'detect 1 input'])
  })

  it('keeps the previous settings, with a warning, when reconfiguring fails', async () => {
    const cause = new Error('graph rebuild failed')
    const mp = fakeMediaPipe('GPU', { reconfigure: () => Promise.reject(cause) })
    const e = env()
    const t = new MediaPipeFrameTracker(mp.tracker, CONFIG, e.env)
    t.configure({ ...CONFIG, maxFaces: 1 })
    await vi.waitFor(() => expect(e.warnings).toEqual(['Could not reconfigure the face tracker; it keeps its previous settings.']))
    expect(e.causes).toEqual([cause])
    expect(mp.tracker.numFaces).toBe(2)
    // Settled: the next track is synchronous again.
    await flush()
    expect(t.track(input, 1, 0, createFaceFrame(2))).toBeUndefined()
  })

  it('analyses a smaller copy of the frame when the analysis scale is below 1 (spec §16.2)', () => {
    const draws: string[] = []
    class FakeOffscreenCanvas {
      width: number
      height: number
      constructor(w: number, h: number) {
        this.width = w
        this.height = h
      }
      getContext() {
        return { drawImage: (_i: unknown, x: number, y: number, w: number, h: number) => void draws.push(`${x} ${y} ${w} ${h}`) }
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    const mp = fakeMediaPipe('GPU')
    const t = new MediaPipeFrameTracker(mp.tracker, { ...CONFIG, analysisScale: 0.5 }, ENV())
    const out = createFaceFrame(2)
    t.track(input, 1, 0, out)
    expect(draws).toEqual(['0 0 320 240'])
    expect(mp.log).toEqual(['detect 1 canvas'])
    // Normalized landmarks: the result keeps the frame's size.
    expect([out.width, out.height]).toEqual([640, 480])
    // Another scale: the same canvas, resized.
    t.configure({ ...CONFIG, analysisScale: 0.25 })
    t.track(input, 2, 0, out)
    expect(draws.at(-1)).toBe('0 0 160 120')
    // A frame without pixels yet is given as it is.
    t.track({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement, 3, 0, out)
    expect(mp.log.at(-1)).toBe('detect 3 canvas')
  })

  it('tracks the full frame where there is no 2D canvas (no OffscreenCanvas, no document)', () => {
    const mp = fakeMediaPipe('GPU')
    const t = new MediaPipeFrameTracker(mp.tracker, { ...CONFIG, analysisScale: 0.5 }, ENV())
    const out = createFaceFrame(2)
    t.track(input, 1, 0, out)
    expect(mp.log).toEqual(['detect 1 input'])
    expect([out.width, out.height]).toEqual([1, 1]) // as the tracker wrote it
  })

  it('falls back to a document canvas without OffscreenCanvas, and to the full frame without a 2D context', () => {
    const created: string[] = []
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        created.push(tag)
        return { width: 0, height: 0, getContext: () => null }
      },
    })
    const mp = fakeMediaPipe('GPU')
    const t = new MediaPipeFrameTracker(mp.tracker, { ...CONFIG, analysisScale: 0.5 }, ENV())
    t.track(input, 1, 0, createFaceFrame(2))
    expect(created).toEqual(['canvas'])
    expect(mp.log).toEqual(['detect 1 input'])
  })

  it('keeps the GPU, with a warning, when the CPU delegate cannot be opened for the benchmark', async () => {
    const mp = fakeMediaPipe('GPU')
    const e = env()
    const cause = new Error('no wasm')
    const t = new MediaPipeFrameTracker(mp.tracker, CONFIG, e.env, { name: 'GPU', source: 'pending' }, () => Promise.reject(cause))
    t.benchmark()
    await flush()
    expect(t.measuring).toBe(false)
    expect(t.backend).toEqual({ name: 'GPU', source: 'only' })
    expect(e.warnings).toEqual(['Could not open the CPU face tracker to compare it with the GPU one; keeping the GPU.'])
    expect(e.causes).toEqual([cause])
    t.benchmark() // once only
    expect(t.measuring).toBe(false)
  })

  it('does not measure when the CPU delegate fell back to the same one', async () => {
    const mp = fakeMediaPipe('GPU')
    const other = fakeMediaPipe('GPU')
    const t = new MediaPipeFrameTracker(mp.tracker, CONFIG, ENV(), { name: 'GPU', source: 'pending' }, async () => other.tracker)
    t.benchmark()
    await flush()
    expect(t.measuring).toBe(false)
    expect(other.log).toEqual(['dispose'])
    t.track(input, 1, 0, createFaceFrame(2))
    expect(mp.log).toEqual(['detect 1 input'])
  })

  it('closes the CPU tracker that opens after dispose', async () => {
    let release!: (t: FaceTracker) => void
    const cpu = fakeMediaPipe('CPU')
    const mp = fakeMediaPipe('GPU')
    const t = new MediaPipeFrameTracker(mp.tracker, CONFIG, ENV(), { name: 'GPU', source: 'pending' }, () => new Promise((resolve) => (release = resolve)))
    t.benchmark()
    t.dispose()
    expect(mp.log).toEqual(['dispose'])
    release(cpu.tracker)
    await flush()
    expect(cpu.log).toEqual(['dispose'])
    t.benchmark() // disposed: nothing
  })

  it('applies a configuration given during the benchmark to the winner, and closes both trackers on dispose', async () => {
    const clock = { t: 0 }
    vi.spyOn(performance, 'now').mockImplementation(() => clock.t)
    const gpu = fakeMediaPipe('GPU')
    const cpu = fakeMediaPipe('CPU')
    const timed = (mp: ReturnType<typeof fakeMediaPipe>, ms: number) => {
      const detect = mp.tracker.detect.bind(mp.tracker)
      mp.tracker.detect = (...args) => {
        clock.t += ms
        detect(...args)
      }
    }
    timed(gpu, 30)
    timed(cpu, 10)
    const e = env()
    const t = new MediaPipeFrameTracker(gpu.tracker, CONFIG, e.env, { name: 'GPU', source: 'pending' }, async () => cpu.tracker)
    t.benchmark()
    await flush()
    t.configure({ ...CONFIG, maxFaces: 1 }) // deferred until the benchmark ends
    expect(gpu.log.concat(cpu.log).some((l) => l.startsWith('reconfigure'))).toBe(false)
    const out = createFaceFrame(2)
    for (let i = 0; i < 60 && t.measuring; i++) t.track(input, i, 0, out)
    expect(t.backend.name).toBe('CPU')
    expect(e.stored).toMatchObject({ backend: 'CPU' })
    await flush()
    expect(cpu.log).toContain('reconfigure 1')
    t.dispose()
    expect(cpu.log.at(-1)).toBe('dispose')
    vi.restoreAllMocks()
  })

  it('a still image aborts the benchmark, which can run again on a later live source', async () => {
    const gpu = fakeMediaPipe('GPU')
    const opened: FaceTracker[] = []
    const t = new MediaPipeFrameTracker(gpu.tracker, CONFIG, ENV(), { name: 'GPU', source: 'pending' }, async () => {
      const cpu = fakeMediaPipe('CPU').tracker
      opened.push(cpu)
      return cpu
    })
    t.benchmark()
    await flush()
    // Dispose with a benchmark running closes the other tracker too (checked below on the second run).
    await t.trackImage(input, 0, createFaceFrame(2))
    expect(t.measuring).toBe(false)
    expect(t.backend).toEqual({ name: 'GPU', source: 'pending' })
    t.benchmark()
    expect(t.measuring).toBe(true)
    await flush()
    expect(opened).toHaveLength(2)
    const disposed = vi.spyOn(opened[1]!, 'dispose')
    t.dispose()
    expect(disposed).toHaveBeenCalledOnce()
  })
})

describe('createDefaultFaceTracker (spec §16.4)', () => {
  it('chooses among MediaPipe GPU and CPU where no worker can run, opening each without fallback', async () => {
    mocks.createFaceTracker.mockImplementation(async (o) => fakeMediaPipe(o.delegate!).tracker)
    const impl = createDefaultFaceTracker()
    expect(impl.id).toBe('face')
    expect(impl.cost).toEqual({ typicalMs: 15 })
    const e = env()
    const t = await impl.create(CONFIG, e.env)
    expect(mocks.createFaceTracker.mock.calls[0]![0]).toMatchObject({ delegate: 'GPU', cpuFallback: false, blendshapes: true, maxFaces: 2 })
    expect(t.backend).toEqual({ name: 'GPU', source: 'pending' })
    expect(t.description).toBe('MediaPipe GPU, main thread (pending)')
    expect(mocks.openLiteRtTracker).not.toHaveBeenCalled()
    // Its own MediaPipe tracker does not measure: the chooser does.
    expect(mocks.createFaceTracker.mock.calls).toHaveLength(1)
    const forced = await impl.create(CONFIG, env({ backend: 'cpu' }).env)
    expect(forced.backend).toEqual({ name: 'CPU', source: 'forced' })
    const unknown = env({ backend: 'litert' })
    await impl.create(CONFIG, unknown.env)
    expect(unknown.warnings[0]).toBe('Unknown or unavailable face tracker backend "litert" (here: GPU, CPU); choosing it by measuring.')
  })

  it('starts on the LiteRT.js worker where it can run, with the given options', async () => {
    vi.stubGlobal('Worker', function Worker() {})
    vi.stubGlobal('OffscreenCanvas', function OffscreenCanvas() {})
    const lite: FrameTracker & { broken: boolean } = {
      description: 'LiteRT.js wasm, worker',
      broken: false,
      track: () => {},
      configure: () => {},
      dispose: () => {},
    }
    mocks.openLiteRtTracker.mockResolvedValue(lite)
    const liteRt = { transfer: false }
    const e = env()
    const t = await createDefaultFaceTracker({ liteRt } as never).create(CONFIG, e.env)
    expect(mocks.openLiteRtTracker).toHaveBeenCalledWith(CONFIG, e.env, liteRt)
    expect(t.backend).toEqual({ name: 'LiteRT', source: 'pending' })
    expect(t.description).toBe('LiteRT.js wasm, worker (pending)')
  })

  it('replaces the LiteRT.js tracker by MediaPipe when its worker dies', async () => {
    vi.stubGlobal('Worker', function Worker() {})
    vi.stubGlobal('OffscreenCanvas', function OffscreenCanvas() {})
    mocks.createFaceTracker.mockImplementation(async (o) => fakeMediaPipe(o.delegate!).tracker)
    const lite: FrameTracker & { broken: boolean } = {
      description: 'LiteRT.js',
      broken: false,
      track: () => Promise.reject(new Error('worker died')),
      configure: () => {},
      dispose: () => {},
    }
    mocks.openLiteRtTracker.mockResolvedValue(lite)
    const e = env({ backend: 'litert' })
    const t = await defaultFaceTracker.create(CONFIG, e.env)
    expect(t.backend).toEqual({ name: 'LiteRT', source: 'forced' })
    // Not broken: the error is the caller's.
    await expect(t.track(input, 1, 0, createFaceFrame(2))).rejects.toThrow('worker died')
    lite.broken = true
    await t.track(input, 2, 0, createFaceFrame(2))
    expect(t.backend).toEqual({ name: 'GPU', source: 'only' })
    expect(e.warnings).toEqual(['The LiteRT face tracker failed (worker died); switching to GPU.'])
  })
})

describe('built-in plugins', () => {
  it('the face plugin registers the default face tracker', () => {
    const registered: FaceTrackerImpl[] = []
    expect(facePlugin).toMatchObject({ name: 'face', version: '1.0.0', official: true })
    facePlugin.setup!({ registerTracker: (t: FaceTrackerImpl) => void registered.push(t) } as unknown as PluginApi)
    expect(registered).toEqual([defaultFaceTracker])
  })

  it('are the face tracker and the v1 layer types, in order', () => {
    const plugins = builtinPlugins()
    expect(plugins.map((p) => p.name)).toEqual(['face', 'text', 'sticker', 'model', 'warp', 'color', 'shader', 'canvas'])
    expect(builtinPlugins()).not.toBe(plugins) // a fresh list each time
  })
})
