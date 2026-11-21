/**
 * Built-in resources of the engine (spec §10.3): fonts and LUTs, referenced by filters as `builtin:<name>`.
 *
 * The files live in this package's `assets/` folder, which the host serves next to the engine (same origin or its
 * own CDN, never a third party: spec §15) under an `assetsBaseUrl`. This module only maps names to URLs: nothing is
 * fetched or bundled until a filter uses a resource, so the engine's bundle does not grow with them.
 */

export const BUILTIN_PREFIX = 'builtin:'

/** A font face: register it with `new FontFace(family, \`url(${url})\`, { weight, style })`. */
export interface BuiltinFont {
  kind: 'font'
  /** Path of the WOFF2 file, relative to the assets folder. */
  path: string
  /** CSS family name to register the face under (unique to Ouaf, so it never matches a system font). */
  family: string
  weight: number
  style: 'normal'
}

/** A 3D LUT in the `.cube` format, applied to gamma-encoded sRGB values. */
export interface BuiltinLut {
  kind: 'lut'
  path: string
  /** Grid size (LUT_3D_SIZE). */
  size: number
}

export type BuiltinAsset = BuiltinFont | BuiltinLut

const font = (file: string, family: string, weight: number): BuiltinFont => ({
  kind: 'font',
  path: `fonts/${file}.woff2`,
  family,
  weight,
  style: 'normal',
})
const lut = (name: string): BuiltinLut => ({ kind: 'lut', path: `luts/${name}.cube`, size: 17 })

/**
 * Every built-in resource, by name (without the `builtin:` prefix). Same names as the spec registry
 * (`BUILTINS` in @ouaf/spec).
 */
export const BUILTIN_ASSETS: Readonly<Record<string, BuiltinAsset>> = {
  'font/sans': font('sans', 'Ouaf Sans', 400),
  'font/sans-bold': font('sans-bold', 'Ouaf Sans', 700),
  'font/rounded-bold': font('rounded-bold', 'Ouaf Rounded', 700),
  'font/serif': font('serif', 'Ouaf Serif', 400),
  'font/mono': font('mono', 'Ouaf Mono', 400),
  'font/handwritten': font('handwritten', 'Ouaf Handwritten', 500),
  'lut/vintage': lut('vintage'),
  'lut/noir': lut('noir'),
  'lut/warm': lut('warm'),
  'lut/cool': lut('cool'),
  'lut/vivid': lut('vivid'),
}

/** Does this asset reference point to a built-in resource? */
export function isBuiltinRef(ref: string): boolean {
  return ref.startsWith(BUILTIN_PREFIX)
}

/** The built-in resource of a `builtin:<name>` reference (or a bare name), or undefined if there is none. */
export function findBuiltin(ref: string): BuiltinAsset | undefined {
  const name = isBuiltinRef(ref) ? ref.slice(BUILTIN_PREFIX.length) : ref
  return Object.hasOwn(BUILTIN_ASSETS, name) ? BUILTIN_ASSETS[name] : undefined
}

/**
 * URL of a built-in resource. `assetsBaseUrl` is where the host serves this package's `assets/` folder (absolute,
 * or relative to `location.href` in a page); a trailing slash is added when missing.
 *
 *   resolveBuiltin('builtin:font/sans', 'https://example.com/ouaf/') → https://example.com/ouaf/fonts/sans.woff2
 */
export function resolveBuiltin(ref: string, assetsBaseUrl: string | URL): URL {
  const asset = findBuiltin(ref)
  if (!asset) throw new Error(`Unknown built-in resource "${ref}"`)
  return new URL(asset.path, baseUrl(assetsBaseUrl))
}

function baseUrl(base: string | URL): URL {
  const s = String(base)
  const abs = URL.canParse(s) ? s : new URL(s, globalThis.location?.href).href
  return new URL(abs.endsWith('/') ? abs : abs + '/')
}
