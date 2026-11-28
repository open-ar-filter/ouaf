/**
 * Rebuilds the synthetic KTX2 textures of the `sticker-ktx2` fixture (#177): flat shapes drawn from code, no image
 * of anyone. CC0, like the fixtures. All in sRGB (the transfer function of the file's data format descriptor).
 *
 * - `ring-rgba8.ktx2`: uncompressed R8G8B8A8_SRGB, straight alpha, 64×64: a magenta disc, opaque for r < 0.3
 *   (relative to the side), alpha 0.5 up to 0.42, transparent outside, where the color is green (it must not show).
 *   Written by `packages/core/test/ktx2-helpers.ts`.
 * - `ring-etc1s.ktx2`: the same ring in Basis Universal ETC1S, 128×128 with mipmaps.
 * - `blue.ktx2`: UASTC with Zstandard supercompression, no mipmaps, 64×64 of (48, 96, 192), opaque.
 * - `walk.ktx2`: UASTC spritesheet, 2 × 1 frames of 64 px, red then green, opaque.
 *
 * The Basis Universal encoder is not a dependency of the project; install it anywhere and point `ENCODERS` at that
 * folder (without it, only the RGBA8 texture is written):
 *
 *   npm i --prefix /tmp/ouaf-encoders ktx2-encoder@0.6.0
 *   ENCODERS=/tmp/ouaf-encoders node filters/fixtures/make-ktx2-assets.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rgba, writeKtx2 } from '../../packages/core/test/ktx2-helpers.ts'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, 'sticker-ktx2/assets')
mkdirSync(out, { recursive: true })

const save = (name: string, bytes: Uint8Array) => {
  writeFileSync(resolve(out, name), bytes)
  console.log(`${name}: ${bytes.byteLength} bytes`)
}

const ring = (side: number) => rgba(side, side, (x, y) => {
  const r = Math.hypot(x + 0.5 - side / 2, y + 0.5 - side / 2) / side
  if (r < 0.3) return [255, 0, 255, 255]
  if (r < 0.42) return [255, 0, 255, 128]
  return [0, 255, 0, 0]
})
save('ring-rgba8.ktx2', writeKtx2({ width: 64, height: 64, levels: [ring(64)] }))

const encoders = process.env.ENCODERS
if (!encoders) {
  console.log('ENCODERS is not set: the Basis Universal textures were not rebuilt (see the header).')
} else {
  type Encode = (image: Uint8Array, options: Record<string, unknown>) => Promise<Uint8Array>
  const { encodeToKTX2 } = (await import(pathToFileURL(resolve(encoders, 'node_modules/ktx2-encoder/dist/node/index.js')).href)) as { encodeToKTX2: Encode }
  const basis = async (name: string, width: number, height: number, data: Uint8Array, options: Record<string, unknown>) => {
    // The raw RGBA goes through the encoder's image decoder hook, which only has to hand it back.
    save(name, await encodeToKTX2(new Uint8Array(0), {
      isKTX2File: true,
      isPerceptual: true,
      isSetKTX2SRGBTransferFunc: true,
      imageDecoder: () => Promise.resolve({ width, height, data }),
      ...options,
    }))
  }
  await basis('ring-etc1s.ktx2', 128, 128, ring(128), { isUASTC: false, generateMipmap: true, qualityLevel: 255 })
  await basis('blue.ktx2', 64, 64, rgba(64, 64, () => [48, 96, 192, 255]), { isUASTC: true, needSupercompression: true, generateMipmap: false })
  await basis('walk.ktx2', 128, 64, rgba(128, 64, (x) => (x < 64 ? [255, 0, 0, 255] : [0, 255, 0, 255])), { isUASTC: true, generateMipmap: false })
}
