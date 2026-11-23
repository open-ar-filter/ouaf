import { relative } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, UsageError, type Command } from '../command.ts'
import {
  DEFAULT_OUT_DIR,
  PREVIEW_MAX_SIZE,
  PreviewSetupError,
  previewFilters,
  type PreviewOptions,
  type PreviewResult,
} from '../preview.ts'
import { DEFAULT_REFERENCES, inputReference, loadReferences, ReferenceError, type Reference } from '../preview/references.ts'
import { formatReport, REPORT_FORMAT } from '../report.ts'

export interface PreviewDeps {
  /** Renders (default: `previewFilters`, headless Chromium); replaced in tests. */
  preview?: (options: PreviewOptions) => Promise<PreviewResult>
  /** Environment, for OUAF_MODELS (default: process.env). */
  env?: Record<string, string | undefined>
  /** Progress lines (default: none; the CLI prints them on stderr unless --json). */
  progress?: (text: string) => void
}

const HELP = `Usage: ouaf preview <filter>... [options]

Renders a filter, or a stack of filters (the first one at the bottom), on reference frames in headless Chromium and
writes one screenshot per reference, with perf stats. For humans and AI agents to see what a filter does.

  <filter>  a filter folder (filter.ts / filter.js, or manifest.json: packed in memory as ouaf pack does) or a .ouaf
            package. Each one is validated first; nothing is rendered when one has errors.

Each reference is rendered as the browser tests render the demos: every frame of the clip from "from" to "time" is
tracked then rendered (the file regime, spec §12.1), with media time and a fixed seed, in a fresh page. The
screenshot is the frame at "time", as the canvas shows it.

Inputs (default: every reference of test-media/references.json: talk, walk, two-faces, no-face):
  --ref <id>            Render only this reference of the set (repeatable)
  --references <file>   Another reference set (JSON, in the format of test-media/references.json)
  --input <file>        A clip (.mp4, .mov) or an image (.png, .jpg, .webp) instead of a reference set
  --at <s>              With a clip --input: media time of the screenshot (default 1)
  --from <s>            With a clip --input: first frame rendered (default: half a second before --at)
  --max-faces <n>       Faces tracked (default: the reference's maxFaces; 1 for --input)

Output:
  -o, --out <dir>       Folder of the screenshots, <reference>.png, replaced if they exist (default ${DEFAULT_OUT_DIR}/)
  --max-size <px>       Longer side of the screenshots (default ${PREVIEW_MAX_SIZE}; 0: the render size, 720×1280 for the
                        test clips)
  --seed <n>            Seed of random choices, 0 to 2^32 − 1 (default: the engine's fixed seed for files)
  --models <dir>        Face model folder (default: OUAF_MODELS, else apps/playground/models of the repository,
                        filled by npm run fetch-models)
  --json                Print the result as JSON (for tools and AI agents)
  --strict              Fail on warnings too
  -h, --help            Show this help

Determinism: Chromium renders with software WebGL (SwiftShader), so the same filters and inputs give the same
pixels on the same machine with the same Chromium build (Playwright version): compare "pixelsSha256". Another CPU,
OS or Chromium may differ slightly (tracking, video decoding, text rasterization): compare such images with a
tolerance, as the browser tests do (at most 1 % of the pixels beyond a YIQ distance of 0.2).

Perf stats (frame times, load time) are measured with software rendering: they compare filters with each other on
one machine, they do not predict a phone's frame rate.

Needs Playwright and its Chromium (npm install --save-dev playwright && npx playwright install chromium) and the face
model. Nothing is served on a port and the browser never reaches the network: every request is answered from the
local files, anything else is blocked.

Exit codes:
  0  rendered (warnings allowed without --strict)
  1  a filter has errors (nothing rendered), failed to load or reported an error while rendering (or a warning with
     --strict)
  2  usage error: bad arguments, a missing file, Playwright, Chromium or the face model missing`

