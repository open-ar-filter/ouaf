/**
 * Validation of an Ouaf v1 manifest, with explicit, actionable errors
 * (designed for humans and AI agents alike): JSON pointer, message, fix hint.
 */
import { Kind, type TSchema } from '@sinclair/typebox'
import { Value, ValueErrorType, type ValueError } from '@sinclair/typebox/value'
import { ManifestEnvelope, type TManifest } from './manifest.ts'
import { ParamTypes, type ParamTypeName } from './params.ts'
import { createRegistry, findEvent, type SpecRegistry } from './registry.ts'
import { assetKind, type TAssetEntry } from './assets.ts'

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

function literalOptions(schema: TSchema): string[] | undefined {
  const anyOf = (schema as { anyOf?: TSchema[] }).anyOf
  if (!anyOf) return undefined
  const consts = anyOf.map((s) => (s as { const?: unknown }).const)
  return consts.every((c) => typeof c === 'string') ? (consts as string[]) : undefined
}

function typeName(schema: TSchema): string {
  switch (schema[Kind]) {
    case 'Number': return 'a number'
    case 'Integer': return 'an integer'
    case 'String': return 'a string'
    case 'Boolean': return 'true or false'
    case 'Object': return 'an object { … }'
    case 'Array': return 'a list [ … ]'
    case 'Tuple': return `a list of ${(schema as { maxItems?: number }).maxItems ?? ''} numbers`
    case 'Record': return 'an object { … }'
    default: return 'a different value'
  }
}

function fromValueError(e: ValueError, base: string): Issue {
  const path = base + e.path
  const s = e.schema as TSchema & Record<string, unknown>
  const hint = typeof s['x-hint'] === 'string' ? (s['x-hint'] as string) : undefined
  const desc = typeof s.description === 'string' ? s.description : undefined
  const issue = (code: string, message: string, h = hint ?? desc): Issue => ({ severity: 'error', code, path, message, ...(h ? { hint: h } : {}) })
  const num = (key: string) => (s as Record<string, unknown>)[key]

  switch (e.type) {
    case ValueErrorType.ObjectRequiredProperty:
      return issue('required', `Missing required property "${e.path.split('/').pop() ?? ''}".`)
    case ValueErrorType.ObjectAdditionalProperties: {
      // TypeBox points at the unknown key; suggest the closest known property.
      const name = e.path.split('/').pop() ?? '?'
      const known = Object.keys((s as { properties?: Json }).properties ?? {})
      return {
        severity: 'error',
        code: 'unknown-property',
        path,
        message: `Unknown property "${name}". ${didYouMean(name, known)}`.trim(),
        hint: `Accepted properties here: ${listOf(known, 20)}.`,
      }
    }
    case ValueErrorType.Union: {
      const options = literalOptions(s)
      if (options && typeof e.value === 'string') {
        return issue('enum', `Unrecognized value "${e.value}". ${didYouMean(e.value, options)}`.trim(), `Possible values: ${listOf(options)}.`)
      }
      if (options) return issue('enum', 'Unrecognized value.', `Possible values: ${listOf(options)}.`)
      return issue('type', 'This form of value is not accepted.')
    }
    case ValueErrorType.Literal:
      return issue('literal', `Expected value: ${JSON.stringify(num('const'))}.`)
    case ValueErrorType.StringPattern:
      return issue('format', `Invalid format: ${JSON.stringify(e.value)}.`)
    case ValueErrorType.StringMaxLength:
      return issue('too-long', `Text too long (maximum ${num('maxLength')} characters).`)
    case ValueErrorType.StringMinLength:
      return issue('too-short', 'Text too short or empty.')
    case ValueErrorType.NumberMinimum:
    case ValueErrorType.IntegerMinimum:
      return issue('range', `Value ${e.value} is too small: minimum is ${num('minimum')}.`)
    case ValueErrorType.NumberMaximum:
    case ValueErrorType.IntegerMaximum:
      return issue('range', `Value ${e.value} is too large: maximum is ${num('maximum')}.`)
    case ValueErrorType.NumberExclusiveMinimum:
    case ValueErrorType.IntegerExclusiveMinimum:
      return issue('range', `Value ${e.value} is too small: must be greater than ${num('exclusiveMinimum')}.`)
    case ValueErrorType.ArrayMaxItems:
      return issue('too-many', `Too many items (maximum ${num('maxItems')}).`)
    case ValueErrorType.ArrayMinItems:
      return issue('too-few', `Not enough items (minimum ${num('minItems')}).`)
    case ValueErrorType.ArrayUniqueItems:
      return issue('duplicate', 'The list contains duplicates.')
    case ValueErrorType.ObjectMaxProperties:
      return issue('too-many', `Too many entries (maximum ${num('maxProperties')}).`)
    default:
      return issue('type', `Invalid value: expected ${typeName(s)}.`)
  }
}

