/**
 * Per-filter parameter store (spec section 9).
 *
 * Parameters belong to the host: it sets them, the filter only reads them. Every value is checked when it is set
 * (an invalid value throws a `ParamError`, nothing is applied); accepted changes are queued and applied together at
 * the start of the next frame (`beginFrame`), so a host setting values at 60 Hz or faster never shows a half-applied
 * state. Numbers, colors and vectors can be animated (`transition`, in ms). Parameters with `apply: "reload"` are
 * preloaded in the background through the engine's `ReloadHooks` and swapped in at a frame boundary only once ready,
 * so there is never an empty frame.
 *
 * Reads for the bindings go through `ParamReader`: parameters are resolved once to an index, then numeric reads are
 * plain typed-array reads, without allocation.
 */
import type { TLocalizedText, TParamDef, TParams, TPresets } from '@ouaf/spec'
import { ParamError } from './errors.ts'
import {
  checkParamValue,
  componentCount,
  isAnimatable,
  sameValue,
  writeComponents,
  type ParamValue,
  type SelectOptions,
} from './values.ts'

/** A committed change, as reported to `onChange` listeners (and to scripts as the `paramChange` event). */
export interface ParamChange {
  readonly name: string
  readonly value: ParamValue
  readonly previous: ParamValue
}

export type ParamChangeListener = (change: ParamChange) => void

export interface SetParamOptions {
  /**
   * Transition duration in ms for numbers, colors and vectors, overriding the parameter's `transition`; `0` applies
   * the value at once. Ignored for the other types and for `apply: "reload"` parameters.
   */
  transition?: number | undefined
}

/** What the engine must prepare for a reload. */
export interface ReloadRequest {
  /** Values of every parameter the reloaded filter must use (the new values for the parameters in `changed`). */
  readonly values: Readonly<Record<string, ParamValue>>
  /** `apply: "reload"` parameters whose value differs from the one in use. */
  readonly changed: readonly string[]
  /** Aborted when the request is superseded by a newer one or the store is disposed. */
  readonly signal: AbortSignal
}

/**
 * Engine side of `apply: "reload"`. The store decides when to reload and when to swap; loading is the engine's job.
 */
export interface ReloadHooks<R = unknown> {
  /**
   * Prepares the filter for `request.values` in the background, without touching what is being rendered: the
   * current filter keeps rendering until `swap`. Should stop early when `request.signal` is aborted.
   */
  preload(request: ReloadRequest): Promise<R>
  /**
   * Called synchronously at the start of a frame (inside `beginFrame`), once the preload has resolved: switch to the
   * prepared resources now, so that this frame already renders with them. The new values are committed after it
   * returns; if it throws, they are not.
   */
  swap(prepared: R, request: ReloadRequest): void
  /** Releases a prepared result that will never be swapped in (superseded, failed swap, or store disposed). */
  discard?(prepared: R): void
}

export interface ParamStoreOptions<R = unknown> {
  /** The manifest's `presets`. */
  presets?: TPresets | undefined
  /**
   * Engine hooks for `apply: "reload"` parameters. Without them, those parameters are applied at the next frame like
   * `live` ones (there is nothing to preload).
   */
  reload?: ReloadHooks<R> | undefined
  /** Receives errors thrown by listeners and reload failures. Default: `console.error`. */
  onError?: ((err: unknown) => void) | undefined
}

/** `idle`: nothing to reload; `loading`: a preload is running; `ready`: prepared, swapped at the next frame. */
export type ReloadState = 'idle' | 'loading' | 'ready'

/**
 * Allocation-free read access to the parameters, for the bindings evaluator and the renderer.
 *
 * Resolve each parameter once with `indexOf`, then read per frame by index. Numeric parameters expose their current
 * **animated** components in `numbers` (see `offsetOf` / `sizeOf`): `number` → 1, `boolean` → 1 (0 or 1),
 * `vec2` → 2, `vec3` → 3, `color` → 4 (r, g, b, a in 0–1, sRGB as written). `valueAt` gives the committed value (the
 * target of a running transition), for strings, selects and assets.
 */
