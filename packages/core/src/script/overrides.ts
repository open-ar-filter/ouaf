/**
 * What a filter's script changes on its layers (spec §12.4): `.set()` values and `.animate()` tweens, which replace a
 * property's manifest value (fixed or bound) until the script sets it back to `null`.
 *
 * The bindings compiler wraps every bindable property of a scripted filter (`BindingEnv.overrides`), so layer types
 * need nothing special: they keep evaluating their bindings, and the wrapper returns the script's value when there is
 * one. Values are kept per face **id** (`f.layer(id, face)`) or for every instance (`f.layer(id)`); a value set for
 * every instance clears the per-face values of that property. Animations run on the engine side, on the filter's
 * script clock: the media time, where a backwards jump or a long gap counts as no time (as for sticker playback), so
 * they are deterministic with a file source.
 *
 * With no script value, evaluating a wrapped property costs one check and allocates nothing. While a vector or color
 * animation runs, its evaluation allocates its result.
 */
import type { CompiledBinding, NumberArray, PropertyOverrides, ValueType } from '../bindings/types.ts'
import { easingOf } from './easing.ts'

/** A value the script can give a property: number, boolean, string or color, vector. */
export type OverrideValue = number | boolean | string | readonly number[]

/** `.animate()` options (spec §12.4), times in milliseconds. */
export interface TweenOptions {
  duration: number
  easing?: string
  delay?: number
  repeat?: number
}

interface SetEntry {
  readonly kind: 'set'
  readonly value: OverrideValue
}

interface TweenEntry {
  readonly kind: 'tween'
  /** Target, or `undefined` with keyframes. */
  readonly target: OverrideValue | undefined
  readonly keyframes: readonly OverrideValue[] | undefined
  /** Script clock (s) when the animation was applied. */
  readonly start: number
  readonly delay: number
  readonly duration: number
  /** Extra runs, -1 for endless. */
  readonly repeat: number
  readonly ease: (t: number) => number
  /** Value each face started from (target animations), by face key; captured at its first evaluation. */
  readonly from: Map<number, OverrideValue>
}

type Entry = SetEntry | TweenEntry

/** Key of an instance: the face id, 0 for the screen instance (no face). */
export type FaceKey = number

const COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

function fits(v: unknown, type: ValueType): boolean {
  switch (type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'boolean':
      return typeof v === 'boolean'
    case 'string':
      return typeof v === 'string'
    case 'color':
      return typeof v === 'string' && COLOR.test(v)
    case 'vec2':
    case 'vec3':
      return Array.isArray(v) && v.length === (type === 'vec2' ? 2 : 3) && v.every((x) => typeof x === 'number' && Number.isFinite(x))
  }
}

/** The script values of one property of one layer. */
export class PropertyOverride {
  readonly name: string
  readonly types: readonly ValueType[]
  #all: Entry | undefined
  readonly #faces = new Map<FaceKey, Entry>()
  readonly #clock: ScriptClock
  readonly #check: ((value: string) => string | undefined) | undefined

  constructor(name: string, types: readonly ValueType[], clock: ScriptClock, check?: (value: string) => string | undefined) {
    this.name = name
    this.types = types
    this.#clock = clock
    this.#check = check
  }

  /** The type a value fits, or `undefined`. A string fits a color property only when it is a color. */
  typeOf(value: unknown): ValueType | undefined {
    return this.types.find((t) => fits(value, t))
  }

  /** Why a value of the right type is refused (a content property's name that is not an asset it shows), if it is. */
  problem(value: unknown): string | undefined {
    return this.#check && typeof value === 'string' ? this.#check(value) : undefined
  }

  /** Whether the property can be animated (numbers, colors, vectors). */
  get animatable(): boolean {
    return this.types.some((t) => t !== 'boolean' && t !== 'string')
  }

  get empty(): boolean {
    return this.#all === undefined && this.#faces.size === 0
  }

  /** `.set()`; `face` undefined: every instance. `null` restores the manifest value. */
  set(face: FaceKey | undefined, value: OverrideValue | null): void {
    const entry: Entry | undefined = value === null ? undefined : { kind: 'set', value }
    this.#put(face, entry)
  }

  /** `.animate()`: towards `target`, or through `keyframes`. */
  animate(face: FaceKey | undefined, target: OverrideValue | undefined, keyframes: readonly OverrideValue[] | undefined, options: TweenOptions): void {
    const entry: TweenEntry = {
      kind: 'tween',
      target,
      keyframes,
      start: this.#clock.time,
      delay: Math.max(0, options.delay ?? 0) / 1000,
      duration: Math.max(1e-3, options.duration / 1000),
      repeat: options.repeat === undefined ? 0 : options.repeat < 0 ? -1 : Math.trunc(options.repeat),
      ease: easingOf(options.easing ?? 'inOutQuad') ?? ((t) => t),
      from: new Map(),
    }
    this.#put(face, entry)
  }

