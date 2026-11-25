/**
 * The face-mask mesh (`face-mask.ts`) as a three.js geometry, shared by the color layer (`region: "face"`) and the
 * shader layer (`face` stage, `ouaf_faceMask`): clip-space positions of up to `maxFaces` face ovals, with the mask
 * value of each vertex (`mask` attribute), rewritten every frame without allocating.
 */
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Sphere, Vector3 } from 'three'
import type { FaceFrame } from '../../face.ts'
import { MASK_INDICES, MASK_VERTICES, faceMaskIndices, faceMaskValues, writeFaceMask } from './face-mask.ts'

export class FaceMaskMesh {
  readonly geometry = new BufferGeometry()
  readonly #positions: BufferAttribute
  readonly #maxFaces: number

  constructor(maxFaces: number) {
    this.#maxFaces = maxFaces
    this.#positions = new BufferAttribute(new Float32Array(maxFaces * MASK_VERTICES * 2), 2).setUsage(DynamicDrawUsage)
    this.geometry.setAttribute('position', this.#positions)
    this.geometry.setAttribute('mask', new BufferAttribute(faceMaskValues(maxFaces), 1))
    this.geometry.setIndex(new BufferAttribute(faceMaskIndices(maxFaces), 1))
    // Clip-space positions: never culled.
    this.geometry.boundingSphere = new Sphere(new Vector3(), Infinity)
  }

  /**
   * Places the ovals of the first `count` faces (at most `maxFaces`) and draws only those. `projection` is the
   * objects camera's projection matrix (`camera.projectionMatrix.elements`).
   */
  update(faces: Readonly<FaceFrame>, count: number, mirrored: boolean, projection: ArrayLike<number>): void {
    const n = Math.min(count, this.#maxFaces)
    const out = this.#positions.array as Float32Array
    for (let f = 0; f < n; f++) writeFaceMask(faces, f, f, mirrored, projection, out)
    this.#positions.needsUpdate = true
    this.geometry.setDrawRange(0, n * MASK_INDICES)
  }

  dispose(): void {
    this.geometry.dispose()
  }
}
