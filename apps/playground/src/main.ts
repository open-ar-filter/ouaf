import { CameraError, CameraSource, FrameScheduler, VERSION, type FacingMode } from '@ouaf/core'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

const status = $<HTMLDListElement>('status')
const startButton = $<HTMLButtonElement>('start')
const flipButton = $<HTMLButtonElement>('flip')
const stopButton = $<HTMLButtonElement>('stop')
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

let camera: CameraSource | undefined
let scheduler: FrameScheduler | undefined
let facingMode: FacingMode = 'user'

function stop() {
  scheduler?.dispose()
  camera?.dispose()
  scheduler = undefined
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
  video.hidden = false
  video.classList.toggle('mirrored', camera.mirrored)
  flipButton.disabled = stopButton.disabled = false
  cameraRow.textContent = `${camera.width}×${camera.height}, facing ${camera.facingMode ?? 'unknown'}, ${camera.mirrored ? 'mirrored' : 'not mirrored'}`
  trackRow.textContent = describeTrack(camera.stream)

  // Count the frames the engine would process: only new camera frames, independent of the display refresh rate.
  let count = 0
  let since = performance.now()
  scheduler = new FrameScheduler(video, (frame) => {
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

startButton.addEventListener('click', () => void start())
stopButton.addEventListener('click', stop)
flipButton.addEventListener('click', () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user'
  void start()
})
