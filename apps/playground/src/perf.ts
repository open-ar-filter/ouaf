import {
  RollingStats,
  SessionRecorder,
  VERSION,
  collectDeviceInfo,
  createRollingSnapshot,
  stringifySession,
  type DeviceInfo,
  type FrameSample,
  type FrameSampleSink,
  type PerfSession,
  type PipelineInfo,
} from '@ouaf/core'

export interface PlaygroundPerf extends FrameSampleSink {
  /** Element holding the overlay (fps, timings, recorder controls). */
  readonly element: HTMLElement
  setInfo(info: PipelineInfo): void
  /** Logs a `note` event in the current recording (ignored when not recording). */
  note(message: string): void
  dispose(): void
}

export interface PerfOptions {
  /** Extra per-frame columns recorded from `FrameSample.extra` (`SessionRecorderOptions.extraColumns`). */
  extraColumns?: readonly string[]
  /**
   * Extra columns also shown live in the overlay, by index in `extraColumns`: `ms` columns as p50/p95, `count`
   * columns as the mean per frame (NaN values skipped). Default: none.
   */
  live?: readonly { column: number; label: string; kind: 'ms' | 'count' }[]
  /** Extra `app` fields of the export (e.g. spike variant details), read when exporting. */
  app?: () => Record<string, string | number | boolean>
}

/** Overlay refresh period: a few times per second, never per frame. */
const REFRESH_MS = 250

const PRESETS: { label: string; ms: number | undefined }[] = [
  { label: '5 min', ms: 5 * 60_000 },
  { label: '10 min', ms: 10 * 60_000 },
  { label: 'Manual', ms: undefined },
]

const STYLE = `
.ouaf-perf { position: sticky; top: 0; z-index: 1; margin: 12px 0; padding: 8px; max-width: 640px; box-sizing: border-box;
  background: Canvas; color: CanvasText; border: 1px solid GrayText; border-radius: 6px;
  font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
.ouaf-perf-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px 8px; }
@media (max-width: 480px) { .ouaf-perf-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.ouaf-perf-grid b { font-weight: 600; opacity: .7; margin-right: 4px; }
.ouaf-perf-info { opacity: .7; margin-top: 2px; }
.ouaf-perf-rec { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.ouaf-perf-rec button, .ouaf-perf-rec select { font: inherit; padding: 6px 10px; }
.ouaf-perf-rec button.recording { background: #c62828; color: #fff; border-color: #c62828; }
.ouaf-perf-msg:empty { display: none; }
.ouaf-perf-msg { margin-top: 4px; opacity: .8; }
`

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e: HTMLElementTagNameMap[K] = document.createElement(tag)
  Object.assign(e, props)
  e.append(...children)
  return e
}

