/**
 * Validation of a whole filter package (spec §3, §10, §11, §18): the manifest through `@ouaf/spec`, then the files
 * it references (existence, format, dimensions, codecs), the package layout and its size budget.
 *
 * Every issue names the file it is about and, when it relates to the manifest, the JSON pointer of the element;
 * line and column are given when known, so humans and AI agents can go straight to the fix.
 */
import {
  assetKind, checkPackageEntries, checkPackageSize, checkShaderSource, closest, createRegistry, formatBytes, kindFromPath, missingManifestHint,
  PACKAGE_RECOMMENDED_BYTES, validateManifest,
} from '@ouaf/spec'
import type { Issue, Severity, SpecRegistry, TAssetEntry, TAssetKind } from '@ouaf/spec'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import { jsonLocator, jsonSyntaxError, type JsonLocator } from './json-locate.ts'
import { sniff, type Format, type MediaInfo } from './media.ts'
import { openPackage, SourceError, type PackageSource } from './source.ts'
import { ZipError } from './zip.ts'

// ---------------------------------------------------------------------------------------------
// Limits (spec §3 and §10.4)

/** §3: package limits, shared with the engine's package reader. */
export { PACKAGE_MAX_BYTES, PACKAGE_MAX_ENTRIES, PACKAGE_RECOMMENDED_BYTES } from '@ouaf/spec'
/** §10.4: images ≤ 4096 px per side. */
export const IMAGE_MAX_SIDE = 4096
/** §10.4: videos ≤ 1080p (long side × short side, either orientation), 720p recommended. */
export const VIDEO_MAX = { long: 1920, short: 1080 }
export const VIDEO_RECOMMENDED = { long: 1280, short: 720 }

// ---------------------------------------------------------------------------------------------
// Report

export interface PackageIssue extends Issue {
  /**
   * File the issue is located in, relative to the package root: "manifest.json", "assets/glitch.frag"…
   * Empty for issues about the package as a whole (size budget).
   */
  file: string
  /** 1-based line (and column) in `file`, when known. */
  line?: number
  column?: number
  // `path` (from Issue) is a JSON pointer into manifest.json: the element concerned, or the one that references
  // `file`. Empty when no manifest element is involved.
}

/** A check that could not run, so a clean report does not claim more than it verified. */
export interface SkippedCheck {
  check: string
  files: string[]
  reason: string
}

export interface PackageReport {
  /** What was validated: the path given on the command line, or a label. */
  input: string
  kind: PackageSource['kind']
  ok: boolean
  errors: PackageIssue[]
  warnings: PackageIssue[]
  skipped: SkippedCheck[]
  stats: {
    /** Files in the package layout (manifest.json, script.js, assets/…). */
    files: number
    /** Their total uncompressed size. */
    bytes: number
    /** Size of the .ouaf archive, for a zip. */
    archiveBytes?: number
  }
}

/** Diagnostic of a shader compiler, with lines in the author's file (wrapper lines already subtracted). */
export interface ShaderDiagnostic {
  severity: Severity
  line?: number
  column?: number
  message: string
  hint?: string
}

/**
 * Compiles the `effect()` source of a shader asset (spec §11). Hook for a GLSL ES 3.00 compiler: none ships yet, as
 * Node has no WebGL. A compiler wraps the source with `wrapShader` (`@ouaf/spec`, the engine's own wrapper) and maps
 * its log with `parseShaderLog`, which gives lines in the author's file.
 */
export type ShaderCompiler = (source: string, file: string) => ShaderDiagnostic[] | Promise<ShaderDiagnostic[]>

export interface ValidateOptions {
  /** Vocabulary of loaded plugins (defaults to the built-in registry). */
  registry?: SpecRegistry
  compileShader?: ShaderCompiler
}

// ---------------------------------------------------------------------------------------------
// Formats (spec §10.2)

const KIND_EXTENSIONS: Record<TAssetKind, string[]> = {
  image: ['png', 'webp', 'jpg', 'jpeg', 'avif', 'svg', 'ktx2'],
  spritesheet: ['png', 'webp', 'jpg', 'jpeg', 'avif', 'svg', 'ktx2'],
  video: ['mp4', 'webm'],
  model: ['glb', 'gltf'],
  lut: ['cube'],
  shader: ['frag', 'glsl'],
  font: ['woff2', 'woff', 'ttf', 'otf'],
  audio: ['ogg', 'mp3', 'wav', 'opus'],
  lottie: ['lottie', 'json'],
  data: ['json'],
}

