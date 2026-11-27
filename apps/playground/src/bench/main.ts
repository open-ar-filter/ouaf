/// <reference types="vite/client" />
/**
 * Benchmark page (`/bench.html`, #39): renders each case (the baselines and stacks of `filters/bench.json`, every demo
 * of `filters/demos.json` on its clip, or the stack of the URL) frame by frame on its test clip, as fast as the device
 * can, and reports the time per frame (mean, p50, p95, p99, max) and the frames per second it allows. The results
 * download as an `ouaf-bench` document (`docs/perf/bench-format.md`) or copy as a Markdown table, and compare with an
 * earlier document. Nothing leaves the device unless the person downloads or copies it.
 *
 * Each frame is decoded first (`OfflineVideoSource`), then timed from `engine.pushFrame` (tracking and rendering,
 * spec §12.1 file regime) to a one-pixel `readPixels`, which waits for the GPU to finish it. Device adaptation is off,
 * so every case does the same work on every device. Scripts run in their Worker meanwhile, not on the timed path.
 */
import { collectDeviceInfo, createEngine, OfflineVideoSource, VERSION, type Engine, type EngineStats } from '@ouaf/core'
import { loadDemos } from '../engine/demos.ts'
import { playgroundPlugin } from '../engine/test-plugin.ts'
import { BENCH_FORMAT, BENCH_VERSION, caseResult, change, markdown, parseReport, percent, type BenchCase, type BenchReport, type CaseResult } from './report.ts'

declare const __OUAF_COMMIT__: string

declare global {
  interface Window {
    /** Test hook: the last report (partial while running) and whether a run is going on. */
    ouafBench?: { report: BenchReport | undefined; running: boolean }
  }
}

const params = new URLSearchParams(location.search)
const int = (name: string, fallback: number, min: number) => Math.max(min, Math.trunc(Number(params.get(name))) || fallback)
const BACKEND = params.get('backend')
const casesBox = document.getElementById('cases') as HTMLElement
const framesInput = document.getElementById('frames') as HTMLInputElement
const warmupInput = document.getElementById('warmup') as HTMLInputElement
const runButton = document.getElementById('run') as HTMLButtonElement
const stopButton = document.getElementById('stop') as HTMLButtonElement
const status = document.getElementById('status') as HTMLElement
const stage = document.getElementById('stage') as HTMLElement
const table = document.getElementById('results') as HTMLTableElement
const compareInput = document.getElementById('compare') as HTMLInputElement
const output = document.getElementById('output') as HTMLTextAreaElement
framesInput.value = String(int('frames', 300, 1))
warmupInput.value = String(int('warmup', 30, 0))

const hook: NonNullable<Window['ouafBench']> = { report: undefined, running: false }
window.ouafBench = hook
let previous: BenchReport | undefined
let stopped = false

async function loadCases(): Promise<BenchCase[]> {
  const response = await fetch(new URL('filters/bench.json', document.baseURI))
  if (!response.ok) throw new Error(`filters/bench.json: HTTP ${response.status}`)
  const bench = (await response.json()) as { baselines: BenchCase[]; stacks: BenchCase[] }
  const demos = (await loadDemos()).map((d) => ({ name: d.id, clip: d.clip, maxFaces: d.maxFaces, filters: [`/filters/${d.id}/`] }))
  const cases = [...bench.baselines, ...demos, ...bench.stacks]
  // `?filter=<url>` (repeatable) `&source=<clip>` `&maxFaces=N`: a stack of one's own, e.g. from the engine page.
  const own = params.getAll('filter')
  if (own.length > 0) {
    cases.unshift({ name: `this stack: ${own.join(' + ')}`, clip: params.get('source') ?? 'pesquet-talk', maxFaces: int('maxFaces', 1, 1), filters: own })
  }
  return cases
}

function renderCases(cases: readonly BenchCase[]): void {
  const picked = new Set(params.getAll('case'))
  casesBox.replaceChildren(
    ...cases.map((c) => {
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: picked.size === 0 || picked.has(c.name), value: c.name })
      const label = document.createElement('label')
      const detail = Object.assign(document.createElement('small'), { textContent: ` ${c.clip}${c.maxFaces > 1 ? `, ${c.maxFaces} faces` : ''}` })
      label.append(box, ` ${c.name}`, detail)
      return label
    }),
  )
}

