/**
 * Parameter values: strict validation of host-set values and their numeric form (spec section 9).
 */
import { Color, PACKAGE_MAX_BYTES, type TParamDef } from '@ouaf/spec'
import { ParamError } from './errors.ts'

/**
 * A file supplied for an `asset` parameter. `Blob` and `File` satisfy it. Only the declared MIME type and the size are
 * checked here; the content goes through the untrusted-asset checks of the asset loader (spec sections 10.4 and 15).
 */
export interface AssetFile {
  readonly type: string
  readonly size: number
}

/**
 * Value of a parameter, by type: `number` → number, `boolean` → boolean, `string` / `text` / `select` → string,
 * `color` → hex string as given, `vec2` / `vec3` → frozen tuple, `asset` → `AssetFile` or `null` (none).
 */
export type ParamValue =
  | number
  | boolean
  | string
  | readonly [number, number]
  | readonly [number, number, number]
  | AssetFile
  | null

// Same pattern as the manifest's Color schema (single source: packages/spec).
const COLOR_RE = new RegExp((Color as { pattern?: string }).pattern!)

/**
 * Number of numeric components a parameter exposes to the bindings: 1 for `number` and `boolean` (0 / 1),
 * 2 for `vec2`, 3 for `vec3`, 4 for `color` (r, g, b, a in 0–1), 0 for the others.
 */
export function componentCount(def: TParamDef): number {
  switch (def.type) {
    case 'number':
    case 'boolean':
      return 1
    case 'vec2':
      return 2
    case 'vec3':
      return 3
    case 'color':
      return 4
    default:
      return 0
  }
}

/** Whether a parameter type can be animated by a transition (spec: numbers, colors and vectors). */
export function isAnimatable(def: TParamDef): boolean {
  return def.type === 'number' || def.type === 'color' || def.type === 'vec2' || def.type === 'vec3'
}

function hexDigit(c: number): number {
  // '0'-'9', 'A'-'F', 'a'-'f'; the string has already been checked against the Color pattern.
  return c <= 57 ? c - 48 : (c | 32) - 87
}

/**
 * Writes a hex color (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) as r, g, b, a in 0–1 into `out` at `offset`.
 * The components are the sRGB values as written (no conversion to linear). The color must be valid.
 */
export function writeColor(hex: string, out: Float64Array, offset: number): void {
  const short = hex.length <= 5
  const n = short ? hex.length - 1 : (hex.length - 1) / 2
  for (let i = 0; i < 4; i++) {
    if (i >= n) {
      out[offset + i] = 1
    } else if (short) {
      out[offset + i] = (hexDigit(hex.charCodeAt(1 + i)) * 17) / 255
    } else {
      out[offset + i] = (hexDigit(hex.charCodeAt(1 + 2 * i)) * 16 + hexDigit(hex.charCodeAt(2 + 2 * i))) / 255
    }
  }
}

/** Writes the numeric components of a valid `value` of `def` into `out` at `offset` (see `componentCount`). */
export function writeComponents(def: TParamDef, value: ParamValue, out: Float64Array, offset: number): void {
  switch (def.type) {
    case 'number':
      out[offset] = value as number
      break
    case 'boolean':
      out[offset] = value ? 1 : 0
      break
    case 'color':
      writeColor(value as string, out, offset)
      break
    case 'vec2':
    case 'vec3': {
      const v = value as readonly number[]
      for (let i = 0; i < v.length; i++) out[offset + i] = v[i]!
      break
    }
    default:
  }
}

/** Two valid values of the same parameter are equal (component-wise for vectors, by identity for files). */
export function sameValue(a: ParamValue, b: ParamValue): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  return false
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return isAssetFile(value) ? `a file of type "${value.type}"` : 'an object'
  }
  let s: string
  try {
    s = JSON.stringify(value) ?? String(value)
  } catch {
    s = String(value)
  }
  return s.length > 60 ? `${s.slice(0, 57)}...` : s
}

function isAssetFile(value: unknown): value is AssetFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AssetFile).type === 'string' &&
    typeof (value as AssetFile).size === 'number'
  )
}

function codePointLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    // Count a surrogate pair once, like JSON Schema's maxLength.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

/** MIME type without parameters, lowercased: "Image/SVG+XML; charset=utf-8" → "image/svg+xml". */
function mimeEssence(type: string): string {
  const i = type.indexOf(';')
  return (i < 0 ? type : type.slice(0, i)).trim().toLowerCase()
}

