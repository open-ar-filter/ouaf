import type { BufferAttribute, BufferGeometry, Mesh, Points, RawShaderMaterial, Scene, Texture, Vector4 } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LANDMARKS_STRIDE, LANDMARK_COUNT, createFaceFrame, type RendererOptions } from '../src/index.ts'

// No WebGL in Node: replace three's WebGLRenderer with a recorder; everything else is the real three.js.
const fake = vi.hoisted(() => ({
  instances: [] as FakeWebGL[],
}))

interface FakeWebGL {
  sizes: [number, number, boolean | undefined][]
  scenes: unknown[]
  disposed: boolean
  contextLost: boolean
}

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()
  class WebGLRenderer implements FakeWebGL {
    sizes: [number, number, boolean | undefined][] = []
    scenes: unknown[] = []
    disposed = false
    contextLost = false
    constructor() {
      fake.instances.push(this)
    }
    setPixelRatio() {}
    setClearColor() {}
    setSize(w: number, h: number, updateStyle?: boolean) {
      this.sizes.push([w, h, updateStyle])
    }
    render(scene: unknown) {
      this.scenes.push(scene)
    }
    dispose() {
      this.disposed = true
    }
    forceContextLoss() {
      this.contextLost = true
    }
  }
  return { ...actual, WebGLRenderer }
})

const { Renderer } = await import('../src/index.ts')

function fakeVideo(width = 1280, height = 720) {
  return { videoWidth: width, videoHeight: height, readyState: 4 } as { videoWidth: number; videoHeight: number; readyState: number }
}

function setup(options: Partial<RendererOptions> = {}) {
  const video = fakeVideo()
  const canvas = { remove() {} } as unknown as HTMLCanvasElement
  const renderer = new Renderer({ video: video as unknown as HTMLVideoElement, mirrored: true, maxFaces: 2, canvas, debugLandmarks: true, ...options })
  const gl = fake.instances.at(-1)!
  const scene = () => gl.scenes.at(-1) as Scene
  const background = () => scene().children[0] as Mesh<BufferGeometry, RawShaderMaterial>
  const points = () => scene().children[1] as Points<BufferGeometry, RawShaderMaterial>
  const mapping = () => (background().material.uniforms.uVideoToClip!.value as Vector4).toArray()
  const texture = () => background().material.uniforms.uMap!.value as Texture
  return { video, renderer, gl, background, points, mapping, texture }
}

beforeEach(() => {
  fake.instances.length = 0
})

