/**
 * Rebuilds the glTF models of the demo filters (#37): `glasses/assets/glasses.glb`, `wink-crown/assets/crown.glb`
 * and their copies in `stress/assets/`. Every shape is computed here, from code (tubes along curves, discs, spheres,
 * a zig-zag band): no third-party model, no image. Our own work, dedicated to the public domain (CC0-1.0), like the
 * demos. No dependency: a small glTF 2.0 / GLB writer is below.
 *
 *   node filters/make-demo-assets.ts
 *
 * Units are face units (spec §5.1: 1 = the distance between the eye centres), +x right, +y up, +z towards the camera,
 * so the models need no `scale` on their anchor.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

type V3 = [number, number, number]

/** Triangles with per-vertex normals. */
interface Geometry {
  positions: number[]
  normals: number[]
  indices: number[]
}

const geometry = (): Geometry => ({ positions: [], normals: [], indices: [] })

function merge(...parts: Geometry[]): Geometry {
  const out = geometry()
  for (const g of parts) {
    const base = out.positions.length / 3
    out.positions.push(...g.positions)
    out.normals.push(...g.normals)
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

/**
 * A tube of radius `r` along `path` (`sides` vertices around), with a rotation-minimizing frame so it does not
 * twist. `closed`: the path loops (a rim). Open ends are left open: they sit inside other parts or behind the head.
 */
function tube(path: V3[], r: number, sides = 12, closed = false): Geometry {
  const g = geometry()
  const n = path.length
  const tangent = (i: number): V3 => {
    const prev = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!
    const next = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!
    return normalize(sub(next, prev))
  }
  // Initial normal: any vector perpendicular to the first tangent.
  const t0 = tangent(0)
  let normal = normalize(cross(t0, Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))
  let prevT = t0
  for (let i = 0; i < n; i++) {
    const t = tangent(i)
    // Parallel transport: remove the component of the previous normal along the new tangent.
    if (i > 0) {
      const d = dot(normal, t)
      normal = normalize([normal[0] - d * t[0], normal[1] - d * t[1], normal[2] - d * t[2]])
    }
    prevT = t
    const binormal = cross(prevT, normal)
    const p = path[i]!
    for (let s = 0; s < sides; s++) {
      const a = (2 * Math.PI * s) / sides
      const dir: V3 = [
        Math.cos(a) * normal[0] + Math.sin(a) * binormal[0],
        Math.cos(a) * normal[1] + Math.sin(a) * binormal[1],
        Math.cos(a) * normal[2] + Math.sin(a) * binormal[2],
      ]
      g.positions.push(p[0] + r * dir[0], p[1] + r * dir[1], p[2] + r * dir[2])
      g.normals.push(...dir)
    }
  }
  const rings = closed ? n : n - 1
  for (let i = 0; i < rings; i++) {
    const a = i * sides
    const b = ((i + 1) % n) * sides
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides
      g.indices.push(a + s, b + s, b + s1, a + s, b + s1, a + s1)
    }
  }
  return g
}

/** Points of a superellipse (a rounded rectangle for n ≈ 4) of half-axes `a`, `b`, centred on `c`, in the xy plane. */
function superellipse(c: V3, a: number, b: number, n: number, count: number): V3[] {
  const pts: V3[] = []
  for (let i = 0; i < count; i++) {
    const t = (2 * Math.PI * i) / count
    const cos = Math.cos(t)
    const sin = Math.sin(t)
    pts.push([c[0] + a * Math.sign(cos) * Math.abs(cos) ** (2 / n), c[1] + b * Math.sign(sin) * Math.abs(sin) ** (2 / n), c[2]])
  }
  return pts
}

/** A flat polygon facing +z (and -z: two layers), filled as a fan from its centre. */
function fan(center: V3, outline: V3[]): Geometry {
  const g = geometry()
  for (const z of [1, -1]) {
    const base = g.positions.length / 3
    g.positions.push(...center)
    g.normals.push(0, 0, z)
    for (const p of outline) {
      g.positions.push(...p)
      g.normals.push(0, 0, z)
    }
    for (let i = 0; i < outline.length; i++) {
      const a = base + 1 + i
      const b = base + 1 + ((i + 1) % outline.length)
      if (z > 0) g.indices.push(base, a, b)
      else g.indices.push(base, b, a)
    }
  }
  return g
}

function sphere(c: V3, r: number, segments = 12, rings = 8): Geometry {
  const g = geometry()
  for (let i = 0; i <= rings; i++) {
    const v = (Math.PI * i) / rings
    for (let j = 0; j <= segments; j++) {
      const u = (2 * Math.PI * j) / segments
      const n: V3 = [Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u)]
      g.positions.push(c[0] + r * n[0], c[1] + r * n[1], c[2] + r * n[2])
      g.normals.push(...n)
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j
      const b = a + segments + 1
      g.indices.push(a, a + 1, b, b, a + 1, b + 1)
    }
  }
  return g
}

