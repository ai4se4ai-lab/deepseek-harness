/** Extracting the `# Computation` block from a concept body (SPEC §10.3). */

import { describe, expect, it } from 'vitest'
import { extractComputationBody } from '../src/computation.ts'

describe('extractComputationBody', () => {
  it('reads a fenced block under the heading', () => {
    const body = '# Definition\ntext\n\n# Computation\n\n```sql\nSELECT SUM(amount) AS revenue\nFROM t\nWHERE y = @year\n```\n\ntrailing prose\n'
    expect(extractComputationBody(body)).toBe('SELECT SUM(amount) AS revenue\nFROM t\nWHERE y = @year')
  })

  it('reads a tilde-fenced block', () => {
    expect(extractComputationBody('# Computation\n~~~\nSELECT 1\n~~~\n')).toBe('SELECT 1')
  })

  it('reads a 4-space indented block', () => {
    const body = '# Computation\n\n    SELECT SUM(amount) AS revenue\n    FROM finance.recognized_revenue\n    WHERE fiscal_year = @year\n\nThe computation binds only the declared parameters.\n'
    expect(extractComputationBody(body)).toBe('SELECT SUM(amount) AS revenue\nFROM finance.recognized_revenue\nWHERE fiscal_year = @year')
  })

  it('returns null when there is no # Computation heading', () => {
    expect(extractComputationBody('# Definition\n\n```\nSELECT 1\n```\n')).toBeNull()
  })

  it('returns null when no code block follows the heading', () => {
    expect(extractComputationBody('# Computation\n\nJust prose, no code.\n')).toBeNull()
  })

  it('returns null for an unterminated fence', () => {
    expect(extractComputationBody('# Computation\n```\nSELECT 1\n')).toBeNull()
  })

  it('matches the heading at any level and is case-insensitive', () => {
    expect(extractComputationBody('### computation\n```\nSELECT 1\n```\n')).toBe('SELECT 1')
  })
})
