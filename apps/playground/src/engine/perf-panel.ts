/**
 * Performance panel of the engine page (#90, #34): rendering and tracking rates, frame budget, the device governor's
 * state and dropped capabilities (spec §16), the `performance` events, and a control that simulates slow tracking
 * (`throttlePlugin`) to watch the governor on a fast device. With `?signals`, a table compares the expression signals
 * from blendshapes and from the landmark geometry for face 0 (spec §13), live, with the peak of the last 1.5 s (a blink
 * lasts one or two tracking results), and counts blinks and winks: those the engine fired (with the source it used:
 * blendshapes, or the geometry while they are dropped) and those each source alone would fire.
 */
import {
  BLENDSHAPES_STRIDE,
  DEFAULT_GOVERNOR_TUNING,
  ExpressionEventDetector,
  SIGNAL,
  blendshapeSignals,
  createSignals,
  GeometrySignals,
  type Engine,
  type EngineStats,
  type ExpressionEventPayload,
  type ObjectLayer,
  type OuafPlugin,
  type PerformanceEvent,
  type TrackingThrottle,
} from '@ouaf/core'
import { Group } from 'three'

const STYLE = `
.ouaf-perf { margin: 12px 0; padding: 8px; max-width: 640px; box-sizing: border-box;
  background: Canvas; color: CanvasText; border: 1px solid GrayText; border-radius: 6px;
  font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
.ouaf-perf-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 2px 8px; }
@media (max-width: 480px) { .ouaf-perf-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.ouaf-perf b { font-weight: 600; opacity: .7; margin-right: 4px; }
.ouaf-perf-state { margin-top: 4px; }
.ouaf-perf-state [data-state="ok"] { color: #2e7d32; }
.ouaf-perf-state [data-state="degraded"] { color: #ef6c00; }
.ouaf-perf-state [data-state="unsupported"] { color: #c62828; }
.ouaf-perf-info { opacity: .7; margin-top: 2px; }
.ouaf-perf-log { margin: 4px 0 0; padding: 0; list-style: none; opacity: .8; }
.ouaf-perf-throttle { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.ouaf-perf-throttle input[type=range] { flex: 1; min-width: 120px; }
.ouaf-perf table { border-collapse: collapse; margin-top: 6px; }
.ouaf-perf td, .ouaf-perf th { padding: 0 8px 0 0; text-align: right; }
.ouaf-perf th:first-child, .ouaf-perf td:first-child { text-align: left; }
`

export interface PerfPanel {
  readonly element: HTMLElement
  /** An expression event the engine delivered to a filter (counted under `?signals`). */
  expression(e: ExpressionEventPayload): void
  /** `performance` events received, oldest first (test hook). */
  readonly events: PerformanceEvent[]
  /** Renders the expression signals of face 0 (`?signals`), installed with the engine. */
  readonly signalsPlugin: OuafPlugin
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  Object.assign(e, props)
  e.append(...children)
  return e
}

const fmt = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '—')

