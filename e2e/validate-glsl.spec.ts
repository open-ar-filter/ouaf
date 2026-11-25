import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { run } from '../packages/cli/src/cli.ts'

/**
 * `ouaf validate` compiles shaders in its own headless Chromium (#28): the real command, on the repository's shader
 * filters. It compiles what the engine compiles: the filters the browser tests load compile, and the fixture the
 * engine rejects (`shader-error`, `shader-error-eof`) is reported at the same line of the author's file.
 */

interface ValidateJson {
  ok: boolean
  errors: Array<{ code: string; file: string; line?: number; path: string; message: string }>
  skipped: Array<{ check: string }>
}

async function validate(...argv: string[]): Promise<{ code: number; json: ValidateJson }> {
  const out: string[] = []
  const code = await run(['validate', ...argv, '--json'], { out: (t) => out.push(t), err: () => {} })
  return { code, json: JSON.parse(out.join('\n')) as ValidateJson }
}

const fixtures = join(import.meta.dirname, '../filters/fixtures')
const shaderFixtures = readdirSync(fixtures).filter((d) => d.startsWith('shader-') && !d.startsWith('shader-error'))

test('the shader filters compile', async () => {
  for (const dir of [join(import.meta.dirname, '../filters/vintage'), ...shaderFixtures.map((d) => join(fixtures, d))]) {
    const { code, json } = await validate(dir)
    expect([dir, code, json.errors, json.skipped]).toEqual([dir, 0, [], []])
  }
})

test('a shader that does not compile is reported at its line, as the engine reports it', async () => {
  const { code, json } = await validate(join(fixtures, 'shader-error'))
  expect(code).toBe(1)
  expect(json.errors).toEqual([
    expect.objectContaining({ code: 'glsl', file: 'assets/broken.frag', line: 4, path: '/layers/0/src', message: "'notDeclared' : undeclared identifier" }),
  ])
})

test('a shader that is not closed is reported on its last line, not in the engine main()', async () => {
  const { code, json } = await validate(join(fixtures, 'shader-error-eof'))
  expect(code).toBe(1)
  expect(json.errors).toEqual([expect.objectContaining({ code: 'glsl', file: 'assets/unclosed.frag', line: 5, message: expect.stringContaining('a "}"') })])
})
