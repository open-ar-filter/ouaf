import { MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Texture, type WebGLRenderer } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireEnvironment, applyEnvironment, releaseEnvironment } from '../src/layers/model/environment.ts'

// PMREMGenerator and RoomEnvironment need a WebGL context: fakes record how the environment map is made.
const log = vi.hoisted(() => [] as string[])

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>()
  class FakePMREMGenerator {
    readonly renderer: unknown
    constructor(renderer: unknown) {
      this.renderer = renderer
      log.push('pmrem')
    }
    fromScene(scene: { name: string }, sigma: number) {
      log.push(`fromScene ${scene.name} ${sigma}`)
      const texture = new three.Texture()
      texture.name = `env ${log.filter((l) => l === 'pmrem').length}`
      return { texture }
    }
    dispose() {
      log.push('pmrem.dispose')
    }
  }
  return { ...three, PMREMGenerator: FakePMREMGenerator }
})

vi.mock('three/addons/environments/RoomEnvironment.js', () => ({
  RoomEnvironment: class {
    name = 'room'
    dispose() {
      log.push('room.dispose')
    }
  },
}))

const renderer = () => ({}) as WebGLRenderer

beforeEach(() => {
  log.length = 0
})

describe('model environment', () => {
  it('prefilters the room once per renderer and shares it until the last user releases it', () => {
    const r = renderer()
    const a = acquireEnvironment(r)
    expect(log).toEqual(['pmrem', 'fromScene room 0.04', 'room.dispose', 'pmrem.dispose'])
    const b = acquireEnvironment(r)
    expect(b).toBe(a)
    expect(log).toHaveLength(4) // not generated again

    let disposed = 0
    a.addEventListener('dispose', () => void disposed++)
    releaseEnvironment(r)
    expect(disposed).toBe(0) // one user left
    releaseEnvironment(r)
    expect(disposed).toBe(1)
    // A renderer without an environment (released already, or never acquired): nothing to do.
    releaseEnvironment(r)
    releaseEnvironment(renderer())
    expect(disposed).toBe(1)
    // Acquired again: a new map.
    const c = acquireEnvironment(r)
    expect(c).not.toBe(a)
    releaseEnvironment(r)
  })

  it('gives each renderer its own map', () => {
    const r1 = renderer()
    const r2 = renderer()
    const a = acquireEnvironment(r1)
    const b = acquireEnvironment(r2)
    expect(a).not.toBe(b)
    expect(log.filter((l) => l === 'pmrem')).toHaveLength(2)
    releaseEnvironment(r1)
    releaseEnvironment(r2)
  })

  it('sets the map on lit materials that have none, and only there', () => {
    const env = new Texture()
    const own = new Texture()
    const standard = new MeshStandardMaterial()
    const physical = new MeshPhysicalMaterial()
    const custom = new MeshStandardMaterial({ envMap: own })
    const basic = new MeshBasicMaterial()
    for (const m of [standard, physical, custom, basic]) applyEnvironment(m, env)
    expect([standard.envMap === env, physical.envMap === env, custom.envMap === own, basic.envMap]).toEqual([true, true, true, null])
    const bare = new MeshStandardMaterial()
    applyEnvironment(bare, null)
    expect(bare.envMap).toBeNull()
  })
})