/** Creates the panel; `attach` wires it to the engine once created (the throttle and signals plugins come first). */
export function createPerfPanel(throttle: TrackingThrottle, options: { signals: boolean }): PerfPanel & { attach(engine: Engine): void } {
  const style = el('style', { textContent: STYLE })
  const cells = new Map<string, HTMLElement>()
  const cell = (key: string, label: string) => {
    const value = el('span', { textContent: '—' })
    cells.set(key, value)
    return el('div', {}, el('b', { textContent: label }), value)
  }
  const set = (key: string, text: string) => {
    const c = cells.get(key)
    if (c && c.textContent !== text) c.textContent = text
  }
  const grid = el('div', { className: 'ouaf-perf-grid' }, cell('fps', 'fps'), cell('frame', 'frame ms'), cell('track', 'track ms'), cell('hz', 'track Hz'), cell('faces', 'faces'), cell('size', 'px'))
  const state = el('span', { textContent: 'ok' })
  state.dataset.state = 'ok'
  const dropped = el('span', { textContent: 'none' })
  const tracker = el('div', { textContent: 'no tracker', className: 'ouaf-perf-info' })
  const stateLine = el('div', { className: 'ouaf-perf-state' }, el('b', { textContent: 'governor' }), state, ' · ', el('b', { textContent: 'dropped' }), dropped)
  const log = el('ul', { className: 'ouaf-perf-log' })
  const events: PerformanceEvent[] = []

  // Simulated slow tracking: the time each result is held back to (0 = off).
  const range = el('input', { type: 'range', min: '0', max: '150', step: '5', value: String(throttle.ms) })
  const output = el('span')
  const describeThrottle = () => {
    output.textContent = throttle.ms > 0 ? `${throttle.ms} ms (≈ ${fmt(1000 / throttle.ms, 0)} Hz with everything on)` : 'off'
  }
  describeThrottle()
  range.addEventListener('input', () => {
    throttle.ms = Number(range.value)
    describeThrottle()
  })
  const throttleLine = el('label', { className: 'ouaf-perf-throttle' }, el('b', { textContent: 'simulate tracking' }), range, output)

  const t = DEFAULT_GOVERNOR_TUNING
  const help = el('div', {
    className: 'ouaf-perf-info',
    textContent: `floor ${t.floorHz} Hz (hidden after ${t.floorDelayMs / 1000} s), shown above ${t.resumeHz} Hz; drops below ${t.dropBelowHz} Hz, restores above ${t.restoreAboveHz} Hz`,
  })

  const SIGNAL_NAMES = ['eyeClosedLeft', 'eyeClosedRight', 'jawOpen', 'smile', 'browRaise', 'pucker'] as const
  const table = el('table')
  /** Per signal: blendshapes now, blendshapes peak, geometry now, geometry peak. */
  const signalRows = new Map<string, HTMLElement[]>()
  const COUNTED = ['blink', 'wink left', 'wink right'] as const
  /** Per counted event: engine (blendshapes), engine (geometry), blendshapes alone, geometry alone. */
  const countCells = new Map<string, HTMLElement[]>()
  const counts = new Map<string, number[]>(COUNTED.map((n) => [n, [0, 0, 0, 0]]))
  const resetButton = el('button', { type: 'button', textContent: 'Reset counts' })
  if (options.signals) {
    table.append(el('tr', {}, ...['signal', 'blendshapes', 'peak 1.5 s', 'geometry', 'peak 1.5 s'].map((h) => el('th', { textContent: h }))))
    for (const name of SIGNAL_NAMES) {
      const cells = [0, 1, 2, 3].map(() => el('td', { textContent: '—' }))
      signalRows.set(name, cells)
      table.append(el('tr', {}, el('td', { textContent: name }), ...cells))
    }
    table.append(el('tr', {}, ...['events', 'engine (bs+geo)', 'engine (geo)', 'bs alone', 'geo alone'].map((h) => el('th', { textContent: h }))))
    for (const name of COUNTED) {
      const cells = [0, 1, 2, 3].map(() => el('td', { textContent: '0' }))
      countCells.set(name, cells)
      table.append(el('tr', {}, el('td', { textContent: name }), ...cells))
    }
  }
  const showCounts = () => {
    for (const [name, cells] of countCells) counts.get(name)!.forEach((n, i) => (cells[i]!.textContent = String(n)))
  }
  resetButton.addEventListener('click', () => {
    for (const c of counts.values()) c.fill(0)
    showCounts()
  })
  const signalsHelp = el('div', {
    className: 'ouaf-perf-info',
    textContent:
      'Engine: events delivered to the filters, under the source in use: with blendshapes, each eye is the larger of the blendshape and the geometry; geometry alone while blendshapes are dropped (?throttle). "Alone": what each source would fire by itself, approximated here on the displayed faces, once per tracking result. Blink 10 times, then read the counts.',
  })

  const element = el('div', { className: 'ouaf-perf' }, style, grid, tracker, stateLine, help, log, throttleLine, ...(options.signals ? [table, resetButton, signalsHelp] : []))

  const showState = (p: PerformanceEvent) => {
    state.textContent = p.state
    state.dataset.state = p.state
    dropped.textContent = p.dropped.length ? p.dropped.join(', ') : 'none'
  }

  const bs = createSignals(1)
  const geo = createSignals(1)
  // The engine's own source (adaptive open-eye baseline), fed once per tracking result; on the displayed faces
  // (smoothed), where the engine reads the raw result: blinks look a little weaker here than in the engine.
  const geometry = new GeometrySignals(1)
  const ids = new Int32Array(1)
  const detectors = [new ExpressionEventDetector({ maxFaces: 1 }), new ExpressionEventDetector({ maxFaces: 1 })] as const
  /** Peak of each signal over the last `PEAK_MS`, and when it was reached: blendshapes, then geometry. */
  const PEAK_MS = 1500
  const peaks = new Float64Array(2 * SIGNAL_NAMES.length)
  const peakAt = new Float64Array(2 * SIGNAL_NAMES.length).fill(-Infinity)
  /** Blendshapes of the last result seen: they only change with a new tracking result (copied, not smoothed). */
  const lastScores = new Float32Array(BLENDSHAPES_STRIDE)
  let shownAt = -Infinity
  let engineRef: Engine | undefined
  const countEvents = (column: number, out: ReturnType<ExpressionEventDetector['update']>) => {
    for (let i = 0; i < out.count; i++) {
      const e = out.items[i]!
      const key = e.name === 'blink' ? 'blink' : e.name === 'wink' ? `wink ${e.side}` : undefined
      if (key) counts.get(key)![column]!++
    }
  }
  const signalsPlugin: OuafPlugin = {
    name: 'playground-signals',
    version: '1.0.0',
    setup(api) {
      api.registerRenderPass({
        id: 'signals',
        create: (): ObjectLayer => ({
          kind: 'object',
          stage: 'objects',
          object: new Group(),
          update(frame) {
            if (!options.signals) return
            const faces = frame.faces
            const has = faces.count > 0
            let fresh = false
            if (has) {
              for (let i = 0; i < BLENDSHAPES_STRIDE; i++) if (faces.blendshapes[i] !== lastScores[i]) fresh = true
              if (fresh) lastScores.set(faces.blendshapes.subarray(0, BLENDSHAPES_STRIDE))
            }
            if (fresh) {
              ids[0] = frame.anchors.id(0)
              blendshapeSignals(faces, 0, bs, 0)
              geometry.begin(ids, frame.now)
              geometry.source(faces, 0, geo, 0)
              countEvents(2, detectors[0].update(frame.now, 1, ids, bs))
              countEvents(3, detectors[1].update(frame.now, 1, ids, geo))
              SIGNAL_NAMES.forEach((name, k) => {
                for (let src = 0; src < 2; src++) {
                  const v = (src ? geo : bs)[SIGNAL[name]]!
                  const j = src * SIGNAL_NAMES.length + k
                  if (v >= peaks[j]! || frame.now - peakAt[j]! > PEAK_MS) {
                    peaks[j] = v
                    peakAt[j] = frame.now
                  }
                }
              })
            }
            if (frame.now - shownAt < 250) return
            shownAt = frame.now
            SIGNAL_NAMES.forEach((name, k) => {
              const cells = signalRows.get(name)!
              cells[0]!.textContent = has ? fmt(bs[SIGNAL[name]]!, 2) : '—'
              cells[1]!.textContent = fmt(peaks[k]!, 2)
              cells[2]!.textContent = has ? fmt(geo[SIGNAL[name]]!, 2) : '—'
              cells[3]!.textContent = fmt(peaks[SIGNAL_NAMES.length + k]!, 2)
            })
            showCounts()
          },
          dispose() {},
        }),
      })
    },
  }

  return {
    element,
    events,
    signalsPlugin,
    expression(e) {
      const key = e.name === 'blink' ? 'blink' : e.name === 'wink' ? `wink ${e.side}` : undefined
      if (!key || !engineRef) return
      // The source the engine used: the geometry while the governor has dropped blendshapes.
      counts.get(key)![engineRef.performance.dropped.includes('blendshapes') ? 1 : 0]!++
    },
    attach(engine) {
      engineRef = engine
      engine.on('stats', (s: EngineStats) => {
        set('fps', fmt(s.fps))
        set('frame', `${fmt(s.frameMs)} (max ${fmt(s.frameMsMax)}) / ${fmt(1000 / s.fps)}`)
        set('track', fmt(s.trackMs))
        set('hz', fmt(s.trackingHz))
        set('faces', String(s.faces))
        set('size', `${s.width}×${s.height}`)
        tracker.textContent = s.tracker ?? 'no tracker'
        showState(engine.performance)
      })
      engine.on('performance', (p) => {
        events.push(p)
        showState(p)
        const time = new Date().toLocaleTimeString()
        log.prepend(el('li', { textContent: `${time} ${p.state}${p.dropped.length ? ` (${p.dropped.join(', ')})` : ''} at ${fmt(p.trackingHz)} Hz` }))
        while (log.children.length > 6) log.lastElementChild?.remove()
      })
    },
  }
}
