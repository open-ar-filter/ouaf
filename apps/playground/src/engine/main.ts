/**
 * Engine page (`/engine.html`): drives `@ouaf/core`'s public API, the way a host would. Used by the browser tests
 * (`window.ouaf`) and by the layer-type work as a harness, until the playground app (#36) is rebuilt on the engine.
 */
import { CameraSource, VideoFileSource, createEngine, memorySource, type Engine, type EngineStats, type VideoSource } from '@ouaf/core'
import * as core from '@ouaf/core'
import { playgroundPlugin } from './test-plugin.ts'

declare global {
  interface Window {
    /** Test hook: the engine, the `@ouaf/core` module and what the engine reported. */
    ouaf?: {
      engine: Engine
      core: typeof core
      memorySource: typeof memorySource
      stats: EngineStats | undefined
      frames: number
      warnings: string[]
      errors: string[]
    }
  }
}

const params = new URLSearchParams(location.search)
const SOURCE = /^[\w-]+$/.test(params.get('source') ?? '') ? params.get('source') : null
const FILTERS = params.getAll('filter')
const MAX_FACES = Math.min(16, Math.max(1, Math.trunc(Number(params.get('maxFaces'))) || 1))
const canvas = document.getElementById('canvas') as HTMLCanvasElement
const video = document.getElementById('video') as HTMLVideoElement
const log = document.getElementById('log') as HTMLPreElement
const startButton = document.getElementById('start') as HTMLButtonElement

const engine = createEngine({ canvas, assetsBaseUrl: new URL('./', document.baseURI).href, maxFaces: MAX_FACES, plugins: [playgroundPlugin] })
const hook = { engine, core, memorySource, stats: undefined as EngineStats | undefined, frames: 0, warnings: [] as string[], errors: [] as string[] }
window.ouaf = hook

const lines = new Map<string, string>()
const show = (key: string, value: string) => {
  lines.set(key, value)
  log.textContent = [...lines].map(([k, v]) => `${k}: ${v}`).join('\n')
}
engine.on('stats', (s) => {
  hook.stats = s
  hook.frames += Math.round(s.fps)
  show('stats', `${s.fps.toFixed(1)} fps, tracking ${s.trackingHz.toFixed(1)} Hz, ${s.faces} face(s), ${s.frameMs.toFixed(2)} ms/frame, ${s.width}×${s.height}, ${s.tracker ?? 'no tracker'}`)
})
engine.on('warning', (w) => {
  hook.warnings.push(w.message)
  show(`warning ${hook.warnings.length}`, w.message)
})
engine.on('error', (e) => {
  hook.errors.push(e.message)
  show(`error ${hook.errors.length}`, e.message)
})
show('plugins', [...engine.plugins].map(([n, v]) => `${n}@${v}`).join(', '))

async function start(): Promise<void> {
  startButton.disabled = true
  let source: VideoSource
  try {
    source = SOURCE
      ? await VideoFileSource.open(new URL(`test-media/${SOURCE}.mp4`, document.baseURI).href, { video, mirror: params.get('mirror') === '1' })
      : await CameraSource.open({ facingMode: 'user', video })
    await engine.setSource(source)
    show('source', SOURCE ? `test-media/${SOURCE}.mp4` : 'camera')
    for (const url of FILTERS) {
      const handle = await engine.addFilter(url)
      show(`filter ${handle.index}`, `${handle.id} (${url})${handle.warnings.length ? ` — ${handle.warnings.join('; ')}` : ''}`)
    }
  } catch (error) {
    hook.errors.push(String(error))
    show('error', error instanceof Error ? error.message : String(error))
    startButton.disabled = false
  }
}

startButton.addEventListener('click', () => void start())
if (params.has('autostart') && SOURCE) void start()
