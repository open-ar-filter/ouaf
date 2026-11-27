/**
 * What `ouaf preview` changes in the filters it renders, without editing them (#197): parameter values
 * (`--param <name>=<value>`), given to the engine as a host would, and event thresholds (`--event-threshold
 * <event>=<value>`), written into the `events` section of the manifest of the package rendered (spec §13).
 *
 * Node only; the page receives the parameter values and the rewritten packages.
 */
import { checkParamValue, ParamError, type SelectOptions } from '@ouaf/core'
import { createRegistry, findEvent, type TManifest, type TParamDef } from '@ouaf/spec'
import { readZipEntries, readZipEntry, writeZip } from '../zip.ts'
import { SIGNAL_OF_EVENT } from './protocol.ts'

/** A value the user gave on the command line that does not fit the filters: a usage error. */
export class TuningError extends Error {}

/** `name=value` arguments of a repeatable option, in order; a name given twice is an error. */
export function parseAssignments(option: string, args: readonly string[] | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const arg of args ?? []) {
    const eq = arg.indexOf('=')
    const name = eq < 0 ? '' : arg.slice(0, eq).trim()
    if (!name) throw new TuningError(`--${option} expects <name>=<value>, got "${arg}".`)
    if (out.has(name)) throw new TuningError(`--${option}: "${name}" is given twice.`)
    out.set(name, arg.slice(eq + 1))
  }
  return out
}

/** The text of a command-line value as the JavaScript value the parameter takes (checked afterwards). */
function parseParamText(def: TParamDef, text: string): unknown {
  switch (def.type) {
    case 'number':
      return text.trim() === '' ? text : Number(text)
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : text
    case 'vec2':
    case 'vec3':
      return text.split(',').map((c) => (c.trim() === '' ? NaN : Number(c)))
    default:
      return text
  }
}

const EXPECTS: Partial<Record<TParamDef['type'], string>> = {
  boolean: ' (true or false)',
  vec2: ' (two numbers separated by a comma: 0.1,0.2)',
  vec3: ' (three numbers separated by commas: 0,0.1,0)',
}

/**
 * The values of `--param` for each filter of the stack, in order: a parameter is set on every filter that declares
 * it, checked as the engine checks a host's value (spec §9: never fixed). Throws `TuningError` when no filter
 * declares a name or a value is invalid.
 */
export function resolveParams(manifests: readonly TManifest[], params: ReadonlyMap<string, string>): Array<Record<string, unknown>> {
  const out = manifests.map(() => ({}) as Record<string, unknown>)
  for (const [name, text] of params) {
    let found = false
    for (const [i, manifest] of manifests.entries()) {
      const def = manifest.params?.[name]
      if (!def) continue
      found = true
      if (def.type === 'asset') throw new TuningError(`--param ${name}: asset parameters cannot be set from the command line.`)
      const options: SelectOptions | undefined = def.type === 'select' && !('from' in def.options)
        ? new Map(Object.entries(def.options))
        : undefined
      try {
        out[i]![name] = checkParamValue(name, def, parseParamText(def, text), options)
      } catch (e) {
        if (e instanceof ParamError) throw new TuningError(`--param ${name}=${text}: ${manifest.id}: ${e.message}${EXPECTS[def.type] ?? ''}`)
        throw e
      }
    }
    if (!found) {
      const declared = [...new Set(manifests.flatMap((m) => Object.keys(m.params ?? {})))]
      throw new TuningError(`--param ${name}: no filter of the stack declares this parameter (${declared.length ? `parameters: ${declared.join(', ')}` : 'no parameters'}).`)
    }
  }
  return out
}

const registry = createRegistry()

/** Events whose threshold the manifest can tune (spec §13), with their default. */
const TUNABLE = new Map([...registry.events.values()].filter((e) => e.tunable && e.threshold !== undefined).map((e) => [e.name, e.threshold!]))

/** Checks the values of `--event-threshold`: tunable events, numbers from 0 to 1. */
export function parseEventThresholds(raw: ReadonlyMap<string, string>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [name, text] of raw) {
    if (!TUNABLE.has(name)) {
      const known = findEvent(registry, name) ? `"${name}" has no threshold of its own` : `unknown event "${name}"`
      throw new TuningError(`--event-threshold: ${known}. Events with a threshold: ${[...TUNABLE.keys()].join(', ')}.`)
    }
    const n = Number(text)
    if (text.trim() === '' || !Number.isFinite(n) || n < 0 || n > 1) {
      throw new TuningError(`--event-threshold ${name} expects a number from 0 to 1, got "${text}".`)
    }
    out.set(name, n)
  }
  return out
}

/** The manifest with `thresholds` written into its `events` section (other tuning kept). */
export function withEventThresholds(manifest: TManifest, thresholds: ReadonlyMap<string, number>): TManifest {
  if (!thresholds.size) return manifest
  const events: NonNullable<TManifest['events']> = { ...manifest.events }
  for (const [name, threshold] of thresholds) events[name] = { ...events[name], threshold }
  return { ...manifest, events }
}

/**
 * The threshold each event of `SIGNAL_OF_EVENT` that the filter's script handles fires at: its `events` tuning, else
 * the default of spec §13. Empty for a filter without script.
 */
export function handledThresholds(manifest: TManifest): Record<string, number> {
  const out: Record<string, number> = {}
  for (const name of manifest.script?.on ?? []) {
    if (!(name in SIGNAL_OF_EVENT)) continue
    out[name] = manifest.events?.[name]?.threshold ?? TUNABLE.get(name)!
  }
  return out
}

/** The `manifest.json` of a package (validated beforehand). */
export function readManifest(zip: Uint8Array): TManifest {
  const entry = readZipEntries(zip).find((e) => e.name === 'manifest.json')
  if (!entry) throw new Error('The package has no manifest.json.')
  return JSON.parse(new TextDecoder().decode(readZipEntry(zip, entry))) as TManifest
}

/** The package with another `manifest.json`, every other file kept, in order (directory entries dropped). */
export function replaceManifest(zip: Uint8Array, manifest: TManifest): Uint8Array {
  const files = readZipEntries(zip)
    .filter((e) => !e.name.endsWith('/'))
    .map((e) => ({
      path: e.name,
      data: e.name === 'manifest.json' ? new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) : readZipEntry(zip, e),
    }))
  return writeZip(files)
}
