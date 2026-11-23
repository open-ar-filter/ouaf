/**
 * Rebuilds the synthetic glTF models of the model fixtures (`model-screen/assets/`, `model/assets/`, `content/assets/`):
 * unit cubes written from code, no third-party model. CC0, like the fixtures.
 *
 * - `red.glb`, `gray.glb`: plain GLB, unlit material (`KHR_materials_unlit`), so the rendered color is known: the
 *   base color factor is linear, the canvas gets its sRGB encoding (linear 0.2158605 → 128); also in
 *   `content/assets/`.
 * - `green-draco.glb`: Draco compression (`KHR_draco_mesh_compression`).
 * - `blue-meshopt.glb`: meshopt compression (`EXT_meshopt_compression`).
 * - `lift.glb`: yellow, with two animations: `lift` (moves up 2 units and back, 2 s) and `spin` (a turn around z, 1 s);
 *   also in `model/assets/`.
 *
 * The encoders are not dependencies of the project; install them anywhere and point `ENCODERS` at that folder:
 *
 *   npm i --prefix /tmp/ouaf-encoders draco3dgltf@1.5.7 meshoptimizer@1.1.1
 *   ENCODERS=/tmp/ouaf-encoders node filters/fixtures/make-model-assets.ts
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, 'model-screen/assets')
const encoders = process.env.ENCODERS
if (!encoders) throw new Error('Set ENCODERS to a folder where draco3dgltf and meshoptimizer are installed (see the header).')

const require = createRequire(resolve(encoders, 'package.json'))
const draco3d = require('draco3dgltf') as { createEncoderModule(o: object): Promise<DracoEncoderModule> }
const { MeshoptEncoder } = (await import(pathToFileURL(resolve(encoders, 'node_modules/meshoptimizer/index.js')).href)) as {
  MeshoptEncoder: { ready: Promise<void>; encodeGltfBuffer(source: Uint8Array, count: number, size: number, mode: string): Uint8Array }
}

type DracoEncoderModule = any

// ---------------------------------------------------------------------------------------------
// The cube: 24 vertices (4 per face, flat normals), 12 triangles, size 1 centred on the origin.

function cube(): { positions: Float32Array; normals: Float32Array; indices: Uint16Array } {
  const faces: Array<[number[], number[], number[]]> = [
    // normal, u axis, v axis
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ]
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  for (const [n, u, v] of faces) {
    const base = positions.length / 3
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      for (let k = 0; k < 3; k++) positions.push(0.5 * (n[k]! + a * u[k]! + b * v[k]!))
      normals.push(...n)
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices) }
}

// ---------------------------------------------------------------------------------------------
// A small glTF builder: one buffer (the GLB BIN chunk), 4-byte aligned views.

class Gltf {
  json: any = {
    asset: { version: '2.0', generator: 'ouaf make-model-assets' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
  }
  chunks: Uint8Array[] = []
  length = 0

  use(name: string, required = false): void {
    ;(this.json.extensionsUsed ??= []).includes(name) || this.json.extensionsUsed.push(name)
    if (required) (this.json.extensionsRequired ??= []).includes(name) || this.json.extensionsRequired.push(name)
  }

  /** Appends bytes to the BIN chunk; returns their offset. */
  append(bytes: Uint8Array): number {
    const offset = this.length
    this.chunks.push(bytes)
    this.length += bytes.length
    const pad = (4 - (this.length % 4)) % 4
    if (pad) {
      this.chunks.push(new Uint8Array(pad))
      this.length += pad
    }
    return offset
  }

  view(bytes: Uint8Array, extra: object = {}): number {
    const byteOffset = this.append(bytes)
    this.json.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, ...extra })
    return this.json.bufferViews.length - 1
  }

  accessor(def: object): number {
    this.json.accessors.push(def)
    return this.json.accessors.length - 1
  }

  floats(data: Float32Array, type: string, extra: object = {}): number {
    const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type]!
    const min = Array.from({ length: n }, (_, k) => Math.min(...data.filter((_, i) => i % n === k)))
    const max = Array.from({ length: n }, (_, k) => Math.max(...data.filter((_, i) => i % n === k)))
    const bufferView = this.view(new Uint8Array(data.buffer.slice(0)), extra)
    return this.accessor({ bufferView, componentType: 5126, count: data.length / n, type, min, max })
  }

  unlit(name: string, rgb: [number, number, number]): number {
    this.use('KHR_materials_unlit')
    this.json.materials.push({ name, pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} } })
    return this.json.materials.length - 1
  }

  glb(): Uint8Array {
    this.json.buffers[0].byteLength = this.length
    let json = new TextEncoder().encode(JSON.stringify(this.json))
    const jsonPad = (4 - (json.length % 4)) % 4
    json = Uint8Array.from([...json, ...new Array<number>(jsonPad).fill(0x20)])
    const total = 12 + 8 + json.length + 8 + this.length
    const glb = new Uint8Array(total)
    const view = new DataView(glb.buffer)
    view.setUint32(0, 0x46546c67, true)
    view.setUint32(4, 2, true)
    view.setUint32(8, total, true)
    view.setUint32(12, json.length, true)
    view.setUint32(16, 0x4e4f534a, true)
    glb.set(json, 20)
    let p = 20 + json.length
    view.setUint32(p, this.length, true)
    view.setUint32(p + 4, 0x004e4942, true)
    p += 8
    for (const c of this.chunks) {
      glb.set(c, p)
      p += c.length
    }
    return glb
  }
}

