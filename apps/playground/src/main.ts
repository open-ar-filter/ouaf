import {
  CameraError,
  CameraSource,
  VideoFileSource,
  FrameScheduler,
  VERSION,
  createFaceFrame,
  createFrameSample,
  type FaceFrame,
  type FaceTracker,
  type FacingMode,
  type VideoSource,
} from '@ouaf/core'
import { createPerf, type PlaygroundPerf } from './perf.ts'
import { createRenderer, type PlaygroundRenderer } from './render.ts'
import { createTestHook } from './test-hook.ts'
import { createTracker } from './tracking.ts'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

const status = $<HTMLDListElement>('status')
const startButton = $<HTMLButtonElement>('start')
const flipButton = $<HTMLButtonElement>('flip')
const stopButton = $<HTMLButtonElement>('stop')
const stage = $<HTMLDivElement>('stage')
const perfContainer = $<HTMLDivElement>('perf')
const video = $<HTMLVideoElement>('video')

function row(label: string, value: string) {
  const dt = document.createElement('dt')
  dt.textContent = label
  const dd = document.createElement('dd')
  dd.textContent = value
  status.append(dt, dd)
  return dd
}

row('@ouaf/core', VERSION)
row('Secure context', window.isSecureContext ? 'yes' : 'no — camera unavailable, open the https:// URL')
const cameraRow = row('Camera', 'not started')
const trackRow = row('Track settings', '—')
const schedulerRow = row('Scheduler', '—')
const fpsRow = row('Processed frames', '—')

const params = new URLSearchParams(location.search)
/** `?maxFaces=N` (1–8, default 2) — multi-face cost spike (#8). */
const MAX_FACES = Math.min(8, Math.max(1, Math.trunc(Number(params.get('maxFaces'))) || 2))
row('maxFaces', String(MAX_FACES))
/** `?source=<clip>` plays `test-media/<clip>.mp4` instead of the camera (#77); `&mirror=1` mirrors it, `&loop=0` plays it once. */
const SOURCE = /^[\w-]+$/.test(params.get('source') ?? '') ? params.get('source') : null
/** `?autostart` starts without a tap (file sources only: iOS needs a gesture for the camera). */
const AUTOSTART = params.has('autostart') && SOURCE !== null
/** `?track=0` / `?render=0` turn tracking / WebGL rendering off, to find where the time goes. */
const TRACK = params.get('track') !== '0'
const RENDER = params.get('render') !== '0'
/** `?test` exposes counters on `window.ouafTest` for the browser tests. */
const testHook = params.has('test') ? createTestHook(video) : undefined

let camera: VideoSource | undefined
let scheduler: FrameScheduler | undefined
let tracker: FaceTracker | undefined
let renderer: PlaygroundRenderer | undefined
// Created once: the overlay and an ongoing recording survive camera switches and stops.
const perf: PlaygroundPerf | undefined = createPerf()
if (perf) perfContainer.append(perf.element)
let facingMode: FacingMode = 'user'
const faces: FaceFrame = createFaceFrame(MAX_FACES)
const sample = createFrameSample()

/** What the browser negotiated with the camera, to tell a camera limit from a scheduler problem. */
function describeTrack(stream: MediaStream): string {
  const track = stream.getVideoTracks()[0]
  if (!track) return 'no video track'
  const s = track.getSettings()
  const parts = [`${s.width}×${s.height} @ ${s.frameRate?.toFixed(1) ?? '?'} fps`]
  // getCapabilities is missing in Firefox.
  const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : undefined
  if (caps?.frameRate) parts.push(`frameRate ${caps.frameRate.min ?? '?'}–${caps.frameRate.max ?? '?'}`)
  if (caps?.width && caps.height) parts.push(`max ${caps.width.max}×${caps.height.max}`)
  return parts.join(', ')
}

function stop() {
  scheduler?.dispose()
  renderer?.dispose()
  camera?.dispose()
  scheduler = undefined
  renderer = undefined
  camera = undefined
  video.hidden = true
  flipButton.disabled = stopButton.disabled = true
  startButton.disabled = false
  cameraRow.textContent = 'stopped'
  fpsRow.textContent = '—'
}

