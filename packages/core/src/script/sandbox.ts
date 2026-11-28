/**
 * The script sandbox in a browser (spec §15.1): a `sandbox="allow-scripts"` iframe (opaque origin: no access to the
 * host's DOM, cookies or storage) whose CSP blocks every network request, running a dedicated Worker (off the
 * rendering thread, and terminated with the iframe). One sandbox per filter.
 *
 * The engine keeps one end of a `MessageChannel`; the other end goes to the Worker through the iframe, which does
 * nothing else. Removing the iframe terminates the Worker, even one stuck in an infinite loop (the watchdog,
 * spec §12.7).
 *
 * The iframe is a `srcdoc` document by default: no file to host. A `srcdoc` document inherits the host page's CSP, so a
 * host with a CSP must allow inline scripts in it… or keep `script-src` open to `'unsafe-inline'` for frames; when the
 * sandbox does not start, `openSandbox` rejects with an `OuafError('script')` that says so.
 *
 * With `url` (`EngineOptions.sandboxUrl`, #181), the iframe loads the same document (`sandboxDocument()`) from there
 * instead. Served from another site, site isolation puts the iframe and its Worker in a renderer process of their own:
 * a Worker that reaches V8's heap limit then takes down that process, not the host page's (Chrome Android shares one
 * process otherwise). The iframe keeps its `sandbox` attribute, so its origin stays opaque either way.
 */
import { OuafError } from '../engine/errors.ts'
import type { ScriptConnection, ScriptPort } from './host.ts'
import { workerSource } from './runtime.ts'
import { SANDBOX_PROTOCOL, sandboxDocument } from './sandbox-document.ts'

/** How long the sandbox may take to start before `openSandbox` gives up (ms). */
const START_TIMEOUT_MS = 10_000

/** Where the sandbox document comes from. */
export interface SandboxOptions {
  /** URL of a hosted sandbox document (`sandboxDocument()`, served with `SANDBOX_HEADERS`). Default: a `srcdoc`. */
  url?: string
}

/**
 * Opens a sandbox and connects to its Worker: `port` is the engine's end of the channel, `terminate` removes the
 * iframe (and the Worker with it). Rejects with `OuafError('script')` when it cannot start.
 */
export function openSandbox(label: string, options: SandboxOptions = {}): Promise<ScriptConnection> {
  if (typeof document === 'undefined' || !document.body) {
    return Promise.reject(new OuafError('script', `${label}: scripts need a document to create their sandbox (an engine running in a worker cannot run them).`))
  }
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('tabindex', '-1')
  iframe.title = 'ouaf script sandbox'
  iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
  if (options.url === undefined) {
    iframe.srcdoc = sandboxDocument()
  } else {
    // The sandbox's origin does not learn which page hosts it.
    iframe.referrerPolicy = 'no-referrer'
    iframe.src = options.url
  }

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
        const v = (e.data as { v?: unknown }).v
        if (v !== SANDBOX_PROTOCOL) {
          fail(`the sandbox document at ${options.url} is of another version (${String(v)}, expected ${SANDBOX_PROTOCOL}): serve sandboxDocument() of this engine`)
          return
        }
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
      () =>
        fail(
          options.url === undefined
            ? "no answer: a Content-Security-Policy of the page may block the sandbox's inline bootstrap or its blob: worker"
            : `no answer from ${options.url}: check that it serves sandboxDocument() and that the page's frame-src allows it`,
        ),
      START_TIMEOUT_MS,
    )
    window.addEventListener('message', onMessage)
    document.body.appendChild(iframe)
  })
}