// ---------------------------------------------------------------------------------------------
// A small glTF 2.0 writer: one binary buffer (the GLB BIN chunk), 4-byte aligned views, PBR materials.

interface Material {
  name: string
  color: [number, number, number, number]
  metallic: number
  roughness: number
  emissive?: V3
  blend?: boolean
  doubleSided?: boolean
}

class Gltf {
  json: any = {
    asset: { version: '2.0', generator: 'ouaf make-demo-assets' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
  }
  chunks: Uint8Array[] = []
  length = 0

  view(bytes: Uint8Array, target?: number): number {
    const byteOffset = this.length
    this.chunks.push(bytes)
    this.length += bytes.length
    const pad = (4 - (this.length % 4)) % 4
    if (pad) {
      this.chunks.push(new Uint8Array(pad))
      this.length += pad
    }
    this.json.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, ...(target ? { target } : {}) })
    return this.json.bufferViews.length - 1
  }

  floats(values: number[], type: 'SCALAR' | 'VEC3' | 'VEC4', target?: number): number {
    const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type]
    const data = new Float32Array(values)
    const min = Array.from({ length: n }, (_, k) => Math.min(...data.filter((_, i) => i % n === k)))
    const max = Array.from({ length: n }, (_, k) => Math.max(...data.filter((_, i) => i % n === k)))
    const bufferView = this.view(new Uint8Array(data.buffer), target)
    this.json.accessors.push({ bufferView, componentType: 5126, count: data.length / n, type, min, max })
    return this.json.accessors.length - 1
  }

  material(m: Material): number {
    this.json.materials.push({
      name: m.name,
      pbrMetallicRoughness: { baseColorFactor: m.color, metallicFactor: m.metallic, roughnessFactor: m.roughness },
      ...(m.emissive ? { emissiveFactor: m.emissive } : {}),
      ...(m.blend ? { alphaMode: 'BLEND' } : {}),
      ...(m.doubleSided ? { doubleSided: true } : {}),
    })
    return this.json.materials.length - 1
  }

  /** A mesh with one primitive per (geometry, material) pair. */
  mesh(name: string, parts: Array<[Geometry, number]>): number {
    const primitives = parts.map(([g, material]) => {
      const POSITION = this.floats(g.positions, 'VEC3', 34962)
      const NORMAL = this.floats(g.normals, 'VEC3', 34962)
      const big = g.positions.length / 3 > 65535
      const indices = big ? new Uint32Array(g.indices) : new Uint16Array(g.indices)
      const bufferView = this.view(new Uint8Array(indices.buffer), 34963)
      this.json.accessors.push({ bufferView, componentType: big ? 5125 : 5123, count: indices.length, type: 'SCALAR' })
      return { attributes: { POSITION, NORMAL }, indices: this.json.accessors.length - 1, material }
    })
    this.json.meshes.push({ name, primitives })
    return this.json.meshes.length - 1
  }

  node(def: { name: string; mesh?: number; children?: number[]; translation?: V3 }, root = false): number {
    this.json.nodes.push(def)
    const index = this.json.nodes.length - 1
    if (root) this.json.scenes[0].nodes.push(index)
    return index
  }

  /** A named animation: channels sampled at `times` (s), linear interpolation. */
  animation(name: string, channels: Array<{ node: number; path: 'translation' | 'rotation'; times: number[]; values: number[] }>): void {
    const samplers = channels.map((c) => ({
      input: this.floats(c.times, 'SCALAR'),
      output: this.floats(c.values, c.path === 'rotation' ? 'VEC4' : 'VEC3'),
      interpolation: 'LINEAR',
    }))
    ;(this.json.animations ??= []).push({
      name,
      samplers,
      channels: channels.map((c, i) => ({ sampler: i, target: { node: c.node, path: c.path } })),
    })
  }

  glb(): Uint8Array {
    this.json.buffers[0].byteLength = this.length
    let json = new TextEncoder().encode(JSON.stringify(this.json))
    const jsonPad = (4 - (json.length % 4)) % 4
    json = Uint8Array.from([...json, ...new Array<number>(jsonPad).fill(0x20)])
    const total = 12 + 8 + json.length + 8 + this.length
    const glb = new Uint8Array(total)
    const view = new DataView(glb.buffer)
    view.setUint32(0, 0x46546c67, true) // "glTF"
    view.setUint32(4, 2, true)
    view.setUint32(8, total, true)
    view.setUint32(12, json.length, true)
    view.setUint32(16, 0x4e4f534a, true) // "JSON"
    glb.set(json, 20)
    let p = 20 + json.length
    view.setUint32(p, this.length, true)
    view.setUint32(p + 4, 0x004e4942, true) // "BIN"
    p += 8
    for (const c of this.chunks) {
      glb.set(c, p)
      p += c.length
    }
    return glb
  }
}

