/**
 * OkfBundleStore: traversal, read, search, write (with the no-shrink guard and
 * generated stamping), verification append, and index/log regeneration, all
 * against a temp bundle directory.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OkfBundleStore, OkfPathError, OkfShrinkError, bundleKey } from '../src/store.ts'

let root: string
let store: OkfBundleStore

async function seed(rel: string, text: string): Promise<void> {
  const abs = join(root, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, text, 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'okf-store-'))
  store = new OkfBundleStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('exists / list on an empty root', () => {
  it('reports a missing bundle without throwing', async () => {
    await rm(root, { recursive: true, force: true })
    expect(await store.exists()).toBe(false)
    expect(await store.list()).toEqual({ exists: false, concepts: [], truncated: false })
    expect(await store.search({ text: 'x' })).toEqual([])
    expect(await store.regenerateIndexes()).toEqual([])
  })

  it('reports exists:false when the root is a file, not a directory', async () => {
    await rm(root, { recursive: true, force: true })
    await writeFile(root, 'not a dir')
    expect(await store.list()).toMatchObject({ exists: false })
  })
})

describe('list', () => {
  beforeEach(async () => {
    await seed('index.md', '# Metric\n\n* [Revenue](metrics/revenue.md)\n')
    await seed(
      'metrics/revenue.md',
      '---\ntype: Metric\ntitle: Revenue\ndescription: Recognized revenue.\ntags: [finance, revenue]\nstatus: stable\n' +
        'generated: { by: dsh/1, at: 2026-06-01T00:00:00Z }\n' +
        'verified:\n  - { by: human:jsmith, at: 2026-07-01T09:00:00Z }\n' +
        'stale_after: 2020-01-01T00:00:00Z\n---\n\n# Definition\nSums `amount`.\n',
    )
    await seed('metrics/draft.md', '---\ntype: Metric\n---\n\nwip\n')
    await seed('broken.md', '---\ntype: X\nunterminated\n')
  })

  it('returns directory rows and parsed concept summaries, sorted by path', async () => {
    const { exists, concepts } = await store.list()
    expect(exists).toBe(true)
    const byPath = Object.fromEntries(concepts.map(c => [c.path, c]))

    expect(byPath['metrics']!.isDirectory).toBe(true)
    expect(byPath['index.md']!.type).toBeNull()

    const rev = byPath['metrics/revenue.md']
    expect(rev).toMatchObject({
      id: 'metrics/revenue',
      type: 'Metric',
      title: 'Revenue',
      tags: ['finance', 'revenue'],
      trustTier: 'human-reviewed',
      stale: true,
      generatedAt: '2026-06-01T00:00:00Z',
      verifiedAt: '2026-07-01T09:00:00Z',
      attested: false,
      issue: null,
    })

    // A draft with only `type` is conformant (SPEC §11) but unverified.
    expect(byPath['metrics/draft.md']).toMatchObject({ trustTier: 'unverified', title: null })

    // An unparseable file lists with an issue rather than crashing the walk.
    expect(byPath['broken.md']!.issue).toMatch(/Unterminated/)

    expect(concepts.map(c => c.path)).toEqual([...concepts.map(c => c.path)].sort((a, b) => a.localeCompare(b)))
  })

  it('marks a non-conformant (typeless) concept with an issue', async () => {
    await seed('typeless.md', '---\ntitle: No type here\n---\n\nbody\n')
    const { concepts } = await store.list()
    expect(concepts.find(c => c.path === 'typeless.md')?.issue).toMatch(/type/)
  })
})

describe('readConcept', () => {
  beforeEach(async () => {
    await seed('computations/revenue-ytd.md',
      '---\ntype: Attested Computation\ntitle: Revenue YTD\nruntime: bigquery\n' +
      'parameters:\n  - { name: year, type: integer, required: true }\n---\n\n# Computation\n\n    SELECT 1\n')
  })

  it('returns raw, parsed frontmatter/body, and derived verdicts', async () => {
    const c = await store.readConcept('computations/revenue-ytd')
    expect(c.id).toBe('computations/revenue-ytd')
    expect(c.frontmatter.runtime).toBe('bigquery')
    expect(c.body).toContain('SELECT 1')
    expect(c.trustTier).toBe('unverified')
    expect(c.stale).toBe(false)
    expect(c.raw.startsWith('---')).toBe(true)
  })

  it('accepts an id with or without the .md suffix', async () => {
    expect((await store.readConcept('computations/revenue-ytd.md')).id).toBe('computations/revenue-ytd')
  })

  it('rejects a traversal id', async () => {
    await expect(store.readConcept('../../../etc/passwd')).rejects.toBeInstanceOf(OkfPathError)
    await expect(store.readConcept('/etc/passwd')).rejects.toBeInstanceOf(OkfPathError)
    await expect(store.readConcept('')).rejects.toBeInstanceOf(OkfPathError)
  })

  it('throws ENOENT for a missing concept', async () => {
    await expect(store.readConcept('nope')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a concept file above the size cap', async () => {
    await seed('big.md', `---\ntype: X\n---\n\n${'a'.repeat(600 * 1024)}\n`)
    await expect(store.readConcept('big')).rejects.toBeInstanceOf(OkfPathError)
  })
})

describe('search', () => {
  beforeEach(async () => {
    await seed('metrics/revenue.md', '---\ntype: Metric\ntitle: Revenue\ntags: [finance, headline]\n---\n\nSums amounts.\n')
    await seed('metrics/margin.md', '---\ntype: Metric\ntitle: Margin\ntags: [finance]\n---\n\nProfit over revenue.\n')
    await seed('policies/rev-rec.md', '---\ntype: Policy\ntitle: Revenue recognition\ntags: [finance]\nverified: { by: human:a, at: 2026-01-01T00:00:00Z }\n---\n\nText.\n')
  })

  it('filters by type', async () => {
    expect((await store.search({ type: 'Policy' })).map(c => c.id)).toEqual(['policies/rev-rec'])
  })

  it('filters by every provided tag', async () => {
    expect((await store.search({ tags: ['finance', 'headline'] })).map(c => c.id)).toEqual(['metrics/revenue'])
    expect((await store.search({ tags: ['finance'] })).map(c => c.id).sort()).toEqual(
      ['metrics/margin', 'metrics/revenue', 'policies/rev-rec'],
    )
  })

  it('filters by trust tier', async () => {
    expect((await store.search({ trustTier: 'human-reviewed' })).map(c => c.id)).toEqual(['policies/rev-rec'])
  })

  it('filters by case-insensitive text over id, title, description, and body', async () => {
    expect((await store.search({ text: 'PROFIT' })).map(c => c.id)).toEqual(['metrics/margin'])
    expect((await store.search({ text: 'rev-rec' })).map(c => c.id)).toEqual(['policies/rev-rec'])
  })

  it('excludes directory rows and returns [] on no match', async () => {
    expect(await store.search({ text: 'nothing-matches-this' })).toEqual([])
  })
})

describe('writeConcept', () => {
  it('creates a concept, stamps generated, and writes index + log', async () => {
    const res = await store.writeConcept('metrics/revenue', {
      frontmatter: { type: 'Metric', title: 'Revenue', description: 'Recognized revenue.' },
      body: '# Definition\nSums `amount`.\n',
      actor: 'dsh/0.1.0',
    })
    expect(res.action).toBe('create')
    expect(res.generated.by).toBe('dsh/0.1.0')
    expect(res.generated.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(res.indexesWritten).toEqual(['index.md', 'metrics/index.md'])

    const onDisk = await readFile(join(root, 'metrics/revenue.md'), 'utf8')
    expect(onDisk).toContain('generated:')
    expect(await readFile(join(root, 'metrics/index.md'), 'utf8')).toContain('[Revenue](revenue.md)')
    expect(await readFile(join(root, 'log.md'), 'utf8')).toMatch(/\*\*Creation\*\*.*revenue\.md/)
  })

  it('preserves a caller-supplied generated block', async () => {
    const res = await store.writeConcept('m', {
      frontmatter: { type: 'Metric', generated: { by: 'human:ahormati', at: '2026-01-01T00:00:00Z' } },
      body: 'x\n',
      actor: 'dsh/0.1.0',
    })
    expect(res.generated).toEqual({ by: 'human:ahormati', at: '2026-01-01T00:00:00Z' })
  })

  it('records the second write of a concept as an update', async () => {
    await store.writeConcept('m', { frontmatter: { type: 'Metric' }, body: 'a `x`\n', actor: 'dsh/1' })
    const res = await store.writeConcept('m', { frontmatter: { type: 'Metric' }, body: 'a `x` and `y`\n', actor: 'dsh/1' })
    expect(res.action).toBe('update')
    expect(await readFile(join(root, 'log.md'), 'utf8')).toMatch(/\*\*Update\*\*/)
  })

  it('refuses a non-conformant (typeless) write', async () => {
    await expect(
      store.writeConcept('m', { frontmatter: { title: 'no type' }, body: 'x\n', actor: 'dsh/1' }),
    ).rejects.toBeInstanceOf(OkfShrinkError)
  })

  it('refuses a write that drops backtick identifiers, unless allowShrink', async () => {
    await store.writeConcept('t', { frontmatter: { type: 'BigQuery Table' }, body: '`id` `name` `email`\n', actor: 'dsh/1' })
    await expect(
      store.writeConcept('t', { frontmatter: { type: 'BigQuery Table' }, body: '`id`\n', actor: 'dsh/1' }),
    ).rejects.toThrow(/drops 2 identifier/)
    await expect(
      store.writeConcept('t', { frontmatter: { type: 'BigQuery Table' }, body: '`id`\n', actor: 'dsh/1', allowShrink: true }),
    ).resolves.toMatchObject({ action: 'update' })
  })

  it('refuses a write that shrinks sources, unless allowShrink', async () => {
    await store.writeConcept('s', {
      frontmatter: { type: 'Metric', sources: [{ id: 'a', resource: 'x' }, { id: 'b', resource: 'y' }] },
      body: 'x\n',
      actor: 'dsh/1',
    })
    await expect(
      store.writeConcept('s', {
        frontmatter: { type: 'Metric', sources: [{ id: 'a', resource: 'x' }] },
        body: 'x\n',
        actor: 'dsh/1',
      }),
    ).rejects.toThrow(/sources had 2/)
  })

  it('rejects a traversal id', async () => {
    await expect(
      store.writeConcept('../evil', { frontmatter: { type: 'X' }, body: 'x\n', actor: 'dsh/1' }),
    ).rejects.toBeInstanceOf(OkfPathError)
  })
})

