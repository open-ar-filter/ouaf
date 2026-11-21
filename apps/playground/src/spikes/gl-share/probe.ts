/**
 * Instrumentation for the shared WebGL context spike (#7): counts synchronous GPU→CPU readbacks and the GPU
 * contexts the page creates, so a recording proves (or disproves) that a path does no readback per frame.
 *
 * Installed once, before MediaPipe or three create anything. It wraps a few prototype methods; every WebGL context
 * of the page (three's, MediaPipe's internal OffscreenCanvas contexts, the device-info probe) goes through them.
 */

export interface ReadbackCounters {
  /** `readPixels` and `getBufferSubData` calls (any WebGL context of the page). */
  readbacks: number
  /** Bytes requested by those `readPixels` / `getBufferSubData` calls. */
  readbackBytes: number
  /**
   * Calls that stall on the GPU without transferring data: `clientWaitSync` with a non-zero timeout, `finish`,
   * and `getError` / `checkFramebufferStatus` (a synchronous round trip to the GPU process in Chromium).
   */
  syncCalls: number
  /** `MPMask.getAsFloat32Array` / `getAsUint8Array` calls (a readback when the mask lives on the GPU). */
  maskReads: number
}

export interface ContextCounts {
  webgl: number
  webgl2: number
  webgpu: number
}

export interface Probe {
  /** Totals since installation; read them before and after a frame. */
  readonly counters: Readonly<ReadbackCounters>
  /** Distinct contexts created so far, by type (including lost or unused ones). */
  readonly contexts: Readonly<ContextCounts>
  /** Wraps `MPMask` (loaded with MediaPipe) so mask reads are counted too. Idempotent. */
  watchMasks(mpMask: { prototype: object }): void
}

const counters: ReadbackCounters = { readbacks: 0, readbackBytes: 0, syncCalls: 0, maskReads: 0 }
const contexts: ContextCounts = { webgl: 0, webgl2: 0, webgpu: 0 }
let installed: Probe | undefined

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

function wrap(proto: object, name: string, before: (args: unknown[]) => void): void {
  const target = proto as Record<string, unknown>
  const original = target[name]
  if (typeof original !== 'function' || (original as { __ouafProbe?: true }).__ouafProbe) return
  const fn = original as AnyFn
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    before(args)
    return fn.apply(this, args)
  }
  ;(wrapped as { __ouafProbe?: true }).__ouafProbe = true
  target[name] = wrapped
}

// WebGL enums (same values in WebGL 1 and 2).
const GL = {
  ALPHA: 0x1906,
  RGB: 0x1907,
  RGBA: 0x1908,
  RED: 0x1903,
  RG: 0x8227,
  RED_INTEGER: 0x8d94,
  RG_INTEGER: 0x8228,
  RGB_INTEGER: 0x8d98,
  RGBA_INTEGER: 0x8d99,
  UNSIGNED_BYTE: 0x1401,
  BYTE: 0x1400,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  INT: 0x1404,
  UNSIGNED_INT: 0x1405,
  SHORT: 0x1402,
  UNSIGNED_SHORT: 0x1403,
} as const

function channels(format: number): number {
  switch (format) {
    case GL.RED:
    case GL.RED_INTEGER:
    case GL.ALPHA:
      return 1
    case GL.RG:
    case GL.RG_INTEGER:
      return 2
    case GL.RGB:
    case GL.RGB_INTEGER:
      return 3
    default:
      return 4
  }
}

function bytesPerChannel(type: number): number {
  switch (type) {
    case GL.FLOAT:
    case GL.INT:
    case GL.UNSIGNED_INT:
      return 4
    case GL.HALF_FLOAT:
    case GL.SHORT:
    case GL.UNSIGNED_SHORT:
      return 2
    default:
      return 1 // UNSIGNED_BYTE, BYTE; packed types are approximated
  }
}

/** Installs the probe (once) and returns it. */
export function installProbe(): Probe {
  if (installed) return installed

  const onReadPixels = (args: unknown[]) => {
    counters.readbacks++
    const [, , w, h, format, type] = args as number[]
    if (w !== undefined && h !== undefined && format !== undefined && type !== undefined) {
      counters.readbackBytes += w * h * channels(format) * bytesPerChannel(type)
    }
  }
  const onGetBufferSubData = (args: unknown[]) => {
    counters.readbacks++
    const dst = args[2] as ArrayBufferView | undefined
    if (dst) counters.readbackBytes += dst.byteLength
  }
  const onClientWaitSync = (args: unknown[]) => {
    if (Number(args[2]) > 0) counters.syncCalls++
  }
  const onSyncCall = () => {
    counters.syncCalls++
  }

  for (const ctor of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    if (!ctor) continue
    wrap(ctor.prototype, 'readPixels', onReadPixels)
    for (const name of ['getError', 'checkFramebufferStatus', 'finish']) wrap(ctor.prototype, name, onSyncCall)
  }
  if (globalThis.WebGL2RenderingContext) {
    wrap(WebGL2RenderingContext.prototype, 'getBufferSubData', onGetBufferSubData)
    wrap(WebGL2RenderingContext.prototype, 'clientWaitSync', onClientWaitSync)
  }

  // Context count: distinct context objects returned by getContext, by type.
  const seen = new WeakSet<object>()
  const countContext = (canvasProto: object) => {
    const target = canvasProto as Record<string, unknown>
    const original = target.getContext as AnyFn | undefined
    if (typeof original !== 'function') return
    target.getContext = function (this: unknown, ...args: unknown[]): unknown {
      const ctx = original.apply(this, args)
      const type = args[0]
      if (ctx && typeof ctx === 'object' && !seen.has(ctx)) {
        seen.add(ctx)
        if (type === 'webgl2') contexts.webgl2++
        else if (type === 'webgl' || type === 'experimental-webgl') contexts.webgl++
        else if (type === 'webgpu') contexts.webgpu++
      }
      return ctx
    }
  }
  if (globalThis.HTMLCanvasElement) countContext(HTMLCanvasElement.prototype)
  if (globalThis.OffscreenCanvas) countContext(OffscreenCanvas.prototype)

  installed = {
    counters,
    contexts,
    watchMasks(mpMask) {
      const onMaskRead = () => {
        counters.maskReads++
      }
      wrap(mpMask.prototype, 'getAsFloat32Array', onMaskRead)
      wrap(mpMask.prototype, 'getAsUint8Array', onMaskRead)
    },
  }
  return installed
}

export function describeContexts(c: Readonly<ContextCounts>): string {
  const parts: string[] = []
  if (c.webgl2) parts.push(`webgl2 ×${c.webgl2}`)
  if (c.webgl) parts.push(`webgl ×${c.webgl}`)
  if (c.webgpu) parts.push(`webgpu ×${c.webgpu}`)
  return parts.join(', ') || 'none'
}
