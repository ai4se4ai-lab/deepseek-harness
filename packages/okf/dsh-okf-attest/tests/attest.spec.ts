/**
 * ctx.okfAttest end to end over a real `ctx.okf` bundle, and the okf_attest tool
 * through the real ToolRuntime.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import OkfBundle from '@mindportalix/dsh-okf-bundle'
import OkfAttest from '../src/index.ts'

let root: string
let ctx: Context
let call = 0
const signal = new AbortController().signal

const REVENUE_BODY =
  '# Computation\n\n```sql\nSELECT SUM(amount) AS revenue\nFROM finance.recognized_revenue\nWHERE fiscal_year = @year\n```\n'

async function setup(): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(OkfBundle, { root })
  await ctx.plugin(OkfAttest)
}

async function seedRevenue(extra: Record<string, unknown> = {}): Promise<void> {
  await ctx.okf.writeConcept('computations/revenue', {
    frontmatter: {
      type: 'Attested Computation',
      title: 'Revenue for fiscal year',
      runtime: 'bigquery',
      parameters: [{ name: 'year', type: 'integer', required: true }],
      ...extra,
    },
    body: REVENUE_BODY,
    actor: 'dsh/test',
  })
}

function passingReceipt() {
  return {
    job_id: 'bq-job-1',
    executed_sql: 'SELECT SUM(amount) AS revenue FROM finance.recognized_revenue WHERE fiscal_year = 2026',
    result: [4200000],
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'okf-attest-'))
  await setup()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ctx.okfAttest.attestReceipt', () => {
  it('attests a faithful run', async () => {
    await seedRevenue()
    const v = await ctx.okfAttest.attestReceipt('computations/revenue', { year: 2026 }, passingReceipt(), 4200000)
    expect(v.ok).toBe(true)
    expect(v.stale).toBe(false)
  })

  it('fails a tampered SQL run', async () => {
    await seedRevenue()
    const v = await ctx.okfAttest.attestReceipt(
      'computations/revenue',
      { year: 2026 },
      { ...passingReceipt(), executed_sql: 'SELECT SUM(amount)*10 AS revenue FROM finance.recognized_revenue WHERE fiscal_year = 2026' },
      42000000,
    )
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/does not match the sanctioned computation/)
  })

  it('fails a tampered value', async () => {
    await seedRevenue()
    const v = await ctx.okfAttest.attestReceipt('computations/revenue', { year: 2026 }, passingReceipt(), 999)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/claimed value does not match/)
  })

  it('rejects bad parameter binding', async () => {
    await seedRevenue()
    const missing = await ctx.okfAttest.attestReceipt('computations/revenue', {}, passingReceipt(), 4200000)
    expect(missing.ok).toBe(false)
    expect(missing.reason).toMatch(/missing required parameter\(s\): year/)

    const wrongType = await ctx.okfAttest.attestReceipt('computations/revenue', { year: 'twenty' }, passingReceipt(), 4200000)
    expect(wrongType.reason).toMatch(/year: expected an integer/)

    const undeclared = await ctx.okfAttest.attestReceipt('computations/revenue', { year: 2026, junk: 1 }, passingReceipt(), 4200000)
    expect(undeclared.reason).toMatch(/undeclared parameter\(s\): junk/)
  })

  it('reports a stale definition while still attesting a matching run', async () => {
    await seedRevenue({ stale_after: '2000-01-01T00:00:00Z' })
    const v = await ctx.okfAttest.attestReceipt('computations/revenue', { year: 2026 }, passingReceipt(), 4200000)
    expect(v.ok).toBe(true)
    expect(v.stale).toBe(true)
  })

  it('refuses an unsupported runtime', async () => {
    await ctx.okf.writeConcept('computations/looker', {
      frontmatter: { type: 'Attested Computation', runtime: 'Looker', parameters: [] },
      body: '# Computation\n```\nmeasure: revenue\n```\n',
      actor: 'dsh/test',
    })
    const v = await ctx.okfAttest.attestReceipt('computations/looker', {}, passingReceipt(), 1)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/no built-in attester/)
  })

  it('fails when the body has no # Computation block', async () => {
    await ctx.okf.writeConcept('computations/empty', {
      frontmatter: { type: 'Attested Computation', runtime: 'bigquery', parameters: [] },
      body: '# Definition\nprose only\n',
      actor: 'dsh/test',
    })
    const v = await ctx.okfAttest.attestReceipt('computations/empty', {}, passingReceipt(), 1)
    expect(v.reason).toMatch(/no `# Computation` code block/)
  })

  it('throws a not-found error for a missing concept', async () => {
    await expect(ctx.okfAttest.attestReceipt('computations/nope', {}, passingReceipt(), 1)).rejects.toThrow(/no concept/)
  })

  it('surfaces a non-ENOENT read failure as OKF_ATTEST_FAILED', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'computations', 'dir-concept.md'), { recursive: true })
    await expect(
      ctx.okfAttest.attestReceipt('computations/dir-concept', {}, passingReceipt(), 1),
    ).rejects.toMatchObject({ code: 'OKF_ATTEST_FAILED' })
  })

  it('treats a non-string runtime as absent', async () => {
    await ctx.okf.writeConcept('computations/weird', {
      frontmatter: { type: 'Attested Computation', runtime: 123, parameters: [] },
      body: '# Computation\n```\nSELECT 1\n```\n',
      actor: 'dsh/test',
    })
    const v = await ctx.okfAttest.attestReceipt('computations/weird', {}, passingReceipt(), 1)
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/runtime "\(none\)" has no built-in attester/)
  })

  it('treats a non-array parameters as an empty parameter list', async () => {
    await ctx.okf.writeConcept('computations/noparams', {
      frontmatter: { type: 'Attested Computation', runtime: 'bigquery', parameters: 'oops' },
      body: '# Computation\n```\nSELECT 1 AS n\n```\n',
      actor: 'dsh/test',
    })
    const v = await ctx.okfAttest.attestReceipt(
      'computations/noparams', {}, { job_id: 'j', executed_sql: 'SELECT 1 AS n', result: [1] }, 1,
    )
    expect(v.ok).toBe(true)
  })
})

describe('attestConcept placeholder', () => {
  it('returns workflow guidance rather than a verdict', async () => {
    const v = await ctx.okfAttest.attestConcept('computations/revenue')
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/follow.*executor skill/i)
  })
})

describe('okf_attest tool', () => {
  function run(args: unknown) {
    return ctx.tools.execute({ signal, callId: CallId(`c-${++call}`), name: 'okf_attest', arguments: args })
  }
  function text(result: { content: { type: string; text?: string }[] }): string {
    return result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
  }

  it('is registered with the expected schema', () => {
    const schema = ctx.tools.schemas().find(s => s.name === 'okf_attest')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props).sort()).toEqual(['claimed_value', 'id', 'parameters', 'receipt'])
  })

  it('renders a ✓ line on a passing verdict', async () => {
    await seedRevenue()
    const res = await run({ id: 'computations/revenue', parameters: { year: 2026 }, receipt: passingReceipt(), claimed_value: 4200000 })
    expect(res.isError).toBeFalsy()
    expect(text(res)).toMatch(/^✓ attested/)
  })

  it('renders a ✗ line and a stale warning on a failing stale verdict', async () => {
    await seedRevenue({ stale_after: '2000-01-01T00:00:00Z' })
    const res = await run({ id: 'computations/revenue', parameters: { year: 2026 }, receipt: passingReceipt(), claimed_value: 1 })
    expect(text(res)).toMatch(/^✗ /)
    expect(text(res)).toMatch(/past its stale_after/)
  })

  it('rejects a non-object receipt', async () => {
    await seedRevenue()
    const res = await run({ id: 'computations/revenue', parameters: { year: 2026 }, receipt: 'nope', claimed_value: 1 })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/receipt must be a JSON object/)
  })
})