export interface ParamReader {
  /** Parameter names, in manifest order; the index of a name is its position here. */
  readonly names: readonly string[]
  /** Index of a parameter, `-1` when the manifest does not declare it. */
  indexOf(name: string): number
  /** Declaration of the parameter at `index` (its `type` tells which reads make sense). */
  defAt(index: number): TParamDef
  /** Current numeric components of every numeric parameter, back to back. Updated by `beginFrame`. */
  readonly numbers: Float64Array
  /** Offset of the parameter's components in `numbers`, `-1` for a non-numeric parameter. */
  offsetOf(index: number): number
  /** Number of components of the parameter in `numbers` (0 for a non-numeric parameter). */
  sizeOf(index: number): number
  /** First (or only) component of a numeric parameter: `numbers[offsetOf(index)]`. */
  numberAt(index: number): number
  /** Committed value of the parameter (stored reference, not a copy: do not mutate). */
  valueAt(index: number): ParamValue
  /** Incremented by every `beginFrame` that changed a value or a component; lets readers skip unchanged frames. */
  readonly revision: number
}

interface Slot {
  readonly index: number
  readonly name: string
  readonly def: TParamDef
  /** Goes through the reload hooks. */
  readonly reload: boolean
  readonly animatable: boolean
  readonly offset: number
  readonly size: number
  readonly defaultTransition: number
  /** Committed value. */
  value: ParamValue
  /** Options of a select (the manifest's, or the host's for `from: "host"`; `undefined` until supplied). */
  options: SelectOptions | undefined
  /** Value queued for the next frame. */
  pending: ParamValue
  hasPending: boolean
  /** Transition requested with the pending value, `-1` for the parameter's default. */
  pendingTransition: number
  /** Value requested from the reload hooks (equals `value` when no reload is wanted). */
  reloadTarget: ParamValue
  /** Running transition: elapsed and total time (ms); `duration` 0 when none. */
  elapsed: number
  duration: number
}

interface Ready<R> {
  readonly prepared: R
  readonly request: ReloadRequest
}

const NO_TRANSITION = -1

function checkTransition(ms: number | undefined, param?: string): number {
  if (ms === undefined) return NO_TRANSITION
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new ParamError('invalid-transition', `Invalid transition ${String(ms)}: expected a duration in ms >= 0.`,
      param === undefined ? {} : { param })
  }
  return ms
}

function optionsMap(options: Readonly<Record<string, TLocalizedText>>): SelectOptions {
  return new Map(Object.entries(options))
}

export class ParamStore<R = unknown> implements ParamReader {
  readonly names: readonly string[]
  readonly numbers: Float64Array
  readonly presetNames: readonly string[]
  #revision = 0
  readonly #slots: Slot[]
  readonly #byName = new Map<string, number>()
  readonly #presets: TPresets
  readonly #reload: ReloadHooks<R> | undefined
  readonly #onError: (err: unknown) => void
  /** Transition start and end components, same layout as `numbers`. */
  readonly #from: Float64Array
  readonly #to: Float64Array
  /** Indices of the slots with a pending value, in the order they were first set. */
  readonly #pending: Int32Array
  #pendingCount = 0
  #animating = 0
  #lastNow: number | undefined
  readonly #listeners = new Set<ParamChangeListener>()
  readonly #changes: ParamChange[] = []
  #reloadState: ReloadState = 'idle'
  #generation = 0
  #abort: AbortController | undefined
  #ready: Ready<R> | undefined
  #disposed = false

  /**
   * @param params The manifest's `params` (already validated with `validateManifest`).
   * @throws ParamError when a default value is invalid for its parameter.
   */
  constructor(params: TParams | undefined, options: ParamStoreOptions<R> = {}) {
    this.#presets = options.presets ?? {}
    this.presetNames = Object.keys(this.#presets)
    this.#reload = options.reload
    this.#onError = options.onError ?? ((err) => console.error(err))
    const entries = Object.entries(params ?? {})
    this.names = entries.map(([name]) => name)
    this.#slots = []
    let offset = 0
    for (const [name, def] of entries) {
      const size = componentCount(def)
      const reload = def.apply === 'reload' && this.#reload !== undefined
      const options = def.type === 'select' && !('from' in def.options) ? optionsMap(def.options) : undefined
      const initial: ParamValue = def.type === 'asset' ? null : checkParamValue(name, def, def.default, options)
      this.#byName.set(name, this.#slots.length)
      this.#slots.push({
        index: this.#slots.length,
        name,
        def,
        reload,
        animatable: isAnimatable(def) && def.apply !== 'reload',
        offset: size > 0 ? offset : -1,
        size,
        defaultTransition: def.transition ?? 0,
        value: initial,
        options,
        pending: initial,
        hasPending: false,
        pendingTransition: NO_TRANSITION,
        reloadTarget: initial,
        elapsed: 0,
        duration: 0,
      })
      offset += size
    }
    this.numbers = new Float64Array(offset)
    this.#from = new Float64Array(offset)
    this.#to = new Float64Array(offset)
    this.#pending = new Int32Array(this.#slots.length)
    for (const s of this.#slots) if (s.size > 0) writeComponents(s.def, s.value, this.numbers, s.offset)
  }

