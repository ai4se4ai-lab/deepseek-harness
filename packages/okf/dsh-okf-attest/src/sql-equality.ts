/**
 * Deterministic (no-LLM, no-network) attester for `runtime: bigquery` Attested
 * Computations. Ported from
 * `projects/knowledge-catalog/okf/bundles/acme_retail/attesters/sql_equality.py`.
 *
 * It verifies two things about a run receipt:
 *  1. provenance — the SQL that actually ran equals the sanctioned computation
 *     after stripping comments, collapsing whitespace, and upper-casing
 *     keywords;
 *  2. fidelity — the value the agent is about to display equals the first cell
 *     of the receipt's result.
 *
 * @module @mindportalix/dsh-okf-attest/sql-equality
 */

const COMMENT_BLOCK = /\/\*[\s\S]*?\*\//g
const COMMENT_LINE = /--[^\n]*/g
const WHITESPACE = /\s+/g
const WORD = /[A-Za-z_][A-Za-z_0-9]*/g

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AS', 'AND', 'OR',
  'SUM', 'COUNT', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'WITH', 'UNION', 'ALL', 'DISTINCT', 'LIMIT', 'OFFSET',
])

/** Strip comments, collapse whitespace, upper-case only known SQL keywords. */
export function canonicalizeSql(sql: string): string {
  const stripped = sql.replace(COMMENT_BLOCK, ' ').replace(COMMENT_LINE, ' ').replace(WHITESPACE, ' ').trim()
  return stripped.replace(WORD, (word) => {
    const upper = word.toUpperCase()
    return KEYWORDS.has(upper) ? upper : word
  })
}

/** A run receipt shaped by `executor.receipt` (SPEC §10.2). */
export interface Receipt {
  /** The job id the run produced (surfaced on a passing verdict). */
  job_id?: unknown
  /** The exact SQL the job executed. */
  executed_sql?: unknown
  /** The result — a scalar, or a row-shaped array whose first cell is the value. */
  result?: unknown
}

/** The verdict a deterministic attester returns. */
export interface Verdict {
  /** Whether the run is attested. A consumer MUST NOT display the value when false. */
  ok: boolean
  /** Why it failed, or a success note. */
  reason: string
  /** Diagnostic detail (canonical SQL forms, cell values, job id). */
  details: Record<string, unknown>
}

/**
 * Verify a BigQuery run receipt against a sanctioned computation.
 *
 * @param args.sanctionedSql - the SQL from the concept's `# Computation` fence
 *   (already parameter-bound the same way the executor bound it).
 * @param args.receipt - the run receipt.
 * @param args.claimedValue - the value the agent is about to display.
 * @returns the {@link Verdict}.
 */
export function attestSqlReceipt(args: {
  sanctionedSql: string
  receipt: Receipt
  claimedValue: unknown
}): Verdict {
  const { sanctionedSql, receipt, claimedValue } = args
  const executed = receipt.executed_sql
  if (typeof executed !== 'string' || executed.length === 0) {
    return { ok: false, reason: 'receipt is missing executed_sql', details: { receiptKeys: Object.keys(receipt).sort() } }
  }
  const sanctioned = canonicalizeSql(sanctionedSql)
  const ran = canonicalizeSql(executed)
  if (sanctioned !== ran) {
    return {
      ok: false,
      reason: 'executed SQL does not match the sanctioned computation',
      details: { sanctionedCanonical: sanctioned, executedCanonical: ran },
    }
  }
  if (receipt.result === undefined || receipt.result === null) {
    return { ok: false, reason: 'receipt is missing result', details: {} }
  }
  const firstCell = Array.isArray(receipt.result) ? receipt.result[0] : receipt.result
  if (!Object.is(firstCell, claimedValue) && firstCell !== claimedValue) {
    return {
      ok: false,
      reason: 'the claimed value does not match the receipt result',
      details: { claimed: claimedValue, receiptFirstCell: firstCell },
    }
  }
  return { ok: true, reason: 'attested: executed SQL and displayed value both match', details: { jobId: receipt.job_id ?? null } }
}
