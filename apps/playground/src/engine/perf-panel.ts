/**
 * Performance panel of the engine page (#90, #34): rendering and tracking rates, frame budget, the device governor's
 * state and dropped capabilities (spec §16), the `performance` events, and a control that simulates slow tracking
 * (`throttlePlugin`) to watch the governor on a fast device. With `?signals`, a table compares the expression signals
 * from blendshapes and from the landmark geometry for face 0 (spec §13), live.
 */
import {
  DEFAULT_GOVERNOR_TUNING,
  SIGNAL,
  blendshapeSignals,
  createSignals,
  GeometrySignals,
  type Engine,
  type EngineStats,
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

  const table = el('table')
  const signalRows = new Map<string, [HTMLElement, HTMLElement]>()
  if (options.signals) {
    table.append(el('tr', {}, el('th', { textContent: 'signal' }), el('th', { textContent: 'blendshapes' }), el('th', { textContent: 'geometry' })))
    for (const name of ['eyeClosedLeft', 'eyeClosedRight', 'jawOpen', 'smile', 'browRaise', 'pucker'] as const) {
      const a = el('td', { textContent: '—' })
      const b = el('td', { textContent: '—' })
      signalRows.set(name, [a, b])
      table.append(el('tr', {}, el('td', { textContent: name }), a, b))
    }
  }

  const element = el('div', { className: 'ouaf-perf' }, style, grid, tracker, stateLine, help, log, throttleLine, ...(options.signals ? [table] : []))

  const showState = (p: PerformanceEvent) => {
    state.textContent = p.state
    state.dataset.state = p.state
    dropped.textContent = p.dropped.length ? p.dropped.join(', ') : 'none'
  }

  const bs = createSignals(1)
  const geo = createSignals(1)
  // The engine's own source (adaptive open-eye baseline), fed every frame; on the displayed faces (smoothed), where
  // the engine reads the raw result: blinks look a little weaker here.
  const geometry = new GeometrySignals(1)
  const ids = new Int32Array(1)
  let shownAt = -Infinity
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
            const has = frame.faces.count > 0
            if (has) {
              ids[0] = frame.anchors.id(0)
              geometry.begin(ids, frame.now)
              geometry.source(frame.faces, 0, geo, 0)
            }
            if (frame.now - shownAt < 250) return
            shownAt = frame.now
            if (has) blendshapeSignals(frame.faces, 0, bs, 0)
            for (const [name, [a, b]] of signalRows) {
              const k = SIGNAL[name as keyof typeof SIGNAL]
              a.textContent = has ? fmt(bs[k]!, 2) : '—'
              b.textContent = has ? fmt(geo[k]!, 2) : '—'
            }
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
    attach(engine) {
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
