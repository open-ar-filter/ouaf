import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OuafError } from '../src/engine/errors.ts'
import { Outputs, RECORDING_TYPES, pickRecordingType, type OutputsEnv } from '../src/engine/outputs.ts'

// Fakes of the browser objects the outputs use (Node has no canvas, MediaStream or MediaRecorder).

class FakeTrack {
  readyState: 'live' | 'ended' = 'live'
  readonly kind: 'video' | 'audio'
  constructor(kind: 'video' | 'audio') {
    this.kind = kind
  }
  stop() {
    this.readyState = 'ended'
  }
}

class FakeStream {
  readonly tracks: FakeTrack[]
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
}

/** A 2D canvas whose "pixels" are the label of the last image drawn into it. */
class FakeCanvas {
  width = 300
  height = 150
  content = ''
  frameRates: Array<number | undefined> = []
  context = {
    canvas: this as FakeCanvas,
    drawImage: (source: { label: string } | FakeCanvas, x: number, y: number, w?: number, h?: number) => {
      // From the capture surface (into the canvas streams read): a copy of its content.
      this.content = source instanceof FakeCanvas ? `copy of ${source.content}` : `${source.label} ${x},${y} ${w}x${h} into ${this.width}x${this.height}`
    },
  }
  getContext(kind: string, options: { alpha: boolean }) {
    expect([kind, options.alpha]).toEqual(['2d', false])
    return this.context
  }
  captureStream(frameRate?: number) {
    this.frameRates.push(frameRate)
    return new FakeStream([new FakeTrack('video')])
  }
  toBlob(callback: (blob: Blob | null) => void, type: string, quality?: number) {
    const content = this.content // copied now, encoded later
    setTimeout(() => callback(new Blob([`${content} q=${quality}`], { type })), 0)
  }
}

let supported = new Set<string>()

class FakeRecorder extends EventTarget {
  static instances: FakeRecorder[] = []
  static isTypeSupported(type: string) {
    return supported.has(type)
  }
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  timeslice: number | undefined
  readonly mimeType: string
  readonly stream: FakeStream
  readonly options: MediaRecorderOptions
  constructor(stream: FakeStream, options: MediaRecorderOptions) {
    super()
    this.stream = stream
    this.options = options
    this.mimeType = options.mimeType ?? 'video/x-default'
    FakeRecorder.instances.push(this)
  }
  start(timeslice?: number) {
    this.state = 'recording'
    this.timeslice = timeslice
  }
  pause() {
    this.state = 'paused'
  }
  resume() {
    this.state = 'recording'
  }
  /** Delivers a chunk, as the browser does every `timeslice`. */
  emit(data: string) {
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([data]) }))
  }
  stop() {
    this.state = 'inactive'
    setTimeout(() => {
      this.emit('end')
      this.dispatchEvent(new Event('stop'))
    }, 0)
  }
}

let canvases: FakeCanvas[] = []
/** Capture surfaces (`createSurface`); `canvases` are the canvases streams and recordings read. */
let surfaces: FakeCanvas[] = []

function outputs(env: Partial<OutputsEnv> = {}): Outputs {
  return new Outputs({
    createSurface: () => {
      const c = new FakeCanvas()
      surfaces.push(c)
      return c as unknown as HTMLCanvasElement
    },
    createCanvas: () => {
      const c = new FakeCanvas()
      canvases.push(c)
      return c as unknown as HTMLCanvasElement
    },
    MediaRecorder: FakeRecorder as unknown as typeof MediaRecorder,
    ...env,
  })
}

const frame = (label: string) => ({ label }) as unknown as HTMLCanvasElement

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeStream)
  canvases = []
  surfaces = []
  supported = new Set()
  FakeRecorder.instances = []
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pickRecordingType', () => {
  it('prefers H.264 MP4, then WebM VP9, VP8, with the audio codecs when there is audio', () => {
    const all = new Set(RECORDING_TYPES.flat())
    expect(pickRecordingType((t) => all.has(t), false)).toBe('video/mp4;codecs=avc1')
    expect(pickRecordingType((t) => all.has(t), true)).toBe('video/mp4;codecs=avc1,mp4a.40.2')
    // Chromium without proprietary codecs, Firefox:
    const webm = (t: string) => t.startsWith('video/webm')
    expect(pickRecordingType(webm, false)).toBe('video/webm;codecs=vp9')
    expect(pickRecordingType(webm, true)).toBe('video/webm;codecs=vp9,opus')
    expect(pickRecordingType((t) => t === 'video/webm;codecs=vp8' || t === 'video/mp4', false)).toBe('video/webm;codecs=vp8')
    expect(pickRecordingType((t) => t === 'video/mp4', true)).toBe('video/mp4')
    expect(pickRecordingType(() => false, false)).toBeUndefined()
  })
})

