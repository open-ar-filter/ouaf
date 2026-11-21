/**
 * Output of a validation report: human-readable lines (same shape as `formatIssues` of `@ouaf/spec`, with the file
 * location in front) or JSON for tools.
 */
import type { PackageIssue, PackageReport } from './validate.ts'

/** Version of the JSON output format; bumped on a breaking change. */
export const REPORT_FORMAT = 1

/** Where the user finds a package file: a path under the folder, or `pkg.ouaf!/path` inside a zip. */
export function displayPath(report: Pick<PackageReport, 'input' | 'kind'>, file: string): string {
  if (report.kind === 'zip') return `${report.input}!/${file}`
  if (report.kind === 'memory' || report.input === '.') return file
  return `${report.input.replace(/\/+$/, '')}/${file}`
}

/** `<file>:<line>:<column> <pointer> — <severity> [<code>] <message>` then `    → <hint>`. */
export function formatReport(report: PackageReport): string {
  const lines: string[] = []
  const location = (i: PackageIssue) => {
    let where = i.file ? displayPath(report, i.file) : report.input
    if (i.line !== undefined) where += `:${i.line}${i.column !== undefined ? `:${i.column}` : ''}`
    return i.path ? `${where} ${i.path}` : where
  }
  for (const i of [...report.errors, ...report.warnings]) {
    lines.push(`${location(i)} — ${i.severity} [${i.code}] ${i.message}`)
    if (i.hint) lines.push(`    → ${i.hint}`)
  }
  for (const s of report.skipped) lines.push(`${report.input}: skipped ${s.check} (${s.files.join(', ')}): ${s.reason}`)
  const w = report.warnings.length
  const warnings = w ? `${w} warning${w > 1 ? 's' : ''}` : ''
  if (report.ok) lines.push(`${report.input}: valid${warnings ? ` (${warnings})` : ''}.`)
  else {
    const e = report.errors.length
    lines.push(`${report.input}: ${e} error${e > 1 ? 's' : ''}${warnings ? `, ${warnings}` : ''}.`)
  }
  return lines.join('\n')
}

export function reportJson(report: PackageReport): string {
  return JSON.stringify({ format: REPORT_FORMAT, ...report }, null, 2)
}
