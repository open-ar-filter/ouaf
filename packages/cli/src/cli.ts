/**
 * `ouaf <command> [args]`: dispatches to the commands of `commands/index.ts`.
 */
import { readFileSync } from 'node:fs'
import { EXIT, UsageError, type Command, type ExitCode, type Io } from './command.ts'
import { COMMANDS } from './commands/index.ts'

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

function usage(commands: Command[]): string {
  const width = Math.max(...commands.map((c) => c.name.length))
  return `Usage: ouaf <command> [options]

Tools for Ouaf (Open Universal AR Filter) filters.

Commands:
${commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join('\n')}

Options:
  -h, --help     Show this help (ouaf <command> --help for a command)
  -v, --version  Show the version

Exit codes: 0 success, 1 the command found problems (e.g. invalid filter), 2 usage error.`
}

/** Runs the CLI with arguments (without `node` and the script path); returns the exit code. */
export async function run(argv: string[], io: Io, commands: Command[] = COMMANDS): Promise<ExitCode> {
  const [first, ...rest] = argv
  if (first === undefined || first === '-h' || first === '--help' || first === 'help') {
    const cmd = first === 'help' && rest[0] ? commands.find((c) => c.name === rest[0]) : undefined
    io.out(cmd ? cmd.help : usage(commands))
    return first === undefined ? EXIT.USAGE : EXIT.OK
  }
  if (first === '-v' || first === '--version') {
    io.out(VERSION)
    return EXIT.OK
  }
  const cmd = commands.find((c) => c.name === first)
  if (!cmd) {
    io.err(`ouaf: unknown command "${first}". Commands: ${commands.map((c) => c.name).join(', ')}. See ouaf --help.`)
    return EXIT.USAGE
  }
  try {
    return await cmd.run(rest, io)
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`ouaf ${cmd.name}: ${e.message}\nSee ouaf ${cmd.name} --help.`)
      return EXIT.USAGE
    }
    throw e
  }
}