/** Renders `c` frame by frame and times each frame. */
/** The longest a warm-up waits for the first face of a stack that tracks faces (ms). */
const FIRST_FACE_MS = 15_000

async function measure(c: BenchCase, warmup: number, frames: number, progress: (done: number, warming: number) => void): Promise<CaseResult> {
  const canvas = document.createElement('canvas')
  stage.replaceChildren(canvas)
  const errors: string[] = []
  const warnings: string[] = []
  let stats: EngineStats | undefined
  let engine: Engine | undefined
  let source: OfflineVideoSource | undefined
  const times: number[] = []
  const faces: number[] = []
  try {
    engine = createEngine({
      canvas,
      assetsBaseUrl: new URL('./', document.baseURI).href,
      maxFaces: c.maxFaces,
      // The fixtures may use the playground's layer types.
      plugins: [playgroundPlugin],
      adaptation: false,
      seed: 1,
      ...(BACKEND ? { trackerBackend: BACKEND } : {}),
    })
    engine.on('error', (e) => errors.push(e.message))
    engine.on('warning', (w) => warnings.push(w.message))
    engine.on('stats', (s) => (stats = s))
    if (c.filters.length > 0) await engine.setFilters(c.filters)
    source = await OfflineVideoSource.open(new URL(`test-media/${c.clip}.mp4`, document.baseURI).href)
    const gl = canvas.getContext('webgl2')
    const pixel = new Uint8Array(4)
    // A tracker finds its first faces a moment after it starts (its detector warms up): until then, still a warm-up.
    const tracks = engine.filters.some((f) => f.manifest.requires?.face)
    const since = performance.now()
    let warming = warmup
    // Looping over the clip: the media time keeps increasing, so tracking goes on (spec §12.1).
    let offset = 0
    for (let i = 0; i < warming + frames && !stopped; ) {
      const frame = await source.read()
      if (!frame) {
        offset += source.duration
        source.restart()
        continue
      }
      const start = performance.now()
      await engine.pushFrame(frame.image, offset + frame.time)
      gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      const ms = performance.now() - start
      frame.close()
      if (i === warming - 1 && tracks && engine.faceCount === 0 && performance.now() - since < FIRST_FACE_MS) warming++
      else if (i >= warming) {
        times.push(ms)
        faces.push(engine.faceCount)
      }
      i++
      if (i % 10 === 0) progress(i, warming)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  } finally {
    source?.dispose()
    engine?.dispose()
  }
  const s = stats as EngineStats | undefined
  // A short case may end before the engine's first stats (one per second): the canvas has the same size.
  const size = s ? `${s.width}×${s.height}` : canvas.width > 0 ? `${canvas.width}×${canvas.height}` : null
  return caseResult(c, times, faces, { size, tracker: s?.tracker ?? null, errors, warnings: [...new Set(warnings)] })
}

const cell = (text: string, className = '') => Object.assign(document.createElement('td'), { textContent: text, className })

function renderResults(report: BenchReport): void {
  const before = new Map(previous?.results.map((r) => [r.name, r]))
  const head = document.createElement('tr')
  for (const h of ['Case', 'Faces', 'Mean ms', 'p50', 'p95', 'p99', 'Max', 'fps', ...(previous ? ['fps change', 'p95 change'] : [])]) {
    head.append(Object.assign(document.createElement('th'), { textContent: h }))
  }
  const rows = report.results.map((r) => {
    const tr = document.createElement('tr')
    const name = cell(r.name)
    const notes = [...r.errors, ...r.warnings]
    if (notes.length) {
      name.append(Object.assign(document.createElement('small'), { textContent: notes.join('; '), className: r.errors.length ? 'error' : '' }))
    }
    const f = (n: number | undefined) => (n === undefined ? '–' : n.toFixed(1))
    tr.append(name, cell(r.faces.toFixed(1)), cell(f(r.frameMs?.mean)), cell(f(r.frameMs?.p50)), cell(f(r.frameMs?.p95)), cell(f(r.frameMs?.p99)), cell(f(r.frameMs?.max)), cell(r.fps === null ? '–' : r.fps.toFixed(0)))
    if (previous) {
      const b = before.get(r.name)
      const fps = change(r.fps, b?.fps)
      const p95 = change(r.frameMs?.p95, b?.frameMs?.p95)
      // Better is more fps, less p95.
      tr.append(cell(percent(fps), fps === null ? '' : fps >= 0 ? 'better' : 'worse'), cell(percent(p95), p95 === null ? '' : p95 <= 0 ? 'better' : 'worse'))
    }
    return tr
  })
  table.replaceChildren(head, ...rows)
  output.value = markdown(report, previous)
}

async function run(): Promise<void> {
  const names = new Set([...casesBox.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value))
  const cases = (await loadCases()).filter((c) => names.has(c.name))
  const warmup = Math.max(0, Math.trunc(Number(warmupInput.value)) || 0)
  const frames = Math.max(1, Math.trunc(Number(framesInput.value)) || 1)
  stopped = false
  hook.running = true
  runButton.disabled = true
  stopButton.disabled = false
  // Phones dim and lock the screen during a long run.
  const lock = await navigator.wakeLock?.request('screen').catch(() => undefined)
  const started = performance.now()
  const report: BenchReport = {
    format: BENCH_FORMAT,
    version: BENCH_VERSION,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    app: { name: 'ouaf-bench-page', core: VERSION, commit: __OUAF_COMMIT__ },
    device: await collectDeviceInfo().catch(() => null),
    settings: { warmup, frames, backend: BACKEND },
    results: [],
  }
  hook.report = report
  try {
    for (const [i, c] of cases.entries()) {
      if (stopped) break
      const label = `${i + 1}/${cases.length} ${c.name}`
      status.textContent = `${label}: loading…`
      const result = await measure(c, warmup, frames, (done, warming) => {
        status.textContent = done < warming ? `${label}: warming up (frame ${done})` : `${label}: frame ${done - warming}/${frames}`
      })
      report.results.push(result)
      report.durationMs = Math.round(performance.now() - started)
      renderResults(report)
    }
    status.textContent = `${stopped ? 'Stopped' : 'Done'}: ${report.results.length} case(s) in ${(report.durationMs / 1000).toFixed(0)} s.`
  } finally {
    stage.replaceChildren()
    void lock?.release()
    hook.running = false
    runButton.disabled = false
    stopButton.disabled = true
  }
}

runButton.addEventListener('click', () => {
  run().catch((error: unknown) => (status.textContent = `Failed: ${error instanceof Error ? error.message : String(error)}`))
})
stopButton.addEventListener('click', () => (stopped = true))

document.getElementById('download')!.addEventListener('click', () => {
  if (!hook.report) return
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(hook.report, null, 2)], { type: 'application/json' }))
  a.download = `ouaf-bench-${hook.report.startedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
})
document.getElementById('copy')!.addEventListener('click', () => {
  output.hidden = false
  output.select()
  navigator.clipboard?.writeText(output.value).then(() => (status.textContent = 'Markdown table copied.'), () => (status.textContent = 'Select the text below and copy it.'))
})
compareInput.addEventListener('change', () => {
  const file = compareInput.files?.[0]
  if (!file) return
  file.text().then((text) => {
    previous = parseReport(text)
    status.textContent = `Comparing with ${file.name} (${previous.startedAt.slice(0, 10)}, ${previous.app.commit}).`
    if (hook.report) renderResults(hook.report)
  }).catch((error: unknown) => (status.textContent = `${file.name}: ${error instanceof Error ? error.message : String(error)}`))
})

loadCases().then((cases) => {
  renderCases(cases)
  runButton.disabled = false
  if (params.has('autorun')) runButton.click()
}, (error: unknown) => (status.textContent = `Failed: ${error instanceof Error ? error.message : String(error)}`))
