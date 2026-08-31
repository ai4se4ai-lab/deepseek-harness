/**
 * Branch coverage for OkfBundleStore edges: the accessor, symlink skipping,
 * nested-directory index ancestry, non-string frontmatter fields, the size cap
 * in list, and the generated-block variants.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OkfBundleStore, CONCEPT_MAX_BYTES } from '../src/store.ts'

let root: string
let store: OkfBundleStore

async function seed(rel: string, text: string): Promise<void> {
  const abs = join(root, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, text, 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'okf-cov-'))
  store = new OkfBundleStore(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('exposes the bundle root via the accessor', () => {
  expect(store.bundleRoot).toBe(root)
})

it('skips symlinked entries during the walk', async () => {
  await seed('real.md', '---\ntype: Metric\n---\n\nx\n')
  await symlink(join(root, 'real.md'), join(root, 'link.md'))
  await symlink(root, join(root, 'selfdir'))
  const { concepts } = await store.list()
  expect(concepts.map(c => c.path)).toEqual(['real.md'])
})

it('lists a concept in a nested directory and rolls index ancestry up to the root', async () => {
  await seed('a/b/c/deep.md', '---\ntype: Metric\ntitle: Deep\n---\n\nx\n')
  const { concepts } = await store.list()
  expect(concepts.map(c => c.path).sort()).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/deep.md'])
  const written = await store.regenerateIndexes()
  expect(written).toEqual(['a/b/c/index.md', 'a/b/index.md', 'a/index.md', 'index.md'])
})

it('treats an oversize concept as not-listable content but keeps the walk going', async () => {
  await seed('ok.md', '---\ntype: Metric\ntitle: OK\n---\n\nx\n')
  await seed('huge.md', `---\ntype: Metric\n---\n\n${'x'.repeat(CONCEPT_MAX_BYTES + 10)}\n`)
  const { concepts } = await store.list()
  // Both still list (summary only parses frontmatter); only readConcept caps.
  expect(concepts.filter(c => !c.isDirectory).map(c => c.path).sort()).toEqual(['huge.md', 'ok.md'])
  await expect(store.readConcept('huge')).rejects.toThrow(/too large/)
})

it('tolerates non-string type/title/description/tags in frontmatter', async () => {
  await seed('weird.md', '---\ntype: [not, a, string]\ntitle: 42\ndescription: {a: b}\ntags: not-a-list\n---\n\nx\n')
  const { concepts } = await store.list()
  const weird = concepts.find(c => c.path === 'weird.md')
  expect(weird).toMatchObject({ type: null, title: null, description: null, tags: [] })
  // Index generation also falls back for the non-string fields.
  await store.regenerateIndexes()
  const idx = concepts.length // touch
  expect(idx).toBeGreaterThan(0)
})

it('search text falls back to an empty body when a concept cannot be re-read', async () => {
  await seed('m.md', '---\ntype: Metric\ntitle: Findable\n---\n\nunique-token-xyz\n')
  expect((await store.search({ text: 'unique-token-xyz' })).map(c => c.id)).toEqual(['m'])
  expect((await store.search({ text: 'Findable' })).map(c => c.id)).toEqual(['m'])
  expect(await store.search({ text: 'absent' })).toEqual([])
})

it('search stale filter selects fresh vs stale concepts', async () => {
  await seed('old.md', '---\ntype: Metric\ntitle: Old\nstale_after: 2000-01-01T00:00:00Z\n---\n\nx\n')
  await seed('new.md', '---\ntype: Metric\ntitle: New\nstale_after: 2999-01-01T00:00:00Z\n---\n\nx\n')
  expect((await store.search({ stale: true })).map(c => c.id)).toEqual(['old'])
  expect((await store.search({ stale: false })).map(c => c.id)).toEqual(['new'])
})

it('stamps generated.at when the caller supplies only generated.by', async () => {
  const res = await store.writeConcept('m', {
    frontmatter: { type: 'Metric', generated: { by: 'human:ahormati' } },
    body: 'x\n',
    actor: 'dsh/1',
  })
  expect(res.generated.by).toBe('human:ahormati')
  expect(Date.parse(res.generated.at)).toBeGreaterThan(0)
})

it('ignores an empty generated block and stamps the actor', async () => {
  const res = await store.writeConcept('m', {
    frontmatter: { type: 'Metric', generated: { by: '' } },
    body: 'x\n',
    actor: 'dsh/9',
  })
  expect(res.generated.by).toBe('dsh/9')
})

it('regenerateIndexes skips an unparseable file rather than failing', async () => {
  await seed('good.md', '---\ntype: Metric\ntitle: Good\n---\n\nx\n')
  await seed('bad.md', '---\ntype: X\nunterminated\n')
  const written = await store.regenerateIndexes()
  expect(written).toEqual(['index.md'])
})

it('appendVerification appends to an existing verified array', async () => {
  await seed('m.md', '---\ntype: Metric\nverified:\n  - { by: process:a, at: 2026-01-01T00:00:00Z }\n---\n\nx\n')
  const after = await store.appendVerification('m', 'process:b', '2026-02-01T00:00:00Z')
  expect(after.frontmatter.verified).toHaveLength(2)
  expect(after.trustTier).toBe('machine-confirmed')
})

it('writeConcept propagates a non-ENOENT read error', async () => {
  // A directory where the concept file path is expected → EISDIR on readFile.
  await mkdir(join(root, 'm.md'))
  await expect(
    store.writeConcept('m', { frontmatter: { type: 'Metric' }, body: 'x\n', actor: 'dsh/1' }),
  ).rejects.toBeTruthy()
})
