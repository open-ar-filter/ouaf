import { Group, Matrix4, Mesh, Object3D, PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { DrawOrder, createPlacement, type DrawItem } from '../src/engine/draw-order.ts'
import type { ObjectLayer, ObjectPlacement } from '../src/engine/layer-type.ts'
import { bytesPerCall } from './allocation.ts'

const camera = new PerspectiveCamera(60, 1, 1, 10000)
camera.updateMatrixWorld()

/** An object layer whose instances are plain objects at the given positions (camera space, cm). */
function layer(instances: Array<{ at: [number, number, number]; anchor?: string; face?: number; z?: number }>, stage: 'objects' | 'overlay' = 'objects'): ObjectLayer & { placements: ObjectPlacement[] } {
  const root = new Group()
  const scene = new Group()
  scene.add(root)
  const placements = instances.map((i) => {
    const object = new Mesh()
    object.matrixAutoUpdate = false
    object.matrix.makeTranslation(...i.at)
    root.add(object)
    const p = createPlacement(object, i.anchor ?? 'head')
    p.face = i.face ?? 1
    p.z = i.z ?? 0
    return p
  })
  return { kind: 'object', stage, object: root, placements, update() {}, dispose() {} }
}

let nextId = 1
/** A render item as three makes it: the clip-space depth of the object's (world) origin. */
function item(object: Object3D): DrawItem {
  let top = object
  while (top.parent) top = top.parent
  top.updateMatrixWorld(true)
  const v = new Vector3().setFromMatrixPosition(object.matrixWorld).applyMatrix4(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
  return { id: nextId++, object, groupOrder: 0, renderOrder: 0, z: v.z }
}

/** The objects in the order the comparator draws them. */
function drawn(order: DrawOrder, objects: Object3D[]): Object3D[] {
  return objects.map(item).sort(order.compare).map((i) => i.object)
}

describe('draw order of transparent objects (spec §7)', () => {
  it('draws objects of the same face on the same anchor by offset z, whatever their depth', () => {
    // A bubble and a text 0.02 in front of it on the head anchor; the head turned, the text's centre is deeper.
    const bubble = layer([{ at: [0, 0, -50], z: 0 }])
    const text = layer([{ at: [3, 0, -50.5], z: 0.02 }])
    const order = new DrawOrder()
    order.setLayers([text, bubble]) // the text is first in the layer list: offset z decides
    order.update(camera)
    const b = bubble.placements[0]!.object
    const t = text.placements[0]!.object
    expect(drawn(order, [t, b])).toEqual([b, t])
    expect(drawn(order, [b, t])).toEqual([b, t])
  })

  it('orders equal offsets by stack then layer order', () => {
    const a = layer([{ at: [0, 0, -40], z: 0.1 }])
    const b = layer([{ at: [0, 0, -45], z: 0.1 }])
    const order = new DrawOrder()
    order.setLayers([b, a])
    order.update(camera)
    expect(drawn(order, [a.placements[0]!.object, b.placements[0]!.object])).toEqual([b.placements[0]!.object, a.placements[0]!.object])
    expect(order.order).toEqual([b.placements[0], a.placements[0]])
  })

  it('keeps depth order between different anchors, faces and stages', () => {
    const near = { at: [0, 0, -40] as [number, number, number], z: -1 }
    const far = { at: [0, 0, -60] as [number, number, number], z: 1 }
    const cases = [
      [layer([{ ...near, anchor: 'mouth' }]), layer([{ ...far, anchor: 'head' }])],
      [layer([{ ...near, face: 1 }]), layer([{ ...far, face: 2 }])],
      [layer([near], 'overlay'), layer([far])],
    ]
    for (const [n, f] of cases) {
      const order = new DrawOrder()
      order.setLayers([n!, f!])
      order.update(camera)
      const no = n!.placements[0]!.object
      const fo = f!.placements[0]!.object
      expect(drawn(order, [no, fo])).toEqual([fo, no]) // back to front
    }
  })

  it('counts the screen as one anchor, whatever the face', () => {
    const a = layer([{ at: [0, 0, -10], anchor: 'screen', face: 3, z: 0 }])
    const b = layer([{ at: [0.5, 0, -10.2], anchor: 'screen', face: 0, z: 0.01 }])
    const order = new DrawOrder()
    order.setLayers([a, b])
    order.update(camera)
    expect(drawn(order, [b.placements[0]!.object, a.placements[0]!.object])).toEqual([a.placements[0]!.object, b.placements[0]!.object])
  })

  it('places a group among other objects by depth, and its members never before the ones they cover', () => {
    // Group on face 1's head: back (depth 50), front (offset z higher, but at 52, deeper). Another face's object at 51.
    const back = layer([{ at: [0, 0, -50], z: 0 }])
    const front = layer([{ at: [0, 0, -52], z: 1 }])
    const other = layer([{ at: [0, 0, -51], face: 2 }])
    const lone = layer([{ at: [0, 0, -70], anchor: 'chin' }])
    const order = new DrawOrder()
    order.setLayers([back, front, other, lone])
    order.update(camera)
    const [b, f, o, l] = [back, front, other, lone].map((x) => x.placements[0]!.object)
    // `front` is drawn with `back`'s depth, right after it; `other` (51) is farther, so before both.
    expect(drawn(order, [b!, f!, o!, l!])).toEqual([l, o, b, f])
    expect(drawn(order, [f!, l!, b!, o!])).toEqual([l, o, b, f])
  })

  it('orders the meshes of a model instance with it, by their own depth among themselves', () => {
    const sticker = layer([{ at: [0, 0, -50], z: 0.5 }])
    const model = layer([{ at: [0, 0, -50], z: 0 }])
    const holder = model.placements[0]!.object
    const parts = [new Mesh(), new Mesh()]
    parts[0]!.position.set(0, 0, 1) // nearer
    parts[1]!.position.set(0, 0, -1)
    const copy = new Group()
    copy.add(...parts)
    holder.add(copy)
    const order = new DrawOrder()
    order.setLayers([sticker, model])
    order.update(camera)
    const s = sticker.placements[0]!.object
    expect(drawn(order, [s, parts[0]!, parts[1]!])).toEqual([parts[1], parts[0], s])
  })

  it('leaves hidden instances, single members and other objects to the depth order', () => {
    const a = layer([{ at: [0, 0, -50], z: 0 }])
    const b = layer([{ at: [3, 0, -51], z: 1 }])
    const plain = new Mesh()
    plain.position.set(0, 0, -50.5)
    const order = new DrawOrder()
    order.setLayers([a, b])
    b.placements[0]!.object.visible = false
    order.update(camera)
    const ao = a.placements[0]!.object
    const bo = b.placements[0]!.object
    expect(drawn(order, [ao, bo, plain])).toEqual([bo, plain, ao]) // plain depth order: 51, 50.5, 50
    b.placements[0]!.object.visible = true
    b.object.visible = false // a hidden layer root (a canvas before its first draw)
    order.update(camera)
    expect(drawn(order, [ao, bo, plain])).toEqual([bo, plain, ao])
    b.object.visible = true
    order.update(camera)
    expect(drawn(order, [ao, bo, plain])).toEqual([plain, ao, bo])
    order.setLayers([a]) // b left the stack
    order.update(camera)
    expect(drawn(order, [ao, bo, plain])).toEqual([bo, plain, ao])
  })

  it('keeps three’s groupOrder and renderOrder first', () => {
    const a = layer([{ at: [0, 0, -50], z: 1 }])
    const b = layer([{ at: [0, 0, -50], z: 0 }])
    const order = new DrawOrder()
    order.setLayers([a, b])
    order.update(camera)
    const ia = { ...item(a.placements[0]!.object), renderOrder: -1 }
    const ib = item(b.placements[0]!.object)
    expect([ib, ia].sort(order.compare).map((i) => i.object)).toEqual([a.placements[0]!.object, b.placements[0]!.object])
  })

  it('is a total order (every triple consistent), so Array.sort is well defined', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const layers = Array.from({ length: 12 }, () =>
      layer([{ at: [rnd() * 10 - 5, 0, -40 - rnd() * 20], anchor: rnd() < 0.5 ? 'head' : 'mouth', face: rnd() < 0.5 ? 1 : 2, z: Math.round(rnd() * 3) / 2 }]),
    )
    const order = new DrawOrder()
    order.setLayers(layers)
    order.update(camera)
    const items = layers.map((l) => item(l.placements[0]!.object))
    const sign = (x: number) => Math.sign(x)
    for (const a of items) {
      expect(order.compare(a, a)).toBe(0)
      for (const b of items) {
        expect(sign(order.compare(a, b)) + sign(order.compare(b, a))).toBe(0)
        for (const c of items) {
          if (order.compare(a, b) < 0 && order.compare(b, c) < 0) expect(order.compare(a, c)).toBeLessThan(0)
        }
      }
    }
    // And within each group, the sorted order follows offset z, then layer order.
    const sorted = [...items].sort(order.compare).map((i) => layers.find((l) => l.placements[0]!.object === i.object)!.placements[0]!)
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const p = sorted[i]!
        const q = sorted[j]!
        if (p.anchor === q.anchor && p.face === q.face) expect(p.z).toBeLessThanOrEqual(q.z)
      }
    }
  })

  it('allocates nothing per frame', () => {
    const layers = Array.from({ length: 8 }, (_, i) =>
      layer([
        { at: [i, 0, -50 - i], z: (i % 3) * 0.1, face: 1 },
        { at: [-i, 0, -55 + i], z: (i % 2) * 0.1, face: 2, anchor: i % 2 ? 'head' : 'chin' },
      ]),
    )
    const order = new DrawOrder()
    order.setLayers(layers)
    const items = layers.flatMap((l) => l.placements.map((p) => item(p.object)))
    const state = new Float64Array(1)
    const sink = new Float64Array(1)
    const frame = () => {
      state[0]! += 0.01
      for (let i = 0; i < layers.length; i++) {
        const p = layers[i]!.placements[0]!
        p.z = Math.sin(state[0]! + i) * 0.2
        p.object.matrix.elements[12] = Math.cos(state[0]! * 3 + i) * 5
      }
      order.update(camera)
      // Array.prototype.sort itself copies the array (V8), as three's sort does every frame anyway: compare by hand.
      for (let i = 1; i < items.length; i++) sink[0]! += order.compare(items[i - 1]!, items[i]!)
    }
    expect(bytesPerCall(frame, { warmup: 20_000 })).toBeLessThan(1)
  })

  it('returns whole numbers, which Array.prototype.sort receives without boxing', () => {
    // sort is a builtin: it never inlines the comparator, so a fractional result (a depth difference) was boxed on
    // every comparison of three's transparent sort (#159).
    const layers = Array.from({ length: 6 }, (_, i) => layer([{ at: [i * 0.37, 0, -50.3 - i * 1.21], z: (i % 3) * 0.13, face: 1 }]))
    const order = new DrawOrder()
    order.setLayers(layers)
    order.update(camera)
    const items = layers.map((l) => item(l.placements[0]!.object))
    items[4] = { ...items[4]!, object: new Mesh() } // not one of the layers': three's depth
    items[5] = { ...items[5]!, object: new Mesh(), z: items[5]!.z + 0.001 }
    for (const a of items) for (const b of items) expect(Number.isInteger(order.compare(a, b))).toBe(true)
    // Sorting: V8's sort allocates its work array, the same with any comparator; boxing would add 16 bytes per
    // comparison.
    const subtract = (a: DrawItem, b: DrawItem) => b.z - a.z
    const sorted = items.slice()
    const sortWith = (compare: (a: DrawItem, b: DrawItem) => number) => () => {
      for (let i = 0; i < items.length; i++) sorted[i] = items[(i * 5) % items.length]!
      sorted.sort(compare)
    }
    expect(bytesPerCall(sortWith(order.compare))).toBeLessThan(bytesPerCall(sortWith(subtract)) - 3 * 16)
  })
})
