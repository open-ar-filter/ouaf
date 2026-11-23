import type { FaceLandmarkerOptions } from '@mediapipe/tasks-vision'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFaceFrame, type FaceFrame, type FaceTracker } from '../src/face.ts'
import { createFaceTrackerWith, type Landmarker, type LandmarkerBackend } from '../src/face-tracker.ts'
import { MediaPipeFrameTracker } from '../src/engine/builtin.ts'
import type { FaceTrackerImpl, FrameTracker, TrackerConfig } from '../src/engine/plugin.ts'
import { throttledMs, throttleTracker } from '../src/engine/throttle.ts'
import { TrackingHub } from '../src/engine/tracking.ts'

const env = { assetsBaseUrl: '/', warn: () => {} }
const input = { videoWidth: 640, videoHeight: 480 } as HTMLVideoElement
const FULL: TrackerConfig = { maxFaces: 4, blendshapes: true, analysisScale: 1 }

afterEach(() => {
  vi.useRealTimers()
})

describe('TrackingHub: tracking rate and configuration (spec §16.1, §16.2)', () => {
  function syncHub(maxFaces = 4) {
    const configs: TrackerConfig[] = []
    const tracker: FrameTracker = {
      description: 'sync',
      track: (_i, _t, mediaTime, out) => {
        out.count = 1
        out.mediaTime = mediaTime
      },
      configure: (c) => void configs.push({ ...c }),
      dispose: () => {},
    }
    const created: TrackerConfig[] = []
    const impl: FaceTrackerImpl = { id: 'sync', create: async (c) => (created.push({ ...c }), tracker) }
    const hub = new TrackingHub({ impl, env, maxFaces, modifiers: [], onError: () => {} })
    return { hub, configs, created }
  }

  it('measures completed results per second, and restarts the window on demand', async () => {
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const { hub } = syncHub()
    await hub.setNeeds({ face: true, blendshapes: true })
    // 20 Hz for 2 s (a synchronous tracker completes at the submit).
    for (; clock <= 2000; clock += 50) hub.submit(input, clock, clock / 1000)
    expect(hub.rateHz).toBeCloseTo(20, 1)
    hub.restartRate(clock)
    expect(hub.rateHz).toBe(0)
    // Then 10 Hz: the restarted window only sees the new rate.
    for (const end = clock + 1000; clock <= end; clock += 100) hub.submit(input, clock, clock / 1000)
    expect(hub.rateHz).toBeCloseTo(10, 1)
    now.mockRestore()
  })

  it('measures the rate and pipeline time of the results with faces apart (no face: detector only, faster)', async () => {
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    let faces = 1
    let cost = 0
    const tracker: FrameTracker = {
      description: 'sync',
      track: (_i, _t, mediaTime, out) => {
        clock += cost // the call takes `cost` ms
        out.count = faces
        out.mediaTime = mediaTime
      },
      configure: () => {},
      dispose: () => {},
    }
    const hub = new TrackingHub({ impl: { id: 'sync', create: async () => tracker }, env, maxFaces: 1, modifiers: [], onError: () => {} })
    await hub.setNeeds({ face: true, blendshapes: true })
    // 1 s at 10 Hz with a face (80 ms per result), then 1 s at 30 Hz without (10 ms per result).
    for (let end = clock + 1000; clock < end; clock += 100 - 80) {
      cost = 80
      hub.submit(input, clock, clock / 1000)
    }
    faces = 0
    for (let end = clock + 1000; clock < end; clock += 33 - 10) {
      cost = 10
      hub.submit(input, clock, clock / 1000)
    }
    hub.submit(input, clock, clock / 1000) // the window ends at the last submit
    const out = new Float64Array(2)
    hub.rateWithFaces(1, out)
    expect(out[0]).toBeCloseTo(10, 0)
    expect(out[1]).toBeCloseTo(80, 0)
    expect(hub.rateHz).toBeGreaterThan(18) // all results: mostly the fast ones
    hub.rateWithFaces(2, out)
    expect(out[0]).toBeNaN()
    now.mockRestore()
  })

  it('passes the faces, blendshapes and analysis resolution to the tracker, clamped', async () => {
    const { hub, configs, created } = syncHub(4)
    await hub.setNeeds({ face: true, blendshapes: true })
    expect(created).toEqual([FULL])
    await hub.setNeeds({ face: true, blendshapes: false, maxFaces: 2, analysisScale: 0.5 })
    await hub.setNeeds({ face: true, blendshapes: false, maxFaces: 2, analysisScale: 0.5 }) // unchanged: not passed again
    await hub.setNeeds({ face: true, blendshapes: true, maxFaces: 9, analysisScale: 3 })
    expect(configs).toEqual([
      { maxFaces: 2, blendshapes: false, analysisScale: 0.5 },
      FULL,
    ])
    expect(hub.config).toEqual(FULL)
  })
})

