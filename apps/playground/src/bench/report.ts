/**
 * The benchmark page's results (#39): the `ouaf-bench` document (`docs/perf/bench-format.md`), its statistics, its
 * Markdown table and the comparison with an earlier document.
 */
import type { DeviceInfo } from '@ouaf/core'

export const BENCH_FORMAT = 'ouaf-bench'
export const BENCH_VERSION = 1

/** One measured case: a stack of filters on a test clip. */
export interface BenchCase {
  name: string
  /** A clip of `test-media/`. */
  clip: string
  maxFaces: number
  /** Filter URLs, bottom of the stack first. */
  filters: string[]
}

export interface Distribution {
  mean: number
  p50: number
  p95: number
  p99: number
  max: number
}

export interface CaseResult extends BenchCase {
  /** Frames measured (after the warm-up). */
  frames: number
  /** Time per frame (ms): tracking, rendering and the GPU finishing it; `null` without frames. */
  frameMs: Distribution | null
  /** Frames per second the device can render: `1000 / frameMs.mean`. */
  fps: number | null
  /** Mean number of faces drawn per frame. */
  faces: number
  /** Internal rendering size, `<width>×<height>`, from the engine's stats; `null` if none came. */
  size: string | null
  /** Tracker in use (`EngineStats.tracker`). */
  tracker: string | null
  errors: string[]
  warnings: string[]
}

export interface BenchReport {
  format: typeof BENCH_FORMAT
  version: typeof BENCH_VERSION
  /** ISO 8601, UTC. */
  startedAt: string
  durationMs: number
  app: { name: string; core: string; commit: string }
  device: DeviceInfo | null
  settings: { warmup: number; frames: number; backend: string | null }
  results: CaseResult[]
}

const round = (n: number) => Math.round(n * 1000) / 1000

/** Percentile `p` (0–1) of sorted values, interpolated between the closest ranks (NumPy's default). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const rank = p * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo)
}

export function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return { mean: round(mean), p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), p99: round(percentile(sorted, 0.99)), max: round(sorted.at(-1)!) }
}

/** The result of a case from its frame times (ms) and the faces drawn on each frame. */
export function caseResult(c: BenchCase, times: readonly number[], faces: readonly number[], extra: Pick<CaseResult, 'size' | 'tracker' | 'errors' | 'warnings'>): CaseResult {
  const frameMs = distribution(times)
  return {
    ...c,
    frames: times.length,
    frameMs,
    fps: frameMs && frameMs.mean > 0 ? round(1000 / frameMs.mean) : null,
    faces: faces.length ? round(faces.reduce((a, b) => a + b, 0) / faces.length) : 0,
    ...extra,
  }
}

/** Reads an `ouaf-bench` document; throws on another format or version. */
export function parseReport(text: string): BenchReport {
  const doc = JSON.parse(text) as Partial<BenchReport>
  if (doc.format !== BENCH_FORMAT) throw new Error(`Not an ${BENCH_FORMAT} file (format: ${JSON.stringify(doc.format)}).`)
  if (doc.version !== BENCH_VERSION) throw new Error(`${BENCH_FORMAT} version ${doc.version} is not supported (this page reads version ${BENCH_VERSION}).`)
  return doc as BenchReport
}

/** Relative change from `before` to `after` (+0.1 = 10 % more), `null` when either is missing. */
export function change(after: number | null | undefined, before: number | null | undefined): number | null {
  if (after == null || before == null || before === 0) return null
  return after / before - 1
}

export const percent = (r: number | null) => (r === null ? '' : `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(1)} %`)

const ms = (n: number | undefined) => (n === undefined ? '–' : n.toFixed(1))

/** One line about the device, for the table's caption. */
export function deviceLine(report: BenchReport): string {
  const d = report.device
  const ua = d?.userAgentData
  const model = ua?.model || ua?.platform || d?.platform || ''
  const gpu = d?.gpu?.unmaskedRenderer ?? d?.gpu?.renderer ?? ''
  const tracker = [...new Set(report.results.map((r) => r.tracker).filter((t): t is string => !!t))].join('; ')
  return [model, gpu, tracker && `tracker: ${tracker}`, `engine ${report.app.core} (${report.app.commit})`, report.startedAt.slice(0, 10)].filter(Boolean).join(' · ')
}

/** The results as a Markdown table, with the change against `previous` (matched by case name) when given. */
export function markdown(report: BenchReport, previous?: BenchReport): string {
  const before = new Map(previous?.results.map((r) => [r.name, r]))
  const head = ['Case', 'Faces', 'Mean ms', 'p95 ms', 'Max ms', 'fps', ...(previous ? ['fps change', 'p95 change'] : [])]
  const rows = report.results.map((r) => {
    const b = before.get(r.name)
    return [
      r.errors.length ? `${r.name} (error)` : r.name,
      r.faces.toFixed(1),
      ms(r.frameMs?.mean),
      ms(r.frameMs?.p95),
      ms(r.frameMs?.max),
      r.fps === null ? '–' : r.fps.toFixed(0),
      ...(previous ? [percent(change(r.fps, b?.fps)), percent(change(r.frameMs?.p95, b?.frameMs?.p95))] : []),
    ]
  })
  const line = (cells: readonly string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`
  return [
    `${deviceLine(report)}; ${report.settings.frames} frames per case after ${report.settings.warmup} of warm-up${previous ? `; changes against ${previous.startedAt.slice(0, 10)} (${previous.app.commit})` : ''}`,
    '',
    line(head),
    line(head.map((_, i) => (i === 0 ? '---' : '---:'))),
    ...rows.map(line),
  ].join('\n')
}
