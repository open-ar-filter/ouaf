import { CustomBlending, DstColorFactor, Matrix4, OneFactor, OneMinusSrcAlphaFactor, OneMinusSrcColorFactor, Texture, Vector3, Vector4 } from 'three'
import { describe, expect, it } from 'vitest'
import type { AnchorProvider } from '../src/engine/anchor-provider.ts'
import type { FrameContext, LayerContext, LayerDecl, ObjectLayer } from '../src/engine/layer-type.ts'
import type { FaceFrame } from '../src/face.ts'
import { createStickerAsset, imageLoader, sizeSvg, spritesheetLoader, videoLoader, type StickerAsset } from '../src/layers/sticker/assets.ts'
import type { AssetRequest } from '../src/engine/assets.ts'
import { createSticker, stickerRefs } from '../src/layers/sticker/layer.ts'
import { BLEND_FACTORS, StickerMaterial } from '../src/layers/sticker/material.ts'
import { clockStep, frameRect, spriteFrame, videoDrift, videoTarget } from '../src/layers/sticker/playback.ts'
import { pickIndex } from '../src/layers/sticker/select.ts'
import type { BindingDataSource } from '../src/bindings/index.ts'
import type { TParams } from '@ouaf/spec'
import { bindingParams } from '../src/engine/filter.ts'
import { ParamStore } from '../src/params/index.ts'
import { ScriptOverrides } from '../src/script/overrides.ts'
import { bytesPerCall } from './allocation.ts'

describe('sticker playback math', () => {
  it('advances the clock with the frame time; a backwards jump or a long gap counts as no time', () => {
    expect(clockStep(-1, 5)).toBe(0) // first frame
    expect(clockStep(1, 1.033)).toBeCloseTo(0.033)
    expect(clockStep(3, 0.02)).toBe(0) // the source looped
    expect(clockStep(1, 4)).toBe(0) // paused, seeked, hidden tab
  })

  it('picks the spritesheet frame, looping or holding the last one', () => {
    expect(spriteFrame(0, 12, 8, true)).toBe(0)
    expect(spriteFrame(1 / 12, 12, 8, true)).toBe(1) // exactly on a frame boundary, despite rounding
    expect(spriteFrame(3 / 12, 12, 8, true)).toBe(3)
    expect(spriteFrame(0.999, 12, 8, true)).toBe(3) // frame 11 of a loop of 8
    expect(spriteFrame(10, 12, 8, true)).toBe(120 % 8)
    expect(spriteFrame(10, 12, 8, false)).toBe(7)
    expect(spriteFrame(5, 12, 1, true)).toBe(0)
  })

  it('maps a frame to its rectangle, row by row from the top left', () => {
    const r = new Vector4()
    const rect = (i: number) => (frameRect(i, 4, 2, r), r.toArray())
    expect(rect(0)).toEqual([0, 0, 0.25, 0.5])
    expect(rect(3)).toEqual([0.75, 0, 0.25, 0.5])
    expect(rect(5)).toEqual([0.25, 0.5, 0.25, 0.5])
    expect(rect(8)).toEqual([0, 0, 0.25, 0.5]) // wraps
  })

  it('computes the video position and its drift the short way round a loop', () => {
    expect(videoTarget(7.5, 3, true)).toBeCloseTo(1.5)
    expect(videoTarget(7.5, 3, false)).toBe(3)
    expect(videoTarget(2, Number.POSITIVE_INFINITY, true)).toBe(2)
    expect(videoDrift(2.9, 0.1, 3, true)).toBeCloseTo(-0.2) // behind, across the loop point
    expect(videoDrift(0.1, 2.9, 3, true)).toBeCloseTo(0.2)
    expect(videoDrift(0.1, 2.9, 3, false)).toBeCloseTo(-2.8)
    expect(videoDrift(1.05, 1, 3, true)).toBeCloseTo(0.05)
  })
})

describe('sticker pick', () => {
  it('picks per face id (stable, successive faces get successive assets) or from a random draw', () => {
    expect([1, 2, 3, 4].map((id) => pickIndex('face', id, 3, 0))).toEqual([0, 1, 2, 0])
    expect(pickIndex('face', 0, 3, 0)).toBe(0)
    expect(pickIndex('random', 5, 3, 0.7)).toBe(2)
    expect(pickIndex('random', 6, 3, 0.1)).toBe(0) // the face id does not count
    expect(pickIndex('random', 1, 3, 0.999999)).toBe(2)
    expect(pickIndex('face', 9, 1, 0.5)).toBe(0)
  })
})

