# Local by default, remote processing by host plugins

Status: **proposed** (2026-11-22). No issue yet. Once accepted, it changes spec §14 and §15, `docs/privacy.md`, the
plugin API and the contributor rules (see Consequences).

## Question

Ouaf must keep working entirely on the device: no server, no network, offline. Some integrations also want to send
part of the processing to a server. Examples are generative effects (style transfer, ageing, "beauty" models), models
too heavy for low-end phones, and voice effects. Can an integration do that without weakening what Ouaf promises to
the people in front of the camera?

## What the rules say today

- **§15.1 is about filters.** Filter code has no network access. It runs in a sandboxed iframe and Worker with
  `connect-src 'none'`. A filter is untrusted: anyone can write one and a host can load it from anywhere.
- **§14 already lets a plugin do it.** Plugins are trusted code installed by the host. They can add sources, trackers,
  render passes and layer types. Nothing in the spec stops a plugin from sending frames to a server.
- **The wording closes the door.** `docs/privacy.md` starts with "Ouaf processes the camera, the microphone and the face
  data on the device". `AGENTS.md` and `CONTRIBUTING.md` forbid runtime network calls. These sentences are right for the
  engine and the playground, but they read as a ban for every integration.
- **One flow already exists.** MediaPipe sends usage metrics to Google (`docs/privacy.md`). Today the only way to learn
  about it is to read that page.

## Decision

Three levels of trust, each with its own network rule.

| Level | Who writes it | Network | Guarantee |
|---|---|---|---|
| Filter | Anyone (untrusted) | Never | A filter cannot send data off the device, whatever the host does. Unchanged. |
| Engine (`@ouaf/core`, official plugins) | The project | Never by itself | Every v1 feature works locally and offline, with no server. |
| Host and its plugins | The integrator (trusted) | Allowed, declared | An integration can send processing to a server. What leaves the device is declared and visible. |

### 1. Filters stay offline

§15.1 and §15.2 do not change. A filter never knows where a capability runs. It asks for a capability through
`requires.plugins` (for example a `stylize` plugin), and the host provides it locally or remotely. So the same `.ouaf`
file runs on a fully offline host and on a host with a server. A filter gallery does not have to vet network
behaviour, because filters have none.

The host already receives the data a script sends with `f.emit` (§12.4). That data is limited to what the script was
given through `uses`. The host is trusted, so this decision does not change that channel.

### 2. The engine stays local

`@ouaf/core` and the official plugins make no network call of their own. They only fetch their files from
`assetsBaseUrl`. The playground, the e2e tests and the demo filters (#37) stay 100 % local. An official plugin can
offer a remote mode only if it has a local mode too, so that a remote mode never becomes the only way to get a feature.

### 3. Host plugins may process remotely, and declare it

A plugin that sends data off the device declares it:

```ts
const stylize: OuafPlugin = {
  name: 'acme-stylize',
  version: '1.0.0',
  dataFlows: [{
    data: ['video'],                     // what leaves: video, audio, landmarks, blendshapes, pose, metrics
    destination: 'https://fx.acme.example',
    when: 'layer',                       // 'always' (sources, trackers) or 'layer' (only while one of its layers is shown)
    purpose: { en: 'Style transfer on Acme servers', fr: 'Transfert de style sur les serveurs Acme' },
  }],
  setup(api) { /* … */ },
}
```

The engine then has three duties:

- **It exposes the flows.** `engine.dataFlows()` lists the flows the installed plugins declare and marks those
  active now. An active flow is one from a source or tracker in use, or from a layer type that a shown filter uses.
  An event `engine.on('dataFlows', …)` fires when that set changes. The host uses them to inform the person, ask for
  consent and show an indicator while data leaves.
- **It requires opt-in.** `createEngine` refuses a plugin that declares flows unless the host passes
  `allowDataFlows: true`. Adding an npm package therefore never turns on remote processing silently.
- **It applies the rules to the tracker too.** The built-in face tracker declares MediaPipe's metrics as a flow
  (`data: ['metrics']`, destination `https://odml.pa.googleapis.com`, `when: 'always'`). It is exempt from the
  opt-in, because the metrics are on by default today. A host can still block them with its CSP.

### Enforcement is the host's CSP

The declaration is information. The engine cannot check what a server does, or whether a plugin lies. The host's
`Content-Security-Policy` is what actually controls the network: `connect-src` lists the servers the page may reach.
`docs/privacy.md` already explains this for MediaPipe. A host that wants a guarantee lists the declared destinations
in `connect-src`, and nothing else.

### Rules that still apply to remote plugins

- **§15.3, no identification.** A plugin, local or remote, MUST NOT recognize or re-identify a person. Face ids stay
  ephemeral and are not sent as stable identifiers.
- **§15.7, expressions not emotions.** Emotion inference stays reserved for an explicit plugin, and hosts in education
  or workplace settings MUST disable it. Sending the face to a server does not lift that rule.
- **§12.7 and §16, rendering never waits.** A remote plugin MUST NOT block rendering. It renders the latest result it
  has, or nothing, as the engine does with tracking (§16.1). Its latency is its own problem, not the frame's.
- **Minimization.** A plugin sends only what its purpose needs. For example, it sends a face crop rather than the
  whole frame, or landmarks rather than images, when that is enough.

These are obligations of the plugin author and the host. The engine cannot enforce them.

## Rejected alternatives

- **Network access for filters**, with an allowlist of URLs in the manifest. A filter is untrusted and portable. Any
  allowlist becomes an exfiltration channel the person cannot judge, and every gallery would have to review servers.
- **No remote processing at all.** Integrators would do it anyway, around the engine: they would read the canvas, send
  it and draw the result. That gives no declaration, no indicator and no shared rules. It is better to give them a
  declared path.
- **Remote processing in the core**, for example a generic `remote` layer type. It would put a server protocol in the
  format and make the engine depend on a network. The plugin system already covers this.
- **Declaration without opt-in.** It is simpler, but a dependency update could start sending frames without the host
  noticing.

## Consequences

If this note is accepted:

- **Spec §14:** plugins MAY process data off the device if they declare it (`dataFlows`). Official plugins never
  require it.
- **Spec §15:** a new rule on remote processing by plugins (declaration, opt-in, `dataFlows()`). It states that
  §15.3, §15.7 and the no-blocking rule apply to plugins too. §15.1 is unchanged.
- **`docs/privacy.md`:** the opening says "nothing leaves the device by default; anything that leaves goes through a
  plugin the host installed and declared". It gets a section for integrators: declaring a flow, informing people,
  restricting `connect-src`. The MediaPipe section becomes the first declared flow.
- **`AGENTS.md` and `CONTRIBUTING.md`:** "no runtime network calls from the engine, the official plugins or the
  playground". The rule stays for the project's own code.
- **`packages/core`:** `OuafPlugin.dataFlows`, the `allowDataFlows` option, `engine.dataFlows()` and the event, plus
  unit tests. The validator does not change, because filters declare nothing new.
- **Demo filters (#37):** generative transforms move from "out of scope" to "possible with a host plugin". The demos
  stay local.

## Open questions

- Should `data` stay a closed list (video, audio, landmarks, blendshapes, pose, metrics), or can plugins add their own
  kinds?
- Should a filter be able to say it works better with a capability that is often remote, so a host or gallery can warn
  ahead of time? The current answer is no, because it is the host's choice.
- Should the engine pause flows while the page is hidden, or leave that to each plugin?
- Should an indicator be mandatory? The spec cannot bind a host's UI. It could be a SHOULD with a reference component
  in the playground.
