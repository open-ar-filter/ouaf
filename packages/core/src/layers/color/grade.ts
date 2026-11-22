/**
 * The color layer's properties (spec §6.3) → the uniforms of its shader. Pure and allocation-free, so it is unit
 * tested in Node and called every frame.
 *
 * All the math works on the **sRGB-encoded** values the image buffers hold (docs/decisions/engine-architecture.md),
 * which is also what `.cube` LUTs for video and photos expect (the built-in ones are made for it). Per pixel, in order:
 *
 * | Step        | Property ([range])        | Formula on c (each channel, 0–1)                                        |
 * |-------------|---------------------------|-------------------------------------------------------------------------|
 * | LUT         | `lut`, `intensity` i      | c = mix(c, lut(c), i), the LUT's input mapped from DOMAIN_MIN–DOMAIN_MAX |
 * | brightness  | `brightness` b [-1, 1]    | c = c^(2^-b): a midtone curve, black and white stay put                 |
 * | contrast    | `contrast` k [-1, 1]      | c = (c − 0.5)·(1 + k) + 0.5 (-1 = flat grey)                            |
 * | saturation  | `saturation` s [-1, 1]    | c = Y + (c − Y)·(1 + s), Y = Rec. 709 luma (-1 = black and white)       |
 * | temperature | `temperature` t [-1, 1]   | r ·= 1 + 0.2·t, b ·= 1 − 0.2·t (+1 warm, -1 cool)                       |
 * | tint        | `tint` (color, alpha = a) | c = mix(c, c·tint, a): a multiply by the color; white = no change       |
 * | vignette    | `vignette` v [0, 1]       | c ·= 1 − v·smoothstep(0.35, 1, r), r = 0 at the centre, 1 in the corners |
 * | grain       | `grain` g [0, 1]          | c += 0.2·g·(n − 0.5), n uniform noise per pixel, from the media time    |
 *
 * then the result is clamped to [0, 1] and mixed with the layer's input by `opacity` (× the face mask with
 * `region: "face"`). `intensity` only weakens the LUT, so a filter can soften its look and keep its adjustments.
 * These formulas are the reference ones (spec Appendix E, informative).
 */

/** Indices of the layer's numeric properties in the values array the bindings write into. */
export const AMOUNT = {
  opacity: 0,
  intensity: 1,
  brightness: 2,
  contrast: 3,
  saturation: 4,
  temperature: 5,
  vignette: 6,
  grain: 7,
} as const
export type AmountName = keyof typeof AMOUNT
export const AMOUNT_COUNT = 8

/** Default value and schema range of each property. */
export const AMOUNT_DEFS: Readonly<Record<AmountName, { fallback: number; min: number; max: number }>> = {
  opacity: { fallback: 1, min: 0, max: 1 },
  intensity: { fallback: 1, min: 0, max: 1 },
  brightness: { fallback: 0, min: -1, max: 1 },
  contrast: { fallback: 0, min: -1, max: 1 },
  saturation: { fallback: 0, min: -1, max: 1 },
  temperature: { fallback: 0, min: -1, max: 1 },
  vignette: { fallback: 0, min: 0, max: 1 },
  grain: { fallback: 0, min: 0, max: 1 },
}

/** Red and blue gain per unit of `temperature`. */
export const TEMPERATURE_GAIN = 0.2
/** Grain amplitude at `grain: 1` (peak to peak, in 0–1 units). */
export const GRAIN_AMPLITUDE = 0.2
/** Grain pattern changes per second of media time (film-like; deterministic with a file source, spec §12.5). */
export const GRAIN_RATE = 24

/** Layout of the uniforms array written by `writeGradeUniforms`. */
export const U = {
  /** Mix with the input: opacity. */
  mix: 0,
  /** Brightness exponent 2^-b. */
  gamma: 1,
  /** Contrast factor 1 + k. */
  contrast: 2,
  /** Saturation factor 1 + s. */
  saturation: 3,
  redGain: 4,
  blueGain: 5,
  vignette: 6,
  /** Grain amplitude. */
  grain: 7,
  /** Tint color r, g, b (sRGB as written) and its strength (the color's alpha). */
  tintR: 8,
  tintG: 9,
  tintB: 10,
  tintA: 11,
  /** Integer seed of the grain pattern. */
  seed: 12,
  /** Strength of the LUT: intensity. */
  lut: 13,
} as const
export const UNIFORM_COUNT = 14

const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v)

/** Property `name` of `amounts`, clamped to its range (its default when not a number). */
function amount(amounts: ArrayLike<number>, name: AmountName): number {
  const d = AMOUNT_DEFS[name]
  const x = amounts[AMOUNT[name]]!
  return Number.isFinite(x) ? clamp(x, d.min, d.max) : d.fallback
}

/**
 * Writes the uniforms for property values `amounts` (indexed by `AMOUNT`; values outside the schema range, e.g. from
 * a `range`/`to` binding, are clamped), tint `tint` (r, g, b, a in 0–1) and media time `time` (s) into `out`.
 */
export function writeGradeUniforms(amounts: ArrayLike<number>, tint: ArrayLike<number>, time: number, out: Float32Array): Float32Array {
  const t = amount(amounts, 'temperature')
  out[U.mix] = amount(amounts, 'opacity')
  out[U.gamma] = Math.pow(2, -amount(amounts, 'brightness'))
  out[U.contrast] = 1 + amount(amounts, 'contrast')
  out[U.saturation] = 1 + amount(amounts, 'saturation')
  out[U.redGain] = 1 + TEMPERATURE_GAIN * t
  out[U.blueGain] = 1 - TEMPERATURE_GAIN * t
  out[U.vignette] = amount(amounts, 'vignette')
  out[U.grain] = GRAIN_AMPLITUDE * amount(amounts, 'grain')
  out[U.tintR] = clamp(tint[0]!, 0, 1)
  out[U.tintG] = clamp(tint[1]!, 0, 1)
  out[U.tintB] = clamp(tint[2]!, 0, 1)
  out[U.tintA] = clamp(tint[3]!, 0, 1)
  out[U.seed] = grainSeed(time)
  out[U.lut] = amount(amounts, 'intensity')
  return out
}

/** Seed of the grain pattern at media time `time`: changes `GRAIN_RATE` times per second, the same on every run. */
export function grainSeed(time: number): number {
  return Number.isFinite(time) && time > 0 ? Math.floor(time * GRAIN_RATE) % 16777216 : 0 // exact as a float32
}

/**
 * Whether uniforms `u` leave the image unchanged, so the pass can be skipped (`PassLayer.active`). `hasLut`: the layer
 * has a LUT (assumed to change the image unless its intensity is 0).
 */
export function isNeutral(u: ArrayLike<number>, hasLut: boolean): boolean {
  if (u[U.mix]! <= 0) return true
  const tintNeutral = u[U.tintA]! <= 0 || (u[U.tintR]! >= 1 && u[U.tintG]! >= 1 && u[U.tintB]! >= 1)
  return (
    (!hasLut || u[U.lut]! <= 0) &&
    u[U.gamma] === 1 &&
    u[U.contrast] === 1 &&
    u[U.saturation] === 1 &&
    u[U.redGain] === 1 &&
    u[U.blueGain] === 1 &&
    u[U.vignette] === 0 &&
    u[U.grain] === 0 &&
    tintNeutral
  )
}
