/**
 * Cordis-free tests for document text extraction: UTF-8 passthrough with the
 * character clamp, the `%PDF-` sniff, a real text-layer PDF through `unpdf`, a
 * valid PDF with no text operators, a corrupt PDF, and a non-text binary.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractDocumentText, looksLikePdf } from '../src/extract-document.ts'

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))))

const HUGE = 1_000_000

describe('looksLikePdf', () => {
  it('accepts the marker at the start', () => {
    expect(looksLikePdf(new TextEncoder().encode('%PDF-1.7\n...'))).toBe(true)
  })

  it('accepts the marker after leading bytes but within the sniff window', () => {
    expect(looksLikePdf(new TextEncoder().encode(`${' '.repeat(20)}%PDF-1.4`))).toBe(true)
  })

  it('rejects text with no marker and a marker past the sniff window', () => {
    expect(looksLikePdf(new TextEncoder().encode('plain text'))).toBe(false)
    expect(looksLikePdf(new TextEncoder().encode(`${'x'.repeat(2000)}%PDF-`))).toBe(false)
  })
})

describe('extractDocumentText', () => {
  it('returns UTF-8 text unchanged below the character cap', async () => {
    const result = await extractDocumentText(new TextEncoder().encode('hello, world'), HUGE)
    expect(result).toEqual({ kind: 'text', text: 'hello, world', truncated: false })
  })

  it('clamps UTF-8 text at the character cap and flags truncation', async () => {
    const result = await extractDocumentText(new TextEncoder().encode('abcdef'), 4)
    expect(result).toEqual({ kind: 'text', text: 'abcd', truncated: true })
  })

  it('reports a non-text, non-PDF binary as unsupported', async () => {
    const result = await extractDocumentText(new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x81]), HUGE)
    expect(result.kind).toBe('unsupported')
    expect(result.text).toBe('')
    expect(result.note).toMatch(/text, Markdown, or PDF/u)
  })

  it("recovers a text-based PDF's text layer", async () => {
    const result = await extractDocumentText(fixture('text-layer.pdf'), HUGE)
    expect(result.kind).toBe('pdf')
    expect(result.truncated).toBe(false)
    expect(result.note).toBeUndefined()
    expect(result.text).toContain('Quarterly Reliability Review')
    expect(result.text).toContain('99.94 percent')
  })

  it('clamps an extracted PDF text layer at the character cap', async () => {
    const result = await extractDocumentText(fixture('text-layer.pdf'), 20)
    expect(result.kind).toBe('pdf')
    expect(result.text).toHaveLength(20)
    expect(result.truncated).toBe(true)
  })

  it('notes a PDF with no extractable text layer', async () => {
    const result = await extractDocumentText(fixture('no-text-layer.pdf'), HUGE)
    expect(result.kind).toBe('pdf')
    expect(result.text).toBe('')
    expect(result.note).toMatch(/scanned or image-only/u)
  })

  it('notes a PDF that cannot be parsed', async () => {
    const result = await extractDocumentText(new TextEncoder().encode('%PDF-1.4\nthis is not a real pdf body'), HUGE)
    expect(result.kind).toBe('pdf')
    expect(result.text).toBe('')
    expect(result.note).toMatch(/encrypted, corrupt, or an unsupported variant/u)
  })
})
