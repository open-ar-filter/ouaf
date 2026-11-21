import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatIssues, validateManifest } from '@ouaf/spec'
import { describe, expect, it } from 'vitest'

/** Every manifest under `filters/` (demos and browser-test fixtures) must stay valid. */
const root = fileURLToPath(new URL('../../../filters/', import.meta.url))
const manifests = (readdirSync(root, { recursive: true }) as string[]).filter((p) => p.endsWith('manifest.json'))

describe('filters/ folder', () => {
  it('has manifests', () => {
    expect(manifests.length).toBeGreaterThan(0)
  })

  it.each(manifests)('%s is valid', (path) => {
    const result = validateManifest(JSON.parse(readFileSync(join(root, path), 'utf8')))
    expect(result.ok, formatIssues(result, relative(process.cwd(), join(root, path)))).toBe(true)
  })
})