describe('MediaPipe tracker: reconfiguration (spec §16.2)', () => {
  function backend() {
    const setOptions: FaceLandmarkerOptions[] = []
    const detected: unknown[] = []
    let release: (() => void) | undefined
    const landmarker: Landmarker = {
      detectForVideo(frame) {
        detected.push(frame)
        return { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] }
      },
      detect: () => ({ faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] }),
      setOptions: (o) => {
        setOptions.push(o)
        return new Promise<void>((resolve) => (release = resolve))
      },
      close: () => {},
    }
    const b: LandmarkerBackend = { loadModel: async () => new Uint8Array(1), createLandmarker: async () => landmarker, warmupFrame: () => ({}) as TexImageSource }
    return { b, setOptions, detected, release: () => release?.() }
  }

  it('changes numFaces and blendshapes with setOptions, keeping the running mode, within its capacity', async () => {
    const { b, setOptions, release } = backend()
    const tracker = await createFaceTrackerWith({ wasmBaseUrl: '/', modelUrl: '/m', maxFaces: 3 }, b)
    expect([tracker.numFaces, tracker.blendshapes]).toEqual([3, true])
    const done = tracker.reconfigure({ numFaces: 1, blendshapes: false })
    await Promise.resolve()
    release()
    await done
    expect(setOptions).toEqual([{ numFaces: 1, outputFaceBlendshapes: false, runningMode: 'VIDEO' }])
    expect([tracker.numFaces, tracker.blendshapes]).toEqual([1, false])
    const again = tracker.reconfigure({ numFaces: 8 })
    await Promise.resolve()
    release()
    await again
    expect(tracker.numFaces).toBe(3)
    await tracker.reconfigure({ numFaces: 3 }) // no change: no setOptions
    expect(setOptions).toHaveLength(2)
  })

  it('FrameTracker: changes the number of faces; a track during the reconfiguration waits for it', async () => {
    const { b, detected, release } = backend()
    const tracker: FaceTracker = await createFaceTrackerWith({ wasmBaseUrl: '/', modelUrl: '/m', maxFaces: 2 }, b)
    const frameTracker = new MediaPipeFrameTracker(tracker, { maxFaces: 2, blendshapes: true, analysisScale: 1 }, env)
    const out = createFaceFrame(2)
    detected.length = 0
    expect(frameTracker.track(input, 10, 0.01, out)).toBeUndefined() // synchronous
    expect(detected).toHaveLength(1)
    frameTracker.configure({ maxFaces: 1, blendshapes: false, analysisScale: 1 })
    const pending = frameTracker.track(input, 20, 0.02, out)
    expect(pending).toBeInstanceOf(Promise)
    await Promise.resolve()
    expect(detected).toHaveLength(1)
    release()
    await pending
    expect(detected).toHaveLength(2)
    // Only the number of faces: MediaPipe keeps computing blendshapes (a graph rebuild for no gain), the engine ignores them.
    expect([tracker.numFaces, tracker.blendshapes]).toEqual([1, true])
  })
})

describe('throttleTracker (simulated slow tracking)', () => {
  it('saves the share of each dropped capability', () => {
    const t = { ms: 100 }
    expect(throttledMs(t, FULL, 4)).toBe(100)
    expect(throttledMs(t, { ...FULL, blendshapes: false }, 4)).toBe(85)
    expect(throttledMs(t, { ...FULL, maxFaces: 1 }, 4)).toBe(80)
    expect(throttledMs(t, { ...FULL, maxFaces: 1 }, 1)).toBe(100) // one face: nothing to save
    expect(throttledMs(t, { maxFaces: 1, blendshapes: false, analysisScale: 0.5 }, 4)).toBeCloseTo(40)
    expect(throttledMs({ ms: 100, shares: { resolution: 0.5 } }, { ...FULL, analysisScale: 0.5 }, 4)).toBe(50)
    expect(throttledMs({ ms: 0 }, FULL, 4)).toBe(0)
  })

  it('holds each result back until the simulated time, and passes the configuration through', async () => {
    vi.useFakeTimers()
    const configs: TrackerConfig[] = []
    let calls = 0
    const inner: FrameTracker = {
      description: 'inner',
      track: (_i, _t, mediaTime, out: FaceFrame) => {
        calls++
        out.mediaTime = mediaTime
      },
      configure: (c) => void configs.push(c),
      dispose: () => {},
    }
    const throttle = { ms: 80 }
    const tracker = await throttleTracker({ id: 'inner', create: async () => inner }, throttle).create(FULL, env)
    expect(tracker.description).toBe('inner, throttled to 80 ms')
    const out = createFaceFrame(4)
    let done = false
    void Promise.resolve(tracker.track(input, 0, 1, out)).then(() => (done = true))
    expect(calls).toBe(1) // the real tracker ran at once
    await vi.advanceTimersByTimeAsync(70)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    expect(done).toBe(true)
    tracker.configure({ ...FULL, blendshapes: false })
    expect(configs).toHaveLength(1)
    expect(tracker.description).toBe('inner, throttled to 68 ms')
    throttle.ms = 0
    expect(tracker.track(input, 1, 2, out)).toBeUndefined() // off: the inner tracker's own result
  })
})
