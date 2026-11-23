/**
 * The `canvas` layer type (spec §6.3, §12.6): Canvas 2D drawing by the filter's script, shown on a quad attached to
 * an anchor.
 *
 * The script draws in its sandbox Worker, on an `OffscreenCanvas` of `width` × `height` px (`draw.<id>(ctx, f,
 * frame)`, see `script/runtime.ts`); each new image reaches the layer as an `ImageBitmap` (`setImage`), which it
 * uploads to the GPU at the next render. A layer has **one** image, shown on every selected face (and once for
 * `anchor: "screen"`): `draw` receives the whole frame, not a face.
 *
 * Placement is the sticker's (`createSticker`): one quad per selected face, `size` is the height in anchor units and
 * the width follows `width / height`, `scale` multiplies it; `visible`, `opacity`, `size`, `scale`, `offset`,
 * `rotation` are bindable and settable by the script. Nothing is shown until the script has drawn once.
 *
 * Images arrive premultiplied, like decoded image assets: `ImageBitmap` uploads ignore `UNPACK_PREMULTIPLY_ALPHA` and
 * `UNPACK_FLIP_Y` (WebGL), and the sticker material samples v = 0 as the top row.
 */
import type { TCanvasLayer } from '@ouaf/spec'
import { ClampToEdgeWrapping, LinearFilter, NoColorSpace, Texture } from 'three'
import type { LayerContext, LayerDecl, LayerTypeImpl, ObjectLayer } from '../../engine/layer-type.ts'
import { createStickerAsset } from '../sticker/assets.ts'
import { createSticker } from '../sticker/layer.ts'

/** A canvas layer instance: an object layer that takes the images the script draws. */
export interface CanvasLayerInstance extends ObjectLayer {
  /** Shows `image` from the next render on; the layer owns it from then on and closes it once replaced. */
  setImage(image: ImageBitmap): void
  /** Number of images received (tests, stats). */
  readonly draws: number
}

export function createCanvasLayer(decl: LayerDecl, ctx: LayerContext): CanvasLayerInstance {
  const d = decl as unknown as TCanvasLayer
  const texture = new Texture()
  texture.colorSpace = NoColorSpace
  texture.flipY = false
  texture.premultiplyAlpha = false
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearFilter
  // No mipmaps: they would be rebuilt at every draw, and canvases are drawn near their own size.
  texture.generateMipmaps = false
  const asset = createStickerAsset({
    kind: 'image',
    texture,
    textureWidth: d.width,
    textureHeight: d.height,
    width: d.width,
    height: d.height,
    frames: undefined,
    packed: false,
    video: undefined,
    owner: undefined,
  })
  const sticker = createSticker(decl, ctx, { assets: [asset] })
  const root = sticker.object
  root.name = decl.id ?? 'canvas'
  let image: ImageBitmap | undefined
  let draws = 0
  root.visible = false

  return {
    kind: 'object',
    stage: sticker.stage,
    object: root,
    ...(sticker.excludeFromCapture ? { excludeFromCapture: true } : {}),
    ...(sticker.placements ? { placements: sticker.placements } : {}),
    get draws() {
      return draws
    },
    setImage(next) {
      if (next.width !== d.width || next.height !== d.height) {
        // The runtime keeps the declared size; anything else is refused (GPU memory is sized by the manifest).
        ctx.warn(`layer "${decl.id}": a canvas image of ${next.width}×${next.height} px instead of ${d.width}×${d.height} was ignored.`)
        next.close()
        return
      }
      // The previous image was uploaded at a render since it arrived, or it was never shown: either way it is done.
      image?.close()
      image = next
      draws++
      texture.image = next
      texture.needsUpdate = true
      root.visible = true
    },
    update(frame) {
      sticker.update(frame)
    },
    dispose() {
      sticker.dispose()
      texture.dispose()
      image?.close()
      image = undefined
    },
  }
}

export const canvasLayerType: LayerTypeImpl = {
  type: 'canvas',
  create: (decl, ctx) => createCanvasLayer(decl, ctx),
}
