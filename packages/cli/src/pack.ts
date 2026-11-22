/**
 * `ouaf pack`: builds a `.ouaf` package from a filter folder (spec §3, §3.1, §12.2).
 *
 * A source folder holds `filter.js` or `filter.ts`, whose default export is the manifest data plus the script
 * functions and initial state, and an optional `assets/` folder. The packer:
 *
 * 1. bundles `filter.js` with Rolldown (TypeScript, relative and npm imports), the bundler of the Vite playground, so
 *    that a packed filter is compiled as in dev mode. The bundle is written once as an ES module without `import`,
 *    `script.js`, and once as a classic script for step 2. `import { defineFilter } from '@ouaf/spec'` is replaced
 *    by the identity function, so the format library is not bundled;
 * 2. runs the classic script once, in a `node:vm` context without Node APIs (no `require`, `process`, file system or
 *    network) and with a time limit, and reads its default export;
 * 3. separates the data (`manifest.json`, with the `ouaf` field and the `script` section filled in) from the functions
 *    (`setup`, `update`, `on`, `draw`) and the `state`, which stay in `script.js`;
 * 4. zips `manifest.json`, `script.js` and `assets/` deterministically, then validates the archive exactly as
 *    `ouaf validate` does: nothing is written when it has errors.
 *
 * `script.js` is the whole bundle of `filter.js`, data included: functions keep their closures, module-level helpers
 * and `this`, so the packed filter behaves as the source does. The engine ignores the other keys of its export.
 *
 * A folder that already holds a `manifest.json` (and no `filter.js`) is packed as it is.
 *
 * `node:vm` is not a security boundary: the run keeps the author's own code away from Node APIs by accident, not
 * against an attacker. Pack only filters you trust, as you would run their build scripts.
 */
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { rolldown, type Plugin, type RollupLog } from 'rolldown'
import { validatePackage, type PackageIssue, type PackageReport, type ValidateOptions } from './validate.ts'
import { zipSource } from './source.ts'
import { writeZip, type ZipInput } from './zip.ts'

/** Source files of a filter, in lookup order. */
export const FILTER_ENTRIES = ['filter.ts', 'filter.js'] as const
/** Keys of the `filter.js` export that go to `script.js` (spec §12.2); every other key is manifest data. */
export const SCRIPT_KEYS = ['state', 'setup', 'update', 'on', 'draw'] as const
/** The one-time run of `filter.js` is stopped after this delay (ms). */
export const RUN_TIMEOUT_MS = 2000

export interface FilterPackOptions extends ValidateOptions {
  /** Label of the output, for messages (the output path). */
  label?: string
}

export interface FilterPackResult {
  /** The validation report of the package; with `filter.js`, manifest issues point to it (JSON pointers). */
  report: PackageReport
  /** `filter.ts` / `filter.js`, or undefined for a folder packed from its `manifest.json`. */
  entry?: string
  /** The archive, when the package has no errors. */
  zip?: Uint8Array
  /** Files of the package, in archive order. */
  files: string[]
  /** Hidden files under `assets/` (".DS_Store", ".gitkeep"…), left out of the package. */
  hidden: string[]
}

/** The input cannot be packed at all (missing folder, nothing to pack): a usage error. */
export class PackSourceError extends Error {}

/** Issues found before validation, about the source folder. */
interface Problems {
  entry: string
  errors: PackageIssue[]
  warnings: PackageIssue[]
}

const issue = (severity: 'error' | 'warning', code: string, file: string, path: string, message: string, hint?: string, line?: number, column?: number): PackageIssue => ({
  severity, code, file, path, message, ...(hint ? { hint } : {}), ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}),
})

const pointer = (parent: string, key: string | number) => `${parent}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`

// ---------------------------------------------------------------------------------------------
// Source folder

