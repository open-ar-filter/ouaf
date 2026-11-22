import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { EXIT, UsageError, type Command } from '../command.ts'
import { packFolder, PackSourceError, RUN_TIMEOUT_MS, type FilterPackResult } from '../pack.ts'
import { formatReport, REPORT_FORMAT } from '../report.ts'

const HELP = `Usage: ouaf pack <folder> [-o <file.ouaf>] [--json] [--strict]

Builds a .ouaf package (spec §3) from a filter folder:
  folder/
    filter.ts or filter.js   default export: the manifest data, the script functions (setup, update, on, draw)
                             and the initial state (spec §3.1, §12.3)
    assets/                  files referenced by the manifest (optional)

  1. bundles filter.ts / filter.js with its imports into script.js, a self-contained ES module (esbuild;
     TypeScript is transpiled, "@ouaf/spec" is reduced to defineFilter, the identity function)
  2. runs it once, without Node or browser APIs (time limit ${RUN_TIMEOUT_MS} ms), and reads its default export
  3. writes manifest.json from the data, with "ouaf" and the "script" section filled in from the functions
     (write script: { uses: [...] } in filter.js to choose the data the script receives, spec §12.4)
  4. zips manifest.json, script.js and assets/, then validates the archive as ouaf validate does

A folder with a manifest.json (and no filter.js) is packed as it is, with its script.js and assets/.
Other files of the folder (README, package.json…) and hidden files are left out; symbolic links are errors.
The same folder gives the same archive, byte for byte: files sorted, fixed timestamps and permissions.
Nothing is written when the package has errors.

filter.js runs on your machine, as a build script does: node:vm keeps it away from Node APIs but is not a
security boundary, so pack only filters you trust.

Options:
  -o, --output <file.ouaf>  Output file (default: <folder>.ouaf next to the folder); replaced if it exists
  --json                    Print the report as JSON (for tools and AI agents)
  --strict                  Fail on warnings too (nothing is written)
  -h, --help                Show this help

Exit codes:
  0  written (warnings allowed without --strict)
  1  not written: the filter has errors (or a warning with --strict)
  2  usage error: bad arguments, the folder does not exist or has nothing to pack`

export const pack: Command = {
  name: 'pack',
  summary: 'Build a .ouaf package from a filter folder (filter.ts / filter.js, assets/)',
  help: HELP,

  async run(args, io) {
    const { values, positionals } = (() => {
      try {
        return parseArgs({
          args,
          allowPositionals: true,
          options: {
            output: { type: 'string', short: 'o' },
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
    if (positionals.length !== 1) throw new UsageError(positionals.length ? 'Expected a single folder.' : 'Missing the filter folder to pack.')
    const dir = positionals[0]!
    const output = values.output ?? `${resolve(dir)}.ouaf`
    if (!output.endsWith('.ouaf')) throw new UsageError(`The output must be a .ouaf file, got "${output}".`)
    // An archive under assets/ would be packed into the next one.
    const inside = relative(resolve(dir, 'assets'), resolve(output))
    if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) {
      throw new UsageError(`The output "${output}" is inside the filter's assets/ folder: write it elsewhere.`)
    }

    let result: FilterPackResult
    try {
      result = await packFolder(dir, { label: output })
    } catch (e) {
      if (e instanceof PackSourceError) throw new UsageError(e.message)
      throw e
    }
    const { report } = result
    const write = result.zip !== undefined && !(values.strict && report.warnings.length)
    if (write) {
      await mkdir(dirname(resolve(output)), { recursive: true })
      // Written next to the output then renamed: a failed write never leaves a truncated package behind.
      const tmp = `${output}.${process.pid}.tmp`
      try {
        await writeFile(tmp, result.zip!)
        await rename(tmp, output)
      } catch (e) {
        await rm(tmp, { force: true })
        throw e
      }
    }

    if (values.json) {
      io.out(JSON.stringify({
        format: REPORT_FORMAT,
        ...report,
        output: write ? output : null,
        ...(result.entry ? { entry: result.entry } : {}),
        packageFiles: result.files,
        hidden: result.hidden,
      }, null, 2))
    } else {
      const lines = [formatReport(report)]
      if (result.hidden.length) lines.push(`Left out ${result.hidden.length} hidden file${result.hidden.length > 1 ? 's' : ''}: ${result.hidden.join(', ')}.`)
      if (write) {
        const size = result.zip!.length
        const kb = size < 1e6 ? `${Math.max(1, Math.round(size / 1e3))} kB` : `${(size / 1e6).toFixed(1)} MB`
        lines.push(`Wrote ${output}: ${result.files.length} file${result.files.length > 1 ? 's' : ''}, ${kb}${result.entry ? ` (from ${result.entry})` : ''}.`)
      } else lines.push(`${basename(output)} was not written.`)
      io.out(lines.join('\n'))
    }
    return write ? EXIT.OK : EXIT.FAILED
  },
}
