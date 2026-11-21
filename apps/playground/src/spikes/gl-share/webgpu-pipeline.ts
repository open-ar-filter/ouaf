/**
 * `?path=webgpu`: three's WebGPURenderer draws the same composite; MediaPipe (WebGL only) runs in its own WebGL2
 * context and the mask is copied to a WebGPU texture every frame. Loaded with a dynamic `import()` from the spike
 * page only: `three/webgpu` never reaches the main page bundle.
 *
 * Copy modes (`?copy=`), timed as `transferMs` (out of MediaPipe) and `uploadMs` (into WebGPU):
 * - `canvas` (default, GPU → GPU): the mask texture is drawn into MediaPipe's canvas (one full-screen triangle in
 *   MediaPipe's context), then `GPUQueue.copyExternalImageToTexture({ source: canvas })` copies the canvas into an
 *   `r8unorm` texture of three's device. No CPU readback; the browser copies between the two APIs on the GPU.
 * - `readback` (CPU): `getAsFloat32Array` (readPixels) converted to bytes, then `GPUQueue.writeTexture`.
 *
 * MediaPipe 1.2.3's wasm contains WebGPU code paths (e.g. `preinitializedWebGPUDevice`), but the tasks API exposes
 * no way to run a task on a given GPUDevice: a shared device is not possible yet.
 */
import { computeVideoToClip, createVideoToClip } from '@ouaf/core'
import { createFaceTask, createSegmenter, type FaceTask, type MPMask, type Segmenter } from './mediapipe.ts'
import { compareOrientation, meanOf, type FrameTimings, type MaskPipeline, type SpikeOptions } from './pipeline.ts'
import type { Probe } from './probe.ts'
import { BG_SATURATION, BG_TINT, BLUR_RADIUS, BLUR_TAPS, GOLDEN_ANGLE, MASK_COLOR } from './shaders.ts'

const BLIT_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); // full-screen triangle
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

// Writes the mask so that the canvas image (top row first, as copyExternalImageToTexture reads it) is the mask
// image (top row first). uFlip: the mask texture is stored bottom row first.
const BLIT_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uMask;
uniform vec2 uSize;
uniform float uFlip;
out vec4 color;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize; // y = 0: bottom row of the canvas
  float v = 1.0 - uv.y; // image v, down
  float m = texture(uMask, vec2(uv.x, mix(v, 1.0 - v, uFlip))).r;
  color = vec4(m, m, m, 1.0);
}
`

// WebGPU flag values (the namespaces are not in TypeScript's DOM lib).
const TEXTURE_USAGE = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 } as const
const BUFFER_USAGE = { MAP_READ: 0x0001, COPY_DST: 0x0008 } as const
const MAP_READ = 0x0001

/** Same orientation as the shared WebGL path (see `SHARED_MASK_FLIP_Y` in webgl-pipeline.ts). */
const MASK_FLIP_Y = false

function compile(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type)
    if (!shader) throw new Error('createShader failed')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Blit program: ${gl.getProgramInfoLog(program)}`)
  return program
}

