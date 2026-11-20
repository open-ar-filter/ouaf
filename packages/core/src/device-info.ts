/**
 * Best-effort description of the device and browser, stored with performance recordings. Every field is
 * optional: browsers expose different subsets, and some values are rounded or masked for privacy.
 */
export interface DeviceInfo {
  userAgent?: string
  /** `navigator.platform` (deprecated but still informative, e.g. "iPhone" or "Linux armv8l"). */
  platform?: string
  language?: string
  /** User-Agent Client Hints (Chromium only), including the high-entropy values when granted. */
  userAgentData?: UserAgentDataInfo
  /** Logical processors. */
  hardwareConcurrency?: number
  /** Approximate RAM in GiB, rounded and capped by the browser (Chromium only). */
  deviceMemory?: number
  maxTouchPoints?: number
  screen?: ScreenInfo
  gpu?: GpuInfo
  /** Whether the page is cross-origin isolated, which raises the `performance.now()` precision. */
  crossOriginIsolated?: boolean
  /** Smallest observed `performance.now()` increment (ms): bounds the precision of every timing. */
  timerResolutionMs?: number
}

export interface UserAgentDataInfo {
  brands?: { brand: string; version: string }[]
  mobile?: boolean
  platform?: string
  platformVersion?: string
  model?: string
  architecture?: string
  bitness?: string
  fullVersionList?: { brand: string; version: string }[]
}

export interface ScreenInfo {
  /** CSS pixels. */
  width?: number
  height?: number
  devicePixelRatio?: number
  /** e.g. `portrait-primary`. */
  orientation?: string
}

export interface GpuInfo {
  /** WebGL context used for the query. */
  api?: 'webgl2' | 'webgl'
  /** `VENDOR` / `RENDERER` strings (often generic or masked, e.g. "WebKit WebGL"). */
  vendor?: string
  renderer?: string
  /** Unmasked strings from `WEBGL_debug_renderer_info`, when the extension is exposed. */
  unmaskedVendor?: string
  unmaskedRenderer?: string
  maxTextureSize?: number
}

/** Minimal shape of the globals read by `collectDeviceInfo`, so tests can pass fakes. */
export interface DeviceInfoEnvironment {
  navigator?: unknown
  screen?: unknown
  devicePixelRatio?: number
  crossOriginIsolated?: boolean
  /** Creates a throwaway canvas for the WebGL query; return `undefined` to skip it. */
  createCanvas?: () => unknown
  /** High-resolution clock, for the timer resolution estimate. */
  now?: () => number
}

const HIGH_ENTROPY_HINTS = ['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList']

// WebGL constants (avoid depending on a live context's prototype).
const GL_VENDOR = 0x1f00
const GL_RENDERER = 0x1f01
const GL_MAX_TEXTURE_SIZE = 0x0d33
const UNMASKED_VENDOR_WEBGL = 0x9245
const UNMASKED_RENDERER_WEBGL = 0x9246

function defaultEnvironment(): DeviceInfoEnvironment {
  const g = globalThis as Record<string, unknown>
  return {
    navigator: g.navigator,
    screen: g.screen,
    devicePixelRatio: typeof g.devicePixelRatio === 'number' ? g.devicePixelRatio : undefined,
    crossOriginIsolated: typeof g.crossOriginIsolated === 'boolean' ? g.crossOriginIsolated : undefined,
    createCanvas: () => {
      if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(1, 1)
      if (typeof document !== 'undefined') return document.createElement('canvas')
      return undefined
    },
    now: typeof performance !== 'undefined' ? () => performance.now() : undefined,
  }
}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null
}