describe('sticker blend modes', () => {
  it('maps each mode to premultiplied blend factors', () => {
    expect(BLEND_FACTORS.normal).toEqual({ src: OneFactor, dst: OneMinusSrcAlphaFactor })
    expect(BLEND_FACTORS.add).toEqual({ src: OneFactor, dst: OneFactor })
    expect(BLEND_FACTORS.multiply).toEqual({ src: DstColorFactor, dst: OneMinusSrcAlphaFactor })
    expect(BLEND_FACTORS.screen).toEqual({ src: OneFactor, dst: OneMinusSrcColorFactor })
    const m = new StickerMaterial('screen')
    expect([m.blending, m.blendSrc, m.blendDst, m.transparent, m.depthWrite]).toEqual([CustomBlending, OneFactor, OneMinusSrcColorFactor, true, false])
  })

  // The blend equation on one channel, as the GPU computes it: out = S·src + D·dst, S premultiplied.
  const blend = (mode: keyof typeof BLEND_FACTORS, c: number, a: number, d: number) => {
    const S = c * a
    const factor = (f: number, src: boolean) =>
      f === OneFactor ? 1 : f === OneMinusSrcAlphaFactor ? 1 - a : f === DstColorFactor ? d : f === OneMinusSrcColorFactor ? 1 - S : src ? 0 : 0
    const f = BLEND_FACTORS[mode]
    return S * factor(f.src, true) + d * factor(f.dst, false)
  }

  it('gives the expected compositing results, and no change at opacity 0', () => {
    expect(blend('normal', 0.8, 0.5, 0.2)).toBeCloseTo(0.8 * 0.5 + 0.2 * 0.5)
    expect(blend('add', 0.4, 0.5, 0.3)).toBeCloseTo(0.3 + 0.2)
    expect(blend('multiply', 0.5, 1, 0.6)).toBeCloseTo(0.3)
    expect(blend('multiply', 0.5, 0.5, 0.6)).toBeCloseTo(0.6 * (0.25 + 0.5))
    expect(blend('screen', 0.5, 1, 0.6)).toBeCloseTo(1 - 0.5 * 0.4)
    for (const mode of ['normal', 'add', 'multiply', 'screen'] as const) expect(blend(mode, 0.7, 0, 0.42)).toBeCloseTo(0.42)
  })
})

describe('sizeSvg', () => {
  it('rasterizes at the aspect ratio of width/height or the viewBox', () => {
    const a = sizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect/></svg>', 512)
    expect([a.width, a.height]).toEqual([512, 256])
    expect(a.markup).toBe('<svg width="512" height="256" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect/></svg>')
    const b = sizeSvg("<?xml version='1.0'?><svg width='30px' height=\"60\" xmlns='http://www.w3.org/2000/svg'><g/></svg>", 100)
    expect([b.width, b.height]).toEqual([50, 100])
    // A viewBox is added from the original size, so the drawing scales to the new size.
    expect(b.markup).toBe("<?xml version='1.0'?><svg width=\"50\" height=\"100\" viewBox=\"0 0 30 60\" xmlns='http://www.w3.org/2000/svg'><g/></svg>")
    const c = sizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100%"><g/></svg>', 64)
    expect([c.width, c.height]).toEqual([64, 64])
  })
})

describe('sticker asset loaders: checks before decoding (spec §10.4)', () => {
  const request = (bytes: Uint8Array<ArrayBuffer>, kind: AssetRequest['kind'] = 'image', entry?: AssetRequest['entry']): AssetRequest => ({
    ref: 'x',
    kind,
    entry,
    path: 'assets/x.bin',
    builtin: false,
    read: () => Promise.resolve(new Blob([bytes])),
    signal: new AbortController().signal,
  })
  const png = (width: number, height: number) => {
    const b = new Uint8Array(33)
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    new DataView(b.buffer).setUint32(16, width)
    new DataView(b.buffer).setUint32(20, height)
    return b
  }
  const ktx2 = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(20).fill(0)])

  it('refuses images over 4096 px, KTX2, other formats and unreadable headers', async () => {
    await expect(imageLoader.load(request(png(5000, 10)))).rejects.toThrow(/5000×10 px: images are limited to 4096 px per side/)
    await expect(imageLoader.load(request(ktx2))).rejects.toThrow(/KTX2/)
    await expect(imageLoader.load(request(new TextEncoder().encode('GIF89a\x10\x00\x10\x00')))).rejects.toThrow(/not a PNG, WebP, JPEG, AVIF or SVG image \(its content is gif\)/)
    await expect(imageLoader.load(request(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])))).rejects.toThrow(/Could not read the dimensions/)
  })

  it('refuses a spritesheet without frames, and a video that is not MP4 or WebM', async () => {
    await expect(spritesheetLoader.load(request(png(64, 64), 'spritesheet', 'assets/x.png'))).rejects.toThrow(/no "frames" grid/)
    await expect(videoLoader.load(request(png(64, 64), 'video'))).rejects.toThrow(/not an MP4 or WebM video \(its content is png\)/)
  })
})

