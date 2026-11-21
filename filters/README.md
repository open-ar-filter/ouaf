# Filters

Filter folders served by the playground at `/filters/<path>/` (`manifest.json` + `assets/`), loaded with
`engine.addFilter('/filters/<path>/')` or `/engine.html?filter=/filters/<path>/`.

- `fixtures/`: small filters used by the browser tests (`e2e/`). They may use the playground's test plugin
  (`playground:*` layer types, `apps/playground/src/engine/test-plugin.ts`).
- Demo filters (#37) go next to it, one folder per filter id.
