/**
 * Downloads the tracking models served by the playground into apps/playground/models/ (gitignored).
 * Models are pinned by URL and checked against their SHA-256; existing valid files are kept.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODELS = [
  {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
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

for (const { file, url, sha256: expected } of MODELS) {
  const path = resolve(dir, file)
  if (existsSync(path) && sha256(readFileSync(path)) === expected) {
    console.log(`${file}: up to date`)
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
}
