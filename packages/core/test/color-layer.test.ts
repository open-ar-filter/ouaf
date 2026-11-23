import { readFile } from 'node:fs/promises'
import { resolveBuiltin } from '@ouaf/builtins'
import { createRegistry } from '@ouaf/spec'
import { DataUtils, PerspectiveCamera } from 'three'
import { describe, expect, it } from 'vitest'
import { CORE_LOADERS, memorySource, type AssetLoader, type LoaderKind } from '../src/engine/assets.ts'
import { AssetError, type InvalidParamError } from '../src/engine/errors.ts'
import { loadFilter, type FilterLoadEnv } from '../src/engine/filter.ts'
import type { FrameContext, PassLayer } from '../src/engine/layer-type.ts'
import { FaceBindingData } from '../src/bindings/index.ts'
import { createFaceFrame } from '../src/face.ts'
import { FACE_OVAL, FEATHER, MASK_INDICES, MASK_VERTICES, faceMaskIndices, faceMaskValues, writeFaceMask } from '../src/layers/color/face-mask.ts'
import { AMOUNT, AMOUNT_COUNT, GRAIN_AMPLITUDE, U, UNIFORM_COUNT, grainSeed, isNeutral, writeGradeUniforms } from '../src/layers/color/grade.ts'
import { CubeError, LUT_1D_GRID, colorLayerType, colorPlugin, lutLoader, lutTextureData, parseCube } from '../src/layers/color/index.ts'
import { TRACKER_FOV_Y } from '../src/engine/anchor-provider.ts'
import { bytesPerCall } from './allocation.ts'
import { writeSyntheticFace } from './synthetic-face.ts'

/** Identity `.cube` of the given size. */
function identityCube(size: number, header = ''): string {
  const lines = ['TITLE "identity"', `LUT_3D_SIZE ${size}`, header]
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push(`${r / (size - 1)} ${g / (size - 1)} ${b / (size - 1)}`)
  return lines.join('\n') + '\n'
}

const errorOf = (fn: () => unknown): CubeError => {
  try {
    fn()
  } catch (e) {
    if (e instanceof CubeError) return e
    throw e
  }
  throw new Error('no error')
}