/** Samples `fn(t)` every 1/30 s over `duration` (s), the end included. */
function sample(duration: number, fn: (t: number) => number[]): { times: number[]; values: number[] } {
  const steps = Math.round(duration * 30)
  const times: number[] = []
  const values: number[] = []
  for (let i = 0; i <= steps; i++) {
    const t = (duration * i) / steps
    times.push(t)
    values.push(...fn(t))
  }
  return { times, values }
}

// ---------------------------------------------------------------------------------------------
// Glasses: two rounded rims around the eyes (x = ±0.5), a bridge, temples going back over the ears (hidden by the
// head with `occlusion: "head"`), and tinted, half-transparent lenses. Origin: the `eyes` anchor.

function glasses(): Gltf {
  const g = new Gltf()
  const acetate = g.material({ name: 'frame', color: [0.55, 0.03, 0.08, 1], metallic: 0, roughness: 0.25 })
  const lens = g.material({ name: 'lens', color: [0.1, 0.35, 0.45, 0.35], metallic: 0, roughness: 0.05, blend: true, doubleSided: true })
  const rimR = 0.045
  const rims = [-1, 1].map((side) => superellipse([0.52 * side, 0, 0], 0.4, 0.29, 3.5, 64))
  const frame = merge(
    ...rims.map((pts) => tube(pts, rimR, 10, true)),
    // Bridge: a small arch between the inner edges of the rims.
    tube(Array.from({ length: 13 }, (_, i) => {
      const x = -0.14 + (0.28 * i) / 12
      return [x, 0.1 + 0.05 * Math.cos((Math.PI * x) / 0.28), 0.01] as V3
    }), 0.035, 10),
    // Temples: from the outer edge of each rim (x = ±0.92), back along -z to behind the ears, opening to ±1.2 (about the
    // width of a head near the ear, so that they rest on it) and bending down at the end.
    ...[-1, 1].map((side) =>
      tube(Array.from({ length: 24 }, (_, i) => {
        const u = i / 23
        const z = -0.05 - 1.75 * u
        const y = 0.1 - (u > 0.75 ? 0.6 * ((u - 0.75) / 0.25) ** 2 : 0)
        return [side * (0.92 + 0.28 * Math.sin(Math.min(1, u * 2.5) * (Math.PI / 2))), y, z] as V3
      }), 0.035, 8),
    ),
  )
  const lenses = merge(...rims.map((pts, i) => fan([0.52 * (i === 0 ? -1 : 1), 0, -0.005], pts.map(([x, y]) => [x, y, -0.005] as V3))))
  const mesh = g.mesh('glasses', [[frame, acetate], [lenses, lens]])
  g.node({ name: 'glasses', mesh }, true)
  return g
}

// ---------------------------------------------------------------------------------------------
// Crown: a gold band of 8 spikes with gems, centred on its axis (y up), base at y = 0. Two animations:
// - `drop` (0.9 s, on the root node): falls from above and bounces into place; played when a face appears.
// - `spin` (1 s, on the inner node): a full turn around y with a little hop; the wink-crown script plays it.
// Both end at the rest pose, so either can follow the other.