const KIND_LABEL: Record<TAssetKind, string> = {
  image: 'PNG, WebP, JPEG, AVIF, SVG, KTX2',
  spritesheet: 'PNG, WebP, JPEG, AVIF, SVG, KTX2',
  video: 'MP4 (H.264), WebM (VP9)',
  model: 'glTF 2.0 / GLB',
  lut: '.cube',
  shader: '.frag, .glsl',
  font: 'WOFF2, WOFF, TTF, OTF',
  audio: 'OGG, MP3, WAV, Opus',
  lottie: '.lottie, or .json with "kind": "lottie"',
  data: 'JSON',
}

/** Content expected for each extension; "text" accepts any UTF-8 text. */
const EXT_FORMAT: Record<string, Format> = {
  png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', avif: 'avif', svg: 'svg', ktx2: 'ktx2',
  mp4: 'mp4', webm: 'webm', glb: 'glb', gltf: 'json',
  ogg: 'ogg', opus: 'ogg', mp3: 'mp3', wav: 'wav',
  woff2: 'woff2', woff: 'woff', ttf: 'sfnt', otf: 'sfnt',
  cube: 'text', frag: 'text', glsl: 'text', json: 'json', lottie: 'zip',
}

const FORMAT_NAME: Record<Format, string> = {
  png: 'PNG', jpeg: 'JPEG', webp: 'WebP', avif: 'AVIF', svg: 'SVG', ktx2: 'KTX2', gif: 'GIF', heic: 'HEIC',
  mp4: 'MP4', webm: 'WebM', glb: 'GLB', gltf: 'glTF', ogg: 'Ogg', mp3: 'MP3', wav: 'WAV',
  woff2: 'WOFF2', woff: 'WOFF', sfnt: 'TrueType/OpenType', ttc: 'font collection (TTC)',
  zip: 'zip', json: 'JSON', text: 'text',
}

/** Usual extension of a detected format, to suggest a rename. */
const FORMAT_EXT: Partial<Record<Format, string>> = {
  png: 'png', jpeg: 'jpg', webp: 'webp', avif: 'avif', svg: 'svg', ktx2: 'ktx2', mp4: 'mp4', webm: 'webm', glb: 'glb',
  ogg: 'ogg', mp3: 'mp3', wav: 'wav', woff2: 'woff2', woff: 'woff', sfnt: 'ttf',
}

const RASTER: Format[] = ['png', 'jpeg', 'webp', 'avif', 'ktx2']
const TEXT_FORMATS: Format[] = ['text', 'json', 'svg']

const extOf = (path: string) => path.split('/').pop()!.split('.').slice(1).pop()?.toLowerCase() ?? ''

// ---------------------------------------------------------------------------------------------

interface Ctx {
  source: PackageSource
  errors: PackageIssue[]
  warnings: PackageIssue[]
  skipped: SkippedCheck[]
  files: Map<string, number>
  referenced: Set<string>
  locate: JsonLocator
  options: ValidateOptions
  shaders: string[]
}

interface Loc {
  file: string
  path?: string
  line?: number
  column?: number
}

function add(ctx: Ctx, severity: Severity, code: string, loc: Loc, message: string, hint?: string) {
  const issue: PackageIssue = {
    severity,
    code,
    file: loc.file,
    path: loc.path ?? '',
    ...(loc.line !== undefined ? { line: loc.line } : {}),
    ...(loc.column !== undefined ? { column: loc.column } : {}),
    message,
    ...(hint ? { hint } : {}),
  }
  ;(severity === 'error' ? ctx.errors : ctx.warnings).push(issue)
}

/** Location of a manifest element: manifest.json, line and column of the pointer. */
function at(ctx: Ctx, pointer: string): Loc {
  return { file: 'manifest.json', path: pointer, ...ctx.locate(pointer) }
}

const decoder = new TextDecoder('utf-8', { fatal: true })
function text(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    return undefined
  }
}