/** Finds what to pack: `filter.ts` / `filter.js`, or `manifest.json`. Throws PackSourceError. */
async function findEntry(dir: string): Promise<{ entry?: string }> {
  let st
  try {
    // Following a link given on the command line is fine; links inside the folder are reported.
    st = await stat(dir)
  } catch {
    throw new PackSourceError(`${dir}: no such folder.`)
  }
  if (!st.isDirectory()) throw new PackSourceError(`${dir}: not a folder (ouaf pack takes the filter folder; ouaf validate checks a .ouaf file).`)
  const names = new Set(await readdir(dir))
  const entries = FILTER_ENTRIES.filter((n) => names.has(n))
  if (entries.length > 1) throw new PackSourceError(`${dir}: both filter.ts and filter.js are present; keep one.`)
  if (entries[0] && names.has('manifest.json')) {
    throw new PackSourceError(`${dir}: both ${entries[0]} and manifest.json are present; ouaf pack writes manifest.json from ${entries[0]}, remove one of them.`)
  }
  if (entries[0]) return { entry: entries[0] }
  if (names.has('manifest.json')) return {}
  throw new PackSourceError(`${dir}: no filter.ts, filter.js or manifest.json in this folder.`)
}

/** Collects `assets/`: regular files only, hidden files left out, links and special files reported. */
async function collectAssets(dir: string, problems: PackageIssue[]): Promise<{ files: string[]; hidden: string[] }> {
  const files: string[] = []
  const hidden: string[] = []
  const walk = async (abs: string): Promise<void> => {
    for (const d of await readdir(abs, { withFileTypes: true })) {
      const full = join(abs, d.name)
      const path = relative(dir, full).split(sep).join('/')
      if (d.name.startsWith('.')) {
        hidden.push(d.isDirectory() ? `${path}/` : path)
        continue
      }
      if (d.isSymbolicLink()) {
        problems.push(issue('error', 'symlink', path, '', `"${path}" is a symbolic link: packages MUST NOT contain links (spec §3), and ouaf pack does not follow them.`,
          'Replace the link with a copy of the file.'))
      } else if (d.isDirectory()) await walk(full)
      else if (d.isFile()) files.push(path)
      else problems.push(issue('error', 'not-a-file', path, '', `"${path}" is not a regular file.`, 'Remove it from assets/.'))
    }
  }
  let st
  try {
    st = await lstat(join(dir, 'assets'))
  } catch {
    return { files, hidden }
  }
  if (st.isSymbolicLink()) {
    problems.push(issue('error', 'symlink', 'assets', '', '"assets" is a symbolic link: packages MUST NOT contain links (spec §3), and ouaf pack does not follow them.',
      'Make assets/ a real folder.'))
  } else if (st.isDirectory()) await walk(join(dir, 'assets'))
  else problems.push(issue('error', 'not-a-file', 'assets', '', '"assets" is not a folder.', 'Asset files live under assets/ (spec §3).'))
  // Code-unit order: the same on every platform and locale.
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  hidden.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { files, hidden }
}

// ---------------------------------------------------------------------------------------------
// filter.js → script.js + manifest data

/** `@ouaf/spec` at run time: only `defineFilter`, the identity function (spec §12.3); the types are erased. */
const SPEC_SHIM = 'ouaf:spec'
const specShim: Plugin = {
  name: 'ouaf-spec',
  resolveId: (id) => (id === '@ouaf/spec' ? SPEC_SHIM : undefined),
  load: (id) => (id === SPEC_SHIM ? 'export function defineFilter(def) { return def }\n' : undefined),
}

/** Name of the default export's holder in the classic script run by `evaluate`. */
const GLOBAL = '__ouafFilter'

/** The two outputs of one bundle: `script.js` and the same code as a classic script, for `node:vm`. */
interface Bundle {
  module: string
  classic: string
}

/** A Rolldown log as an issue: first line of its message, without the colors and the `[CODE]` prefix. */
function buildIssue(dir: string, p: Problems, log: RollupLog, severity: 'error' | 'warning'): PackageIssue {
  // eslint-disable-next-line no-control-regex
  const text = log.message.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0]!.replace(/^\[[A-Z_]+\]\s*/, '')
  const file = log.loc?.file ?? log.id
  const path = file ? relative(resolve(dir), file).split(sep).join('/') : p.entry
  return issue(severity, severity === 'error' ? 'build-error' : 'build-warning', path, '', text, undefined,
    log.loc ? log.loc.line : undefined, log.loc ? log.loc.column + 1 : undefined)
}

/**
 * Bundles `filter.js` into a self-contained module. An import that cannot be bundled (a Node built-in, a package that
 * is not installed) is an error: the script runs in a Worker (spec §12.1) and `script.js` has no `import`.
 */
