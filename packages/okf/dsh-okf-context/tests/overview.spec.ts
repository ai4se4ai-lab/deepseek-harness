/** The pure overview builders: guidance text, concept lines, and the byte-capped snapshot. */

import { describe, expect, it } from 'vitest'
import type { ConceptSummary } from '@mindportalix/dsh-okf-bundle'
import { OKF_GUIDANCE, bundleSnapshot, conceptLine } from '../src/index.ts'

function concept(over: Partial<ConceptSummary> = {}): ConceptSummary {
  return {
    id: 'metrics/revenue',
    path: 'metrics/revenue.md',
    name: 'revenue.md',
    isDirectory: false,
    type: 'Metric',
    title: 'Revenue',
    description: null,
    tags: [],
    status: 'stable',
    trustTier: 'unverified',
    stale: false,
    generatedAt: null,
    verifiedAt: null,
    attested: false,
    issue: null,
    ...over,
  }
}

describe('OKF_GUIDANCE', () => {
  it('names the tools and the honesty rules', () => {
    expect(OKF_GUIDANCE).toMatch(/okf_write_concept/)
    expect(OKF_GUIDANCE).toMatch(/okf_verify_concept/)
    expect(OKF_GUIDANCE).toMatch(/human:<id>/)
    expect(OKF_GUIDANCE).toMatch(/stale_after/)
  })
})

describe('conceptLine', () => {
  it('renders id, title, and the signal flags', () => {
    expect(conceptLine(concept())).toBe('- metrics/revenue — Revenue [Metric, unverified]')
    expect(conceptLine(concept({ status: 'deprecated', trustTier: 'human-reviewed', stale: true, attested: true })))
      .toBe('- metrics/revenue — Revenue [Metric, deprecated, human-reviewed, stale, attested]')
    expect(conceptLine(concept({ type: null, title: null })))
      .toBe('- metrics/revenue — (untitled) [(no type), unverified]')
  })
})

describe('bundleSnapshot', () => {
  it('is empty when the bundle is absent or holds no concepts', () => {
    expect(bundleSnapshot({ exists: false, concepts: [] }, 4096)).toBe('')
    expect(bundleSnapshot({ exists: true, concepts: [] }, 4096)).toBe('')
    expect(bundleSnapshot({
      exists: true,
      concepts: [{ ...concept(), isDirectory: true }, { ...concept(), name: 'index.md' }, { ...concept(), name: 'log.md' }],
    }, 4096)).toBe('')
  })

  it('lists concepts under a header', () => {
    const text = bundleSnapshot({ exists: true, concepts: [concept(), concept({ id: 'policies/rr', title: 'RR', type: 'Policy' })] }, 4096)
    expect(text).toMatch(/^OKF knowledge bundle — 2 concept\(s\)\./)
    expect(text).toMatch(/- metrics\/revenue — Revenue \[Metric, unverified\]/)
    expect(text).toMatch(/- policies\/rr — RR \[Policy, unverified\]/)
  })

  it('truncates on a line boundary with a marker when over maxBytes', () => {
    const many = Array.from({ length: 50 }, (_, i) => concept({ id: `metrics/m${i}`, title: `Metric ${i}` }))
    const text = bundleSnapshot({ exists: true, concepts: many }, 300)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(300)
    expect(text).toMatch(/… \(list truncated\)$/)
    expect(text).toMatch(/^OKF knowledge bundle — 50 concept\(s\)\./)
  })
})