/** JSON.parse; a syntax error is reported with its line and column. */
function parseJson(ctx: Ctx, src: string, file: string, path?: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(src) }
  } catch (e) {
    const found = jsonSyntaxError(src)
    const { message, ...pos } = found ?? { message: (e as Error).message }
    add(ctx, 'error', 'json-syntax', { file, ...(path !== undefined ? { path } : {}), ...pos }, `Invalid JSON: ${message}.`,
      'Check for a trailing comma, a missing comma or quote, or a comment (JSON has none).')
    return undefined
  }
}

async function read(ctx: Ctx, file: string, path?: string): Promise<Uint8Array | undefined> {
  try {
    return await ctx.source.read(file)
  } catch (e) {
    if (e instanceof ZipError || e instanceof SourceError) {
      add(ctx, 'error', e.code, { file, ...(path !== undefined ? { path } : {}) }, e.message, 'Rebuild the archive.')
      return undefined
    }
    throw e
  }
}

// ---------------------------------------------------------------------------------------------
// Layout (spec §3)

/** The rules of `@ouaf/spec` (`checkPackageEntries`), the ones the engine's package reader applies. */
function checkLayout(ctx: Ctx) {
  const zip = ctx.source.kind === 'zip'
  const layout = checkPackageEntries(ctx.source.entries)
  const outside = new Map<string, string[]>()
  for (const p of layout.problems) add(ctx, 'error', p.code, { file: p.path }, p.message, p.hint)
  for (const c of layout.caseConflicts) {
    add(ctx, 'warning', 'case-conflict', { file: c.path },
      `"${c.path}" differs from "${c.other}" only by case or Unicode normalization: an engine reads them as two files, ` +
        'most file systems as one.', 'Rename one of them (spec §3).')
  }
  for (const e of layout.files) ctx.files.set(e.path, e.size)
  for (const e of layout.outside) {
    const top = e.path.includes('/') ? `${e.path.split('/')[0]}/` : e.path
    outside.set(top, [...(outside.get(top) ?? []), e.path])
  }
  for (const [top, paths] of outside) {
    const what = paths.length > 1 ? `"${top}" (${paths.length} files)` : `"${top}"`
    add(ctx, 'warning', 'outside-layout', { file: top },
      `${what} is outside the package layout (manifest.json, script.js, assets/): an engine ignores it.`,
      zip ? 'Remove it from the archive (spec §3).' : 'It is left out of the package; move it elsewhere to silence this warning.')
  }
}

// ---------------------------------------------------------------------------------------------
// Asset references in the manifest

interface FileRef {
  kind: TAssetKind | undefined
  /** Pointer of the manifest element that declares or references the file. */
  pointer: string
  entry?: { alpha?: string; frames?: { cols: number; rows: number } }
}

/** Collects `assets/…` paths used directly by layers, walking each layer along its schema (`x-ref: asset`). */
function collectLayerPaths(value: unknown, schema: TSchema, pointer: string, out: Map<string, FileRef>) {
  const s = schema as TSchema & Record<string, unknown>
  if (value === undefined) return
  if (Array.isArray(s.anyOf)) {
    const branch = (s.anyOf as TSchema[]).find((b) => Value.Check(b, value))
    if (branch) collectLayerPaths(value, branch, pointer, out)
    return
  }
  if (typeof value === 'string') {
    if (s['x-ref'] === 'asset' && value.startsWith('assets/') && !out.has(value)) out.set(value, { kind: kindFromPath(value), pointer })
    return
  }
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    if (s.items && !Array.isArray(s.items)) value.forEach((v, i) => collectLayerPaths(v, s.items as TSchema, `${pointer}/${i}`, out))
    return
  }
  const rec = value as Record<string, unknown>
  for (const [k, sub] of Object.entries((s.properties ?? {}) as Record<string, TSchema>)) collectLayerPaths(rec[k], sub, `${pointer}/${k}`, out)
  const pattern = Object.values((s.patternProperties ?? {}) as Record<string, TSchema>)[0]
  if (pattern && !s.properties) for (const [k, v] of Object.entries(rec)) collectLayerPaths(v, pattern, `${pointer}/${k}`, out)
}

