/**
 * The document of the script sandbox (spec §15.1), and what a host needs to serve it from an origin of its own
 * (`EngineOptions.sandboxUrl`, #181). By default the engine writes it into a `srcdoc` iframe; served from another site,
 * it does not inherit the page's CSP, and a browser that isolates that site gives the iframe and its Worker a renderer
 * process of their own (`SECURITY.md`: not Chrome Android).
 *
 * The document only bootstraps the Worker: the runtime comes from the engine (`ouaf:start`), so a hosted copy only
 * changes when `SANDBOX_PROTOCOL` does.
 */

/** CSP of the sandbox document, inherited by its Worker (spec §15.1): only the bootstrap and `blob:` scripts run. */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; img-src 'none'"

/**
 * Version of the messages between the engine and the sandbox document. The document sends it in `ouaf:ready`; the
 * engine refuses a hosted document of another version (an outdated copy), rather than waiting for its timeout.
 */
export const SANDBOX_PROTOCOL = 1

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
parent.postMessage({ t: 'ouaf:ready', v: ${SANDBOX_PROTOCOL} }, '*')
`

/** The sandbox document: what the engine puts in `srcdoc`, and what a host serves at its `sandboxUrl`. */
export function sandboxDocument(): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><script>${BOOTSTRAP}</script>`
}

/**
 * Response headers of a hosted sandbox document (`sandboxUrl`). The `sandbox` directive gives the document an opaque
 * origin even when it is framed without the iframe's `sandbox` attribute, or opened on its own. A host may add
 * `frame-ancestors` with the origins of its pages.
 */
export const SANDBOX_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': `sandbox allow-scripts; ${SANDBOX_CSP}`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}
