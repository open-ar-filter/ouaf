# Malicious filters

Filters that attack the engine (#27). Each one must fail: [`e2e/evil.spec.ts`](../../e2e/evil.spec.ts) runs them on
Chromium, Firefox and WebKit (`npm run test:security`), and CI fails if any of them succeeds. The threat model is in
[`SECURITY.md`](../../SECURITY.md).

They are valid filters (`ouaf validate` accepts them): what makes them malicious is what their script or shader does.
Most attack when the test sends them a host message, so that each attack starts on a running engine.

| Filter | Attack | Expected |
|---|---|---|
| [`network`](network/) | every network API of a Worker (fetch, XHR, WebSocket, EventSource, importScripts, `import()`, workers, fonts, WebAssembly streaming, storage, BroadcastChannel), to the host's origin and another one | every attempt `blocked`, no request gets out |
| [`globals`](globals/) | gets the removed globals back (prototype chain, function constructors, eval, string timers, `blob:` and `data:` modules, a nested worker), reaches the host page | every attempt `blocked` |
| [`forge`](forge/) | hooks `MessagePort.prototype.postMessage` to take the runtime's port, rewrites its answers (invalid commands, `__proto__` keys, 1 000 long warnings, oversized and too many emits, wrong canvas images), then swallows the frames | the host ignores what it cannot use, warnings stay bounded, no prototype pollution; the watchdog stops the script |
| [`loop-setup`](loop-setup/) | a `setup` that never returns | stopped after 1 s, rendering goes on |
| [`loop`](loop/) | a synchronous loop, or an endless chain of microtasks, in a frame | stopped after 1 s, rendering goes on |
| [`memory`](memory/) | allocates without bound (objects, array buffers), sends 32 MB messages | the page survives, the script is stopped; messages over 64 KB are dropped. On Chrome Android (not tested here) the heap bomb still crashes the page (#181) |
| [`heavy-shader`](heavy-shader/) | a post shader that loops `iterations` times a pixel (a million by default) | disabled by the GPU watchdog (or after a GPU reset), rendering resumes |
| [`zip-bombs.ts`](zip-bombs.ts) | archives built by the test: entries that inflate past their declared size, over 50 MB declared, over 1000 entries, `..` and absolute paths, a symbolic link, a duplicate entry | refused with a `PackageError`, nothing loaded |

The test sends the attacks' targets (the dev server's sink `/__evil__/…`, which records every request that reaches
it, and `https://evil.invalid/`), and removes the playground page's own CSP: the sandbox must hold by itself.

All files here are our own work, dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