function collectRefs(manifest: Record<string, unknown>, reg: SpecRegistry): Map<string, FileRef> {
  const refs = new Map<string, FileRef>()
  const assets = manifest.assets
  if (assets && typeof assets === 'object' && !Array.isArray(assets)) {
    for (const [name, entry] of Object.entries(assets as Record<string, unknown>)) {
      const src = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? (entry as { src?: unknown }).src : undefined
      if (typeof src !== 'string' || !src.startsWith('assets/') || refs.has(src)) continue
      let kind: TAssetKind | undefined
      try {
        kind = assetKind(entry as TAssetEntry)
      } catch {
        kind = kindFromPath(src)
      }
      const pointer = `/assets/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`
      refs.set(src, { kind, pointer, entry: typeof entry === 'object' ? (entry as FileRef['entry']) : undefined })
    }
  }
  if (typeof manifest.thumbnail === 'string' && !refs.has(manifest.thumbnail)) {
    refs.set(manifest.thumbnail, { kind: 'image', pointer: '/thumbnail' })
  }
  if (Array.isArray(manifest.layers)) {
    manifest.layers.forEach((layer, i) => {
      const type = layer && typeof layer === 'object' ? (layer as { type?: unknown }).type : undefined
      const def = typeof type === 'string' ? reg.layers.get(type) : undefined
      if (def) collectLayerPaths(layer, def.schema, `/layers/${i}`, refs)
    })
  }
  return refs
}

function missingFile(ctx: Ctx, path: string, loc: Loc) {
  const near = closest(path, ctx.files.keys())
  add(ctx, 'error', 'missing-file', loc, `File "${path}" not found in the package.${near ? ` Did you mean "${near}"?` : ''}`,
    near && near.toLowerCase() === path.toLowerCase()
      ? 'Paths are case-sensitive: fix the case of the path or of the file name.'
      : `Add the file to the package, or fix the path.`)
}

// ---------------------------------------------------------------------------------------------
// Per-file checks

async function checkFile(ctx: Ctx, path: string, ref: FileRef) {
  const loc: Loc = { file: path, path: ref.pointer }
  const ext = extOf(path)
  const kind = ref.kind
  if (kind === undefined) return // validateManifest already warns (unknown-kind)
  if (!KIND_EXTENSIONS[kind].includes(ext)) {
    add(ctx, 'error', 'unsupported-format', at(ctx, ref.pointer),
      `"${path}": ${ext ? `.${ext}` : 'a file without extension'} is not a supported ${kind} format.`,
      `Supported ${kind} formats: ${KIND_LABEL[kind]} (spec §10.2).`)
    return
  }
  const bytes = await read(ctx, path, ref.pointer)
  if (!bytes) return
  if (bytes.length === 0) {
    add(ctx, 'error', 'empty-file', loc, `"${path}" is empty.`, 'Export the asset again.')
    return
  }
  const info = sniff(bytes)
  const expected = EXT_FORMAT[ext]!
  const okFormat = expected === 'text' ? info && TEXT_FORMATS.includes(info.format) : info?.format === expected
  if (!info || !okFormat) {
    formatMismatch(ctx, path, loc, kind, expected, info)
    return
  }
  switch (kind) {
    case 'image':
    case 'spritesheet':
      return checkImage(ctx, path, loc, info, ref)
    case 'video':
      return checkVideo(ctx, path, loc, info, ref)
    case 'model':
      return checkModel(ctx, path, loc, bytes, ext)
    case 'lut':
      return checkCube(ctx, path, loc, bytes)
    case 'shader':
      return checkShader(ctx, path, loc, bytes)
    case 'audio':
      if (ext === 'opus' && !info.opus) {
        add(ctx, 'error', 'format-mismatch', loc, `"${path}" is an Ogg file but not an Opus stream.`, 'Rename it to .ogg, or encode it with Opus.')
      }
      return
    case 'data':
    case 'lottie':
      if (ext === 'json') {
        const src = text(bytes)
        if (src === undefined) add(ctx, 'error', 'encoding', loc, `"${path}" is not valid UTF-8.`, 'Save the file as UTF-8.')
        else parseJson(ctx, src, path, ref.pointer)
      }
      return
    case 'font':
      return
  }
}

