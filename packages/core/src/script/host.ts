/**
 * The engine side of a filter's script (spec §12): it starts the sandbox, sends `init` then one frame at a time, and
 * applies the answers.
 *
 * - **One frame in flight** (spec §12.7): a frame goes to the script only once it has answered the previous one;
 *   the frames rendered in between are not sent (the next `frame.dt` covers them). Events are queued and delivered
 *   with the next frame sent, in order. A script that gets no frames (its filter disabled or hidden by the governor)
 *   keeps a bounded queue: at `MAX_QUEUED_EVENTS`, only the last `message:<name>` of each name and the last
 *   `paramChange` of each parameter are kept (then the oldest event is dropped if still full), with a warning.
 * - **Live sources** (spec §12.1): the engine never waits. An answer is applied at the start of the first frame
 *   rendered after it arrives (`beginFrame`), so commands take effect with at least one frame of latency.
 *   (Waiting for the answer with file sources needs the offline sources of #32.)
 * - **Watchdog**: no answer within 1 s (`setup` included) stops the script: its sandbox is removed (which terminates
 *   the Worker) and the engine emits `OuafError('SCRIPT_STOPPED')`. Layers, bindings and the animations already
 *   started keep working; the script stays stopped until the filter is activated again. The 1 s are the script's:
 *   - at activation, the runtime first prepares the canvases and fonts (slow under load, and no script code runs):
 *     the 1 s start when it says that the script starts (`started`), before `script.js` is evaluated; until then
 *     only a generous bound applies (`STARTUP_MS`);
 *   - a timer that fires late means this thread was stalled (a long rendering task): the answer may be waiting
 *     behind it, so the script gets another period. A script stuck in a loop is still stopped by the next timer
 *     that fires on time, about 1 s later.
 * - **Messages** (`f.emit`): structured-cloneable, at most 64 KB, at most 60 per second; others are dropped with a
 *   warning.
 * - **Canvas layers** (spec §12.6): the script draws them in its Worker; each answer may carry their new images
 *   (premultiplied RGBA pixels, transferred), handed to the layers with the answer's commands (`drawn`).
 */
import { SCRIPT_LIMITS, type ScriptUse } from '@ouaf/spec'
import { OuafError } from '../engine/errors.ts'
import { isEasing } from './easing.ts'
import { estimateSize } from './size.ts'
import type { FrameDataBuilder, FrameDataSource } from './frame-data.ts'
import type { OverrideValue, ScriptOverrides } from './overrides.ts'
import type { WireCanvas, WireCommand, WireDone, WireEvent, WireFont, WireFrame, WireInit } from './runtime.ts'

/**
 * Events queued for a script before the queue is bounded (spec §12.7). A running script empties it with each frame
 * it is sent, so only a script that gets no frames (filter disabled or hidden, or not answering for up to the 1 s of
 * the watchdog) reaches it: a host that sends a message every frame would otherwise grow it forever.
 */
export const MAX_QUEUED_EVENTS = 256

/** Key of the events a later one makes obsolete: a host message by its name, a `paramChange` by its parameter. */
function supersedeKey(e: WireEvent): string | undefined {
  if (e.name.startsWith('message:')) return e.name
  if (e.name === 'paramChange') return `paramChange:${String((e.payload as { name?: unknown } | undefined)?.name)}`
  return undefined
}

/**
 * Keeps only the last event of each key (`supersedeKey`), in order; a kept `paramChange` takes the `previous` of the
 * first change it replaces, so the script still learns the value before the changes it missed.
 */
function compactEvents(events: WireEvent[]): WireEvent[] {
  const kept = new Map<string, WireEvent>()
  const out: WireEvent[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    const key = supersedeKey(e)
    if (key === undefined) out.push(e)
    else {
      const later = kept.get(key)
      if (!later) {
        const copy = e.name === 'paramChange' ? { ...e, payload: { ...(e.payload as object) } } : e
        kept.set(key, copy)
        out.push(copy)
      } else if (e.name === 'paramChange') {
        ;(later.payload as { previous?: unknown }).previous = (e.payload as { previous?: unknown }).previous
      }
    }
  }
  return out.reverse()
}

export { estimateSize } from './size.ts'

/** How late (ms) the watchdog timer may fire before the delay is blamed on this thread rather than on the script. */
const WATCHDOG_LATE_MS = 250

/**
 * Bound (ms) on the runtime's own preparation at activation, before it starts the script (`started`): registering
 * the fonts, setting up the canvases. No script code runs then, so the 1 s watchdog does not apply yet.
 */
export const STARTUP_MS = 10_000

