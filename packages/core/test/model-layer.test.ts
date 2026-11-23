import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'
import { Box3, Matrix4, Mesh, Quaternion, Vector3, type Material, type Object3D } from 'three'
import { describe, expect, it } from 'vitest'
import type { AnchorProvider } from '../src/engine/anchor-provider.ts'
import type { AssetRequest } from '../src/engine/assets.ts'
import type { FrameContext, LayerContext, LayerDecl } from '../src/engine/layer-type.ts'
import type { FaceFrame } from '../src/face.ts'
import type { BindingDataSource } from '../src/bindings/index.ts'
import { checkGltf, cloneModel, isModelAsset, modelLoader, parseModel, type ModelAsset } from '../src/layers/model/assets.ts'
import { createModel, fitScale, modelRefs, type ModelLayerInstance } from '../src/layers/model/layer.ts'
import { HEAD_CENTER, HEAD_RADII, OCCLUDER_RENDER_ORDER } from '../src/layers/model/occluder.ts'
import { createShapeAsset, parseHex, shapeGeometry } from '../src/layers/model/shapes.ts'
import type { TParams } from '@ouaf/spec'
import { bindingParams } from '../src/engine/filter.ts'
import { ParamStore } from '../src/params/index.ts'
import { ScriptOverrides } from '../src/script/overrides.ts'

const FIXTURES = resolve(import.meta.dirname, '../../../filters/fixtures/model-screen/assets')
const glb = (name: string) => readFileSync(resolve(FIXTURES, name))

const round = (values: number[]) => values.map((v) => Math.round(v * 1000) / 1000 + 0)
const sizeOf = (box: Box3) => round(box.getSize(new Vector3()).toArray())

describe('model sources', () => {
  it('lists its asset references: src, every pick, none for a shape', () => {
    expect(modelRefs({ type: 'model', src: 'hat' })).toEqual(['hat'])
    expect(modelRefs({ type: 'model', src: { pick: ['a', 'b'], by: 'random' } })).toEqual(['a', 'b'])
    expect(modelRefs({ type: 'model', src: { shape: 'torus' } })).toEqual([])
  })

  it('fit: a uniform scale to the width, the height, or the largest that fits both', () => {
    expect(fitScale(undefined, 2, 4)).toBe(1)
    expect(fitScale({ width: 1 }, 2, 4)).toBe(0.5)
    expect(fitScale({ height: 1 }, 2, 4)).toBe(0.25)
    expect(fitScale({ width: 1, height: 1 }, 2, 4)).toBe(0.25)
    expect(fitScale({ width: 3, height: 2 }, 2, 1)).toBe(1.5)
    expect(fitScale({ height: 1 }, 2, 0)).toBe(1) // flat along y: nothing to fit
  })
})

describe('procedural shapes', () => {
  it('fit in a 1 × 1 × 1 box centred on the origin', () => {
    const size = (shape: Parameters<typeof shapeGeometry>[0], thickness?: number) => {
      const g = shapeGeometry(shape, thickness)
      g.computeBoundingBox()
      const center = round(g.boundingBox!.getCenter(new Vector3()).toArray())
      expect(center).toEqual([0, 0, 0])
      return sizeOf(g.boundingBox!)
    }
    expect(size('box')).toEqual([1, 1, 1])
    expect(size('sphere')).toEqual([1, 1, 1])
    expect(size('cone')).toEqual([1, 1, 1])
    expect(size('torus')).toEqual([1, 1, 0.2]) // in the xy plane, tube 0.2
    expect(size('torus', 0.5)).toEqual([1, 1, 0.5])
    expect(size('ring')).toEqual([1, 1, 0])
    expect(size('cylinder')).toEqual([1, 1, 1])
    expect(size('cylinder', 0.5)).toEqual([1, 1, 1]) // thickness is for the torus and the ring only
    expect(size('plane')).toEqual([1, 1, 0])
  })

  it('ring and torus share the band: outer radius 0.5, inner 0.5 − thickness', () => {
    const ring = shapeGeometry('ring', 0.2)
    const p = ring.getAttribute('position')
    let inner = Infinity
    for (let i = 0; i < p.count; i++) inner = Math.min(inner, Math.hypot(p.getX(i), p.getY(i)))
    expect(inner).toBeCloseTo(0.3)
  })

  it('reads sRGB colors, the alpha of `color` as the opacity', () => {
    expect(parseHex('#f0c')).toEqual({ rgb: '#ff00cc', alpha: 1 })
    expect(parseHex('#ff00cc80').alpha).toBeCloseTo(128 / 255)
    const asset = createShapeAsset({ shape: 'box', color: '#80808080', metalness: 1, roughness: 0.2, emissive: '#ff0000' })
    const mesh = asset.scene as Mesh
    const material = mesh.material as import('three').MeshStandardMaterial
    expect(round([material.color.r, material.metalness, material.roughness, material.emissive.r])).toEqual([0.216, 1, 0.2, 1]) // sRGB 128 → linear
    expect([material.transparent, Math.round(material.opacity * 255)]).toEqual([true, 128])
    expect(isModelAsset(asset)).toBe(true)
    expect(sizeOf(asset.bounds)).toEqual([1, 1, 1])
  })
})

