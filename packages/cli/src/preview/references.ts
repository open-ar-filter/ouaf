/**
 * Reference inputs of `ouaf preview`: the frames a filter is rendered on. A reference set is a JSON file
 * (`test-media/references.json` by default) listing clips or images with the frames to render; `--input` gives a
 * single file instead. The reference face set of #31 plugs in as another set file in the same format.
 */
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The default reference set: frames of the licensed test clips (test-media/README.md). */
export const DEFAULT_REFERENCES = fileURLToPath(new URL('../../../../test-media/references.json', import.meta.url))

/** Still images a reference can be (decoded by the browser). */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}
/** Clips (H.264 or another codec the browser decodes, in an MP4 / MOV container: `OfflineVideoSource`). */
export const VIDEO_TYPES: Readonly<Record<string, string>> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime' }

/** Copies of a still image rendered by default: tracking and smoothing settle over them. */
export const IMAGE_FRAMES = 10

export interface Reference {
  /** Name of the screenshot (`<id>.png`): letters, digits, `-`, `_`. */
  id: string
  /** Absolute path of the clip or image. */
  file: string
  kind: 'video' | 'image'
  /** Clip: the frames rendered, from `from` to `time` (media time, s); the screenshot is the frame at `time`. */
  from: number
  time: number
  /** Image: copies rendered. */
  frames: number
  /** Faces the host tracks. */
  maxFaces: number
  description?: string
}

/** A reference set or an input file cannot be used: a usage error. */
export class ReferenceError extends Error {}

const ID = /^[\w-]+$/

function kindOf(file: string): 'video' | 'image' | undefined {
  const ext = extname(file).toLowerCase()
  return ext in VIDEO_TYPES ? 'video' : ext in IMAGE_TYPES ? 'image' : undefined
}

function checkFile(file: string, what: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) throw new ReferenceError(`${what}: no such file ${file}.`)
  if (kindOf(file)) return
  const list = (types: Record<string, string>) => Object.keys(types).join(', ')
  throw new ReferenceError(`${what}: ${file} is neither a clip (${list(VIDEO_TYPES)}) nor an image (${list(IMAGE_TYPES)}).`)
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Reads a reference set. Throws ReferenceError. */
export async function loadReferences(path: string): Promise<Reference[]> {
  let data: unknown
  try {
    data = JSON.parse(await readFile(path, 'utf8'))
  } catch (e) {
    throw new ReferenceError(`${path}: cannot read the reference set (${(e as Error).message}).`)
  }
  const list = (data as { references?: unknown } | null)?.references
  if (!Array.isArray(list) || list.length === 0) throw new ReferenceError(`${path}: expected { "references": [ … ] } with at least one reference.`)
  const seen = new Set<string>()
  return list.map((r: Record<string, unknown>, i) => {
    const where = `${path}: references[${i}]`
    if (typeof r?.id !== 'string' || !ID.test(r.id)) throw new ReferenceError(`${where}: "id" must be letters, digits, "-" or "_".`)
    if (seen.has(r.id)) throw new ReferenceError(`${where}: duplicate id "${r.id}".`)
    seen.add(r.id)
    if (typeof r.file !== 'string') throw new ReferenceError(`${where}: "file" is missing.`)
    const file = resolve(dirname(path), r.file)
    checkFile(file, `${where} (${r.id})`)
    const kind = kindOf(file)!
    const maxFaces = r.maxFaces ?? 1
    if (!Number.isInteger(maxFaces) || (maxFaces as number) < 1) throw new ReferenceError(`${where}: "maxFaces" must be a positive integer.`)
    const ref: Reference = { id: r.id, file, kind, from: 0, time: 0, frames: IMAGE_FRAMES, maxFaces: maxFaces as number }
    if (typeof r.description === 'string') ref.description = r.description
    if (kind === 'video') {
      if (!isNumber(r.time) || r.time < 0) throw new ReferenceError(`${where}: a clip needs "time" (s), the frame of the screenshot.`)
      const from = r.from ?? r.time
      if (!isNumber(from) || from < 0 || from > r.time) throw new ReferenceError(`${where}: "from" must be between 0 and "time".`)
      ref.from = from
      ref.time = r.time
    } else if (r.frames !== undefined) {
      if (!Number.isInteger(r.frames) || (r.frames as number) < 1) throw new ReferenceError(`${where}: "frames" must be a positive integer.`)
      ref.frames = r.frames as number
    }
    return ref
  })
}

export interface InputOptions {
  /** Clip: time of the screenshot (s). Default: 1. */
  at?: number
  /** Clip: first frame rendered (s). Default: half a second before `at`. */
  from?: number
  /** Image: copies rendered. */
  frames?: number
  maxFaces?: number
}

/** A single clip or image given on the command line. Throws ReferenceError. */
export function inputReference(file: string, options: InputOptions = {}): Reference {
  const abs = resolve(file)
  checkFile(abs, '--input')
  const kind = kindOf(abs)!
  const name = abs.split(/[\\/]/).at(-1)!.replace(/\.[^.]+$/, '').replace(/[^\w-]/g, '_') || 'input'
  const at = options.at ?? 1
  const from = options.from ?? Math.max(0, at - 0.5)
  if (from > at) throw new ReferenceError(`--from (${from}) is after --at (${at}).`)
  return { id: name, file: abs, kind, from, time: at, frames: options.frames ?? IMAGE_FRAMES, maxFaces: options.maxFaces ?? 1 }
}