  // ParamReader

  get revision(): number {
    return this.#revision
  }

  indexOf(name: string): number {
    return this.#byName.get(name) ?? -1
  }

  defAt(index: number): TParamDef {
    return this.#slotAt(index).def
  }

  offsetOf(index: number): number {
    return this.#slotAt(index).offset
  }

  sizeOf(index: number): number {
    return this.#slotAt(index).size
  }

  numberAt(index: number): number {
    const s = this.#slotAt(index)
    return s.size > 0 ? this.numbers[s.offset]! : NaN
  }

  valueAt(index: number): ParamValue {
    return this.#slotAt(index).value
  }

  // Host side

  /** Committed value of `name` (changes set since the last frame are not visible yet). */
  get(name: string): ParamValue {
    return this.#slot(name).value
  }

  /** Snapshot of all committed values, e.g. for `f.params` (allocates: call it when something changed). */
  values(): Record<string, ParamValue> {
    const out: Record<string, ParamValue> = {}
    for (const s of this.#slots) out[s.name] = s.value
    return out
  }

  /**
   * Sets a parameter. The value is checked now and applied at the start of the next frame; within a frame the last
   * value set wins.
   * @throws ParamError when the name is unknown or the value invalid; nothing is queued then.
   */
  set(name: string, value: unknown, options?: SetParamOptions): void {
    const transition = checkTransition(options?.transition, name)
    const s = this.#slot(name)
    this.#queue(s, checkParamValue(name, s.def, value, s.options), transition)
  }

  /**
   * Sets several parameters at once: all values are checked first and either all are queued, or none (the first
   * invalid one throws).
   * @throws ParamError
   */
  setMany(values: Readonly<Record<string, unknown>>, options?: SetParamOptions): void {
    this.#queueAll(values, checkTransition(options?.transition), undefined)
  }

  /**
   * Applies a preset: sets the parameters it lists (the others keep their value), atomically like `setMany`.
   * @throws ParamError `unknown-preset`, or when a preset value is invalid.
   */
  applyPreset(name: string, options?: SetParamOptions): void {
    const transition = checkTransition(options?.transition)
    const preset = Object.hasOwn(this.#presets, name) ? this.#presets[name] : undefined
    if (!preset) {
      const known = this.presetNames.length ? ` Presets: ${this.presetNames.map((p) => `"${p}"`).join(', ')}.` : ''
      throw new ParamError('unknown-preset', `Unknown preset "${name}".${known}`, { preset: name })
    }
    this.#queueAll(preset, transition, name)
  }

  /**
   * Supplies the options of a select declared with `options: { from: "host" }`, as value → label or as a list of
   * values. They replace the previous ones and are used to check values from now on; the current value is kept.
   * @throws ParamError `not-host-options` or `invalid-options`.
   */
  setOptions(name: string, options: Readonly<Record<string, TLocalizedText>> | readonly string[]): void {
    const s = this.#slot(name)
    if (s.def.type !== 'select' || !('from' in s.def.options)) {
      throw new ParamError('not-host-options', `Parameter "${name}" does not take its options from the host.`, { param: name })
    }
    const map = new Map<string, unknown>()
    const bad = (why: string) =>
      new ParamError('invalid-options', `Invalid options for parameter "${name}": ${why}`, { param: name })
    if (Array.isArray(options)) {
      for (const v of options as unknown[]) {
        if (typeof v !== 'string' || v === '') throw bad('every value must be a non-empty string.')
        map.set(v, v)
      }
    } else if (options && typeof options === 'object') {
      for (const [v, label] of Object.entries(options)) {
        if (v === '') throw bad('values must be non-empty strings.')
        const ok = typeof label === 'string'
          ? label !== ''
          : !!label && typeof label === 'object' && Object.values(label).every((t) => typeof t === 'string' && t !== '')
        if (!ok) throw bad(`the label of "${v}" must be a text or translations { "en": "…" }.`)
        map.set(v, label)
      }
    } else {
      throw bad('expected value → label or a list of values.')
    }
    s.options = map
  }

  /** Current options of a select (`undefined` for a host-supplied list not supplied yet). */
  optionsOf(name: string): SelectOptions | undefined {
    return this.#slot(name).options
  }

  /** Listens to committed changes; returns the function that removes the listener. */
  onChange(listener: ParamChangeListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** State of the `apply: "reload"` machinery. */
  get reloadState(): ReloadState {
    return this.#reloadState
  }

  /** Whether changes are queued for the next frame. */
  get hasPendingChanges(): boolean {
    return this.#pendingCount > 0
  }

  // Engine side

  /**
   * Applies the frame's changes; the engine calls it once at the start of every frame, before evaluating bindings.
   * In order: running transitions advance to `now`, a ready reload is swapped in, queued changes are committed (live
   * ones at once or as a transition starting now, reload ones handed to the preload), then listeners are notified.
   * Allocation-free when nothing changes.
   *
   * @param now Frame time in ms, on any monotonic clock (only differences matter; a clock going back counts as 0).
   * @returns whether a value or a component changed (same as `revision` moving).
   */
  beginFrame(now: number): boolean {
    if (this.#disposed) return false
    const dt = this.#lastNow === undefined ? 0 : Math.max(0, now - this.#lastNow)
    this.#lastNow = now
    let changed = false
    if (this.#animating > 0) changed = this.#advance(dt)
    if (this.#ready) changed = this.#swap(this.#ready) || changed
    if (this.#pendingCount > 0) changed = this.#commitPending() || changed
    if (changed) this.#revision++
    if (this.#changes.length > 0) this.#notify()
    return changed
  }

  /** Stops any reload (the prepared result is discarded) and removes the listeners. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#cancelReload()
    this.#listeners.clear()
    this.#pendingCount = 0
  }

  // Internals

  #slotAt(index: number): Slot {
    const s = this.#slots[index]
    if (!s) throw new RangeError(`No parameter at index ${index}.`)
    return s
  }

  #slot(name: string): Slot {
    const i = this.#byName.get(name)
    if (i === undefined) {
      const known = this.names.length ? ` Parameters: ${this.names.map((n) => `"${n}"`).join(', ')}.` : ''
      throw new ParamError('unknown-param', `Unknown parameter "${name}".${known}`, { param: name })
    }
    return this.#slots[i]!
  }

  #queue(s: Slot, value: ParamValue, transition: number): void {
    if (!s.hasPending) {
      s.hasPending = true
      this.#pending[this.#pendingCount++] = s.index
    }
    s.pending = value
    s.pendingTransition = transition
  }

  #queueAll(values: Readonly<Record<string, unknown>>, transition: number, preset: string | undefined): void {
    const checked: [Slot, ParamValue][] = []
    for (const [name, value] of Object.entries(values)) {
      const i = this.#byName.get(name)
      if (i === undefined) {
        const where = preset === undefined ? '' : ` (preset "${preset}")`
        throw new ParamError('unknown-param', `Unknown parameter "${name}"${where}.`,
          preset === undefined ? { param: name } : { param: name, preset })
      }
      const s = this.#slots[i]!
      checked.push([s, checkParamValue(name, s.def, value, s.options, preset)])
    }
    for (const [s, value] of checked) this.#queue(s, value, transition)
  }

  #advance(dt: number): boolean {
    let changed = false
    for (const s of this.#slots) {
      if (s.duration === 0) continue
      s.elapsed = Math.min(s.duration, s.elapsed + dt)
      const t = s.elapsed / s.duration
      for (let i = s.offset, end = s.offset + s.size; i < end; i++) {
        const v = t >= 1 ? this.#to[i]! : this.#from[i]! + (this.#to[i]! - this.#from[i]!) * t
        if (v !== this.numbers[i]) changed = true
        this.numbers[i] = v
      }
      if (t >= 1) {
        s.duration = 0
        this.#animating--
      }
    }
    return changed
  }

  #commitPending(): boolean {
    let changed = false
    let reloadWanted = false
    const n = this.#pendingCount
    this.#pendingCount = 0
    for (let k = 0; k < n; k++) {
      const s = this.#slots[this.#pending[k]!]!
      s.hasPending = false
      const value = s.pending
      if (s.reload) {
        if (!sameValue(value, s.reloadTarget)) {
          s.reloadTarget = value
          reloadWanted = true
        }
        continue
      }
      if (sameValue(value, s.value)) continue
      const previous = s.value
      s.value = value
      changed = true
      if (s.size > 0) {
        const duration = s.animatable ? (s.pendingTransition === NO_TRANSITION ? s.defaultTransition : s.pendingTransition) : 0
        if (duration > 0) {
          // Start from the value on screen, which may be mid-way through a previous transition.
          for (let i = s.offset, end = s.offset + s.size; i < end; i++) this.#from[i] = this.numbers[i]!
          writeComponents(s.def, value, this.#to, s.offset)
          if (s.duration === 0) this.#animating++
          s.elapsed = 0
          s.duration = duration
        } else {
          if (s.duration > 0) {
            s.duration = 0
            this.#animating--
          }
          writeComponents(s.def, value, this.numbers, s.offset)
        }
      }
      this.#changes.push({ name: s.name, value, previous })
    }
    if (reloadWanted) this.#requestReload()
    return changed
  }

  #requestReload(): void {
    this.#cancelReload()
    const hooks = this.#reload!
    const changed: string[] = []
    const values: Record<string, ParamValue> = {}
    for (const s of this.#slots) {
      values[s.name] = s.reload ? s.reloadTarget : s.value
      if (s.reload && !sameValue(s.reloadTarget, s.value)) changed.push(s.name)
    }
    if (changed.length === 0) return // back to the values in use: nothing to load
    const abort = new AbortController()
    const request: ReloadRequest = { values, changed, signal: abort.signal }
    const generation = ++this.#generation
    this.#abort = abort
    this.#reloadState = 'loading'
    let promise: Promise<R>
    try {
      promise = Promise.resolve(hooks.preload(request))
    } catch (err) {
      promise = Promise.reject(err)
    }
    promise.then(
      (prepared) => {
        if (generation !== this.#generation || this.#disposed) {
          this.#discard(prepared)
          return
        }
        this.#abort = undefined
        this.#ready = { prepared, request }
        this.#reloadState = 'ready'
      },
      (err: unknown) => {
        if (generation !== this.#generation || this.#disposed) return // superseded: the error is expected
        this.#abort = undefined
        this.#reloadState = 'idle'
        this.#resetReloadTargets()
        this.#onError(err)
      },
    )
  }

  #swap(ready: Ready<R>): boolean {
    this.#ready = undefined
    this.#reloadState = 'idle'
    const { prepared, request } = ready
    try {
      this.#reload!.swap(prepared, request)
    } catch (err) {
      this.#discard(prepared)
      this.#resetReloadTargets()
      this.#onError(err)
      return false
    }
    for (const name of request.changed) {
      const s = this.#slots[this.#byName.get(name)!]!
      const previous = s.value
      const value = request.values[name] as ParamValue
      s.value = value
      if (s.size > 0) writeComponents(s.def, value, this.numbers, s.offset)
      this.#changes.push({ name, value, previous })
    }
    return request.changed.length > 0
  }

  /** Aborts the running preload and discards a prepared result not swapped in yet. */
  #cancelReload(): void {
    this.#generation++
    this.#abort?.abort()
    this.#abort = undefined
    if (this.#ready) this.#discard(this.#ready.prepared)
    this.#ready = undefined
    this.#reloadState = 'idle'
  }

  #resetReloadTargets(): void {
    for (const s of this.#slots) if (s.reload) s.reloadTarget = s.value
  }

  #discard(prepared: R): void {
    try {
      this.#reload?.discard?.(prepared)
    } catch (err) {
      this.#onError(err)
    }
  }

  #notify(): void {
    const changes = this.#changes
    const n = changes.length
    for (let i = 0; i < n; i++) {
      const change = changes[i]!
      for (const listener of this.#listeners) {
        try {
          listener(change)
        } catch (err) {
          this.#onError(err)
        }
      }
    }
    changes.length = 0
  }
}