describe('model loader', () => {
  it('parses GLB files, meshopt-compressed ones included, with their animations', async () => {
    for (const name of ['red.glb', 'blue-meshopt.glb', 'lift.glb']) {
      const asset = await parseModel(glb(name), undefined)
      expect(sizeOf(asset.bounds)).toEqual([1, 1, 1])
    }
    const lift = await parseModel(glb('lift.glb'), undefined)
    expect(lift.animations.map((a) => [a.name, a.duration])).toEqual([['lift', 2], ['spin', 1]])
  })

  it('refuses what is not glTF 2.0, and resources outside the file', () => {
    const json = (gltf: object) => new TextEncoder().encode(JSON.stringify(gltf))
    expect(() => checkGltf(json({ asset: { version: '1.0' } }))).toThrow(/not glTF 2.0/)
    expect(() => checkGltf(new TextEncoder().encode('solid cube'))).toThrow(/not a glTF 2.0 \/ GLB file/)
    expect(() => checkGltf(json({ asset: { version: '2.0' }, buffers: [{ uri: 'cube.bin', byteLength: 4 }] }))).toThrow(/"cube.bin": a model must embed/)
    expect(() => checkGltf(json({ asset: { version: '2.0' }, images: [{ uri: 'https://example.com/a.png' }] }))).toThrow(/https:\/\/example.com\/a.png/)
    expect(() => checkGltf(json({ asset: { version: '2.0' }, buffers: [{ uri: 'data:application/octet-stream;base64,AAAA', byteLength: 3 }] }))).not.toThrow()
  })

  it('checks textures from their headers before decoding: format, at most 4096 px per side', () => {
    const png = (width: number, height: number) => {
      const b = new Uint8Array(33)
      b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
      new DataView(b.buffer).setUint32(16, width)
      new DataView(b.buffer).setUint32(20, height)
      return b
    }
    const uri = (bytes: Uint8Array) => `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`
    const withImage = (bytes: Uint8Array) => new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: uri(bytes) }] }))
    expect(() => checkGltf(withImage(png(64, 64)))).not.toThrow()
    expect(() => checkGltf(withImage(png(5000, 10)))).toThrow(/texture 0 is 5000×10 px: images are limited to 4096 px per side/)
    const ktx2 = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(20).fill(0)])
    expect(() => checkGltf(withImage(ktx2))).toThrow(/texture 0 is KTX2/)
    expect(() => checkGltf(withImage(new TextEncoder().encode('GIF89a\x10\x00\x10\x00')))).toThrow(/not a PNG, JPEG, WebP or AVIF image \(its content is gif\)/)
    // An image in a buffer view of a data: buffer.
    const buffer = png(8000, 8000)
    const inView = { asset: { version: '2.0' }, buffers: [{ uri: uri(buffer), byteLength: buffer.length }], bufferViews: [{ buffer: 0, byteLength: buffer.length }], images: [{ bufferView: 0, mimeType: 'image/png' }] }
    expect(() => checkGltf(new TextEncoder().encode(JSON.stringify(inView)))).toThrow(/8000×8000/)
  })

  const request = (bytes: Uint8Array<ArrayBuffer>, assetsBaseUrl?: string): AssetRequest => ({
    ref: 'hat',
    kind: 'model',
    entry: undefined,
    path: 'assets/hat.glb',
    builtin: false,
    assetsBaseUrl,
    read: () => Promise.resolve(new Blob([bytes])),
    signal: new AbortController().signal,
  })

  it('reports load errors with the asset; Draco needs the engine (its decoder is served under assetsBaseUrl)', async () => {
    await expect(modelLoader.load(request(new Uint8Array(glb('green-draco.glb'))))).rejects.toThrow(/Model "hat" \(assets\/hat.glb\) could not be loaded: .*DRACOLoader/)
    await expect(modelLoader.load(request(new TextEncoder().encode('{}')))).rejects.toThrow(/asset.version is undefined/)
    const asset = await modelLoader.load(request(new Uint8Array(glb('red.glb')), 'https://host.example/ouaf/'))
    expect(isModelAsset(asset)).toBe(true)
    modelLoader.dispose!(asset)
  })

  it('clones a model per face: own nodes and materials, shared geometry', async () => {
    const asset = await parseModel(glb('red.glb'), undefined)
    const a = cloneModel(asset)
    const b = cloneModel(asset)
    const meshOf = (o: Object3D) => o.getObjectByProperty('isMesh', true) as Mesh
    expect(meshOf(a.root)).not.toBe(meshOf(b.root))
    expect(meshOf(a.root).geometry).toBe(meshOf(b.root).geometry)
    expect(meshOf(a.root).material).not.toBe(meshOf(b.root).material)
    expect(a.materials).toEqual([meshOf(a.root).material])
  })
})

