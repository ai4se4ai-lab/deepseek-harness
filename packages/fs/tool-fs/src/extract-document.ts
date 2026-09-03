/**
 * Best-effort plain-text extraction for documents a UTF-8 read cannot surface.
 *
 * The model-facing `read` tool and the `@`-reference inliner decode files as
 * UTF-8 text. That leaves PDFs — a common thing a person drops into chat and
 * asks about — opaque: the decode fails with `FS_NOT_TEXT` and the agent never
 * sees a word. This module recovers a PDF's text layer through
 * `unpdf` (a bundled, dependency-free pdf.js build) so "summarize this",
 * "turn this into OKF concepts", and similar requests work on a `.pdf` the same
 * way they already work on a `.md`.
 *
 * It is text extraction, not OCR: an image-only (scanned) PDF yields no text,
 * and the result then carries a {@link ExtractedDocument.note} saying so rather
 * than an empty string with no explanation.
 *
 * @module @deepseek-ai/dsh-tool-fs/src/extract-document
 */

import { Buffer } from 'node:buffer'
import { extractText, getDocumentProxy } from 'unpdf'

/** What {@link extractDocumentText} made of a file's bytes. */
export interface ExtractedDocument {
  /** `text`: decoded as UTF-8. `pdf`: recovered from a PDF text layer. `unsupported`: neither applied. */
  kind: 'text' | 'pdf' | 'unsupported'
  /** The extracted text, already clamped to the requested character ceiling. May be empty. */
  text: string
  /** Whether {@link text} was cut at the ceiling because the source held more. */
  truncated: boolean
  /**
   * A short caveat when extraction was empty or lossy — a scanned PDF, an
   * unreadable PDF, or a binary that is neither text nor PDF. Absent on a
   * clean extraction.
   */
  note?: string
}

/** Bytes inspected for the `%PDF-` marker (some writers emit leading whitespace/BOM). */
const PDF_SNIFF_BYTES = 1024

/** True when `bytes` carries the `%PDF-` marker within its first {@link PDF_SNIFF_BYTES}. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, PDF_SNIFF_BYTES)).toString('latin1').includes('%PDF-')
}

/**
 * Decode `bytes` to text, transparently handling a PDF text layer.
 * @param bytes - the whole file.
 * @param maxChars - hard ceiling on the returned character count; the caller's
 *   resolved cap, never defaulted here.
 * @returns the extraction outcome; a well-formed call never rejects.
 */
export async function extractDocumentText(bytes: Uint8Array, maxChars: number): Promise<ExtractedDocument> {
  if (looksLikePdf(bytes)) return extractPdf(bytes, maxChars)

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return clamp('text', text, maxChars)
  } catch {
    return {
      kind: 'unsupported',
      text: '',
      truncated: false,
      note: 'This file is neither UTF-8 text nor a PDF, so its contents cannot be shown. Ask for a text, Markdown, or PDF version.',
    }
  }
}

/** Run `unpdf` over PDF bytes, turning both an empty layer and a parse failure into a `note`. */
async function extractPdf(bytes: Uint8Array, maxChars: number): Promise<ExtractedDocument> {
  let merged: string
  try {
    const proxy = await getDocumentProxy(Uint8Array.from(bytes))
    const { text } = await extractText(proxy, { mergePages: true })
    merged = text.replace(/\r\n?/gu, '\n').replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
  } catch {
    return {
      kind: 'pdf',
      text: '',
      truncated: false,
      note: 'This PDF could not be parsed — it may be encrypted, corrupt, or an unsupported variant. Provide a text or Markdown version.',
    }
  }

  if (merged.length === 0) {
    return {
      kind: 'pdf',
      text: '',
      truncated: false,
      note: 'This PDF has no extractable text layer — it is likely scanned or image-only. Provide a text, Markdown, or OCR’d version.',
    }
  }
  return clamp('pdf', merged, maxChars)
}

/** Trim `text` to `maxChars`, recording whether anything was dropped. */
function clamp(kind: 'text' | 'pdf', text: string, maxChars: number): ExtractedDocument {
  const truncated = text.length > maxChars
  return { kind, text: truncated ? text.slice(0, maxChars) : text, truncated }
}
