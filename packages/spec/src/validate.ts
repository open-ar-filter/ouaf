/**
 * Validation of an Ouaf v1 manifest, with explicit, actionable errors
 * (designed for humans and AI agents alike): JSON pointer, message, fix hint.
 */
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import { ManifestEnvelope, type TManifest } from './manifest.ts'
import { ParamTypes, type ParamTypeName } from './params.ts'
import { createRegistry, findEvent, type DataPathDef, type SpecRegistry } from './registry.ts'
import { assetKind, kindFromPath, type TAssetEntry, type TAssetKind } from './assets.ts'
import { CONTENT_KINDS, CONTENT_PARAM_TYPES, contentMediaTypes, contentProperties, isAssetBinding, type ContentKind } from './content.ts'
import type { TShaderLayer } from './layers.ts'
import { shaderNameProblem, shaderUses } from './shader.ts'
import { mapKeyValue } from './bindings.ts'

export type Severity = 'error' | 'warning'

export interface Issue {
  severity: Severity
  /** Stable code, usable for translation or filtering. */
  code: string
  /** JSON pointer to the offending element, e.g. "/layers/2/anchor". */
  path: string
  message: string
  hint?: string
}

export interface ValidationResult {
  ok: boolean
  errors: Issue[]
  warnings: Issue[]
}

/** What the validator can read besides the manifest (a package validator has the files; the engine does not). */
export interface ManifestFiles {
  /**
   * Source of the shader file at `path` (`assets/….frag`), or `undefined` when it cannot be read. With it, a shader
   * that uses a face-tracking input (`ouaf_faceMask`, `ouaf_faceCount`, `ouaf_faceSize`) uses the face (spec §11.1).
   */
  shaderSource?(path: string): string | undefined
}

type Json = Record<string, unknown>

// ---------------------------------------------------------------------------------------------
// Suggestions

/** Common words (English and French) mapped to anchor names, for friendlier suggestions. */
const SYNONYMS: Record<string, string> = {
  nose: 'noseTip', eye: 'leftEye', lips: 'mouth', lip: 'upperLip', cheek: 'leftCheek', face: 'head', top: 'forehead',
  temple: 'leftTemple', jaw: 'chin',
  nez: 'noseTip', bouche: 'mouth', menton: 'chin', front: 'forehead', yeux: 'eyes', tete: 'head', tête: 'head',
  oeil: 'leftEye', œil: 'leftEye', joue: 'leftCheek', levre: 'upperLip', lèvre: 'upperLip', ecran: 'screen', écran: 'screen',
}

function levenshtein(a: string, b: string): number {
  const n = b.length
  const row = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[n]!
}