export async function createWebGPUPipeline(options: SpikeOptions, probe: Probe, mirrored: boolean): Promise<MaskPipeline> {
  if (!('gpu' in navigator) || !navigator.gpu) throw new Error('WebGPU is not available in this browser (navigator.gpu missing).')
  // three's source modules rather than `three/webgpu` (build/three.webgpu.js): that build shares
  // build/three.core.js with `three`, so every core class WebGPU needs would be kept in the chunk the main page
  // loads (+200 kB). From src/, the WebGPU path is self-contained (its own copy of the few core classes it uses).
  const THREE = await import('three/src/Three.WebGPU.js')
  const TSL = await import('three/src/Three.TSL.js')

  const canvas = document.createElement('canvas')
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,
    alpha: false,
    ...(options.powerPreference ? { powerPreference: options.powerPreference } : {}),
  })
  await renderer.init()
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean; device?: GPUDevice }
  if (!backend.isWebGPUBackend || !backend.device) {
    renderer.dispose()
    throw new Error('three fell back to its WebGL 2 backend: WebGPU adapter unavailable.')
  }
  const device = backend.device
  const info = (device as GPUDevice & { adapterInfo?: GPUAdapterInfo }).adapterInfo
  const adapter = info ? `${info.vendor} ${info.architecture}${info.isFallbackAdapter ? ' (fallback)' : ''}`.trim() : 'unknown'
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 1)
  // three's WebGPU renderer requires sRGB video textures (decoded to linear when sampled), so the output is
  // re-encoded to sRGB: one decode/encode round trip the WebGL paths avoid by passing the bytes through.
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping

  // MediaPipe's own WebGL2 context, on a canvas we keep so we can draw the mask into it.
  const mpCanvas = document.createElement('canvas')
  const segmenter: Segmenter = await createSegmenter({
    ...(options.copy === 'canvas' ? { canvas: mpCanvas } : {}),
    delegate: options.delegate,
    probe,
  })
  const face: FaceTask | undefined = options.face === 'off' ? undefined : await createFaceTask(undefined)
  const mgl = options.copy === 'canvas' ? (mpCanvas.getContext('webgl2') as WebGL2RenderingContext | null) : null
  if (options.copy === 'canvas' && !mgl) throw new Error('MediaPipe canvas has no WebGL2 context')
  const blit = mgl ? compile(mgl, BLIT_VERTEX, BLIT_FRAGMENT) : undefined
  const blitVao = mgl?.createVertexArray()
  const uMaskLoc = mgl && blit ? mgl.getUniformLocation(blit, 'uMask') : null
  const uSizeLoc = mgl && blit ? mgl.getUniformLocation(blit, 'uSize') : null
  const uFlipLoc = mgl && blit ? mgl.getUniformLocation(blit, 'uFlip') : null
  const flip = options.maskFlipY ?? MASK_FLIP_Y

  // --- Scene (TSL) ------------------------------------------------------------------------------------------------
  const { texture, uniform, varying, vec2, vec3, vec4, float, mix, dot, clamp, positionGeometry } = TSL
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera() // unused by the shaders; WebGPURenderer needs a projection
  const uVideoToClip = uniform(new THREE.Vector4())
  const uBlur = uniform(new THREE.Vector2())
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3))
  geometry.setIndex([0, 2, 1, 2, 3, 1])
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0), 1)
  let videoTexture: InstanceType<typeof THREE.VideoTexture> | undefined
  let maskTexture: GPUTexture | undefined
  let maskExternal: InstanceType<typeof THREE.ExternalTexture> | undefined
  let mesh: InstanceType<typeof THREE.Mesh> | undefined
  let material: InstanceType<typeof THREE.MeshBasicNodeMaterial> | undefined
  let bytes: Uint8ClampedArray<ArrayBuffer> | undefined

  function buildMaterial(video: InstanceType<typeof THREE.VideoTexture>, mask: InstanceType<typeof THREE.ExternalTexture>) {
    const p = positionGeometry.xy
    const vUv = varying(p)
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, depthTest: false, depthWrite: false })
    m.vertexNode = vec4(uVideoToClip.x.mul(p.x).add(uVideoToClip.y), uVideoToClip.z.mul(p.y).add(uVideoToClip.w), 0, 1)
    const c = texture(video, vUv).rgb
    const k = clamp(texture(mask, vUv).r, 0, 1) // the WebGPU texture is always top row first
    if (options.view === 'mask') {
      m.colorNode = mix(c.mul(0.3), vec3(...MASK_COLOR), k.mul(0.8))
    } else {
      let b = c
      if (options.effect === 'blur') {
        let acc = c
        for (let i = 1; i < BLUR_TAPS; i++) {
          const r = Math.sqrt(i / (BLUR_TAPS - 1))
          const a = i * GOLDEN_ANGLE
          acc = acc.add(texture(video, vUv.add(uBlur.mul(vec2(r * Math.cos(a), r * Math.sin(a))))).rgb)
        }
        b = acc.div(float(BLUR_TAPS))
      }
      const l = dot(b, vec3(0.2126, 0.7152, 0.0722))
      const bg = mix(vec3(l), b, BG_SATURATION).mul(vec3(...BG_TINT))
      m.colorNode = mix(bg, c, k)
    }
    return m
  }

  function ensureMask(width: number, height: number) {
    if (maskTexture && maskTexture.width === width && maskTexture.height === height) return
    maskTexture?.destroy()
    maskTexture = device.createTexture({
      size: [width, height],
      format: 'r8unorm',
      usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST | TEXTURE_USAGE.COPY_SRC | TEXTURE_USAGE.RENDER_ATTACHMENT,
    })
    maskExternal = new THREE.ExternalTexture(maskTexture)
    if (mesh) scene.remove(mesh)
    material?.dispose()
    material = buildMaterial(videoTexture!, maskExternal)
    mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    scene.add(mesh)
    if (mgl) {
      mpCanvas.width = width
      mpCanvas.height = height
    }
  }

  const video = { width: 0, height: 0 }
  let maskWidth = 0
  let maskHeight = 0
  let maskInfo = ''
  let pendingCheck: ((ref: Float32Array, mask: MPMask) => void) | undefined

  function layout(el: HTMLVideoElement) {
    video.width = el.videoWidth
    video.height = el.videoHeight
    renderer.setSize(video.width, video.height, false)
    const m = computeVideoToClip(video.width, video.height, video.width, video.height, 'cover', mirrored, createVideoToClip())
    uVideoToClip.value.set(m.ax, m.bx, m.ay, m.by)
    uBlur.value.set(BLUR_RADIUS, (BLUR_RADIUS * video.width) / Math.max(1, video.height))
  }

  /** Draws the mask into MediaPipe's canvas (its default framebuffer), for `uploadViaCanvas`. */
  function copyViaCanvas(mask: MPMask) {
    const gl = mgl!
    const tex = mask.getAsWebGLTexture()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, mask.width, mask.height)
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.STENCIL_TEST)
    gl.disable(gl.CULL_FACE)
    gl.useProgram(blit!)
    gl.bindVertexArray(blitVao!)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(uMaskLoc, 0)
    gl.uniform2f(uSizeLoc, mask.width, mask.height)
    gl.uniform1f(uFlipLoc, flip ? 1 : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    // Leave MediaPipe's context as MediaPipe binds it: nothing of ours bound.
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindVertexArray(null)
    gl.useProgram(null)
  }

  /** Copies MediaPipe's canvas into the WebGPU texture (GPU → GPU inside the browser). */
  function uploadViaCanvas(mask: MPMask) {
    device.queue.copyExternalImageToTexture({ source: mpCanvas }, { texture: maskTexture! }, [mask.width, mask.height])
  }

  /** Reads the mask back (readPixels inside MediaPipe) and converts it to bytes, for `uploadViaReadback`. */
  function copyViaReadback(mask: MPMask) {
    const data = mask.getAsFloat32Array()
    const n = mask.width * mask.height
    if (!bytes || bytes.length !== n) bytes = new Uint8ClampedArray(n)
    for (let i = 0; i < n; i++) bytes[i] = (data[i] as number) * 255 // clamped and rounded by the typed array
  }

  function uploadViaReadback(mask: MPMask) {
    device.queue.writeTexture({ texture: maskTexture! }, bytes!, { bytesPerRow: mask.width }, [mask.width, mask.height])
  }

  async function readMaskTexture(width: number, height: number): Promise<(x: number, y: number) => number> {
    const bytesPerRow = Math.ceil(width / 256) * 256
    const buffer = device.createBuffer({ size: bytesPerRow * height, usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ })
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture: maskTexture! }, { buffer, bytesPerRow }, [width, height])
    device.queue.submit([encoder.finish()])
    await buffer.mapAsync(MAP_READ)
    const data = new Uint8Array(buffer.getMappedRange().slice(0))
    buffer.unmap()
    buffer.destroy()
    return (x, y) => (data[y * bytesPerRow + x] as number) / 255
  }

  return {
    canvas,
    get renderWidth() {
      return video.width
    },
    get renderHeight() {
      return video.height
    },
    get maskWidth() {
      return maskWidth
    },
    get maskHeight() {
      return maskHeight
    },
    details() {
      return {
        path: 'webgpu',
        copy: options.copy,
        adapter,
        delegate: segmenter.delegate,
        effect: options.effect,
        view: options.view,
        face: options.face,
        mask: maskInfo,
        maskFlipY: flip,
        autoResizeDisabled: segmenter.autoResizeDisabled,
      }
    },
    frame(el, timestampMs, out) {
      if (el.videoWidth !== video.width || el.videoHeight !== video.height) layout(el)
      if (video.width === 0 || video.height === 0) return
      if (!videoTexture) {
        videoTexture = new THREE.VideoTexture(el)
        videoTexture.colorSpace = THREE.SRGBColorSpace
        videoTexture.flipY = false
      }
      if (face) {
        const t = performance.now()
        out.faces = face.detect(el, timestampMs)
        out.trackingMs = performance.now() - t
      }
      const t0 = performance.now()
      segmenter.segment(el, timestampMs, (mask) => {
        const t1 = performance.now()
        out.segmentationMs = t1 - t0
        maskWidth = mask.width
        maskHeight = mask.height
        ensureMask(mask.width, mask.height)
        const onGpu = mask.hasWebGLTexture()
        // transfer: out of MediaPipe (blit into its canvas, or readback); upload: into the WebGPU texture.
        if (options.copy === 'canvas') copyViaCanvas(mask)
        else copyViaReadback(mask)
        const t2 = performance.now()
        out.transferMs = t2 - t1
        if (options.copy === 'canvas') uploadViaCanvas(mask)
        else uploadViaReadback(mask)
        out.uploadMs = performance.now() - t2
        maskInfo = `${mask.width}×${mask.height}, ${onGpu ? 'WebGLTexture' : 'Float32Array'} → ${options.copy === 'canvas' ? 'canvas → copyExternalImageToTexture' : 'readback → writeTexture'} → r8unorm`
        if (pendingCheck) {
          const check = pendingCheck
          pendingCheck = undefined
          check(new Float32Array(mask.getAsFloat32Array()), mask)
        }
      })
      if (!mesh) return // no mask yet
      videoTexture.needsUpdate = true
      const t = performance.now()
      renderer.render(scene, camera)
      out.renderMs = performance.now() - t
    },
    check() {
      return new Promise((resolve) => {
        pendingCheck = (ref, mask) => {
          const { width, height } = mask
          readMaskTexture(width, height).then(
            (at) => {
              const r = compareOrientation(width, height, ref, at)
              resolve(
                `webgpu/${options.copy}: WebGPU mask texture is stored ${r.orientation} (mean |Δ| direct ${r.direct.toFixed(4)}, ` +
                  `flipped ${r.flipped.toFixed(4)}; mask mean ${meanOf(ref).toFixed(3)}); expected top-first` +
                  (r.orientation === 'top-first' ? ' (correct).' : r.orientation === 'unclear' ? ': unclear, put a person in view.' : ' (WRONG).'),
              )
            },
            (err: unknown) => resolve(`check failed: ${String(err)}`),
          )
        }
      })
    },
    dispose() {
      segmenter.close()
      face?.close()
      videoTexture?.dispose()
      material?.dispose()
      geometry.dispose()
      maskTexture?.destroy()
      renderer.dispose()
    },
  }
}
