/**
 * Downloads the tracking models served by the playground into apps/playground/models/ (gitignored).
 * Models are pinned by URL and checked against their SHA-256; existing valid files are kept.
 *
 * The TFLite models bundled in `face_landmarker.task` (a zip archive) are also extracted next to it, for the
 * runtime spike (#83), which runs them without MediaPipe.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const MODELS = [
  {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    // Face detector (BlazeFace short range), face mesh (478 landmarks) and blendshapes: Apache-2.0 (model cards of
    // MediaPipe BlazeFace, Face Mesh V2 and Blendshape V2).
    extract: ['face_detector.tflite', 'face_landmarks_detector.tflite', 'face_blendshapes.tflite'],
  },
  {
    // Person segmentation (256×256 input, one confidence mask), for the shared WebGL context spike (#7).
    file: 'selfie_segmenter.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
    sha256: '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b',
  },
]

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../models')
mkdirSync(dir, { recursive: true })

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/** The files of a zip archive (stored or deflated entries), read from its central directory. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('not a zip archive')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory')
    const method = zip.readUInt16LE(p + 10)
    const compressed = zip.readUInt32LE(p + 20)
    const nameLength = zip.readUInt16LE(p + 28)
    const extraLength = zip.readUInt16LE(p + 30)
    const commentLength = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    const name = zip.toString('utf8', p + 46, p + 46 + nameLength)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + compressed)
    if (method === 0) files.set(name, raw)
    else if (method === 8) files.set(name, inflateRawSync(raw))
    else throw new Error(`${name}: unsupported zip method ${method}`)
    p += 46 + nameLength + extraLength + commentLength
  }
  return files
}

function extract(archive: string, names: readonly string[]) {
  const files = unzip(readFileSync(resolve(dir, archive)))
  for (const name of names) {
    const data = files.get(name)
    if (!data) throw new Error(`${archive}: no ${name} inside`)
    writeFileSync(resolve(dir, name), data)
    console.log(`${name}: extracted from ${archive} (${(data.length / 1e6).toFixed(1)} MB)`)
  }
}

for (const model of MODELS) {
  const { file, url, sha256: expected } = model
  const path = resolve(dir, file)
  const names: readonly string[] = ('extract' in model && model.extract) || []
  if (existsSync(path) && sha256(readFileSync(path)) === expected) {
    console.log(`${file}: up to date`)
    if (names.some((name) => !existsSync(resolve(dir, name)))) extract(file, names)
    continue
  }
  console.log(`${file}: downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status} from ${url}`)
  const data = new Uint8Array(await res.arrayBuffer())
  const actual = sha256(data)
  if (actual !== expected) throw new Error(`${file}: SHA-256 mismatch (expected ${expected}, got ${actual})`)
  writeFileSync(`${path}.tmp`, data)
  renameSync(`${path}.tmp`, path)
  console.log(`${file}: ${(data.length / 1e6).toFixed(1)} MB written to ${path}`)
  extract(file, names)
}