async function bundle(dir: string, p: Problems): Promise<Bundle | undefined> {
  const logs: { level: 'error' | 'warning'; log: RollupLog }[] = []
  const report = () => {
    // Each `generate` logs the same problems again: report each one once.
    const seen = new Set<string>()
    for (const { level, log } of logs) {
      const i = buildIssue(dir, p, log, level)
      const key = JSON.stringify([i.file, i.line, i.column, i.message])
      if (seen.has(key)) continue
      seen.add(key)
      ;(level === 'error' ? p.errors : p.warnings).push(i)
    }
  }
  const built = await rolldown({
    input: p.entry,
    cwd: resolve(dir),
    // Browser resolution of npm packages, no Node built-ins.
    platform: 'browser',
    transform: { target: 'es2022' },
    plugins: [specShim],
    onLog: (level, log) => {
      if (level === 'debug' || level === 'info') return
      logs.push({ level: log.code === 'UNRESOLVED_IMPORT' ? 'error' : 'warning', log })
    },
  })
  try {
    // The build runs at the first `generate`; the second one reuses it.
    const banner = `// Generated by ouaf pack from ${p.entry} (spec §12.2). Do not edit: edit ${p.entry} and pack again.`
    // The banner is added here: Rolldown 1.2 drops `output.banner` when the first module is the `@ouaf/spec` shim.
    const module = await built.generate({ format: 'esm', codeSplitting: false })
    const classic = await built.generate({ format: 'iife', codeSplitting: false, name: GLOBAL, exports: 'named' })
    report()
    if (logs.some((l) => l.level === 'error')) return undefined
    return { module: `${banner}\n${module.output[0].code}`, classic: classic.output[0].code }
  } catch (e) {
    const errors = (e as { errors?: RollupLog[] }).errors
    if (!Array.isArray(errors)) throw e
    for (const log of errors) p.errors.push(buildIssue(dir, p, log, 'error'))
    report()
    return undefined
  } finally {
    await built.close()
  }
}

/** Runs the bundle once, without Node APIs, and returns its default export. */
async function evaluate(code: Bundle, p: Problems): Promise<unknown> {
  // The same bundle as script.js, as a classic script: node:vm runs ES modules only behind a flag.
  const logs: string[] = []
  const log = (...args: unknown[]) => void logs.push(args.map(String).join(' '))
  const context = createContext({ console: { log, info: log, warn: log, error: log, debug: log } }, {
    name: `ouaf pack: ${p.entry}`,
    codeGeneration: { strings: false, wasm: false },
  })
  try {
    runInContext(code.classic, context, { filename: p.entry, timeout: RUN_TIMEOUT_MS })
  } catch (e) {
    const timeout = (e as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
    p.errors.push(issue('error', 'run-error', p.entry, '',
      timeout ? `${p.entry} did not finish within ${RUN_TIMEOUT_MS} ms when run to read its export.` : `${p.entry} threw when run to read its export: ${describe(e)}`,
      timeout
        ? 'The top level of filter.js runs once at pack time: keep loops and heavy work in setup or update.'
        : 'The top level of filter.js runs once at pack time, without browser or Node APIs (no document, fetch, process).'))
    return undefined
  }
  for (const l of logs) p.warnings.push(issue('warning', 'console', p.entry, '', `console output while packing: ${l}`, 'Remove top-level console calls.'))
  const ns = (context as Record<string, unknown>)[GLOBAL] as { default?: unknown } | undefined
  if (!ns || ns.default === undefined) {
    p.errors.push(issue('error', 'no-default-export', p.entry, '', `${p.entry} has no default export.`,
      'export default defineFilter({ id, name, version, license, requires, layers, … }) (spec §3.1).'))
    return undefined
  }
  return ns.default
}

function describe(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const name = (e as { name?: unknown }).name
    return `${typeof name === 'string' ? `${name}: ` : ''}${String((e as { message: unknown }).message)}`
  }
  return String(e)
}

/** A plain object of any realm (the run happens in another one): `{}`, `Object.create(null)`. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as object | null
  return proto === null || (Object.getPrototypeOf(proto) === null && (proto as { constructor?: { name?: string } }).constructor?.name === 'Object')
}

const SKIP = Symbol('skip')

/**
 * Reports the getters and setters of `obj`. Reading one would run the author's code again, after the run's time
 * limit: a getter that never returns would hang the packer. Data is plain values anyway.
 */