const SRGB_128 = 0.2158605 // linear value whose sRGB encoding is 128/255

function plainCube(name: string, rgb: [number, number, number]): Gltf {
  const g = new Gltf()
  const { positions, normals, indices } = cube()
  const position = g.floats(positions, 'VEC3', { target: 34962 })
  const normal = g.floats(normals, 'VEC3', { target: 34962 })
  const index = g.accessor({ bufferView: g.view(new Uint8Array(indices.buffer), { target: 34963 }), componentType: 5123, count: indices.length, type: 'SCALAR' })
  g.json.meshes.push({ name, primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices: index, material: g.unlit(name, rgb) }] })
  g.json.nodes.push({ name, mesh: 0 })
  return g
}

async function dracoCube(name: string, rgb: [number, number, number]): Promise<Gltf> {
  const draco = await draco3d.createEncoderModule({})
  const { positions, normals, indices } = cube()
  const builder = new draco.MeshBuilder()
  const mesh = new draco.Mesh()
  builder.AddFacesToMesh(mesh, indices.length / 3, new Uint32Array(indices))
  const posId = builder.AddFloatAttributeToMesh(mesh, draco.POSITION, positions.length / 3, 3, positions)
  const normalId = builder.AddFloatAttributeToMesh(mesh, draco.NORMAL, normals.length / 3, 3, normals)
  const encoder = new draco.Encoder()
  // Sequential encoding keeps the vertex count and order, so the accessors below stay valid.
  encoder.SetEncodingMethod(draco.MESH_SEQUENTIAL_ENCODING)
  encoder.SetAttributeQuantization(draco.POSITION, 14)
  encoder.SetAttributeQuantization(draco.NORMAL, 10)
  const data = new draco.DracoInt8Array()
  const length = encoder.EncodeMeshToDracoBuffer(mesh, data)
  if (!(length > 0)) throw new Error('Draco encoding failed')
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = data.GetValue(i) & 0xff
  for (const o of [data, encoder, mesh, builder]) draco.destroy(o)

  const g = new Gltf()
  g.use('KHR_draco_mesh_compression', true)
  const bufferView = g.view(bytes)
  const vec3 = (src: Float32Array) => ({
    componentType: 5126,
    count: src.length / 3,
    type: 'VEC3',
    min: [0, 1, 2].map((k) => Math.min(...src.filter((_, i) => i % 3 === k))),
    max: [0, 1, 2].map((k) => Math.max(...src.filter((_, i) => i % 3 === k))),
  })
  const position = g.accessor(vec3(positions))
  const normal = g.accessor(vec3(normals))
  const index = g.accessor({ componentType: 5123, count: indices.length, type: 'SCALAR' })
  g.json.meshes.push({
    name,
    primitives: [{
      attributes: { POSITION: position, NORMAL: normal },
      indices: index,
      material: g.unlit(name, rgb),
      extensions: { KHR_draco_mesh_compression: { bufferView, attributes: { POSITION: posId, NORMAL: normalId } } },
    }],
  })
  g.json.nodes.push({ name, mesh: 0 })
  return g
}

