import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendBenchmark, localBackendStore, readStoredBackend } from '../src/engine/backend-choice.ts'
import { MediaPipeFrameTracker } from '../src/engine/builtin.ts'
import { createFaceFrame, type FaceFrame, type FaceTracker } from '../src/face.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BackendBenchmark (spec §16.4)', () => {
  it('alternates the backends, skips the warm-up and keeps the lowest median', () => {
    const b = new BackendBenchmark(['GPU', 'CPU'], { warmup: 2, samples: 5 })
    const cost: Record<string, number[]> = { GPU: [500, 400, 130, 140, 128, 135, 600], CPU: [300, 70, 66, 68, 69, 67, 65] }
    const order: string[] = []
    while (!b.done) {
      const next = b.next
      order.push(next)
      b.add(next, cost[next]!.shift()!, true)
    }
    expect(order.slice(0, 4)).toEqual(['GPU', 'CPU', 'GPU', 'CPU'])
    // The 600 ms outlier of the GPU does not decide: medians.
    expect(b.medians).toEqual({ GPU: 135, CPU: 67 })
    expect(b.winner).toBe('CPU')
  })

  it('compares frames with a face when both backends have enough of them', () => {
    const b = new BackendBenchmark(['GPU', 'CPU'], { warmup: 0, samples: 4 })
    // Without a face only the detector runs: the CPU looks slower there, but with a face it is faster.
    for (const [name, ms, face] of [
      ['GPU', 10, false], ['CPU', 15, false], ['GPU', 40, true], ['CPU', 30, true],
      ['GPU', 41, true], ['CPU', 31, true], ['GPU', 10, false], ['CPU', 15, false],
    ] as const) b.add(name, ms, face)
    expect(b.medians).toEqual({ GPU: 40.5, CPU: 30.5 })
    expect(b.winner).toBe('CPU')
  })

  it('has no winner before every backend has its samples', () => {
    const b = new BackendBenchmark(['GPU', 'CPU'], { warmup: 0, samples: 2 })
    b.add('GPU', 1, true)
    b.add('GPU', 1, true)
    b.add('CPU', 2, true)
    expect(b.done).toBe(false)
    expect(b.winner).toBeUndefined()
    expect(b.next).toBe('CPU') // only the backend still short of samples
  })
})

describe('stored backend choice', () => {
  it('is used only for a known backend and the same browser', () => {
    const value = { backend: 'CPU', measuredMs: { CPU: 20, GPU: 60 }, userAgent: 'UA 1', at: '2026-11-23T00:00:00Z' }
    expect(readStoredBackend(value, ['GPU', 'CPU'], 'UA 1')).toEqual(value)
    expect(readStoredBackend(value, ['GPU', 'CPU'], 'UA 2')).toBeUndefined()
    expect(readStoredBackend({ ...value, backend: 'NPU' }, ['GPU', 'CPU'], 'UA 1')).toBeUndefined()
    expect(readStoredBackend('CPU', ['GPU', 'CPU'], 'UA 1')).toBeUndefined()
    expect(readStoredBackend(undefined, ['GPU', 'CPU'], 'UA 1')).toBeUndefined()
  })

  it('lives in localStorage as JSON, and is silent without storage', () => {
    const map = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) })
    const store = localBackendStore('ouaf:tracker-backend:1.0.0:mediapipe')
    expect(store.get()).toBeUndefined()
    store.set({ backend: 'GPU' })
    expect(map.get('ouaf:tracker-backend:1.0.0:mediapipe')).toBe('{"backend":"GPU"}')
    expect(store.get()).toEqual({ backend: 'GPU' })
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    expect(store.get()).toBeUndefined()
    expect(() => store.set({ backend: 'CPU' })).not.toThrow()
  })
})

describe('MediaPipeFrameTracker benchmark', () => {
  /** A fake MediaPipe tracker whose `detect` takes `ms` (by moving the mocked clock) and finds one face. */
  function fake(delegate: 'GPU' | 'CPU', ms: number, clock: { t: number }) {
    const calls: number[] = []
    const tracker = {
      delegate,
      maxFaces: 1,
      numFaces: 1,
      blendshapes: true,
      runningMode: 'VIDEO',
      detect(_s: unknown, ts: number, _m: number, out: FaceFrame) {
        calls.push(ts)
        clock.t += ms
        out.count = 1
      },
      detectImage: async () => {},
      setRunningMode: async () => {},
      resetState: async () => {},
      reconfigure: async () => {},
      disposed: 0,
      dispose() {
        this.disposed++
      },
    }
    return { tracker: tracker as unknown as FaceTracker & { disposed: number }, calls }
  }

  it('measures the other delegate on live frames, keeps the faster one and stores it', async () => {
    const clock = { t: 0 }
    vi.spyOn(performance, 'now').mockImplementation(() => clock.t)
    const gpu = fake('GPU', 60, clock)
    const cpu = fake('CPU', 20, clock)
    const stored: unknown[] = []
    const env = { assetsBaseUrl: '/', warn: () => {}, store: { get: () => undefined, set: (v: unknown) => void stored.push(v) } }
    const t = new MediaPipeFrameTracker(gpu.tracker, { maxFaces: 1, blendshapes: true, analysisScale: 1 }, env, { name: 'GPU', source: 'pending' }, async () => cpu.tracker)
    const input = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement
    const out = createFaceFrame(1)
    t.benchmark()
    expect(t.measuring).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    for (let i = 0; i < 40 && t.measuring; i++) t.track(input, i, i / 30, out)
    expect(t.measuring).toBe(false)
    expect(gpu.calls.length).toBe(15) // 3 warm-up + 12 samples each, in turns
    expect(cpu.calls.length).toBe(15)
    expect(t.backend).toEqual({ name: 'CPU', source: 'measured', measuredMs: { GPU: 60, CPU: 20 } })
    expect(t.description).toBe('MediaPipe CPU (measured: GPU 60.0 ms, CPU 20.0 ms), main thread')
    expect(gpu.tracker.disposed).toBe(1)
    expect(stored).toEqual([expect.objectContaining({ backend: 'CPU', measuredMs: { GPU: 60, CPU: 20 } })])
    // From now on, the CPU tracker only.
    t.track(input, 100, 4, out)
    expect(cpu.calls.at(-1)).toBe(100)
    vi.restoreAllMocks()
  })

  it('a file source stops the benchmark (results must not depend on timing)', async () => {
    const clock = { t: 0 }
    const gpu = fake('GPU', 60, clock)
    const cpu = fake('CPU', 20, clock)
    const env = { assetsBaseUrl: '/', warn: () => {} }
    const t = new MediaPipeFrameTracker(gpu.tracker, { maxFaces: 1, blendshapes: true, analysisScale: 1 }, env, { name: 'GPU', source: 'pending' }, async () => cpu.tracker)
    t.benchmark()
    await Promise.resolve()
    await Promise.resolve()
    await t.reset()
    expect(t.measuring).toBe(false)
    expect(cpu.tracker.disposed).toBe(1)
    t.track({ videoWidth: 1, videoHeight: 1 } as HTMLVideoElement, 1, 0, createFaceFrame(1))
    expect(gpu.calls).toEqual([1])
  })
})