// ---------------------------------------------------------------------------------------------
// The layer, with fake assets and anchors

function asset(kind: StickerAsset['kind'], width: number, height: number, extra: Partial<StickerAsset> = {}): StickerAsset {
  return createStickerAsset({
    kind,
    texture: new Texture(),
    textureWidth: width,
    textureHeight: height,
    width,
    height,
    frames: undefined,
    packed: false,
    video: undefined,
    owner: undefined,
    ...extra,
  })
}

/** Face slot i sits at x = 10·i cm, 50 cm away, with a face unit of 6 cm and no rotation. */
function fakeAnchors(ids: number[]): AnchorProvider & { count: number } {
  return {
    count: ids.length,
    face(face, _anchor, _follow, out) {
      if (face < 0 || face >= this.count) return false
      out.makeScale(6, 6, 6).setPosition(10 * face, 0, -50 - face)
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

/** `face.index` data: the slot index (NaN without a face); `test.shown`: `shownData`. */
const data: BindingDataSource = {
  resolve: (path) =>
    path === 'face.index'
      ? { type: 'number', perFace: true, read: (face: number, out: Float64Array, i: number) => void (out[i] = face < 0 ? Number.NaN : face) }
      : path === 'test.shown'
        ? { type: 'boolean', perFace: false, read: () => shownData }
        : undefined,
}

function context(assets: Record<string, StickerAsset>, maxFaces = 2): LayerContext {
  return {
    filterId: 'test',
    renderer: {} as LayerContext['renderer'],
    view: {} as LayerContext['view'],
    assets: { get: <T>(ref: string) => assets[ref] as T, has: (ref) => ref in assets },
    params: {} as LayerContext['params'],
    bindings: { data, params: { type: () => undefined, get: () => undefined } },
    maxFaces,
    random: Math.random,
    warn: () => {},
  }
}

function frameAt(time: number, anchors: AnchorProvider & { count: number }): FrameContext {
  return { time, now: time * 1000, dt: 33, faces: { count: anchors.count } as FaceFrame, anchors, width: 720, height: 1280, mirrored: false }
}

const meshes = (layer: ObjectLayer) => layer.object.children as Array<import('three').Mesh<import('three').BufferGeometry, StickerMaterial>>
const positionOf = (m: Matrix4) => new Vector3().setFromMatrixPosition(m).toArray().map((v) => Math.round(v * 1000) / 1000)
const scaleOf = (m: Matrix4) => new Vector3().setFromMatrixScale(m).toArray().map((v) => Math.round(v * 1000) / 1000)

describe('sticker layer', () => {
  it('lists its asset references', () => {
    expect(stickerRefs({ type: 'sticker', src: 'hat' })).toEqual(['hat'])
    expect(stickerRefs({ type: 'sticker', src: { pick: ['a', 'b'] } })).toEqual(['a', 'b'])
  })

  it('places one quad per face: anchor, offset, size and aspect ratio', () => {
    const layer = createSticker({ type: 'sticker', src: 'wide', size: 0.5, offset: [0, 1, 0] } as LayerDecl, context({ wide: asset('image', 200, 100) }))
    expect(layer.stage).toBe('objects')
    const anchors = fakeAnchors([4, 9])
    layer.update(frameAt(0, anchors))
    const [a, b] = meshes(layer)
    expect([a!.visible, b!.visible]).toEqual([true, true])
    expect(positionOf(a!.matrix)).toEqual([0, 6, -50]) // offset of 1 face unit up
    expect(scaleOf(a!.matrix)).toEqual([6, 3, 6]) // 0.5 units high, twice as wide
    expect(positionOf(b!.matrix)).toEqual([10, 6, -51])

    anchors.count = 1
    layer.update(frameAt(0.033, anchors))
    expect([a!.visible, b!.visible]).toEqual([true, false])
    layer.dispose()
  })

  it('gives the place of each quad on its anchor, for the draw order (spec §7)', () => {
    const decl = { type: 'sticker', src: 'img', anchor: 'mouth', offset: { bind: 'face.index', map: { '0': [0, 0, 0.1], '1': [0, 0, -0.2] } } }
    const layer = createSticker(decl as unknown as LayerDecl, context({ img: asset('image', 10, 10) }))
    layer.update(frameAt(0, fakeAnchors([4, 9])))
    expect(layer.placements!.map((p) => [p.object, p.anchor, p.face, p.z])).toEqual(meshes(layer).map((m, i) => [m, 'mouth', [4, 9][i], [0.1, -0.2][i]]))
    const screen = createSticker({ type: 'sticker', src: 'img', anchor: 'screen', offset: [0, 0, 0.3] } as LayerDecl, context({ img: asset('image', 10, 10) }))
    screen.update(frameAt(0, fakeAnchors([4])))
    expect(screen.placements!.map((p) => [p.anchor, p.face, p.z])).toEqual([['screen', 0, 0.3]])
    for (const l of [layer, screen]) l.dispose()
  })

  it('scale multiplies the size, uniformly or per axis, bindable; a factor ≤ 0 hides the quad', () => {
    const ctx = context({ wide: asset('image', 200, 100) })
    const uniform = createSticker({ type: 'sticker', src: 'wide', size: 0.5, scale: 2 } as LayerDecl, ctx)
    uniform.update(frameAt(0, fakeAnchors([4])))
    expect(scaleOf(meshes(uniform)[0]!.matrix)).toEqual([12, 6, 12]) // twice the [6, 3, 6] of size 0.5
    const stretched = createSticker({ type: 'sticker', src: 'wide', size: 0.5, scale: [1, 1.4, 1] } as LayerDecl, ctx)
    stretched.update(frameAt(0, fakeAnchors([4])))
    expect(scaleOf(meshes(stretched)[0]!.matrix)).toEqual([6, 4.2, 6])
    const bound = createSticker({ type: 'sticker', src: 'wide', size: 0.5, scale: { bind: 'face.index', range: [0, 1], to: [0, 1] } } as LayerDecl, ctx)
    bound.update(frameAt(0, fakeAnchors([4, 9])))
    expect(meshes(bound).map((m) => m.visible)).toEqual([false, true]) // face 0: scale 0
    expect(scaleOf(meshes(bound)[1]!.matrix)).toEqual([6, 3, 6])
    for (const l of [uniform, stretched, bound]) l.dispose()
  })

  it('orient "screen" keeps the quad facing the screen; rotation is in degrees', () => {
    const layer = createSticker(
      { type: 'sticker', src: 'img', orient: 'screen', rotation: [0, 0, 90], offset: [1, 0, 0] } as LayerDecl,
      context({ img: asset('image', 100, 100) }, 1),
    )
    const anchors = fakeAnchors([1])
    // A head turned 90° around y: the offset follows the head, the quad does not.
    anchors.face = (face, _a, _f, out) => (out.makeRotationY(Math.PI / 2).scale(new Vector3(6, 6, 6)).setPosition(0, 0, -50), face === 0)
    layer.update(frameAt(0, anchors))
    const m = meshes(layer)[0]!.matrix
    expect(positionOf(m)).toEqual([0, 0, -56])
    const x = new Vector3(1, 0, 0).transformDirection(m).toArray().map((v) => Math.round(v * 1000) / 1000)
    expect(x).toEqual([0, 1, 0]) // rolled 90° in the screen plane
    layer.dispose()
  })

  it('"screen" anchor: one quad in the screen frame; overlay stage', () => {
    const layer = createSticker(
      { type: 'sticker', src: 'img', anchor: 'screen', size: 0.25, overlay: true, excludeFromCapture: true } as LayerDecl,
      context({ img: asset('image', 64, 128) }, 3),
    )
    expect([layer.stage, layer.excludeFromCapture, meshes(layer).length]).toEqual(['overlay', true, 1])
    layer.update(frameAt(0, fakeAnchors([])))
    const m = meshes(layer)[0]!
    expect(m.visible).toBe(true)
    expect(positionOf(m.matrix)).toEqual([0, 0, -10])
    expect(scaleOf(m.matrix)).toEqual([1.5, 3, 12])
    layer.dispose()
  })

  it('visible and opacity are bindable per face; opacity 0 hides the quad', () => {
    const layer = createSticker(
      { type: 'sticker', src: 'img', opacity: { bind: 'face.index', range: [0, 1], to: [0, 0.5] } } as LayerDecl,
      context({ img: asset('image', 10, 10) }),
    )
    layer.update(frameAt(0, fakeAnchors([1, 2])))
    const [a, b] = meshes(layer)
    expect([a!.visible, b!.visible]).toEqual([false, true])
    expect(b!.material.params.x).toBe(0.5)

    const hidden = createSticker({ type: 'sticker', src: 'img', visible: false } as LayerDecl, context({ img: asset('image', 10, 10) }))
    hidden.update(frameAt(0, fakeAnchors([1])))
    expect(meshes(hidden)[0]!.visible).toBe(false)
    layer.dispose()
    hidden.dispose()
  })

  it('faces "largest" and "first" select one face', () => {
    const anchors = fakeAnchors([8, 2])
    // Slot 1 is nearer, hence larger.
    anchors.face = (face, _a, _f, out) => (out.makeScale(6, 6, 6).setPosition(0, 0, face === 1 ? -30 : -60), face < 2)
    const ctx = context({ img: asset('image', 10, 10) }, 2)
    const largest = createSticker({ type: 'sticker', src: 'img', faces: 'largest' } as LayerDecl, ctx)
    const first = createSticker({ type: 'sticker', src: 'img', faces: 'first' } as LayerDecl, ctx)
    largest.update(frameAt(0, anchors))
    first.update(frameAt(0, anchors))
    expect(meshes(largest).length).toBe(1)
    expect(positionOf(meshes(largest)[0]!.matrix)[2]).toBe(-30)
    expect(positionOf(meshes(first)[0]!.matrix)[2]).toBe(-30) // id 2 is the oldest face
    largest.dispose()
    first.dispose()
  })

  it('{ pick } shows one asset per face id, and re-picks when the id changes', () => {
    const assets = { a: asset('image', 10, 10), b: asset('image', 20, 10), c: asset('image', 30, 10) }
    const layer = createSticker({ type: 'sticker', src: { pick: ['a', 'b', 'c'] } } as LayerDecl, context(assets))
    const ids = [1, 2]
    const anchors = fakeAnchors(ids)
    layer.update(frameAt(0, anchors))
    expect(meshes(layer).map((m) => m.material.asset)).toEqual([assets.a, assets.b])
    ids[0] = 3 // the first person left, a new one came in
    layer.update(frameAt(0.033, anchors))
    expect(meshes(layer).map((m) => m.material.asset)).toEqual([assets.c, assets.b])
    layer.dispose()
  })

  it('{ pick, by: "random" } draws once per face, kept while the face keeps its id', () => {
    const assets = { a: asset('image', 10, 10), b: asset('image', 10, 10), c: asset('image', 10, 10) }
    const draws = [0.5, 0.9, 0.1]
    let calls = 0
    const random = () => draws[calls++ % draws.length]!
    const layer = createSticker({ type: 'sticker', src: { pick: ['a', 'b', 'c'], by: 'random' } } as LayerDecl, context(assets), { random })
    const ids = [1, 2]
    const anchors = fakeAnchors(ids)
    layer.update(frameAt(0, anchors))
    expect(meshes(layer).map((m) => m.material.asset)).toEqual([assets.b, assets.c])
    layer.update(frameAt(0.033, anchors))
    expect(calls).toBe(2) // no new draw while the faces stay
    ids[1] = 3 // a new face in slot 1: a new draw for it only
    layer.update(frameAt(0.066, anchors))
    expect(meshes(layer).map((m) => m.material.asset)).toEqual([assets.b, assets.a])
    expect(calls).toBe(3)
    layer.dispose()

    // A screen sticker picks for its first selected face: one draw while no face is tracked, one more when one comes.
    calls = 0
    const screen = createSticker({ type: 'sticker', anchor: 'screen', src: { pick: ['a', 'b', 'c'], by: 'random' } } as LayerDecl, context(assets), { random })
    const none = fakeAnchors([])
    screen.update(frameAt(0, none))
    screen.update(frameAt(0.033, none))
    expect([meshes(screen)[0]!.material.asset, calls]).toEqual([assets.b, 1])
    screen.update(frameAt(0.066, fakeAnchors([4])))
    expect([meshes(screen)[0]!.material.asset, calls]).toEqual([assets.c, 2])
    screen.dispose()
  })

  it('plays a spritesheet with the frame time, at `rate`, looping or not', () => {
    const sheet = asset('spritesheet', 400, 200, { width: 100, height: 100, frames: { cols: 4, rows: 2, count: 6, fps: 10 } })
    const rect = (layer: ObjectLayer) => meshes(layer)[0]!.material.uniforms.uRect!.value as Vector4
    const anchors = fakeAnchors([1])
    const run = (decl: Record<string, unknown>, times: number[]) => {
      const layer = createSticker({ type: 'sticker', src: 'walk', ...decl } as LayerDecl, context({ walk: sheet }, 1))
      const frames: number[] = []
      for (const t of times) {
        layer.update(frameAt(t, anchors))
        const r = rect(layer)
        frames.push(Math.round(r.y / r.w) * 4 + Math.round(r.x / r.z))
      }
      layer.dispose()
      return frames
    }
    // Activated at media time 5 s: the clock starts at 0 there.
    expect(run({}, [5, 5.1, 5.2, 5.45, 5.55, 5.65])).toEqual([0, 1, 2, 4, 5, 0])
    expect(run({ loop: false }, [5, 5.3, 5.6, 6.5])).toEqual([0, 3, 5, 5])
    expect(run({ rate: 2 }, [0, 0.1, 0.2])).toEqual([0, 2, 4])
    expect(run({ autoplay: false }, [0, 0.5, 1])).toEqual([0, 0, 0])
    // The source loops back to 0: no time passes.
    expect(run({}, [2, 2.1, 0, 0.1])).toEqual([0, 1, 1, 2])
    expect(sheet.width / sheet.height).toBe(1)
  })

  it('keeps playing while hidden by `visible` or `opacity`, and resumes where it is (CSS `visibility`)', () => {
    const sheet = asset('spritesheet', 400, 400, { width: 100, height: 100, frames: { cols: 4, rows: 4, count: 16, fps: 10 } })
    const frameOf = (layer: ObjectLayer) => {
      const r = meshes(layer)[0]!.material.uniforms.uRect!.value as Vector4
      return Math.round(r.y / r.w) * 4 + Math.round(r.x / r.z)
    }
    for (const decl of [
      { visible: { bind: 'test.shown' } },
      { opacity: { bind: 'test.shown', map: { true: 1, false: 0 } } },
      { anchor: 'screen', visible: { bind: 'test.shown' } },
    ]) {
      const layer = createSticker({ type: 'sticker', src: 'walk', ...decl } as LayerDecl, context({ walk: sheet }, 1))
      const anchors = fakeAnchors([1])
      shownData = true
      for (let i = 0; i <= 3; i++) layer.update(frameAt(i / 10, anchors))
      expect(frameOf(layer)).toBe(3)
      // Hidden for 1 s at 10 fps, the face staying tracked.
      shownData = false
      for (let i = 4; i < 14; i++) {
        layer.update(frameAt(i / 10, anchors))
        expect(meshes(layer)[0]!.visible).toBe(false)
      }
      shownData = true
      layer.update(frameAt(1.4, anchors))
      expect([meshes(layer)[0]!.visible, frameOf(layer)]).toEqual([true, 14]) // frame +10, not frame 0
      layer.dispose()
    }
    shownData = true
  })

  /** A video element as far as `VideoPlayback` uses it. */
  const fakeVideo = () => ({
    loop: false,
    duration: 10,
    currentTime: 0,
    paused: true,
    seeking: false,
    playbackRate: 1,
    plays: 0,
    play() {
      this.paused = false
      this.plays++
      return Promise.resolve()
    },
    pause() {
      this.paused = true
    },
  })

  it('pauses its videos while the filter is not drawn, and plays them again at the clock', () => {
    const video = fakeVideo()
    const clip = asset('video', 100, 100, { video: video as unknown as HTMLVideoElement })
    const layer = createSticker({ type: 'sticker', src: 'clip' } as LayerDecl, context({ clip }, 1))
    const anchors = fakeAnchors([1])
    layer.update(frameAt(0, anchors))
    expect([video.paused, video.plays]).toEqual([false, 1])
    layer.suspend!() // disabled: no update until it is enabled again
    expect(video.paused).toBe(true)
    layer.update(frameAt(5, anchors))
    expect([video.paused, video.plays]).toEqual([false, 2])
    layer.dispose()
  })

  it('re-synchronizes a video paused while hidden by `visible` to the running clock', () => {
    const video = fakeVideo()
    const clip = asset('video', 100, 100, { video: video as unknown as HTMLVideoElement })
    const layer = createSticker({ type: 'sticker', src: 'clip', visible: { bind: 'test.shown' } } as LayerDecl, context({ clip }, 1))
    const anchors = fakeAnchors([1])
    shownData = true
    layer.update(frameAt(0, anchors))
    expect([video.paused, video.plays]).toEqual([false, 1])
    shownData = false
    for (let i = 1; i <= 20; i++) layer.update(frameAt(i / 10, anchors)) // hidden 2 s: paused after VIDEO_IDLE_PAUSE_MS
    expect(video.paused).toBe(true)
    video.currentTime = 1.1 // where it was paused
    shownData = true
    layer.update(frameAt(2.1, anchors))
    expect([video.paused, video.plays]).toEqual([false, 2])
    expect(video.currentTime).toBeCloseTo(2.1) // the clock kept running: seeked to it, not to 0
    layer.dispose()
  })

  it('restarts playback at activation and when the first face appears after none was, not when another face joins', () => {
    const sheet = asset('spritesheet', 400, 200, { width: 100, height: 100, frames: { cols: 4, rows: 2, count: 8, fps: 10 } })
    const layer = createSticker({ type: 'sticker', src: 'walk' } as LayerDecl, context({ walk: sheet }, 2))
    const frameOf = (i: number) => {
      const r = meshes(layer)[i]!.material.uniforms.uRect!.value as Vector4
      return Math.round(r.y / r.w) * 4 + Math.round(r.x / r.z)
    }
    const ids = [1, 2]
    const anchors = fakeAnchors(ids)
    anchors.count = 0
    layer.update(frameAt(0, anchors)) // activated with no face: nothing shown
    layer.update(frameAt(0.5, anchors))
    anchors.count = 1
    layer.update(frameAt(1, anchors))
    expect(frameOf(0)).toBe(0) // the first face appears: from the first frame
    layer.update(frameAt(1.2, anchors))
    expect(frameOf(0)).toBe(2)
    anchors.count = 2
    layer.update(frameAt(1.3, anchors))
    expect([frameOf(0), frameOf(1)]).toEqual([3, 3]) // the second face joins the running animation
    anchors.count = 0
    layer.update(frameAt(1.4, anchors))
    anchors.count = 1
    layer.update(frameAt(1.5, anchors))
    expect(frameOf(0)).toBe(0) // every face left, then one came back: restarted
    layer.dispose()
  })

  it('refuses an asset that is not an image, spritesheet or video', () => {
    const ctx = context({})
    ctx.assets.get = <T>() => 'vec4 effect(vec2 uv) { return vec4(1.0); }' as T
    expect(() => createSticker({ type: 'sticker', src: 'fx' } as LayerDecl, ctx)).toThrow(/not an image, spritesheet or video/)
  })
})

describe('sticker layer: src bound to a param or set by a script (spec §8, §12.4, #140)', () => {
  const params: TParams = {
    style: { type: 'select', default: 'a', options: { a: 'A', b: 'B', c: 'C' } },
    logo: { type: 'asset', accept: ['image/png'], optional: true },
  }
  /** A context with real params, host files from `host`, and the script registry `overrides`. */
  function bound(assets: Record<string, StickerAsset>, host: Record<string, StickerAsset | null> = {}, overrides?: ScriptOverrides) {
    const store = new ParamStore(params)
    const ctx: LayerContext = {
      ...context(assets),
      params: store,
      hostAssets: { get: (name) => host[name] ?? null },
      bindings: { data, params: bindingParams(store), ...(overrides ? { overrides: overrides.forLayer(0) } : {}) },
    }
    return { ctx, store }
  }
  const shown = (layer: ObjectLayer) => meshes(layer).filter((m) => m.visible).map((m) => m.material.asset)

  it('shows the asset a select param maps its value to, from the next frame; an unmapped value hides it', () => {
    const assets = { red: asset('image', 10, 10), green: asset('image', 10, 10) }
    const { ctx, store } = bound(assets)
    const layer = createSticker({ type: 'sticker', src: { param: 'style', map: { a: 'red', b: 'green' } }, anchor: 'screen' } as LayerDecl, ctx)
    const anchors = fakeAnchors([])
    layer.update(frameAt(0, anchors))
    expect(shown(layer)).toEqual([assets.red])
    store.set('style', 'b')
    layer.update(frameAt(0.033, anchors))
    expect(shown(layer)).toEqual([assets.red]) // applied at the start of the next frame
    store.beginFrame(66)
    layer.update(frameAt(0.066, anchors))
    expect(shown(layer)).toEqual([assets.green])
    store.set('style', 'c')
    store.beginFrame(100)
    layer.update(frameAt(0.1, anchors))
    expect(shown(layer)).toEqual([])
    layer.dispose()
  })

  it('shows the host\'s file of an asset param, and nothing without one', () => {
    const host: Record<string, StickerAsset | null> = { logo: null }
    const { ctx } = bound({}, host)
    const layer = createSticker({ type: 'sticker', src: { param: 'logo' } } as LayerDecl, ctx)
    const anchors = fakeAnchors([1, 2])
    layer.update(frameAt(0, anchors))
    expect(shown(layer)).toEqual([])
    host.logo = asset('image', 30, 10)
    layer.update(frameAt(0.033, anchors))
    expect(shown(layer)).toEqual([host.logo, host.logo])
    // Its aspect ratio: 3:1.
    expect(scaleOf(meshes(layer)[0]!.matrix)).toEqual([18, 6, 6])
    layer.dispose()
  })

  it('takes the script\'s asset name per face or for every instance; null restores the manifest\'s pick', () => {
    const overrides = new ScriptOverrides()
    const ids = [1, 2]
    overrides.idOf = (slot) => (slot < 0 ? 0 : ids[slot] ?? 0)
    const assets = { a: asset('image', 10, 10), b: asset('image', 10, 10), c: asset('image', 10, 10), fx: 'shader' as unknown as StickerAsset }
    const { ctx } = bound(assets, {}, overrides)
    const layer = createSticker({ type: 'sticker', src: { pick: ['a', 'b'] } } as LayerDecl, ctx)
    const anchors = fakeAnchors(ids)
    layer.update(frameAt(0, anchors))
    expect(shown(layer)).toEqual([assets.a, assets.b])
    const src = overrides.property(0, 'src')!
    expect(src.problem('c')).toBeUndefined()
    expect(src.problem('fx')).toBe('no asset named "fx" is declared in "assets" as an image, spritesheet or video')
    expect(src.problem('assets/c.png')).toMatch(/no asset named/)
    src.set(2, 'c')
    layer.update(frameAt(0.033, anchors))
    expect(shown(layer)).toEqual([assets.a, assets.c])
    src.set(undefined, 'c')
    layer.update(frameAt(0.066, anchors))
    expect(shown(layer)).toEqual([assets.c, assets.c])
    src.set(undefined, null)
    layer.update(frameAt(0.1, anchors))
    expect(shown(layer)).toEqual([assets.a, assets.b])
    layer.dispose()
  })
})

describe('sticker layer: allocation', () => {
  it('allocates nothing per frame', () => {
    const sheet = asset('spritesheet', 400, 200, { width: 100, height: 100, frames: { cols: 4, rows: 2, count: 8, fps: 12 } })
    const ctx = context({ walk: sheet, a: asset('image', 10, 20), b: asset('image', 20, 10) }, 4)
    const layers = [
      createSticker({ type: 'sticker', src: 'walk', offset: [0, 1, 0], rotation: [0, 0, 15], opacity: { bind: 'face.index', range: [0, 3], to: [1, 0.5] } } as LayerDecl, ctx),
      createSticker({ type: 'sticker', src: { pick: ['a', 'b'] }, orient: 'screen', faces: 'largest' } as LayerDecl, ctx),
      createSticker({ type: 'sticker', src: 'a', anchor: 'screen', faces: 2, scale: [1, 2, 1] } as LayerDecl, ctx),
      createSticker({ type: 'sticker', src: 'b', scale: { bind: 'face.index', range: [0, 3], to: [1, 2] } } as LayerDecl, ctx),
    ]
    const ids = [1, 2, 3, 4]
    const anchors = fakeAnchors(ids)
    const frame = frameAt(0, anchors) as { -readonly [K in keyof FrameContext]: FrameContext[K] }
    const state = new Float64Array(2) // time, frame
    const render = () => {
      state[0]! += 0.033
      frame.time = state[0]!
      frame.now = state[0]! * 1000
      anchors.count = 1 + (state[1]!++ % 4)
      for (let l = 0; l < layers.length; l++) layers[l]!.update(frame)
    }
    expect(bytesPerCall(render, { warmup: 20_000 })).toBeLessThan(1)
    for (const l of layers) l.dispose()
  })
})
