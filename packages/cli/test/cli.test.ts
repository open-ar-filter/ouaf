import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.ts'
import { EXIT } from '../src/command.ts'

const fixtures = join(import.meta.dirname, 'fixtures')

async function cli(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(argv, { out: (t) => out.push(t), err: (t) => err.push(t) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('ouaf', () => {
  it('lists the commands and the exit codes', async () => {
    const r = await cli('--help')
    expect(r.code).toBe(EXIT.OK)
    expect(r.out).toMatch(/^\s+validate\s+Check a filter folder/m)
    expect(r.out).toContain('Exit codes')
    expect((await cli()).code).toBe(EXIT.USAGE)
  })

  it('prints the version', async () => {
    expect((await cli('--version')).out).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('rejects an unknown command with exit code 2', async () => {
    const r = await cli('vaildate', 'x')
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.err).toContain('unknown command "vaildate"')
  })
})

describe('ouaf validate', () => {
  it('exit 0 for a valid filter, 1 for an invalid one', async () => {
    expect((await cli('validate', '--no-glsl', join(fixtures, 'valid'))).code).toBe(EXIT.OK)
    const r = await cli('validate', '--no-glsl', join(fixtures, 'broken'))
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.out).toContain('error [unknown-anchor]')
  })

  it('--strict fails on warnings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ouaf-cli-'))
    try {
      const manifest = { ouaf: '1', id: 'x', name: 'X', version: '1.0.0', license: 'CC0-1.0', requires: {}, layers: [] }
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
      await writeFile(join(dir, 'notes.txt'), 'outside the layout: a warning in a folder')
      expect((await cli('validate', '--no-glsl', dir)).code).toBe(EXIT.OK)
      expect((await cli('validate', '--no-glsl', '--strict', dir)).code).toBe(EXIT.FAILED)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('--json prints a machine-readable report', async () => {
    const r = await cli('validate', '--json', '--no-glsl', join(fixtures, 'broken'))
    expect(r.code).toBe(EXIT.FAILED)
    const report = JSON.parse(r.out)
    expect(report).toMatchObject({ format: 1, kind: 'folder', ok: false })
    expect(report.errors[0]).toEqual({
      severity: 'error',
      code: 'unknown-anchor',
      file: 'manifest.json',
      path: '/layers/0/anchor',
      line: 15,
      column: 40,
      message: 'Unknown anchor "nose". Did you mean "noseTip"?',
      hint: expect.stringContaining('Available anchors'),
    })
  })

  it('usage errors exit with 2: no input, too many inputs, unknown option, missing path', async () => {
    for (const args of [[], ['a', 'b'], ['--nope', 'a'], [join(fixtures, 'does-not-exist')]]) {
      const r = await cli('validate', ...args)
      expect(r.code, args.join(' ')).toBe(EXIT.USAGE)
      expect(r.err).toContain('See ouaf validate --help.')
    }
  })

  it('a symbolic link to nothing is a missing input (exit 2), not a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ouaf-cli-'))
    try {
      const link = join(dir, 'filter.ouaf')
      await symlink(join(dir, 'gone.ouaf'), link)
      const r = await cli('validate', '--no-glsl', link)
      expect(r.code).toBe(EXIT.USAGE)
      expect(r.err).toContain('a symbolic link to a file or folder that does not exist')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('--help documents the exit codes', async () => {
    const r = await cli('validate', '--help')
    expect(r.code).toBe(EXIT.OK)
    expect(r.out).toMatch(/Exit codes:\n\s+0 .*\n\s+1 .*\n\s+2 /)
  })

  it('runs as a binary with Node', async () => {
    const bin = join(import.meta.dirname, '..', 'src', 'bin.ts')
    const r = await promisify(execFile)(process.execPath, [bin, 'validate', '--no-glsl', join(fixtures, 'valid')])
    expect(r.stdout).toContain('valid.')
    await expect(promisify(execFile)(process.execPath, [bin, 'validate', '--no-glsl', join(fixtures, 'broken')])).rejects.toMatchObject({ code: 1 })
  })
})
