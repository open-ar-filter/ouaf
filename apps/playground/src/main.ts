import { VERSION } from '@ouaf/core'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

const status = $<HTMLDListElement>('status')
const button = $<HTMLButtonElement>('camera')
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
const camera = row('Camera', 'not started')

// Smoke test that the camera is reachable from this origin; the real camera source lives in @ouaf/core.
button.addEventListener('click', async () => {
  button.disabled = true
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
    video.srcObject = stream
    video.hidden = false
    await video.play()
    camera.textContent = `${video.videoWidth}×${video.videoHeight}`
  } catch (err) {
    camera.textContent = `error: ${err instanceof Error ? err.message : String(err)}`
    button.disabled = false
  }
})