function formatMismatch(ctx: Ctx, path: string, loc: Loc, kind: TAssetKind, expected: Format, info: MediaInfo | undefined) {
  const want = expected === 'text' ? 'a text file' : `a ${FORMAT_NAME[expected]} file`
  const got = info && info.format !== 'text' ? ` (its content is ${FORMAT_NAME[info.format]})` : info ? '' : ' (unrecognized content)'
  const ext = info && FORMAT_EXT[info.format]
  const supported = ext !== undefined && KIND_EXTENSIONS[kind].includes(ext)
  const renamed = ext ? path.replace(/\.[^./]+$/, `.${ext}`) : undefined
  add(ctx, 'error', 'format-mismatch', loc, `"${path}" is not ${want}${got}.`,
    supported && renamed
      ? `Rename it to "${renamed}" and update the manifest, or export it again as ${FORMAT_NAME[expected]}.`
      : `Export it again as ${expected === 'text' ? 'UTF-8 text' : FORMAT_NAME[expected]}. Supported ${kind} formats: ${KIND_LABEL[kind]}.`)
}

function checkImage(ctx: Ctx, path: string, loc: Loc, info: MediaInfo, ref: FileRef) {
  if (!RASTER.includes(info.format)) return // SVG: rendered as an image, no pixel size to check
  const { width, height } = info
  if (!width || !height) {
    add(ctx, 'warning', 'unreadable-header', loc, `Could not read the dimensions of "${path}" from its header.`,
      'An engine checks them before decoding and may refuse the file: export it again.')
    return
  }
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) {
    add(ctx, 'error', 'image-too-large', loc, `"${path}" is ${width}×${height} px: images are limited to ${IMAGE_MAX_SIDE} px per side (spec §10.4).`,
      `Resize it to at most ${IMAGE_MAX_SIDE} px on its longest side.`)
  }
  const frames = ref.entry?.frames
  if (frames && typeof frames.cols === 'number' && typeof frames.rows === 'number' && (width % frames.cols || height % frames.rows)) {
    add(ctx, 'warning', 'spritesheet-grid', loc,
      `"${path}" is ${width}×${height} px, which does not divide into ${frames.cols}×${frames.rows} frames: frames will drift.`,
      `Make the width a multiple of ${frames.cols} and the height a multiple of ${frames.rows}.`)
  }
}

function checkVideo(ctx: Ctx, path: string, loc: Loc, info: MediaInfo, ref: FileRef) {
  const want = info.format === 'mp4' ? 'h264' : 'vp9'
  const reencode = info.format === 'mp4'
    ? `ffmpeg -i in -c:v libx264 -pix_fmt yuv420p -an "${path.split('/').pop()}"`
    : `ffmpeg -i in -c:v libvpx-vp9 -an "${path.split('/').pop()}"`
  if (info.codec === undefined) {
    add(ctx, 'warning', 'unreadable-header', loc, `Could not read the video codec of "${path}".`,
      `${info.format === 'mp4' ? 'MP4 videos must be H.264' : 'WebM videos must be VP9'} (spec §10.2).`)
  } else if (info.codec !== want) {
    add(ctx, 'error', 'unsupported-codec', loc,
      `"${path}" uses the ${info.codec.toUpperCase()} codec: ${info.format === 'mp4' ? 'MP4 videos must be H.264' : 'WebM videos must be VP9'} (spec §10.2).`,
      `Re-encode it, e.g. ${reencode}.`)
  }
  const { width, height } = info
  if (!width || !height) return
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  const packed = ref.entry?.alpha === 'packed' ? ' (alpha packed side by side included)' : ''
  if (long > VIDEO_MAX.long || short > VIDEO_MAX.short) {
    add(ctx, 'error', 'video-too-large', loc, `"${path}" is ${width}×${height} px${packed}: videos are limited to 1080p (spec §10.4).`,
      'Scale it down to at most 1920×1080 (1280×720 recommended).')
  } else if (long > VIDEO_RECOMMENDED.long || short > VIDEO_RECOMMENDED.short) {
    add(ctx, 'warning', 'video-large', loc, `"${path}" is ${width}×${height} px${packed}: 720p or less is recommended (spec §10.4).`,
      'Scale it down to at most 1280×720 for phones.')
  }
}

