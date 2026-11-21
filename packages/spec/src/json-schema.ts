/**
 * Published JSON Schema (draft-07) of the manifest, built from the TypeBox schemas.
 *
 * TypeBox inlines a shared schema everywhere it is used (Bindable, LocalizedText, Color…), and the validator relies
 * on that. The published file factors them out instead: every exported schema of this package becomes a `$defs` entry
 * named after its export, and each exact copy of it becomes a `$ref`. Only exact copies are replaced (plus the
 * alternatives of a pure union, see `hoistDefinitions`), so validation, descriptions and `x-*` annotations are kept.
 */
import * as assets from './assets.ts'
import * as bindings from './bindings.ts'
import * as common from './common.ts'
import * as layers from './layers.ts'
import * as manifest from './manifest.ts'
import * as params from './params.ts'
import type { SpecRegistry } from './registry.ts'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

// A spread copy (`{ ...Color, default: '#fff' }`) loses TypeBox's non-enumerable `~kind`: also look at the keywords.
const isSchema = (v: unknown): boolean => isObject(v) && ('~kind' in v || 'type' in v || 'anyOf' in v)

/**
 * Exported TypeBox schemas by export name, then the members of the exported property groups (`LayerBase`,
 * `Anchored`, `ParamCommon`) as `<Group>.<property>`: the names of the published definitions.
 */
function namedSchemas(): Array<[string, unknown]> {
  const schemas: Array<[string, unknown]> = []
  const members: Array<[string, unknown]> = []
  for (const mod of [common, bindings, params, assets, layers, manifest]) {
    for (const [name, value] of Object.entries(mod)) {
      if (name === 'ManifestEnvelope' || !isObject(value)) continue
      if (isSchema(value)) schemas.push([name, value])
      else if (Object.values(value).every(isSchema)) {
        for (const [prop, schema] of Object.entries(value)) members.push([`${name}.${prop}`, schema])
      }
    }
  }
  return [...schemas, ...members]
}

/** Plain JSON copy; registry references (`x-registry`) get the registered names as examples (autocompletion). */
function toJson(schema: unknown, vocab: Record<string, string[]>): Json {
  return JSON.parse(
    JSON.stringify(schema, (_key, value) => {
      const registry = isObject(value) ? value['x-registry'] : undefined
      return typeof registry === 'string' ? { ...value, examples: vocab[registry] } : value
    }),
  ) as Json
}

const ANNOTATIONS = new Set(['description', 'title', '$comment'])

/** A union with no other keyword than annotations: its alternatives can be grouped inside a larger `anyOf`. */
const isPureUnion = (s: Json): s is JsonObject & { anyOf: Json[] } =>
  isObject(s) && Array.isArray(s.anyOf) && s.anyOf.length > 1 &&
  Object.keys(s).every((k) => k === 'anyOf' || ANNOTATIONS.has(k))

/**
 * Moves the named schemas to `$defs` and replaces each exact copy by a `$ref` (outermost copies first).
 * A pure named union whose alternatives appear in a row in a larger `anyOf` (e.g. `Binding` in every Bindable) is
 * referenced there too: `anyOf: [A, B, C]` and `anyOf: [A, { anyOf: [B, C] }]` accept exactly the same values.
 */
export function hoistDefinitions(root: JsonObject, named: Array<[string, Json]>): JsonObject {
  const nameOf = new Map<string, string>()
  for (const [name, schema] of named) {
    const key = JSON.stringify(schema)
    if (!nameOf.has(key)) nameOf.set(key, name)
  }
  const unions = named.map(([, s]) => s).filter(isPureUnion)

  const group = (anyOf: Json[]): Json[] => {
    for (const union of unions) {
      const alts = union.anyOf.map((a) => JSON.stringify(a))
      if (anyOf.length <= alts.length) continue
      for (let i = 0; i + alts.length <= anyOf.length; i++) {
        if (alts.every((a, j) => JSON.stringify(anyOf[i + j]) === a)) {
          anyOf = [...anyOf.slice(0, i), union, ...anyOf.slice(i + alts.length)]
          break
        }
      }
    }
    return anyOf
  }

  const defs: JsonObject = {}
  const replace = (node: Json, isRoot: boolean): Json => {
    if (Array.isArray(node)) return node.map((n) => replace(n, false))
    if (!isObject(node)) return node
    const name = isRoot ? undefined : nameOf.get(JSON.stringify(node))
    if (name !== undefined) {
      if (!(name in defs)) {
        defs[name] = {} // reserved before recursing, in case the schema contains itself
        defs[name] = replace(node, true)
      }
      return { $ref: `#/$defs/${name}` }
    }
    const out: JsonObject = {}
    for (const [k, v] of Object.entries(node)) out[k] = replace(k === 'anyOf' && Array.isArray(v) ? group(v) : v, false)
    return out
  }
  const result = replace(root, true) as JsonObject
  const sorted: JsonObject = {}
  for (const name of Object.keys(defs).sort()) sorted[name] = defs[name]!
  return { ...result, $defs: sorted }
}

/**
 * Indented JSON (2 spaces) that keeps an object or an array on one line when it fits in `width` columns, and fills
 * the lines of a long array of scalars (e.g. `examples`).
 */
export function formatJson(value: Json, width = 120): string {
  const oneLine = (v: Json): string => {
    if (Array.isArray(v)) return `[${v.map(oneLine).join(', ')}]`
    if (!isObject(v)) return JSON.stringify(v)
    const entries = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${oneLine(x)}`)
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`
  }
  const format = (v: Json, indent: string, prefix: number): string => {
    const flat = oneLine(v)
    if (!v || typeof v !== 'object' || indent.length + prefix + flat.length <= width) return flat
    const inner = indent + '  '
    let lines: string[]
    if (Array.isArray(v) && v.every((x) => !x || typeof x !== 'object')) {
      lines = ['']
      for (const item of v.map(oneLine)) {
        const last = lines[lines.length - 1]!
        if (last && inner.length + last.length + item.length + 2 > width) lines.push(item)
        else lines[lines.length - 1] = last ? `${last}, ${item}` : item
      }
    } else if (Array.isArray(v)) {
      lines = v.map((x) => format(x, inner, 0))
    } else {
      lines = Object.entries(v).map(([k, x]) => {
        const key = `${JSON.stringify(k)}: `
        return key + format(x, inner, key.length)
      })
    }
    const [open, close] = Array.isArray(v) ? ['[', ']'] : ['{', '}']
    return `${open}\n${lines.map((l) => inner + l).join(',\n')}\n${indent}${close}`
  }
  return format(value, '', 0)
}

/** The JSON Schema published as docs/spec/ouaf-v1.schema.json, for a given registry. */
export function buildPublishedSchema(reg: SpecRegistry): JsonObject {
  const vocab: Record<string, string[]> = { anchors: [...reg.anchors.keys()], scriptData: [...reg.scriptData.keys()] }
  const draft07 = 'http://json-schema.org/draft-07/schema#'
  const root = toJson({ $schema: draft07, ...manifest.buildManifestSchema(reg) }, vocab)
  const named = namedSchemas().map(([name, schema]): [string, Json] => [name, toJson(schema, vocab)])
  return hoistDefinitions(root as JsonObject, named)
}
