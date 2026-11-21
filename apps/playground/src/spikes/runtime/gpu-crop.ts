/**
 * Rotated face crop on WebGL2 (#83 spike, `crop=gpu`). The 2D-canvas crop (`willReadFrequently`, CPU-backed) pulls
 * the whole video frame back to the CPU and resamples it in software; here the frame stays a texture, the crop is
 * drawn by a fragment shader and only the `size`×`size` result is read back (`readPixels`).
 *
 * Same mapping as the canvas path: crop pixel `d` (centre at `+0.5`) samples the frame at
 * `roi.c + R(roi.rotation) · (roi.size / size) · (d − size / 2)`, bilinear, black outside the frame. Framebuffer row 0
 * (bottom in GL) is read back first, so using `gl_FragCoord.y` directly as the crop row keeps the rows top-down.
 */
import type { Roi } from './geometry.ts'

export interface GpuCropper {
  /** Crops `source` (`width`×`height`) to the ROI into `out` (RGBA, `size`×`size`×4 bytes, top row first). */
  crop(source: TexImageSource, width: number, height: number, roi: Roi, out: Uint8Array): void
  dispose(): void
}

const VERTEX = `#version 300 es
void main() {
  // One triangle covering the viewport.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D frame;
uniform vec2 frameSize;
uniform vec2 center;
uniform vec2 axisX;
uniform vec2 axisY;
uniform float halfSize;
out vec4 color;
void main() {
  vec2 d = gl_FragCoord.xy - vec2(halfSize);
  vec2 uv = (center + d.x * axisX + d.y * axisY) / frameSize;
  bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  color = inside ? vec4(texture(frame, uv).rgb, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
}`

export function createGpuCropper(size: number): GpuCropper {
  const canvas = new OffscreenCanvas(size, size)
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false })
  if (!gl) throw new Error('crop=gpu needs WebGL2, unavailable in this browser')

  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, source)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`crop=gpu shader: ${gl.getShaderInfoLog(s)}`)
    return s
  }
  const program = gl.createProgram()
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX))
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`crop=gpu program: ${gl.getProgramInfoLog(program)}`)
  gl.useProgram(program)
  const u = (name: string) => gl.getUniformLocation(program, name)
  const frameSize = u('frameSize')
  const center = u('center')
  const axisX = u('axisX')
  const axisY = u('axisY')
  gl.uniform1i(u('frame'), 0)
  gl.uniform1f(u('halfSize'), size / 2)

  const texture = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.viewport(0, 0, size, size)
  gl.bindVertexArray(gl.createVertexArray())

  return {
    crop(source, width, height, roi, out) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      const k = roi.size / size
      const cos = Math.cos(roi.rotation) * k
      const sin = Math.sin(roi.rotation) * k
      gl.uniform2f(frameSize, width, height)
      gl.uniform2f(center, roi.cx, roi.cy)
      gl.uniform2f(axisX, cos, sin)
      gl.uniform2f(axisY, -sin, cos)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, out)
    },
    dispose() {
      gl.deleteTexture(texture)
      gl.deleteProgram(program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