function checkModel(ctx: Ctx, path: string, loc: Loc, bytes: Uint8Array, ext: string) {
  let json: string | undefined
  if (ext === 'glb') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.length < 20 || view.getUint32(4, true) !== 2) {
      add(ctx, 'error', 'gltf-version', loc, `"${path}" is not a glTF 2.0 binary.`, 'Export it again as glTF 2.0 (GLB).')
      return
    }
    const length = view.getUint32(12, true)
    if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.length) {
      add(ctx, 'error', 'gltf-invalid', loc, `"${path}": the GLB has no valid JSON chunk.`, 'Export it again as glTF 2.0 (GLB).')
      return
    }
    json = text(bytes.subarray(20, 20 + length))
  } else json = text(bytes)
  if (json === undefined) {
    add(ctx, 'error', 'encoding', loc, `"${path}": the glTF JSON is not valid UTF-8.`, 'Export it again as glTF 2.0.')
    return
  }
  const parsed = parseJson(ctx, json, path, loc.path)
  if (!parsed) return
  const gltf = parsed.value as { asset?: { version?: unknown }; buffers?: Array<{ uri?: unknown }>; images?: Array<{ uri?: unknown }> }
  if (typeof gltf.asset?.version !== 'string' || !gltf.asset.version.startsWith('2.')) {
    add(ctx, 'error', 'gltf-version', loc, `"${path}" is not glTF 2.0 (asset.version is ${JSON.stringify(gltf.asset?.version)}).`,
      'Export it again as glTF 2.0.')
    return
  }
  // External resources of a .gltf: local files next to it; remote URLs are forbidden (spec §10.1, §15).
  const dir = path.split('/').slice(0, -1).join('/')
  const uris = [
    ...(gltf.buffers ?? []).map((b, i) => [b?.uri, `buffers[${i}]`] as const),
    ...(gltf.images ?? []).map((b, i) => [b?.uri, `images[${i}]`] as const),
  ]
  for (const [uri, where] of uris) {
    if (typeof uri !== 'string' || uri.startsWith('data:')) continue
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) {
      add(ctx, 'error', 'remote-resource', loc, `"${path}" ${where} loads "${uri}": remote resources are forbidden (spec §10.1).`,
        'Embed the resource (export as GLB) or put the file in the package.')
      continue
    }
    let target = uri
    try {
      target = decodeURIComponent(uri)
    } catch {}
    const parts: string[] = dir ? dir.split('/') : []
    for (const s of target.split('/')) {
      if (s === '..') parts.pop()
      else if (s !== '.' && s !== '') parts.push(s)
    }
    const resolved = parts.join('/')
    if (!resolved.startsWith('assets/')) {
      add(ctx, 'error', 'unsafe-path', loc, `"${path}" ${where} points outside assets/ ("${uri}").`, 'Keep the model\'s files under assets/, or export it as GLB.')
    } else if (!ctx.files.has(resolved)) {
      missingFile(ctx, resolved, loc)
    } else ctx.referenced.add(resolved)
  }
}

