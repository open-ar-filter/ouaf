/**
 * Lighting of models. The format has no lights (spec §6.3), so the engine lights every model the same way: image-based
 * lighting from three's procedural `RoomEnvironment` (a neutral, softly lit room, generated on the GPU: no file),
 * prefiltered once per renderer with `PMREMGenerator` and set as the `envMap` of every lit material that has none.
 * Metallic materials need it: without an environment they render black.
 */
import { PMREMGenerator, type Material, type Texture, type WebGLRenderer } from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

const environments = new WeakMap<WebGLRenderer, { texture: Texture; users: number }>()

/** The shared environment map of `renderer`; call `releaseEnvironment` once per call when done. */
export function acquireEnvironment(renderer: WebGLRenderer): Texture {
  let env = environments.get(renderer)
  if (!env) {
    const pmrem = new PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    const texture = pmrem.fromScene(room, 0.04).texture
    room.dispose()
    pmrem.dispose()
    env = { texture, users: 0 }
    environments.set(renderer, env)
  }
  env.users++
  return env.texture
}

export function releaseEnvironment(renderer: WebGLRenderer): void {
  const env = environments.get(renderer)
  if (!env || --env.users > 0) return
  env.texture.dispose()
  environments.delete(renderer)
}

/** Sets `envMap` on a lit material (standard, physical) that has none. */
export function applyEnvironment(material: Material, envMap: Texture | null): void {
  const m = material as Material & { isMeshStandardMaterial?: boolean; envMap?: Texture | null }
  if (envMap && m.isMeshStandardMaterial && !m.envMap) m.envMap = envMap
}
