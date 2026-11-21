/**
 * Errors raised by the engine's public API. Every error has a stable `code` (for hosts and tests) and an actionable
 * message; nothing is fixed silently (spec §9: invalid values are rejected, never corrected).
 */
import type { Issue } from '@ouaf/spec'

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
  | 'disposed'

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
  readonly param: string

  constructor(param: string, message: string) {
    super('invalid-param', message)
    this.param = param
  }
}

export function disposedError(what: string): OuafError {
  return new OuafError('disposed', `${what} has been disposed.`)
}