/** Reads a property, swallowing getters that throw. */
function get(o: unknown, key: string): unknown {
  if (!isObj(o)) return undefined
  try {
    return o[key]
  } catch {
    return undefined
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function brands(v: unknown): { brand: string; version: string }[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter(isObj).map((b) => ({ brand: String(b.brand), version: String(b.version) }))
}

/** Drops `undefined` fields; returns `undefined` when nothing is left. */
function compact<T extends object>(o: T): T | undefined {
  const out: Obj = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return Object.keys(out).length > 0 ? (out as T) : undefined
}

async function collectUserAgentData(nav: unknown): Promise<UserAgentDataInfo | undefined> {
  const uad = get(nav, 'userAgentData')
  if (!isObj(uad)) return undefined
  const info: UserAgentDataInfo = {
    brands: brands(get(uad, 'brands')),
    mobile: bool(get(uad, 'mobile')),
    platform: str(get(uad, 'platform')),
  }
  const getHigh = get(uad, 'getHighEntropyValues')
  if (typeof getHigh === 'function') {
    try {
      const high: unknown = await getHigh.call(uad, HIGH_ENTROPY_HINTS)
      info.platformVersion = str(get(high, 'platformVersion'))
      info.model = str(get(high, 'model'))
      info.architecture = str(get(high, 'architecture'))
      info.bitness = str(get(high, 'bitness'))
      info.fullVersionList = brands(get(high, 'fullVersionList'))
    } catch {
      // Refused or unsupported hints: keep the low-entropy values.
    }
  }
  return compact(info)
}

function collectScreen(env: DeviceInfoEnvironment): ScreenInfo | undefined {
  const s = env.screen
  return compact<ScreenInfo>({
    width: num(get(s, 'width')),
    height: num(get(s, 'height')),
    devicePixelRatio: num(env.devicePixelRatio),
    orientation: str(get(get(s, 'orientation'), 'type')),
  })
}

/** Queries the GPU strings through a throwaway WebGL context, released right after. */
function collectGpu(env: DeviceInfoEnvironment): GpuInfo | undefined {
  let canvas: unknown
  try {
    canvas = env.createCanvas?.()
  } catch {
    return undefined
  }
  const getContext = get(canvas, 'getContext')
  if (typeof getContext !== 'function') return undefined
  let api: GpuInfo['api']
  let gl: unknown
  for (const type of ['webgl2', 'webgl'] as const) {
    try {
      gl = getContext.call(canvas, type, { failIfMajorPerformanceCaveat: false, powerPreference: 'default' })
    } catch {
      gl = undefined
    }
    if (isObj(gl)) {
      api = type
      break
    }
  }
  if (!isObj(gl)) return undefined
  const call = (name: string, ...args: unknown[]): unknown => {
    const fn = get(gl, name)
    if (typeof fn !== 'function') return undefined
    try {
      return fn.apply(gl, args)
    } catch {
      return undefined
    }
  }
  const info: GpuInfo = {
    api,
    vendor: str(call('getParameter', GL_VENDOR)),
    renderer: str(call('getParameter', GL_RENDERER)),
    maxTextureSize: num(call('getParameter', GL_MAX_TEXTURE_SIZE)),
  }
  // Firefox deprecates this extension (it may warn, and returns the same sanitized strings as RENDERER).
  if (isObj(call('getExtension', 'WEBGL_debug_renderer_info'))) {
    info.unmaskedVendor = str(call('getParameter', UNMASKED_VENDOR_WEBGL))
    info.unmaskedRenderer = str(call('getParameter', UNMASKED_RENDERER_WEBGL))
  }
  const lose = call('getExtension', 'WEBGL_lose_context')
  const loseContext = get(lose, 'loseContext')
  if (typeof loseContext === 'function') {
    try {
      loseContext.call(lose)
    } catch {
      // Ignore: the context is garbage-collected anyway.
    }
  }
  return compact(info)
}

/** Smallest positive increment of the clock over a short busy loop (≤ ~2 ms). */
function estimateTimerResolution(now: () => number): number | undefined {
  try {
    const start = now()
    let prev = start
    let min = Infinity
    let changes = 0
    for (let i = 0; i < 100_000 && changes < 20; i++) {
      const t = now()
      if (t > prev) {
        min = Math.min(min, t - prev)
        prev = t
        changes++
      }
      if (t - start > 2) break
    }
    return Number.isFinite(min) ? Math.round(min * 1e6) / 1e6 : undefined
  } catch {
    return undefined
  }
}

/**
 * Collects what the browser tells about the device: user agent (and Client Hints), CPU and memory hints, screen,
 * GPU strings and timer resolution. Never throws; missing values are left out. Creates and immediately releases
 * a WebGL context, so call it outside of a measured section.
 */
export async function collectDeviceInfo(env: DeviceInfoEnvironment = defaultEnvironment()): Promise<DeviceInfo> {
  const nav = env.navigator
  const info: DeviceInfo = {
    userAgent: str(get(nav, 'userAgent')),
    platform: str(get(nav, 'platform')),
    language: str(get(nav, 'language')),
    userAgentData: await collectUserAgentData(nav),
    hardwareConcurrency: num(get(nav, 'hardwareConcurrency')),
    deviceMemory: num(get(nav, 'deviceMemory')),
    maxTouchPoints: num(get(nav, 'maxTouchPoints')),
    screen: collectScreen(env),
    gpu: collectGpu(env),
    crossOriginIsolated: env.crossOriginIsolated,
    timerResolutionMs: env.now ? estimateTimerResolution(env.now) : undefined,
  }
  return compact(info) ?? {}
}
