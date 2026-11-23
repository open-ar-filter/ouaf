/**
 * Loader of `font` assets (spec §10.2: WOFF2, WOFF, TTF, OTF), registered by the text plugin. A font is registered
 * with the CSS Font Loading API in the page's (or worker's) font set, from the bytes of the package file or built-in
 * resource: nothing is fetched by CSS, and the face is ready before the filter is activated (spec §10.4).
 *
 * Built-in fonts (`builtin:font/…`) keep the family and weight `@ouaf/builtins` gives them (`Ouaf Sans` 400 and 700
 * are two faces of one family); a package font gets a family name of its own, so two filters never mix their fonts.
 */
import { findBuiltin } from '@ouaf/builtins'
import type { AssetLoader } from '../../engine/assets.ts'

/** A loaded font face, as the text layer draws with it (`ctx.font`). */
export interface LoadedFont {
  readonly family: string
  readonly weight: string
  readonly style: string
  /** The registered face, removed from the font set on dispose. */
  readonly face: FontFace
  /** The font file, for the script's canvases (registered in its Worker, spec §12.6). */
  readonly data: ArrayBuffer
}

function fontSet(): FontFaceSet | undefined {
  const g = globalThis as { document?: { fonts?: FontFaceSet }; fonts?: FontFaceSet }
  return g.document?.fonts ?? g.fonts
}

let packageFonts = 0

/** The loaded value of a font asset (`fontLoader`). */
export function isLoadedFont(value: unknown): value is LoadedFont {
  const f = value as Partial<LoadedFont> | null
  return typeof f === 'object' && f !== null && typeof f.family === 'string' && typeof f.weight === 'string' && typeof f.style === 'string' && 'face' in f
}

export const fontLoader: AssetLoader<LoadedFont> = {
  kinds: ['font'],
  async load(request) {
    if (typeof FontFace === 'undefined') throw new Error('this environment has no CSS Font Loading API (FontFace).')
    const fonts = fontSet()
    if (!fonts) throw new Error('this environment has no font set (document.fonts).')
    const builtin = request.builtin ? findBuiltin(request.path) : undefined
    if (request.builtin && (!builtin || builtin.kind !== 'font')) throw new Error(`"${request.ref}" is not a built-in font.`)
    const family = builtin?.kind === 'font' ? builtin.family : `Ouaf Filter Font ${++packageFonts}`
    const weight = builtin?.kind === 'font' ? String(builtin.weight) : 'normal'
    const style = 'normal'
    const bytes = await (await request.read()).arrayBuffer()
    const face = new FontFace(family, bytes, { weight, style })
    await face.load()
    fonts.add(face)
    return { family, weight, style, face, data: bytes }
  },
  dispose(font) {
    fontSet()?.delete(font.face)
  },
}
