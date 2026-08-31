/**
 * The OKF tool suite driven through the real ToolRuntime: schema shape and each
 * tool's behaviour and error mapping against a real `ctx.okf` over a temp bundle.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import OkfBundle from '@mindportalix/dsh-okf-bundle'
import * as toolOkf from '../src/index.ts'

let root: string
let ctx: Context
let call = 0

const signal = new AbortController().signal

async function setup(): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(OkfBundle, { root })
  await ctx.plugin(toolOkf, { producer: 'dsh', version: 'test' })
}

function run(name: string, args: unknown) {
  return ctx.tools.execute({ signal, callId: CallId(`c-${++call}`), name, arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tool-okf-'))
  await setup()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('registration', () => {
  it('registers the five OKF tools', async () => {
    const names = ctx.tools.schemas().map(s => s.name).filter(n => n.startsWith('okf_')).sort()
    expect(names).toEqual([
      'okf_bundle_overview',
      'okf_read_concept',
      'okf_search_concepts',
      'okf_verify_concept',
      'okf_write_concept',
    ])
  })
})

describe('okf_bundle_overview', () => {
  it('reports no bundle when the directory is absent', async () => {
    await rm(root, { recursive: true, force: true })
    const res = await run('okf_bundle_overview', {})
    expect(res.isError).toBeFalsy()
    expect(text(res)).toMatch(/No knowledge bundle exists yet/)
  })

  it('reports an empty bundle when the directory exists but holds no concepts', async () => {
    const res = await run('okf_bundle_overview', {})
    expect(text(res)).toMatch(/exists but has no concepts yet/)
  })

  it('lists concepts with type / trust / stale flags once written', async () => {
    await run('okf_write_concept', {
      id: 'metrics/revenue',
      frontmatter: { type: 'Metric', title: 'Revenue', stale_after: '2000-01-01T00:00:00Z' },
      body: '# Definition\nx\n',
    })
    const res = await run('okf_bundle_overview', {})
    expect(text(res)).toMatch(/metrics\/revenue — Revenue \[Metric, unverified, STALE\]/)
  })

  it('surfaces status, attested, and issue flags in the summary line', async () => {
    await run('okf_write_concept', {
      id: 'computations/rev',
      frontmatter: { type: 'Attested Computation', title: 'Rev', status: 'deprecated', runtime: 'bigquery' },
      body: '# Computation\n\n    SELECT 1\n',
    })
    // A typeless file, seeded straight to disk (okf_write_concept would refuse it),
    // so it lists with a conformance issue and a null type.
    await writeFile(join(root, 'orphan.md'), '---\ntitle: Orphan\n---\n\nno type here\n', 'utf8')
    const res = await run('okf_bundle_overview', {})
    expect(text(res)).toMatch(/computations\/rev — Rev \[Attested Computation, deprecated, unverified, attested\]/)
    expect(text(res)).toMatch(/orphan — Orphan \[\(no type\), unverified, ISSUE: /)
  })
})

describe('okf_write_concept', () => {
  it('creates a concept, stamps the machine actor, and reports the indexes written', async () => {
    const res = await run('okf_write_concept', {
      id: 'metrics/revenue',
      frontmatter: { type: 'Metric', title: 'Revenue', description: 'Recognized revenue.' },
      body: '# Definition\nSums `amount`.\n',
    })
    expect(res.isError).toBeFalsy()
    expect(text(res)).toMatch(/Created metrics\/revenue \(generated\.by dsh\/test\)/)
    const read = await ctx.okf.readConcept('metrics/revenue')
    expect((read.frontmatter.generated as { by: string }).by).toBe('dsh/test')
  })

  it('rejects frontmatter that is not an object', async () => {
    const res = await run('okf_write_concept', { id: 'x', frontmatter: 'nope', body: 'x\n' })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/must be a JSON object/)
  })

  it('maps a non-conformant write to OKF_TOOL_REFUSED', async () => {
    const res = await run('okf_write_concept', { id: 'x', frontmatter: { title: 'no type' }, body: 'x\n' })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/non-conformant/)
  })

  it('maps an unexpected filesystem failure to OKF_TOOL_FAILED', async () => {
    await mkdir(join(root, 'occupied.md')) // the concept path is a directory → EISDIR
    const res = await run('okf_write_concept', { id: 'occupied', frontmatter: { type: 'Metric' }, body: 'x\n' })
    expect(res.isError).toBe(true)
  })

  it('refuses a shrinking write, and honours allow_shrink', async () => {
    await run('okf_write_concept', { id: 't', frontmatter: { type: 'BigQuery Table' }, body: '`a` `b`\n' })
    const refused = await run('okf_write_concept', { id: 't', frontmatter: { type: 'BigQuery Table' }, body: '`a`\n' })
    expect(refused.isError).toBe(true)
    const ok = await run('okf_write_concept', {
      id: 't', frontmatter: { type: 'BigQuery Table' }, body: '`a`\n', allow_shrink: true,
    })
    expect(ok.isError).toBeFalsy()
  })
})

describe('okf_read_concept', () => {
  beforeEach(async () => {
    await run('okf_write_concept', {
      id: 'metrics/revenue',
      frontmatter: { type: 'Metric', title: 'Revenue', stale_after: '2000-01-01T00:00:00Z' },
      body: '# Definition\nx\n',
    })
  })

  it('returns the body with a stale warning', async () => {
    const res = await run('okf_read_concept', { id: 'metrics/revenue' })
    expect(res.isError).toBeFalsy()
    expect(text(res)).toMatch(/past its stale_after/)
    expect(text(res)).toMatch(/# Definition/)
  })

  it('maps a missing concept to OKF_TOOL_NOT_FOUND', async () => {
    const res = await run('okf_read_concept', { id: 'metrics/missing' })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/no concept "metrics\/missing"/)
  })

  it('maps a traversal id to an invalid-input error', async () => {
    const res = await run('okf_read_concept', { id: '../../../etc/passwd' })
    expect(res.isError).toBe(true)
  })

  it('reads a fresh concept without a stale warning', async () => {
    await run('okf_write_concept', { id: 'fresh', frontmatter: { type: 'Metric', title: 'Fresh' }, body: '# Ok\nfine\n' })
    const res = await run('okf_read_concept', { id: 'fresh' })
    expect(text(res)).not.toMatch(/stale_after/)
    expect(text(res)).toMatch(/trust: unverified/)
  })

  it('maps a corrupt concept file to OKF_TOOL_REFUSED', async () => {
    await writeFile(join(root, 'corrupt.md'), '---\ntype: X\nunterminated frontmatter\n', 'utf8')
    const res = await run('okf_read_concept', { id: 'corrupt' })
    expect(res.isError).toBe(true)
  })
})

describe('okf_search_concepts', () => {
  beforeEach(async () => {
    await run('okf_write_concept', { id: 'metrics/revenue', frontmatter: { type: 'Metric', title: 'Revenue', tags: ['finance'] }, body: 'sums amounts\n' })
    await run('okf_write_concept', { id: 'policies/rr', frontmatter: { type: 'Policy', title: 'RR', tags: ['finance'] }, body: 'policy text\n' })
  })

  it('filters by type', async () => {
    const res = await run('okf_search_concepts', { type: 'Policy' })
    expect(text(res)).toMatch(/policies\/rr/)
    expect(text(res)).not.toMatch(/metrics\/revenue/)
  })

  it('filters by tag and text together', async () => {
    const res = await run('okf_search_concepts', { tags: ['finance'], text: 'amounts' })
    expect(text(res)).toMatch(/1 match/)
    expect(text(res)).toMatch(/metrics\/revenue/)
  })

  it('reports no matches', async () => {
    const res = await run('okf_search_concepts', { text: 'nothing-here' })
    expect(text(res)).toMatch(/No concepts match/)
  })

  it('filters by trust_tier and staleness', async () => {
    await run('okf_verify_concept', { id: 'policies/rr', by: 'human:a' })
    const human = await run('okf_search_concepts', { trust_tier: 'human-reviewed' })
    expect(text(human)).toMatch(/policies\/rr/)
    expect(text(human)).not.toMatch(/metrics\/revenue/)
    const fresh = await run('okf_search_concepts', { stale: false })
    expect(text(fresh)).toMatch(/2 match/)
  })
})

describe('okf_verify_concept', () => {
  beforeEach(async () => {
    await run('okf_write_concept', { id: 'm', frontmatter: { type: 'Metric', title: 'M' }, body: 'x\n' })
  })

  it('records a machine verification by default', async () => {
    const res = await run('okf_verify_concept', { id: 'm' })
    expect(text(res)).toMatch(/by dsh\/test; trust tier is now machine-confirmed/)
  })

  it('records a human verification and lifts the tier', async () => {
    const res = await run('okf_verify_concept', { id: 'm', by: 'human:jsmith' })
    expect(text(res)).toMatch(/by human:jsmith; trust tier is now human-reviewed/)
  })

  it('maps a missing concept to not-found', async () => {
    const res = await run('okf_verify_concept', { id: 'nope' })
    expect(res.isError).toBe(true)
  })
})
