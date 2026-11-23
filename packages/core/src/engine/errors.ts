/**
 * Errors raised by the engine's public API. Every error has a stable `code` (for hosts and tests) and an actionable
 * message; nothing is fixed silently (spec §9: invalid values are rejected, never corrected).
 */
import type { Issue, PackageProblemCode, ZipErrorCode } from '@ouaf/spec'
import { ParamError, type ParamErrorCode } from '../params/errors.ts'

export type OuafErrorCode =
  | 'invalid-manifest'
  | 'incompatible-engine'
  | 'missing-plugin'
  | 'plugin-conflict'
  | 'unknown-layer-type'
  | 'incompatible-source'
  | 'asset'
  | 'invalid-param'
  | 'filter-load'
  /** A `.ouaf` package breaks a package rule (spec §3): see `PackageError.reason`. */
  | 'invalid-package'
  | 'shader'
  | 'gpu-context-lost'
  | 'disposed'
  /** The browser lacks what an output needs (`MediaRecorder`, a codec, `captureStream` in a worker). */
  | 'unsupported'
  /** A filter's script could not start (sandbox, `script.js`). */
  | 'script'
  /** A filter's script did not answer within 1 s and was stopped (spec §12.7); the rest of the filter keeps working. */
  | 'SCRIPT_STOPPED'

export class OuafError extends Error {
  override name = 'OuafError'
  readonly code: OuafErrorCode

