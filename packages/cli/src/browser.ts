/**
 * Headless Chromium through Playwright, an optional peer dependency of `@ouaf/cli`: `ouaf preview` renders filters in
 * it, `ouaf validate` compiles shaders with its WebGL2 (the same ANGLE / SwiftShader compiler for both).
 */
import type { Browser } from 'playwright'

/**
 * Chromium flags. Software WebGL (SwiftShader) whatever the machine has: the same rendering everywhere this
 * Chromium build runs, the condition of pixel-identical screenshots. Fixed scale factor and color profile.
 */
export const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--force-device-scale-factor=1',
  '--force-color-profile=srgb',
  '--autoplay-policy=no-user-gesture-required',
]

/** Chromium cannot be started (Playwright or its browser missing), or the command's inputs are unusable. */
export class BrowserSetupError extends Error {
  hint: string | undefined
  constructor(message: string, hint?: string) {
    super(message)
    this.hint = hint
  }
}

type Chromium = typeof import('playwright').chromium

/** Loads Playwright's Chromium (`playwright` or `playwright-core`); `command` names who needs it in the error. */
export async function loadChromium(command: string): Promise<Chromium> {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return ((await import(name)) as typeof import('playwright')).chromium
    } catch {}
  }
  throw new BrowserSetupError(
    `${command} needs Playwright, which is not installed.`,
    'Install it next to @ouaf/cli, with its Chromium: npm install --save-dev playwright && npx playwright install chromium',
  )
}

/** Starts headless Chromium with `CHROMIUM_ARGS`. Throws `BrowserSetupError` when its browser is not installed. */
export async function launchChromium(chromium: Chromium): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, args: CHROMIUM_ARGS })
  } catch (e) {
    const message = (e as Error).message
    if (/Executable doesn't exist|browserType\.launch: .*(install|not found)/i.test(message)) {
      const hint = 'Run: npx playwright install chromium (add --with-deps on Linux if system libraries are missing)'
      throw new BrowserSetupError('Playwright\'s Chromium is not installed.', hint)
    }
    throw new BrowserSetupError(`Cannot start Chromium: ${message.split('\n')[0]}`)
  }
}
