/**
 * GLSL ES 3.00 compilation for `ouaf validate` (spec §11): the programs the engine would build (its vertex shader and
 * the wrapped fragment shader, `@ouaf/spec`) are compiled and linked with WebGL2 in headless Chromium, the compiler
 * of the browsers the engine runs in (ANGLE, on SwiftShader as for `ouaf preview`). Nothing is served: the page is
 * `about:blank` and never loads anything.
 */
import type { Browser } from 'playwright'
import { BrowserSetupError, launchChromium, loadChromium } from './browser.ts'

/** A program to compile: sources without `#version` (the compiler adds `#version 300 es`, as the engine does). */
export interface ShaderProgram {
  vertex: string
  fragment: string
}

/** The compiler's logs of a program; a field is set when that step failed. */
export interface ProgramLog {
  vertex?: string
  fragment?: string
  link?: string
}

/** Compiles programs, in order. Throws `BrowserSetupError` when no compiler can run. */
export type GlslCompiler = (programs: ShaderProgram[]) => Promise<ProgramLog[]>

/** Runs in the page: compiles and links each program with a WebGL2 context. */
function compileInPage(programs: ShaderProgram[]): ProgramLog[] | string {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return 'WebGL2 is not available in this Chromium'
  return programs.map(({ vertex, fragment }) => {
    const log: ProgramLog = {}
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, `#version 300 es\n${source}`)
      gl.compileShader(shader)
      const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean
      return { shader, ok, info: ok ? '' : (gl.getShaderInfoLog(shader) ?? '') || 'does not compile' }
    }
    const vs = compile(gl.VERTEX_SHADER, vertex)
    const fs = compile(gl.FRAGMENT_SHADER, fragment)
    if (!vs.ok) log.vertex = vs.info
    if (!fs.ok) log.fragment = fs.info
    if (vs.ok && fs.ok) {
      const program = gl.createProgram()
      gl.attachShader(program, vs.shader)
      gl.attachShader(program, fs.shader)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) log.link = gl.getProgramInfoLog(program) || 'does not link'
      gl.deleteProgram(program)
    }
    gl.deleteShader(vs.shader)
    gl.deleteShader(fs.shader)
    return log
  })
}

/**
 * A compiler on headless Chromium, started at its first use and kept for the next ones; `close()` stops it. Throws
 * `BrowserSetupError` (Playwright or its Chromium missing) from the first compilation.
 */
export function chromiumCompiler(): GlslCompiler & { close(): Promise<void> } {
  let browser: Promise<Browser> | undefined
  const compile = async (programs: ShaderProgram[]): Promise<ProgramLog[]> => {
    if (programs.length === 0) return []
    browser ??= loadChromium('GLSL compilation').then(launchChromium)
    const page = await (await browser).newPage()
    try {
      const result = await page.evaluate(compileInPage, programs)
      if (typeof result === 'string') throw new BrowserSetupError(`Cannot compile shaders: ${result}.`)
      return result
    } finally {
      await page.close()
    }
  }
  return Object.assign(compile, {
    async close() {
      const started = browser
      browser = undefined
      await (await started?.catch(() => undefined))?.close()
    },
  })
}
