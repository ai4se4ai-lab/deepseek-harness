/**
 * parseConcept / serializeConcept / conformanceIssue. Mirrors
 * projects/knowledge-catalog/okf/tests/test_document.py's parse cases.
 */

import { describe, expect, it } from 'vitest'
import { conformanceIssue, OKFDocumentError, parseConcept, serializeConcept } from '../src/document.ts'

describe('parseConcept', () => {
  it('round-trips frontmatter and body, keeping ISO timestamps as strings', () => {
    const src = [
      '---',
      'type: BigQuery Table',
      'title: Sample',
      'tags: [a, b]',
      'generated: { by: dsh/1.0, at: 2026-05-27T00:00:00Z }',
      '---',
      '',
      '# Sample',
      '',
      'Body text.',
      '',
    ].join('\n')
    const doc = parseConcept(src)
    expect(doc.frontmatter['type']).toBe('BigQuery Table')
    expect(doc.frontmatter['tags']).toEqual(['a', 'b'])
    expect((doc.frontmatter['generated'] as { at: unknown }).at).toBe('2026-05-27T00:00:00Z')
    expect(doc.body.startsWith('# Sample')).toBe(true)

    const reparsed = parseConcept(serializeConcept(doc))
    expect(reparsed.frontmatter).toEqual(doc.frontmatter)
    expect(reparsed.body.trim()).toBe(doc.body.trim())
  })

  it('handles CRLF newlines', () => {
    const doc = parseConcept('---\r\ntype: X\r\n---\r\n\r\nbody\r\n')
    expect(doc.frontmatter['type']).toBe('X')
    expect(doc.body.trim()).toBe('body')
  })

  it('keeps the body intact when no blank line follows the closing ---', () => {
    const doc = parseConcept('---\ntype: X\n---\nimmediately body\n')
    expect(doc.frontmatter['type']).toBe('X')
    expect(doc.body).toBe('immediately body\n')
  })

  it('treats a file with no frontmatter as all body', () => {
    const doc = parseConcept('# Hello\n\nNo frontmatter here.\n')
    expect(doc.frontmatter).toEqual({})
    expect(doc.body).toContain('Hello')
  })

  it('returns an empty object for an empty frontmatter block', () => {
    const doc = parseConcept('---\n---\n\nbody\n')
    expect(doc.frontmatter).toEqual({})
    expect(doc.body.trim()).toBe('body')
  })

  it('throws on an unterminated frontmatter block', () => {
    expect(() => parseConcept('---\ntype: X\nstill in frontmatter\n')).toThrow(OKFDocumentError)
  })

  it('throws when frontmatter is not a mapping', () => {
    expect(() => parseConcept('---\n- a\n- b\n---\nbody\n')).toThrow(OKFDocumentError)
  })

  it('throws on invalid YAML', () => {
    expect(() => parseConcept('---\ntype: "unterminated\n---\nbody\n')).toThrow(/Invalid YAML/)
  })
})

describe('serializeConcept', () => {
  it('emits body only when frontmatter is empty', () => {
    expect(serializeConcept({ frontmatter: {}, body: '# Index\n' })).toBe('# Index\n')
  })

  it('adds the single trailing newline when the body lacks one', () => {
    const out = serializeConcept({ frontmatter: { type: 'X' }, body: 'no newline' })
    expect(out).toBe('---\ntype: X\n---\n\nno newline\n')
  })
})

describe('conformanceIssue (SPEC §11)', () => {
  it('accepts a type-only frontmatter', () => {
    expect(conformanceIssue({ type: 'Metric' })).toBeNull()
  })

  it('flags a missing or empty type', () => {
    expect(conformanceIssue({})).toMatch(/type/)
    expect(conformanceIssue({ type: '' })).toMatch(/type/)
    expect(conformanceIssue({ type: null })).toMatch(/type/)
  })

  it('flags a non-string type', () => {
    expect(conformanceIssue({ type: 42 })).toMatch(/must be a string/)
  })
})