async function meshoptCube(name: string, rgb: [number, number, number]): Promise<Gltf> {
  await MeshoptEncoder.ready
  const { positions, normals, indices } = cube()
  const g = new Gltf()
  g.use('EXT_meshopt_compression', true)
  // Buffer 1: the uncompressed layout, never loaded (no uri, `fallback`); buffer 0 (BIN) holds the compressed data.
  g.json.buffers.push({ byteLength: 0, extensions: { EXT_meshopt_compression: { fallback: true } } })
  let fallbackLength = 0
  const compressed = (src: Uint8Array, count: number, stride: number, mode: 'ATTRIBUTES' | 'TRIANGLES', target: number) => {
    const data = MeshoptEncoder.encodeGltfBuffer(src, count, stride, mode)
    const byteOffset = g.append(data)
    const view = {
      buffer: 1,
      byteOffset: fallbackLength,
      byteLength: src.length,
      ...(mode === 'ATTRIBUTES' && { byteStride: stride }),
      target,
      extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset, byteLength: data.length, byteStride: stride, count, mode } },
    }
    fallbackLength += Math.ceil(src.length / 4) * 4
    g.json.bufferViews.push(view)
    return g.json.bufferViews.length - 1
  }
  const vec3 = (src: Float32Array) => ({
    bufferView: compressed(new Uint8Array(src.buffer.slice(0)), src.length / 3, 12, 'ATTRIBUTES', 34962),
    componentType: 5126,
    count: src.length / 3,
    type: 'VEC3',
    min: [0, 1, 2].map((k) => Math.min(...src.filter((_, i) => i % 3 === k))),
    max: [0, 1, 2].map((k) => Math.max(...src.filter((_, i) => i % 3 === k))),
  })
  const position = g.accessor(vec3(positions))
  const normal = g.accessor(vec3(normals))
  const index = g.accessor({ bufferView: compressed(new Uint8Array(indices.buffer.slice(0)), indices.length, 2, 'TRIANGLES', 34963), componentType: 5123, count: indices.length, type: 'SCALAR' })
  g.json.buffers[1].byteLength = fallbackLength
  g.json.meshes.push({ name, primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices: index, material: g.unlit(name, rgb) }] })
  g.json.nodes.push({ name, mesh: 0 })
  return g
}

/** A yellow cube with the `lift` and `spin` animations on its node. */
function animatedCube(): Gltf {
  const g = plainCube('lift', [1, 1, 0])
  const sampler = (input: number, output: number) => ({ input, output, interpolation: 'LINEAR' })
  const liftTimes = g.floats(new Float32Array([0, 1, 2]), 'SCALAR')
  const liftValues = g.floats(new Float32Array([0, 0, 0, 0, 2, 0, 0, 0, 0]), 'VEC3')
  const spinTimes = g.floats(new Float32Array([0, 0.25, 0.5, 0.75, 1]), 'SCALAR')
  const s = Math.SQRT1_2
  // Quaternions (x, y, z, w) of 0°, 90°, 180°, 270°, 360° around z.
  const spinValues = g.floats(new Float32Array([0, 0, 0, 1, 0, 0, s, s, 0, 0, 1, 0, 0, 0, s, -s, 0, 0, 0, -1]), 'VEC4')
  g.json.animations = [
    { name: 'lift', samplers: [sampler(liftTimes, liftValues)], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] },
    { name: 'spin', samplers: [sampler(spinTimes, spinValues)], channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }] },
  ]
  return g
}

mkdirSync(out, { recursive: true })
const files: Record<string, Gltf> = {
  'red.glb': plainCube('red', [1, 0, 0]),
  'gray.glb': plainCube('gray', [SRGB_128, SRGB_128, SRGB_128]),
  'green-draco.glb': await dracoCube('green', [0, 1, 0]),
  'blue-meshopt.glb': await meshoptCube('blue', [0, 0, 1]),
  'lift.glb': animatedCube(),
}
for (const [name, gltf] of Object.entries(files)) {
  const bytes = gltf.glb()
  writeFileSync(resolve(out, name), bytes)
  console.log(`${name}: ${bytes.length} bytes`)
}
mkdirSync(resolve(here, 'model/assets'), { recursive: true })
copyFileSync(resolve(out, 'lift.glb'), resolve(here, 'model/assets/lift.glb'))
mkdirSync(resolve(here, 'content/assets'), { recursive: true })
for (const name of ['red.glb', 'gray.glb']) copyFileSync(resolve(out, name), resolve(here, `content/assets/${name}`))
