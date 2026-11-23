import { Matrix4, Vector3, type BufferGeometry, type Mesh } from 'three'
import { describe, expect, it } from 'vitest'
import type { AnchorProvider } from '../src/engine/anchor-provider.ts'
import type { FrameContext, LayerContext, LayerDecl } from '../src/engine/layer-type.ts'
import type { FaceFrame } from '../src/face.ts'
import { createCanvasLayer } from '../src/layers/canvas/layer.ts'
import { scriptFontRefs, scriptFonts } from '../src/layers/canvas/script-fonts.ts'
import { scriptImageRefs } from '../src/layers/canvas/script-images.ts'
import type { StickerMaterial } from '../src/layers/sticker/material.ts'

/** Face slot i sits at x = 10·i cm, 50 cm away, with a face unit of 6 cm. */
function fakeAnchors(count: number): AnchorProvider {
  return {
    face(face, _anchor, _follow, out) {
      if (face < 0 || face >= count) return false
      out.makeScale(6, 6, 6).setPosition(10 * face, 0, -50)
      return true
    },
    screen: (out) => void out.makeScale(12, 12, 12).setPosition(0, 0, -10),
    id: (face) => face + 1,
  }
}

function context(warnings: string[] = []): LayerContext {
  return {
    filterId: 'test',
    renderer: {} as LayerContext['renderer'],
    view: {} as LayerContext['view'],
    assets: { get: () => undefined as never, has: () => false },
    params: {} as LayerContext['params'],
    bindings: { data: { resolve: () => undefined }, params: { type: () => undefined, get: () => undefined } },
    maxFaces: 2,
    random: Math.random,
    warn: (m) => void warnings.push(m),
  }
}

const frame = (faces: number): FrameContext => ({
  time: 0,
  now: 0,
  dt: 33,
  faces: { count: faces } as FaceFrame,
  anchors: fakeAnchors(faces),
  width: 720,
  height: 1280,
  mirrored: false,
})

/** Premultiplied RGBA pixels of a `width` × `height` image. */
const image = (width: number, height: number) => new Uint8ClampedArray(width * height * 4)

const meshes = (o: { children: unknown[] }) => o.children as Array<Mesh<BufferGeometry, StickerMaterial>>
const scaleOf = (m: Matrix4) => new Vector3().setFromMatrixScale(m).toArray().map((v) => Math.round(v * 1000) / 1000)

describe('canvas layer', () => {
  it('shows nothing before the first image, then the image on every selected face, sized like a sticker', () => {
    const layer = createCanvasLayer({ type: 'canvas', id: 'bubble', width: 200, height: 100, size: 0.5 } as LayerDecl, context())
    expect(layer.stage).toBe('objects')
    layer.update(frame(2))
    expect(layer.object.visible).toBe(false)

    const first = image(200, 100)
    layer.setImage(first)
    layer.update(frame(2))
    expect(layer.object.visible).toBe(true)
    const [a, b] = meshes(layer.object)
    expect([a!.visible, b!.visible]).toEqual([true, true])
    expect(scaleOf(a!.matrix)).toEqual([6, 3, 6]) // 0.5 units high, twice as wide (200 × 100 px)
    const texture = a!.material.asset!.texture
    // Uploaded as they are: premultiplied, top row first, no copy.
    expect(texture.image).toMatchObject({ width: 200, height: 100 })
    expect((texture.image as { data: Uint8Array }).data.buffer).toBe(first.buffer)
    expect(b!.material.asset!.texture).toBe(texture) // one image for every face
    expect([texture.flipY, texture.premultiplyAlpha, texture.generateMipmaps]).toEqual([false, false, false])

    // A new image replaces the previous one.
    const second = image(200, 100)
    const version = texture.version
    layer.setImage(second)
    expect((texture.image as { data: Uint8Array }).data.buffer).toBe(second.buffer)
    expect(texture.version).toBe(version + 1)
    expect(layer.draws).toBe(2)
    layer.dispose()
  })

  it('scale multiplies the size, as on a sticker', () => {
    const layer = createCanvasLayer({ type: 'canvas', id: 'bubble', width: 200, height: 100, size: 0.5, scale: [2, 1, 1] } as LayerDecl, context())
    layer.setImage(image(200, 100))
    layer.update(frame(1))
    expect(scaleOf(meshes(layer.object)[0]!.matrix)).toEqual([12, 3, 6])
    layer.dispose()
  })

  it('refuses an image of another size than declared', () => {
    const warnings: string[] = []
    const layer = createCanvasLayer({ type: 'canvas', id: 'c', width: 64, height: 64 } as LayerDecl, context(warnings))
    layer.setImage(image(4096, 4096))
    expect(layer.draws).toBe(0)
    expect(warnings).toEqual(['layer "c": a canvas image of 67108864 bytes instead of 64×64 px was ignored.'])
  })

  it('goes to the overlay stage with overlay: true, and can be left out of captures', () => {
    const layer = createCanvasLayer({ type: 'canvas', id: 'ui', width: 16, height: 16, anchor: 'screen', overlay: true, excludeFromCapture: true } as LayerDecl, context())
    expect(layer.stage).toBe('overlay')
    expect(layer.excludeFromCapture).toBe(true)
    layer.setImage(image(16, 16))
    layer.update(frame(0))
    expect(meshes(layer.object).map((m) => m.visible)).toEqual([true])
  })
})