function hasAccessors(obj: object, path: string, p: Problems): boolean {
  let found = false
  for (const key of Object.keys(obj)) {
    const d = Object.getOwnPropertyDescriptor(obj, key)
    if (!d || 'value' in d) continue
    p.errors.push(issue('error', 'accessor-in-data', p.entry, pointer(path, key), `"${key}" is a getter or setter: data is plain values.`,
      'Write the value itself; compute it in setup or update if it depends on the frame.'))
    found = true
  }
  return found
}

/** Converts manifest data to JSON values, reporting what JSON cannot hold (functions, NaN, class instances…). */
function toJson(value: unknown, path: string, p: Problems, parents: unknown[]): unknown {
  const fail = (code: string, message: string, hint?: string) => {
    p.errors.push(issue('error', code, p.entry, path, message, hint))
    return SKIP
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : fail('not-json', `${value} is not a JSON number.`)
    case 'undefined':
      return SKIP
    case 'function':
      return fail('function-in-data', 'A function is only allowed as setup, update, on.<event> or draw.<layer id> (spec §3.1, §12.3).',
        'Move the logic into an event handler, update or a draw function; data stays plain values.')
    case 'bigint':
    case 'symbol':
      return fail('not-json', `A ${typeof value} cannot be written to manifest.json.`)
  }
  if (value === null) return null
  if (parents.includes(value)) return fail('cycle', 'This value contains itself: manifest data must be a tree.')
  const next = [...parents, value]
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i]
      if (item === undefined) {
        fail('not-json', `${pointer(path, i)}: undefined in a list (JSON would write null).`)
        continue
      }
      const v = toJson(item, pointer(path, i), p, next)
      if (v !== SKIP) out.push(v)
    }
    return out
  }
  if (!isPlainObject(value)) {
    const name = (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'object'
    return fail('not-json', `A ${name} cannot be written to manifest.json: data is made of objects, lists, strings, numbers, booleans and null.`)
  }
  if (hasAccessors(value, path, p)) return SKIP
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const v = toJson(value[key], pointer(path, key), p, next)
    if (v !== SKIP) out[key] = v
  }
  return out
}

/** Separates the export of `filter.js` into the manifest (with `ouaf` and `script` filled in) and the script keys. */
function split(def: unknown, p: Problems): Record<string, unknown> | undefined {
  if (!isPlainObject(def)) {
    p.errors.push(issue('error', 'not-an-object', p.entry, '', `The default export of ${p.entry} must be an object.`,
      'export default defineFilter({ id, name, version, license, requires, layers, … }) (spec §3.1).'))
    return undefined
  }
  if (hasAccessors(def, '', p)) return undefined
  for (const key of ['on', 'draw'] as const) {
    const v = def[key]
    if (isPlainObject(v) && hasAccessors(v, `/${key}`, p)) return undefined
  }
  const script: Record<string, unknown> = { entry: 'script.js' }
  let functions = 0
  for (const key of ['setup', 'update'] as const) {
    const v = def[key]
    if (v === undefined) continue
    if (typeof v === 'function') {
      script[key] = true
      functions++
    } else p.errors.push(issue('error', 'not-a-function', p.entry, `/${key}`, `"${key}" must be a function.`))
  }
  for (const key of ['on', 'draw'] as const) {
    const v = def[key]
    if (v === undefined) continue
    if (!isPlainObject(v)) {
      p.errors.push(issue('error', 'not-an-object', p.entry, `/${key}`,
        key === 'on' ? '"on" must be an object of event handlers: { smile(f, { face }) { … } }.' : '"draw" must be an object of draw functions by canvas layer id.'))
      continue
    }
    const names: string[] = []
    for (const [name, fn] of Object.entries(v)) {
      if (fn === undefined) continue
      if (typeof fn === 'function') names.push(name)
      else p.errors.push(issue('error', 'not-a-function', p.entry, pointer(`/${key}`, name), `"${key}.${name}" must be a function.`))
    }
    if (names.length) {
      script[key] = names
      functions += names.length
    }
  }
  if (typeof def.state === 'function') p.errors.push(issue('error', 'not-plain-data', p.entry, '/state', '"state" is the initial state: plain data, not a function.'))

  const authored = def.script
  if (authored !== undefined) {
    if (!isPlainObject(authored)) {
      p.errors.push(issue('error', 'script-section', p.entry, '/script', '"script" must be an object: { uses: [...] }.'))
    } else {
      for (const key of Object.keys(authored)) {
        if (key === 'uses') continue
        p.errors.push(issue('error', 'script-section', p.entry, pointer('/script', key), `"script.${key}" is filled in by ouaf pack from the functions of ${p.entry}.`,
          'Only "script.uses" is written by hand (spec §12.2); remove this key.'))
      }
      if (authored.uses !== undefined) {
        const uses = toJson(authored.uses, '/script/uses', p, [])
        if (uses !== SKIP) {
          if (functions) script.uses = uses
          else p.warnings.push(issue('warning', 'unused-script-uses', p.entry, '/script/uses', '"script.uses" is ignored: the filter has no script functions.'))
        }
      }
    }
  }

  const manifest: Record<string, unknown> = { ouaf: '1' }
  for (const [key, value] of Object.entries(def)) {
    if ((SCRIPT_KEYS as readonly string[]).includes(key) || key === 'script') continue
    const v = toJson(value, pointer('', key), p, [def])
    if (v !== SKIP) manifest[key] = v
  }
  if (functions) manifest.script = script
  return manifest
}

