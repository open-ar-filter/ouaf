# Security

Ouaf runs filters written by anyone (third parties, AI agents) on people's faces. A filter must never get data out
of the device, reach the host page, or make it unusable. This page says how to report a hole, what the engine
defends against, and how that is tested.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting: the
repository's **Security** tab, then **Report a vulnerability**. If that is not available, open an issue that only
asks for a private contact, without any detail.

Include the filter (folder or `.ouaf` package) or the steps that show the problem, the browser and its version, and
what you expected. We answer within a week and credit you in the fix unless you prefer otherwise.

Ouaf has no release yet: fixes land on `main`.

## Threat model

What a malicious filter may try, and what stops it (normative rules: [spec §15](docs/spec/ouaf-v1.md)):

| Attack | Defense |
|---|---|
| Send data out (face data, frames) | The script runs in a Worker of a `sandbox` iframe with an opaque origin and a CSP that blocks every request (`connect-src 'none'`, `default-src 'none'`); the runtime also removes the network, storage and messaging globals. No remote assets: everything comes from the package. |
| Reach the host page (DOM, cookies, storage) | Opaque origin: none of the page's objects or storage are reachable from the sandbox. |
| Rewrite the runtime's messages (the script shares its Worker) | The host checks every field of every answer, bounds warnings and messages (64 KB, 60 a second), and stops a script whose answer cannot be applied. |
| Freeze the page with a loop | The script runs off the rendering thread; a script that does not answer within 1 s is stopped (spec §12.7). |
| Exhaust memory | Only the script's Worker grows; once it is stopped or crashes, the watchdog stops the script. Oversized messages are dropped. A Worker that reaches V8's heap limit takes down its renderer process, and stopping it takes Chromium about 2 s: only a process of its own saves the page. Desktop Chrome runs the sandbox iframe in its own process. **Known limitation on Chrome Android** ([#181](https://github.com/open-ar-filter/ouaf/issues/181)): there the sandbox shares the host page's process, and a heap bomb crashes the page (about 1.4 GB on a Redmi Note 11S), even after the 1 s watchdog has stopped the script. No data leaves. Serving the sandbox from another site (`EngineOptions.sandboxUrl`, below) does not help there: Chrome Android keeps it in the page's process too (measured on that phone, page and sandbox on loopback names). |
| Stall the GPU with a heavy shader | The engine measures the frames that draw author shaders and disables a filter that keeps the GPU busy over 3 s a frame; a GPU reset (context loss) disables it too (spec §11). |
| Zip bomb, path traversal, links in a package | Declared sizes are bounded before anything is inflated, inflating stops at the declared size, and unsafe paths, links, special and duplicate entries are refused (spec §3). |
| Deceptive UI | Layers are drawn into the canvas: a filter cannot create input fields. |

Out of scope: a host that runs untrusted code itself, or loosens the sandbox (for example a CSP that blocks the
sandbox altogether, which only stops scripts from running, see [`docs/privacy.md`](docs/privacy.md)); the browser's
own vulnerabilities; side channels such as timing.

## The sandbox on a site of its own

By default the sandbox is a `srcdoc` iframe. A host can serve the sandbox document itself instead, on another site
than its pages (another registrable domain, e.g. `ouaf-sandbox.example.net` for pages on `example.com`), and pass its
URL:

```ts
import { SANDBOX_HEADERS, sandboxDocument } from '@ouaf/core'
// Server side: answer GET /sandbox.html with sandboxDocument() and the headers of SANDBOX_HEADERS.
const engine = createEngine({ canvas, assetsBaseUrl, sandboxUrl: 'https://ouaf-sandbox.example.net/sandbox.html' })
```

The document only starts the Worker: the runtime and the script still come from the engine, the iframe keeps its
`sandbox` attribute (opaque origin) and the document its CSP, also sent as a header with a `sandbox` directive. It
changes only with `SANDBOX_PROTOCOL`; the engine refuses a copy of another version with an `error` (code `script`).
The page's CSP must allow it in `frame-src`, and no longer needs `script-src 'unsafe-inline'` for the sandbox
([`docs/privacy.md`](docs/privacy.md)). Measured by [`e2e/sandbox.spec.ts`](e2e/sandbox.spec.ts): it starts as fast
as the `srcdoc` sandbox (about 40 ms on Chromium, a few ms more).

What it does for memory ([#181](https://github.com/open-ar-filter/ouaf/issues/181)): a browser that isolates the
sandbox's site runs it in a process of its own, so a script that reaches V8's heap limit crashes that process, not the
page. Desktop Chrome already does so for the `srcdoc` sandbox. Chrome Android does not, for either:

| Chrome Android 158, Redmi Note 11S, heap bomb (`evil-memory`) | Sandbox out of process | Page crashed |
|---|---|---|
| `srcdoc` sandbox | no | 2/3 |
| sandbox from another site (`localhost` page, `127.0.0.1` sandbox) | no | 3/3 |
| both, the page sent with `Cross-Origin-Opener-Policy: same-origin` | no | 3/3 each |

Chrome Android isolates only some sites, picked by heuristics; a sandbox on a public domain was not checked and may be
treated differently. On desktop Chromium with that partial isolation (`--disable-site-isolation-trials`), the sandbox
from another site gets its own process only once its origin is isolated (`--isolate-origins`). The playground's
`?sandbox=cross` loads the sandbox from the other loopback name (`localhost` ↔ `127.0.0.1`; on a phone, through
`adb reverse tcp:5173 tcp:5173`).

## Malicious filters suite

[`filters/evil/`](filters/evil/) holds filters that attack the engine, one per attack above, and archives that break
the package rules ([`filters/evil/zip-bombs.ts`](filters/evil/zip-bombs.ts)). [`e2e/evil.spec.ts`](e2e/evil.spec.ts)
runs them on Chromium, Firefox and WebKit, on a host page without its own CSP (the network, globals and heap attacks
also with the sandbox from another site), and checks that every attempt fails,
that no request gets out (in the browser and on the dev server), and that the page keeps rendering. CI fails if any
of them succeeds.

```sh
npx playwright install --with-deps chromium firefox webkit
npm run fetch-models
npm run test:security           # on Linux without a display: xvfb-run -a npm run test:security
```

A new attack that the engine should resist belongs in this suite, with the fix.
