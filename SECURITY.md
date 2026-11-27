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
| Exhaust memory | Only the script's Worker grows; once it is stopped or crashes, the watchdog stops the script. Oversized messages are dropped. A Worker that reaches V8's heap limit takes down its renderer process, and stopping it takes Chromium about 2 s: only a process of its own saves the page. Desktop Chrome runs the sandbox iframe in its own process. **Known limitation on Chrome Android** ([#181](https://github.com/open-ar-filter/ouaf/issues/181)): there the sandbox shares the host page's process, and a heap bomb crashes the page (about 1.4 GB on a Redmi Note 11S), even after the 1 s watchdog has stopped the script. No data leaves; the fix is a sandbox that Android isolates too. |
| Stall the GPU with a heavy shader | The engine measures the frames that draw author shaders and disables a filter that keeps the GPU busy over 3 s a frame; a GPU reset (context loss) disables it too (spec §11). |
| Zip bomb, path traversal, links in a package | Declared sizes are bounded before anything is inflated, inflating stops at the declared size, and unsafe paths, links, special and duplicate entries are refused (spec §3). |
| Deceptive UI | Layers are drawn into the canvas: a filter cannot create input fields. |

Out of scope: a host that runs untrusted code itself, or loosens the sandbox (for example a CSP that blocks the
sandbox altogether, which only stops scripts from running, see [`docs/privacy.md`](docs/privacy.md)); the browser's
own vulnerabilities; side channels such as timing.

## Malicious filters suite

[`filters/evil/`](filters/evil/) holds filters that attack the engine, one per attack above, and archives that break
the package rules ([`filters/evil/zip-bombs.ts`](filters/evil/zip-bombs.ts)). [`e2e/evil.spec.ts`](e2e/evil.spec.ts)
runs them on Chromium, Firefox and WebKit, on a host page without its own CSP, and checks that every attempt fails,
that no request gets out (in the browser and on the dev server), and that the page keeps rendering. CI fails if any
of them succeeds.

```sh
npx playwright install --with-deps chromium firefox webkit
npm run fetch-models
npm run test:security           # on Linux without a display: xvfb-run -a npm run test:security
```

A new attack that the engine should resist belongs in this suite, with the fix.