// ---------------------------------------------------------------------------------------------
// Package

/** Moves the validator's manifest issues onto `filter.js` (manifest.json is generated, its lines mean nothing). */
function onSource(i: PackageIssue, entry: string | undefined): PackageIssue {
  if (!entry || (i.file !== 'manifest.json' && i.file !== 'script.js')) return i
  const { line: _line, column: _column, ...rest } = i
  return { ...rest, file: entry }
}

/** Builds and validates the package of a filter folder. Throws PackSourceError when there is nothing to pack. */
export async function packFolder(dir: string, options: FilterPackOptions = {}): Promise<FilterPackResult> {
  const { entry } = await findEntry(dir)
  const p: Problems = { entry: entry ?? 'manifest.json', errors: [], warnings: [] }
  const files = new Map<string, Uint8Array>()
  const enc = new TextEncoder()

  if (entry) {
    const code = await bundle(dir, p)
    const def = code === undefined ? undefined : await evaluate(code, p)
    const manifest = def === undefined ? undefined : split(def, p)
    if (manifest) {
      files.set('manifest.json', enc.encode(`${JSON.stringify(manifest, null, 2)}\n`))
      if (manifest.script) files.set('script.js', enc.encode(code!.module))
    }
  } else {
    for (const name of ['manifest.json', 'script.js']) {
      const st = await lstat(join(dir, name)).catch(() => undefined)
      if (!st) continue
      if (st.isFile()) files.set(name, new Uint8Array(await readFile(join(dir, name))))
      else {
        p.errors.push(st.isSymbolicLink()
          ? issue('error', 'symlink', name, '', `"${name}" is a symbolic link: packages MUST NOT contain links (spec §3), and ouaf pack does not follow them.`, 'Replace the link with a copy of the file.')
          : issue('error', 'not-a-file', name, '', `"${name}" is not a regular file.`))
      }
    }
  }
  const assets = await collectAssets(dir, p.errors)
  for (const path of assets.files) files.set(path, new Uint8Array(await readFile(join(dir, ...path.split('/')))))

  const order = [...files.keys()]
  const zipInput: ZipInput[] = order.map((path) => ({ path, data: files.get(path)! }))
  const failed = (): FilterPackResult => ({
    report: {
      input: dir, kind: 'folder', ok: false, errors: p.errors, warnings: p.warnings, skipped: [],
      stats: { files: order.length, bytes: zipInput.reduce((n, f) => n + f.data.length, 0) },
    },
    ...(entry ? { entry } : {}),
    files: order,
    hidden: assets.hidden,
  })
  if (p.errors.length) return failed()

  // Validate the archive itself: what is written is exactly what `ouaf validate` and the engine read.
  const zip = writeZip(zipInput)
  const checked = await validatePackage(zipSource(zip, options.label ?? 'package.ouaf'), options)
  const errors = [...p.errors, ...checked.errors.map((i) => onSource(i, entry))]
  const warnings = [...p.warnings, ...checked.warnings.map((i) => onSource(i, entry))]
  // Issues name files of the folder (assets/… are at the same path), so report against it.
  const report: PackageReport = { ...checked, input: dir, kind: 'folder', ok: errors.length === 0, errors, warnings }
  return { report, ...(entry ? { entry } : {}), ...(report.ok ? { zip } : {}), files: order, hidden: assets.hidden }
}
