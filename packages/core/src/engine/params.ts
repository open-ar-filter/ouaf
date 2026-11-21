/**
 * Parameters of a filter instance (spec §9), as the engine and layers see them.
 *
 * PROVISIONAL implementation: issue #16 (params runtime: transitions, `apply: reload`, `from: host` options,
 * allocation-free numeric reads for bindings) replaces `SimpleParams`. The engine and layers only depend on
 * `ParamReader` / `FilterParams`; the public handle methods (`setParam`, `setParams`, `applyPreset`) keep their
 * signatures.
 */
import type { TParamDef, TParams, TPresets } from '@ouaf/spec'
import { InvalidParamError } from './errors.ts'

export type ParamValue = number | boolean | string | readonly number[] | null

/** Read-only view of the current values (what layers and bindings read). */
export interface ParamReader {
  /** Current value of `name` (as applied at the start of the frame), undefined for an unknown parameter. */
  get(name: string): ParamValue | undefined
}

export interface ParamChange {
  name: string
  value: ParamValue
  previous: ParamValue
}

/** The engine side of a filter's params. */
export interface FilterParams extends ParamReader {
  /** Validates and queues changes; applied together by the next `applyPending` (spec §9: batched per frame). */
  set(values: Readonly<Record<string, unknown>>): void
  applyPreset(name: string): void
  /** Applies queued changes; returns what changed (empty array when nothing did). Called at the start of a frame. */
  applyPending(): readonly ParamChange[]
  /** All current values (a copy). */
  snapshot(): Record<string, ParamValue>
}

const HEX_COLOR = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const NO_CHANGES: readonly ParamChange[] = Object.freeze([])

/** Defaults, validation and per-frame batching; no transitions, no reload, no asset params yet (#16). */
export class SimpleParams implements FilterParams {
  #defs: Readonly<TParams>
  #presets: Readonly<TPresets>
  #filterId: string
  #values = new Map<string, ParamValue>()
  #pending = new Map<string, ParamValue>()

  constructor(filterId: string, defs: Readonly<TParams> = {}, presets: Readonly<TPresets> = {}, initial: Readonly<Record<string, unknown>> = {}) {
    this.#filterId = filterId
    this.#defs = defs
    this.#presets = presets
    for (const [name, def] of Object.entries(defs)) this.#values.set(name, defaultValue(def))
    for (const [name, value] of Object.entries(initial)) this.#values.set(name, this.#check(name, value))
  }

  get(name: string): ParamValue | undefined {
    return this.#values.get(name)
  }

  set(values: Readonly<Record<string, unknown>>): void {
    // All or nothing: validate every value before queueing any.
    const checked: Array<[string, ParamValue]> = []
    for (const [name, value] of Object.entries(values)) checked.push([name, this.#check(name, value)])
    for (const [name, value] of checked) this.#pending.set(name, value)
  }

  applyPreset(name: string): void {
    const preset = Object.hasOwn(this.#presets, name) ? this.#presets[name] : undefined
    if (!preset) {
      const known = Object.keys(this.#presets)
      throw new InvalidParamError(
        name,
        `Filter "${this.#filterId}" has no preset "${name}"${known.length ? `; presets: ${known.join(', ')}` : ''}.`,
      )
    }
    this.set(preset)
  }

  applyPending(): readonly ParamChange[] {
    if (this.#pending.size === 0) return NO_CHANGES
    const changes: ParamChange[] = []
    for (const [name, value] of this.#pending) {
      const previous = this.#values.get(name) ?? null
      if (sameValue(previous, value)) continue
      this.#values.set(name, value)
      changes.push({ name, value, previous })
    }
    this.#pending.clear()
    return changes
  }

  snapshot(): Record<string, ParamValue> {
    return Object.fromEntries(this.#values)
  }

  #check(name: string, value: unknown): ParamValue {
    const def = Object.hasOwn(this.#defs, name) ? this.#defs[name] : undefined
    const fail = (why: string) => new InvalidParamError(name, `Invalid value for parameter "${name}" of filter "${this.#filterId}": ${why}.`)
    if (!def) {
      const known = Object.keys(this.#defs)
      throw new InvalidParamError(name, `Filter "${this.#filterId}" has no parameter "${name}"${known.length ? `; parameters: ${known.join(', ')}` : ''}.`)
    }
    switch (def.type) {
      case 'number': {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(`expected a finite number, got ${describe(value)}`)
        if (def.min !== undefined && value < def.min) throw fail(`${value} is below the minimum ${def.min}`)
        if (def.max !== undefined && value > def.max) throw fail(`${value} is above the maximum ${def.max}`)
        return value
      }
      case 'boolean':
        if (typeof value !== 'boolean') throw fail(`expected a boolean, got ${describe(value)}`)
        return value
      case 'string':
      case 'text':
        if (typeof value !== 'string') throw fail(`expected a string, got ${describe(value)}`)
        if (def.maxLength !== undefined && value.length > def.maxLength) throw fail(`longer than ${def.maxLength} characters`)
        return value
      case 'color':
        if (typeof value !== 'string' || !HEX_COLOR.test(value)) throw fail(`expected a hex color "#rrggbb" or "#rrggbbaa", got ${describe(value)}`)
        return value
      case 'select': {
        if (typeof value !== 'string') throw fail(`expected an option name, got ${describe(value)}`)
        const options = def.options
        // Options supplied by the host (`from: host`) are checked by #16, which receives them.
        if ('from' in options) return value
        if (!Object.hasOwn(options, value)) throw fail(`unknown option "${value}"; options: ${Object.keys(options).join(', ')}`)
        return value
      }
      case 'vec2':
      case 'vec3': {
        const n = def.type === 'vec2' ? 2 : 3
        if (!Array.isArray(value) || value.length !== n || !value.every((x) => typeof x === 'number' && Number.isFinite(x))) {
          throw fail(`expected [${Array.from({ length: n }, (_, i) => 'xyz'[i]).join(', ')}] (finite numbers), got ${describe(value)}`)
        }
        return Object.freeze([...(value as number[])])
      }
      case 'asset':
        throw fail('asset parameters are not supported yet (issue #16)')
    }
  }
}

function defaultValue(def: TParamDef): ParamValue {
  if (def.type === 'asset') return null
  const d = def.default
  return Array.isArray(d) ? Object.freeze([...d]) : (d as ParamValue)
}

function sameValue(a: ParamValue, b: ParamValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i])
  return a === b
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)
  if (Array.isArray(value)) return `an array of length ${value.length}`
  return value === null ? 'null' : typeof value === 'object' ? 'an object' : String(value)
}
