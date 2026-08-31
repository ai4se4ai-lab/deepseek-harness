/**
 * OKF v0.2 conformance (SPEC §11) exercised against the canonical reference
 * bundle `projects/knowledge-catalog/okf/bundles/acme_retail` — 17 markdown
 * files that populate the full v0.2 signal layer.
 *
 * That checkout is a sibling of this repo in local development but is absent on
 * CI, so this suite self-skips there; the inline fixtures in the sibling specs
 * carry the always-on assertions.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { conformanceIssue, parseConcept, serializeConcept } from '../src/document.ts'
import { isAttestedComputation, isStale, trustTier } from '../src/trust.ts'

const BUNDLE = fileURLToPath(new URL('../../../../../knowledge-catalog/okf/bundles/acme_retail', import.meta.url))
const RESERVED = new Set(['index.md', 'log.md'])

function markdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full))
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

describe.skipIf(!existsSync(BUNDLE))('acme_retail reference bundle', () => {
  const files = existsSync(BUNDLE) ? markdownFiles(BUNDLE) : []

  it('parses every markdown file without throwing', () => {
    expect(files.length).toBeGreaterThanOrEqual(15)
    for (const file of files) {
      expect(() => parseConcept(readFileSync(file, 'utf8')), file).not.toThrow()
    }
  })

  it('every non-reserved concept carries a non-empty type (SPEC §11)', () => {
    for (const file of files) {
      if (RESERVED.has(file.split('/').pop() as string)) continue
      const { frontmatter } = parseConcept(readFileSync(file, 'utf8'))
      expect(conformanceIssue(frontmatter), file).toBeNull()
    }
  })

  it('serialize→reparse is frontmatter- and body-stable', async () => {
    const { serializeConcept } = await import('../src/document.ts')
    for (const file of files) {
      const doc = parseConcept(readFileSync(file, 'utf8'))
      const reparsed = parseConcept(serializeConcept(doc))
      expect(reparsed.frontmatter, file).toEqual(doc.frontmatter)
      expect(reparsed.body.trim(), file).toBe(doc.body.trim())
    }
  })

  it('derives the documented trust / staleness / attestation signals', () => {
    const read = (rel: string) => parseConcept(readFileSync(join(BUNDLE, rel), 'utf8')).frontmatter

    // metrics/revenue.md — human-verified.
    expect(trustTier(read('metrics/revenue.md'))).toBe('human-reviewed')

    // An unverified index/reserved file (log.md carries frontmatter type: Log).
    expect(trustTier(read('log.md'))).toBe('unverified')

    // computations/gross-margin-period.md — an Attested Computation with a
    // 2026-12-31 stale_after: fresh in early 2026, stale in 2027.
    const grossMargin = read('computations/gross-margin-period.md')
    expect(isAttestedComputation(grossMargin)).toBe(true)
    expect(isStale(grossMargin, new Date('2026-06-01T00:00:00Z'))).toBe(false)
    expect(isStale(grossMargin, new Date('2027-01-01T00:00:00Z'))).toBe(true)
  })

  it('preserves a producer-defined top-level key that no OKF family models', () => {
    const doc = parseConcept(readFileSync(join(BUNDLE, 'metrics/gross-margin.md'), 'utf8'))
    expect(doc.frontmatter).toHaveProperty('not')
    expect(parseConcept(serializeConcept(doc)).frontmatter['not']).toEqual(doc.frontmatter['not'])
  })
})
