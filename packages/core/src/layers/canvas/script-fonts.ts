/**
 * The fonts a script draws its canvas layers with (spec §12.6).
 *
 * Every `font` asset declared in the manifest's `assets` table (a font file of the package, or a built-in font under a
 * name of the filter: `"title": "builtin:font/rounded-bold"`) is given to a script that draws canvas layers, by its
 * asset name. The runtime registers them in its Worker's font set under that name before `setup`, from the bytes the
 * font loader already read (no network, the sandbox CSP stays closed): `ctx.font = '24px title'`.
 */
import type { TManifest } from '@ouaf/spec'
import { resolveAssetRef, type LoadedAssets } from '../../engine/assets.ts'
import type { WireFont } from '../../script/runtime.ts'
import type { LoadedFont } from '../text/font-loader.ts'

/**
 * Names of the font assets of `manifest` given to its script: none unless the script draws a canvas layer.
 * `canLoad`: whether a loader for the asset kind is installed (the font loader comes with the text plugin).
 */
export function scriptFontRefs(manifest: Pick<TManifest, 'assets' | 'script'>, canLoad: (kind: string) => boolean = () => true): string[] {
  if (!manifest.script?.draw?.length || !manifest.assets || !canLoad('font')) return []
  const out: string[] = []
  for (const name of Object.keys(manifest.assets)) {
    let kind: string
    try {
      kind = resolveAssetRef(name, manifest.assets).kind
    } catch {
      continue // reported when a layer uses it; a script cannot use it either way
    }
    if (kind === 'font') out.push(name)
  }
  return out
}

/** The preloaded fonts `refs`, by asset name, for the script's Worker. */
export function scriptFonts(assets: LoadedAssets, refs: readonly string[]): WireFont[] {
  const out: WireFont[] = []
  for (const ref of refs) {
    if (!assets.has(ref)) continue
    const font = assets.get<Partial<LoadedFont>>(ref)
    if (!(font?.data instanceof ArrayBuffer)) continue
    out.push({ name: ref, data: font.data, weight: font.weight ?? 'normal', style: font.style ?? 'normal' })
  }
  return out
}