describe('appendVerification', () => {
  beforeEach(async () => {
    await seed('m.md', '---\ntype: Metric\ntitle: M\n---\n\nbody\n')
  })

  it('adds a verified event and lifts the trust tier', async () => {
    const before = await store.readConcept('m')
    expect(before.trustTier).toBe('unverified')
    const after = await store.appendVerification('m', 'human:jsmith', '2026-07-01T09:00:00Z')
    expect(after.trustTier).toBe('human-reviewed')
    expect(after.frontmatter.verified).toEqual([{ by: 'human:jsmith', at: '2026-07-01T09:00:00Z' }])
  })

  it('appends to an existing bare-mapping verified', async () => {
    await seed('n.md', '---\ntype: Metric\nverified: { by: process:nightly, at: 2026-01-01T00:00:00Z }\n---\n\nx\n')
    const after = await store.appendVerification('n', 'human:a', '2026-02-01T00:00:00Z')
    expect(after.frontmatter.verified).toHaveLength(2)
    expect(after.trustTier).toBe('human-reviewed')
  })

  it('defaults the timestamp to now', async () => {
    const after = await store.appendVerification('m', 'process:ci')
    const at = (after.frontmatter.verified as { at: string }[])[0]!.at
    expect(Date.parse(at)).toBeGreaterThan(0)
  })
})

