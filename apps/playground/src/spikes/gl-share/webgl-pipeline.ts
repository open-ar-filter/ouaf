import { computeVideoToClip, createVideoToClip } from '@ouaf/core'
import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  DataTexture,
  DoubleSide,
  ExternalTexture,
  FloatType,
  GLSL3,
  LinearFilter,
  Mesh,
  NearestFilter,
  RawShaderMaterial,
  RedFormat,
  SRGBColorSpace,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  Vector4,
  VideoTexture,
  WebGLRenderer,
  type Texture,
} from 'three'
import { createFaceTask, createSegmenter, type FaceTask, type MPMask, type Segmenter } from './mediapipe.ts'
import { compareOrientation, meanOf, type FrameTimings, type MaskPipeline, type SpikeOptions } from './pipeline.ts'
import type { Probe } from './probe.ts'
import { BLUR_RADIUS, FRAGMENT, VERTEX } from './shaders.ts'

/**
 * Orientation of MediaPipe's GPU mask texture: `true` when row 0 of the texture is the bottom of the image (GL
 * convention), so the shader flips v. Measured with the alignment check (`check()`, Chrome 158 desktop): MediaPipe
 * stores it top row first, like the video uploaded without flipY. The check corrects it at runtime if a browser
 * differs; `?flip=` forces it.
 */
const SHARED_MASK_FLIP_Y = false

/**
 * `?path=shared` and `?path=cpu`: three.js WebGLRenderer drawing the camera frame with the person mask applied to
 * the background.
 *
 * - shared: the ImageSegmenter is created on three's canvas, so MediaPipe and three use one WebGL2 context; the mask
 *   is MediaPipe's own texture (`MPMask.getAsWebGLTexture`), handed to three as an `ExternalTexture` and drawn
 *   inside the segmenter callback (the texture is recycled afterwards). No readback.
 * - cpu: MediaPipe runs in its own context; the mask is read back (`getAsFloat32Array`) and uploaded to a
 *   `DataTexture` in three's context every frame.
 *
 * What sharing takes (all found in this spike, MediaPipe tasks-vision 1.2.3, three 0.187):
 * 1. three creates the context first; `ImageSegmenter.createFromOptions({ canvas })` then gets the same context from
 *    `getContext('webgl2')` (three's attributes win).
 * 2. MediaPipe resizes its canvas to every input frame by default: switched off through a private API
 *    (`disableAutoResizeCanvas`), or the render resolution must equal the video resolution.
 * 3. `segmentForVideo` with a callback (the returning form clones the masks), and the draw happens inside the
 *    callback: the mask texture is MediaPipe's and is recycled when the callback returns.
 * 4. `MPMask.getAsWebGLTexture()` returns that texture as is (an R32F texture at the video size, 1280×720 here); three
 *    0.187 takes it as an `ExternalTexture` (`sourceTexture` swapped per frame, never uploaded nor deleted by three;
 *    its sampling parameters are MediaPipe's).
 * 5. `renderer.resetState()` after MediaPipe and before three draws is required: MediaPipe leaves its own framebuffer,
 *    program and textures bound, and three's state cache does not know (without it: black frame). A reset before
 *    MediaPipe is defensive (MediaPipe has not been seen to need it); each costs a few hundredths of a millisecond.
 */
