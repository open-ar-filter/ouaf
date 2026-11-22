/**
 * The render pipeline of the stack (spec §7): fixed stages, then stack order, then layer order.
 *
 *     background → video → face → warp → objects → color → overlay
 *
 * - `background`, `face`, `warp`, `color` are chains of full-screen passes (`PassLayer`): each reads the image so far
 *   and writes the next one, ping-ponging between two render targets.
 * - `video` draws the source frame (cover fit, mirroring), as the phase 0 renderer did.
 * - `objects` renders one scene shared by the whole stack, depth-sorted, with a perspective camera matched to the
 *   tracker (`ObjectsView.camera`); `overlay` renders a second scene after color grading.
 * - Fast path: when no pass is active, the video, objects and overlay are drawn straight into the canvas, with no
 *   render target and no copy (the common case: stickers, text, models).
 *
 * Image buffers hold sRGB-encoded bytes, like the camera texture and the canvas: raw shader passes read and write
 * them unchanged. Render targets are RGBA8 tagged sRGB, so three.js encodes the output of lit materials into them
 * exactly as it does for the canvas.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  DoubleSide,
  GLSL3,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  RawShaderMaterial,
  SRGBColorSpace,
  Scene,
  Sphere,
  Vector3,
  Vector4,
  VideoTexture,
  WebGLRenderTarget,
  WebGLRenderer,
  type Material,
  type Texture,
} from 'three'
import { computeVideoToClip, createVideoToClip, resolveRenderSize, type FitMode, type Size, type VideoToClip } from '../viewport.ts'
import { TRACKER_FOV_Y } from './anchor-provider.ts'
import type { ObjectsView, PassContext, PassLayer } from './layer-type.ts'

/** Vertex shader for full-screen passes: `position` is already in clip space; `vUv` covers [0, 1]. */
export const FULLSCREEN_VERTEX = /* glsl */ `
precision highp float;
in vec2 position;
out vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const COPY_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uInput;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = texture(uInput, vUv);
}
`

const VIDEO_VERTEX = /* glsl */ `
precision highp float;
in vec2 position; // video-space corner of the frame
uniform vec4 uVideoToClip;
out vec2 vUv;
void main() {
  vUv = position; // uploaded without flipY: t = 0 is the top row, like v
  gl_Position = vec4(uVideoToClip.x * position.x + uVideoToClip.y, uVideoToClip.z * position.y + uVideoToClip.w, 0.0, 1.0);
}
`

