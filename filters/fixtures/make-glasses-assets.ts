/**
 * Rebuilds `glasses/assets/glasses.glb`, the model of the head occluder fixture (#155): glasses with the geometry of
 * the `glasses` demo (#37, `filters/make-demo-assets.ts`), without lenses, in flat unlit colors
 * (`KHR_materials_unlit`) so the browser test can tell the parts apart: the front (rims and bridge) red, the temple on
 * +x green, the temple on -x magenta. Computed here, from code; CC0, like the fixtures. No dependency.
 *
 *   node filters/fixtures/make-glasses-assets.ts
 *
 * Units are face units (spec §5.1), +x right, +y up, +z towards the camera; the origin goes on the `eyes` anchor.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

type V3 = [number, number, number]

interface Geometry {
  positions: number[]
  indices: number[]
}

function merge(...parts: Geometry[]): Geometry {
  const out: Geometry = { positions: [], indices: [] }
  for (const g of parts) {
    const base = out.positions.length / 3
    out.positions.push(...g.positions)
    out.indices.push(...g.indices.map((i) => i + base))
  }
  return out
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
function normalize(a: V3): V3 {
  const l = Math.hypot(...a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** A tube of radius `r` along `path`, with a rotation-minimizing frame; `closed`: the path loops. */
function tube(path: V3[], r: number, sides: number, closed = false): Geometry {
  const g: Geometry = { positions: [], indices: [] }
  const n = path.length
  const tangent = (i: number): V3 => {
    const prev = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!
    const next = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!
    return normalize(sub(next, prev))
  }
  const t0 = tangent(0)
  let normal = normalize(cross(t0, Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))
  for (let i = 0; i < n; i++) {
    const t = tangent(i)
    const d = dot(normal, t)
    normal = normalize([normal[0] - d * t[0], normal[1] - d * t[1], normal[2] - d * t[2]])
    const binormal = cross(t, normal)
    const p = path[i]!
    for (let s = 0; s < sides; s++) {
      const a = (2 * Math.PI * s) / sides
      for (let k = 0; k < 3; k++) g.positions.push(p[k]! + r * (Math.cos(a) * normal[k]! + Math.sin(a) * binormal[k]!))
    }
  }
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = i * sides
    const b = ((i + 1) % n) * sides
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides
      g.indices.push(a + s, b + s, b + s1, a + s, b + s1, a + s1)
    }
  }
  return g
}

/** A superellipse (a rounded rectangle for n ≈ 4) of half-axes `a`, `b`, centred on `c`, in the xy plane. */
function superellipse(c: V3, a: number, b: number, n: number, count: number): V3[] {
  return Array.from({ length: count }, (_, i) => {
    const t = (2 * Math.PI * i) / count
    const cos = Math.cos(t)
    const sin = Math.sin(t)
    return [c[0] + a * Math.sign(cos) * Math.abs(cos) ** (2 / n), c[1] + b * Math.sign(sin) * Math.abs(sin) ** (2 / n), c[2]] as V3
  })
}

// The demo's glasses: rims around the eyes (x = ±0.52), a bridge, temples from the outer edge of each rim back along
// -z (x from 0.92 out to 1.2 at 0.75 behind the front, the width of the tracked heads near the ear), bending down
// behind the ears.
const front = merge(
  ...[-1, 1].map((side) => tube(superellipse([0.52 * side, 0, 0], 0.4, 0.29, 3.5, 64), 0.045, 10, true)),
  tube(Array.from({ length: 13 }, (_, i) => {
    const x = -0.14 + (0.28 * i) / 12
    return [x, 0.1 + 0.05 * Math.cos((Math.PI * x) / 0.28), 0.01] as V3
  }), 0.035, 10),
)
const temple = (side: number) =>
  tube(Array.from({ length: 24 }, (_, i) => {
    const u = i / 23
    const z = -0.05 - 1.75 * u
    const y = 0.1 - (u > 0.75 ? 0.6 * ((u - 0.75) / 0.25) ** 2 : 0)
    return [side * (0.92 + 0.28 * Math.sin(Math.min(1, u * 2.5) * (Math.PI / 2))), y, z] as V3
  }), 0.035, 8)

const parts: Array<[string, Geometry, V3]> = [
  ['front', front, [1, 0, 0]],
  ['temple+x', temple(1), [0, 1, 0]],
  ['temple-x', temple(-1), [1, 0, 1]],
]

// A minimal GLB: one buffer, positions and 16-bit indices per part, one unlit material per part.
const json = {
  asset: { version: '2.0', generator: 'ouaf make-glasses-assets' },
  extensionsUsed: ['KHR_materials_unlit'],
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'glasses', mesh: 0 }],
  meshes: [{ name: 'glasses', primitives: [] as object[] }],
  materials: [] as object[],
  accessors: [] as object[],
  bufferViews: [] as object[],
  buffers: [{ byteLength: 0 }],
}
const chunks: Uint8Array[] = []
let length = 0
const view = (bytes: Uint8Array, target: number) => {
  json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, target })
  chunks.push(bytes)
  length += bytes.length
  const pad = (4 - (length % 4)) % 4
  chunks.push(new Uint8Array(pad))
  length += pad
  return json.bufferViews.length - 1
}
for (const [name, g, rgb] of parts) {
  const positions = Float32Array.from(g.positions)
  const min = [0, 1, 2].map((k) => Math.min(...positions.filter((_, i) => i % 3 === k)))
  const max = [0, 1, 2].map((k) => Math.max(...positions.filter((_, i) => i % 3 === k)))
  json.accessors.push({ bufferView: view(new Uint8Array(positions.buffer), 34962), componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max })
  const indices = Uint16Array.from(g.indices)
  json.accessors.push({ bufferView: view(new Uint8Array(indices.buffer), 34963), componentType: 5123, count: indices.length, type: 'SCALAR' })
  json.materials.push({ name, pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} } })
  json.meshes[0]!.primitives.push({ attributes: { POSITION: json.accessors.length - 2 }, indices: json.accessors.length - 1, material: json.materials.length - 1 })
}
json.buffers[0]!.byteLength = length
let text = new TextEncoder().encode(JSON.stringify(json))
text = Uint8Array.from([...text, ...new Array<number>((4 - (text.length % 4)) % 4).fill(0x20)])
const glb = new Uint8Array(12 + 8 + text.length + 8 + length)
const dv = new DataView(glb.buffer)
dv.setUint32(0, 0x46546c67, true) // glTF
dv.setUint32(4, 2, true)
dv.setUint32(8, glb.length, true)
dv.setUint32(12, text.length, true)
dv.setUint32(16, 0x4e4f534a, true) // JSON
glb.set(text, 20)
let p = 20 + text.length
dv.setUint32(p, length, true)
dv.setUint32(p + 4, 0x004e4942, true) // BIN
p += 8
for (const c of chunks) {
  glb.set(c, p)
  p += c.length
}
const file = resolve(here, 'glasses/assets/glasses.glb')
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, glb)
console.log(`glasses/assets/glasses.glb: ${glb.length} bytes`)