// ---------------------------------------------------------------------------------------------
// The layer, with fake anchors

/** Face slot i: x = 10·i cm, 50 cm away, face unit 6 cm, no rotation. The `head` anchor is 9 cm behind the others. */
function fakeAnchors(ids: number[]): AnchorProvider & { count: number } {
  return {
    count: ids.length,
    face(face, anchor, _follow, out) {
      if (face < 0 || face >= this.count) return false
      out.makeScale(6, 6, 6).setPosition(10 * face, 0, (anchor === 'head' ? -59 : -50) - face)
      return true
    },
    screen(out) {
      out.makeScale(12, 12, 12).setPosition(0, 0, -10)
    },
    id: (face) => ids[face] ?? 0,
  }
}

/** What `test.shown` reads (a boolean the tests toggle). */
let shownData = true

const data: BindingDataSource = {
  resolve: (path) =>
    path === 'face.index'
      ? { type: 'number', perFace: true, read: (face: number, out: Float64Array, i: number) => void (out[i] = face < 0 ? Number.NaN : face) }
      : path === 'test.shown'
        ? { type: 'boolean', perFace: false, read: () => shownData }
        : undefined,
}

function context(assets: Record<string, ModelAsset>, maxFaces = 2, warnings: string[] = []): LayerContext {
  return {
    filterId: 'test',
    renderer: {} as LayerContext['renderer'],
    view: {} as LayerContext['view'],
    assets: { get: <T>(ref: string) => assets[ref] as T, has: (ref) => ref in assets },
    params: {} as LayerContext['params'],
    bindings: { data, params: { type: () => undefined, get: () => undefined } },
    maxFaces,
    random: Math.random,
    warn: (message) => void warnings.push(message),
  }
}

function frameAt(time: number, anchors: AnchorProvider & { count: number }): FrameContext {
  return { time, now: time * 1000, dt: 33, faces: { count: anchors.count } as FaceFrame, anchors, width: 720, height: 1280, mirrored: false }
}

const make = (decl: Record<string, unknown>, ctx: LayerContext, random?: () => number) =>
  createModel({ type: 'model', ...decl } as LayerDecl, ctx, { environment: null, ...(random && { random }) })

