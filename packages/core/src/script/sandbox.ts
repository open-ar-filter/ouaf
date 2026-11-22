/**
 * The script sandbox in a browser (spec §15.1): a `sandbox="allow-scripts"` iframe (opaque origin: no access to the
 * host's DOM, cookies or storage) whose CSP blocks every network request, running a dedicated Worker (off the
 * rendering thread, and terminated with the iframe). One sandbox per filter.
 *
 * The engine keeps one end of a `MessageChannel`; the other end goes to the Worker through the iframe, which does
 * nothing else. Removing the iframe terminates the Worker, even one stuck in an infinite loop (the watchdog,
 * spec §12.7).
 *
 * The iframe is a `srcdoc` document: no file to host. A `srcdoc` document inherits the host page's CSP, so a host
 * with a CSP must allow inline scripts in it… or keep `script-src` open to `'unsafe-inline'` for frames; when the
 * sandbox does not start, `openSandbox` rejects with an `OuafError('script')` that says so.
 */
import { OuafError } from '../engine/errors.ts'
import type { ScriptConnection, ScriptPort } from './host.ts'
import { workerSource } from './runtime.ts'

/** CSP of the sandbox document, inherited by its Worker (spec §15.1): only the bootstrap and `blob:` scripts run. */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; img-src 'none'"

/** How long the sandbox may take to start before `openSandbox` gives up (ms). */
const START_TIMEOUT_MS = 10_000

/**
 * The bootstrap of the iframe: on the engine's `start` message it creates the Worker from `blob:` and hands it the
 * port. It checks that the message comes from its parent, then removes its listener.
 */
const BOOTSTRAP = `
addEventListener('message', function start(e) {
  if (e.source !== parent || !e.data || e.data.t !== 'ouaf:start' || !e.ports[0]) return
  removeEventListener('message', start)
  try {
    var url = URL.createObjectURL(new Blob([e.data.worker], { type: 'text/javascript' }))
    // A classic worker: a module worker does not load from a blob: URL of an opaque origin (Chromium), and import()
    // of script.js works in a classic worker too.
    var w = new Worker(url, { name: 'ouaf-script' })
    w.postMessage({ t: 'port' }, [e.ports[0]])
    parent.postMessage({ t: 'ouaf:started' }, '*')
  } catch (err) {
    parent.postMessage({ t: 'ouaf:failed', message: String(err) }, '*')
  }
})
parent.postMessage({ t: 'ouaf:ready' }, '*')
`

function srcdoc(): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><script>${BOOTSTRAP}</script>`
}

/**
 * Opens a sandbox and connects to its Worker: `port` is the engine's end of the channel, `terminate` removes the
 * iframe (and the Worker with it). Rejects with `OuafError('script')` when it cannot start.
 */
export function openSandbox(label: string): Promise<ScriptConnection> {
  if (typeof document === 'undefined' || !document.body) {
    return Promise.reject(new OuafError('script', `${label}: scripts need a document to create their sandbox (an engine running in a worker cannot run them).`))
  }
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('tabindex', '-1')
  iframe.title = 'ouaf script sandbox'
  iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
  iframe.srcdoc = srcdoc()

  return new Promise((resolve, reject) => {
    let done = false
    const channel = new MessageChannel()
    const terminate = () => {
      window.removeEventListener('message', onMessage)
      channel.port1.close()
      iframe.remove()
    }
    const fail = (message: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      terminate()
      reject(new OuafError('script', `${label}: the script sandbox did not start (${message}).`))
    }
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return
      const t = (e.data as { t?: unknown } | null)?.t
      if (t === 'ouaf:ready') {
        // Opaque origin: the target origin can only be '*'; the message goes to this iframe only.
        iframe.contentWindow!.postMessage({ t: 'ouaf:start', worker: workerSource() }, '*', [channel.port2])
      } else if (t === 'ouaf:started') {
        if (done) return
        done = true
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        // A MessagePort's onmessage receives a MessageEvent, which has the `data` the host reads.
        resolve({ port: channel.port1 as unknown as ScriptPort, terminate })
      } else if (t === 'ouaf:failed') {
        fail(String((e.data as { message?: unknown }).message))
      }
    }
    const timer = setTimeout(
      () => fail("no answer: a Content-Security-Policy of the page may block the sandbox's inline bootstrap or its blob: worker"),
      START_TIMEOUT_MS,
    )
    window.addEventListener('message', onMessage)
    document.body.appendChild(iframe)
  })
}