function fmt(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '—'
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/** `ouaf-perf-20261121-142530-pixel-8-worker-maxfaces-4.json`: device, then page and URL options. */
function fileName(doc: PerfSession): string {
  const stamp = doc.startedAt.replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-')
  const device = doc.device?.userAgentData?.model || doc.device?.userAgentData?.platform || doc.device?.platform || ''
  const page = location.pathname.replace(/^.*\//, '').replace(/\.html$/, '').replace(/^index$/, '')
  const params = [...new URLSearchParams(location.search)].map(([k, v]) => (v ? `${k}-${v}` : k)).join('-')
  const slug = [device, page, params].join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `ouaf-perf-${stamp}${slug ? `-${slug}` : ''}.json`
}

// Experimental APIs, typed loosely (not in every TypeScript DOM lib).
interface BatteryLike extends EventTarget {
  level: number
  charging: boolean
}
interface PressureRecordLike {
  source: string
  state: string
}
interface PressureObserverLike {
  observe(source: string, options?: { sampleInterval?: number }): Promise<void>
  disconnect(): void
}
type PressureObserverCtor = new (cb: (records: PressureRecordLike[]) => void) => PressureObserverLike

/**
 * Creates the performance overlay and recorder: live rolling statistics (refreshed a few times per second) and a
 * session recorder with 5/10-minute presets and JSON export. Keeps the screen awake while recording.
 */
export function createPerf(options: PerfOptions = {}): PlaygroundPerf | undefined {
  // `?window=N`: seconds covered by the live figures (default 2; longer = steadier, e.g. a whole test clip loop).
  const windowS = Math.min(60, Math.max(1, Number(new URLSearchParams(location.search).get('window')) || 2))
  const stats = new RollingStats({ windowMs: windowS * 1000, capacity: Math.max(256, windowS * 130) })
  const snap = createRollingSnapshot()
  const recorder = new SessionRecorder(options.extraColumns ? { extraColumns: options.extraColumns } : {})
  let info: PipelineInfo | undefined
  let device: DeviceInfo | null = null
  let exported = true
  let wakeLock: WakeLockSentinel | undefined
  let pressure: PressureObserverLike | undefined
  let battery: BatteryLike | undefined

  // Collected once, before any measurement (it creates a throwaway WebGL context).
  void collectDeviceInfo().then((d) => (device = d))

  // --- DOM -------------------------------------------------------------------------------------------------------
  const cell = (label: string) => {
    const value = el('span', { textContent: '—' })
    return [el('div', {}, el('b', { textContent: label }), value), value] as const
  }
  const [fpsCell, fpsValue] = cell('fps')
  const [frameCell, frameValue] = cell('frame')
  const [delegateCell, delegateValue] = cell('delegate')
  const [trackCell, trackValue] = cell('track')
  const [renderCell, renderValue] = cell('render')
  const [facesCell, facesValue] = cell('faces')
  const live = (options.live ?? []).map((c) => ({ ...c, cell: cell(c.label) }))
  const extraWindow = live.length > 0 ? createExtraWindow(options.extraColumns?.length ?? 0) : undefined
  const infoLine = el('div', { className: 'ouaf-perf-info', textContent: 'p50/p95 in ms over the last 2 s' })

  const preset = el('select', { title: 'Recording duration' }, ...PRESETS.map((p, i) => el('option', { value: String(i), textContent: p.label })))
  preset.value = '1' // 10 minutes: the sustained-run default
  const recordButton = el('button', { type: 'button', textContent: '● Record' })
  const timeLabel = el('span', { textContent: '' })
  const exportButton = el('button', { type: 'button', textContent: 'Export', disabled: true })
  const shareButton = el('button', { type: 'button', textContent: 'Share', disabled: true, hidden: !canShareFiles() })
  const message = el('div', { className: 'ouaf-perf-msg' })

  const element = el(
    'section',
    { className: 'ouaf-perf', ariaLabel: 'Performance' },
    el('style', { textContent: STYLE }),
    el('div', { className: 'ouaf-perf-grid' }, fpsCell, frameCell, delegateCell, trackCell, renderCell, facesCell, ...live.map((c) => c.cell[0])),
    infoLine,
    el('div', { className: 'ouaf-perf-rec' }, preset, recordButton, timeLabel, exportButton, shareButton),
    message,
  )

  // --- Recording ---------------------------------------------------------------------------------------------------
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
      recorder.event({ type: 'wakeLock', state: 'unsupported' })
      message.textContent = 'Screen Wake Lock unavailable: keep the screen on manually.'
      return
    }
    if (wakeLock && !wakeLock.released) return
    try {
      const lock = await navigator.wakeLock.request('screen')
      if (!recorder.recording) {
        void lock.release()
        return
      }
      wakeLock = lock
      recorder.event({ type: 'wakeLock', state: 'acquired' })
      lock.addEventListener('release', () => {
        recorder.event({ type: 'wakeLock', state: 'released' })
        if (wakeLock === lock) wakeLock = undefined
      })
    } catch (err) {
      recorder.event({ type: 'wakeLock', state: 'error', message: errorMessage(err) })
      message.textContent = `Wake lock failed (${errorMessage(err)}): keep the screen on manually.`
    }
  }

  function releaseWakeLock() {
    const lock = wakeLock
    wakeLock = undefined
    if (lock && !lock.released) void lock.release().catch(() => {})
  }

  const logBattery = () => {
    if (battery) recorder.event({ type: 'battery', level: battery.level, charging: battery.charging })
  }
  const getBattery = (navigator as { getBattery?: () => Promise<BatteryLike> }).getBattery
  if (typeof getBattery === 'function') {
    getBattery
      .call(navigator)
      .then((b) => {
        battery = b
        b.addEventListener('levelchange', logBattery)
        b.addEventListener('chargingchange', logBattery)
      })
      .catch(() => {})
  }

  /** Compute Pressure API (Chromium): CPU pressure changes hint at thermal throttling. */
  function observePressure() {
    const Ctor = (globalThis as { PressureObserver?: PressureObserverCtor }).PressureObserver
    if (typeof Ctor !== 'function') return
    // Records arrive every sample interval, even when unchanged: keep the transitions only.
    const last = new Map<string, string>()
    try {
      pressure = new Ctor((records) => {
        for (const r of records) {
          if (last.get(r.source) === r.state) continue
          last.set(r.source, r.state)
          recorder.event({ type: 'pressure', source: r.source, state: r.state })
        }
      })
      pressure.observe('cpu', { sampleInterval: 1000 }).catch(() => {})
    } catch {
      pressure = undefined
    }
  }

  function startRecording() {
    if (!exported && recorder.count > 0 && !confirm('Discard the previous recording? It has not been exported.')) return
    const p = PRESETS[Number(preset.value)]
    recorder.start(p?.ms !== undefined ? { maxDurationMs: p.ms } : {})
    if (info) recorder.setInfo(info)
    exported = false
    message.textContent = ''
    if (document.visibilityState === 'hidden') recorder.event({ type: 'visibility', state: 'hidden' })
    logBattery()
    observePressure()
    void acquireWakeLock()
    refresh()
  }

  /** Called once the recorder has stopped (manually, at the duration limit or when full). */
  function onRecordingStopped() {
    releaseWakeLock()
    pressure?.disconnect()
    pressure = undefined
    const reason = recorder.stopReason
    const why = reason === 'duration' ? 'duration reached' : reason === 'full' ? 'buffers full' : 'stopped'
    message.textContent = `Recording ${why}: ${recorder.count} frames over ${clock(recorder.elapsedMs)}. Export it before starting a new one.`
  }

  function buildFile(): File {
    const doc = recorder.export({
      device,
      app: {
        name: 'ouaf-playground',
        core: VERSION,
        // Mirrors the FrameScheduler 'auto' choice.
        scheduler: 'requestVideoFrameCallback' in HTMLVideoElement.prototype ? 'video-frame' : 'animation-frame',
        // Which page and URL options produced the recording (spike variants, maxFaces, delegate…).
        page: location.pathname,
        params: location.search,
        ...options.app?.(),
      },
    })
    const text = stringifySession(doc)
    return new File([text], fileName(doc), { type: 'application/json' })
  }

  function download() {
    const file = buildFile()
    const url = URL.createObjectURL(file)
    const a = el('a', { href: url, download: file.name })
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    exported = true
    message.textContent = `Exported ${file.name} (${(file.size / 1024).toFixed(0)} KiB).`
  }

  async function share() {
    // Built synchronously so the share call stays within the user gesture.
    const file = buildFile()
    try {
      await navigator.share({ files: [file], title: file.name })
      exported = true
      message.textContent = `Shared ${file.name} (${(file.size / 1024).toFixed(0)} KiB).`
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      message.textContent = `Share failed (${errorMessage(err)}); use Export instead.`
    }
  }

  recordButton.addEventListener('click', () => {
    if (recorder.recording) {
      recorder.stop()
      refresh()
    } else startRecording()
  })
  exportButton.addEventListener('click', download)
  shareButton.addEventListener('click', () => void share())

  // Hidden pages stop delivering frames: log it (the analysis excludes those gaps) and re-acquire the wake lock,
  // which the browser releases when the page is hidden.
  const onVisibility = () => {
    const hidden = document.visibilityState === 'hidden'
    stats.markGap()
    recorder.event({ type: 'visibility', state: hidden ? 'hidden' : 'visible' })
    if (recorder.recording) {
      if (hidden) message.textContent = 'The page was hidden during the recording: keep it in front while measuring.'
      else void acquireWakeLock()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  // --- Overlay refresh ---------------------------------------------------------------------------------------------
  let wasRecording = false
  function refresh() {
    // Detects every way a recording ends: Stop button, duration limit, full buffers.
    recorder.update()
    if (wasRecording && !recorder.recording) onRecordingStopped()
    wasRecording = recorder.recording

    stats.compute(snap, performance.now())
    fpsValue.textContent = fmt(snap.fps)
    frameValue.textContent = `${fmt(snap.frameMs.p50)}/${fmt(snap.frameMs.p95)}`
    trackValue.textContent = `${fmt(snap.trackingMs.p50)}/${fmt(snap.trackingMs.p95)}`
    renderValue.textContent = `${fmt(snap.renderMs.p50)}/${fmt(snap.renderMs.p95)}`
    facesValue.textContent = fmt(snap.faces, 1)
    delegateValue.textContent = info?.delegate ?? '—'
    if (extraWindow) {
      const since = performance.now() - LIVE_WINDOW_MS
      for (const c of live) {
        const v = extraWindow.stats(c.column, since)
        c.cell[1].textContent = c.kind === 'ms' ? `${fmt(v.p50)}/${fmt(v.p95)}` : fmt(v.mean, 2)
      }
    }

    const recording = recorder.recording
    recordButton.textContent = recording ? '■ Stop' : '● Record'
    recordButton.classList.toggle('recording', recording)
    preset.disabled = recording
    exportButton.disabled = shareButton.disabled = recorder.count === 0
    if (recorder.state === 'idle') timeLabel.textContent = ''
    else {
      const limit = Number.isFinite(recorder.maxDurationMs) ? ` / ${clock(recorder.maxDurationMs)}` : ''
      timeLabel.textContent = `${recording ? 'REC ' : ''}${clock(recorder.elapsedMs)}${limit} · ${recorder.count} fr`
    }
  }
  const timer = setInterval(refresh, REFRESH_MS)
  refresh()

  return {
    element,
    record(sample: Readonly<FrameSample>) {
      stats.record(sample)
      recorder.record(sample)
      extraWindow?.record(sample)
    },
    setInfo(next: PipelineInfo) {
      info = { ...next }
      stats.reset()
      recorder.setInfo(next)
      infoLine.textContent =
        `video ${next.videoWidth}×${next.videoHeight} → render ${next.renderWidth}×${next.renderHeight}, ` +
        `max ${next.maxFaces} faces · p50/p95 ms over ${windowS} s`
    },
    note(message: string) {
      recorder.event({ type: 'note', message })
    },
    dispose() {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      battery?.removeEventListener('levelchange', logBattery)
      battery?.removeEventListener('chargingchange', logBattery)
      recorder.stop()
      releaseWakeLock()
      pressure?.disconnect()
      element.remove()
    },
  }
}

/** Window of the live statistics of the extra columns (same as `RollingStats`). */
const LIVE_WINDOW_MS = 2000
/** Samples kept for them: 2 s at up to 120 fps. */
const LIVE_CAPACITY = 256

/** Ring buffer of the last extra-column values, for the live overlay (allocation-free in the steady state). */
function createExtraWindow(columns: number) {
  const t = new Float64Array(LIVE_CAPACITY).fill(-Infinity)
  const values = Array.from({ length: columns }, () => new Float64Array(LIVE_CAPACITY))
  const scratch = new Float64Array(LIVE_CAPACITY)
  let next = 0
  const result = { p50: NaN, p95: NaN, mean: NaN }
  return {
    record(sample: Readonly<FrameSample>) {
      t[next] = sample.now
      for (let c = 0; c < columns; c++) (values[c] as Float64Array)[next] = sample.extra?.[c] ?? NaN
      next = (next + 1) % LIVE_CAPACITY
    },
    stats(column: number, since: number) {
      const v = values[column]
      let n = 0
      let sum = 0
      if (v) {
        for (let i = 0; i < LIVE_CAPACITY; i++) {
          const x = v[i] as number
          if ((t[i] as number) >= since && !Number.isNaN(x)) {
            scratch[n++] = x
            sum += x
          }
        }
      }
      const sorted = scratch.subarray(0, n).sort()
      result.mean = n > 0 ? sum / n : NaN
      result.p50 = n > 0 ? (sorted[Math.floor((n - 1) * 0.5)] as number) : NaN
      result.p95 = n > 0 ? (sorted[Math.floor((n - 1) * 0.95)] as number) : NaN
      return result
    },
  }
}

function canShareFiles(): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File(['{}'], 'test.json', { type: 'application/json' })] })
  } catch {
    return false
  }
}
