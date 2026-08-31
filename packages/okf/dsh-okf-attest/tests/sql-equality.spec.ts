/** SQL canonicalization and receipt attestation. Mirrors sql_equality.py's checks. */

import { describe, expect, it } from 'vitest'
import { attestSqlReceipt, canonicalizeSql } from '../src/sql-equality.ts'

describe('canonicalizeSql', () => {
  it('strips comments, collapses whitespace, upper-cases only keywords', () => {
    const sql = '-- header comment\nselect  sum(amount)   AS revenue /* inline */\nfrom finance.recognized_revenue\nwhere fiscal_year = 2026'
    expect(canonicalizeSql(sql)).toBe('SELECT SUM(amount) AS revenue FROM finance.recognized_revenue WHERE fiscal_year = 2026')
  })

  it('leaves identifiers untouched even when they look like keywords in another case', () => {
    expect(canonicalizeSql('SELECT from_user FROM t')).toBe('SELECT from_user FROM t')
  })
})

describe('attestSqlReceipt', () => {
  const sanctioned = 'SELECT SUM(amount) AS revenue FROM finance.recognized_revenue WHERE fiscal_year = 2026'

  it('passes when the executed SQL and the claimed value both match', () => {
    const v = attestSqlReceipt({
      sanctionedSql: sanctioned,
      receipt: { job_id: 'job-1', executed_sql: '  select sum(amount) as revenue\nfrom finance.recognized_revenue where fiscal_year = 2026', result: [4200000] },
      claimedValue: 4200000,
    })
    expect(v.ok).toBe(true)
    expect(v.details.jobId).toBe('job-1')
  })

  it('accepts a scalar result', () => {
    const v = attestSqlReceipt({ sanctionedSql: sanctioned, receipt: { executed_sql: sanctioned, result: 4200000 }, claimedValue: 4200000 })
    expect(v.ok).toBe(true)
  })

  it('fails when executed_sql is missing', () => {
    const v = attestSqlReceipt({ sanctionedSql: sanctioned, receipt: { result: [1] }, claimedValue: 1 })
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/missing executed_sql/)
  })

  it('fails when the executed SQL differs from the sanctioned computation (tamper)', () => {
    const v = attestSqlReceipt({
      sanctionedSql: sanctioned,
      receipt: { executed_sql: 'SELECT SUM(amount) * 2 AS revenue FROM finance.recognized_revenue WHERE fiscal_year = 2026', result: [8400000] },
      claimedValue: 8400000,
    })
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/does not match the sanctioned computation/)
    expect(v.details.executedCanonical).toMatch(/\* 2/)
  })

  it('fails when result is missing', () => {
    const v = attestSqlReceipt({ sanctionedSql: sanctioned, receipt: { executed_sql: sanctioned }, claimedValue: 1 })
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/missing result/)
  })

  it('fails when the claimed value does not match the receipt (tamper)', () => {
    const v = attestSqlReceipt({
      sanctionedSql: sanctioned,
      receipt: { executed_sql: sanctioned, result: [4200000] },
      claimedValue: 9999999,
    })
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/claimed value does not match/)
    expect(v.details).toMatchObject({ claimed: 9999999, receiptFirstCell: 4200000 })
  })

  it('treats an empty executed_sql string as missing', () => {
    const v = attestSqlReceipt({ sanctionedSql: sanctioned, receipt: { executed_sql: '', result: [1] }, claimedValue: 1 })
    expect(v.ok).toBe(false)
  })
})
