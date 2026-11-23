/**
 * Shape of a CLI command. Each command lives in `commands/<name>.ts` and is listed in `commands/index.ts`;
 * `validate`, `pack`, `preview` and `pack-alpha` follow the same pattern.
 */

/** Exit codes shared by every command. */
export const EXIT = {
  /** Success (for `validate`: no errors; warnings allowed unless `--strict`). */
  OK: 0,
  /** The command ran and found problems (for `validate`: the filter is invalid). */
  FAILED: 1,
  /** The command could not run: bad arguments, unknown command, missing input. */
  USAGE: 2,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** Output streams, injected so commands can be tested without a process. */
export interface Io {
  out(text: string): void
  err(text: string): void
}

export interface Command {
  name: string
  /** One line, for `ouaf --help`. */
  summary: string
  /** Full help text, for `ouaf <name> --help`. */
  help: string
  run(args: string[], io: Io): Promise<ExitCode>
}

/** Thrown by a command for a usage error: printed with the command's help hint, exit code 2. */
export class UsageError extends Error {}