/** The engine's end of the channel to a sandbox (a `MessagePort`, or a test double). */
export interface ScriptPort {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: { data: unknown }) => void) | null
  start?(): void
}

export interface ScriptConnection {
  readonly port: ScriptPort
  terminate(): void
}

export interface ScriptHostOptions {
  /** Filter id, for messages. */
  filterId: string
  /** Source of `script.js`. */
  code: string
  /** Layer ids by index (`''` without id). */
  layers: readonly string[]
  /** Events the script handles (`script.on`). */
  on: readonly string[]
  uses: readonly ScriptUse[]
  overrides: ScriptOverrides
  frameData: FrameDataBuilder
  /** 32-bit seed of `f.random()` for this activation (spec §12.5). */
  seed: number
  /** Opens the sandbox (`openSandbox` in a browser). */
  connect(): Promise<ScriptConnection>
  warn(message: string): void
  /** Asynchronous failures: the sandbox did not start, `SCRIPT_STOPPED`. */
  error(error: OuafError): void
  /** `f.emit(name, data)`. */
  emit(name: string, data: unknown): void
  /**
   * `.play(animation)` on layer `layer` (index), for face id `face` or every instance: `'played'`, `'unknown'` (the
   * model has no such animation) or `'unsupported'` (not a model layer).
   */
  play?(layer: number, face: number | undefined, animation: string): 'played' | 'unknown' | 'unsupported'
  /** The canvas layers the script draws (`script.draw`, spec §12.6). */
  canvases?: readonly WireCanvas[]
  /**
   * The image assets `f.asset()` gives, made afresh for each activation (they are transferred to the sandbox).
   * Called only when the script draws canvas layers.
   */
  images?(): Promise<Record<string, ImageBitmap>>
  /**
   * The font assets the runtime registers in its Worker before `setup`, by asset name (spec §12.6): their bytes are
   * copied to the sandbox. Called only when the script draws canvas layers.
   */
  fonts?(): WireFont[]
  /**
   * A new image of canvas layer `layer` (index): premultiplied RGBA pixels, top row first (the sandbox's: their
   * length is the callee's to check). The callee owns them from then on.
   */
  drawn?(layer: number, pixels: Uint8ClampedArray): void
  /** Clock for the watchdog (ms); default `performance.now`. */
  now?(): number
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(id: unknown): void
}

type State = 'idle' | 'starting' | 'running' | 'stopped' | 'disposed'

export class ScriptHost {
  readonly #o: ScriptHostOptions
  readonly #on: ReadonlySet<string>
  #state: State = 'idle'
  #connection: ScriptConnection | undefined
  #seq = 0
  /** Sequence number of the message awaiting an answer, or -1. */
  #inFlight = -1
  #watchdog: unknown
  /** When the watchdog was armed (`now()`, ms), and for how long. */
  #armedAt = 0
  #period = 0
  /** The runtime has prepared the sandbox and runs the script (`started`): `setup` is timed from then on. */
  #started = false
  /** Answers received since the last frame, applied at the start of the next one. */
  #answers: WireDone[] = []
  #events: WireEvent[] = []
  #params: Record<string, unknown> | undefined
  /** A new seed for `f.random()` (a new source run), sent with the next frame. */
  #seed: number | undefined
  #lastTime = -1
  #slowFrames = 0
  #warnedSlow = false
  #emitWindow = 0
  #emitCount = 0
  readonly #warned = new Set<string>()

  constructor(options: ScriptHostOptions) {
    this.#o = options
    this.#on = new Set(options.on)
  }

  get state(): State {
    return this.#state
  }

  /** A message (`init` or a frame) is waiting for the script's answer. */
  get waiting(): boolean {
    return this.#inFlight >= 0
  }

  /** The script handles `event` (it is in `script.on`). */
  handles(event: string): boolean {
    return this.#on.has(event)
  }

