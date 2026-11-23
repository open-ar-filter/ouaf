/**
 * Draw order of transparent objects (spec §7).
 *
 * three.js draws transparent objects back to front by the depth of their centre. That is right between objects far
 * apart, but objects stacked on one anchor swap as the head turns: a text 0.02 in front of its bubble sticker, a bit
 * to the side of the bubble's centre, ends up deeper than it once the head is turned, and goes behind it. So objects
 * of the **same face on the same anchor** (the screen counts as one anchor) are drawn in the order of their offset
 * along the anchor frame's z axis (lowest first: +z points towards the camera), then in stack and layer order; other
 * objects stay depth-sorted. Only the order of transparent objects changes: opaque ones and the head occluders write
 * the depth buffer.
 *
 * How: each object layer gives the placement of its instances (`ObjectLayer.placements`: object, anchor, face id,
 * offset z). Before rendering, `update` sorts the placements shown this frame into groups (stage, face, anchor) in
 * that order, and gives the members of every group of two or more a sort depth: the running minimum of their own
 * depths along the group's order (so a member is never drawn before the ones it must cover), with the group order as
 * tie-break. `compare`, installed with `renderer.setTransparentSort`, sorts by that depth for those objects (their
 * meshes: the descendants of a model's instance share it, ordered among themselves by their own depth) and by three's
 * own depth for every other object. Each item has one fixed key, so the order is a total order (Array.sort needs
 * one), and objects of different groups keep their depth order.
 *
 * `update` and `compare` allocate nothing.
 */
import { Matrix4, Vector3, type Camera, type Object3D } from 'three'
import type { ObjectLayer, ObjectPlacement } from './layer-type.ts'

/** What `compare` reads of a three.js render item. */
export interface DrawItem {
  readonly id: number
  readonly object: Object3D
  readonly groupOrder: number
  readonly renderOrder: number
  /** Depth of the item's centre in clip space (larger: farther). */
  readonly z: number
}

interface Entry {
  readonly placement: ObjectPlacement
  /** The layer's root: hidden (a canvas before its first draw) or out of the scene, the instance is not drawn. */
  readonly root: Object3D
  /** Stack order, then layer order. */
  readonly rank: number
  /** 0: objects, 1: overlay, 2: overlay left out of captures (separate scenes, never ordered together). */
  readonly stage: number
  /** Clip-space depth of the instance's origin this frame. */
  depth: number
  /** Sort depth in its group (running minimum of the depths). */
  sortZ: number
  /** Position in the frame's sorted list: the order within a group, a tie-break between groups. */
  seq: number
  /** In a group of two or more this frame: `compare` uses `sortZ` and `seq`. */
  grouped: boolean
}

/** Key in `userData`: the placement's entry on its object, `null` on a layer root (stops the lookup). */
const ENTRY = Symbol('ouaf.drawOrder')

type Stamped = Record<symbol, Entry | null | undefined>

/** The entry of the grouped instance `object` belongs to, if any. */
function entryOf(object: Object3D): Entry | undefined {
  for (let o: Object3D | null = object; o !== null; o = o.parent) {
    const e = (o.userData as Stamped)[ENTRY]
    if (e !== undefined) return e !== null && e.grouped ? e : undefined
  }
  return undefined
}

/** Group key of an entry, compared field by field: stage, face (0 on the screen), anchor. */
function sameGroup(a: Entry, b: Entry): boolean {
  return a.stage === b.stage && faceOf(a) === faceOf(b) && a.placement.anchor === b.placement.anchor
}

function faceOf(e: Entry): number {
  return e.placement.anchor === 'screen' ? 0 : e.placement.face
}

/** Order of the sorted list: by group, then offset z (back first), then stack and layer order. */
function before(a: Entry, b: Entry): boolean {
  if (a.stage !== b.stage) return a.stage < b.stage
  const fa = faceOf(a)
  const fb = faceOf(b)
  if (fa !== fb) return fa < fb
  const na = a.placement.anchor
  const nb = b.placement.anchor
  if (na !== nb) return na < nb
  const za = a.placement.z
  const zb = b.placement.z
  if (za !== zb) return za < zb
  return a.rank < b.rank
}

