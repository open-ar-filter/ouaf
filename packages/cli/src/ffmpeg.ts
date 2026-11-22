/**
 * The ffmpeg and ffprobe binaries, run as child processes (no npm wrapper: users install ffmpeg themselves). The
 * process runner is injected so commands can be tested without ffmpeg.
 */
import { spawn } from 'node:child_process'
import { basename } from 'node:path'

export interface ProcessResult {
  /** Exit code, or null when the process was killed by a signal. */
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Runs `command` with `args` (no shell) and resolves once it exits, whatever its exit code. Rejects when it cannot be
 * started, with the Node error (`code: 'ENOENT'` when the binary does not exist).
 */
export type ProcessRunner = (command: string, args: string[]) => Promise<ProcessResult>

/** Output kept per stream: ffmpeg can log a lot, only the end of stderr is shown on failure. */
const MAX_OUTPUT = 1 << 20

export const spawnRunner: ProcessRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const out = { stdout: '', stderr: '' }
    const collect = (key: keyof typeof out) => (chunk: Buffer) => {
      out[key] = (out[key] + chunk.toString('utf8')).slice(-MAX_OUTPUT)
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, ...out }))
  })

/** ffmpeg is missing or unusable: the message says how to install it. */
export class ToolError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export const INSTALL_HINT = `Install ffmpeg (built with libx264), then run the command again:
  macOS          brew install ffmpeg
  Debian/Ubuntu  sudo apt install ffmpeg
  Fedora         sudo dnf install ffmpeg   (RPM Fusion; the default ffmpeg-free has no H.264 encoder)
  Windows        winget install ffmpeg
or point to the binary with --ffmpeg <path> (or the OUAF_FFMPEG environment variable).`

export interface Ffmpeg {
  ffmpeg: string
  ffprobe: string
  /** First line of `ffmpeg -version`, e.g. "ffmpeg version 6.1.1". */
  version: string
}

/** ffprobe next to the given ffmpeg (same folder, same suffix such as `.exe`), or on the PATH. */
export function ffprobePath(ffmpeg: string): string {
  return ffmpeg.replace(/ffmpeg(?=[^\\/]*$)/i, 'ffprobe')
}

const notFound = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

/** Checks that ffmpeg and ffprobe run and that ffmpeg can encode H.264; throws a `ToolError` otherwise. */
export async function findFfmpeg(runner: ProcessRunner, ffmpeg: string): Promise<Ffmpeg> {
  const ffprobe = ffprobePath(ffmpeg)
  const start = async (bin: string, args: string[]) => {
    try {
      return await runner(bin, args)
    } catch (e) {
      if (notFound(e)) throw new ToolError(`${basename(bin).replace(/\.exe$/i, '')}-missing`, `"${bin}" was not found.\n${INSTALL_HINT}`)
      throw new ToolError('ffmpeg-failed', `Could not run "${bin}": ${(e as Error).message}`)
    }
  }
  const version = await start(ffmpeg, ['-hide_banner', '-version'])
  if (version.code !== 0) throw new ToolError('ffmpeg-failed', `"${ffmpeg} -version" failed:\n${tail(version.stderr)}`)
  const probe = await start(ffprobe, ['-hide_banner', '-version'])
  if (probe.code !== 0) throw new ToolError('ffprobe-missing', `"${ffprobe} -version" failed:\n${tail(probe.stderr)}\n${INSTALL_HINT}`)
  const encoders = await start(ffmpeg, ['-hide_banner', '-encoders'])
  if (!/^\s*V\S*\s+libx264\s/m.test(encoders.stdout)) {
    throw new ToolError('no-libx264', `"${ffmpeg}" has no libx264 encoder (H.264).\n${INSTALL_HINT}`)
  }
  return { ffmpeg, ffprobe, version: version.stdout.split('\n')[0]!.trim() }
}

/** The last lines of a process output, for error messages. */
export function tail(text: string, lines = 12): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}
