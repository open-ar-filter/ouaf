import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  DoubleSide,
  DynamicDrawUsage,
  GLSL3,
  Mesh,
  Points,
  RawShaderMaterial,
  SRGBColorSpace,
  Scene,
  Sphere,
  Vector3,
  Vector4,
  VideoTexture,
  WebGLRenderer,
} from 'three'
import { LANDMARKS_STRIDE, LANDMARK_COUNT, type FaceFrame } from './face.ts'
import { computeVideoToClip, createVideoToClip, resolveRenderSize, type FitMode, type Size } from './viewport.ts'

export interface RendererOptions {
  /** Video element playing the camera stream (`CameraSource.video`). */
  video: HTMLVideoElement
  /** Mirror the image and everything drawn over it (`CameraSource.mirrored`). */
  mirrored: boolean
  /** Capacity of the landmark debug layer; faces beyond it are not drawn. */
  maxFaces: number
  /** Canvas to render into. Default: a new, detached canvas (see `Renderer.canvas`). */
  canvas?: HTMLCanvasElement
  /**
   * Fixed internal render resolution (drawing buffer size, in pixels), independent from the canvas CSS size.
   * Set both or neither. Default: follow the video frame size times `scale`.
   */
  width?: number
  height?: number
  /** Internal resolution relative to the video frame size, when no fixed resolution is set. Default: 1. */
  scale?: number
  /** How the video is fitted into the render target when their aspect ratios differ. Default: `'cover'`. */
  fit?: FitMode
  /** Draw the 478 landmarks of each face (debug layer). Default: false. */
  debugLandmarks?: boolean
  /** Landmark point diameter in internal-resolution pixels. Default: scaled with the resolution. */
  landmarkSize?: number
}

/** Minimum `readyState` for a frame to be available (`HAVE_CURRENT_DATA`). */
const HAVE_CURRENT_DATA = 2

// Both vertex shaders map video space (u right, v down, [0, 1]) to clip space with the same uniform:
// x = ax·u + bx, y = ay·v + by, with uVideoToClip = (ax, bx, ay, by) from `computeVideoToClip`.
const VIDEO_TO_CLIP = /* glsl */ `
uniform vec4 uVideoToClip;
vec4 videoToClip(vec2 uv) {
  return vec4(uVideoToClip.x * uv.x + uVideoToClip.y, uVideoToClip.z * uv.y + uVideoToClip.w, 0.0, 1.0);
}
`

const BACKGROUND_VERTEX = /* glsl */ `
precision highp float;
in vec2 position; // video-space corner of the frame
out vec2 vUv;
${VIDEO_TO_CLIP}
void main() {
  vUv = position; // the texture is uploaded without flipY: t = 0 is the top row, like v
  gl_Position = videoToClip(position);
}
`