describe('Outputs', () => {
  it('copies nothing while no output is in use', () => {
    const o = outputs()
    expect(o.active).toBe(false)
    expect(canvases).toHaveLength(0)
  })

  it('snapshot: encodes the next captured frame at the render size, then stops capturing', async () => {
    const o = outputs()
    const png = o.snapshot()
    const jpeg = o.snapshot({ type: 'image/jpeg', quality: 0.8 })
    expect(o.active).toBe(true)
    o.capture(frame('frame1'), 640, 360)
    o.capture(frame('frame2'), 640, 360) // after the snapshots were taken: not in them
    const [a, b] = await Promise.all([png, jpeg])
    expect([a.type, await a.text()]).toEqual(['image/png', 'frame1 0,0 640x360 into 640x360 q=undefined'])
    expect([b.type, await b.text()]).toEqual(['image/jpeg', 'frame1 0,0 640x360 into 640x360 q=0.8'])
    expect(o.active).toBe(false)
    expect(surfaces).toHaveLength(1) // one capture surface, reused
    expect(canvases).toHaveLength(0) // no stream: no copy for streams
  })

  it('hold: keeps the surface captured on every frame until released (an export)', () => {
    const o = outputs()
    const a = o.hold()
    const b = o.hold()
    expect(o.active).toBe(true)
    o.capture(frame('frame1'), 64, 48)
    expect((a.canvas as unknown as FakeCanvas).content).toBe('frame1 0,0 64x48 into 64x48')
    expect(b.canvas).toBe(a.canvas)
    a.release()
    a.release() // idempotent: b still holds
    expect(o.active).toBe(true)
    b.release()
    expect(o.active).toBe(false)
    o.dispose()
    expect(() => o.hold()).toThrow(OuafError)
  })

  it('snapshot: rejects an invalid quality', () => {
    expect(() => outputs().snapshot({ quality: 2 })).toThrow(RangeError)
  })

  it('outputStream: one video track per call, captured until the host stops every track', () => {
    const o = outputs()
    const a = o.outputStream()
    const b = o.outputStream({ frameRate: 15 })
    expect(canvases[0]!.frameRates).toEqual([undefined, 15])
    expect(a.getVideoTracks()).toHaveLength(1)
    expect(o.active).toBe(true)
    o.capture(frame('f'), 320, 240)
    // Streams read a copy of the capture surface (Firefox swaps red and blue drawing WebGL into a <canvas>).
    expect(surfaces[0]!.content).toBe('f 0,0 320x240 into 320x240')
    expect(canvases[0]!.content).toBe('copy of f 0,0 320x240 into 320x240')
    expect([canvases[0]!.width, canvases[0]!.height]).toEqual([320, 240])
    a.getVideoTracks()[0]!.stop()
    expect(o.active).toBe(true)
    b.getVideoTracks()[0]!.stop()
    expect(o.active).toBe(false)
    expect(() => o.outputStream({ frameRate: 0 })).toThrow(RangeError)
  })

  it('outputStream: needs captureStream (not in a worker)', () => {
    const o = outputs({ createCanvas: () => ({ getContext: () => ({ canvas: {} }) }) as unknown as OffscreenCanvas })
    expect(() => o.outputStream()).toThrow(expect.objectContaining({ code: 'unsupported' }))
  })

  it('record: picks the type, adds the host audio, gives the chunks as one Blob on stop', async () => {
    supported = new Set(['video/webm;codecs=vp9', 'video/webm;codecs=vp9,opus'])
    const o = outputs()
    const mic = new FakeTrack('audio')
    const rec = o.record({ audio: new FakeStream([mic]) as unknown as MediaStream, videoBitsPerSecond: 4e6 })
    const recorder = FakeRecorder.instances[0]!
    expect(rec.mimeType).toBe('video/webm;codecs=vp9,opus')
    expect(recorder.options).toEqual({ mimeType: 'video/webm;codecs=vp9,opus', videoBitsPerSecond: 4e6 })
    expect(recorder.stream.tracks.map((t) => t.kind)).toEqual(['video', 'audio'])
    expect([rec.state, recorder.timeslice, o.active]).toEqual(['recording', 1000, true])
    rec.pause()
    expect(rec.state).toBe('paused')
    rec.resume()
    recorder.emit('a,')
    const stopped = rec.stop()
    expect(rec.stop()).toBe(stopped)
    const blob = await stopped
    expect([blob.type, await blob.text()]).toEqual(['video/webm;codecs=vp9,opus', 'a,end'])
    expect(await rec.done).toBe(blob)
    expect(rec.state).toBe('inactive')
    expect(o.active).toBe(false)
    expect(recorder.stream.tracks.map((t) => t.readyState)).toEqual(['ended', 'live']) // the mic stays the host's
  })

  it('record: refuses a type the browser cannot record, and works without MediaRecorder only to say so', () => {
    supported = new Set(['video/webm'])
    expect(() => outputs().record({ mimeType: 'video/mp4;codecs=avc1' })).toThrow(OuafError)
    expect(outputs().record({ mimeType: 'video/webm' }).mimeType).toBe('video/webm')
    expect(outputs().record().mimeType).toBe('video/webm')
    expect(() => outputs({ MediaRecorder: undefined }).record()).toThrow(expect.objectContaining({ code: 'unsupported' }))
  })

  it('dispose: rejects pending snapshots, ends recordings and the tracks of the streams', async () => {
    supported = new Set(['video/webm'])
    const o = outputs()
    const snap = o.snapshot()
    const stream = o.outputStream()
    const rec = o.record()
    o.dispose()
    await expect(snap).rejects.toMatchObject({ code: 'disposed' })
    expect(await (await rec.done).text()).toBe('end')
    expect(stream.getVideoTracks()[0]!.readyState).toBe('ended')
    expect(o.active).toBe(false)
    expect(() => o.snapshot()).toThrow(expect.objectContaining({ code: 'disposed' }))
    expect(() => o.outputStream()).toThrow(expect.objectContaining({ code: 'disposed' }))
    o.dispose()
  })
})
