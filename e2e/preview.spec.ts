import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { expect, test } from './fixtures.ts'
import { run } from '../packages/cli/src/cli.ts'

/**
 * `ouaf preview` (#30): the real command, in its own headless Chromium (it serves the engine itself: the playground's
 * dev server that Playwright starts for the other tests is not used). Requires the face model (`npm run fetch-models`).
 *
 * Determinism, as `ouaf preview --help` states it: on one machine and Chromium build, two runs give pixel-identical
 * screenshots (same `pixelsSha256`), scripted filters included.
 */

interface PreviewJson {
  ok: boolean
  references: Array<{
    id: string
    ok: boolean
    screenshot: string
    pixelsSha256: string
    faces: number
    changed: number
    filters: string[]
    warnings: string[]
    errors: string[]
    error?: string
  }>
}

async function preview(...argv: string[]): Promise<{ code: number; json: PreviewJson }> {
  const out: string[] = []
  const err: string[] = []
  const code = await run(['preview', ...argv, '--json'], { out: (t) => out.push(t), err: (t) => err.push(t) })
  if (!out.length) throw new Error(`ouaf preview printed nothing (exit ${code}): ${err.join('\n')}`)
  return { code, json: JSON.parse(out.join('\n')) as PreviewJson }
}

/** A plain RGB PNG of one color: synthetic input, no face. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    return Buffer.concat([Buffer.from(u32(data.length)), body, Buffer.from(u32(crc32(body)))])
  }
  const row = [0, ...Array.from({ length: width }, () => rgb).flat()]
  const raw = Buffer.from(Array.from({ length: height }, () => row).flat())
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.from([...u32(width), ...u32(height), 8, 2, 0, 0, 0])),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let dir: string
test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ouaf-preview-e2e-'))
})
test.afterAll(() => rm(dir, { recursive: true, force: true }))

test('a stack renders the same pixels on every run', async () => {
  test.setTimeout(240_000)
  // A glTF model with occlusion and a scripted filter (whose answers are timing-dependent, #26), stacked.
  const args = ['filters/glasses', 'filters/smile-counter', '--ref', 'talk', '--ref', 'two-faces']
  const first = await preview(...args, '-o', join(dir, 'a'))
  const second = await preview(...args, '-o', join(dir, 'b'))
  expect(first.code).toBe(0)
  expect(second.code).toBe(0)
  expect(first.json.references.map((r) => [r.id, r.faces])).toEqual([['talk', 1], ['two-faces', 2]])
  for (const [i, shot] of first.json.references.entries()) {
    expect(shot.ok).toBe(true)
    expect(shot.errors).toEqual([])
    expect(shot.warnings).toEqual([])
    expect(shot.filters).toEqual(['glasses', 'smile-counter'])
    // The filters show: much more than nothing.
    expect(shot.changed).toBeGreaterThan(0.01)
    expect(second.json.references[i]!.pixelsSha256).toBe(shot.pixelsSha256)
    const png = await readFile(shot.screenshot)
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  }
})

test('an image input, and a filter that fails in the engine', async () => {
  test.setTimeout(120_000)
  const image = join(dir, 'grey.png')
  await writeFile(image, solidPng(90, 160, [128, 128, 128]))
  const still = await preview('filters/vintage', '--input', image, '--max-size', '0', '-o', join(dir, 'still'))
  expect(still.code).toBe(0)
  expect(still.json.references[0]).toMatchObject({ id: 'grey', ok: true, faces: 0, errors: [], warnings: [] })
  // The film look changes the grey image.
  expect(still.json.references[0]!.changed).toBeGreaterThan(0.1)

  // Validation does not compile GLSL; the engine does, and the preview reports it.
  const broken = await preview('filters/fixtures/shader-error', '--ref', 'no-face', '-o', join(dir, 'broken'))
  expect(broken.code).toBe(1)
  expect(broken.json.ok).toBe(false)
  expect(broken.json.references[0]!.error).toMatch(/does not compile[\s\S]*line 4/)
})

test('the reference face set: the tracker finds the faces each reference documents, and the filter shows', async () => {
  test.setTimeout(240_000)
  // #31: every photo and clip of test-media/faces/ and the licensed test clips. `faces` in all.json is what the
  // reference engine finds; when a tracker change makes this fail, look at the screenshots and update the file.
  const set = JSON.parse(await readFile('test-media/faces/all.json', 'utf8')) as { references: Array<{ id: string; faces: number }> }
  const { code, json } = await preview('filters/glasses', '--references', 'test-media/faces/all.json', '--max-size', '256', '-o', join(dir, 'faces'))
  expect(code).toBe(0)
  expect(json.references.map((r) => [r.id, r.faces])).toEqual(set.references.map((r) => [r.id, r.faces]))
  for (const shot of json.references) {
    expect(shot.errors, shot.id).toEqual([])
    // Glasses and a moustache where a face is found; next to nothing changes elsewhere (video decoding, scaling).
    if (shot.faces > 0) expect(shot.changed, shot.id).toBeGreaterThan(0.005)
    else expect(shot.changed, shot.id).toBeLessThan(0.003)
  }
})
