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
}

/** Builds `frame.faces` for `uses`. `anchorNames`: the face anchors of the registry (spec §5.3). */
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

  constructor(uses: readonly ScriptUse[], anchorNames: readonly string[]) {
    this.#pose = uses.includes('face.pose')
    this.#blendshapes = uses.includes('face.blendshapes')
    this.#anchors = uses.includes('face.anchors')
    this.#landmarks = uses.includes('face.landmarks')
    this.#anchorNames = anchorNames
  }

  build(src: FrameDataSource): WireFace[] {
    const out: WireFace[] = []
    const data = src.bindingData
    if (this.#readers.length === 0) {
      for (const path of ['face.pose.yaw', 'face.pose.pitch', 'face.pose.roll', 'face.size']) this.#readers.push(data.resolve(path))
    }
    for (let i = 0; i < src.faces.count; i++) {
      const id = src.anchors.id(i)
      if (id <= 0) continue
      const face: WireFace = { id, index: i }
      if (this.#pose) {
        face.pose = { yaw: this.#read(0, i), pitch: this.#read(1, i), roll: this.#read(2, i) }
        face.size = this.#read(3, i)
      }
      if (this.#blendshapes && data.blendshapes) {
        const b: Record<string, number> = {}
        const scores = src.faces.blendshapes
        const o = i * BLENDSHAPE_NAMES.length
        for (let k = 1; k < BLENDSHAPE_NAMES.length; k++) b[BLENDSHAPE_NAMES[k]!] = scores[o + k]!
        face.blendshapes = b
      }
      if (this.#anchors) face.anchors = this.#projectAnchors(src, i)
      if (this.#landmarks) face.landmarks = landmarksToDisplay(src.faces, i, src.videoToClip)
      out.push(face)
    }
    return out
  }

  #read(reader: number, face: number): number {
    const r = this.#readers[reader]
    if (!r || r.type !== 'number') return NaN
    r.read(face, this.#x, 0)
    return this.#x[0]!
  }

  #projectAnchors(src: FrameDataSource, face: number): Record<string, [number, number]> {
    const result: Record<string, [number, number]> = {}
    const proj = src.camera.projectionMatrix
    for (const name of this.#anchorNames) {
      if (!src.anchors.face(face, name, 'auto', this.#m)) continue
      const p = this.#v.setFromMatrixPosition(this.#m).applyMatrix4(proj)
      result[name] = [(p.x + 1) / 2, (1 - p.y) / 2]
    }
    return result
  }
}

/** Landmarks of face slot `face` in normalized display space (x, y), z scaled like x. */
export function landmarksToDisplay(faces: Readonly<FaceFrame>, face: number, v: Readonly<VideoToClip>): Float32Array {
  const out = new Float32Array(LANDMARK_COUNT * 3)
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