async function start() {
  stop()
  startButton.disabled = true
  cameraRow.textContent = 'opening…'
  try {
    camera = SOURCE
      ? await VideoFileSource.open(new URL(`test-media/${SOURCE}.mp4`, document.baseURI).href, { video, mirror: params.get('mirror') === '1', loop: params.get('loop') !== '0' })
      : await CameraSource.open({ facingMode, video })
  } catch (err) {
    cameraRow.textContent = err instanceof CameraError ? `${err.code}: ${err.message}` : String(err)
    if (testHook) testHook.hook.error = cameraRow.textContent
    startButton.disabled = false
    return
  }
  // A file is held at its start until the pipeline is ready: loading the tracker can take longer than a short clip
  // lasts, and a clip played to its end before the scheduler starts gives no frame at all (#124).
  const file = camera instanceof VideoFileSource
  if (file) {
    video.pause()
    video.currentTime = 0
  }
  stopButton.disabled = false
  flipButton.disabled = file
  const mirror = camera.mirrored ? 'mirrored' : 'not mirrored'
  if (camera instanceof CameraSource) {
    cameraRow.textContent = `${camera.width}×${camera.height}, facing ${camera.facingMode ?? 'unknown'}, ${mirror}`
    trackRow.textContent = describeTrack(camera.stream)
  } else {
    cameraRow.textContent = `file test-media/${SOURCE}.mp4, ${camera.width}×${camera.height}, ${mirror}`
    trackRow.textContent = '—'
  }

  // The tracker survives camera switches; it is created once.
  if (TRACK) tracker ??= await createTracker({ maxFaces: MAX_FACES })
  if (testHook) testHook.hook.delegate = tracker?.delegate ?? null

  renderer = RENDER ? createRenderer(camera, { maxFaces: MAX_FACES }) : undefined
  // The <video> stays displayed, behind the canvas when there is a renderer: browsers throttle or pause the decoding
  // of hidden (display: none) muted videos, which slows a file source down to a few fps on phones.
  video.hidden = false
  video.classList.toggle('backing', renderer !== undefined)
  video.classList.toggle('mirrored', !renderer && camera.mirrored)
  if (renderer) stage.append(renderer.element)

  perf?.setInfo({
    delegate: tracker?.delegate,
    videoWidth: camera.width,
    videoHeight: camera.height,
    renderWidth: renderer?.width ?? camera.width,
    renderHeight: renderer?.height ?? camera.height,
    maxFaces: MAX_FACES,
  })

  // Per new camera frame: track → render → record. Only new frames are processed (FrameScheduler).
  let count = 0
  let since = performance.now()
  scheduler = new FrameScheduler(video, (frame) => {
    sample.now = frame.now
    sample.mediaTime = frame.mediaTime

    let t = performance.now()
    if (tracker) tracker.detect(video, frame.now, frame.mediaTime, faces)
    else faces.count = 0
    sample.trackingMs = performance.now() - t
    sample.faces = faces.count

    t = performance.now()
    renderer?.render(faces)
    sample.renderMs = performance.now() - t

    perf?.record(sample)
    testHook?.afterFrame(faces, frame.mediaTime, renderer?.canvas)

    count++
    if (frame.now - since >= 1000) {
      fpsRow.textContent = `${((count * 1000) / (frame.now - since)).toFixed(1)} fps (${frame.width}×${frame.height})`
      count = 0
      since = frame.now
    }
  })
  schedulerRow.textContent = scheduler.mode === 'video-frame' ? 'requestVideoFrameCallback' : 'requestAnimationFrame (fallback)'
  scheduler.start()
  if (file) {
    video.play().catch((err: unknown) => {
      cameraRow.textContent = `cannot play the file: ${err instanceof Error ? err.message : String(err)}`
      if (testHook) testHook.hook.error = cameraRow.textContent
    })
  }
}

startButton.addEventListener('click', () => void start())
if (AUTOSTART) void start()
stopButton.addEventListener('click', stop)
flipButton.addEventListener('click', () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user'
  void start()
})
