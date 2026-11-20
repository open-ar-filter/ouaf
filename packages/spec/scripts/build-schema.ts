/**
 * Generates the published JSON Schema of the Ouaf v1 manifest from the TypeBox schemas (single source of truth).
 * Outputs: docs/spec/ouaf-v1.schema.json and packages/spec/schema/ouaf-v1.schema.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifestSchema, createRegistry } from '../src/index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const reg = createRegistry()
const vocab: Record<string, string[]> = {
  anchors: [...reg.anchors.keys()],
  scriptData: [...reg.scriptData.keys()],
}

// Registry references become examples (autocompletion) without blocking plugin vocabulary.
const json = JSON.stringify(
  { $schema: 'http://json-schema.org/draft-07/schema#', ...buildManifestSchema(reg) },
  (_key, value) => {
    if (value && typeof value === 'object' && typeof value['x-registry'] === 'string') {
      return { ...value, examples: vocab[value['x-registry']] }
    }
    return value
  },
  2,
)

for (const out of ['docs/spec/ouaf-v1.schema.json', 'packages/spec/schema/ouaf-v1.schema.json']) {
  const file = resolve(root, out)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, json + '\n')
  console.log(`wrote ${out} (${(json.length / 1024).toFixed(1)} kB)`)
}