// The texture holds the camera's sRGB-encoded bytes in an RGBA8 texture (no hardware decode, see `#texture`) and
// the canvas expects sRGB-encoded output: decoding to linear then re-encoding would be the identity, so the
// colour is passed through unchanged.
const BACKGROUND_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = vec4(texture(uMap, vUv).rgb, 1.0);
}
`

const LANDMARKS_VERTEX = /* glsl */ `
precision highp float;
in vec3 position; // landmark as returned by the tracker: u, v (video space), z (unused)
uniform float uPointSize;
flat out int vFace;
${VIDEO_TO_CLIP}
void main() {
  vFace = gl_VertexID / ${LANDMARK_COUNT}; // faces are stored back to back, ${LANDMARK_COUNT} points each
  gl_Position = videoToClip(position.xy);
  gl_PointSize = uPointSize;
}
`

// sRGB-encoded output colours, one per face slot.
const LANDMARKS_FRAGMENT = /* glsl */ `
precision mediump float;
flat in int vFace;
out vec4 fragColor;
const vec3 PALETTE[4] = vec3[4](vec3(0.0, 1.0, 0.8), vec3(1.0, 0.2, 0.8), vec3(1.0, 0.85, 0.0), vec3(0.4, 0.6, 1.0));
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard; // round points
  fragColor = vec4(PALETTE[vFace % 4], 1.0);
}
`

/**
 * WebGL2 renderer (three.js): draws the camera frame as the background (stage `video` of the render order) and,
 * optionally, a debug layer with the landmarks of every tracked face. One canvas, one WebGL2 context.
 *
 * - Fit: `cover` by default (see `FitMode`). The background and the landmarks share one video → clip mapping
 *   (`computeVideoToClip`), uploaded as a single uniform, so they cannot drift apart.
 * - Mirroring is applied by that mapping, to the background and the overlays alike: what is drawn is what is
 *   displayed and captured. `FaceFrame` data stays unmirrored.
 * - The internal resolution (drawing buffer) is independent from the CSS size of the canvas: size the canvas
 *   with CSS; set the resolution with the options or `setResolution`.
 * - `render` is meant to be called once per new camera frame (`FrameScheduler`), right after tracking: it
 *   uploads that frame, so the background and the landmarks always belong to the same frame. It allocates
 *   nothing itself (typed arrays and uniforms are reused; the landmark buffer is updated in place).
 */
export class Renderer {
  /** The canvas rendered into. When the renderer created it, the host attaches it to the DOM (and removes it). */
  readonly canvas: HTMLCanvasElement
  readonly video: HTMLVideoElement
  readonly maxFaces: number

  #three: WebGLRenderer
  #scene = new Scene()
  #camera = new Camera() // unused by the shaders, required by three
  #texture: VideoTexture
  #background: Mesh<BufferGeometry, RawShaderMaterial>
  #landmarks: Points<BufferGeometry, RawShaderMaterial>
  #positions: Float32Array
  #positionAttribute: BufferAttribute
  #mapping = createVideoToClip()
  #uVideoToClip = { value: new Vector4() }
  #uPointSize = { value: 1 }
  #fixedSize: Size | undefined
  #scale: number
  #size: Size = { width: 0, height: 0 }
  #nextSize: Size = { width: 0, height: 0 }
  #videoWidth = 0
  #videoHeight = 0
  #fit: FitMode
  #mirrored: boolean
  #landmarkSize: number | undefined
  #ownsCanvas: boolean
  #disposed = false

  /** Throws when WebGL2 is not available. */
  constructor(options: RendererOptions) {
    const { video, maxFaces } = options
    if (!Number.isInteger(maxFaces) || maxFaces < 1) throw new RangeError(`maxFaces must be a positive integer, got ${maxFaces}`)
    this.video = video
    this.maxFaces = maxFaces
    this.#mirrored = options.mirrored
    this.#fit = options.fit ?? 'cover'
    this.#scale = options.scale ?? 1
    if (!(this.#scale > 0)) throw new RangeError(`scale must be positive, got ${this.#scale}`)
    this.#fixedSize = checkFixedSize(options.width, options.height)
    this.#landmarkSize = options.landmarkSize
    this.#ownsCanvas = !options.canvas
    this.canvas = options.canvas ?? document.createElement('canvas')

    // three.js only creates WebGL2 contexts. No MSAA (costly on mobile, useless for a video background), opaque
    // canvas (cheaper compositing), no stencil.
    this.#three = new WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: false, stencil: false })
    this.#three.setPixelRatio(1) // the drawing buffer size is the internal resolution, not CSS px × DPR
    this.#three.setClearColor(0x000000, 1)
    this.#scene.matrixWorldAutoUpdate = false // nothing moves: the shaders work in video/clip space

    // `VideoTexture` is three's only upload path that works for a <video>: mutable storage re-specified from
    // `videoWidth`/`videoHeight` at each upload (so a size change needs nothing special), RGBA8 with no hardware
    // sRGB decode (an SRGB8_ALPHA8 video upload can fall off the browsers' fast GPU path). A plain `Texture`
    // sizes its immutable storage from the element's `width` attribute (0) and never shows the video.
    // Its own requestVideoFrameCallback loop, which also flags uploads, is not ordered with the frame
    // scheduler's, so it is not relied upon: `render` flags the upload itself, so the background is always the
    // frame that was just tracked (the upload happens at most once per `render`).
    this.#texture = new VideoTexture(video)
    this.#texture.colorSpace = SRGBColorSpace // the content is sRGB-encoded; the shader passes it through
    this.#texture.flipY = false

    const quad = new BufferGeometry()
    quad.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2))
    quad.setIndex([0, 2, 1, 2, 3, 1])
    this.#background = new Mesh(
      quad,
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: BACKGROUND_VERTEX,
        fragmentShader: BACKGROUND_FRAGMENT,
        uniforms: { uVideoToClip: this.#uVideoToClip, uMap: { value: this.#texture } },
        side: DoubleSide, // mirroring flips the winding
        depthTest: false,
        depthWrite: false,
      }),
    )
    this.#background.renderOrder = 0

    // One `Points` object for every face: the buffer is sized once for `maxFaces` and updated in place; the draw
    // range limits it to the faces of the frame.
    this.#positions = new Float32Array(maxFaces * LANDMARKS_STRIDE)
    this.#positionAttribute = new BufferAttribute(this.#positions, 3)
    this.#positionAttribute.setUsage(DynamicDrawUsage)
    const points = new BufferGeometry()
    points.setAttribute('position', this.#positionAttribute)
    points.setDrawRange(0, 0)
    this.#landmarks = new Points(
      points,
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: LANDMARKS_VERTEX,
        fragmentShader: LANDMARKS_FRAGMENT,
        uniforms: { uVideoToClip: this.#uVideoToClip, uPointSize: this.#uPointSize },
        depthTest: false,
        depthWrite: false,
      }),
    )
    this.#landmarks.renderOrder = 1
    this.#landmarks.visible = options.debugLandmarks ?? false

    for (const object of [this.#background, this.#landmarks]) {
      // Positions are not in world space: no frustum culling, and a fixed bounding sphere so three does not
      // compute one (it only feeds the render-list sort).
      object.frustumCulled = false
      object.geometry.boundingSphere = new Sphere(new Vector3(0.5, 0.5, 0), 1)
      object.matrixAutoUpdate = false
      this.#scene.add(object)
    }

    this.#videoWidth = video.videoWidth
    this.#videoHeight = video.videoHeight
    this.#updateLayout()
  }

  /** Internal render resolution (drawing buffer size, in pixels). */
  get width(): number {
    return this.#size.width
  }

  get height(): number {
    return this.#size.height
  }

  get mirrored(): boolean {
    return this.#mirrored
  }

  set mirrored(value: boolean) {
    this.#mirrored = value
    this.#updateLayout()
  }

  get fit(): FitMode {
    return this.#fit
  }

  set fit(value: FitMode) {
    this.#fit = value
    this.#updateLayout()
  }

  get debugLandmarks(): boolean {
    return this.#landmarks.visible
  }

  set debugLandmarks(value: boolean) {
    this.#landmarks.visible = value
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /**
   * Sets a fixed internal resolution, or, without arguments, follows the video frame size again (times
   * `scale`, when given). The CSS size of the canvas is not touched.
   */
  setResolution(width?: number, height?: number, scale?: number): void {
    if (scale !== undefined) {
      if (!(scale > 0)) throw new RangeError(`scale must be positive, got ${scale}`)
      this.#scale = scale
    }
    this.#fixedSize = checkFixedSize(width, height)
    this.#updateLayout()
  }

  /**
   * Draws the video's current frame and, when enabled, the landmarks of `faces` (only the first `count`, up to
   * `maxFaces`). Call once per new frame; allocation-free in the steady state.
   */
  render(faces: FaceFrame): void {
    if (this.#disposed) return
    const video = this.video
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw !== this.#videoWidth || vh !== this.#videoHeight) {
      // Phone rotation: new aspect ratio (and internal resolution, when it follows the video).
      this.#videoWidth = vw
      this.#videoHeight = vh
      this.#updateLayout()
    }

    const hasFrame = vw > 0 && vh > 0 && video.readyState >= HAVE_CURRENT_DATA
    this.#background.visible = hasFrame
    if (hasFrame) this.#texture.needsUpdate = true

    const count = this.#landmarks.visible ? Math.max(0, Math.min(faces.count, this.maxFaces)) : 0
    if (count > 0) {
      const src = faces.landmarks
      const dst = this.#positions
      const n = count * LANDMARKS_STRIDE
      for (let i = 0; i < n; i++) dst[i] = src[i] as number
      this.#positionAttribute.needsUpdate = true
    }
    this.#landmarks.geometry.setDrawRange(0, count * LANDMARK_COUNT)

    this.#three.render(this.#scene, this.#camera)
  }

  /** Frees every GPU resource (and the WebGL context when the renderer created the canvas). Idempotent. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#texture.dispose()
    this.#background.geometry.dispose()
    this.#background.material.dispose()
    this.#landmarks.geometry.dispose()
    this.#landmarks.material.dispose()
    this.#three.dispose()
    // Browsers cap the number of live contexts; release ours now rather than at garbage collection. A canvas
    // provided by the host is left usable.
    if (this.#ownsCanvas) this.#three.forceContextLoss()
  }

  /** Applies the resolution and the video → clip mapping after a size, fit or mirroring change. */
  #updateLayout(): void {
    const next = resolveRenderSize(this.#videoWidth, this.#videoHeight, this.#fixedSize, this.#scale, this.#nextSize)
    if (next.width !== this.#size.width || next.height !== this.#size.height) {
      this.#size.width = next.width
      this.#size.height = next.height
      this.#three.setSize(next.width, next.height, false) // drawing buffer only; CSS size is the host's
    }
    const m = computeVideoToClip(this.#videoWidth, this.#videoHeight, this.#size.width, this.#size.height, this.#fit, this.#mirrored, this.#mapping)
    this.#uVideoToClip.value.set(m.ax, m.bx, m.ay, m.by)
    this.#uPointSize.value = this.#landmarkSize ?? defaultLandmarkSize(this.#size.width, this.#size.height)
  }
}

/** Creates a renderer; see `Renderer`. Throws when WebGL2 is not available. */
export function createRenderer(options: RendererOptions): Renderer {
  return new Renderer(options)
}

/** Landmark diameter readable at any resolution: about 4 px at 720p. */
export function defaultLandmarkSize(width: number, height: number): number {
  return Math.max(2, Math.round(Math.min(width, height) / 180))
}

function checkFixedSize(width: number | undefined, height: number | undefined): Size | undefined {
  if (width === undefined && height === undefined) return undefined
  if (width === undefined || height === undefined) throw new RangeError('Set both width and height, or neither.')
  if (!(width >= 1 && height >= 1)) throw new RangeError(`Invalid render resolution ${width}×${height}`)
  return { width, height }
}
