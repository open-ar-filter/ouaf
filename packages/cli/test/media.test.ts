import { describe, expect, it } from 'vitest'
import { sniff } from '../src/media.ts'
import { avif, bytes, glb, jpeg, ktx2, mp4, png, webm, webpExtended, webpLossless } from './helpers.ts'

describe('sniff: formats and header dimensions', () => {
  it.each([
    ['png', png(300, 200), { format: 'png', width: 300, height: 200 }],
    ['jpeg', jpeg(5000, 12), { format: 'jpeg', width: 5000, height: 12 }],
    ['webp lossless', webpLossless(640, 480), { format: 'webp', width: 640, height: 480 }],
    ['webp extended', webpExtended(4097, 10), { format: 'webp', width: 4097, height: 10 }],
    ['ktx2', ktx2(1024, 512), { format: 'ktx2', width: 1024, height: 512 }],
    ['avif', avif(2048, 1024), { format: 'avif', width: 2048, height: 1024 }],
    ['mp4 h264', mp4('avc1', 1280, 720), { format: 'mp4', codec: 'h264', width: 1280, height: 720 }],
    ['mp4 hevc', mp4('hvc1', 1920, 1080), { format: 'mp4', codec: 'hevc', width: 1920, height: 1080 }],
    ['webm vp9', webm('V_VP9', 720, 1280), { format: 'webm', codec: 'vp9', width: 720, height: 1280 }],
    ['webm vp8', webm('V_VP8', 320, 240), { format: 'webm', codec: 'vp8', width: 320, height: 240 }],
  ])('%s', (_, data, expected) => {
    expect(sniff(data)).toEqual(expected)
  })

  it('recognizes the other formats of spec §10.2 by their magic bytes', () => {
    expect(sniff(glb({ asset: { version: '2.0' } }))?.format).toBe('glb')
    expect(sniff(bytes('OggS\0\x02' + '\0'.repeat(22) + 'OpusHead'))).toEqual({ format: 'ogg', opus: true })
    expect(sniff(bytes('ID3\x04\0\0\0\0\0\0'))?.format).toBe('mp3')
    expect(sniff(bytes('RIFF\0\0\0\0WAVEfmt '))?.format).toBe('wav')
    expect(sniff(bytes('wOF2\0\x01\0\0'))?.format).toBe('woff2')
    expect(sniff(bytes('OTTO\0\x0a'))?.format).toBe('sfnt')
    expect(sniff(bytes('<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'))?.format).toBe('svg')
    expect(sniff(bytes('  { "a": 1 }'))?.format).toBe('json')
    expect(sniff(bytes('vec4 effect(vec2 uv) {}'))?.format).toBe('text')
    expect(sniff(bytes('GIF89a\x10\0\x10\0'))).toEqual({ format: 'gif', width: 16, height: 16 })
    expect(sniff(Uint8Array.from([0, 0xff, 0xfe, 0x80, 0]))).toBeUndefined()
  })

  it('never throws on truncated headers', () => {
    for (const data of [png(10, 10), jpeg(10, 10), mp4('avc1', 10, 10), webm('V_VP9', 10, 10), avif(10, 10)]) {
      for (let n = 0; n < data.length; n += 3) expect(() => sniff(data.subarray(0, n))).not.toThrow()
    }
  })
})
