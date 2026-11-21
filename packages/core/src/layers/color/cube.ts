/**
 * `.cube` color lookup tables (spec §10.2, Adobe/Resolve "Cube LUT" format), parsed into plain arrays (no WebGL, so
 * it is unit tested in Node) and converted into the 3D texture data of the color layer.
 *
 *     TITLE "Warm"              optional
 *     LUT_3D_SIZE 33            or LUT_1D_SIZE n (one curve per channel)
 *     DOMAIN_MIN 0 0 0          optional, default 0 0 0 (also LUT_3D_INPUT_RANGE min max, Resolve)
 *     DOMAIN_MAX 1 1 1          optional, default 1 1 1
 *     0.0 0.0 0.0               size³ (3D) or size (1D) rows "R G B"; red varies fastest
 *
 * Lines starting with `#` are comments. Unknown keywords are ignored (as the validator does). Same limits as
 * `ouaf validate`: LUT_3D_SIZE from 2 to 256, LUT_1D_SIZE from 2 to 65536.
 */
import { DataUtils } from 'three'

export const MAX_LUT_3D_SIZE = 256
export const MAX_LUT_1D_SIZE = 65536
/** Grid size a 1D LUT is resampled to in the 3D texture (each axis is one channel's curve, so this stays exact). */
export const LUT_1D_GRID = 65

export interface CubeLut {
  title: string | undefined
  /** `3`: LUT_3D_SIZE (a size³ grid), `1`: LUT_1D_SIZE (three curves). */
  dims: 1 | 3
  size: number
  /** Input range of each channel (DOMAIN_MIN / DOMAIN_MAX). */
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  /** R, G, B per entry: size³ entries (red fastest, then green, then blue) or size entries. */
  data: Float32Array
}

/** A malformed `.cube` file; `line` is 1-based when the problem is on a line. */
export class CubeError extends Error {
  override name = 'CubeError'
  readonly line: number | undefined

  constructor(message: string, line?: number) {
    super(line ? `line ${line}: ${message}` : message)
    this.line = line
  }
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

function numbers(parts: readonly string[], count: number, what: string, line: number): number[] {
  if (parts.length !== count || !parts.every((p) => NUMBER.test(p))) {
    throw new CubeError(`${what} expects ${count} numbers, got "${parts.join(' ')}".`, line)
  }
  return parts.map(Number)
}

/** Parses a `.cube` file. Throws a `CubeError` on anything malformed (never returns a partial LUT). */
export function parseCube(text: string): CubeLut {
  let title: string | undefined
  let dims: 1 | 3 | undefined
  let size = 0
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  let data: Float32Array | undefined
  let rows = 0
  let expected = 0
  let sizeLine = 0

  const lines = text.split(/\r\n|\r|\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    const n = i + 1
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    const word = parts[0]!
    if (/^[A-Z][A-Z0-9_]*$/.test(word)) {
      const args = parts.slice(1)
      if (word === 'TITLE') {
        title = line.slice(5).trim().replace(/^"(.*)"$/, '$1')
      } else if (word === 'LUT_3D_SIZE' || word === 'LUT_1D_SIZE') {
        if (dims !== undefined) throw new CubeError('only one LUT_3D_SIZE or LUT_1D_SIZE line is supported.', n)
        dims = word === 'LUT_3D_SIZE' ? 3 : 1
        const max = dims === 3 ? MAX_LUT_3D_SIZE : MAX_LUT_1D_SIZE
        size = Number(args[0])
        if (args.length !== 1 || !Number.isInteger(size) || size < 2 || size > max) {
          throw new CubeError(`${word} must be an integer from 2 to ${max}, got "${args.join(' ')}".`, n)
        }
        expected = dims === 3 ? size ** 3 : size
        data = new Float32Array(expected * 3)
        sizeLine = n
      } else if (word === 'DOMAIN_MIN') {
        domainMin = numbers(args, 3, word, n) as [number, number, number]
      } else if (word === 'DOMAIN_MAX') {
        domainMax = numbers(args, 3, word, n) as [number, number, number]
      } else if (word === 'LUT_3D_INPUT_RANGE' || word === 'LUT_1D_INPUT_RANGE') {
        const [min, max] = numbers(args, 2, word, n) as [number, number]
        domainMin = [min, min, min]
        domainMax = [max, max, max]
      }
      // Other keywords (LUT_IN_VIDEO_RANGE…) are ignored, as by `ouaf validate`.
      continue
    }
    if (!data) throw new CubeError('data rows before LUT_3D_SIZE (or LUT_1D_SIZE).', n)
    if (rows >= expected) throw new CubeError(`more than the ${expected} data rows ${dims === 3 ? `LUT_3D_SIZE ${size}` : `LUT_1D_SIZE ${size}`} needs.`, n)
    const [r, g, b] = numbers(parts, 3, 'A data row', n) as [number, number, number]
    data[rows * 3] = r
    data[rows * 3 + 1] = g
    data[rows * 3 + 2] = b
    rows++
  }
  if (!data || dims === undefined) throw new CubeError('no LUT_3D_SIZE (or LUT_1D_SIZE) line.')
  if (rows !== expected) {
    throw new CubeError(`LUT_${dims}D_SIZE ${size} needs ${expected} data rows, the file has ${rows} (truncated?).`, sizeLine)
  }
  for (let c = 0; c < 3; c++) {
    if (!(domainMax[c]! > domainMin[c]!)) throw new CubeError(`DOMAIN_MAX must be greater than DOMAIN_MIN on every channel.`)
  }
  return { title, dims, size, domainMin, domainMax, data }
}

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