function crown(): Gltf {
  const g = new Gltf()
  const gold = g.material({ name: 'gold', color: [1, 0.72, 0.25, 1], metallic: 1, roughness: 0.3, doubleSided: true })
  const ruby = g.material({ name: 'ruby', color: [0.85, 0.02, 0.08, 1], metallic: 0, roughness: 0.15, emissive: [0.25, 0, 0.02] })
  const sapphire = g.material({ name: 'sapphire', color: [0.05, 0.2, 0.9, 1], metallic: 0, roughness: 0.15, emissive: [0, 0.03, 0.2] })
  const R = 0.72
  const H = 0.28
  const SPIKE = 0.32
  const N = 8
  const SEG = 96
  // Spike profile: peaks at θ = 2πk/N, so one peak faces the camera (θ = π/2 is +z).
  const top = (theta: number) => {
    const u = (((theta * N) / (2 * Math.PI) + 0.25 * N + 0.5) % 1 + 1) % 1
    return H + SPIKE * (1 - Math.abs(2 * u - 1))
  }
  const band = geometry()
  for (let i = 0; i <= SEG; i++) {
    const t = (2 * Math.PI * i) / SEG
    const c = Math.cos(t)
    const s = Math.sin(t)
    band.positions.push(R * c, 0, R * s, R * c, top(t), R * s)
    band.normals.push(c, 0, s, c, 0, s)
    if (i < SEG) {
      const a = 2 * i
      band.indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
  }
  const circle = (r: number, y: number): V3[] => Array.from({ length: 96 }, (_, i) => [r * Math.cos((2 * Math.PI * i) / 96), y, r * Math.sin((2 * Math.PI * i) / 96)] as V3)
  const goldParts = merge(band, tube(circle(R, 0), 0.05, 10, true), tube(circle(R, H * 0.55), 0.025, 8, true))
  const peaks: V3[] = Array.from({ length: N }, (_, k) => {
    const t = (2 * Math.PI * k) / N + Math.PI / 2
    return [R * Math.cos(t), H + SPIKE + 0.03, R * Math.sin(t)]
  })
  const bandGems: V3[] = Array.from({ length: N }, (_, k) => {
    const t = (2 * Math.PI * (k + 0.5)) / N + Math.PI / 2
    return [(R + 0.03) * Math.cos(t), H * 0.55, (R + 0.03) * Math.sin(t)]
  })
  const mesh = g.mesh('crown', [
    [goldParts, gold],
    [merge(...peaks.map((p) => sphere(p, 0.06))), ruby],
    [merge(...bandGems.map((p) => sphere(p, 0.07))), sapphire],
  ])
  const inner = g.node({ name: 'spin', mesh })
  const root = g.node({ name: 'crown', children: [inner] }, true)

  // A fall with a bounce: y = 3 → 0 by 0.45 s (accelerating), up to 0.3 and back by 0.75 s, then rest.
  const drop = sample(0.9, (t) => {
    let y = 0
    if (t < 0.45) y = 3 * (1 - (t / 0.45) ** 2)
    else if (t < 0.75) y = 0.3 * Math.sin((Math.PI * (t - 0.45)) / 0.3)
    return [0, y, 0]
  })
  g.animation('drop', [{ node: root, path: 'translation', ...drop }])
  // A turn around y, eased in and out; the hop peaks halfway.
  const ease = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t)
  const turn = sample(1, (t) => {
    const a = Math.PI * ease(t) // half the angle: quaternion (0, sin(a), 0, cos(a)) turns by 2a
    return [0, Math.sin(a), 0, Math.cos(a)]
  })
  const hop = sample(1, (t) => [0, 0.45 * Math.sin(Math.PI * t), 0])
  g.animation('spin', [
    { node: inner, path: 'rotation', ...turn },
    { node: inner, path: 'translation', ...hop },
  ])
  return g
}

const outputs: Array<[string, Gltf]> = [
  ['glasses/assets/glasses.glb', glasses()],
  ['wink-crown/assets/crown.glb', crown()],
]
for (const [path, gltf] of outputs) {
  const file = resolve(here, path)
  mkdirSync(dirname(file), { recursive: true })
  const bytes = gltf.glb()
  writeFileSync(file, bytes)
  console.log(`${path}: ${bytes.length} bytes`)
}
// The stress demo carries its own copies: a package is self-contained (spec §3).
mkdirSync(resolve(here, 'stress/assets'), { recursive: true })
for (const name of ['crown', 'glasses']) {
  const from = `${name === 'crown' ? 'wink-crown' : 'glasses'}/assets/${name}.glb`
  copyFileSync(resolve(here, from), resolve(here, `stress/assets/${name}.glb`))
  console.log(`stress/assets/${name}.glb: copy of ${from}`)
}
