import { parseArgs } from 'node:util'
import { EXIT, UsageError, type Command } from '../command.ts'
import { formatReport, reportJson } from '../report.ts'
import { SourceError } from '../source.ts'
import { validatePath } from '../validate.ts'

export const validate: Command = {
  name: 'validate',
  summary: 'Check a filter folder or .ouaf package: manifest, files, formats, limits',
  help: `Usage: ouaf validate <folder | file.ouaf> [--json] [--strict]

Checks a filter package (or its unzipped folder) against the Ouaf v1 spec:
  - manifest.json: schema and semantic rules (anchors, assets, params, bindings, events, requires)
  - package layout (spec §3): manifest.json, script.js, assets/; no links, no unsafe paths
  - referenced files exist, have a supported format whose content matches the extension (spec §10.2)
  - image ≤ 4096 px per side, video ≤ 1080p (720p recommended), MP4 H.264 / WebM VP9 (spec §10.4)
  - .cube LUTs, glTF / GLB models (version, external files), JSON data
  - shaders (spec §11): no #version, no main(), defines vec4 effect(vec2 uv)
    (GLSL compilation is not available yet: reported as a skipped check)
  - package size: ≤ 5 MB recommended (warning), above 50 MB an engine may refuse it (error)

Each problem names a file (with line and column when known), the JSON pointer of the manifest element
concerned, a stable code, a message and, when possible, a fix hint.

Options:
  --json     Print the report as JSON (for tools and AI agents) instead of text
  --strict   Fail on warnings too
  -h, --help Show this help

Exit codes:
  0  valid (warnings allowed without --strict)
  1  invalid: at least one error (or a warning with --strict)
  2  usage error: bad arguments, or the input does not exist`,

  async run(args, io) {
    const { values, positionals } = (() => {
      try {
        return parseArgs({
          args,
          allowPositionals: true,
          options: { json: { type: 'boolean' }, strict: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
        })
      } catch (e) {
        throw new UsageError((e as Error).message)
      }
    })()
    if (values.help) {
      io.out(validate.help)
      return EXIT.OK
    }
    if (positionals.length !== 1) throw new UsageError(positionals.length ? 'Expected a single folder or .ouaf file.' : 'Missing the folder or .ouaf file to validate.')
    let report
    try {
      report = await validatePath(positionals[0]!)
    } catch (e) {
      if (e instanceof SourceError) throw new UsageError(e.message)
      throw e
    }
    io.out(values.json ? reportJson(report) : formatReport(report))
    return report.ok && !(values.strict && report.warnings.length) ? EXIT.OK : EXIT.FAILED
  },
}
