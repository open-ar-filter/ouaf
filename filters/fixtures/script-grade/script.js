// Script of the script-grade fixture (#26), as `ouaf pack` would write it: an ES module without imports.

/** Tries one way out of the sandbox: 'blocked' when it throws or is missing, 'OPEN' when it seems to work. */
async function probe(fn) {
  try {
    const result = await fn()
    return result === undefined ? 'blocked' : 'OPEN'
  } catch {
    return 'blocked'
  }
}

export default {
  state: { tints: 0 },
  setup(f) {
    f.emit('ready', { random: f.random() })
  },
  on: {
    'message:tint'(f, { data }) {
      f.state.tints++
      f.layer('grade').set({ tint: data, saturation: -1 })
      f.emit('tinted', f.state.tints)
    },
    'message:fade'(f, { data }) {
      f.layer('grade').animate({ opacity: 0 }, { duration: data, easing: 'linear' })
    },
    async 'message:probe'(f) {
      const g = globalThis
      const results = {
        fetch: await probe(() => g.fetch('/filters/fixtures/script-grade/manifest.json')),
        fetchFromPrototype: await probe(() => Object.getPrototypeOf(g).fetch?.call(g, '/')),
        fetchFromFunction: await probe(() => new Function('return fetch')()('/')),
        xhr: await probe(() => {
          const x = new g.XMLHttpRequest()
          x.open('GET', '/')
          x.send()
          return x
        }),
        webSocket: await probe(() => new g.WebSocket('wss://localhost:5173/')),
        eventSource: await probe(() => new g.EventSource('/')),
        importScripts: await probe(() => g.importScripts('/x.js')),
        worker: await probe(() => new g.Worker('data:text/javascript,1')),
        indexedDB: await probe(() => g.indexedDB.open('x')),
        dynamicImport: await probe(() => import('/filters/fixtures/script-grade/script.js')),
        document: await probe(() => g.document),
        parent: await probe(() => g.parent),
      }
      f.emit('probed', results)
    },
    'message:loop'() {
      for (;;) {
        // The watchdog stops the script after 1 s (spec §12.7).
      }
    },
  },
}
