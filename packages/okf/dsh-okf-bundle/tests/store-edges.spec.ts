/**
 * The remaining OkfBundleStore branches: truncation, directory-shaped concept
 * paths, symlinks and missing titles during index generation, empty-index
 * skipping, non-string generated.at, and the appendLog rethrow guard.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OkfBundleStore, OkfPathError } from '../src/store.ts'

let root: string

async function seed(rel: string, text: string): Promise<void> {
  const abs = join(root, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, text, 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'okf-edge-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('truncates the listing at maxEntries, across sibling directories', async () => {
  await seed('a/one.md', '---\ntype: Metric\n---\n\nx\n')
  await seed('a/two.md', '---\ntype: Metric\n---\n\nx\n')
  await seed('b/three.md', '---\ntype: Metric\n---\n\nx\n')
  const store = new OkfBundleStore(root, { maxEntries: 3 })
  const { concepts, truncated } = await store.list()
  expect(truncated).toBe(true)
  expect(concepts.length).toBe(3)
})

it('does not descend past maxDepth', async () => {
  await seed('l1/l2/l3/deep.md', '---\ntype: Metric\n---\n\nx\n')
  const store = new OkfBundleStore(root, { maxDepth: 1 })
  const { concepts } = await store.list()
  expect(concepts.map(c => c.path)).toEqual(['l1', 'l1/l2'])
})

it('readConcept rejects a path that resolves to a directory', async () => {
  await mkdir(join(root, 'dir.md'))
  const store = new OkfBundleStore(root)
  await expect(store.readConcept('dir')).rejects.toBeInstanceOf(OkfPathError)
})

it('regenerateIndexes skips symlinks and falls back to the file stem when a concept has no title', async () => {
  await seed('metrics/no-title.md', '---\ntype: Metric\n---\n\nx\n')
  await symlink(join(root, 'metrics/no-title.md'), join(root, 'metrics/alias.md'))
  const store = new OkfBundleStore(root)
  await store.regenerateIndexes()
  const idx = await import('node:fs/promises').then(fs => fs.readFile(join(root, 'metrics/index.md'), 'utf8'))
  expect(idx).toContain('* [no-title](no-title.md)')
  expect(idx).not.toContain('alias')
})

it('regenerateIndexes records a plural description for a multi-concept subdirectory', async () => {
  await seed('metrics/a.md', '---\ntype: Metric\ntitle: A\n---\n\nx\n')
  await seed('metrics/b.md', '---\ntype: Metric\ntitle: B\n---\n\nx\n')
  const store = new OkfBundleStore(root)
  await store.regenerateIndexes()
  const rootIdx = await import('node:fs/promises').then(fs => fs.readFile(join(root, 'index.md'), 'utf8'))
  expect(rootIdx).toContain('[metrics](metrics/index.md) - 2 concepts')
})

it('regenerateIndexes skips the index for a directory whose only .md files are unparseable', async () => {
  await seed('junk/bad1.md', '---\nnope\n')
  await seed('junk/bad2.md', '---\nalso nope\n')
  const store = new OkfBundleStore(root)
  // The root still lists the junk/ subdirectory, but junk/index.md is not written.
  const written = await store.regenerateIndexes()
  expect(written).not.toContain('junk/index.md')
})

it('reports generatedAt as null when generated.at is not a string', async () => {
  await seed('m.md', '---\ntype: Metric\ntitle: M\ngenerated: { by: dsh/1, at: 12345 }\n---\n\nx\n')
  const store = new OkfBundleStore(root)
  const summary = (await store.list()).concepts.find(c => c.path === 'm.md')
  expect(summary?.generatedAt).toBeNull()
})

it('writeConcept links the log entry by concept id when the frontmatter has no title', async () => {
  const store = new OkfBundleStore(root)
  await store.writeConcept('notes/untitled', { frontmatter: { type: 'Reference' }, body: 'x\n', actor: 'dsh/1' })
  const log = await import('node:fs/promises').then(fs => fs.readFile(join(root, 'log.md'), 'utf8'))
  expect(log).toContain('[notes/untitled](/notes/untitled.md)')
})

it('search matches text for a concept that has no title', async () => {
  await seed('m.md', '---\ntype: Metric\n---\n\nbody has token qwerty\n')
  const store = new OkfBundleStore(root)
  expect((await store.search({ text: 'qwerty' })).map(c => c.id)).toEqual(['m'])
})

it('ignores non-markdown files in the listing and in index generation', async () => {
  await seed('README.txt', 'not a concept')
  await seed('metrics/notes.txt', 'also not a concept')
  await seed('metrics/revenue.md', '---\ntype: Metric\ntitle: Revenue\n---\n\nx\n')
  const store = new OkfBundleStore(root)
  const { concepts } = await store.list()
  expect(concepts.map(c => c.path).sort()).toEqual(['metrics', 'metrics/revenue.md'])
  await store.regenerateIndexes()
  const idx = await import('node:fs/promises').then(fs => fs.readFile(join(root, 'metrics/index.md'), 'utf8'))
  expect(idx).not.toContain('notes.txt')
})

it('uses the singular "entry" in the sources-shrink message when exactly one source is dropped', async () => {
  const store = new OkfBundleStore(root)
  await store.writeConcept('s', {
    frontmatter: { type: 'Metric', sources: [{ id: 'a', resource: 'x' }] },
    body: 'x\n',
    actor: 'dsh/1',
  })
  await expect(
    store.writeConcept('s', { frontmatter: { type: 'Metric' }, body: 'x\n', actor: 'dsh/1' }),
  ).rejects.toThrow(/sources had 1 entry,/)
})

it('appendLog surfaces a non-ENOENT read failure', async () => {
  await mkdir(join(root, 'log.md')) // reading it as a file → EISDIR, not ENOENT
  const store = new OkfBundleStore(root)
  await expect(store.appendLog({ date: '2026-01-01', kind: 'Update', text: 'x' })).rejects.toBeTruthy()
})
