import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validatePath } from '../src/validate.ts'
import { formatReport } from '../src/report.ts'

/**
 * The demo filters (#37): every one listed in `filters/demos.json` (the playground's list and the browser test of
 * their reference images) is a folder `filters/<id>/` that `ouaf validate` accepts without a warning. Other folders
 * of `filters/` (fixtures, an author's own filters) are not demos.
 */
const root = join(import.meta.dirname, '../../../filters')
const index = JSON.parse(readFileSync(join(root, 'demos.json'), 'utf8')) as { demos: Array<{ id: string; clip: string; maxFaces: number }> }
const ids = index.demos.map((d) => d.id)
const manifest = (id: string) => JSON.parse(readFileSync(join(root, id, 'manifest.json'), 'utf8')) as { id: string; layers: Array<{ type: string }> }

describe('demo filters', () => {
  it('are listed once each, with a test clip', () => {
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    for (const demo of index.demos) {
      expect(existsSync(join(root, '../test-media', `${demo.clip}.mp4`)), `${demo.id}: test-media/${demo.clip}.mp4`).toBe(true)
      expect(demo.maxFaces).toBeGreaterThanOrEqual(1)
    }
  })

  it.each(ids)('%s passes ouaf validate without warnings', async (id) => {
    const report = await validatePath(join(root, id))
    expect(report.errors.concat(report.warnings), formatReport(report)).toEqual([])
    // The folder name is the filter id.
    expect(manifest(id).id).toBe(id)
  })

  it('cover the seven v1 layer types', () => {
    const types = new Set(ids.flatMap((id) => manifest(id).layers.map((l) => l.type)))
    expect([...types].sort()).toEqual(['canvas', 'color', 'model', 'shader', 'sticker', 'text', 'warp'])
  })
})