  #put(face: FaceKey | undefined, entry: Entry | undefined): void {
    if (face === undefined) {
      this.#all = entry
      this.#faces.clear()
    } else if (entry) this.#faces.set(face, entry)
    else this.#faces.delete(face)
  }

  /** Forgets the values of a face that left (its id is never reused). */
  dropFace(face: FaceKey): void {
    this.#faces.delete(face)
    if (this.#all?.kind === 'tween') this.#all.from.delete(face)
  }

  /** The entry for `face`, or `undefined` when the manifest value applies. */
  entryFor(face: FaceKey): Entry | undefined {
    if (this.#all === undefined && this.#faces.size === 0) return undefined
    return this.#faces.get(face) ?? this.#all
  }

  /** Value of `entry` for `face`; `current` gives the manifest value (the starting point of a target animation). */
  valueOf(entry: Entry, face: FaceKey, current: () => unknown): OverrideValue {
    if (entry.kind === 'set') return entry.value
    const t = this.#clock.time - entry.start - entry.delay
    const values = entry.keyframes
    let from: OverrideValue | undefined
    if (!values) {
      from = entry.from.get(face)
      if (from === undefined) {
        from = current() as OverrideValue
        entry.from.set(face, from)
      }
    }
    if (t < 0) return values ? values[0]! : from!
    const run = Math.floor(t / entry.duration)
    if (entry.repeat >= 0 && run > entry.repeat) {
      const end = values ? values[values.length - 1]! : entry.target!
      // Finished: the final value stays set, as with `.set()`.
      this.#replace(entry, { kind: 'set', value: end })
      return end
    }
    const p = entry.ease((t - run * entry.duration) / entry.duration)
    if (!values) return mix(from!, entry.target!, p)
    const x = Math.min(Math.max(p, 0), 1) * (values.length - 1)
    const i = Math.min(Math.floor(x), values.length - 2)
    // Overshooting easings (Back, Elastic) extrapolate the first or last segment.
    return mix(values[i]!, values[i + 1]!, p < 0 ? p * (values.length - 1) : p > 1 ? 1 + (p - 1) * (values.length - 1) : x - i)
  }

  #replace(old: Entry, entry: Entry): void {
    if (this.#all === old) this.#all = entry
    for (const [k, v] of this.#faces) if (v === old) this.#faces.set(k, entry)
  }
}

/** Interpolates numbers, vectors and colors (`#rrggbb[aa]`, in sRGB components). */
function mix(a: OverrideValue, b: OverrideValue, t: number): OverrideValue {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x: number, i: number) => x + ((b[i] as number) - x) * t)
  if (typeof a === 'string' && typeof b === 'string') return mixColor(a, b, t)
  return t < 1 ? a : b
}

function rgba(hex: string): [number, number, number, number] {
  let h = hex.slice(1)
  if (h.length <= 4) h = [...h].map((c) => c + c).join('')
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255]
}

function mixColor(a: string, b: string, t: number): string {
  const x = rgba(a)
  const y = rgba(b)
  const c = x.map((v, i) => Math.round(Math.min(255, Math.max(0, v + (y[i]! - v) * t))))
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** Media-time clock of a filter's script values (s): advances with the frame time, a jump back or a gap is no time. */
export class ScriptClock {
  time = 0
  #last = -1

  advance(frameTime: number): void {
    if (this.#last >= 0) {
      const dt = frameTime - this.#last
      if (dt > 0 && dt <= 1) this.time += dt
    }
    this.#last = frameTime
  }
}

/** The script values of every layer of a filter. */
export class ScriptOverrides {
  readonly clock = new ScriptClock()
  /** Face key of a face slot this frame (set by the engine before the layers update). */
  idOf: (slot: number) => FaceKey = () => 0
  readonly #layers: Array<Map<string, PropertyOverride>> = []

  /** The registry of layer `index`, for the bindings compiler. */
  forLayer(index: number): PropertyOverrides {
    const props = (this.#layers[index] ??= new Map())
    return {
      wrap: (name, types, binding) => {
        // A property compiled twice (same name) shares its script values.
        let prop = props.get(name)
        if (!prop) props.set(name, (prop = new PropertyOverride(name, types, this.clock)))
        return new OverridableBinding(binding, prop, this) as unknown as typeof binding
      },
      content: (name, check) => {
        const prop = new PropertyOverride(name, ['string'], this.clock, check)
        props.set(name, prop)
        return {
          get: (face) => {
            if (prop.empty) return undefined
            const entry = prop.entryFor(this.idOf(face))
            return entry?.kind === 'set' ? (entry.value as string) : undefined
          },
        }
      },
    }
  }

  /** Property `name` of layer `index`, or `undefined` when it cannot be set (structural, unknown). */
  property(index: number, name: string): PropertyOverride | undefined {
    return this.#layers[index]?.get(name)
  }

  /** Names of the settable properties of layer `index`. */
  propertiesOf(index: number): string[] {
    return [...(this.#layers[index]?.keys() ?? [])]
  }

  dropFace(face: FaceKey): void {
    for (const props of this.#layers) for (const p of props?.values() ?? []) p.dropFace(face)
  }
}

/** A compiled binding whose value the script can replace. */
class OverridableBinding implements CompiledBinding<unknown> {
  readonly kind: CompiledBinding<unknown>['kind']
  /** The script may set a value per face. */
  readonly perFace = true
  readonly #inner: CompiledBinding<unknown> & { write?(face: number, out: NumberArray, index: number): void }
  readonly #prop: PropertyOverride
  readonly #owner: ScriptOverrides

  constructor(inner: CompiledBinding<unknown>, prop: PropertyOverride, owner: ScriptOverrides) {
    this.kind = inner.kind
    this.#inner = inner
    this.#prop = prop
    this.#owner = owner
  }

  evaluate(face: number): unknown {
    const prop = this.#prop
    if (prop.empty) return this.#inner.evaluate(face)
    const key = this.#owner.idOf(face)
    const entry = prop.entryFor(key)
    if (!entry) return this.#inner.evaluate(face)
    return prop.valueOf(entry, key, () => this.#inner.evaluate(face))
  }

  write(face: number, out: NumberArray, index: number): void {
    const prop = this.#prop
    if (prop.empty) {
      this.#inner.write!(face, out, index)
      return
    }
    out[index] = this.evaluate(face) as number
  }
}