/** The holders of the layer's instances (one per face slot), and their occluders. */
const holders = (layer: ModelLayerInstance) => layer.object.children.filter((c) => c.name !== 'head-occluder')
const occluders = (layer: ModelLayerInstance) => layer.object.children.filter((c) => c.name === 'head-occluder') as Mesh[]
const positionOf = (m: Matrix4) => round(new Vector3().setFromMatrixPosition(m).toArray())
const scaleOf = (m: Matrix4) => round(new Vector3().setFromMatrixScale(m).toArray())
const materialsOf = (o: Object3D) => {
  const out: Material[] = []
  o.traverse((c) => (c as Mesh).isMesh && out.push((c as Mesh).material as Material))
  return out
}

describe('model layer', () => {
  const box = () => createShapeAsset({ shape: 'box' })

  it('places one copy per face: anchor, offset, scale (number or vector), rotation in degrees', () => {
    const layer = make({ src: 'box', offset: [0, 1, 0], scale: [1, 2, 3], rotation: [0, 0, 90] }, context({ box: box() }))
    expect(layer.stage).toBe('objects')
    const anchors = fakeAnchors([4, 9])
    layer.update(frameAt(0, anchors))
    const [a, b] = holders(layer)
    expect([a!.visible, b!.visible]).toEqual([true, true])
    expect(positionOf(a!.matrix)).toEqual([0, 6, -59]) // the `head` anchor by default
    expect(scaleOf(a!.matrix)).toEqual([6, 12, 18])
    const x = round(new Vector3(1, 0, 0).transformDirection(a!.matrix).toArray())
    expect(x).toEqual([0, 1, 0])
    expect(positionOf(b!.matrix)).toEqual([10, 6, -60])
    expect(a!.children).toHaveLength(1) // the copy of the model

    anchors.count = 1
    layer.update(frameAt(0.033, anchors))
    expect([a!.visible, b!.visible]).toEqual([true, false])
    layer.dispose()
  })

  it('gives the place of each copy on its anchor, for the draw order of transparent objects (spec §7)', () => {
    const layer = make({ src: 'box', anchor: 'noseTip', offset: [0, 0, 0.4] }, context({ box: box() }))
    layer.update(frameAt(0, fakeAnchors([4, 9])))
    expect(layer.placements!.map((p) => [p.object, p.anchor, p.face, p.z])).toEqual(holders(layer).map((h, i) => [h, 'noseTip', [4, 9][i], 0.4]))
    layer.dispose()
  })

  it('fit rescales the model to a width or height in anchor units, times scale', async () => {
    const lift = await parseModel(glb('lift.glb'), undefined) // a unit cube
    const layer = make({ src: 'lift', fit: { width: 0.5 }, scale: 2 }, context({ lift }, 1))
    layer.update(frameAt(0, fakeAnchors([1])))
    expect(scaleOf(holders(layer)[0]!.matrix)).toEqual([6, 6, 6]) // 1 × 0.5 × 2 face units
    layer.dispose()
  })

  it('orient "screen" keeps the anchor position and scale, not its rotation; "screen" anchor; overlay', () => {
    const turned = make({ src: 'box', orient: 'screen', offset: [1, 0, 0] }, context({ box: box() }, 1))
    const anchors = fakeAnchors([1])
    anchors.face = (face, _a, _f, out) => (out.makeRotationY(Math.PI / 2).scale(new Vector3(6, 6, 6)).setPosition(0, 0, -50), face === 0)
    turned.update(frameAt(0, anchors))
    const m = holders(turned)[0]!.matrix
    expect(positionOf(m)).toEqual([0, 0, -56])
    expect(round(new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(m)).toArray())).toEqual([0, 0, 0, 1])
    turned.dispose()

    const screen = make({ src: 'box', anchor: 'screen', scale: 0.1, overlay: true, excludeFromCapture: true }, context({ box: box() }, 3))
    expect([screen.stage, screen.excludeFromCapture, holders(screen).length]).toEqual(['overlay', true, 1])
    screen.update(frameAt(0, fakeAnchors([])))
    expect(holders(screen)[0]!.visible).toBe(true)
    expect(scaleOf(holders(screen)[0]!.matrix)).toEqual([1.2, 1.2, 1.2])
    screen.dispose()
  })

  it('visible and opacity per face; opacity scales the materials and makes them transparent', () => {
    const layer = make({ src: 'box', opacity: { bind: 'face.index', range: [0, 1], to: [0, 0.5] } }, context({ box: box() }))
    layer.update(frameAt(0, fakeAnchors([1, 2])))
    const [a, b] = holders(layer)
    expect([a!.visible, b!.visible]).toEqual([false, true])
    const [m] = materialsOf(b!)
    expect([m!.opacity, m!.transparent]).toEqual([0.5, true])
    // Each face has its own materials.
    expect(materialsOf(a!)[0]).not.toBe(m)
    layer.dispose()

    const hidden = make({ src: 'box', visible: false }, context({ box: box() }))
    hidden.update(frameAt(0, fakeAnchors([1])))
    expect(holders(hidden)[0]!.visible).toBe(false)
    hidden.dispose()
  })

  it('{ pick } gives each face id its model, (id − 1) mod n, and re-picks for a new id', () => {
    const models = { a: box(), b: createShapeAsset({ shape: 'sphere' }), c: createShapeAsset({ shape: 'cone' }) }
    const layer = make({ src: { pick: ['a', 'b', 'c'] } }, context(models))
    const ids = [1, 2]
    const anchors = fakeAnchors(ids)
    const shown = () => holders(layer).map((h) => h.children[0]!.name)
    layer.update(frameAt(0, anchors))
    expect(shown()).toEqual(['box', 'sphere'])
    ids[0] = 3
    layer.update(frameAt(0.033, anchors))
    expect(shown()).toEqual(['cone', 'sphere'])
    expect(holders(layer)[0]!.children).toHaveLength(1)
    layer.dispose()
  })

  it('{ pick, by: "random" } draws once per face, when it gets its id', () => {
    const models = { a: box(), b: createShapeAsset({ shape: 'sphere' }), c: createShapeAsset({ shape: 'cone' }) }
    const draws = [0.9, 0.1, 0.5]
    let n = 0
    const layer = make({ src: { pick: ['a', 'b', 'c'], by: 'random' } }, context(models), () => draws[n++]!)
    const ids = [1, 2]
    const anchors = fakeAnchors(ids)
    const shown = () => holders(layer).map((h) => h.children[0]!.name)
    layer.update(frameAt(0, anchors))
    layer.update(frameAt(0.033, anchors))
    expect(shown()).toEqual(['cone', 'box'])
    ids[1] = 5
    layer.update(frameAt(0.066, anchors))
    expect(shown()).toEqual(['cone', 'sphere'])
    expect(n).toBe(3)
    layer.dispose()
  })

  it('plays `animation` with the frame time on each face from its arrival; play() restarts a clip', async () => {
    const lift = await parseModel(glb('lift.glb'), undefined)
    const warnings: string[] = []
    const layer = make({ src: 'lift', animation: 'lift' }, context({ lift }, 2, warnings))
    expect(layer.animations).toEqual(['lift', 'spin'])
    const ids = [1, 2]
    const anchors = fakeAnchors(ids)
    anchors.count = 1
    const node = (i: number) => holders(layer)[i]!.getObjectByName('lift')!
    const y = (i: number) => Math.round(node(i).position.y * 1000) / 1000
    layer.update(frameAt(10, anchors)) // activation: the clip starts at 0, whatever the media time
    expect(y(0)).toBe(0)
    layer.update(frameAt(10.5, anchors))
    expect(y(0)).toBe(1) // halfway up (2 units at 1 s)
    anchors.count = 2 // a second face arrives: its own copy starts from the beginning
    layer.update(frameAt(10.75, anchors))
    expect([y(0), y(1)]).toEqual([1.5, 0])
    layer.update(frameAt(11, anchors))
    expect([y(0), y(1)]).toEqual([2, 0.5])

    // play() on one face, then on all.
    // play() on one face: the clip starts on the next frame, from its start.
    expect(layer.play('spin', 2)).toBe(true)
    layer.update(frameAt(11.25, anchors))
    expect([y(0), y(1)]).toEqual([1.5, 0]) // `spin` does not move it, `lift` goes on on the other face
    expect(round(node(1).quaternion.toArray())).toEqual([0, 0, 0, 1])
    layer.update(frameAt(11.5, anchors))
    expect(round(node(1).quaternion.toArray())).toEqual([0, 0, 0.707, 0.707]) // a quarter turn in 0.25 s
    expect(layer.play('nope')).toBe(false)
    // On every face, and the faces that come later.
    expect(layer.play('spin')).toBe(true)
    layer.update(frameAt(11.75, anchors))
    layer.update(frameAt(12, anchors))
    expect(round(node(0).quaternion.toArray())).toEqual([0, 0, 0.707, 0.707])
    ids[1] = 3
    layer.update(frameAt(12.25, anchors))
    expect(holders(layer)[1]!.getObjectByName('lift')!.position.y).toBe(0)
    layer.update(frameAt(12.5, anchors))
    expect(round(holders(layer)[1]!.getObjectByName('lift')!.quaternion.toArray())).toEqual([0, 0, 0.707, 0.707])
    expect(warnings).toEqual([])
    layer.dispose()
  })

  it('keeps animating while hidden by `visible`, and resumes where it is; a face that comes back restarts', async () => {
    const lift = await parseModel(glb('lift.glb'), undefined)
    const layer = make({ src: 'lift', animation: 'lift', loop: false, visible: { bind: 'test.shown' } }, context({ lift }, 1))
    const ids = [1]
    const anchors = fakeAnchors(ids)
    const y = () => Math.round(holders(layer)[0]!.getObjectByName('lift')!.position.y * 1000) / 1000
    shownData = true
    layer.update(frameAt(0, anchors))
    layer.update(frameAt(0.25, anchors))
    expect(y()).toBe(0.5)
    shownData = false
    for (const t of [0.5, 0.75]) layer.update(frameAt(t, anchors))
    expect(holders(layer)[0]!.visible).toBe(false)
    shownData = true
    layer.update(frameAt(1, anchors))
    expect([holders(layer)[0]!.visible, y()]).toEqual([true, 2]) // 1 s in, not 0.5 s
    anchors.count = 0
    layer.update(frameAt(1.25, anchors))
    anchors.count = 1
    ids[0] = 2 // a face that comes back is a new face (new id)
    layer.update(frameAt(1.5, anchors))
    expect(y()).toBe(0) // from the start
    layer.dispose()
  })

  it('without loop, holds the last pose; an unknown animation is a warning', async () => {
    const lift = await parseModel(glb('lift.glb'), undefined)
    const once = make({ src: 'lift', animation: 'lift', loop: false }, context({ lift }, 1))
    const anchors = fakeAnchors([1])
    for (const t of [0, 0.5, 1, 1.5, 2, 2.5, 3]) once.update(frameAt(t, anchors))
    expect(holders(once)[0]!.getObjectByName('lift')!.position.y).toBeCloseTo(0)
    const looping = make({ src: 'lift', animation: 'lift' }, context({ lift }, 1))
    for (const t of [0, 0.5, 1, 1.5, 2, 2.5, 3]) looping.update(frameAt(t, anchors))
    expect(holders(looping)[0]!.getObjectByName('lift')!.position.y).toBeCloseTo(2) // 3 s: the top of the second cycle

    const warnings: string[] = []
    make({ id: 'hat', src: 'lift', animation: 'wave' }, context({ lift }, 1, warnings))
    expect(warnings).toEqual(['layer "hat".animation: no animation "wave" in the model (it has "lift", "spin").'])
  })

  it('occlusion "head": a depth-only head per face, on the head anchor, drawn first', () => {
    const layer = make({ src: 'box', anchor: 'forehead', occlusion: 'head' }, context({ box: box() }))
    const anchors = fakeAnchors([1, 2])
    anchors.count = 1
    layer.update(frameAt(0, anchors))
    const [a, b] = occluders(layer)
    expect([a!.visible, b!.visible]).toEqual([true, false])
    const material = a!.material as import('three').MeshBasicMaterial
    expect([material.colorWrite, material.depthWrite, a!.renderOrder]).toEqual([false, true, OCCLUDER_RENDER_ORDER])
    expect(positionOf(a!.matrix)).toEqual(round(HEAD_CENTER.map((v, i) => v * 6 + [0, 0, -59][i]!)))
    expect(scaleOf(a!.matrix)).toEqual(round(HEAD_RADII.map((r) => r * 6)))
    layer.dispose()

    const warnings: string[] = []
    const screen = make({ src: 'box', anchor: 'screen', occlusion: 'head' }, context({ box: box() }, 1, warnings))
    expect(occluders(screen)).toEqual([])
    expect(warnings).toEqual(['model.occlusion: "head" has no effect with anchor "screen".'])
  })

  it('refuses an asset that is not a model', () => {
    const ctx = context({})
    ctx.assets.get = <T>() => 'void main() {}' as T
    expect(() => make({ src: 'fx' }, ctx)).toThrow(/not a glTF model/)
  })
})

