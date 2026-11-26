/**
 * `.cube` color lookup tables (spec §10.2): the file is parsed by `parseCube` of `@ouaf/spec` (the rules
 * `ouaf validate` applies, re-exported here) into plain arrays, converted here into the 3D texture data of the color
 * layer (no WebGL, so it is unit tested in Node).
 */
import { DataUtils } from 'three'
import type { CubeLut } from '@ouaf/spec'

export { CubeError, MAX_LUT_1D_SIZE, MAX_LUT_3D_SIZE, parseCube, type CubeLut } from '@ouaf/spec'

/** Grid size a 1D LUT is resampled to in the 3D texture (each axis is one channel's curve, so this stays exact). */
export const LUT_1D_GRID = 65

/** Value of channel `c` of a 1D LUT at `t` in [0, 1] (linear interpolation between entries). */
function sample1d(lut: CubeLut, c: number, t: number): number {
  const x = Math.min(Math.max(t, 0), 1) * (lut.size - 1)
  const i = Math.min(Math.floor(x), lut.size - 2)
  const f = x - i
  return lut.data[i * 3 + c]! * (1 - f) + lut.data[(i + 1) * 3 + c]! * f
}

/**
 * RGBA half-float data of the 3D texture for a LUT (`size³` texels, red fastest, as three's `Data3DTexture` expects),
 * and its grid size. A 1D LUT becomes a `LUT_1D_GRID`³ grid whose red output depends on the red input only, and so
 * on: trilinear filtering then interpolates each curve linearly, like a 1D lookup.
 *
 * Half floats, not bytes: the LUT keeps its output precision (and values outside [0, 1]); RGBA16F is filterable in
 * every WebGL 2 implementation.
 */
export function lutTextureData(lut: CubeLut): { size: number; data: Uint16Array } {
  const size = lut.dims === 3 ? lut.size : Math.min(lut.size, LUT_1D_GRID)
  const n = size ** 3
  const out = new Uint16Array(n * 4)
  const one = DataUtils.toHalfFloat(1)
  const half = (v: number) => DataUtils.toHalfFloat(Math.min(Math.max(v, -65504), 65504))
  if (lut.dims === 3) {
    for (let i = 0; i < n; i++) {
      out[i * 4] = half(lut.data[i * 3]!)
      out[i * 4 + 1] = half(lut.data[i * 3 + 1]!)
      out[i * 4 + 2] = half(lut.data[i * 3 + 2]!)
      out[i * 4 + 3] = one
    }
    return { size, data: out }
  }
  const curves = new Uint16Array(size * 3)
  for (let i = 0; i < size; i++) for (let c = 0; c < 3; c++) curves[i * 3 + c] = half(sample1d(lut, c, i / (size - 1)))
  let i = 0
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++, i++) {
        out[i * 4] = curves[r * 3]!
        out[i * 4 + 1] = curves[g * 3 + 1]!
        out[i * 4 + 2] = curves[b * 3 + 2]!
        out[i * 4 + 3] = one
      }
    }
  }
  return { size, data: out }
}
