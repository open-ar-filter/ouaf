import { blendshapeIndex, createFaceTracker, type Delegate, type FaceFrame, type FaceTracker } from '@ouaf/core'

/** Self-hosted assets, served by the `ouaf-self-hosted-assets` plugin (vite.config.ts). */
const WASM_BASE_URL = 'mediapipe/wasm/'
const MODEL_URL = 'models/face_landmarker.task'

const JAW_OPEN = blendshapeIndex('jawOpen')
/** Refresh period of the "Faces" status row (ms). */
const STATUS_PERIOD_MS = 250

let statusRow: HTMLElement | undefined

/** "Faces" row of the playground status list, created on first use. */
function facesRow(): HTMLElement {
  if (statusRow) return statusRow
  const dt = document.createElement('dt')
  dt.textContent = 'Faces'
  statusRow = document.createElement('dd')
  document.getElementById('status')?.append(dt, statusRow)
  return statusRow
}

/** `?delegate=CPU` forces the CPU delegate (to compare with GPU); default: GPU with automatic CPU fallback. */
export function requestedDelegate(): Delegate {
  return new URLSearchParams(location.search).get('delegate')?.toUpperCase() === 'CPU' ? 'CPU' : 'GPU'
}

/**
 * Creates the MediaPipe face tracker used by the playground, or `undefined` when it cannot be initialized (the
 * reason is shown in the "Faces" row). The returned tracker also refreshes that row with the face count and the
 * `jawOpen` score of face 0, so tracking can be checked without a renderer.
 */
export async function createTracker({ maxFaces }: { maxFaces: number }): Promise<FaceTracker | undefined> {
  const row = facesRow()
  row.textContent = 'loading the face tracker…'
  let tracker: FaceTracker
  try {
    tracker = await createFaceTracker({
      maxFaces,
      delegate: requestedDelegate(),
      // `?blendshapes=0` skips the blendshapes model (measures its cost; `jawOpen` then reads 0).
      blendshapes: new URLSearchParams(location.search).get('blendshapes') !== '0',
      wasmBaseUrl: new URL(WASM_BASE_URL, document.baseURI).href,
      modelUrl: new URL(MODEL_URL, document.baseURI).href,
    })
  } catch (err) {
    console.error('[playground] face tracker initialization failed:', err)
    const hint = /face model/.test(String(err)) ? ' — run `npm run fetch-models`' : ''
    row.textContent = `unavailable: ${err instanceof Error ? err.message : String(err)}${hint}`
    return undefined
  }
  row.textContent = `ready (${tracker.delegate})`
  return withStatus(tracker, row)
}

function withStatus(tracker: FaceTracker, row: HTMLElement): FaceTracker {
  let shownAt = -Infinity
  return {
    get delegate() {
      return tracker.delegate
    },
    maxFaces: tracker.maxFaces,
    detect(video: HTMLVideoElement, timestampMs: number, mediaTime: number, out: FaceFrame) {
      tracker.detect(video, timestampMs, mediaTime, out)
      if (timestampMs - shownAt < STATUS_PERIOD_MS && timestampMs >= shownAt) return
      shownAt = timestampMs
      // Debug display only: the string is rebuilt a few times per second, not every frame.
      row.textContent =
        out.count > 0
          ? `${out.count} (${tracker.delegate}), jawOpen ${(out.blendshapes[JAW_OPEN] ?? 0).toFixed(2)}`
          : `0 (${tracker.delegate})`
    },
    detectImage: (source, mediaTime, out) => tracker.detectImage(source, mediaTime, out),
    get runningMode() {
      return tracker.runningMode
    },
    setRunningMode: (mode) => tracker.setRunningMode(mode),
    resetState: () => tracker.resetState(),
    get numFaces() {
      return tracker.numFaces
    },
    get blendshapes() {
      return tracker.blendshapes
    },
    reconfigure: (options) => tracker.reconfigure(options),
    dispose() {
      tracker.dispose()
    },
  }
}
