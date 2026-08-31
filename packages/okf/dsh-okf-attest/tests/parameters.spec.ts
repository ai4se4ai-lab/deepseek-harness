/** Parameter binding and computation expansion. */

import { describe, expect, it } from 'vitest'
import { bindOk, bindParameters, expandComputation, type ParameterSpec } from '../src/parameters.ts'

const YEAR: ParameterSpec = { name: 'year', type: 'integer', required: true }
const SEGMENT: ParameterSpec = { name: 'segment', type: 'string', required: true }
const FROM: ParameterSpec = { name: 'from', type: 'date', required: false }

describe('bindParameters', () => {
  it('accepts declared values of the right type', () => {
    const r = bindParameters([YEAR, SEGMENT], { year: 2026, segment: 'retail' })
    expect(bindOk(r)).toBe(true)
    expect(r.bound).toEqual({ year: 2026, segment: 'retail' })
  })

  it('reports a missing required parameter', () => {
    const r = bindParameters([YEAR, SEGMENT], { year: 2026 })
    expect(r.missing).toEqual(['segment'])
    expect(bindOk(r)).toBe(false)
  })

  it('ignores a missing optional parameter', () => {
    const r = bindParameters([YEAR, FROM], { year: 2026 })
    expect(bindOk(r)).toBe(true)
  })

  it('reports an undeclared parameter', () => {
    const r = bindParameters([YEAR], { year: 2026, rogue: 1 })
    expect(r.unexpected).toEqual(['rogue'])
    expect(bindOk(r)).toBe(false)
  })

  it('reports a type mismatch per declared type', () => {
    const r = bindParameters(
      [YEAR, SEGMENT, FROM, { name: 'ratio', type: 'float' }, { name: 'flag', type: 'boolean' }],
      { year: 'nope', segment: 5, from: '2026/01/01', ratio: 'x', flag: 'true' },
    )
    expect(r.typeErrors).toMatchObject({
      year: expect.stringContaining('integer'),
      segment: expect.stringContaining('string'),
      from: expect.stringContaining('YYYY-MM-DD'),
      ratio: expect.stringContaining('number'),
      flag: expect.stringContaining('boolean'),
    })
  })

  it('accepts valid float, boolean, and date values', () => {
    const r = bindParameters(
      [{ name: 'ratio', type: 'float' }, { name: 'flag', type: 'boolean' }, { name: 'day', type: 'date' }],
      { ratio: 1.5, flag: true, day: '2026-01-01' },
    )
    expect(bindOk(r)).toBe(true)
    expect(r.bound).toEqual({ ratio: 1.5, flag: true, day: '2026-01-01' })
  })

  it('rejects a non-finite number for a float parameter', () => {
    const r = bindParameters([{ name: 'ratio', type: 'float' }], { ratio: Number.NaN })
    expect(r.typeErrors.ratio).toMatch(/number/)
  })

  it('accepts an unknown declared type as-is', () => {
    const r = bindParameters([{ name: 'x', type: 'struct' }], { x: { a: 1 } })
    expect(bindOk(r)).toBe(true)
    expect(r.bound.x).toEqual({ a: 1 })
  })

  it('treats an explicit undefined value as not supplied', () => {
    const r = bindParameters([YEAR], { year: undefined })
    expect(r.missing).toEqual(['year'])
  })
})

describe('expandComputation', () => {
  it('binds @name for bigquery / postgres', () => {
    expect(expandComputation('bigquery', 'WHERE fiscal_year = @year AND seg = @segment', { year: 2026, segment: "o'brien" }))
      .toBe("WHERE fiscal_year = 2026 AND seg = 'o\\'brien'")
    expect(expandComputation('postgres', 'x = @year', { year: 5 })).toBe('x = 5')
  })

  it("binds {{ var('name') }} for dbt", () => {
    expect(expandComputation('dbt', "WHERE y = {{ var('year') }} AND s = {{var(\"segment\")}}", { year: 2026, segment: 'retail' }))
      .toBe("WHERE y = 2026 AND s = 'retail'")
  })

  it('binds {name} for python with JSON string quoting', () => {
    expect(expandComputation('python', 'f({year}, {segment})', { year: 2026, segment: 'retail' }))
      .toBe('f(2026, "retail")')
  })

  it('binds {{name}} for any other runtime', () => {
    expect(expandComputation('looker', 'filter: {{year}}', { year: 2026 })).toBe('filter: 2026')
  })

  it('escapes a regex-special parameter name for dbt', () => {
    expect(expandComputation('dbt', "{{ var('a.b') }}", { 'a.b': 1 })).toBe('1')
  })
})
