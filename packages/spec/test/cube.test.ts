/**
 * `.cube` LUT parser shared by `ouaf validate` and the engine's LUT loader: what it reads, and each malformed file it
 * refuses with a `CubeError` (line, reason, hint).
 */
import { describe, expect, it } from 'vitest'
import { CubeError, MAX_LUT_1D_SIZE, MAX_LUT_3D_SIZE, parseCube } from '../src/index.ts'

const ROWS = '0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'
const cube = (header = '') => `LUT_3D_SIZE 2\n${header}\n${ROWS}`

const errorOf = (text: string): CubeError => {
  try {
    parseCube(text)
  } catch (e) {
    if (e instanceof CubeError) return e
    throw e
  }
  throw new Error('no error')
}

describe('parseCube', () => {
  it('reads a 3D LUT: title, default domain, data in file order', () => {
    const lut = parseCube(`# comment\r\nTITLE "Grade"\r\n\r\n${cube().replace(/\n/g, '\r\n')}`)
    expect(lut).toMatchObject({ title: 'Grade', dims: 3, size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1] })
    expect([...lut.data.subarray(0, 6)]).toEqual([0, 0, 0, 1, 0, 0])
    expect(lut.data).toHaveLength(24)
    expect(parseCube('TITLE plain\nLUT_3D_SIZE 2\n' + ROWS).title).toBe('plain')
    expect(parseCube(cube()).title).toBeUndefined()
  })

  it('reads a 1D LUT, bare CR line ends, tabs, exponents and signs', () => {
    const lut = parseCube('LUT_1D_SIZE 3\r+0 -0.5 .5\r\t2.5e-1\t5E-1  7.5e-1 \r1. 1 1\r')
    expect(lut).toMatchObject({ dims: 1, size: 3 })
    expect([...lut.data]).toEqual([0, -0.5, 0.5, 0.25, 0.5, 0.75, 1, 1, 1])
  })

  it('reads the domain (DOMAIN_MIN / DOMAIN_MAX, or an INPUT_RANGE line) and ignores other keywords', () => {
    expect(parseCube(cube('DOMAIN_MIN 0 -0.5 0\nDOMAIN_MAX 1 1.5 2'))).toMatchObject({ domainMin: [0, -0.5, 0], domainMax: [1, 1.5, 2] })
    expect(parseCube(cube('LUT_3D_INPUT_RANGE 0.1 0.9'))).toMatchObject({ domainMin: [0.1, 0.1, 0.1], domainMax: [0.9, 0.9, 0.9] })
    expect(parseCube('LUT_1D_INPUT_RANGE 0 2\nLUT_1D_SIZE 2\n0 0 0\n1 1 1\n')).toMatchObject({ domainMax: [2, 2, 2] })
    expect(parseCube(cube('LUT_IN_VIDEO_RANGE\nLUT_OUT_VIDEO_RANGE whatever 1'))).toMatchObject({ size: 2 })
  })

  it('accepts the largest sizes it documents', () => {
    expect(MAX_LUT_3D_SIZE).toBe(256)
    const lut = parseCube(`LUT_1D_SIZE ${MAX_LUT_1D_SIZE}\n${'0.5 0.5 0.5\n'.repeat(MAX_LUT_1D_SIZE)}`)
    expect(lut.data).toHaveLength(MAX_LUT_1D_SIZE * 3)
  })

  it('refuses a size line out of range, not an integer, with no or several values, or given twice', () => {
    expect(errorOf('LUT_3D_SIZE 257\n')).toMatchObject({ line: 1, reason: 'LUT_3D_SIZE must be an integer from 2 to 256, got "257".', hint: 'E.g. "LUT_3D_SIZE 33".' })
    expect(errorOf('LUT_1D_SIZE 65537\n').message).toBe('line 1: LUT_1D_SIZE must be an integer from 2 to 65536, got "65537".')
    for (const size of ['1', '2.5', '', 'two', '2 2', '-4']) expect(errorOf(`\nLUT_3D_SIZE ${size}\n`).line).toBe(2)
    expect(errorOf('LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n' + ROWS)).toMatchObject({ line: 2, reason: 'only one LUT_3D_SIZE or LUT_1D_SIZE line is supported.' })
    expect(errorOf('LUT_3D_SIZE 2\n' + ROWS + 'LUT_1D_SIZE 2\n').line).toBe(10)
  })

  it('refuses malformed data rows, rows before the size, and a row count that is not the size\'s', () => {
    expect(errorOf('LUT_3D_SIZE 2\n0 0 0\n0 0 oops\n')).toMatchObject({ line: 3, reason: 'A data row expects 3 numbers, got "0 0 oops".' })
    expect(errorOf('LUT_3D_SIZE 2\n0 0\n').message).toBe('line 2: A data row expects 3 numbers, got "0 0".')
    expect(errorOf('LUT_3D_SIZE 2\n0 0 0 0\n').line).toBe(2)
    expect(errorOf('LUT_3D_SIZE 2\n0 0 0x10\n').line).toBe(2)
    expect(errorOf('LUT_3D_SIZE 2\ntitle x\n').line).toBe(2) // keywords are upper case
    expect(errorOf('0 0 0\nLUT_3D_SIZE 2\n')).toMatchObject({ line: 1, reason: 'data rows before LUT_3D_SIZE (or LUT_1D_SIZE).' })
    expect(errorOf('# empty\n')).toMatchObject({ line: undefined, message: 'no LUT_3D_SIZE (or LUT_1D_SIZE) line.' })
    expect(errorOf('')).toMatchObject({ line: undefined })
    expect(errorOf('TITLE "x"\nLUT_3D_SIZE 2\n0 0 0\n')).toMatchObject({ line: 2, reason: 'LUT_3D_SIZE 2 needs 8 data rows, the file has 1 (truncated?).' })
    expect(errorOf('LUT_3D_SIZE 2\n' + ROWS + '1 1 1\n')).toMatchObject({ line: 10, reason: 'more than the 8 data rows LUT_3D_SIZE 2 needs.' })
    expect(errorOf('LUT_1D_SIZE 2\n0 0 0\n1 1 1\n1 1 1\n')).toMatchObject({ line: 4, reason: 'more than the 2 data rows LUT_1D_SIZE 2 needs.' })
    expect(errorOf('LUT_1D_SIZE 3\n0 0 0\n').reason).toBe('LUT_1D_SIZE 3 needs 3 data rows, the file has 1 (truncated?).')
  })

  it('refuses a malformed domain, and one whose maximum is not above its minimum', () => {
    expect(errorOf(cube('DOMAIN_MIN 0 0'))).toMatchObject({ line: 2, reason: 'DOMAIN_MIN expects 3 numbers, got "0 0".', hint: 'E.g. "DOMAIN_MIN 0 0 0".' })
    expect(errorOf(cube('DOMAIN_MAX 1 1 x'))).toMatchObject({ line: 2, reason: 'DOMAIN_MAX expects 3 numbers, got "1 1 x".' })
    expect(errorOf(cube('DOMAIN_MAX'))).toMatchObject({ line: 2 })
    expect(errorOf(cube('LUT_3D_INPUT_RANGE 0 1 2'))).toMatchObject({ line: 2, hint: 'E.g. "LUT_3D_INPUT_RANGE 0 1".' })
    expect(errorOf(cube('LUT_1D_INPUT_RANGE zero one')).line).toBe(2)
    for (const header of ['DOMAIN_MIN 0 1 0', 'DOMAIN_MAX 1 1 0', 'DOMAIN_MIN 2 2 2\nDOMAIN_MAX 1 1 1', 'LUT_3D_INPUT_RANGE 1 0', 'LUT_3D_INPUT_RANGE 1 1']) {
      expect(errorOf(cube(header))).toMatchObject({ line: undefined, message: 'DOMAIN_MAX must be greater than DOMAIN_MIN on every channel.' })
    }
    // The last line of each kind wins, as in the engine.
    expect(parseCube(cube('DOMAIN_MIN 5 5 5\nDOMAIN_MIN 0 0 0'))).toMatchObject({ domainMin: [0, 0, 0] })
  })

  it('a CubeError is an Error named CubeError with a hint', () => {
    const e = errorOf('0 0 0\n')
    expect([e instanceof Error, e.name, e.hint]).toEqual([true, 'CubeError', 'Put "LUT_3D_SIZE <n>" before the data, e.g. "LUT_3D_SIZE 33".'])
  })
})