function checkCube(ctx: Ctx, path: string, loc: Loc, bytes: Uint8Array) {
  const src = text(bytes)
  if (src === undefined) {
    add(ctx, 'error', 'encoding', loc, `"${path}" is not valid UTF-8 text.`, 'Export the LUT again as a .cube text file.')
    return
  }
  const lines = src.split(/\r?\n/)
  let size: number | undefined
  let dims = 3
  let sizeLine = 0
  let rows = 0
  const number = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === '' || line.startsWith('#')) continue
    const [word, ...rest] = line.split(/\s+/)
    if (word === 'LUT_3D_SIZE' || word === 'LUT_1D_SIZE') {
      dims = word === 'LUT_3D_SIZE' ? 3 : 1
      size = Number(rest[0])
      sizeLine = i + 1
      const max = dims === 3 ? 256 : 65536
      if (!Number.isInteger(size) || size < 2 || size > max) {
        add(ctx, 'error', 'lut-syntax', { ...loc, line: i + 1 }, `${word} must be an integer from 2 to ${max}.`, 'E.g. "LUT_3D_SIZE 33".')
        return
      }
    } else if (/^[A-Z][A-Z0-9_]*$/.test(word!)) {
      continue // TITLE, DOMAIN_MIN, DOMAIN_MAX, LUT_3D_INPUT_RANGE…
    } else {
      const values = line.split(/\s+/)
      if (values.length !== 3 || !values.every((v) => number.test(v))) {
        add(ctx, 'error', 'lut-syntax', { ...loc, line: i + 1, column: 1 }, `Expected a data row of 3 numbers (R G B), got "${line.slice(0, 40)}".`,
          'Each data line of a .cube file holds three numbers, e.g. "0.0 0.5 1.0".')
        return
      }
      if (size === undefined) {
        add(ctx, 'error', 'lut-syntax', { ...loc, line: i + 1 }, 'Data rows before LUT_3D_SIZE.', 'Put "LUT_3D_SIZE <n>" before the data.')
        return
      }
      rows++
    }
  }
  if (size === undefined) {
    add(ctx, 'error', 'lut-syntax', loc, `"${path}" has no LUT_3D_SIZE line.`, 'Add "LUT_3D_SIZE <n>" before the data, e.g. "LUT_3D_SIZE 33".')
    return
  }
  const expected = dims === 3 ? size ** 3 : size
  if (rows !== expected) {
    add(ctx, 'error', 'lut-syntax', { ...loc, line: sizeLine }, `LUT_${dims}D_SIZE ${size} needs ${expected} data rows, the file has ${rows}.`,
      'Export the LUT again: the file looks truncated.')
  }
}