  constructor(code: OuafErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

/** The manifest does not pass `validateManifest` (with the plugins installed on this engine). */
export class InvalidManifestError extends OuafError {
  override name = 'InvalidManifestError'
  /** Errors reported by the validator (JSON pointer, message, hint). */
  readonly issues: readonly Issue[]
  /** Where the manifest came from (URL or label), for messages. */
  readonly source: string

  constructor(source: string, issues: readonly Issue[], message: string) {
    super('invalid-manifest', message)
    this.issues = issues
    this.source = source
  }
}

/**
 * Why a `.ouaf` package is refused: the issue codes of `ouaf validate` for the same problems (`zip-invalid`: not a
 * zip, or a corrupt entry; `zip-unsupported`: ZIP64, encryption, a compression method other than store and deflate).
 */
export type PackageErrorReason = ZipErrorCode | PackageProblemCode | 'missing-manifest'

/**
 * A `.ouaf` package breaks a package rule (spec §3, §15.4): not a readable zip, a link or special entry, an unsafe
 * path, a duplicate entry, too many entries or too large, no `manifest.json`, or an entry whose data is corrupt (size
 * or CRC-32, or one that inflates past its declared size). A corrupt asset file reaches the host as the `cause` of an
 * `AssetError`.
 */
export class PackageError extends OuafError {
  override name = 'PackageError'
  readonly reason: PackageErrorReason
  /** The entry concerned (`assets/hat.png`); empty for the package as a whole. */
  readonly path: string
  /** Where the package came from (URL, file name or label), for messages. */
  readonly source: string

  constructor(source: string, reason: PackageErrorReason, path: string, message: string, options?: { cause?: unknown }) {
    super('invalid-package', `Invalid filter package ${source}: ${message}`, options)
    this.reason = reason
    this.path = path
    this.source = source
  }
}

/** The filter's `engine` range excludes this engine's version (spec §17). */
export class IncompatibleEngineError extends OuafError {
  override name = 'IncompatibleEngineError'
  readonly range: string
  readonly engineVersion: string

  constructor(filterId: string, range: string, engineVersion: string) {
    super('incompatible-engine', `Filter "${filterId}" requires engine ${range}; this engine is ${engineVersion}.`)
    this.range = range
    this.engineVersion = engineVersion
  }
}

/** A plugin listed in `requires.plugins` is not installed, or its version is out of range (spec §4.1). */
export class MissingPluginError extends OuafError {
  override name = 'MissingPluginError'
  readonly plugin: string
  readonly range: string | undefined
  /** Version installed on this engine, when the plugin is present but out of range. */
  readonly installed: string | undefined

  constructor(filterId: string, plugin: string, range: string | undefined, installed: string | undefined) {
    const wanted = range ? `${plugin}@${range}` : plugin
    super(
      'missing-plugin',
      installed === undefined
        ? `Filter "${filterId}" requires plugin "${wanted}", which is not installed. The host must call engine.use() with it.`
        : `Filter "${filterId}" requires plugin "${wanted}", but version ${installed} is installed.`,
    )
    this.plugin = plugin
    this.range = range
    this.installed = installed
  }
}

/** The source cannot be used by the engine (no frames, tainted canvas, the engine's own canvas…). */
export class IncompatibleSourceError extends OuafError {
  override name = 'IncompatibleSourceError'

  constructor(message: string, options?: { cause?: unknown }) {
    super('incompatible-source', message, options)
  }
}

/** An asset could not be resolved, fetched, checked or decoded. */
export class AssetError extends OuafError {
  override name = 'AssetError'
  /** The reference as written in the manifest (`hat`, `assets/hat.glb`, `builtin:lut/noir`). */
  readonly ref: string

  constructor(ref: string, message: string, options?: { cause?: unknown }) {
    super('asset', message, options)
    this.ref = ref
  }
}

/** A parameter value was rejected (type, bounds, unknown option or param, invalid preset). */
export class InvalidParamError extends OuafError {
  override name = 'InvalidParamError'
  /** Parameter concerned, when there is one. */
  readonly param: string | undefined
  /** Preset concerned, when the value comes from a preset. */
  readonly preset: string | undefined
  /** Why the value was rejected (`range`, `type`, `enum`, `unknown-param`…, see `ParamErrorCode`). */
  readonly reason: ParamErrorCode | undefined

  constructor(message: string, details: { param?: string | undefined; preset?: string | undefined; reason?: ParamErrorCode | undefined; cause?: unknown } = {}) {
    super('invalid-param', message, details.cause === undefined ? undefined : { cause: details.cause })
    this.param = details.param
    this.preset = details.preset
    this.reason = details.reason
  }
}

/** A diagnostic of the GLSL compiler, with its line in the author's file (spec §11). */
export interface ShaderErrorDetail {
  severity: 'error' | 'warning'
  /** Line in the shader file (1-based), when the message points at one. */
  line?: number
  message: string
}

/**
 * A shader layer's GLSL does not compile or link (spec §11), or its declarations cannot become GLSL. Lines are
 * counted in the author's file, without the engine's wrapper.
 */
export class ShaderCompileError extends OuafError {
  override name = 'ShaderCompileError'
  /** The `src` reference of the layer (asset name or `assets/…` path). */
  readonly src: string
  readonly details: readonly ShaderErrorDetail[]

  constructor(filterId: string, src: string, details: readonly ShaderErrorDetail[], options?: { cause?: unknown }) {
    const lines = details.map((d) => `  ${d.line !== undefined ? `line ${d.line}: ` : ''}${d.message}`)
    super('shader', `Filter "${filterId}": shader "${src}" does not compile:\n${lines.join('\n')}`, options)
    this.src = src
    this.details = details
  }
}

/**
 * The GPU context was lost while a filter's shader was being drawn (spec §11, §15.5): the engine disabled that
 * filter. Emitted on `engine.on('error')`; the host may re-enable it (`handle.enabled = true`) or remove it.
 */
export class GpuContextLostError extends OuafError {
  override name = 'GpuContextLostError'
  /** The filter disabled (manifest id). */
  readonly filter: string

  constructor(filterId: string) {
    super('gpu-context-lost', `Filter "${filterId}" was disabled: the GPU context was lost while its shader was drawn (spec §11).`)
    this.filter = filterId
  }
}

/** Runs `fn`, turning a `ParamError` of the params store into the public `InvalidParamError`. */
export function withParamErrors<T>(filterId: string, fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof ParamError) {
      throw new InvalidParamError(`Filter "${filterId}": ${error.message}`, { param: error.param, preset: error.preset, reason: error.code, cause: error })
    }
    throw error
  }
}

export function disposedError(what: string): OuafError {
  return new OuafError('disposed', `${what} has been disposed.`)
}
