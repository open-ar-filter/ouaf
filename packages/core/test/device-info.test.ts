import { describe, expect, it, vi } from 'vitest'
import { collectDeviceInfo } from '../src/index.ts'

/** Fake WebGL context answering `getParameter` from a table. */
function fakeGl(params: Record<number, unknown>, extensions: string[]) {
  const loseContext = vi.fn()
  return {
    loseContext,
    gl: {
      getParameter: (p: number) => params[p] ?? null,
      getExtension: (name: string) => (extensions.includes(name) ? (name === 'WEBGL_lose_context' ? { loseContext } : {}) : null),
    },
  }
}

function canvasWith(contexts: Record<string, unknown>) {
  return () => ({ getContext: (type: string) => contexts[type] ?? null })
}

describe('collectDeviceInfo', () => {
  it('collects navigator, screen, client hints and unmasked GPU strings', async () => {
    const { gl, loseContext } = fakeGl(
      { 0x1f00: 'WebKit', 0x1f01: 'WebKit WebGL', 0x0d33: 16384, 0x9245: 'Qualcomm', 0x9246: 'Adreno (TM) 730' },
      ['WEBGL_debug_renderer_info', 'WEBGL_lose_context'],
    )
    let t = 0
    const info = await collectDeviceInfo({
      navigator: {
        userAgent: 'Mozilla/5.0 (Linux; Android 14)',
        platform: 'Linux armv8l',
        language: 'fr-FR',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        maxTouchPoints: 5,
        userAgentData: {
          brands: [{ brand: 'Chromium', version: '142' }],
          mobile: true,
          platform: 'Android',
          getHighEntropyValues: async (hints: string[]) => {
            expect(hints).toContain('model')
            return { model: 'Pixel 8', platformVersion: '14.0.0', architecture: '', fullVersionList: [{ brand: 'Chromium', version: '142.0.1' }] }
          },
        },
      },
      screen: { width: 412, height: 915, orientation: { type: 'portrait-primary' } },
      devicePixelRatio: 2.625,
      crossOriginIsolated: false,
      createCanvas: canvasWith({ webgl2: gl }),
      now: () => (t += 0.1),
    })
    expect(info).toEqual({
      userAgent: 'Mozilla/5.0 (Linux; Android 14)',
      platform: 'Linux armv8l',
      language: 'fr-FR',
      userAgentData: {
        brands: [{ brand: 'Chromium', version: '142' }],
        mobile: true,
        platform: 'Android',
        model: 'Pixel 8',
        platformVersion: '14.0.0',
        fullVersionList: [{ brand: 'Chromium', version: '142.0.1' }],
      },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
      screen: { width: 412, height: 915, devicePixelRatio: 2.625, orientation: 'portrait-primary' },
      gpu: { api: 'webgl2', vendor: 'WebKit', renderer: 'WebKit WebGL', maxTextureSize: 16384, unmaskedVendor: 'Qualcomm', unmaskedRenderer: 'Adreno (TM) 730' },
      crossOriginIsolated: false,
      timerResolutionMs: 0.1,
    })
    expect(loseContext).toHaveBeenCalledOnce()
  })

  it('falls back to WebGL 1 and to RENDERER without the debug extension', async () => {
    const { gl } = fakeGl({ 0x1f01: 'Apple GPU' }, [])
    const info = await collectDeviceInfo({ createCanvas: canvasWith({ webgl: gl }) })
    expect(info).toEqual({ gpu: { api: 'webgl', renderer: 'Apple GPU' } })
  })

  it('keeps the low-entropy client hints when the high-entropy ones are refused', async () => {
    const info = await collectDeviceInfo({
      navigator: { userAgentData: { mobile: false, platform: 'Linux', getHighEntropyValues: () => Promise.reject(new Error('NotAllowed')) } },
    })
    expect(info.userAgentData).toEqual({ mobile: false, platform: 'Linux' })
  })

  it('never throws, whatever the environment', async () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('boom')
        },
      },
    )
    const info = await collectDeviceInfo({
      navigator: throwing,
      screen: throwing,
      createCanvas: () => {
        throw new Error('no canvas')
      },
      now: () => {
        throw new Error('no clock')
      },
    })
    expect(info).toEqual({})
    expect(await collectDeviceInfo({ createCanvas: canvasWith({}) })).toEqual({})
    expect(await collectDeviceInfo({})).toEqual({})
  })
})
