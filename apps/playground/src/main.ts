import {
  CameraError,
  CameraSource,
  FrameScheduler,
  VERSION,
  createFaceFrame,
  createFrameSample,
  type FaceFrame,
  type FaceTracker,
  type FacingMode,
} from '@ouaf/core'
import { createPerf, type PlaygroundPerf } from './perf.ts'
import { createRenderer, type PlaygroundRenderer } from './render.ts'
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

const MAX_FACES = 2

let camera: CameraSource | undefined
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
    camera = await CameraSource.open({ facingMode, video })
  } catch (err) {
    cameraRow.textContent = err instanceof CameraError ? `${err.code}: ${err.message}` : String(err)
    startButton.disabled = false
    return
  }
  flipButton.disabled = stopButton.disabled = false
  cameraRow.textContent = `${camera.width}×${camera.height}, facing ${camera.facingMode ?? 'unknown'}, ${camera.mirrored ? 'mirrored' : 'not mirrored'}`
  trackRow.textContent = describeTrack(camera.stream)

  // The tracker survives camera switches; it is created once.
  tracker ??= await createTracker({ maxFaces: MAX_FACES })

  renderer = createRenderer(camera, { maxFaces: MAX_FACES })
  if (renderer) stage.append(renderer.element)
  else {
    video.hidden = false
    video.classList.toggle('mirrored', camera.mirrored)
  }

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

    count++
    if (frame.now - since >= 1000) {
      fpsRow.textContent = `${((count * 1000) / (frame.now - since)).toFixed(1)} fps (${frame.width}×${frame.height})`
      count = 0
      since = frame.now
    }
  })
  schedulerRow.textContent = scheduler.mode === 'video-frame' ? 'requestVideoFrameCallback' : 'requestAnimationFrame (fallback)'
  scheduler.start()
}

startButton.addEventListener('click', () => void start())
stopButton.addEventListener('click', stop)
flipButton.addEventListener('click', () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user'
  void start()
})
