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
  /**
   * Crops the uploaded frame to each of `rois` (at most `tiles`), side by side, and reads them back at once into `out`
   * (RGBA rows of `rois.length × size` pixels, `size` rows, top row first: crop `i` starts at pixel `i × size` of each
   * row, `cropPixel` finds it); `size` ≤ `maxSize`. One `readPixels` for every face: one wait for the GPU.
   */
  crop(rois: readonly Roi[], size: number, out: Uint8Array): void
  /**
   * Like `crop`, without waiting for the GPU: the crops are read back into a pixel buffer, and `read` copies them out
   * once the GPU is done. The worker runs a model meanwhile instead of stalling in `readPixels`.
   */
  cropAsync(rois: readonly Roi[], size: number): void
  /** Copies the crops of the last `cropAsync` into `out` (as `crop`), after waiting for the GPU (polled); false if none. */
  read(out: Uint8Array): Promise<boolean>
  /** The WebGL context was lost: crops read back black. */
  readonly lost: boolean
  dispose(): void
}

/** Byte offset of pixel (`x`, `y`) of crop `tile` of `tiles`, each `size`×`size`, in the buffer of `GpuCropper.crop`. */
export function cropPixel(tile: number, tiles: number, size: number, x: number, y: number): number {
  return ((y * tiles + tile) * size + x) * 4
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
uniform float originX;
out vec4 color;
void main() {
  vec2 d = gl_FragCoord.xy - vec2(originX + halfSize, halfSize);
  vec2 uv = (center + d.x * axisX + d.y * axisY) / frameSize;
  bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  color = inside ? vec4(texture(frame, uv).rgb, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
}`

/** A cropper for crops of up to `maxSize`, `tiles` of them at once (the faces tracked). */
export function createGpuCropper(maxSize: number, tiles = 1): GpuCropper {
  const canvas = new OffscreenCanvas(maxSize * tiles, maxSize)
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
  const originX = u('originX')
  gl.uniform1i(u('frame'), 0)

  const texture = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindVertexArray(gl.createVertexArray())
  // Pixel buffer of `cropAsync`, and the fence that says its readback is done.
  const pbo = gl.createBuffer()
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
  gl.bufferData(gl.PIXEL_PACK_BUFFER, maxSize * maxSize * 4 * tiles, gl.STREAM_READ)
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
  let fence: WebGLSync | null = null
  let fenceBytes = 0

  /** Draws the crops side by side; returns the width read back. */
  const draw = (rois: readonly Roi[], size: number): number => {
    if (size > maxSize) throw new Error(`crop size ${size} > ${maxSize}`)
    if (rois.length > tiles) throw new Error(`${rois.length} crops > ${tiles}`)
    gl.uniform1f(halfSize, size / 2)
    for (let i = 0; i < rois.length; i++) {
      const roi = rois[i]!
      const k = roi.size / size
      const cos = Math.cos(roi.rotation) * k
      const sin = Math.sin(roi.rotation) * k
      gl.viewport(i * size, 0, size, size)
      gl.uniform1f(originX, i * size)
      gl.uniform2f(center, roi.cx, roi.cy)
      gl.uniform2f(axisX, cos, sin)
      gl.uniform2f(axisY, -sin, cos)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    return rois.length * size
  }

  return {
    upload(source, width, height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      gl.uniform2f(frameSize, width, height)
    },
    crop(rois, size, out) {
      const width = draw(rois, size)
      if (width > 0) gl.readPixels(0, 0, width, size, gl.RGBA, gl.UNSIGNED_BYTE, out)
    },
    cropAsync(rois, size) {
      const width = draw(rois, size)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
      gl.readPixels(0, 0, width, size, gl.RGBA, gl.UNSIGNED_BYTE, 0)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      if (fence) gl.deleteSync(fence)
      fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      fenceBytes = width * size * 4
      gl.flush()
    },
    async read(out) {
      const f = fence
      if (!f) return false
      // WebGL allows no blocking wait (`MAX_CLIENT_WAIT_TIMEOUT_WEBGL` is 0 in practice): poll.
      while (gl.clientWaitSync(f, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((resolve) => setTimeout(resolve, 1))
      gl.deleteSync(f)
      fence = null
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out, 0, fenceBytes)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      return true
    },
    get lost() {
      return gl.isContextLost()
    },
    dispose() {
      if (fence) gl.deleteSync(fence)
      gl.deleteBuffer(pbo)
      gl.deleteTexture(texture)
      gl.deleteProgram(program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
