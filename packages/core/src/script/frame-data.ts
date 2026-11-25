/**
 * The `frame.faces` data a script receives (spec §12.4), limited to what `script.uses` declares (spec §15.2: data
 * minimization). Positions are in display space, normalized: 0 to 1 over the displayed image, origin at the top
 * left, y down, mirroring applied.
 */
import type { ScriptUse } from '@ouaf/spec'
import { Matrix4, Vector3, type Camera } from 'three'
import { BLENDSHAPE_NAMES, LANDMARK_COUNT, LANDMARKS_STRIDE, type FaceFrame } from '../face.ts'
import type { AnchorProvider } from '../engine/anchor-provider.ts'
import type { FaceBindingData } from '../bindings/face-data.ts'
import type { VideoToClip } from '../viewport.ts'
import type { WireFace } from './runtime.ts'

export interface FrameDataSource {
  readonly faces: Readonly<FaceFrame>
  readonly anchors: AnchorProvider
  readonly bindingData: FaceBindingData
  /** Camera of the objects stage (anchors are projected with it). */
  readonly camera: Camera
  /** Video → clip mapping of the view, mirroring included (landmarks). */
  readonly videoToClip: Readonly<VideoToClip>
  /** Displayed width / height (`frame.aspect`, spec §12.4). */
  readonly aspect: number
}

/** `frame.faces` and `frame.blendshapes` of one frame (`WireFrame`); the next `build` reuses them. */
export interface FrameFaces {
  readonly faces: WireFace[]
  blendshapes: Float32Array | undefined
}

/**
 * Builds `frame.faces` for `uses`. `anchorNames`: the face anchors of the registry (spec §5.3).
 *
 * It allocates nothing per frame in the steady state (#129): the faces, their `pose`, `anchors` and `landmarks`, and
 * the blendshape scores are reused from one build to the next, which the structured clone of `postMessage` allows (it
 * copies them at the call). The engine sends each build before the next one.
 */
export class FrameDataBuilder {
  readonly #pose: boolean
  readonly #blendshapes: boolean
  readonly #anchors: boolean
  readonly #landmarks: boolean
  readonly #anchorNames: readonly string[]
  readonly #readers: ReturnType<FaceBindingData['resolve']>[] = []
  readonly #x = new Float64Array(1)
  readonly #m = new Matrix4()
  readonly #v = new Vector3()
  readonly #out: FrameFaces = { faces: [], blendshapes: undefined }
  /** The face objects, by position in `frame.faces`. */
  readonly #pool: WireFace[] = []
  /** Blendshape scores, by number of faces. */
  readonly #scores: Float32Array[] = []

  constructor(uses: readonly ScriptUse[], anchorNames: readonly string[]) {
    this.#pose = uses.includes('face.pose')
    this.#blendshapes = uses.includes('face.blendshapes')
    this.#anchors = uses.includes('face.anchors')
    this.#landmarks = uses.includes('face.landmarks')
    this.#anchorNames = anchorNames
  }

  build(src: FrameDataSource): FrameFaces {
    const out = this.#out
    const faces = out.faces
    const data = src.bindingData
    if (this.#readers.length === 0) {
      for (const path of ['face.pose.yaw', 'face.pose.pitch', 'face.pose.roll', 'face.size']) this.#readers.push(data.resolve(path))
    }
    let n = 0
    for (let i = 0; i < src.faces.count; i++) {
      const id = src.anchors.id(i)
      if (id <= 0) continue
      const face = (this.#pool[n] ??= this.#newFace())
      face.id = id
      face.index = i
      if (this.#pose) {
        const pose = face.pose!
        pose.yaw = this.#read(0, i)
        pose.pitch = this.#read(1, i)
        pose.roll = this.#read(2, i)
        face.size = this.#read(3, i)
      }
      if (this.#anchors) this.#projectAnchors(src, i, face.anchors!)
      if (this.#landmarks) landmarksToDisplay(src.faces, i, src.videoToClip, face.landmarks)
      faces[n++] = face
    }
    // The length changes only when the number of faces does.
    if (faces.length !== n) faces.length = n
    out.blendshapes = this.#blendshapes && data.blendshapes && n > 0 ? this.#copyScores(src, n) : undefined
    return out
  }

  #newFace(): WireFace {
    const face: WireFace = { id: 0, index: 0 }
    if (this.#pose) {
      face.pose = { yaw: 0, pitch: 0, roll: 0 }
      face.size = 0
    }
    if (this.#anchors) face.anchors = {}
    if (this.#landmarks) face.landmarks = new Float32Array(LANDMARK_COUNT * 3)
    return face
  }

  /** The blendshape scores of the `n` faces of `frame.faces`, in their order. */
  #copyScores(src: FrameDataSource, n: number): Float32Array {
    const stride = BLENDSHAPE_NAMES.length
    const scores = (this.#scores[n] ??= new Float32Array(n * stride))
    const from = src.faces.blendshapes
    const faces = this.#out.faces
    for (let k = 0; k < n; k++) {
      const o = faces[k]!.index * stride
      for (let j = 0; j < stride; j++) scores[k * stride + j] = from[o + j]!
    }
    return scores
  }

  #read(reader: number, face: number): number {
    const r = this.#readers[reader]
    if (!r || r.type !== 'number') return NaN
    r.read(face, this.#x, 0)
    return this.#x[0]!
  }

  /** Projects the anchors of face slot `face` into `result`; the ones not found this frame are left out. */
  #projectAnchors(src: FrameDataSource, face: number, result: Record<string, [number, number]>): void {
    const proj = src.camera.projectionMatrix
    for (const name of this.#anchorNames) {
      if (!src.anchors.face(face, name, 'auto', this.#m)) {
        if (Object.hasOwn(result, name)) delete result[name]
        continue
      }
      const p = this.#v.setFromMatrixPosition(this.#m).applyMatrix4(proj)
      const xy = Object.hasOwn(result, name) ? result[name]! : (result[name] = [0, 0])
      xy[0] = (p.x + 1) / 2
      xy[1] = (1 - p.y) / 2
    }
  }
}

/** Landmarks of face slot `face` in normalized display space (x, y), z scaled like x; written to `out` if given. */
export function landmarksToDisplay(faces: Readonly<FaceFrame>, face: number, v: Readonly<VideoToClip>, out: Float32Array = new Float32Array(LANDMARK_COUNT * 3)): Float32Array {
  const src = faces.landmarks
  const o = face * LANDMARKS_STRIDE
  const zScale = Math.abs(v.ax) / 2
  for (let k = 0; k < LANDMARK_COUNT; k++) {
    const x = src[o + 3 * k]!
    const y = src[o + 3 * k + 1]!
    out[3 * k] = (v.ax * x + v.bx + 1) / 2
    out[3 * k + 1] = (1 - (v.ay * y + v.by)) / 2
    out[3 * k + 2] = src[o + 3 * k + 2]! * zScale
  }
  return out
}