async function checkShader(ctx: Ctx, path: string, loc: Loc, bytes: Uint8Array) {
  const src = text(bytes)
  if (src === undefined) {
    add(ctx, 'error', 'encoding', loc, `"${path}" is not valid UTF-8 text.`, 'Save the shader as UTF-8.')
    return
  }
  // Static checks of spec §11 (the author only writes effect(); the engine provides #version and main()).
  for (const issue of checkShaderSource(src)) {
    const message = issue.code === 'shader-no-effect' ? `"${path}" does not define vec4 effect(vec2 uv).` : issue.message
    add(ctx, 'error', issue.code, issue.line !== undefined ? { ...loc, line: issue.line } : loc, message, issue.hint)
  }
  if (!ctx.options.compileShader) {
    ctx.shaders.push(path)
    return
  }
  for (const d of await ctx.options.compileShader(src, path)) {
    add(ctx, d.severity, 'glsl', {
      ...loc,
      ...(d.line !== undefined ? { line: d.line } : {}),
      ...(d.column !== undefined ? { column: d.column } : {}),
    }, d.message, d.hint)
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Limits shared with the engine (`checkPackageSize`: entries, unpacked size, and the archive bound), then the
 * recommended size. Both sizes are those of the files unpacked (spec §3), whatever the compression.
 */
function checkBudget(ctx: Ctx) {
  const bytes = [...ctx.files.values()].reduce((a, b) => a + b, 0)
  const archiveBytes = ctx.source.archiveSize
  const problems = checkPackageSize({ entries: ctx.source.entries.length, bytes, ...(archiveBytes !== undefined ? { archiveBytes } : {}) })
  for (const p of problems) add(ctx, 'error', p.code, { file: '' }, p.message, p.hint)
  if (problems.some((p) => p.code === 'package-too-large')) return
  if (bytes > PACKAGE_RECOMMENDED_BYTES) {
    const unpacked = archiveBytes !== undefined ? ' unpacked' : ''
    add(ctx, 'warning', 'package-size', { file: '' },
      `The package files total ${formatBytes(bytes)}${unpacked}: 5 MB or less is recommended (spec §3).`,
      'Compress the assets (KTX2 textures, Draco/meshopt models, shorter or smaller videos).')
  }
}

/** Validates a package from any source. */
export async function validatePackage(source: PackageSource, options: ValidateOptions = {}): Promise<PackageReport> {
  const reg = options.registry ?? createRegistry()
  const ctx: Ctx = {
    source, errors: [], warnings: [], skipped: [], files: new Map(), referenced: new Set(), options, shaders: [],
    locate: () => ({ line: 1, column: 1 }),
  }
  const report = (): PackageReport => {
    if (ctx.shaders.length) {
      ctx.skipped.push({
        check: 'glsl-compile',
        files: ctx.shaders,
        reason: 'GLSL compilation is not available yet: Node has no GLSL compiler (the engine compiles shaders when it loads the filter). Only static checks ran.',
      })
    }
    return {
      input: source.label,
      kind: source.kind,
      ok: ctx.errors.length === 0,
      errors: ctx.errors,
      warnings: ctx.warnings,
      skipped: ctx.skipped,
      stats: {
        files: ctx.files.size,
        bytes: [...ctx.files.values()].reduce((a, b) => a + b, 0),
        ...(source.archiveSize !== undefined ? { archiveBytes: source.archiveSize } : {}),
      },
    }
  }

  checkLayout(ctx)
  checkBudget(ctx)

  // Manifest (spec §4, §18).
  if (!ctx.files.has('manifest.json')) {
    add(ctx, 'error', 'missing-manifest', { file: 'manifest.json' }, 'The package has no manifest.json at its root.',
      missingManifestHint(source.entries.map((e) => e.path)))
    return report()
  }
  const bytes = await read(ctx, 'manifest.json')
  if (!bytes) return report()
  const src = text(bytes)
  if (src === undefined) {
    add(ctx, 'error', 'encoding', { file: 'manifest.json' }, 'manifest.json is not valid UTF-8.', 'Save the file as UTF-8.')
    return report()
  }
  const parsed = parseJson(ctx, src, 'manifest.json')
  if (!parsed) return report()
  ctx.locate = jsonLocator(src)
  const result = validateManifest(parsed.value, reg)
  for (const i of [...result.errors, ...result.warnings]) add(ctx, i.severity, i.code, at(ctx, i.path), i.message, i.hint)
  const manifest = parsed.value
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return report()
  const m = manifest as Record<string, unknown>

  // Referenced files (spec §10).
  for (const [path, ref] of collectRefs(m, reg)) {
    if (!ctx.files.has(path)) {
      if (!source.entries.some((e) => e.path === path)) missingFile(ctx, path, at(ctx, ref.pointer))
      continue // present but rejected by the layout checks
    }
    ctx.referenced.add(path)
    await checkFile(ctx, path, ref)
  }

  // Script (spec §12.2).
  if (m.script !== undefined && !ctx.files.has('script.js')) {
    add(ctx, 'error', 'missing-file', at(ctx, '/script/entry'), 'The manifest declares a script but the package has no script.js.',
      '`ouaf pack` writes script.js together with the "script" section; pack the filter again.')
  } else if (m.script === undefined && ctx.files.has('script.js')) {
    add(ctx, 'warning', 'unused-script', { file: 'script.js' }, 'script.js is ignored: the manifest has no "script" section.',
      '`ouaf pack` fills in "script"; otherwise remove script.js.')
  }

  for (const path of ctx.files.keys()) {
    if (path.startsWith('assets/') && !ctx.referenced.has(path)) {
      add(ctx, 'warning', 'unreferenced-file', { file: path }, `"${path}" is not referenced by the manifest: it makes the package heavier.`,
        'Declare it in "assets" if a layer or the script uses it, otherwise remove it.')
    }
  }
  return report()
}

/** Opens a folder or a .ouaf file and validates it. Throws SourceError when the input cannot be opened at all. */
export async function validatePath(input: string, options: ValidateOptions = {}): Promise<PackageReport> {
  let source: PackageSource
  try {
    source = await openPackage(input)
  } catch (e) {
    if (e instanceof SourceError && e.code !== 'not-found') {
      // Unreadable archive: a problem of the package, reported like any other.
      return {
        input, kind: 'zip', ok: false, warnings: [], skipped: [], stats: { files: 0, bytes: 0 },
        errors: [{ severity: 'error', code: e.code, file: '', path: '', message: e.message,
          hint: 'A .ouaf file is a zip archive of manifest.json, script.js and assets/ (spec §3).' }],
      }
    }
    throw e
  }
  return validatePackage(source, options)
}