const number = (name: string, value: string | undefined, check: (n: number) => boolean, expects: string) => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (value.trim() === '' || !Number.isFinite(n) || !check(n)) throw new UsageError(`--${name} expects ${expects}, got "${value}".`)
  return n
}

export function createPreview(deps: PreviewDeps = {}): Command {
  const render = deps.preview ?? previewFilters
  const env = deps.env ?? process.env
  const command: Command = {
    name: 'preview',
    summary: 'Render filters (a stack) on reference frames in headless Chromium: screenshots and perf stats',
    help: HELP,

    async run(args, io) {
      const { values, positionals } = (() => {
        try {
          return parseArgs({
            args,
            allowPositionals: true,
            options: {
              ref: { type: 'string', multiple: true },
              references: { type: 'string' },
              input: { type: 'string' },
              at: { type: 'string' },
              from: { type: 'string' },
              'max-faces': { type: 'string' },
              out: { type: 'string', short: 'o' },
              'max-size': { type: 'string' },
              seed: { type: 'string' },
              models: { type: 'string' },
              json: { type: 'boolean' },
              strict: { type: 'boolean' },
              help: { type: 'boolean', short: 'h' },
            },
          })
        } catch (e) {
          throw new UsageError((e as Error).message)
        }
      })()
      if (values.help) {
        io.out(HELP)
        return EXIT.OK
      }
      if (positionals.length === 0) throw new UsageError('Missing the filter folder or .ouaf file to preview.')
      const integer = (n: number) => Number.isInteger(n)
      const maxFaces = number('max-faces', values['max-faces'], (n) => integer(n) && n >= 1 && n <= 16, 'an integer from 1 to 16')
      const maxSize = number('max-size', values['max-size'], (n) => integer(n) && n >= 0, 'a number of pixels (0: the render size)')
      const seed = number('seed', values.seed, (n) => integer(n) && n >= 0 && n <= 0xffffffff, 'an integer from 0 to 2^32 − 1')
      const at = number('at', values.at, (n) => n >= 0, 'a time in seconds')
      const from = number('from', values.from, (n) => n >= 0, 'a time in seconds')

      let references: Reference[]
      try {
        if (values.input !== undefined) {
          if (values.ref || values.references) throw new UsageError('--input replaces the reference set: do not combine it with --ref or --references.')
          const options = { ...(at === undefined ? {} : { at }), ...(from === undefined ? {} : { from }), ...(maxFaces === undefined ? {} : { maxFaces }) }
          references = [inputReference(values.input, options)]
        } else {
          if (at !== undefined || from !== undefined) throw new UsageError('--at and --from apply to a clip given with --input.')
          references = await loadReferences(values.references ?? DEFAULT_REFERENCES)
          if (values.ref) {
            const unknown = values.ref.filter((id) => !references.some((r) => r.id === id))
            if (unknown.length) {
              const ids = unknown.map((id) => `"${id}"`).join(', ')
              throw new UsageError(`Unknown reference ${ids}. References: ${references.map((r) => r.id).join(', ')}.`)
            }
            references = references.filter((r) => values.ref!.includes(r.id))
          }
        }
      } catch (e) {
        if (e instanceof ReferenceError) throw new UsageError(e.message)
        throw e
      }

      const outDir = values.out ?? DEFAULT_OUT_DIR
      const progress = values.json ? undefined : deps.progress
      let result: PreviewResult
      try {
        result = await render({
          filters: positionals,
          references,
          outDir,
          ...(maxSize === undefined ? {} : { maxSize }),
          ...(seed === undefined ? {} : { seed }),
          ...(maxFaces === undefined ? {} : { maxFaces }),
          ...((values.models ?? env.OUAF_MODELS) ? { modelsDir: (values.models ?? env.OUAF_MODELS)! } : {}),
          ...(progress ? { onReference: (r: Reference, i: number) => progress(`[${i + 1}/${references.length}] ${r.id}…`) } : {}),
        })
      } catch (e) {
        if (e instanceof PreviewSetupError) throw new UsageError(e.hint ? `${e.message}\n${e.hint}` : e.message)
        throw e
      }

      const valid = result.filters.every((f) => f.report.ok)
      const rendered = valid && result.shots.every((s) => s.ok && s.errors.length === 0)
      const warnings = result.filters.some((f) => f.report.warnings.length) || result.shots.some((s) => s.warnings.length)
      const ok = rendered && !(values.strict && warnings)
      io.out(values.json ? json(result, references, outDir, ok) : text(result, references, outDir))
      return ok ? EXIT.OK : EXIT.FAILED
    },
  }
  return command
}