export class DrawOrder {
  #entries: Entry[] = []
  /** The entries shown this frame, sorted (its first `#count` items). */
  #sorted: Entry[] = []
  #count = 0
  readonly #projection = new Matrix4()
  readonly #v = new Vector3()

  /** The object layers of the stack, in stack then layer order (after every stack change). */
  setLayers(layers: readonly ObjectLayer[]): void {
    for (const e of this.#entries) e.grouped = false
    const entries: Entry[] = []
    for (let rank = 0; rank < layers.length; rank++) {
      const layer = layers[rank]!
      const stage = layer.stage === 'overlay' ? (layer.excludeFromCapture ? 2 : 1) : 0
      const root = layer.object
      ;(root.userData as Stamped)[ENTRY] = null
      for (const placement of layer.placements ?? []) {
        const entry: Entry = { placement, root, rank, stage, depth: 0, sortZ: 0, seq: 0, grouped: false }
        ;(placement.object.userData as Stamped)[ENTRY] = entry
        entries.push(entry)
      }
    }
    this.#entries = entries
    this.#sorted = entries.slice()
    this.#count = 0
  }

  /** Called before rendering, once the layers are updated: sorts the instances shown and gives groups their depth. */
  update(camera: Camera): void {
    const projection = this.#projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    const entries = this.#entries
    const sorted = this.#sorted
    const v = this.#v
    let n = 0
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      e.grouped = false
      const object = e.placement.object
      if (!object.visible || !e.root.visible || e.root.parent === null) continue
      // The layer root is the identity (layer contract): the instance's matrix places it in the scene. Depth as three
      // computes it for a quad: its origin through the camera, in clip space.
      const m = object.matrix.elements
      e.depth = v.set(m[12]!, m[13]!, m[14]!).applyMatrix4(projection).z
      // Insertion sort: stable, allocation-free, and nearly linear since the order rarely changes between frames.
      let j = n++
      while (j > 0 && before(e, sorted[j - 1]!)) {
        sorted[j] = sorted[j - 1]!
        j--
      }
      sorted[j] = e
    }
    this.#count = n
    let start = 0
    while (start < n) {
      let end = start + 1
      while (end < n && sameGroup(sorted[start]!, sorted[end]!)) end++
      if (end - start > 1) {
        let z = Infinity
        for (let k = start; k < end; k++) {
          const e = sorted[k]!
          // three draws the larger depth first: a member is drawn no earlier than the members before it.
          if (e.depth < z) z = e.depth
          e.sortZ = z
          e.seq = k
          e.grouped = true
        }
      }
      start = end
    }
  }

  /** Placements shown at the last `update`, in group order (tests). */
  get order(): readonly ObjectPlacement[] {
    const out: ObjectPlacement[] = []
    for (let i = 0; i < this.#count; i++) out.push(this.#sorted[i]!.placement)
    return out
  }

  /**
   * Transparent sort of the renderer (`setTransparentSort`): three's own (`groupOrder`, `renderOrder`, depth back to
   * front, id), with the sort depth of grouped instances, and their group order on a tie.
   *
   * Depths are compared rather than subtracted: `Array.prototype.sort` only reads the sign, and a fractional number
   * returned to it is boxed, i.e. allocated, on every comparison (it is a builtin: it never inlines the comparator).
   */
  readonly compare = (a: DrawItem, b: DrawItem): number => {
    if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder
    if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder
    const ea = entryOf(a.object)
    const eb = entryOf(b.object)
    const za = ea !== undefined ? ea.sortZ : a.z
    const zb = eb !== undefined ? eb.sortZ : b.z
    if (za !== zb) return zb > za ? 1 : zb < za ? -1 : 0
    const sa = ea !== undefined ? ea.seq : -1
    const sb = eb !== undefined ? eb.seq : -1
    if (sa !== sb) return sa - sb
    if (a.z !== b.z) return b.z > a.z ? 1 : b.z < a.z ? -1 : 0
    return a.id - b.id
  }
}

/** A placement for `object` on `anchor` (`ObjectLayer.placements`); the layer updates `face` and `z` every frame. */
export function createPlacement(object: Object3D, anchor: string): ObjectPlacement {
  // `z` starts as a fraction, so that the field holds doubles from the start (writing one never changes its shape).
  return { object, anchor, face: 0, z: 0.5 }
}
