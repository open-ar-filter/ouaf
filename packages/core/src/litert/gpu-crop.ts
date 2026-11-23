/**
 * Rotated face crop and detector letterbox on WebGL2 (docs/decisions/face-runtime.md, `crop=gpu` of the #83 spike).
 * A 2D canvas crop (`willReadFrequently`, CPU-backed) pulls the whole video frame back to the CPU and resamples it in
 * software (half the pipeline on the Redmi Note 11S); here the frame stays a texture, the crop is drawn by a fragment
 * shader and only the `size`×`size` result is read back (`readPixels`): 256×256 for the landmark crop, 128×128 for
 * the detector input.
 *
 * The frame is uploaded once per pipeline run (`upload`) and cropped as many times as needed (`crop`): the detector
 * and the landmark crop of a run see the same frame.
 *
 * Same mapping as the canvas path: crop pixel `d` (centre at `+0.5`) samples the frame at
 * `roi.c + R(roi.rotation) · (roi.size / size) · (d − size / 2)`, bilinear, black outside the frame. Framebuffer row 0
 * (bottom in GL) is read back first, so using `gl_FragCoord.y` directly as the crop row keeps the rows top-down.
 * The detector letterbox is the unrotated ROI centred on the frame, of side the frame's long side. One bilinear tap
 * per pixel, even for the ≈ 10× reduction of the letterbox: this is what the 2D canvas and MediaPipe's own crop do;
 * averaging more taps moved the ROI rotation on hard frames.
 *
 * Runs in the tracking worker on an `OffscreenCanvas`; takes the transferred `VideoFrame` or `ImageBitmap`.
 */
import type { Roi } from './geometry.ts'

export interface GpuCropper {
  /** Uploads the frame to crop from (`width`×`height`). */
  upload(source: TexImageSource, width: number, height: number): void
  /** Crops the uploaded frame to `roi` into `out` (RGBA, `size`×`size`×4 bytes, top row first); `size` ≤ `maxSize`. */
  crop(roi: Roi, size: number, out: Uint8Array): void
  /** The WebGL context was lost: crops read back black. */
  readonly lost: boolean
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

export function createGpuCropper(maxSize: number): GpuCropper {
  const canvas = new OffscreenCanvas(maxSize, maxSize)
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false })
  if (!gl) throw new Error('no WebGL2 on an OffscreenCanvas here')

  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, source)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`crop shader: ${gl.getShaderInfoLog(s)}`)
    return s
  }
  const program = gl.createProgram()
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX))
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`crop program: ${gl.getProgramInfoLog(program)}`)
  gl.useProgram(program)
  const u = (name: string) => gl.getUniformLocation(program, name)
  const frameSize = u('frameSize')
  const center = u('center')
  const axisX = u('axisX')
  const axisY = u('axisY')
  const halfSize = u('halfSize')
  gl.uniform1i(u('frame'), 0)

  const texture = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindVertexArray(gl.createVertexArray())

  return {
    upload(source, width, height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      gl.uniform2f(frameSize, width, height)
    },
    crop(roi, size, out) {
      if (size > maxSize) throw new Error(`crop size ${size} > ${maxSize}`)
      const k = roi.size / size
      const cos = Math.cos(roi.rotation) * k
      const sin = Math.sin(roi.rotation) * k
      gl.viewport(0, 0, size, size)
      gl.uniform1f(halfSize, size / 2)
      gl.uniform2f(center, roi.cx, roi.cy)
      gl.uniform2f(axisX, cos, sin)
      gl.uniform2f(axisY, -sin, cos)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, out)
    },
    get lost() {
      return gl.isContextLost()
    },
    dispose() {
      gl.deleteTexture(texture)
      gl.deleteProgram(program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
