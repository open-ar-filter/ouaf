import { describe, expect, it } from 'vitest'
import {
  AssetError,
  disposedError,
  GpuContextLostError,
  IncompatibleEngineError,
  IncompatibleSourceError,
  InvalidManifestError,
  InvalidParamError,
  MissingPluginError,
  OuafError,
  PackageError,
  ShaderCompileError,
  withParamErrors,
} from '../src/engine/errors.ts'
import { ParamError } from '../src/params/errors.ts'

/** Runs `fn` and returns what it throws. */
function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

describe('engine errors: stable codes, names and messages', () => {
  it('every error is an OuafError with its own name and code', () => {
    const cases: Array<[OuafError, string, string]> = [
      [new OuafError('filter-load', 'm'), 'OuafError', 'filter-load'],
      [new InvalidManifestError('demo.ouaf', [], 'm'), 'InvalidManifestError', 'invalid-manifest'],
      [new PackageError('p', 'zip-invalid', '', 'm'), 'PackageError', 'invalid-package'],
      [new IncompatibleEngineError('f', '^2', '1.0.0'), 'IncompatibleEngineError', 'incompatible-engine'],
      [new MissingPluginError('f', 'p', undefined, undefined), 'MissingPluginError', 'missing-plugin'],
      [new IncompatibleSourceError('m'), 'IncompatibleSourceError', 'incompatible-source'],
      [new AssetError('hat', 'm'), 'AssetError', 'asset'],
      [new InvalidParamError('m'), 'InvalidParamError', 'invalid-param'],
      [new ShaderCompileError('f', 'fx', []), 'ShaderCompileError', 'shader'],
      [new GpuContextLostError('f'), 'GpuContextLostError', 'gpu-context-lost'],
      [disposedError('The engine'), 'OuafError', 'disposed'],
    ]
    for (const [error, name, code] of cases) {
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(OuafError)
      expect(error.name).toBe(name)
      expect(error.code).toBe(code)
    }
  })

  it('keeps the cause it is given', () => {
    const cause = new Error('root')
    expect(new OuafError('script', 'm', { cause }).cause).toBe(cause)
    expect(new AssetError('a', 'm', { cause }).cause).toBe(cause)
    expect(new IncompatibleSourceError('m', { cause }).cause).toBe(cause)
    expect(new PackageError('p', 'missing-manifest', '', 'm', { cause }).cause).toBe(cause)
    expect(new ShaderCompileError('f', 's', [], { cause }).cause).toBe(cause)
  })

  it('InvalidManifestError carries the issues and the source', () => {
    const issues = [{ path: '/layers/0', message: 'must have type', severity: 'error' as const }]
    const error = new InvalidManifestError('hat.ouaf', issues as never, 'Invalid filter manifest')
    expect(error.issues).toBe(issues)
    expect(error.source).toBe('hat.ouaf')
    expect(error.message).toBe('Invalid filter manifest')
  })

  it('PackageError names the package and keeps the reason and the entry', () => {
    const error = new PackageError('hat.ouaf', 'zip-unsupported', 'assets/hat.png', 'ZIP64 is not supported.')
    expect(error.message).toBe('Invalid filter package hat.ouaf: ZIP64 is not supported.')
    expect(error.reason).toBe('zip-unsupported')
    expect(error.path).toBe('assets/hat.png')
    expect(error.source).toBe('hat.ouaf')
  })

  it('IncompatibleEngineError gives the range and the engine version', () => {
    const error = new IncompatibleEngineError('demo', '^2.1', '1.4.0')
    expect(error.message).toBe('Filter "demo" requires engine ^2.1; this engine is 1.4.0.')
    expect(error.range).toBe('^2.1')
    expect(error.engineVersion).toBe('1.4.0')
  })

  it('MissingPluginError: not installed (tells the host what to do) or out of range', () => {
    const missing = new MissingPluginError('demo', 'sparkles', undefined, undefined)
    expect(missing.message).toBe('Filter "demo" requires plugin "sparkles", which is not installed. The host must call engine.use() with it.')
    expect(missing.range).toBeUndefined()
    expect(missing.installed).toBeUndefined()

    const ranged = new MissingPluginError('demo', 'sparkles', '^2', undefined)
    expect(ranged.message).toBe('Filter "demo" requires plugin "sparkles@^2", which is not installed. The host must call engine.use() with it.')

    const old = new MissingPluginError('demo', 'sparkles', '^2', '1.3.0')
    expect(old.message).toBe('Filter "demo" requires plugin "sparkles@^2", but version 1.3.0 is installed.')
    expect(old.plugin).toBe('sparkles')
    expect(old.range).toBe('^2')
    expect(old.installed).toBe('1.3.0')
  })

  it('AssetError keeps the reference as written', () => {
    expect(new AssetError('builtin:lut/noir', 'not found').ref).toBe('builtin:lut/noir')
  })

  it('InvalidParamError: details are optional; a cause is only set when given', () => {
    const bare = new InvalidParamError('bad')
    expect(bare.param).toBeUndefined()
    expect(bare.preset).toBeUndefined()
    expect(bare.reason).toBeUndefined()
    expect('cause' in bare).toBe(false)
    const cause = new Error('inner')
    const full = new InvalidParamError('bad', { param: 'size', preset: 'big', reason: 'range', cause })
    expect([full.param, full.preset, full.reason, full.cause]).toEqual(['size', 'big', 'range', cause])
  })

  it('ShaderCompileError lists each diagnostic, with its line in the author file when known', () => {
    const error = new ShaderCompileError('demo', 'fx', [
      { severity: 'error', line: 3, message: "'foo' : undeclared identifier" },
      { severity: 'warning', message: 'precision not specified' },
    ])
    expect(error.message).toBe(
      'Filter "demo": shader "fx" does not compile:\n  line 3: \'foo\' : undeclared identifier\n  precision not specified',
    )
    expect(error.src).toBe('fx')
    expect(error.details).toHaveLength(2)
  })

  it('GpuContextLostError names the filter disabled', () => {
    const error = new GpuContextLostError('demo')
    expect(error.filter).toBe('demo')
    expect(error.message).toBe('Filter "demo" was disabled: the GPU context was lost while its shader was drawn (spec §11).')
  })

  it('disposedError says what was disposed', () => {
    expect(disposedError('The engine').message).toBe('The engine has been disposed.')
  })
})

describe('withParamErrors', () => {
  it('returns the value of the function', () => {
    expect(withParamErrors('demo', () => 42)).toBe(42)
  })

  it('turns a ParamError into an InvalidParamError naming the filter', () => {
    const cause = new ParamError('range', 'size must be at most 2, got 3', { param: 'size', preset: 'big' })
    const error = thrown(() =>
      withParamErrors('demo', () => {
        throw cause
      }),
    ) as InvalidParamError
    expect(error).toBeInstanceOf(InvalidParamError)
    expect(error.message).toBe('Filter "demo": size must be at most 2, got 3')
    expect(error.param).toBe('size')
    expect(error.preset).toBe('big')
    expect(error.reason).toBe('range')
    expect(error.cause).toBe(cause)
  })

  it('lets any other error through unchanged', () => {
    const other = new TypeError('not a param error')
    expect(
      thrown(() =>
        withParamErrors('demo', () => {
          throw other
        }),
      ),
    ).toBe(other)
  })
})