/** Returns the closest candidate, or undefined if nothing is close enough. */
export function closest(input: string, candidates: Iterable<string>): string | undefined {
  const list = [...candidates]
  const syn = SYNONYMS[input.toLowerCase()]
  if (syn && list.includes(syn)) return syn
  const lower = input.toLowerCase()
  const ci = list.find((c) => c.toLowerCase() === lower)
  if (ci) return ci
  let best: string | undefined
  let bestD = Infinity
  for (const c of list) {
    const d = levenshtein(lower, c.toLowerCase())
    if (d < bestD) (best = c), (bestD = d)
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined
}

function listOf(values: Iterable<string>, max = 12): string {
  const all = [...values]
  const shown = all.slice(0, max).map((v) => `"${v}"`).join(', ')
  return all.length > max ? `${shown}… (${all.length} in total)` : shown
}

function didYouMean(input: string, candidates: Iterable<string>, wrap = (s: string) => s): string {
  const c = closest(input, candidates)
  return c ? `Did you mean "${wrap(c)}"? ` : ''
}

// ---------------------------------------------------------------------------------------------
// Structural errors (TypeBox) → issues

type SchemaNode = Record<string, unknown>
type ValueError = ReturnType<typeof Value.Errors>[number]
type SchemaKind = 'Object' | 'Record' | 'Tuple' | 'Array' | 'Union' | 'String' | 'Number' | 'Integer' | 'Boolean' | 'Unknown'

/** Structural kind of a schema node, read from its JSON Schema keywords (independent of TypeBox internals). */
function kindOf(schema: unknown): SchemaKind {
  const s = (schema ?? {}) as SchemaNode
  if (Array.isArray(s.anyOf)) return 'Union'
  switch (s.type) {
    case 'object': return s.patternProperties && !s.properties ? 'Record' : 'Object'
    case 'array': return Array.isArray(s.items) || Array.isArray(s.prefixItems) ? 'Tuple' : 'Array'
    case 'string': return 'String'
    case 'number': return 'Number'
    case 'integer': return 'Integer'
    case 'boolean': return 'Boolean'
    default: return 'Unknown'
  }
}

/** Resolves a JSON pointer ("#/properties/x") inside a schema. */
function resolve(root: unknown, pointer: string): SchemaNode {
  let cur: unknown = root
  for (const raw of pointer.replace(/^#/, '').split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') break
    cur = (cur as SchemaNode)[raw.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return (cur && typeof cur === 'object' ? cur : {}) as SchemaNode
}

function literalOptions(schema: SchemaNode): string[] | undefined {
  const anyOf = schema.anyOf as SchemaNode[] | undefined
  if (!anyOf) return undefined
  const consts = anyOf.map((s) => s.const)
  return consts.every((c) => typeof c === 'string') ? (consts as string[]) : undefined
}

function typeName(schema: SchemaNode): string {
  switch (kindOf(schema)) {
    case 'Number': return 'a number'
    case 'Integer': return 'an integer'
    case 'String': return 'a string'
    case 'Boolean': return 'true or false'
    case 'Object': return 'an object { … }'
    case 'Record': return 'an object { … }'
    case 'Array': return 'a list [ … ]'
    case 'Tuple': return `a list of ${(schema.items as unknown[]).length} numbers`
    default: return 'a different value'
  }
}

function fromValueError(root: TSchema, value: unknown, e: ValueError, base: string): Issue[] {
  const path = base + e.instancePath
  const node = resolve(root, e.schemaPath)
  const actual = Value.Pointer.Get(value, e.instancePath)
  const hint = typeof node['x-hint'] === 'string' ? node['x-hint'] : typeof node.description === 'string' ? node.description : undefined
  const one = (code: string, message: string, h = hint, at = path): Issue[] => [
    { severity: 'error', code, path: at, message, ...(h ? { hint: h } : {}) },
  ]
  const params = (e.params ?? {}) as Record<string, unknown>

  switch (e.keyword) {
    case 'required':
      return ((params.requiredProperties as string[]) ?? []).flatMap((name) =>
        one('required', `Missing required property "${name}".`, undefined, `${path}/${name}`))
    case 'additionalProperties': {
      const known = Object.keys((node.properties as SchemaNode) ?? {})
      return ((params.additionalProperties as string[]) ?? []).flatMap((name) =>
        one('unknown-property', `Unknown property "${name}". ${didYouMean(name, known)}`.trim(),
          `Accepted properties here: ${listOf(known, 20)}.`, `${path}/${name}`))
    }
    case 'anyOf': {
      const options = literalOptions(node)
      if (options && typeof actual === 'string') {
        return one('enum', `Unrecognized value "${actual}". ${didYouMean(actual, options)}`.trim(), `Possible values: ${listOf(options)}.`)
      }
      if (options) return one('enum', 'Unrecognized value.', `Possible values: ${listOf(options)}.`)
      return one('type', 'This form of value is not accepted.')
    }
    case 'enum': {
      const options = ((params.allowedValues ?? node.enum) as unknown[]).map(String)
      return typeof actual === 'string'
        ? one('enum', `Unrecognized value "${actual}". ${didYouMean(actual, options)}`.trim(), `Possible values: ${listOf(options)}.`)
        : one('enum', 'Unrecognized value.', `Possible values: ${listOf(options)}.`)
    }
    case 'const':
      return one('literal', `Expected value: ${JSON.stringify(node.const)}.`)
    case 'pattern':
      return one('format', `Invalid format: ${JSON.stringify(actual)}.`)
    case 'maxLength':
      return one('too-long', `Text too long (maximum ${node.maxLength} characters).`)
    case 'minLength':
      return one('too-short', 'Text too short or empty.')
    case 'minimum':
      return one('range', `Value ${actual} is too small: minimum is ${node.minimum}.`)
    case 'maximum':
      return one('range', `Value ${actual} is too large: maximum is ${node.maximum}.`)
    case 'exclusiveMinimum':
      return one('range', `Value ${actual} is too small: must be greater than ${node.exclusiveMinimum}.`)
    case 'maxItems':
      return one('too-many', `Too many items (maximum ${node.maxItems}).`)
    case 'minItems':
      return one('too-few', `Not enough items (minimum ${node.minItems}).`)
    case 'uniqueItems':
      return one('duplicate', 'The list contains duplicates.')
    case 'maxProperties':
      return one('too-many', `Too many entries (maximum ${node.maxProperties}).`)
    case 'boolean':
      return [] // "false" sub-schema (e.g. additionalProperties: false): reported by its parent keyword
    default:
      return one('type', `Invalid value: expected ${typeName(node)}.`)
  }
}

/** Structural errors of a value against a schema, at most one per path. */
function structural(schema: TSchema, value: unknown, base: string, out: Issue[]): void {
  const errors = Value.Errors(schema, value)
  // Errors inside the branches of a failed union are noise: the union error itself is reported.
  const unions = errors.filter((e) => e.keyword === 'anyOf').map((e) => `${e.schemaPath}/anyOf/`)
  const seen = new Set<string>()
  for (const e of errors) {
    if (unions.some((u) => e.schemaPath.startsWith(u))) continue
    for (const issue of fromValueError(schema, value, e, base)) {
      // One error per path, and none below an element that was already reported.
      if ([...seen].some((p) => issue.path === p || issue.path.startsWith(`${p}/`))) continue
      seen.add(issue.path)
      out.push(issue)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Semantic checks

const PARAM_COMPAT: Record<string, ParamTypeName[]> = {
  Number: ['number'],
  Integer: ['number'],
  Boolean: ['boolean'],
  String: ['string', 'text', 'select', 'color'],
  Color: ['color'],
  Vec2: ['vec2'],
  Vec3: ['vec3'],
}

/** Kinds of value a property accepts: one, or one per member of a union (e.g. shader `uniforms`). */
function valueKinds(schema: TSchema): string[] {
  const s = schema as SchemaNode
  const kind = kindOf(s)
  if (kind === 'String' && typeof s.pattern === 'string' && s.pattern.startsWith('^#(')) return ['Color']
  if (kind === 'Tuple') return [(s.items as unknown[]).length === 2 ? 'Vec2' : 'Vec3']
  if (kind === 'Union') return (s.anyOf as TSchema[]).flatMap(valueKinds)
  return [kind]
}

function isBinding(v: unknown): v is { param?: string; bind?: string } {
  return !!v && typeof v === 'object' && !Array.isArray(v) && ('param' in v || 'bind' in v)
}

interface Ctx {
  reg: SpecRegistry
  manifest: TManifest
  errors: Issue[]
  warnings: Issue[]
  usedAssets: Set<string>
  usesFace: boolean
  /** The face-tracking inputs read by shader sources, for the `requires-face` message: "ouaf_faceMask in layer "x"". */
  shaderFaceUses: string[]
  files: ManifestFiles
  /** Blendshapes are read by a binding or by the script (whose default data includes them). */
  usesBlendshapes: boolean
}

function err(ctx: Ctx, code: string, path: string, message: string, hint?: string) {
  ctx.errors.push({ severity: 'error', code, path, message, ...(hint ? { hint } : {}) })
}
function warn(ctx: Ctx, code: string, path: string, message: string, hint?: string) {
  ctx.warnings.push({ severity: 'warning', code, path, message, ...(hint ? { hint } : {}) })
}

function checkAnchor(ctx: Ctx, name: string, path: string) {
  const a = ctx.reg.anchors.get(name)
  if (!a) {
    err(ctx, 'unknown-anchor', path, `Unknown anchor "${name}". ${didYouMean(name, ctx.reg.anchors.keys())}`.trim(),
      `Available anchors: ${listOf(ctx.reg.anchors.keys(), 20)}.`)
    return
  }
  if (a.subject === 'face') ctx.usesFace = true
}

function checkAssetRef(ctx: Ctx, ref: string, path: string) {
  if (ref.startsWith('builtin:')) {
    const name = ref.slice('builtin:'.length)
    if (!ctx.reg.builtins.has(name)) {
      err(ctx, 'unknown-builtin', path, `Unknown built-in resource "${ref}". ${didYouMean(name, ctx.reg.builtins.keys(), (c) => `builtin:${c}`)}`.trim(),
        `Available: ${listOf([...ctx.reg.builtins.keys()].map((b) => `builtin:${b}`), 20)}.`)
    }
    return
  }
  const assets = (ctx.manifest.assets ?? {}) as Record<string, TAssetEntry>
  if (ref.startsWith('assets/')) {
    const declared = Object.entries(assets).find(([, e]) => (typeof e === 'string' ? e : 'src' in e ? e.src : undefined) === ref)
    if (declared) ctx.usedAssets.add(declared[0])
    return
  }
  if (!(ref in assets)) {
    err(ctx, 'unknown-asset', path, `Unknown asset "${ref}". ${didYouMean(ref, Object.keys(assets))}`.trim(),
      `Declare it in "assets", e.g. "assets": { "${ref}": "assets/${ref}.png" }.`)
    return
  }
  ctx.usedAssets.add(ref)
}

function checkBinding(ctx: Ctx, b: { param?: string; bind?: string }, valueSchema: TSchema, path: string) {
  const expected = valueKinds(valueSchema)
  if (b.param !== undefined) {
    const def = ctx.manifest.params?.[b.param]
    if (!def) {
      err(ctx, 'unknown-param', `${path}/param`, `Unknown parameter "${b.param}". ${didYouMean(b.param, Object.keys(ctx.manifest.params ?? {}))}`.trim(),
        'Declare it in "params".')
      return
    }
    const ok = expected.every((k) => PARAM_COMPAT[k]) ? [...new Set(expected.flatMap((k) => PARAM_COMPAT[k]!))] : undefined
    if (ok && !ok.includes(def.type as ParamTypeName)) {
      err(ctx, 'param-type-mismatch', `${path}/param`,
        `Parameter "${b.param}" has type "${def.type}", which does not fit this property.`,
        `Parameter types accepted here: ${listOf(ok)}.`)
    }
    return
  }
  if (b.bind !== undefined) {
    const d = ctx.reg.data.get(b.bind)
    if (!d) {
      const prefix = b.bind.split('.').slice(0, -1).join('.')
      const candidates = [...ctx.reg.data.keys()]
      const near = candidates.filter((c) => c.startsWith(prefix))
      err(ctx, 'unknown-data-path', `${path}/bind`, `Unknown data path "${b.bind}". ${didYouMean(b.bind, candidates)}`.trim(),
        `Example paths: ${listOf(near.length ? near : candidates, 10)}.`)
      return
    }
    if (b.bind.startsWith('face.')) ctx.usesFace = true
    if (b.bind.startsWith('face.blendshapes.')) ctx.usesBlendshapes = true
    const m = b as { map?: unknown; range?: unknown; to?: unknown }
    if (m.map === undefined && m.range === undefined && m.to === undefined && !plainBindFits(d.type, expected)) {
      const wants = [...new Set(expected.map((k) => KIND_NAME[k] ?? k.toLowerCase()))].join(' or ')
      err(ctx, 'binding-map-required', path, `"${b.bind}" is a ${d.type}, this property expects ${wants}: add "map" to convert it.`,
        d.type === 'number'
          ? `E.g. { "bind": "${b.bind}", "map": { "0": …, "1": … }, "default": … }, with values of the property's type.`
          : `E.g. { "bind": "${b.bind}", "map": { ${d.type === 'boolean' ? '"true": …, "false": …' : '"happy": …'} }, "default": … }.`)
    }
    if ((m.range === undefined) !== (m.to === undefined)) {
      err(ctx, 'binding-range', path, '"range" and "to" go together.', 'E.g. { "bind": "face.blendshapes.jawOpen", "range": [0, 1], "to": [0.1, 0.6] }.')
    }
    if (m.map && typeof m.map === 'object' && !Array.isArray(m.map)) checkMapKeys(ctx, b.bind, d.type, m.map as Json, `${path}/map`)
  }
}

/** Names of the property kinds (`valueKinds`) in messages. */
const KIND_NAME: Record<string, string> = { Number: 'a number', Integer: 'a number', String: 'a text', Boolean: 'a boolean', Color: 'a color', Vec2: 'a [x, y] vector', Vec3: 'an [x, y, z] vector' }

/**
 * Whether data of `type` feeds a property of kinds `expected` without `map` (spec §8, as the engine compiles it):
 * numbers into a number or a text, strings into a text, booleans into a boolean.
 */
function plainBindFits(type: DataPathDef['type'], expected: string[]): boolean {
  if (type === 'number') return expected.some((k) => k === 'Number' || k === 'Integer' || k === 'String')
  return expected.includes(type === 'string' ? 'String' : 'Boolean')
}

/** `map` keys that can never match data of `type` (spec §8): the entry is dead, the binding gives its `default`. */
function checkMapKeys(ctx: Ctx, bind: string, type: DataPathDef['type'], map: Json, path: string) {
  if (type === 'string') return
  for (const key of Object.keys(map)) {
    if (mapKeyValue(key, type) !== undefined) continue
    const at = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
    if (type === 'boolean') {
      warn(ctx, 'binding-map-key', at, `"map" key "${key}" never matches: "${bind}" is a boolean, only "true" and "false" match.`,
        'Use the keys "true" and "false".')
      continue
    }
    const n = Number(key)
    const canonical = key.trim() !== '' && Number.isFinite(n) ? String(n) : undefined
    warn(ctx, 'binding-map-key', at, `"map" key "${key}" never matches: "${bind}" is a number, and keys match a number only when written as JSON writes it.`,
      canonical !== undefined ? `Write the key "${canonical}".` : 'Use number keys such as "0", "1" or "0.5", or "range"/"to" for a continuous value.')
  }
}

const pointerKey = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')

/** Kind of the asset a reference names (spec §10.1), when it can be told. */
function refKind(ctx: Ctx, ref: string): TAssetKind | undefined {
  if (ref.startsWith('builtin:')) return ctx.reg.builtins.get(ref.slice('builtin:'.length))?.kind
  if (ref.startsWith('assets/')) return kindFromPath(ref)
  const entry = ((ctx.manifest.assets ?? {}) as Record<string, TAssetEntry | undefined>)[ref]
  return entry === undefined ? undefined : assetKind(entry)
}

/** What a content property gets for a value without an asset, in messages. */
const NO_ASSET: Record<ContentKind, string> = {
  image: 'the layer is hidden',
  model: 'the layer is hidden',
  font: 'the text uses the default font',
  lut: 'no LUT applies',
}

/**
 * A content property bound to a parameter (spec §8, §9): an `asset` parameter whose `accept` types the property can
 * show, or a `select` / `string` parameter whose `map` gives an asset of the right kind for its values.
 */
function checkContentBinding(ctx: Ctx, b: { param: string; map?: Record<string, string> }, kind: ContentKind, path: string) {
  const params = ctx.manifest.params ?? {}
  const def = params[b.param]
  if (!def) {
    err(ctx, 'unknown-param', `${path}/param`, `Unknown parameter "${b.param}". ${didYouMean(b.param, Object.keys(params))}`.trim(), 'Declare it in "params".')
    return
  }
  const label = CONTENT_KINDS[kind].label
  if (!CONTENT_PARAM_TYPES.includes(def.type as ParamTypeName)) {
    err(ctx, 'param-type-mismatch', `${path}/param`,
      `Parameter "${b.param}" has type "${def.type}": an asset property follows an "asset" parameter (a file from the host) or a "select" or "string" parameter with "map".`,
      `E.g. "${b.param}": { "type": "asset", "accept": ${JSON.stringify(contentMediaTypes(kind).slice(0, 2))} }.`)
    return
  }
  if (def.type === 'asset') {
    if (b.map !== undefined) {
      err(ctx, 'binding-map-unexpected', `${path}/map`, `"${b.param}" is an asset parameter: its file is shown as it is, "map" does not apply.`,
        'Remove "map"; to choose among the filter\'s own assets, bind a "select" parameter with "map".')
    }
    const allowed = contentMediaTypes(kind)
    def.accept.forEach((type, i) => {
      if (allowed.includes(type)) return
      err(ctx, 'asset-accept', `/params/${pointerKey(b.param)}/accept/${i}`,
        `Parameter "${b.param}" accepts "${type}", but it is bound to ${path}, which shows ${label}.`,
        `Media types accepted for ${label}: ${listOf(allowed)}.`)
    })
    return
  }
  if (b.map === undefined) {
    err(ctx, 'binding-map-required', path, `"${b.param}" is a ${def.type} parameter: add "map" from its values to asset references.`,
      `E.g. { "param": "${b.param}", "map": { "<value>": "<asset name>" } }.`)
    return
  }
  for (const [key, ref] of Object.entries(b.map)) {
    const at = `${path}/map/${pointerKey(key)}`
    const before = ctx.errors.length
    checkAssetRef(ctx, ref, at)
    if (ctx.errors.length !== before) continue
    const k = refKind(ctx, ref)
    if (k !== undefined && !CONTENT_KINDS[kind].kinds.includes(k)) {
      err(ctx, 'asset-kind', at, `"${ref}" is a ${k} asset: this property shows ${CONTENT_KINDS[kind].assets}.`,
        `Map "${key}" to ${CONTENT_KINDS[kind].assets}.`)
    }
  }
  if (def.type === 'select' && !('from' in def.options)) {
    const options = Object.keys(def.options)
    for (const option of options) {
      if (Object.hasOwn(b.map, option)) continue
      warn(ctx, 'binding-map-missing', `${path}/map`, `Option "${option}" of "${b.param}" has no entry in "map": when it is chosen, ${NO_ASSET[kind]}.`,
        `Add "${option}": "<asset name>" to "map".`)
    }
    for (const key of Object.keys(b.map)) {
      if (options.includes(key)) continue
      warn(ctx, 'binding-map-key', `${path}/map/${pointerKey(key)}`, `"map" key "${key}" is not an option of "${b.param}": it never matches.`,
        `${didYouMean(key, options)}Options: ${listOf(options)}.`)
    }
  }
}

/** Walks a value along its schema for semantic checks (anchors, assets, bindings). */
function walk(ctx: Ctx, value: unknown, schema: TSchema, path: string): void {
  const s = schema as TSchema & Record<string, unknown>
  if (value === undefined) return
  if (s['x-content'] && isAssetBinding(value)) {
    checkContentBinding(ctx, value, s['x-content'] as ContentKind, path)
    return
  }
  if (s['x-bindable'] && isBinding(value)) {
    checkBinding(ctx, value, (s.anyOf as TSchema[])[0]!, path)
    return
  }
  if (typeof value === 'string') {
    if (s['x-registry'] === 'anchors') checkAnchor(ctx, value, path)
    if (s['x-ref'] === 'asset') checkAssetRef(ctx, value, path)
  }
  if (s.anyOf) {
    const branch = (s.anyOf as TSchema[]).find((b) => Value.Check(b, value))
    if (branch) walk(ctx, value, branch, path)
    return
  }
  if (kindOf(s) === 'Object' && value && typeof value === 'object') {
    for (const [k, sub] of Object.entries((s.properties ?? {}) as Record<string, TSchema>)) {
      walk(ctx, (value as Json)[k], sub, `${path}/${k}`)
    }
    return
  }
  if (kindOf(s) === 'Record' && value && typeof value === 'object') {
    const sub = Object.values((s.patternProperties ?? {}) as Record<string, TSchema>)[0]
    if (sub) for (const [k, v] of Object.entries(value as Json)) walk(ctx, v, sub, `${path}/${k}`)
    return
  }
  if (kindOf(s) === 'Array' && Array.isArray(value)) {
    value.forEach((v, i) => walk(ctx, v, s.items as TSchema, `${path}/${i}`))
  }
}

function checkParams(ctx: Ctx) {
  const params = ctx.manifest.params ?? {}
  for (const [name, def] of Object.entries(params)) {
    const p = `/params/${name}`
    if (def.type === 'number') {
      const { min, max, default: d } = def as { min?: number; max?: number; default: number }
      if (min !== undefined && max !== undefined && min > max) err(ctx, 'range', p, `"min" (${min}) is greater than "max" (${max}).`)
      if ((min !== undefined && d < min) || (max !== undefined && d > max)) err(ctx, 'range', `${p}/default`, `Default value ${d} is outside [${min}, ${max}].`)
    }
    if (def.type === 'select') {
      const { options, default: d } = def as { options: Record<string, unknown>; default: string }
      if (!('from' in options) && !(d in options)) {
        err(ctx, 'enum', `${p}/default`, `Default value "${d}" is not one of the options. ${didYouMean(d, Object.keys(options))}`.trim(),
          `Options: ${listOf(Object.keys(options))}.`)
      }
    }
    for (const dep of Object.keys((def as { visibleIf?: Json }).visibleIf ?? {})) {
      if (!(dep in params)) err(ctx, 'unknown-param', `${p}/visibleIf/${dep}`, `visibleIf refers to an unknown parameter "${dep}".`)
    }
  }
  for (const [preset, values] of Object.entries(ctx.manifest.presets ?? {})) {
    for (const [name, v] of Object.entries(values)) {
      const p = `/presets/${preset}/${name}`
      const def = params[name]
      if (!def) {
        err(ctx, 'unknown-param', p, `Preset "${preset}" sets an unknown parameter "${name}". ${didYouMean(name, Object.keys(params))}`.trim())
        continue
      }
      const schema = (ParamTypes[def.type as ParamTypeName] as unknown as { properties: { default: TSchema } }).properties.default
      if (!Value.Check(schema, v)) err(ctx, 'preset-invalid', p, `Invalid value for "${name}" (type ${def.type}).`)
      const { min, max } = def as { min?: number; max?: number }
      if (typeof v === 'number' && ((min !== undefined && v < min) || (max !== undefined && v > max))) {
        err(ctx, 'range', p, `Value ${v} is outside [${min}, ${max}].`)
      }
    }
  }
}

function checkEvents(ctx: Ctx) {
  const check = (name: string, path: string) => {
    const e = findEvent(ctx.reg, name)
    if (!e) {
      err(ctx, 'unknown-event', path, `Unknown event "${name}". ${didYouMean(name, ctx.reg.events.keys())}`.trim(),
        `Available events: ${listOf([...ctx.reg.events.values()].filter((x) => x.status === 'stable').map((x) => x.name), 20)}.`)
      return undefined
    }
    if (e.status === 'reserved') warn(ctx, 'reserved', path, `Event "${name}" is reserved: this engine version does not emit it yet.`)
    if (e.face) ctx.usesFace = true
    return e
  }
  for (const [name, opts] of Object.entries(ctx.manifest.events ?? {})) {
    const e = check(name, `/events/${name}`)
    if (e && opts.threshold !== undefined && !e.tunable) err(ctx, 'not-tunable', `/events/${name}/threshold`, `The threshold of "${name}" cannot be tuned.`)
  }
  ctx.manifest.script?.on?.forEach((name, i) => check(name, `/script/on/${i}`))
}

function checkLayers(ctx: Ctx) {
  const ids = new Map<string, number>()
  const plugins = new Set((ctx.manifest.requires.plugins ?? []).map((p) => p.split('@')[0]!))
  ctx.manifest.layers.forEach((layer, i) => {
    const path = `/layers/${i}`
    const def = ctx.reg.layers.get(layer.type)
    if (!def) {
      const msg = `Unknown layer type "${layer.type}". ${didYouMean(layer.type, ctx.reg.layers.keys())}`.trim()
      const hint = `Available types: ${listOf(ctx.reg.layers.keys())}. A type provided by a plugin requires "requires.plugins".`
      // The type may come from a declared plugin this validator does not know about.
      if (layer.type.includes(':') && plugins.has(layer.type.split(':')[0]!)) {
        warn(ctx, 'unverified-layer', `${path}/type`, `${msg} Provided by a plugin that is not loaded: not checked.`)
      } else err(ctx, 'unknown-layer-type', `${path}/type`, msg, hint)
      return
    }
    if (def.plugin !== 'core' && !plugins.has(def.plugin)) {
      err(ctx, 'missing-plugin', `${path}/type`, `Layer type "${layer.type}" is provided by the "${def.plugin}" plugin.`,
        `Add "requires": { "plugins": ["${def.plugin}@^${ctx.reg.plugins.get(def.plugin)?.split('.')[0] ?? 1}"] }.`)
    }
    const before = ctx.errors.length
    structural(def.schema, layer, path, ctx.errors)
    if (ctx.errors.length === before) walk(ctx, layer, def.schema, path)
    if (def.anchored && layer.anchor === undefined) ctx.usesFace = true // default anchor: "head"
    if (layer.type === 'color' && layer.region === 'face') ctx.usesFace = true // masked by the tracked face ovals
    if (layer.type === 'shader') checkShader(ctx, layer as TShaderLayer, path)
    if (layer.id !== undefined) {
      if (ids.has(layer.id)) err(ctx, 'duplicate-id', `${path}/id`, `Duplicate layer id "${layer.id}" (already used by /layers/${ids.get(layer.id)}).`)
      ids.set(layer.id, i)
    } else if (def.requiresId) {
      err(ctx, 'missing-id', path, `A "${layer.type}" layer must have an "id".`, `E.g. { "id": "bubble", "type": "${layer.type}", … }.`)
    }
    if (layer.excludeFromCapture && !layer.overlay) {
      warn(ctx, 'ignored', `${path}/excludeFromCapture`, '"excludeFromCapture" only has an effect with "overlay": true.')
    }
  })
  // Script: drawn canvas layers.
  const script = ctx.manifest.script
  script?.draw?.forEach((id, i) => {
    const l = ctx.manifest.layers.find((x) => x.id === id)
    if (!l) err(ctx, 'unknown-layer', `/script/draw/${i}`, `draw.${id}: no layer has the id "${id}". ${didYouMean(id, ids.keys())}`.trim())
    else if (l.type !== 'canvas') err(ctx, 'not-canvas', `/script/draw/${i}`, `draw.${id}: layer "${id}" has type "${l.type}", not "canvas".`)
  })
  ctx.manifest.layers.forEach((l, i) => {
    if (l.type === 'canvas' && l.id && !script?.draw?.includes(l.id)) {
      warn(ctx, 'canvas-not-drawn', `/layers/${i}`, `Canvas layer "${l.id}" is not drawn by any draw.${l.id} function: it will stay empty.`)
    }
  })
  script?.uses?.forEach((u, i) => {
    if (u.startsWith('face.') || u === 'pairs') ctx.usesFace = true
    if (!ctx.reg.scriptData.has(u)) {
      err(ctx, 'unknown-data', `/script/uses/${i}`, `Unknown script data "${u}". ${didYouMean(u, ctx.reg.scriptData.keys())}`.trim(),
        `Possible values: ${listOf(ctx.reg.scriptData.keys())}.`)
    }
  })
}

/**
 * Shader layers (spec §11): the face stage and declared anchors need face tracking; only face anchors make sense;
 * uniform and texture names become GLSL names.
 */
function checkShader(ctx: Ctx, layer: TShaderLayer, path: string) {
  if (layer.stage === 'face' || layer.anchors?.length) ctx.usesFace = true
  const file = shaderPath(ctx, layer.src)
  const source = file === undefined ? undefined : ctx.files.shaderSource?.(file)
  const inputs = source === undefined ? [] : shaderUses(source).faceInputs
  if (inputs.length > 0) {
    ctx.usesFace = true
    ctx.shaderFaceUses.push(`${inputs.join(', ')} in the shader of ${layer.id ? `layer "${layer.id}"` : path}`)
  }
  const names = new Set<string>()
  for (const [what, table] of [['uniforms', layer.uniforms], ['textures', layer.textures]] as const) {
    for (const name of Object.keys(table ?? {})) {
      const problem = shaderNameProblem(name)
      if (problem) {
        err(ctx, 'shader-name', `${path}/${what}/${name}`, `"${name}" ${problem}: it cannot name a GLSL ${what === 'uniforms' ? 'uniform' : 'sampler2D'}.`,
          'Use a GLSL identifier, e.g. "amount" or "noiseTex".')
      } else if (names.has(name)) {
        err(ctx, 'shader-name', `${path}/${what}/${name}`, `"${name}" is declared both in "uniforms" and in "textures".`)
      }
      names.add(name)
    }
  }
  layer.anchors?.forEach((name, i) => {
    const a = ctx.reg.anchors.get(name)
    if (a && a.subject !== 'face') {
      err(ctx, 'not-face-anchor', `${path}/anchors/${i}`, `Shader anchors are face anchors: "${name}" is not one.`,
        'Use ouaf_resolution and uv for screen positions.')
    }
  })
}

/** Package path of a shader reference: an `assets/…` path, or the `src` of a declared asset; none for `builtin:`. */
function shaderPath(ctx: Ctx, ref: string): string | undefined {
  if (ref.startsWith('assets/')) return ref
  const entry = ((ctx.manifest.assets ?? {}) as Record<string, TAssetEntry | undefined>)[ref]
  const src = typeof entry === 'string' ? entry : entry && 'src' in entry ? entry.src : undefined
  return typeof src === 'string' && src.startsWith('assets/') ? src : undefined
}

/** Asset kinds a script can use without a layer referencing them (`f.asset`, `f.sound`, spec §12.4); unknown too. */
const SCRIPT_READABLE_KINDS = new Set<string | undefined>(['image', 'spritesheet', 'video', 'audio', undefined])
/** Asset kinds a script that draws canvas layers uses as well: fonts, by their asset name (spec §12.6). */
const CANVAS_READABLE_KINDS = new Set<string | undefined>(['font'])

function checkRequiresAndAssets(ctx: Ctx) {
  const req = ctx.manifest.requires
  for (const k of ['hands', 'segmentation', 'pose', 'audio'] as const) {
    if (req[k]) warn(ctx, 'reserved', `/requires/${k}`, `"${k}" is reserved: this engine version does not provide it yet.`)
  }
  if (ctx.usesFace && !req.face) {
    const shaders = ctx.shaderFaceUses.map((u) => `; ${u}`).join('')
    err(ctx, 'requires-face', '/requires', `The filter uses the face (anchors, data, events or shader inputs${shaders}) without declaring it.`, 'Add "requires": { "face": true }.')
  }
  if (!ctx.usesFace && req.face) {
    warn(ctx, 'unused-requirement', '/requires/face', '"face" is required but nothing uses it: face tracking costs performance.')
  }
  if (req.blendshapes && !req.face) {
    err(ctx, 'requires-face', '/requires/blendshapes', 'Blendshapes come from face tracking: "blendshapes" needs "face".', 'Add "face": true to "requires".')
  }
  const script = ctx.manifest.script
  if (script && (script.uses === undefined || script.uses.includes('face.blendshapes'))) ctx.usesBlendshapes = true
  if (req.blendshapes && !ctx.usesBlendshapes) {
    warn(ctx, 'unused-requirement', '/requires/blendshapes',
      '"blendshapes" is required but no binding or script reads them: the engine could not drop them on slow devices.',
      'Remove "blendshapes" from "requires": expression events work without it.')
  }
  const assets = (ctx.manifest.assets ?? {}) as Record<string, TAssetEntry>
  const draws = (script?.draw?.length ?? 0) > 0
  // A script can also give a layer's content property any declared asset it shows (`set({ src })`, spec §12.4).
  const scriptKinds = new Set<string | undefined>(SCRIPT_READABLE_KINDS)
  if (script) {
    for (const layer of ctx.manifest.layers) {
      const def = ctx.reg.layers.get(layer.type)
      for (const [, kind] of def ? contentProperties(def.schema) : []) for (const k of CONTENT_KINDS[kind].kinds) scriptKinds.add(k)
    }
  }
  for (const [name, entry] of Object.entries(assets)) {
    // A built-in resource under a name of the filter (spec §10.1).
    if (typeof entry === 'string' && entry.startsWith('builtin:')) checkAssetRef(ctx, entry, `/assets/${name}`)
    const kind = assetKind(entry)
    // Assets used only by the script (sounds, canvas images and fonts, values it sets) cannot be detected here. The
    // other kinds cannot be read by a script: `data` and `lottie` are reserved for later versions (spec §10.2), used
    // only by plugin layers.
    const scriptReadable = scriptKinds.has(kind) || (draws && CANVAS_READABLE_KINDS.has(kind))
    if (!ctx.usedAssets.has(name) && (!script || !scriptReadable)) {
      warn(ctx, 'unused-asset', `/assets/${name}`, `Asset "${name}" is not referenced by any layer: it makes the package heavier.`,
        kind === 'data' ? 'A script does not read data assets: import the JSON in filter.js, ouaf pack bundles it into script.js (spec §10.2).' : undefined)
    }
    if (kind === undefined) {
      warn(ctx, 'unknown-kind', `/assets/${name}`, `Could not infer the kind of asset "${name}" from its extension.`, 'Set "kind", e.g. { "src": "…", "kind": "lottie" }.')
    }
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Validates an Ouaf v1 manifest. `reg` lets you include the vocabulary of loaded plugins; `files` the package files
 * the manifest refers to, for the checks that need them (`ouaf validate` passes them).
 */
export function validateManifest(input: unknown, reg: SpecRegistry = createRegistry(), files: ManifestFiles = {}): ValidationResult {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  structural(ManifestEnvelope, input, '', errors)
  if (errors.length === 0) {
    const ctx: Ctx = { reg, manifest: input as TManifest, errors, warnings, usedAssets: new Set(), usesFace: false, shaderFaceUses: [], files, usesBlendshapes: false }
    checkParams(ctx)
    checkLayers(ctx)
    checkEvents(ctx)
    checkRequiresAndAssets(ctx)
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** Human-readable output (CLI, messages to AI agents). */
export function formatIssues(result: ValidationResult, source = 'manifest'): string {
  const lines: string[] = []
  for (const i of [...result.errors, ...result.warnings]) {
    lines.push(`${source}${i.path || '/'} — ${i.severity} [${i.code}] ${i.message}`)
    if (i.hint) lines.push(`    → ${i.hint}`)
  }
  if (result.ok) lines.push(`${source}: valid${result.warnings.length ? ` (${result.warnings.length} warning(s))` : ''}.`)
  else lines.push(`${source}: ${result.errors.length} error(s).`)
  return lines.join('\n')
}
