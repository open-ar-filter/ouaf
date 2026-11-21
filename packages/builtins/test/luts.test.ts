import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GRADES, LUT_SIZE, cubeFile, type Grade } from '../scripts/build-luts.ts'
import { BUILTIN_ASSETS } from '../src/index.ts'

/** Minimal `.cube` reader: size and RGB triplets. */
function parseCube(text: string): { size: number; data: number[] } {
  let size = 0
  const data: number[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('LUT_3D_SIZE')) size = Number(line.split(/\s+/)[1])
    else if (/^[\d.]/.test(line)) data.push(...line.trim().split(/\s+/).map(Number))
  }
  return { size, data }
}

/** Trilinear lookup, as a GPU samples a 3D texture with linear filtering. */
function sample({ size, data }: { size: number; data: number[] }, rgb: number[]): number[] {
  const p = rgb.map((c) => c * (size - 1))
  const i0 = p.map((c) => Math.min(Math.floor(c), size - 2))
  const f = p.map((c, k) => c - i0[k]!)
  const out = [0, 0, 0]
  for (let corner = 0; corner < 8; corner++) {
    const d = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1]
    const w = d.reduce((acc, dk, k) => acc * (dk ? f[k]! : 1 - f[k]!), 1)
    const idx = ((i0[2]! + d[2]!) * size * size + (i0[1]! + d[1]!) * size + (i0[0]! + d[0]!)) * 3
    for (let c = 0; c < 3; c++) out[c]! += w * data[idx + c]!
  }
  return out
}

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../assets/luts/${name}.cube`, import.meta.url)), 'utf8')

describe('built-in LUTs', () => {
  const names = Object.keys(GRADES)

  it('are the five LUTs of the registry', () => {
    expect(names.map((n) => `lut/${n}`).sort()).toEqual(
      Object.keys(BUILTIN_ASSETS).filter((k) => k.startsWith('lut/')).sort(),
    )
  })

  it('match their generator (rerun `npm run build:luts -w @ouaf/builtins` after a change)', () => {
    for (const name of names) {
      const committed = parseCube(read(name))
      const fresh = parseCube(cubeFile(name))
      expect(committed.size, name).toBe(LUT_SIZE)
      expect(committed.data.length, name).toBe(LUT_SIZE ** 3 * 3)
      for (let i = 0; i < fresh.data.length; i++) expect(committed.data[i], name).toBeCloseTo(fresh.data[i]!, 4)
      expect(read(name)).toMatch(/^TITLE "Ouaf \w+"\n#.*CC0-1\.0/)
    }
  })

  it('stay close to the exact grade when interpolated', () => {
    // Deterministic pseudo-random colors.
    let seed = 1
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (const name of names) {
      const lut = parseCube(read(name))
      const grade: Grade = GRADES[name]!.grade
      let worst = 0
      let sum = 0
      const count = 4000
      for (let n = 0; n < count; n++) {
        const rgb = [rand(), rand(), rand()]
        const exact = grade(rgb[0]!, rgb[1]!, rgb[2]!).map((c) => Math.min(1, Math.max(0, c)))
        const got = sample(lut, rgb)
        for (let c = 0; c < 3; c++) {
          const error = Math.abs(got[c]! - exact[c]!) * 255
          worst = Math.max(worst, error)
          sum += error
        }
      }
      // In 8-bit steps: rare worst cases in saturated corners (vivid), well under one step on average.
      expect(worst, name).toBeLessThan(2.5)
      expect(sum / count / 3, name).toBeLessThan(0.4)
    }
  })

  it('noir is grey, and the white-balance grades keep black and white', () => {
    const noir = parseCube(read('noir')).data
    for (let i = 0; i < noir.length; i += 3) expect(noir[i]).toBe(noir[i + 2])
    for (const name of ['warm', 'cool']) {
      const { data } = parseCube(read(name))
      expect(data.slice(0, 3)).toEqual([0, 0, 0])
      expect(data.slice(-3)).toEqual([1, 1, 1])
    }
  })
})