  /** Starts the sandbox and runs `setup`; `params`: current values; `time`: media time (s). */
  async start(params: Record<string, unknown>, time: number): Promise<void> {
    if (this.#state !== 'idle') return
    this.#state = 'starting'
    const canvases = this.#o.canvases ?? []
    let connection: ScriptConnection
    let images: Record<string, ImageBitmap> = {}
    try {
      ;[connection, images] = await Promise.all([this.#o.connect(), canvases.length > 0 && this.#o.images ? this.#o.images() : {}])
    } catch (error) {
      if ((this.#state as State) === 'disposed') return
      this.#state = 'stopped'
      this.#o.error(error instanceof OuafError ? error : new OuafError('script', `Filter "${this.#o.filterId}": ${String(error)}`, { cause: error }))
      return
    }
    if ((this.#state as State) === 'disposed') {
      connection.terminate()
      for (const image of Object.values(images)) image.close()
      return
    }
    this.#connection = connection
    connection.port.onmessage = (e) => this.#onMessage(e.data)
    connection.port.start?.()
    this.#state = 'running'
    const init: WireInit = {
      t: 'init',
      code: this.#o.code,
      layers: [...this.#o.layers],
      params,
      seed: this.#o.seed >>> 0,
      clock: this.#o.overrides.clock.time,
      time,
      assets: images,
      canvases: canvases.map((c) => ({ ...c })),
      fonts: canvases.length > 0 && this.#o.fonts ? this.#o.fonts() : [],
    }
    this.#send(0, init, Object.values(images))
  }

  /** Queues an event for the script (only those it handles). */
  queue(event: WireEvent): void {
    if (this.#state === 'stopped' || this.#state === 'disposed') return
    if (!this.#on.has(event.name)) return
    if (this.#events.length >= MAX_QUEUED_EVENTS) {
      this.#events = compactEvents(this.#events)
      if (this.#events.length >= MAX_QUEUED_EVENTS) this.#events.shift()
      this.#warnOnce(
        'queue',
        `more than ${MAX_QUEUED_EVENTS} events wait for the script (its filter is disabled or hidden?): only the last message of each name and the last change of each parameter are kept.`,
      )
    }
    this.#events.push(event)
  }

  /** The filter was reseeded (a new source run, spec §12.5): the next frame restarts `f.random()` from `seed`. */
  reseed(seed: number): void {
    this.#seed = seed >>> 0
  }

  /** A parameter changed: the next frame carries the new values. */
  paramsChanged(values: Record<string, unknown>): void {
    this.#params = values
  }

  /** Start of a rendered frame: applies the answers received since the previous one. */
  beginFrame(): void {
    if (this.#answers.length === 0) return
    const answers = this.#answers
    this.#answers = []
    for (const a of answers) this.#apply(a)
  }

  /** End of a rendered frame: sends it to the script unless it is still busy with the previous one. */
  endFrame(time: number, source: FrameDataSource): void {
    if (this.#state !== 'running') return
    if (this.#inFlight >= 0) {
      this.#slowFrames++
      if (this.#slowFrames >= 30 && !this.#warnedSlow) {
        this.#warnedSlow = true
        this.#o.warn(`Filter "${this.#o.filterId}": the script answers more slowly than the frame rate; its commands are late (spec §12.7).`)
      }
      return
    }
    this.#slowFrames = 0
    const dt = this.#lastTime < 0 ? 0 : Math.max(0, time - this.#lastTime)
    this.#lastTime = time
    const frame: WireFrame = {
      t: 'frame',
      seq: ++this.#seq,
      time,
      dt,
      aspect: source.aspect,
      clock: this.#o.overrides.clock.time,
      faces: this.#o.frameData.build(source),
      events: this.#events,
    }
    if (this.#o.uses.includes('pairs')) frame.pairs = []
    if (this.#params) frame.params = this.#params
    if (this.#seed !== undefined) frame.seed = this.#seed
    this.#events = []
    this.#params = undefined
    this.#seed = undefined
    this.#send(frame.seq, frame)
  }

  /** Stops the script and frees the sandbox. Idempotent. */
  dispose(): void {
    if (this.#state === 'disposed') return
    this.#state = 'disposed'
    this.#shutdown()
    this.#answers = []
  }

  #send(seq: number, message: WireInit | WireFrame, images: ImageBitmap[] = []): void {
    this.#inFlight = seq
    // `init`: the runtime prepares the sandbox first, then says when the script starts (`started`).
    this.#armWatchdog(seq, seq === 0 ? STARTUP_MS : SCRIPT_LIMITS.watchdogMs)
    const transfer: Transferable[] = message.t === 'frame' ? message.faces.flatMap((f) => (f.landmarks ? [f.landmarks.buffer as ArrayBuffer] : [])) : images
    try {
      this.#connection!.port.postMessage(message, transfer)
    } catch (error) {
      this.#stop(`its frame data could not be sent (${String(error)})`)
    }
  }

  #onMessage(data: unknown): void {
    const m = data as { t?: unknown; seq?: unknown; message?: unknown } | null
    if (!m || typeof m !== 'object') return
    if (this.#state !== 'running') return
    if (m.t === 'fatal') {
      this.#stop(String(m.message), 'script')
      return
    }
    if (m.t === 'started') {
      // Once, while `init` is in flight: from now on the script runs, and has the watchdog's 1 s (spec §12.7).
      if (this.#started || this.#inFlight !== 0) return
      this.#started = true
      this.#clearWatchdog()
      this.#armWatchdog(0, SCRIPT_LIMITS.watchdogMs)
      return
    }
    if (m.t !== 'done' || m.seq !== this.#inFlight) return
    this.#clearWatchdog()
    this.#inFlight = -1
    this.#answers.push(m as WireDone)
  }

  #armWatchdog(seq: number, ms: number): void {
    const set = this.#o.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    this.#armedAt = this.#now()
    this.#period = ms
    this.#watchdog = set(() => this.#onTimeout(seq), ms)
  }

  #now(): number {
    return (this.#o.now ?? (() => performance.now()))()
  }

  #onTimeout(seq: number): void {
    if (this.#state !== 'running' || this.#inFlight !== seq) return
    // A late timer means this thread was busy (a long task: rendering, decoding): the script's answer may be waiting
    // behind the timer in the event loop. The script gets another period rather than being stopped for the host's
    // stall; a script stuck in a loop is still stopped by the next timer that fires on time.
    if (this.#now() - this.#armedAt > this.#period + WATCHDOG_LATE_MS) {
      this.#armWatchdog(seq, this.#period)
      return
    }
    if (seq === 0 && !this.#started) this.#stop(`its sandbox was not ready within ${STARTUP_MS / 1000} s`)
    else this.#stop(`it did not answer ${seq === 0 ? 'setup' : 'a frame'} within ${SCRIPT_LIMITS.watchdogMs} ms (an endless loop?)`)
  }

  #stop(reason: string, code: 'SCRIPT_STOPPED' | 'script' = 'SCRIPT_STOPPED'): void {
    if (this.#state === 'stopped' || this.#state === 'disposed') return
    this.#state = 'stopped'
    this.#shutdown()
    this.#events = []
    this.#o.error(
      new OuafError(code, `Filter "${this.#o.filterId}": the script was stopped: ${reason}. The rest of the filter keeps working; the script restarts when the filter is added again.`),
    )
  }

  #shutdown(): void {
    this.#clearWatchdog()
    this.#inFlight = -1
    if (this.#connection) {
      this.#connection.port.onmessage = null
      this.#connection.terminate()
      this.#connection = undefined
    }
  }

  #clearWatchdog(): void {
    if (this.#watchdog === undefined) return
    const clear = this.#o.clearTimeout ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
    clear(this.#watchdog)
    this.#watchdog = undefined
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return
    this.#warned.add(key)
    this.#o.warn(`Filter "${this.#o.filterId}": ${message}`)
  }

  #apply(answer: WireDone): void {
    for (const w of answer.warnings ?? []) this.#o.warn(`Filter "${this.#o.filterId}": script: ${w}`)
    for (const c of answer.commands ?? []) this.#command(c)
    for (const [name, data] of answer.emits ?? []) this.#emit(name, data)
    // The answer comes from the sandbox, where the script may have rewritten it: check what it holds.
    if (!Array.isArray(answer.images) || !this.#o.drawn) return
    for (const entry of answer.images as unknown[]) {
      const [layer, pixels] = Array.isArray(entry) ? (entry as unknown[]) : []
      if (pixels instanceof Uint8ClampedArray && typeof layer === 'number' && layer in this.#o.layers) this.#o.drawn(layer, pixels)
    }
  }

  #layerName(index: number): string {
    return this.#o.layers[index] ? `layer "${this.#o.layers[index]}"` : `layer ${index}`
  }

  #command(c: WireCommand): void {
    const [op, layer] = c
    if (typeof layer !== 'number' || !(layer in this.#o.layers)) return
    if (op === 'set' || op === 'animate') {
      const face = c[2] ?? undefined
      for (const [name, value] of flattenProps(c[3])) {
        const prop = this.#o.overrides.property(layer, name)
        if (!prop) {
          const settable = this.#o.overrides.propertiesOf(layer)
          this.#warnOnce(`prop:${layer}:${name}`, `${this.#layerName(layer)} has no property "${name}" a script can ${op} (settable: ${settable.join(', ') || 'none'}).`)
          continue
        }
        if (op === 'set') {
          if (value === null) prop.set(face, null)
          else if (prop.typeOf(value) === undefined) this.#warnOnce(`type:${layer}:${name}`, `.set(): ${JSON.stringify(value)} is not a valid "${name}" of ${this.#layerName(layer)} (${prop.types.join(' or ')}).`)
          else {
            // Content properties (`src`, `font`, `lut`, `animation`) take the name of an asset (or animation) they show.
            const problem = prop.problem(value)
            if (problem) this.#warnOnce(`value:${layer}:${name}:${String(value)}`, `.set({ ${name}: ${JSON.stringify(value)} }) on ${this.#layerName(layer)}: ${problem}; ignored.`)
            else prop.set(face, copy(value as OverrideValue))
          }
          continue
        }
        this.#animate(layer, name, face, value, c[4])
      }
      return
    }
    if (op === 'play') {
      const result = this.#o.play?.(layer, c[2] ?? undefined, c[3]) ?? 'unsupported'
      if (result === 'unsupported') this.#warnOnce(`play:${layer}`, `.play() starts model animations: ${this.#layerName(layer)} is not a model layer; ignored.`)
      else if (result === 'unknown') this.#warnOnce(`play:${layer}:${c[3]}`, `.play(${JSON.stringify(c[3])}): ${this.#layerName(layer)} has no such animation.`)
    }
  }

  #animate(layer: number, name: string, face: number | undefined, value: unknown, options: Record<string, unknown>): void {
    const prop = this.#o.overrides.property(layer, name)!
    const where = `.animate() on "${name}" of ${this.#layerName(layer)}`
    if (!prop.animatable) {
      this.#warnOnce(`anim:${layer}:${name}`, `${where}: only numbers, colors and vectors can be animated.`)
      return
    }
    const duration = options.duration
    if (typeof duration !== 'number' || !(duration >= 0)) return
    let easing = options.easing
    if (easing !== undefined && !isEasing(easing)) {
      this.#warnOnce(`easing:${String(easing)}`, `${where}: unknown easing ${JSON.stringify(easing)}, using inOutQuad.`)
      easing = undefined
    }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const opts = { duration, easing: easing as string | undefined, delay: num(options.delay), repeat: num(options.repeat) }
    if (value && typeof value === 'object' && !Array.isArray(value) && 'keyframes' in value) {
      const frames = (value as { keyframes: unknown }).keyframes
      if (!Array.isArray(frames) || frames.length < 2 || frames.some((v) => prop.typeOf(v) === undefined || prop.typeOf(v) === 'boolean' || prop.typeOf(v) === 'string')) {
        this.#warnOnce(`kf:${layer}:${name}`, `${where}: keyframes must be at least two values of type ${prop.types.join(' or ')}.`)
        return
      }
      const t0 = prop.typeOf(frames[0])
      if (frames.some((v) => prop.typeOf(v) !== t0)) {
        this.#warnOnce(`kf:${layer}:${name}`, `${where}: keyframes must all have the same type.`)
        return
      }
      prop.animate(face, undefined, frames.map((v) => copy(v as OverrideValue)), opts)
      return
    }
    const type = prop.typeOf(value)
    if (type === undefined || type === 'boolean' || type === 'string') {
      this.#warnOnce(`target:${layer}:${name}`, `${where}: ${JSON.stringify(value)} is not a valid target (${prop.types.join(' or ')}).`)
      return
    }
    prop.animate(face, copy(value as OverrideValue), undefined, opts)
  }

  #emit(name: string, data: unknown): void {
    const now = this.#now()
    if (now - this.#emitWindow >= 1000) {
      this.#emitWindow = now
      this.#emitCount = 0
    }
    if (++this.#emitCount > SCRIPT_LIMITS.emitMaxPerSecond) {
      this.#warnOnce('emit-rate', `f.emit(): more than ${SCRIPT_LIMITS.emitMaxPerSecond} messages per second; the extra ones are dropped.`)
      return
    }
    const size = estimateSize(data, SCRIPT_LIMITS.emitMaxBytes + 1)
    if (size > SCRIPT_LIMITS.emitMaxBytes) {
      this.#warnOnce(`emit-size:${name}`, `f.emit("${name}"): the data is larger than ${SCRIPT_LIMITS.emitMaxBytes / 1024} KB; dropped.`)
      return
    }
    this.#o.emit(name, data)
  }
}

/** The properties of a `.set()` / `.animate()` call; `uniforms: { a: 1 }` (shader layers) becomes `uniforms.a`. */
function flattenProps(props: Record<string, unknown>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = []
  for (const [name, value] of Object.entries(props)) {
    if (name === 'uniforms' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) out.push([`uniforms.${k}`, v])
    } else out.push([name, value])
  }
  return out
}

function copy(v: OverrideValue): OverrideValue {
  return Array.isArray(v) ? Object.freeze([...v]) : v
}