describe('parseCube', () => {
  it('reads a 3D LUT, red varying fastest, with its title and default domain', () => {
    const lut = parseCube('# comment\r\nTITLE "Grade"\r\nLUT_3D_SIZE 2\r\n' + '0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1.5e-1\n')
    expect(lut).toMatchObject({ title: 'Grade', dims: 3, size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1] })
    expect(lut.data).toHaveLength(24)
    expect([...lut.data.slice(3, 6)]).toEqual([1, 0, 0])
    expect(lut.data[23]).toBeCloseTo(0.15)
  })

  it('reads DOMAIN_MIN / DOMAIN_MAX and the Resolve input range', () => {
    const lut = parseCube(identityCube(2, 'DOMAIN_MIN 0 -0.5 0\nDOMAIN_MAX 1 1.5 2'))
    expect(lut.domainMin).toEqual([0, -0.5, 0])
    expect(lut.domainMax).toEqual([1, 1.5, 2])
    expect(parseCube(identityCube(2, 'LUT_3D_INPUT_RANGE 0.1 0.9'))).toMatchObject({ domainMin: [0.1, 0.1, 0.1], domainMax: [0.9, 0.9, 0.9] })
  })

  it('reads a 1D LUT', () => {
    const lut = parseCube('LUT_1D_SIZE 3\n0 0 0\n0.25 0.5 0.75\n1 1 1\n')
    expect(lut).toMatchObject({ dims: 1, size: 3 })
  })

  it('accepts the largest grid the validator allows, and refuses larger ones', () => {
    expect(errorOf(() => parseCube('LUT_3D_SIZE 257\n')).message).toMatch(/from 2 to 256/)
    expect(errorOf(() => parseCube('LUT_1D_SIZE 65537\n')).message).toMatch(/from 2 to 65536/)
    expect(errorOf(() => parseCube('LUT_3D_SIZE 1\n')).line).toBe(1)
    expect(errorOf(() => parseCube('LUT_3D_SIZE 2.5\n')).line).toBe(1)
  })

  it('refuses malformed files with the line', () => {
    expect(errorOf(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n0 0 oops\n'))).toMatchObject({ line: 3 })
    expect(errorOf(() => parseCube('LUT_3D_SIZE 2\n0 0\n')).message).toMatch(/line 2: A data row expects 3 numbers/)
    expect(errorOf(() => parseCube('0 0 0\n')).message).toMatch(/line 1: data rows before LUT_3D_SIZE/)
    expect(errorOf(() => parseCube('# empty\n')).message).toMatch(/no LUT_3D_SIZE/)
    expect(errorOf(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'))).toMatchObject({ line: 1 })
    expect(errorOf(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'.padEnd(10) + '1 1 1\n'.repeat(8))).message).toMatch(/more than the 8 data rows/)
    expect(errorOf(() => parseCube('LUT_3D_SIZE 2\nLUT_1D_SIZE 2\n')).line).toBe(2)
    expect(errorOf(() => parseCube(identityCube(2, 'DOMAIN_MIN 0 0')))).toMatchObject({ line: 3 })
    expect(errorOf(() => parseCube(identityCube(2, 'DOMAIN_MIN 0 1 0\nDOMAIN_MAX 1 1 1'))).message).toMatch(/DOMAIN_MAX must be greater/)
  })

  it('parses the built-in LUTs', async () => {
    for (const name of ['vintage', 'noir', 'warm', 'cool', 'vivid']) {
      const text = await readFile(new URL(`../../builtins/assets/luts/${name}.cube`, import.meta.url), 'utf8')
      expect(parseCube(text)).toMatchObject({ dims: 3, size: 17 })
    }
  })
})

describe('lutTextureData', () => {
  const half = (v: number) => DataUtils.toHalfFloat(v)

  it('stores a 3D LUT as RGBA half floats', () => {
    const { size, data } = lutTextureData(parseCube(identityCube(3)))
    expect(size).toBe(3)
    expect(data).toHaveLength(27 * 4)
    // Texel (r=2, g=1, b=0): index 2 + 1·3.
    expect([...data.slice(5 * 4, 5 * 4 + 4)]).toEqual([half(1), half(0.5), half(0), half(1)])
  })

  it('turns a 1D LUT into a separable 3D grid', () => {
    const { size, data } = lutTextureData(parseCube('LUT_1D_SIZE 2\n0 0.2 0\n1 0.8 0.5\n'))
    expect(size).toBe(2)
    // Texel (r=1, g=0, b=1): red curve at 1, green at 0, blue at 1.
    const i = (1 + 0 * 2 + 1 * 4) * 4
    expect([...data.slice(i, i + 4)]).toEqual([half(1), half(0.2), half(0.5), half(1)])
    expect(lutTextureData(parseCube(`LUT_1D_SIZE 1024\n${'0.5 0.5 0.5\n'.repeat(1024)}`)).size).toBe(LUT_1D_GRID)
  })
})

describe('writeGradeUniforms', () => {
  const amounts = (values: Partial<Record<keyof typeof AMOUNT, number>>) => {
    const a = new Float64Array(AMOUNT_COUNT)
    a[AMOUNT.opacity] = 1
    a[AMOUNT.intensity] = 1
    for (const [k, v] of Object.entries(values)) a[AMOUNT[k as keyof typeof AMOUNT]] = v
    return a
  }
  const WHITE = [1, 1, 1, 1]
  const out = new Float32Array(UNIFORM_COUNT)

  it('maps the defaults to a neutral grade', () => {
    writeGradeUniforms(amounts({}), WHITE, 0, out)
    expect([...out]).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1])
    expect(isNeutral(out, false)).toBe(true)
    expect(isNeutral(out, true)).toBe(false)
  })

  it('maps each property', () => {
    writeGradeUniforms(amounts({ intensity: 0.5, opacity: 0.5, brightness: 1, contrast: -0.5, saturation: -1, temperature: 1, vignette: 0.3, grain: 1 }), [1, 0.5, 0, 0.25], 2, out)
    expect(out[U.mix]).toBe(0.5)
    expect(out[U.lut]).toBe(0.5)
    expect(out[U.gamma]).toBe(0.5)
    expect(out[U.contrast]).toBe(0.5)
    expect(out[U.saturation]).toBe(0)
    expect(out[U.redGain]).toBeCloseTo(1.2)
    expect(out[U.blueGain]).toBeCloseTo(0.8)
    expect(out[U.vignette]).toBeCloseTo(0.3)
    expect(out[U.grain]).toBeCloseTo(GRAIN_AMPLITUDE)
    expect([...out.slice(U.tintR, U.tintA + 1)]).toEqual([1, 0.5, 0, 0.25])
    expect(out[U.seed]).toBe(48)
    expect(isNeutral(out, false)).toBe(false)
    writeGradeUniforms(amounts({ brightness: -1 }), WHITE, 0, out)
    expect(out[U.gamma]).toBe(2)
  })

  it('clamps out-of-range values (range/to bindings) and treats NaN as the default', () => {
    writeGradeUniforms(amounts({ contrast: 3, vignette: -1, saturation: Number.NaN }), WHITE, 0, out)
    expect(out[U.contrast]).toBe(2)
    expect(out[U.vignette]).toBe(0)
    expect(out[U.saturation]).toBe(1)
  })

  it('is neutral at zero opacity, with a LUT at zero intensity, or with a white or transparent tint only', () => {
    expect(isNeutral(writeGradeUniforms(amounts({ opacity: 0, saturation: 1 }), WHITE, 0, out), true)).toBe(true)
    expect(isNeutral(writeGradeUniforms(amounts({ intensity: 0 }), WHITE, 0, out), true)).toBe(true)
    // intensity only weakens the LUT: the other adjustments still apply.
    expect(isNeutral(writeGradeUniforms(amounts({ intensity: 0, saturation: 1 }), WHITE, 0, out), true)).toBe(false)
    expect(isNeutral(writeGradeUniforms(amounts({}), [1, 0, 0, 0], 0, out), false)).toBe(true)
    expect(isNeutral(writeGradeUniforms(amounts({}), [1, 0, 0, 0.5], 0, out), false)).toBe(false)
  })

  it('seeds the grain from the media time only', () => {
    expect(grainSeed(0)).toBe(0)
    expect(grainSeed(1 / 24 - 1e-9)).toBe(0)
    expect(grainSeed(1)).toBe(24)
    expect(grainSeed(1)).toBe(grainSeed(1))
    expect(grainSeed(Number.NaN)).toBe(0)
  })

  it('does not allocate', () => {
    const a = amounts({ saturation: 0.3 })
    expect(bytesPerCall(() => writeGradeUniforms(a, WHITE, 1.5, out))).toBeLessThan(1)
  })
})

describe('face mask', () => {
  /** Camera of the objects stage for a 1280×720 frame shown uncropped. */
  const camera = new PerspectiveCamera(TRACKER_FOV_Y, 1280 / 720, 1, 10000)
  camera.updateProjectionMatrix()

  /** Face slot 0: the oval as a circle of radius `r` (video units) around (`u`, `v`). */
  function ovalFace(u: number, v: number, r: number) {
    const faces = createFaceFrame(2)
    faces.count = 1
    faces.width = 1280
    faces.height = 720
    FACE_OVAL.forEach((index, i) => {
      const a = (i / FACE_OVAL.length) * 2 * Math.PI
      faces.landmarks[index * 3] = u + r * Math.cos(a)
      faces.landmarks[index * 3 + 1] = v + r * Math.sin(a)
    })
    return faces
  }

  it('builds static indices and mask values for every face slot', () => {
    const indices = faceMaskIndices(2)
    expect(indices).toHaveLength(2 * MASK_INDICES)
    expect(Math.max(...indices)).toBe(2 * MASK_VERTICES - 1)
    const mask = faceMaskValues(2)
    expect(mask[0]).toBe(1)
    expect(mask[FACE_OVAL.length]).toBe(1)
    expect(mask[FACE_OVAL.length + 1]).toBe(0)
    expect(mask[MASK_VERTICES]).toBe(1)
  })

  it('places the oval in clip space, with the soft edge around the contour', () => {
    const faces = ovalFace(0.75, 0.25, 0.1)
    const out = new Float32Array(2 * MASK_VERTICES * 2)
    writeFaceMask(faces, 0, 0, false, camera.projectionMatrix.elements, out)
    // Centre: u 0.75 → x 0.5, v 0.25 → y 0.5.
    expect(out[0]).toBeCloseTo(0.5, 5)
    expect(out[1]).toBeCloseTo(0.5, 5)
    // First contour point: (0.85, 0.25) → x 0.7; inner and outer at ∓FEATHER of the 0.2 radius.
    expect(out[2]).toBeCloseTo(0.5 + 0.2 * (1 - FEATHER), 5)
    expect(out[2 + FACE_OVAL.length * 2]).toBeCloseTo(0.5 + 0.2 * (1 + FEATHER), 5)

    writeFaceMask(faces, 0, 1, true, camera.projectionMatrix.elements, out)
    expect(out[MASK_VERTICES * 2]).toBeCloseTo(-0.5, 5) // mirrored, written at slot 1
    expect(out[MASK_VERTICES * 2 + 1]).toBeCloseTo(0.5, 5)
  })

  it('follows the cover crop held in the projection', () => {
    const cropped = camera.clone()
    cropped.projectionMatrix.elements[0]! *= 2 // video twice as wide as the target
    const out = new Float32Array(MASK_VERTICES * 2)
    writeFaceMask(ovalFace(0.75, 0.25, 0.1), 0, 0, false, cropped.projectionMatrix.elements, out)
    expect(out[0]).toBeCloseTo(1, 5)
    expect(out[1]).toBeCloseTo(0.5, 5)
  })

  it('does not allocate', () => {
    const faces = ovalFace(0.5, 0.5, 0.2)
    const out = new Float32Array(MASK_VERTICES * 2)
    const p = camera.projectionMatrix.elements
    expect(bytesPerCall(() => writeFaceMask(faces, 0, 0, false, p, out))).toBeLessThan(1)
  })
})

describe('color layer', () => {
  const base = { ouaf: '1', id: 'grade', name: 'Grade', version: '1.0.0', license: 'CC0-1.0', requires: {} }
  const camera = new PerspectiveCamera(TRACKER_FOV_Y, 1280 / 720, 1, 10000)
  camera.updateProjectionMatrix()
  const faces = createFaceFrame(1)

  function env(overrides: Partial<FilterLoadEnv> = {}): FilterLoadEnv {
    const loaders = new Map<LoaderKind, AssetLoader>()
    for (const l of [...CORE_LOADERS, lutLoader]) for (const k of l.kinds) loaders.set(k, l as AssetLoader)
    return {
      engineVersion: '1.0.0',
      registry: createRegistry(),
      layerTypes: new Map([[colorLayerType.type, colorLayerType]]),
      loaders,
      builtinUrl: (name) => resolveBuiltin(`builtin:${name}`, 'https://engine.test/builtins/').href,
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname.replace(/^\/builtins\//, '')
        return new Response(await readFile(new URL(`../../builtins/assets/${path}`, import.meta.url)))
      },
      renderer: {} as FilterLoadEnv['renderer'],
      view: { camera },
      maxFaces: 1,
      bindingData: new FaceBindingData(faces),
      seed: () => 1,
      warn: () => {},
      ...overrides,
    }
  }

  const frame = (count: number, time = 0): FrameContext => {
    faces.count = count
    return { time, now: time * 1000, dt: 16, faces, anchors: {} as FrameContext['anchors'], width: 1280, height: 720, mirrored: false }
  }

  it('is the color plugin, which owns the lut loader', () => {
    const registered: string[] = []
    colorPlugin.setup!({
      engineVersion: '1.0.0',
      registerLayerType: (impl) => void registered.push(`layer:${impl.type}`),
      registerAssetLoader: (loader) => void registered.push(`loader:${loader.kinds.join(',')}`),
    } as Parameters<NonNullable<typeof colorPlugin.setup>>[0])
    expect(registered).toEqual(['loader:lut', 'layer:color'])
  })

  it('loads a built-in LUT and is active while it grades the image', async () => {
    const source = memorySource({ manifest: { ...base, layers: [{ type: 'color', lut: 'builtin:lut/noir', intensity: { param: 'amount' } }], params: { amount: { type: 'number', default: 1, min: 0, max: 1 } } } })
    const filter = await loadFilter(1, source, undefined, env())
    const layer = filter.layers[0]!.instance as PassLayer
    expect(layer.stage).toBe('color')
    expect(filter.assets.get<{ size: number }>('builtin:lut/noir').size).toBe(17)
    layer.update(frame(0))
    expect(layer.active).toBe(true)
    filter.params.set('amount', 0)
    filter.params.beginFrame(0)
    layer.update(frame(0))
    expect(layer.active).toBe(false)
    filter.dispose()
  })

  it('is inactive when neutral or hidden, and with region "face" while no face is tracked', async () => {
    const source = memorySource({
      manifest: {
        ...base,
        requires: { face: true },
        layers: [
          { type: 'color' },
          { type: 'color', saturation: -1, visible: false },
          { type: 'color', saturation: -1, region: 'face' },
          { type: 'color', grain: { bind: 'face.blendshapes.jawOpen', default: 0 } },
        ],
      },
    })
    const filter = await loadFilter(1, source, undefined, env())
    const [neutral, hidden, face, bound] = filter.layers.map((l) => l.instance as PassLayer)
    for (const l of [neutral, hidden, face, bound]) l!.update(frame(0))
    expect([neutral!.active, hidden!.active, face!.active, bound!.active]).toEqual([false, false, false, false])
    writeSyntheticFace(faces, 0, {})
    faces.blendshapes[25] = 0.5 // jawOpen
    face!.update(frame(1))
    bound!.update(frame(1))
    expect([face!.active, bound!.active]).toEqual([true, true])
    const steady = frame(1, 2)
    expect(bytesPerCall(() => face!.update(steady))).toBeLessThan(1)
    filter.dispose()
  })

  it('reports a malformed LUT as an AssetError naming the file and line', async () => {
    const source = memorySource({
      manifest: { ...base, assets: { grade: 'assets/grade.cube' }, layers: [{ type: 'color', lut: 'grade' }] },
      files: { 'assets/grade.cube': 'LUT_3D_SIZE 2\n0 0 0\n0 0 x\n' },
    })
    const error = await loadFilter(1, source, undefined, env()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssetError)
    expect((error as AssetError).message).toMatch(/LUT "grade" \(assets\/grade\.cube\) is not a valid \.cube file: line 3/)
  })

  it('maps the LUT domain to [0, 1]', async () => {
    const source = memorySource({
      manifest: { ...base, layers: [{ type: 'color', lut: 'assets/g.cube' }] },
      files: { 'assets/g.cube': identityCube(2, 'DOMAIN_MIN -0.5 0 0\nDOMAIN_MAX 1.5 1 2') },
    })
    const filter = await loadFilter(1, source, undefined, env())
    const lut = filter.assets.get<{ scale: { x: number; z: number }; offset: { x: number; z: number } }>('assets/g.cube')
    expect([lut.scale.x, lut.offset.x, lut.scale.z, lut.offset.z]).toEqual([0.5, 0.25, 0.5, -0])
    filter.dispose()
  })

  /** The LUT texture and strength the layer's shader draws with (what `render` hands to `drawFullscreen`). */
  const drawn = (layer: PassLayer) => {
    let material: { uniforms: Record<string, { value: unknown }> } | undefined
    layer.render({ renderer: {} as never, input: {} as never, output: null, drawFullscreen: (m) => void (material = m as never) })
    return { texture: material!.uniforms.uLut?.value, mix: material!.uniforms.uLutMix?.value }
  }

  it('lut follows a select param among the filter\'s LUTs; no LUT without a map entry (#140)', async () => {
    const source = memorySource({
      manifest: {
        ...base,
        params: { look: { type: 'select', default: 'off', options: { off: 'Off', noir: 'Noir', own: 'Own' } } },
        assets: { grade: 'assets/grade.cube' },
        layers: [{ type: 'color', lut: { param: 'look', map: { noir: 'builtin:lut/noir', own: 'grade' } } }],
      },
      files: { 'assets/grade.cube': identityCube(3) },
    })
    const filter = await loadFilter(1, source, undefined, env())
    const layer = filter.layers[0]!.instance as PassLayer
    layer.update(frame(0))
    expect(layer.active).toBe(false) // no LUT, nothing else: neutral
    filter.params.set('look', 'noir')
    filter.params.beginFrame(16)
    layer.update(frame(0))
    expect(layer.active).toBe(true)
    expect(drawn(layer)).toEqual({ texture: filter.assets.get<{ texture: unknown }>('builtin:lut/noir').texture, mix: 1 })
    filter.params.set('look', 'own')
    filter.params.beginFrame(32)
    layer.update(frame(0))
    expect(drawn(layer).texture).toBe(filter.assets.get<{ texture: unknown }>('grade').texture)
    filter.dispose()
  })

  it('lut shows the host\'s .cube file; a file that is not a valid LUT is refused, the previous one kept (#140)', async () => {
    const errors: Error[] = []
    const manifest = {
      ...base,
      params: { look: { type: 'asset', accept: ['text/x-cube'], optional: true } },
      layers: [{ type: 'color', lut: { param: 'look' } }],
    }
    // A `.cube` file has no registered media type: a file picker gives it none, its content decides.
    const filter = await loadFilter(1, memorySource({ manifest }), { look: new File([identityCube(2)], 'mine.cube') }, env({ error: (e) => void errors.push(e) }))
    const layer = filter.layers[0]!.instance as PassLayer
    layer.update(frame(0))
    expect(layer.active).toBe(true)
    const first = drawn(layer).texture
    expect(first).toBe((filter.hostAssets!.get('look') as { texture: unknown }).texture)

    filter.params.set('look', new File(['LUT_3D_SIZE 2\n0 0 x\n'], 'broken.cube'))
    filter.params.beginFrame(16)
    await filter.params.assetsSettled()
    filter.params.set('look', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'photo.cube'))
    filter.params.beginFrame(32)
    await filter.params.assetsSettled()
    filter.params.beginFrame(48)
    layer.update(frame(0))
    expect(errors.map((e) => [e.name, (e as InvalidParamError).reason, e.message])).toEqual([
      ['InvalidParamError', 'content', 'Filter "grade": Invalid value for parameter "look": LUT "look" (broken.cube) is not a valid .cube file: line 2: A data row expects 3 numbers, got "0 0 x".'],
      ['InvalidParamError', 'content', 'Filter "grade": Invalid value for parameter "look": "photo.cube": its content is a PNG image, not a .cube LUT this parameter accepts (text/x-cube).'],
    ])
    expect(drawn(layer).texture).toBe(first)
    filter.params.set('look', null)
    filter.params.beginFrame(64)
    layer.update(frame(0))
    expect(layer.active).toBe(false)
    filter.dispose()
  })
})
