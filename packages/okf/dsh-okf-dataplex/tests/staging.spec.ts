/**
 * toStaging / fromStaging round-trip fidelity, mirroring the intent of the
 * upstream demo's `diff -r` check — including the `extra` divert for
 * producer-defined keys at any depth.
 */

import { describe, expect, it } from 'vitest'
import { parseConcept } from '@mindportalix/dsh-okf-core'
import { fromStaging, toStaging } from '../src/staging.ts'

/* oxlint-disable typescript/no-explicit-any -- assertions deep-inspect parsed YAML frontmatter of un-modeled shape. */

const OKF_KEY = 'proj.us-central1.okf'
const ENTRY_KEY = 'proj.us-central1.okf-bundle'

function roundTrip(clean: string): { staged: string; back: string } {
  const staged = toStaging(clean, OKF_KEY, ENTRY_KEY)
  const back = fromStaging(staged, OKF_KEY)
  return { staged, back }
}

describe('toStaging / fromStaging', () => {
  it('moves the signal layer onto the okf aspect and restores it', () => {
    const clean = [
      '---',
      'type: Metric',
      'title: Revenue',
      'description: Recognized revenue.',
      'tags: [finance, revenue]',
      'resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders',
      'status: stable',
      'generated: { by: dsh/1, at: 2026-06-30T14:00:00Z }',
      'verified:',
      '  - { by: human:jsmith, at: 2026-07-01T09:00:00Z }',
      'stale_after: 2026-12-31T00:00:00Z',
      'sources:',
      '  - { id: rev-policy, resource: https://wiki/rev, title: Revenue policy }',
      '---',
      '',
      '# Definition',
      'Recognized revenue sums `amount`.[^rev-policy]',
      '',
      '[^rev-policy]: Revenue policy',
      '',
    ].join('\n')

    const { staged, back } = roundTrip(clean)

    // Staged form: type is the entry type, signal is on the aspect.
    const stagedFm = parseConcept(staged).frontmatter as Record<string, any>
    expect(stagedFm.type).toBe(ENTRY_KEY)
    const aspect = stagedFm.catalogEntry.aspects[OKF_KEY]
    expect(aspect.okf_type).toBe('Metric')
    expect(aspect.generated).toEqual({ by: 'dsh/1', at: '2026-06-30T14:00:00Z' })
    expect(aspect.verified).toEqual([{ by: 'human:jsmith', at: '2026-07-01T09:00:00Z' }])
    expect(stagedFm.catalogEntry.resource.name).toContain('console.cloud.google.com')

    // Round-trip: parsed frontmatter and body are preserved.
    const original = parseConcept(clean)
    const restored = parseConcept(back)
    expect(restored.frontmatter).toEqual(original.frontmatter)
    expect(restored.body.trim()).toBe(original.body.trim())
  })

  it('coerces a bare verified mapping to a list on the aspect and back', () => {
    const clean = '---\ntype: Metric\nverified: { by: human:a, at: 2026-01-01T00:00:00Z }\n---\n\nx\n'
    const staged = toStaging(clean, OKF_KEY, ENTRY_KEY)
    const aspect = (parseConcept(staged).frontmatter as any).catalogEntry.aspects[OKF_KEY]
    expect(Array.isArray(aspect.verified)).toBe(true)
    expect(fromStaging(staged, OKF_KEY)).toContain('- by: human:a')
  })

  it('diverts a producer-defined top-level key through `extra` and restores it', () => {
    const clean = [
      '---',
      'type: Metric',
      'title: Gross margin',
      'not:',
      '  - { term: markup, why: "cost basis differs", instead: gross margin }',
      '---',
      '',
      'body',
      '',
    ].join('\n')
    const { staged, back } = roundTrip(clean)
    const aspect = (parseConcept(staged).frontmatter as any).catalogEntry.aspects[OKF_KEY]
    expect(typeof aspect.extra).toBe('string')
    expect(JSON.parse(aspect.extra)).toEqual([[['not'], [{ term: 'markup', why: 'cost basis differs', instead: 'gross margin' }]]])
    expect(parseConcept(back).frontmatter).toEqual(parseConcept(clean).frontmatter)
  })

  it('diverts a producer-defined subfield inside a modeled record and restores it', () => {
    const clean = [
      '---',
      'type: Metric',
      'sources:',
      '  - { id: a, resource: https://x, license: CC-BY }',
      '---',
      '',
      'body',
      '',
    ].join('\n')
    const { staged, back } = roundTrip(clean)
    const aspect = (parseConcept(staged).frontmatter as any).catalogEntry.aspects[OKF_KEY]
    expect(JSON.parse(aspect.extra)).toEqual([[['sources', 0, 'license'], 'CC-BY']])
    // The diverted subfield returns (at the end of its record — the same
    // presentation normalization pull already applies).
    expect((parseConcept(back).frontmatter as any).sources[0]).toEqual({ id: 'a', resource: 'https://x', license: 'CC-BY' })
  })

  it('stages a frontmatter-free index file as just the entry type, and unstages to body only', () => {
    const index = '# Metric\n\n* [Revenue](revenue.md) - Recognized revenue.\n'
    const staged = toStaging(index, OKF_KEY, ENTRY_KEY)
    expect((parseConcept(staged).frontmatter as any).type).toBe(ENTRY_KEY)
    expect(fromStaging(staged, OKF_KEY).trim()).toBe(index.trim())
  })

  it('unstages a staged file with neither signal nor resource to body only', () => {
    const staged = `---\ntype: ${ENTRY_KEY}\ncatalogEntry: { aspects: {} }\n---\n\njust a nav node\n`
    expect(fromStaging(staged, OKF_KEY).trim()).toBe('just a nav node')
  })

  it('passes plain text through fromStaging when it has no frontmatter', () => {
    expect(fromStaging('no frontmatter here\n', OKF_KEY)).toBe('no frontmatter here\n')
  })

  it('unstages an aspect that carries signal but no okf_type', () => {
    const staged = [
      '---',
      `type: ${ENTRY_KEY}`,
      'catalogEntry:',
      '  aspects:',
      `    ${OKF_KEY}: { status: deprecated }`,
      '---',
      '',
      'body',
      '',
    ].join('\n')
    const back = fromStaging(staged, OKF_KEY)
    const fm = parseConcept(back).frontmatter as any
    expect(fm.type).toBeUndefined()
    expect(fm.status).toBe('deprecated')
  })

  it('passes non-object list items and non-object signal values through unchanged', () => {
    const clean = [
      '---',
      'type: Attested Computation',
      'parameters: [just-a-string, 42]',
      'executor: not-a-record',
      '---',
      '',
      'body',
      '',
    ].join('\n')
    const staged = toStaging(clean, OKF_KEY, ENTRY_KEY)
    const aspect = (parseConcept(staged).frontmatter as any).catalogEntry.aspects[OKF_KEY]
    expect(aspect.parameters).toEqual(['just-a-string', 42])
    expect(aspect.executor).toBe('not-a-record')
    const back = fromStaging(staged, OKF_KEY)
    const fm = parseConcept(back).frontmatter as any
    expect(fm.parameters).toEqual(['just-a-string', 42])
    expect(fm.executor).toBe('not-a-record')
  })

  it('drops null fields inside a modeled record when diverting', () => {
    const clean = '---\ntype: Metric\nsources:\n  - { id: a, resource: https://x, title: ~ }\n---\n\nbody\n'
    const staged = toStaging(clean, OKF_KEY, ENTRY_KEY)
    const aspect = (parseConcept(staged).frontmatter as any).catalogEntry.aspects[OKF_KEY]
    expect(aspect.sources).toEqual([{ id: 'a', resource: 'https://x' }])
  })

  it('stages frontmatter that has keys but no type', () => {
    const clean = '---\ntitle: Just a title\ndescription: no type key\n---\n\nbody\n'
    const staged = toStaging(clean, OKF_KEY, ENTRY_KEY)
    const aspect = (parseConcept(staged).frontmatter as any).catalogEntry.aspects[OKF_KEY]
    expect(aspect.okf_type).toBeUndefined()
    expect((parseConcept(staged).frontmatter as any).title).toBe('Just a title')
  })

  it('tolerates a staged file missing catalogEntry / resource / aspects entirely', () => {
    const staged = `---\ntype: ${ENTRY_KEY}\ntitle: Orphan\n---\n\nbody\n`
    // No signal and no resource → body only.
    expect(fromStaging(staged, OKF_KEY).trim()).toBe('body')
  })

  it('round-trips an Attested Computation contract', () => {
    const clean = [
      '---',
      'type: Attested Computation',
      'runtime: bigquery',
      'parameters:',
      '  - { name: year, type: integer, required: true }',
      'executor: { resource: skills/run-on-bq.md, receipt: [job_id, executed_sql, result] }',
      'attester: { resource: attesters/sql_equality.py }',
      '---',
      '',
      '# Computation',
      '',
      '    SELECT 1',
      '',
    ].join('\n')
    const { back } = roundTrip(clean)
    const fm = parseConcept(back).frontmatter as any
    expect(fm.runtime).toBe('bigquery')
    expect(fm.parameters).toEqual([{ name: 'year', type: 'integer', required: true }])
    expect(fm.executor).toEqual({ resource: 'skills/run-on-bq.md', receipt: ['job_id', 'executed_sql', 'result'] })
    expect(fm.attester).toEqual({ resource: 'attesters/sql_equality.py' })
  })
})