describe('model layer: src bound to a param, src and animation set by a script (spec §8, §12.4, #140)', () => {
  const box = () => createShapeAsset({ shape: 'box' })
  const params: TParams = {
    shape: { type: 'select', default: 'a', options: { a: 'A', b: 'B' } },
    hat: { type: 'asset', accept: ['model/gltf-binary'], optional: true },
  }
  function bound(assets: Record<string, ModelAsset>, host: Record<string, ModelAsset | null> = {}, overrides?: ScriptOverrides) {
    const store = new ParamStore(params)
    const ctx: LayerContext = {
      ...context(assets),
      params: store,
      hostAssets: { get: (name) => host[name] ?? null },
      bindings: { data, params: bindingParams(store), ...(overrides ? { overrides: overrides.forLayer(0) } : {}) },
    }
    return { ctx, store }
  }
  const shown = (layer: ModelLayerInstance) => holders(layer).filter((h) => h.visible).map((h) => h.children[0]!.name)

  it('shows the model a select param maps its value to, keeping the copies of the filter\'s models', () => {
    const models = { a: box(), b: createShapeAsset({ shape: 'sphere' }) }
    const { ctx, store } = bound(models)
    const layer = make({ src: { param: 'shape', map: { a: 'a', b: 'b' } } }, ctx)
    const anchors = fakeAnchors([1])
    layer.update(frameAt(0, anchors))
    expect(shown(layer)).toEqual(['box'])
    const first = holders(layer)[0]!.children[0]
    store.set('shape', 'b')
    store.beginFrame(33)
    layer.update(frameAt(0.033, anchors))
    expect(shown(layer)).toEqual(['sphere'])
    store.set('shape', 'a')
    store.beginFrame(66)
    layer.update(frameAt(0.066, anchors))
    expect(holders(layer)[0]!.children[0]).not.toBe(first) // a copy of the map's model is made again when shown again
    expect(shown(layer)).toEqual(['box'])
    layer.dispose()
  })

  it('shows the host\'s model, nothing without one, and drops the copy of a replaced one', () => {
    const host: Record<string, ModelAsset | null> = { hat: null }
    const { ctx } = bound({}, host)
    const layer = make({ src: { param: 'hat' } }, ctx)
    const anchors = fakeAnchors([1])
    layer.update(frameAt(0, anchors))
    expect(shown(layer)).toEqual([])
    host.hat = box()
    layer.update(frameAt(0.033, anchors))
    expect(shown(layer)).toEqual(['box'])
    const material = materialsOf(holders(layer)[0]!)[0]!
    let disposed = false
    material.addEventListener('dispose', () => void (disposed = true))
    host.hat = createShapeAsset({ shape: 'cone' })
    layer.update(frameAt(0.066, anchors))
    expect(shown(layer)).toEqual(['cone'])
    expect(disposed).toBe(true)
    layer.dispose()
  })

  it('takes the script\'s model and animation names; null restores the manifest values', async () => {
    const lift = await parseModel(glb('lift.glb'), undefined)
    const overrides = new ScriptOverrides()
    overrides.idOf = (slot) => (slot < 0 ? 0 : 1)
    const { ctx } = bound({ lift, other: box() }, {}, overrides)
    const layer = make({ src: 'lift', animation: 'lift' }, ctx)
    const anchors = fakeAnchors([1])
    const node = () => holders(layer)[0]!.getObjectByName('lift')!
    layer.update(frameAt(0, anchors))
    layer.update(frameAt(0.5, anchors))
    expect(Math.round(node().position.y * 1000) / 1000).toBe(1)
    const animation = overrides.property(0, 'animation')!
    expect(animation.problem('nope')).toBe('the model has no animation "nope"')
    animation.set(undefined, 'spin')
    layer.update(frameAt(0.75, anchors)) // restarted: `spin` does not move it
    expect(node().position.y).toBe(0)
    layer.update(frameAt(1, anchors))
    expect(round(node().quaternion.toArray())).toEqual([0, 0, 0.707, 0.707])
    animation.set(undefined, null)
    layer.update(frameAt(1.25, anchors)) // `lift` again, from its start
    layer.update(frameAt(1.75, anchors))
    expect(Math.round(node().position.y * 1000) / 1000).toBe(1)

    const src = overrides.property(0, 'src')!
    expect(src.problem('other')).toBeUndefined()
    src.set(undefined, 'other')
    layer.update(frameAt(2, anchors))
    expect(shown(layer)).toEqual(['box'])
    src.set(undefined, null)
    layer.update(frameAt(2.033, anchors))
    expect(holders(layer)[0]!.getObjectByName('lift')).toBeDefined()
    layer.dispose()
  })
})