const VIDEO_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
in vec2 vUv;
out vec4 fragColor;
void main() {
  fragColor = vec4(texture(uMap, vUv).rgb, 1.0);
}
`

/** Minimum `readyState` for a frame to be available (`HAVE_CURRENT_DATA`). */
const HAVE_CURRENT_DATA = 2

export interface CompositorOptions {
  canvas: HTMLCanvasElement | OffscreenCanvas
  /** How the video is fitted into the canvas. Default: `cover`. */
  fit?: FitMode
  /** Internal resolution relative to the video frame size, when no fixed size is set. Default: 1. */
  scale?: number
  /** Fixed internal resolution (set both or neither). */
  width?: number
  height?: number
}

/** Passes of one frame, by stage, in stack then layer order. Inactive passes may be included; they are skipped. */
export interface StagePasses {
  background: readonly PassLayer[]
  face: readonly PassLayer[]
  warp: readonly PassLayer[]
  color: readonly PassLayer[]
}

export class Compositor implements ObjectsView {
  readonly renderer: WebGLRenderer
  readonly camera: PerspectiveCamera
  /** Scene of the `objects` stage, shared by the stack. */
  readonly objects = new Scene()
  /** Scene of the `overlay` stage. */
  readonly overlay = new Scene()

  #targets: [WebGLRenderTarget, WebGLRenderTarget]
  #video: HTMLVideoElement | undefined
  #mirrored = false
  #texture: VideoTexture | undefined
  /** The texture holds a frame of the current video. */
  #uploaded = false
  #videoMesh: Mesh<BufferGeometry, RawShaderMaterial>
  #videoScene = new Scene()
  #uVideoToClip = { value: new Vector4() }
  #uMap: { value: Texture | null } = { value: null }
  #mapping = createVideoToClip()
  #fsScene = new Scene()
  #fsCamera = new Camera()
  #fsMesh: Mesh<BufferGeometry, Material>
  #copy: RawShaderMaterial
  #uInput: { value: Texture | null } = { value: null }
  #crop = new Matrix4()
  #projection = new Matrix4()
  #fixed: Size | undefined
  #scale: number
  #fit: FitMode
  #size: Size = { width: 0, height: 0 }
  #next: Size = { width: 0, height: 0 }
  #videoWidth = 0
  #videoHeight = 0
  #pass: { renderer: WebGLRenderer; input: Texture; output: WebGLRenderTarget | null; drawFullscreen(m: Material): void }
  #disposed = false

  /** Throws when WebGL2 is not available. */
  constructor(options: CompositorOptions) {
    this.#fit = options.fit ?? 'cover'
    this.#scale = options.scale ?? 1
    if (!(this.#scale > 0)) throw new RangeError(`scale must be positive, got ${this.#scale}`)
    if ((options.width === undefined) !== (options.height === undefined)) throw new RangeError('Set both width and height, or neither.')
    this.#fixed = options.width !== undefined && options.height !== undefined ? { width: options.width, height: options.height } : undefined

    // No MSAA (costly on mobile), opaque canvas, stencil for occluders later.
    this.renderer = new WebGLRenderer({ canvas: options.canvas, antialias: false, alpha: false })
    this.renderer.setPixelRatio(1)
    this.renderer.autoClear = false
    this.renderer.setClearColor(0x000000, 1)

    this.camera = new PerspectiveCamera(TRACKER_FOV_Y, 1, 1, 10000)
    this.camera.matrixAutoUpdate = false

    const makeTarget = () => {
      const target = new WebGLRenderTarget(1, 1, { depthBuffer: true })
      target.texture.colorSpace = SRGBColorSpace
      // Plain RGBA8 storage (no hardware sRGB decode on sampling): passes read the encoded bytes, as for the video.
      target.texture.internalFormat = 'RGBA8'
      target.texture.generateMipmaps = false
      return target
    }
    this.#targets = [makeTarget(), makeTarget()]

    const quad = new BufferGeometry()
    quad.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2))
    quad.setIndex([0, 2, 1, 2, 3, 1])
    this.#videoMesh = new Mesh(
      quad,
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: VIDEO_VERTEX,
        fragmentShader: VIDEO_FRAGMENT,
        uniforms: { uVideoToClip: this.#uVideoToClip, uMap: this.#uMap },
        side: DoubleSide, // mirroring flips the winding
        depthTest: false,
        depthWrite: false,
      }),
    )
    this.#videoScene.add(prepare(this.#videoMesh))

    // One triangle covering the screen: cheaper than a quad (no diagonal seam, fewer fragments shaded twice).
    const tri = new BufferGeometry()
    tri.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2))
    this.#copy = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: COPY_FRAGMENT,
      uniforms: { uInput: this.#uInput },
      depthTest: false,
      depthWrite: false,
    })
    this.#fsMesh = new Mesh(tri, this.#copy)
    this.#fsScene.add(prepare(this.#fsMesh))

    const renderer = this.renderer
    const fsScene = this.#fsScene
    const fsCamera = this.#fsCamera
    const fsMesh = this.#fsMesh
    this.#pass = {
      renderer,
      input: this.#targets[0].texture,
      output: null,
      drawFullscreen(material: Material) {
        fsMesh.material = material
        renderer.setRenderTarget(this.output)
        renderer.render(fsScene, fsCamera)
      },
    }
    this.#updateLayout()
  }

  get width(): number {
    return this.#size.width
  }

  get height(): number {
    return this.#size.height
  }

  get mirrored(): boolean {
    return this.#mirrored
  }

  /** Current video → clip mapping (cover fit, mirroring), as the `video` stage draws it. */
  get videoToClip(): Readonly<VideoToClip> {
    return this.#mapping
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /** Sets (or clears) the video drawn by the `video` stage. */
  setVideo(video: HTMLVideoElement | undefined, mirrored: boolean): void {
    if (video !== this.#video) {
      this.#texture?.dispose()
      this.#texture = undefined
      this.#uploaded = false
      this.#video = video
      if (video) {
        // As in the phase 0 renderer: `VideoTexture` is three's upload path that works for a <video>; uploads are
        // flagged by `render`, so the drawn frame is the one that was just processed.
        this.#texture = new VideoTexture(video)
        this.#texture.colorSpace = SRGBColorSpace
        this.#texture.flipY = false
      }
      this.#uMap.value = this.#texture ?? null
    }
    this.#mirrored = mirrored
    this.#updateLayout()
  }

  /** Sets a fixed internal resolution, or follows the video size (times `scale`) without arguments. */
  setResolution(width?: number, height?: number, scale?: number): void {
    if (scale !== undefined) {
      if (!(scale > 0)) throw new RangeError(`scale must be positive, got ${scale}`)
      this.#scale = scale
    }
    if ((width === undefined) !== (height === undefined)) throw new RangeError('Set both width and height, or neither.')
    this.#fixed = width !== undefined && height !== undefined ? { width, height } : undefined
    this.#updateLayout()
  }

  /** Call before layers update: picks up video size changes (rotation) so the camera and sizes are current. */
  beginFrame(): void {
    const video = this.#video
    const vw = video?.videoWidth ?? 0
    const vh = video?.videoHeight ?? 0
    if (vw !== this.#videoWidth || vh !== this.#videoHeight) {
      this.#videoWidth = vw
      this.#videoHeight = vh
      this.#updateLayout()
    }
  }

  /** Renders one frame. `showFilters: false` renders the raw video only (filter hidden, spec §16.3). */
  render(passes: StagePasses, showFilters = true): void {
    if (this.#disposed) return
    const renderer = this.renderer
    const video = this.#video
    const hasFrame = !!video && video.videoWidth > 0 && video.readyState >= HAVE_CURRENT_DATA
    // While a paused video seeks, Chromium presents the frame (requestVideoFrameCallback) with readyState still at
    // HAVE_METADATA, and presents nothing more once the seek completes on the same frame: keep drawing the last
    // uploaded frame then, instead of a black image (#116).
    const seeking = !hasFrame && !!video && video.seeking && this.#uploaded
    this.#videoMesh.visible = hasFrame || seeking
    if (hasFrame && this.#texture) {
      this.#texture.needsUpdate = true
      this.#uploaded = true
    }

    const anyPass = showFilters && (hasActive(passes.background) || hasActive(passes.face) || hasActive(passes.warp) || hasActive(passes.color))
    if (!anyPass) {
      renderer.setRenderTarget(null)
      renderer.clear()
      renderer.render(this.#videoScene, this.#fsCamera)
      if (showFilters) {
        renderer.clearDepth()
        renderer.render(this.objects, this.camera)
        renderer.clearDepth()
        renderer.render(this.overlay, this.camera)
      }
      return
    }

    const targets = this.#targets
    let current: 0 | 1 = 0
    renderer.setRenderTarget(targets[current])
    renderer.clear()
    current = this.#runPasses(passes.background, current)
    renderer.setRenderTarget(targets[current])
    renderer.render(this.#videoScene, this.#fsCamera)
    current = this.#runPasses(passes.face, current)
    current = this.#runPasses(passes.warp, current)
    renderer.setRenderTarget(targets[current])
    renderer.clearDepth()
    renderer.render(this.objects, this.camera)
    current = this.#runPasses(passes.color, current)
    renderer.setRenderTarget(targets[current])
    renderer.clearDepth()
    renderer.render(this.overlay, this.camera)

    // Final copy to the canvas. (A later optimisation: let the last pass write to the canvas directly.)
    this.#uInput.value = targets[current].texture
    this.#fsMesh.material = this.#copy
    renderer.setRenderTarget(null)
    renderer.render(this.#fsScene, this.#fsCamera)
  }

  /** Frees GPU resources. Idempotent. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#texture?.dispose()
    for (const t of this.#targets) t.dispose()
    this.#videoMesh.geometry.dispose()
    this.#videoMesh.material.dispose()
    this.#fsMesh.geometry.dispose()
    this.#copy.dispose()
    this.renderer.dispose()
  }

  /** Runs a chain of passes starting from target `current`; returns the target holding the result. */
  #runPasses(list: readonly PassLayer[], current: 0 | 1): 0 | 1 {
    const pass = this.#pass
    for (let i = 0; i < list.length; i++) {
      const layer = list[i]!
      if (!layer.active) continue
      const next = current === 0 ? 1 : 0
      pass.input = this.#targets[current].texture
      pass.output = this.#targets[next]
      layer.render(pass as PassContext)
      current = next
    }
    return current
  }

  #updateLayout(): void {
    const vw = this.#videoWidth
    const vh = this.#videoHeight
    const next = resolveRenderSize(vw, vh, this.#fixed, this.#scale, this.#next)
    if (next.width !== this.#size.width || next.height !== this.#size.height) {
      this.#size.width = next.width
      this.#size.height = next.height
      this.renderer.setSize(next.width, next.height, false) // drawing buffer only; CSS size is the host's
      for (const t of this.#targets) t.setSize(next.width, next.height)
    }
    const m = computeVideoToClip(vw, vh, this.#size.width, this.#size.height, this.#fit, this.#mirrored, this.#mapping)
    this.#uVideoToClip.value.set(m.ax, m.bx, m.ay, m.by)

    // Objects camera: the tracker's perspective over the whole frame, then the same crop as the video, unmirrored
    // (mirroring is applied to the anchor poses, so text and models are not mirrored themselves).
    const camera = this.camera
    camera.aspect = vw > 0 && vh > 0 ? vw / vh : 1
    camera.updateProjectionMatrix()
    const sx = Math.abs(m.ax) / 2
    const sy = Math.abs(m.ay) / 2
    this.#crop.makeScale(sx, sy, 1)
    this.#projection.multiplyMatrices(this.#crop, camera.projectionMatrix)
    camera.projectionMatrix.copy(this.#projection)
    camera.projectionMatrixInverse.copy(this.#projection).invert()
  }
}

function hasActive(list: readonly PassLayer[]): boolean {
  for (let i = 0; i < list.length; i++) if (list[i]!.active) return true
  return false
}

/** Static full-screen helpers: no culling, no world matrix updates. */
function prepare<T extends Mesh>(mesh: T): T {
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  mesh.geometry.boundingSphere = new Sphere(new Vector3(), Infinity)
  return mesh
}
