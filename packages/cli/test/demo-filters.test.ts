import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validatePath } from '../src/validate.ts'
import { formatReport } from '../src/report.ts'

/**
 * The demo filters (#37, `filters/<id>/`) are what `ouaf validate` accepts without a warning, and every one is listed
 * in `filters/demos.json` (the playground's list and the browser test of their reference images).
 */
const root = join(import.meta.dirname, '../../../filters')
const folders = readdirSync(root).filter((name) => name !== 'fixtures' && statSync(join(root, name)).isDirectory()).sort()
const index = JSON.parse(readFileSync(join(root, 'demos.json'), 'utf8')) as { demos: Array<{ id: string; clip: string; maxFaces: number }> }

describe('demo filters', () => {
  it('are all listed in filters/demos.json, and only them', () => {
    expect(folders.length).toBeGreaterThan(0)
    expect(index.demos.map((d) => d.id).sort()).toEqual(folders)
  })

  it.each(folders)('%s passes ouaf validate without warnings', async (id) => {
    const report = await validatePath(join(root, id))
    expect(report.errors.concat(report.warnings), formatReport(report)).toEqual([])
    // The folder id is the filter id.
    expect(JSON.parse(readFileSync(join(root, id, 'manifest.json'), 'utf8')).id).toBe(id)
  })

  it('cover the seven v1 layer types', () => {
    const types = new Set(folders.flatMap((id) => (JSON.parse(readFileSync(join(root, id, 'manifest.json'), 'utf8')).layers as Array<{ type: string }>).map((l) => l.type)))
    expect([...types].sort()).toEqual(['canvas', 'color', 'model', 'shader', 'sticker', 'text', 'warp'])
  })
})
