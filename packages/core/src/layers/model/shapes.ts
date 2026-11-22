/**
 * Procedural primitives of the `model` layer (`src: { shape }`, spec §6.3): usable without any file, of size 1 (they
 * fit in a 1 × 1 × 1 box centred on the origin, in face units), lit like glTF models (`MeshStandardMaterial`).
 *
 * - `box`: a 1 × 1 × 1 cube; `sphere`: diameter 1; `cone`: base diameter 1, height 1, tip up (+y).
 * - `torus`, `ring`: outer diameter 1 in the xy plane, facing the camera (+z); `thickness` is the width of the band
 *   (outer minus inner radius), so `{ "shape": "torus" }` and `{ "shape": "ring" }` cover the same area on screen.
 * - `cylinder`: diameter 1, axis along y, height `thickness` (a disc by default: 0.2; 1 gives a 1 × 1 × 1 cylinder).
 * - `plane`: 1 × 1 in the xy plane, facing the camera, drawn on both sides (as the ring).
 */
import type { TModelLayer } from '@ouaf/spec'
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  FrontSide,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
} from 'three'
import { createModelAsset, type ModelAsset } from './assets.ts'

/** A `{ shape }` source (spec §6.3). */
export type TShape = Extract<TModelLayer['src'], { shape: unknown }>
export type ShapeName = TShape['shape']

/** Default `thickness` (schema). */
export const DEFAULT_THICKNESS = 0.2

/** The geometry of a primitive of size 1. `thickness` in (0, 1]. */
export function shapeGeometry(shape: ShapeName, thickness = DEFAULT_THICKNESS): BufferGeometry {
  const t = Math.min(1, Math.max(1e-3, thickness))
  switch (shape) {
    case 'box':
      return new BoxGeometry(1, 1, 1)
    case 'sphere':
      return new SphereGeometry(0.5, 32, 16)
    case 'torus':
      return new TorusGeometry(0.5 - t / 2, t / 2, 16, 48)
    case 'ring':
      return new RingGeometry(Math.max(0, 0.5 - t), 0.5, 48)
    case 'cone':
      return new ConeGeometry(0.5, 1, 32)
    case 'cylinder':
      return new CylinderGeometry(0.5, 0.5, t, 32)
    case 'plane':
      return new PlaneGeometry(1, 1)
  }
}

/** A `{ shape }` source as a model asset: one mesh with its geometry and material, at the origin. */
export function createShapeAsset(src: TShape): ModelAsset {
  // Colors are sRGB hex strings; three converts them to its linear working space. The alpha of `color` is the
  // shape's opacity; `emissive` has none.
  const color = parseHex(src.color ?? '#ffffff')
  const material = new MeshStandardMaterial({
    color: color.rgb,
    metalness: src.metalness ?? 0,
    roughness: src.roughness ?? 0.5,
    emissive: parseHex(src.emissive ?? '#000000').rgb,
    side: src.shape === 'ring' || src.shape === 'plane' ? DoubleSide : FrontSide,
    opacity: color.alpha,
    transparent: color.alpha < 1,
  })
  const mesh = new Mesh(shapeGeometry(src.shape, src.thickness), material)
  mesh.name = src.shape
  return createModelAsset(mesh)
}

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` → `#rrggbb` and the alpha in 0–1. */
export function parseHex(hex: string): { rgb: string; alpha: number } {
  let h = hex.slice(1)
  if (h.length <= 4) h = [...h].map((c) => c + c).join('')
  const alpha = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1
  return { rgb: `#${h.slice(0, 6)}`, alpha }
}