describe('regenerateIndexes', () => {
  it('groups by type with Subdirectories last and reuses a lone child description', async () => {
    await seed('metrics/revenue.md', '---\ntype: Metric\ntitle: Revenue\ndescription: Recognized revenue.\n---\n\nx\n')
    await seed('metrics/margin.md', '---\ntype: Metric\ntitle: Margin\n---\n\nx\n')
    await seed('policies/only.md', '---\ntype: Policy\ntitle: The one policy\ndescription: Sole policy.\n---\n\nx\n')

    const written = await store.regenerateIndexes()
    expect(written).toEqual(['index.md', 'metrics/index.md', 'policies/index.md'])

    const rootIndex = await readFile(join(root, 'index.md'), 'utf8')
    expect(rootIndex).toContain('# Subdirectories')
    expect(rootIndex).toContain('[policies](policies/index.md) - Sole policy.')
    expect(rootIndex.indexOf('metrics')).toBeLessThan(rootIndex.indexOf('# Subdirectories') + rootIndex.length)

    const metricsIndex = await readFile(join(root, 'metrics/index.md'), 'utf8')
    expect(metricsIndex).toContain('* [Margin](margin.md)')
    expect(metricsIndex).toContain('* [Revenue](revenue.md) - Recognized revenue.')
  })

  it('skips a directory that holds only an index.md', async () => {
    await seed('empty/index.md', '# Nothing\n')
    expect(await store.regenerateIndexes()).toEqual([])
  })
})

describe('bundleKey', () => {
  it('is a stable 12-char hex digest of the root', () => {
    expect(bundleKey('/a')).toMatch(/^[0-9a-f]{12}$/)
    expect(bundleKey('/a')).toBe(bundleKey('/a'))
    expect(bundleKey('/a')).not.toBe(bundleKey('/b'))
  })
})
