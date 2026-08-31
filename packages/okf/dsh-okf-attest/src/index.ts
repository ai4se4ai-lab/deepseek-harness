/**
 * `ctx.okfAttest` and the `okf_attest` tool — the consumer side of an Attested
 * Computation (OKF SPEC §10). Given a run receipt the agent produced by
 * following the computation's `executor` skill, this deterministically verifies
 * (no LLM, no network) that:
 *
 *  - the SQL that ran equals the sanctioned `# Computation` bound with the
 *    declared parameters (provenance), and
 *  - the value the agent is about to display equals the receipt's result
 *    (fidelity).
 *
 * A failing verdict means the value MUST NOT be displayed. The engine does not
 * itself run the computation — the agent's shell is the executor — so it needs
 * no runtime beyond `ctx.okf`.
 *
 * @module @mindportalix/dsh-okf-attest
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isStale } from '@mindportalix/dsh-okf-core'
// Type-only: the `ctx.okf` augmentation.
import type {} from '@mindportalix/dsh-okf-bundle'
import { extractComputationBody } from './computation.ts'
import { bindOk, bindParameters, expandComputation, type ParameterSpec } from './parameters.ts'
import { attestSqlReceipt, type Receipt, type Verdict } from './sql-equality.ts'

export { canonicalizeSql, attestSqlReceipt } from './sql-equality.ts'
export type { Receipt, Verdict } from './sql-equality.ts'
export { bindParameters, bindOk, expandComputation } from './parameters.ts'
export type { ParameterSpec, BindResult } from './parameters.ts'
export { extractComputationBody } from './computation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Attested Computation verification (OKF SPEC §10). */
    okfAttest: OkfAttest
  }
}

/** Runtimes the built-in deterministic attester can verify. */
const SUPPORTED_RUNTIMES = new Set(['bigquery', 'postgres'])

/** The `ctx.okfAttest` service. */
export class OkfAttest extends Service {
  static inject = ['okf', 'tools']

  constructor(ctx: Context) {
    super(ctx, 'okfAttest')
    ctx.tools.register(defineTool({
      name: 'okf_attest',
      description:
        'Verify an Attested Computation run before you report its value (OKF §10). Run the computation '
        + 'by following its `executor` skill, then call this with the concept `id`, the `parameters` you '
        + 'bound, the run `receipt` (job_id, executed_sql, result), and the `claimed_value` you are about '
        + 'to report. If `ok` is false, DO NOT report the value — say the attestation failed and why.',
      parameters: {
        id: { type: 'string', required: true, description: 'Attested Computation concept id (no `.md`).' },
        parameters: { type: 'json', required: true, description: 'The `{ name: value }` map you bound.' },
        receipt: { type: 'json', required: true, description: 'The run receipt: { job_id, executed_sql, result }.' },
        claimed_value: { type: 'json', required: true, description: 'The value you are about to report.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            reason: { type: 'string', required: true },
            stale: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value.ok ? '✓ ' : '✗ ') + value.reason + (value.stale ? '\n⚠ The computation definition is past its stale_after — note that when you report the value.' : ''),
        }],
      },
      execute: async (args) => {
        const verdict = await this.attestReceipt(
          String(args.id),
          asObject(args.parameters, 'parameters'),
          asObject(args.receipt, 'receipt') as Receipt,
          args.claimed_value,
        )
        return { ok: verdict.ok, reason: verdict.reason, stale: verdict.stale }
      },
    }))
  }

  /**
   * Verify a run receipt against a concept's sanctioned computation.
   *
   * @param id - the Attested Computation concept id.
   * @param parameters - the `{ name: value }` map the agent bound.
   * @param receipt - the run receipt.
   * @param claimedValue - the value the agent is about to display.
   * @returns the verdict, plus whether the definition is stale (SPEC §10.5 step 6).
   */
  async attestReceipt(
    id: string,
    parameters: Record<string, unknown>,
    receipt: Receipt,
    claimedValue: unknown,
  ): Promise<Verdict & { stale: boolean }> {
    let concept
    try {
      concept = await this.ctx.okf.readConcept(id)
    } catch (error) {
      const code = (error as { code?: string }).code
      throw new HarnessError(
        code === 'ENOENT' ? `no concept "${id}" in the bundle` : String((error as Error).message),
        code === 'ENOENT' ? 'OKF_ATTEST_NOT_FOUND' : 'OKF_ATTEST_FAILED',
      )
    }
    const fm = concept.frontmatter
    const stale = isStale(fm)
    const runtime = typeof fm['runtime'] === 'string' ? (fm['runtime'] as string) : ''
    if (!SUPPORTED_RUNTIMES.has(runtime)) {
      return { ok: false, reason: `runtime "${runtime || '(none)'}" has no built-in attester; only ${[...SUPPORTED_RUNTIMES].join(', ')} are verifiable here`, details: {}, stale }
    }

    const declared = Array.isArray(fm['parameters']) ? (fm['parameters'] as ParameterSpec[]) : []
    const bind = bindParameters(declared, parameters)
    if (!bindOk(bind)) {
      const parts: string[] = []
      if (bind.missing.length > 0) parts.push(`missing required parameter(s): ${bind.missing.join(', ')}`)
      if (bind.unexpected.length > 0) parts.push(`undeclared parameter(s): ${bind.unexpected.join(', ')}`)
      for (const [name, why] of Object.entries(bind.typeErrors)) parts.push(`${name}: ${why}`)
      return { ok: false, reason: `parameter binding failed — ${parts.join('; ')}`, details: { bind }, stale }
    }

    const computation = extractComputationBody(concept.body)
    if (computation === null) {
      return { ok: false, reason: 'the concept body has no `# Computation` code block to attest against', details: {}, stale }
    }
    const expected = expandComputation(runtime, computation, bind.bound)
    const verdict = attestSqlReceipt({ sanctionedSql: expected, receipt, claimedValue })
    return { ...verdict, stale }
  }

  /**
   * Placeholder for end-to-end attestation that also runs the executor. This
   * build has no executor runner — the agent's shell is the executor — so this
   * returns guidance rather than a verdict.
   *
   * @param id - the concept id.
   * @returns a non-ok verdict explaining the workflow.
   */
  attestConcept(id: string): Promise<Verdict & { stale: boolean }> {
    return Promise.resolve({
      ok: false,
      reason:
        `to attest "${id}", run its computation by following the concept's executor skill, then call `
        + 'okf_attest (or attestReceipt) with the resulting receipt',
      details: {},
      stale: false,
    })
  }
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessError(`${field} must be a JSON object`, 'OKF_ATTEST_INVALID_INPUT')
  }
  return value as Record<string, unknown>
}

export default OkfAttest