export const preview = createPreview({ progress: (text) => process.stderr.write(`${text}\n`) })

function json(r: PreviewResult, references: Reference[], outDir: string, ok: boolean): string {
  const renderer = r.shots.find((s) => s.ok)?.perf.renderer ?? null
  return JSON.stringify({
    format: REPORT_FORMAT,
    ok,
    filters: r.filters.map((f) => ({ ...f.report, input: f.input, ...(f.entry ? { entry: f.entry } : {}) })),
    outDir,
    browser: r.browser ? { name: 'chromium', version: r.browser, renderer } : null,
    references: r.shots.map((s, i) => {
      const ref = references[i]!
      const frames = ref.kind === 'video' ? { from: ref.from, time: ref.time } : { frames: ref.frames }
      const input = { input: relative('.', ref.file) || ref.file, kind: ref.kind, ...frames, maxFaces: ref.maxFaces }
      if (!s.ok) return { id: s.reference, ...input, ok: false, error: s.error, warnings: s.warnings, errors: s.errors }
      const { reference, ok: _, time: _time, ...shot } = s
      return { id: reference, ...input, ok: s.errors.length === 0, ...shot }
    }),
  }, null, 2)
}

const pct = (v: number) => `${(v * 100).toFixed(1)} %`

function text(r: PreviewResult, references: Reference[], outDir: string): string {
  const lines: string[] = []
  for (const f of r.filters) lines.push(formatReport(f.report))
  if (!r.filters.every((f) => f.report.ok)) {
    lines.push('Nothing rendered: fix the errors above.')
    return lines.join('\n')
  }
  const done = r.shots.filter((s) => s.ok)
  const ids = done[0]?.filters.join(' + ') ?? r.filters.map((f) => f.input).join(' + ')
  const software = /swiftshader/i.test(done[0]?.perf.renderer ?? '') ? ', SwiftShader' : ''
  const n = references.length
  const shots = `${done.length} screenshot${done.length === 1 ? '' : 's'}`
  lines.push(`${ids} on ${n} reference${n > 1 ? 's' : ''}: ${shots} in ${outDir}/ (Chromium ${r.browser ?? '?'}${software})`)
  const width = Math.max(...references.map((ref) => ref.id.length))
  const shotWidth = Math.max(0, ...done.map((s) => s.screenshot.length))
  const indent = (text: string) => text.replaceAll('\n', '\n      ')
  for (const s of r.shots) {
    const id = s.reference.padEnd(width)
    if (!s.ok) {
      lines.push(`  ${id}  failed: ${indent(s.error)}`)
    } else {
      const p = s.perf
      lines.push(`  ${id}  ${s.screenshot.padEnd(shotWidth)}  ${s.width}×${s.height}, ${s.faces} face${s.faces === 1 ? '' : 's'}, ` +
        `${pct(s.changed)} of the pixels changed; frame ${Math.round(p.frameMs.p50)} ms (p95 ${Math.round(p.frameMs.p95)}), first frame ${p.firstFrameMs} ms, ` +
        `load ${p.loadMs} ms`)
    }
    for (const e of s.errors) lines.push(`    error: ${indent(e)}`)
    for (const w of s.warnings) lines.push(`    warning: ${indent(w)}`)
  }
  return lines.join('\n')
}