describe('script image assets', () => {
  const assets = {
    star: { svg: '<svg/>' },
    smile: { emoji: '😀' },
    walk: { src: 'assets/walk.png', frames: { cols: 2, rows: 1, fps: 4 } },
    flame: { src: 'assets/flame.mp4' },
    hat: 'assets/hat.glb',
    photo: 'assets/photo.webp',
  }

  it('lists the image, spritesheet, SVG and emoji assets, only for a script that draws a canvas', () => {
    expect(scriptImageRefs({ assets, script: { entry: 'script.js', draw: ['c'] } })).toEqual(['star', 'smile', 'walk', 'photo'])
    expect(scriptImageRefs({ assets, script: { entry: 'script.js', draw: ['c'] } }, (kind) => kind !== 'emoji')).toEqual(['star', 'walk', 'photo'])
    expect(scriptImageRefs({ assets, script: { entry: 'script.js' } })).toEqual([])
    expect(scriptImageRefs({ assets })).toEqual([])
  })
})

describe('script fonts', () => {
  const assets = {
    title: 'builtin:font/rounded-bold',
    body: 'assets/body.woff2',
    hand: { src: 'assets/hand.otf' },
    star: { svg: '<svg/>' },
    grade: 'builtin:lut/noir',
  }

  it('lists the font assets, built-in ones included, only for a script that draws a canvas', () => {
    expect(scriptFontRefs({ assets, script: { entry: 'script.js', draw: ['c'] } })).toEqual(['title', 'body', 'hand'])
    expect(scriptFontRefs({ assets, script: { entry: 'script.js', draw: ['c'] } }, (kind) => kind !== 'font')).toEqual([])
    expect(scriptFontRefs({ assets, script: { entry: 'script.js' } })).toEqual([])
    expect(scriptFontRefs({ assets })).toEqual([])
  })

  it('gives the loaded bytes and face descriptors by asset name', () => {
    const data = new ArrayBuffer(4)
    const loaded: Record<string, unknown> = { title: { family: 'Ouaf Rounded', weight: '700', style: 'normal', data }, body: { family: 'x' } }
    const preloaded = { get: <T>(ref: string) => loaded[ref] as T, has: (ref: string) => ref in loaded }
    expect(scriptFonts(preloaded, ['title', 'body', 'missing'])).toEqual([{ name: 'title', data, weight: '700', style: 'normal' }])
  })
})