/** Structural errors of a value against a schema, at most one per path. */
function structural(schema: TSchema, value: unknown, base: string, out: Issue[]): void {
  const seen = new Set<string>()
  for (const e of Value.Errors(schema, value)) {
    const issue = fromValueError(e, base)
    // One error per path, and none below an element that was already reported.
    if ([...seen].some((p) => issue.path === p || issue.path.startsWith(`${p}/`))) continue
    seen.add(issue.path)
    out.push(issue)
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

function valueKind(schema: TSchema): string {
  const s = schema as TSchema & { pattern?: string; maxItems?: number; anyOf?: TSchema[] }
  if (s[Kind] === 'String' && s.pattern?.startsWith('^#(')) return 'Color'
  if (s[Kind] === 'Tuple') return s.maxItems === 2 ? 'Vec2' : 'Vec3'
  if (s[Kind] === 'Union' && s.anyOf) return valueKind(s.anyOf[0]!)
  return String(s[Kind])
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
  const expected = valueKind(valueSchema)
  if (b.param !== undefined) {
    const def = ctx.manifest.params?.[b.param]
    if (!def) {
      err(ctx, 'unknown-param', `${path}/param`, `Unknown parameter "${b.param}". ${didYouMean(b.param, Object.keys(ctx.manifest.params ?? {}))}`.trim(),
        'Declare it in "params".')
      return
    }
    const ok = PARAM_COMPAT[expected]
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
    const m = b as { map?: unknown; range?: unknown; to?: unknown }
    if (d.type === 'string' && m.map === undefined && expected !== 'String') {
      err(ctx, 'binding-map-required', path, `"${b.bind}" is a string: add "map" to convert it.`)
    }
    if ((m.range === undefined) !== (m.to === undefined)) {
      err(ctx, 'binding-range', path, '"range" and "to" go together.', 'E.g. { "bind": "face.blendshapes.jawOpen", "range": [0, 1], "to": [0.1, 0.6] }.')
    }
  }
}

/** Walks a value along its schema for semantic checks (anchors, assets, bindings). */
function walk(ctx: Ctx, value: unknown, schema: TSchema, path: string): void {
  const s = schema as TSchema & Record<string, unknown>
  if (value === undefined) return
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
  if (s[Kind] === 'Object' && value && typeof value === 'object') {
    for (const [k, sub] of Object.entries((s.properties ?? {}) as Record<string, TSchema>)) {
      walk(ctx, (value as Json)[k], sub, `${path}/${k}`)
    }
    return
  }
  if (s[Kind] === 'Record' && value && typeof value === 'object') {
    const sub = Object.values((s.patternProperties ?? {}) as Record<string, TSchema>)[0]
    if (sub) for (const [k, v] of Object.entries(value as Json)) walk(ctx, v, sub, `${path}/${k}`)
    return
  }
  if (s[Kind] === 'Array' && Array.isArray(value)) {
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
    if (!ctx.reg.scriptData.has(u)) {
      err(ctx, 'unknown-data', `/script/uses/${i}`, `Unknown script data "${u}". ${didYouMean(u, ctx.reg.scriptData.keys())}`.trim(),
        `Possible values: ${listOf(ctx.reg.scriptData.keys())}.`)
    }
  })
}

function checkRequiresAndAssets(ctx: Ctx) {
  const req = ctx.manifest.requires
  for (const k of ['hands', 'segmentation', 'pose', 'audio'] as const) {
    if (req[k]) warn(ctx, 'reserved', `/requires/${k}`, `"${k}" is reserved: this engine version does not provide it yet.`)
  }
  if (ctx.usesFace && !req.face) {
    err(ctx, 'requires-face', '/requires', 'The filter uses the face (anchors, data or events) without declaring it.', 'Add "requires": { "face": true }.')
  }
  if (!ctx.usesFace && req.face) {
    warn(ctx, 'unused-requirement', '/requires/face', '"face" is required but nothing uses it: face tracking costs performance.')
  }
  const assets = (ctx.manifest.assets ?? {}) as Record<string, TAssetEntry>
  for (const [name, entry] of Object.entries(assets)) {
    const kind = assetKind(entry)
    // Assets used only by the script (sounds, canvas images) cannot be detected here.
    if (!ctx.usedAssets.has(name) && (!ctx.manifest.script || kind === 'model' || kind === 'lut' || kind === 'shader' || kind === 'font')) {
      warn(ctx, 'unused-asset', `/assets/${name}`, `Asset "${name}" is not referenced by any layer: it makes the package heavier.`)
    }
    if (kind === undefined) {
      warn(ctx, 'unknown-kind', `/assets/${name}`, `Could not infer the kind of asset "${name}" from its extension.`, 'Set "kind", e.g. { "src": "…", "kind": "lottie" }.')
    }
  }
}

// ---------------------------------------------------------------------------------------------

/** Validates an Ouaf v1 manifest. `reg` lets you include the vocabulary of loaded plugins. */
export function validateManifest(input: unknown, reg: SpecRegistry = createRegistry()): ValidationResult {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  structural(ManifestEnvelope, input, '', errors)
  if (errors.length === 0) {
    const ctx: Ctx = { reg, manifest: input as TManifest, errors, warnings, usedAssets: new Set(), usesFace: false }
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