describe('model layer: allocation', () => {
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void

  /** Bytes allocated per frame by `layers`, with 1 to 4 faces in turn. */
  const perFrame = (layers: ModelLayerInstance[]) => {
    const anchors = fakeAnchors([1, 2, 3, 4])
    const frame = frameAt(0, anchors) as { -readonly [K in keyof FrameContext]: FrameContext[K] }
    const state = new Float64Array(1)
    const run = (frames: number) => {
      for (let i = 0; i < frames; i++) {
        state[0]! += 0.033
        frame.time = state[0]!
        frame.now = state[0]! * 1000
        anchors.count = 1 + (i % 4)
        for (let l = 0; l < layers.length; l++) layers[l]!.update(frame)
      }
    }
    const measure = (frames: number) => {
      gc()
      const before = process.memoryUsage().heapUsed
      run(frames)
      return process.memoryUsage().heapUsed - before
    }
    measure(20_000)
    let best = Infinity
    for (let r = 0; r < 3; r++) best = Math.min(best, (measure(60_000) - measure(10_000)) / 50_000)
    for (const l of layers) l.dispose()
    return best
  }

  it('allocates nothing per frame for still models', { timeout: 30_000 }, async () => {
    const lift = await parseModel(glb('lift.glb'), undefined)
    const ctx = context({ lift, a: createShapeAsset({ shape: 'box' }), b: createShapeAsset({ shape: 'torus' }) }, 4)
    const bytes = perFrame([
      make({ src: 'lift', offset: [0, 1, 0], rotation: [0, 0, 15], occlusion: 'head', opacity: { bind: 'face.index', range: [0, 3], to: [1, 0.5] } }, ctx),
      make({ src: { pick: ['a', 'b'] }, orient: 'screen', faces: 'largest', scale: { bind: 'face.index', range: [0, 3], to: [1, 2] } }, ctx),
      make({ src: 'a', anchor: 'screen', fit: { height: 0.2 }, scale: [1, 2, 1] }, ctx),
    ])
    expect(bytes).toBeLessThan(16)
  })

  // three's AnimationMixer passes fractional numbers through calls V8 does not inline, so each update boxes a few of
  // them (about 50 bytes per animated face and frame). A budget, so a regression still shows.
  it('allocates a bounded amount per animated face', { timeout: 30_000 }, async () => {
    const lift = await parseModel(glb('lift.glb'), undefined)
    const bytes = perFrame([make({ src: 'lift', animation: 'lift', occlusion: 'head' }, context({ lift }, 4))])
    expect(bytes).toBeLessThan(2.5 * 160) // 2.5 animated faces per frame on average
  })
})