export async function createWebGLPipeline(options: SpikeOptions, probe: Probe, mirrored: boolean): Promise<MaskPipeline> {
  const shared = options.path === 'shared'
  const canvas = document.createElement('canvas')
  // Same context attributes as @ouaf/core's Renderer. three creates the context first: MediaPipe's later
  // getContext('webgl2', its attributes) returns this context, with these attributes.
  const three = new WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false })
  three.setPixelRatio(1)
  three.setClearColor(0x000000, 1)
  const gl = three.getContext() as WebGL2RenderingContext
  const floatLinear = gl.getExtension('OES_texture_float_linear') !== null

  const segmenter: Segmenter = await createSegmenter({ ...(shared ? { canvas } : {}), delegate: options.delegate, probe })
  const face: FaceTask | undefined =
    options.face === 'off' ? undefined : await createFaceTask(options.face === 'shared' ? canvas : undefined)
  // MediaPipe left its state in the shared context during initialization (warm-up shaders, textures).
  three.resetState()

  const scene = new Scene()
  scene.matrixWorldAutoUpdate = false
  const camera = new Camera()

  const video = { width: 0, height: 0 }
  let videoTexture: VideoTexture | undefined
  const uVideoToClip = { value: new Vector4() }
  const uMap: { value: Texture | null } = { value: null }
  // 1×1 "everything is the person" mask, used until the first mask arrives.
  const noMask = new DataTexture(new Float32Array([1]), 1, 1, RedFormat, FloatType)
  noMask.magFilter = noMask.minFilter = NearestFilter
  noMask.needsUpdate = true
  const uMask: { value: Texture } = { value: noMask }
  const uBlurRadius = { value: new Vector2() }
  const uMaskFlipY = { value: (shared ? (options.maskFlipY ?? SHARED_MASK_FLIP_Y) : false) ? 1 : 0 }
  const uMode = { value: options.view === 'mask' ? 2 : options.effect === 'tint' ? 1 : 0 }

  const quad = new BufferGeometry()
  quad.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2))
  quad.setIndex([0, 2, 1, 2, 3, 1])
  quad.boundingSphere = new Sphere(new Vector3(0.5, 0.5, 0), 1)
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: { uVideoToClip, uMap, uMask, uBlurRadius, uMaskFlipY, uMode },
    side: DoubleSide, // mirroring flips the winding
    depthTest: false,
    depthWrite: false,
  })
  const mesh = new Mesh(quad, material)
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  scene.add(mesh)

  // shared: MediaPipe's texture, swapped in every frame. cpu: our copy, (re)allocated at the mask size.
  const external = new ExternalTexture()
  let upload: DataTexture | undefined
  let maskWidth = 0
  let maskHeight = 0
  let maskInfo = ''
  let pendingCheck: ((mask: MPMask, texture: WebGLTexture) => void) | undefined

  function layout(el: HTMLVideoElement) {
    video.width = el.videoWidth
    video.height = el.videoHeight
    three.setSize(video.width, video.height, false) // render resolution = video resolution
    const m = computeVideoToClip(video.width, video.height, video.width, video.height, 'cover', mirrored, createVideoToClip())
    uVideoToClip.value.set(m.ax, m.bx, m.ay, m.by)
    uBlurRadius.value.set(BLUR_RADIUS, (BLUR_RADIUS * video.width) / Math.max(1, video.height))
  }

  function uploadTexture(mask: MPMask, data: Float32Array): DataTexture {
    if (!upload || upload.image.width !== mask.width || upload.image.height !== mask.height) {
      upload?.dispose()
      upload = new DataTexture(data, mask.width, mask.height, RedFormat, FloatType)
      // R32F is only filterable with OES_texture_float_linear (missing on iOS): fall back to nearest there.
      upload.magFilter = upload.minFilter = floatLinear ? LinearFilter : NearestFilter
      upload.generateMipmaps = false
      upload.flipY = false // row 0 = top of the image, as video space (v down)
    } else upload.image.data = data
    upload.needsUpdate = true
    return upload
  }

  function readTexture(texture: WebGLTexture, width: number, height: number): { at: (x: number, y: number) => number; format: string } | string {
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    try {
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      if (status !== gl.FRAMEBUFFER_COMPLETE) return `mask texture not readable (framebuffer status 0x${status.toString(16)})`
      const readFormat = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number
      const readType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number
      const format = `read format 0x${readFormat.toString(16)}/type 0x${readType.toString(16)}`
      // RGBA/FLOAT is always accepted for float colour attachments (EXT_color_buffer_float).
      const pixels = new Float32Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels)
      const err = gl.getError()
      if (err === gl.NO_ERROR) return { at: (x, y) => pixels[(y * width + x) * 4] as number, format: `${format}, RGBA/FLOAT` }
      const bytes = new Uint8Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
      if (gl.getError() !== gl.NO_ERROR) return `mask texture not readable (${format})`
      return { at: (x, y) => (bytes[(y * width + x) * 4] as number) / 255, format: `${format}, RGBA/UNSIGNED_BYTE` }
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fbo)
      three.resetState()
    }
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
        path: options.path,
        delegate: segmenter.delegate,
        reset: shared ? options.reset : 'n/a',
        effect: options.effect,
        view: options.view,
        face: options.face,
        maskFlipY: uMaskFlipY.value === 1,
        mask: maskInfo,
        floatLinear,
        autoResizeDisabled: segmenter.autoResizeDisabled,
        faceAutoResizeDisabled: face?.autoResizeDisabled ?? false,
      }
    },
    frame(el, timestampMs, out) {
      if (el.videoWidth !== video.width || el.videoHeight !== video.height) layout(el)
      if (video.width === 0 || video.height === 0) return
      if (!videoTexture) {
        // See @ouaf/core's Renderer: VideoTexture, sRGB bytes passed through, no flipY, upload flagged per frame.
        videoTexture = new VideoTexture(el)
        videoTexture.colorSpace = SRGBColorSpace
        videoTexture.flipY = false
        uMap.value = videoTexture
      }

      // MediaPipe expects a default GL state; three's cache must match what MediaPipe leaves behind.
      if (shared && options.reset === 'both') three.resetState()
      if (face) {
        const t = performance.now()
        out.faces = face.detect(el, timestampMs)
        out.trackingMs = performance.now() - t
      }

      let drawn = false
      const draw = () => {
        videoTexture!.needsUpdate = true
        const t = performance.now()
        three.render(scene, camera)
        out.renderMs = performance.now() - t
        drawn = true
      }

      const t0 = performance.now()
      segmenter.segment(el, timestampMs, (mask) => {
        const t1 = performance.now()
        out.segmentationMs = t1 - t0
        maskWidth = mask.width
        maskHeight = mask.height
        let texture: WebGLTexture
        if (shared) {
          // Already a texture of this context when the GPU delegate produced it: returned as is, no copy.
          const onGpu = mask.hasWebGLTexture()
          texture = mask.getAsWebGLTexture()
          if (options.reset !== 'none') three.resetState()
          external.sourceTexture = texture
          uMask.value = external
          out.transferMs = performance.now() - t1
          maskInfo = `${mask.width}×${mask.height}, ${onGpu ? 'WebGLTexture' : mask.hasFloat32Array() ? 'Float32Array → texture' : 'Uint8Array → texture'}`
        } else {
          const onGpu = mask.hasWebGLTexture()
          const data = mask.getAsFloat32Array() // GPU → CPU readback when the mask is on the GPU
          const t2 = performance.now()
          out.transferMs = t2 - t1
          const tex = uploadTexture(mask, data)
          three.initTexture(tex) // uploads now, so the upload is timed apart from the draw
          out.uploadMs = performance.now() - t2
          uMask.value = tex
          texture = (three.properties.get(tex) as { __webglTexture: WebGLTexture }).__webglTexture
          maskInfo = `${mask.width}×${mask.height}, ${onGpu ? 'WebGLTexture (own context) → Float32Array' : 'Float32Array'} → R32F`
        }
        if (pendingCheck) {
          const check = pendingCheck
          pendingCheck = undefined
          check(mask, texture)
        }
        draw() // inside the callback: MediaPipe recycles the mask texture once it returns
      })
      if (!drawn) {
        uMask.value = noMask
        draw()
      }
    },
    check() {
      return new Promise((resolve) => {
        pendingCheck = (mask, texture) => {
          const ref = new Float32Array(mask.getAsFloat32Array()) // MediaPipe's CPU copy: row 0 = top
          if (shared) three.resetState()
          const read = readTexture(texture, mask.width, mask.height)
          if (typeof read === 'string') {
            resolve(read)
            return
          }
          const r = compareOrientation(mask.width, mask.height, ref, read.at)
          let verdict = `${options.path}: GPU mask texture is stored ${r.orientation} (mean |Δ| direct ${r.direct.toFixed(4)}, flipped ${r.flipped.toFixed(4)}; mask mean ${meanOf(ref).toFixed(3)}; ${read.format})`
          if (r.orientation !== 'unclear') {
            const flip = r.orientation === 'bottom-first'
            if (shared && options.maskFlipY === undefined) uMaskFlipY.value = flip ? 1 : 0
            verdict += `. Shader flip ${uMaskFlipY.value === 1 ? 'on' : 'off'}${(uMaskFlipY.value === 1) === flip ? ' (correct)' : ' (WRONG)'}.`
          } else verdict += '. Unclear: put a person in view (an empty mask cannot show the orientation).'
          resolve(verdict)
        }
      })
    },
    dispose() {
      segmenter.close()
      face?.close()
      videoTexture?.dispose()
      upload?.dispose()
      noMask.dispose()
      quad.dispose()
      material.dispose()
      three.dispose()
      three.forceContextLoss()
    },
  }
}