/** Options of a select, value → label: the manifest's, or those supplied by the host. */
export type SelectOptions = ReadonlyMap<string, unknown>

/**
 * Checks a host-set `value` for the parameter `name` and returns the value to store (vectors are copied and frozen,
 * so a later change of the host's array has no effect). Throws a `ParamError` when the value is invalid: it is
 * never clamped, rounded or otherwise fixed.
 *
 * `options` are the current options of a select: the manifest's, or those supplied by the host for
 * `options: { from: "host" }` (`undefined` while the host has not supplied them).
 */
export function checkParamValue(
  name: string,
  def: TParamDef,
  value: unknown,
  options?: SelectOptions,
  preset?: string,
): ParamValue {
  const where = preset === undefined ? `parameter "${name}"` : `parameter "${name}" (preset "${preset}")`
  const fail = (code: ConstructorParameters<typeof ParamError>[0], message: string): never => {
    throw new ParamError(code, `Invalid value for ${where}: ${message}`, preset === undefined ? { param: name } : { param: name, preset })
  }
  switch (def.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('type', `expected a finite number, got ${describe(value)}.`)
      const v = value as number
      if ((def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max)) {
        fail('range', `${v} is outside [${def.min ?? '-∞'}, ${def.max ?? '+∞'}].`)
      }
      return v
    }
    case 'boolean':
      if (typeof value !== 'boolean') fail('type', `expected a boolean, got ${describe(value)}.`)
      return value as boolean
    case 'string':
    case 'text': {
      if (typeof value !== 'string') fail('type', `expected a string, got ${describe(value)}.`)
      const v = value as string
      if (def.maxLength !== undefined && codePointLength(v) > def.maxLength) {
        fail('too-long', `${codePointLength(v)} characters, at most ${def.maxLength} allowed.`)
      }
      return v
    }
    case 'color':
      if (typeof value !== 'string' || !COLOR_RE.test(value)) {
        fail('type', `expected a hex color (#rgb, #rgba, #rrggbb or #rrggbbaa), got ${describe(value)}.`)
      }
      return value as string
    case 'select': {
      if (typeof value !== 'string') fail('type', `expected one of the options (a string), got ${describe(value)}.`)
      const v = value as string
      const fromHost = 'from' in def.options
      // The declared default of a host-supplied list is always accepted, so that the host can reset the parameter.
      if (fromHost && v === def.default) return v
      if (!options) fail('enum', `the host has not supplied the options of this parameter yet.`)
      if (!options!.has(v)) {
        const list = [...options!.keys()].slice(0, 10).map((o) => `"${o}"`).join(', ')
        fail('enum', `"${v}" is not one of the options (${list}${options!.size > 10 ? ', ...' : ''}).`)
      }
      return v
    }
    case 'vec2':
    case 'vec3': {
      const n = def.type === 'vec2' ? 2 : 3
      if (!Array.isArray(value) || value.length !== n || !value.every((c) => typeof c === 'number' && Number.isFinite(c))) {
        fail('type', `expected an array of ${n} finite numbers, got ${describe(value)}.`)
      }
      return Object.freeze([...(value as number[])]) as unknown as ParamValue
    }
    case 'asset': {
      if (value === null) {
        if (!def.optional) fail('required', 'this asset is not optional.')
        return null
      }
      if (!isAssetFile(value)) fail('type', `expected a file (Blob) or null, got ${describe(value)}.`)
      const file = value as AssetFile
      const mime = mimeEssence(file.type)
      // A file without a declared type (an unknown extension, e.g. `.cube`) is judged on its content only, when it
      // is loaded (spec §15); a declared type must be accepted.
      if (mime !== '' && !def.accept.includes(mime)) {
        fail('mime', `type "${file.type}" is not accepted (${def.accept.join(', ')}).`)
      }
      if (!Number.isFinite(file.size) || file.size < 0) fail('type', `invalid file size ${file.size}.`)
      if (def.maxSize !== undefined && file.size > def.maxSize) {
        fail('too-large', `${file.size} bytes, at most ${def.maxSize} allowed.`)
      }
      // No asset of a package can be larger (spec §3), whatever `maxSize` says.
      if (file.size > PACKAGE_MAX_BYTES) fail('too-large', `${file.size} bytes, at most ${PACKAGE_MAX_BYTES} allowed for any asset.`)
      return file
    }
  }
}