describe('Renderer', () => {
  it('validates its options', () => {
    const video = fakeVideo() as unknown as HTMLVideoElement
    expect(() => new Renderer({ video, mirrored: false, maxFaces: 0 })).toThrow(RangeError)
    expect(() => new Renderer({ video, mirrored: false, maxFaces: 1, width: 640 })).toThrow(RangeError)
    expect(() => new Renderer({ video, mirrored: false, maxFaces: 1, scale: 0 })).toThrow(RangeError)
  })

  it('sizes the drawing buffer from the video, without touching the CSS size', () => {
    const { renderer, gl } = setup({ scale: 0.5 })
    expect([renderer.width, renderer.height]).toEqual([640, 360])
    expect(gl.sizes).toEqual([[640, 360, false]])
  })

  it('uses a fixed internal resolution and a cover mapping', () => {
    const { renderer, mapping, gl } = setup({ width: 720, height: 1280, mirrored: false })
    expect([renderer.width, renderer.height]).toEqual([720, 1280])
    renderer.render(createFaceFrame(2))
    const r = (1280 / 720) / (720 / 1280)
    expect(mapping()).toEqual([2 * r, -r, -2, 1])
    renderer.setResolution()
    expect(gl.sizes.at(-1)).toEqual([1280, 720, false])
    expect(mapping()).toEqual([2, -1, -2, 1])
  })

  it('shares one mirrored mapping between the background and the landmarks', () => {
    const { renderer, background, points } = setup()
    renderer.render(createFaceFrame(2))
    expect(points().material.uniforms.uVideoToClip).toBe(background().material.uniforms.uVideoToClip)
    expect((background().material.uniforms.uVideoToClip!.value as Vector4).toArray()).toEqual([-2, 1, -2, 1])
  })

  it('uploads the current frame on every render, as sRGB without flipping', () => {
    const { renderer, texture } = setup()
    renderer.render(createFaceFrame(2))
    const t = texture()
    expect(t.colorSpace).toBe('srgb')
    expect(t.flipY).toBe(false)
    const version = t.version
    renderer.render(createFaceFrame(2))
    renderer.render(createFaceFrame(2))
    expect(t.version).toBe(version + 2)
  })

  it('hides the background until the video has a frame', () => {
    const { renderer, video, background, texture } = setup()
    video.readyState = 1
    renderer.render(createFaceFrame(2))
    expect(background().visible).toBe(false)
    const version = texture().version
    video.readyState = 4
    renderer.render(createFaceFrame(2))
    expect(background().visible).toBe(true)
    expect(texture().version).toBe(version + 1)
  })

  it('copies the landmarks of the tracked faces into one preallocated buffer', () => {
    const { renderer, points } = setup()
    const faces = createFaceFrame(3)
    for (let i = 0; i < faces.landmarks.length; i++) faces.landmarks[i] = i
    renderer.render(faces)
    const attribute = points().geometry.getAttribute('position') as BufferAttribute
    const array = attribute.array
    expect(array.length).toBe(2 * LANDMARKS_STRIDE)
    expect(points().geometry.drawRange.count).toBe(0)

    faces.count = 1
    const version = attribute.version
    renderer.render(faces)
    expect(points().geometry.drawRange).toEqual({ start: 0, count: LANDMARK_COUNT })
    expect(array[LANDMARKS_STRIDE - 1]).toBe(LANDMARKS_STRIDE - 1)
    expect(attribute.version).toBe(version + 1)

    faces.count = 3 // more faces than the renderer's capacity: clamped
    renderer.render(faces)
    expect(points().geometry.drawRange.count).toBe(2 * LANDMARK_COUNT)
    expect(array[2 * LANDMARKS_STRIDE - 1]).toBe(2 * LANDMARKS_STRIDE - 1)
    expect(points().geometry.getAttribute('position').array).toBe(array)

    renderer.debugLandmarks = false
    renderer.render(faces)
    expect(points().visible).toBe(false)
    expect(points().geometry.drawRange.count).toBe(0)
  })

  it('follows a video size change (rotation): resolution and mapping', () => {
    const { renderer, video, gl, mapping } = setup({ width: 720, height: 1280 })
    renderer.render(createFaceFrame(2))
    expect(mapping()[0]).toBeLessThan(-2) // landscape video cropped on a portrait target

    video.videoWidth = 720
    video.videoHeight = 1280
    renderer.render(createFaceFrame(2))
    expect(mapping()).toEqual([-2, 1, -2, 1])
    expect(gl.sizes).toEqual([[720, 1280, false]])

    renderer.setResolution() // follow the video
    video.videoWidth = 1280
    video.videoHeight = 720
    renderer.render(createFaceFrame(2))
    expect(gl.sizes.at(-1)).toEqual([1280, 720, false])
    expect(mapping()).toEqual([-2, 1, -2, 1])
  })

  it('uploads with three\'s video path (mutable storage sized from the video)', () => {
    const { renderer, texture } = setup()
    renderer.render(createFaceFrame(2))
    expect((texture() as Texture & { isVideoTexture?: boolean }).isVideoTexture).toBe(true)
  })

  it('releases its resources, and the context only when it owns the canvas', () => {
    const { renderer, gl, texture } = setup()
    renderer.render(createFaceFrame(2))
    const onDispose = vi.fn()
    texture().addEventListener('dispose', onDispose)
    renderer.dispose()
    renderer.dispose()
    expect(onDispose).toHaveBeenCalledOnce()
    expect(gl.disposed).toBe(true)
    expect(gl.contextLost).toBe(false) // the canvas was provided
    const scenes = gl.scenes.length
    renderer.render(createFaceFrame(2))
    expect(gl.scenes.length).toBe(scenes)
  })
})
