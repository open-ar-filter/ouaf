/**
 * Compile check of a shader layer (spec §11): the wrapped program is compiled and linked once with the raw WebGL2
 * context when the layer is created, so that a broken shader rejects its filter with the compiler's messages, lines
 * counted in the author's file, instead of a console log from three.js at the first frame.
 */
import { parseShaderLog, type WrappedShader } from '@ouaf/spec'
import type { ShaderErrorDetail } from '../../engine/errors.ts'

/** The part of `WebGL2RenderingContext` the check uses (a stub in unit tests). */
export type CompileContext = Pick<
  WebGL2RenderingContext,
  | 'createShader'
  | 'shaderSource'
  | 'compileShader'
  | 'getShaderParameter'
  | 'getShaderInfoLog'
  | 'deleteShader'
  | 'createProgram'
  | 'attachShader'
  | 'linkProgram'
  | 'getProgramParameter'
  | 'getProgramInfoLog'
  | 'deleteProgram'
  | 'isContextLost'
  | 'VERTEX_SHADER'
  | 'FRAGMENT_SHADER'
  | 'COMPILE_STATUS'
  | 'LINK_STATUS'
>

/**
 * Compiles `vertex` and the wrapped fragment shader (both without `#version`) and links them. Returns the errors
 * (empty when the program is valid; warnings are dropped), with fragment lines mapped to the author's file.
 * Returns `undefined` when the context is lost: nothing can be checked then.
 */
export function checkProgram(gl: CompileContext, vertex: string, wrapped: WrappedShader): ShaderErrorDetail[] | undefined {
  if (gl.isContextLost()) return undefined
  const errors: ShaderErrorDetail[] = []
  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, `#version 300 es\n${source}`)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? ''
      if (type === gl.FRAGMENT_SHADER) {
        for (const d of parseShaderLog(log, wrapped)) if (d.severity === 'error') errors.push(d)
        if (errors.length === 0) errors.push({ severity: 'error', message: log.trim() || 'the fragment shader does not compile' })
      } else {
        errors.push({ severity: 'error', message: `engine vertex shader: ${log.trim()}` })
      }
    }
    return shader
  }
  const vs = compile(gl.VERTEX_SHADER, vertex)
  const fs = compile(gl.FRAGMENT_SHADER, wrapped.fragment)
  if (errors.length === 0 && vs && fs) {
    const program = gl.createProgram()
    if (program) {
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        errors.push({ severity: 'error', message: `link: ${(gl.getProgramInfoLog(program) ?? '').trim() || 'the program does not link'}` })
      }
      gl.deleteProgram(program)
    }
  }
  if (vs) gl.deleteShader(vs)
  if (fs) gl.deleteShader(fs)
  if (gl.isContextLost()) return undefined
  return errors
}
