/**
 * The `ctx.okf` service: root resolution (configured root vs. bound tenant id)
 * and delegation to the store.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TenantContextService from '@mindportalix/dsh-tenant-context'
import OkfBundle from '../src/index.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'okf-svc-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function mount(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(OkfBundle, { root, ...config })
  return ctx
}

describe('resolveRoot', () => {
  it('uses the configured root when no tenant context is bound', async () => {
    const ctx = await mount()
    expect(ctx.okf.resolveRoot()).toBe(root)
  })

  it('falls back to $DSH_HOME/<subdir> with neither tenant nor configured root', async () => {
    const ctx = new Context()
    await ctx.plugin(OkfBundle, { subdir: 'kb' })
    expect(ctx.okf.resolveRoot().endsWith('/kb')).toBe(true)
  })

  it('prefers a bound tenant id, resolving under $DSH_HOME/tenants/<id>/<subdir>', async () => {
    const ctx = await mount({ subdir: 'knowledge' })
    await ctx.plugin(TenantContextService)
    const tenantId = 'a'.repeat(32)
    const resolved = ctx.tenantContext.run(tenantId, () => ctx.okf.resolveRoot())
    expect(resolved).toMatch(/tenants\/a{32}\/knowledge$/)
    // Outside the run(), it falls back to the configured root.
    expect(ctx.okf.resolveRoot()).toBe(root)
  })
})

describe('delegation', () => {
  it('round-trips a write → list → read through the service', async () => {
    const ctx = await mount()
    expect((await ctx.okf.list()).concepts).toEqual([])
    const write = await ctx.okf.writeConcept('metrics/revenue', {
      frontmatter: { type: 'Metric', title: 'Revenue' },
      body: '# Definition\nx\n',
      actor: 'dsh/test',
    })
    expect(write.action).toBe('create')
    expect(await ctx.okf.exists()).toBe(true)

    const list = await ctx.okf.list()
    expect(list.concepts.some(c => c.id === 'metrics/revenue')).toBe(true)

    const read = await ctx.okf.readConcept('metrics/revenue')
    expect(read.frontmatter.title).toBe('Revenue')

    expect((await ctx.okf.search({ type: 'Metric' })).map(c => c.id)).toEqual(['metrics/revenue'])

    const verified = await ctx.okf.appendVerification('metrics/revenue', 'human:qa')
    expect(verified.trustTier).toBe('human-reviewed')

    expect(await ctx.okf.regenerateIndexes()).toContain('index.md')
  })
})
