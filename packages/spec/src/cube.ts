/**
 * `.cube` color lookup tables (spec §10.2, Adobe/Resolve "Cube LUT" format), parsed into plain arrays. Shared by
 * `ouaf validate` and the engine's LUT loader, so that a `.cube` file that validates is one the engine loads.
 * Pure JavaScript.
 *
 *     TITLE "Warm"              optional
 *     LUT_3D_SIZE 33            or LUT_1D_SIZE n (one curve per channel)
 *     DOMAIN_MIN 0 0 0          optional, default 0 0 0 (also LUT_3D_INPUT_RANGE min max, Resolve)
 *     DOMAIN_MAX 1 1 1          optional, default 1 1 1
 *     0.0 0.0 0.0               size³ (3D) or size (1D) rows "R G B"; red varies fastest
 *
 * Lines starting with `#` are comments. Unknown keywords are ignored. LUT_3D_SIZE goes from 2 to 256, LUT_1D_SIZE
 * from 2 to 65536.
 */

export const MAX_LUT_3D_SIZE = 256
export const MAX_LUT_1D_SIZE = 65536

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
  /** The message without its "line n:" prefix, for tools that show the line themselves. */
  readonly reason: string
  /** How to fix the file. */
  readonly hint: string

  constructor(message: string, hint: string, line?: number) {
    super(line ? `line ${line}: ${message}` : message)
    this.reason = message
    this.hint = hint
    this.line = line
  }
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

const ROW_HINT = 'Each data line of a .cube file holds three numbers, e.g. "0.0 0.5 1.0".'
const SIZE_HINT = 'Put "LUT_3D_SIZE <n>" before the data, e.g. "LUT_3D_SIZE 33".'
const ROWS_HINT = 'Export the LUT again: the number of data rows does not match its size.'

function numbers(parts: readonly string[], count: number, what: string, hint: string, line: number): number[] {
  if (parts.length !== count || !parts.every((p) => NUMBER.test(p))) {
    throw new CubeError(`${what} expects ${count} numbers, got "${parts.join(' ')}".`, hint, line)
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
        if (dims !== undefined) {
          throw new CubeError('only one LUT_3D_SIZE or LUT_1D_SIZE line is supported.', 'Keep a single size line, before the data.', n)
        }
        dims = word === 'LUT_3D_SIZE' ? 3 : 1
        const max = dims === 3 ? MAX_LUT_3D_SIZE : MAX_LUT_1D_SIZE
        size = Number(args[0])
        if (args.length !== 1 || !Number.isInteger(size) || size < 2 || size > max) {
          throw new CubeError(`${word} must be an integer from 2 to ${max}, got "${args.join(' ')}".`, `E.g. "${word} 33".`, n)
        }
        expected = dims === 3 ? size ** 3 : size
        data = new Float32Array(expected * 3)
        sizeLine = n
      } else if (word === 'DOMAIN_MIN') {
        domainMin = numbers(args, 3, word, 'E.g. "DOMAIN_MIN 0 0 0".', n) as [number, number, number]
      } else if (word === 'DOMAIN_MAX') {
        domainMax = numbers(args, 3, word, 'E.g. "DOMAIN_MAX 1 1 1".', n) as [number, number, number]
      } else if (word === 'LUT_3D_INPUT_RANGE' || word === 'LUT_1D_INPUT_RANGE') {
        const [min, max] = numbers(args, 2, word, `E.g. "${word} 0 1".`, n) as [number, number]
        domainMin = [min, min, min]
        domainMax = [max, max, max]
      }
      // Other keywords (LUT_IN_VIDEO_RANGE…) are ignored.
      continue
    }
    if (!data) throw new CubeError('data rows before LUT_3D_SIZE (or LUT_1D_SIZE).', SIZE_HINT, n)
    if (rows >= expected) {
      throw new CubeError(`more than the ${expected} data rows ${dims === 3 ? `LUT_3D_SIZE ${size}` : `LUT_1D_SIZE ${size}`} needs.`, ROWS_HINT, n)
    }
    const [r, g, b] = numbers(parts, 3, 'A data row', ROW_HINT, n) as [number, number, number]
    data[rows * 3] = r
    data[rows * 3 + 1] = g
    data[rows * 3 + 2] = b
    rows++
  }
  if (!data || dims === undefined) throw new CubeError('no LUT_3D_SIZE (or LUT_1D_SIZE) line.', SIZE_HINT)
  if (rows !== expected) {
    throw new CubeError(`LUT_${dims}D_SIZE ${size} needs ${expected} data rows, the file has ${rows} (truncated?).`, ROWS_HINT, sizeLine)
  }
  for (let c = 0; c < 3; c++) {
    if (!(domainMax[c]! > domainMin[c]!)) {
      throw new CubeError('DOMAIN_MAX must be greater than DOMAIN_MIN on every channel.',
        'Fix DOMAIN_MIN / DOMAIN_MAX (or the INPUT_RANGE line), or remove them for the default range, 0 to 1.')
    }
  }
  return { title, dims, size, domainMin, domainMax, data }
}
