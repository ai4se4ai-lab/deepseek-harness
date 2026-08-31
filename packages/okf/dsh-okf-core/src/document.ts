/**
 * Parse and serialize a single OKF concept document: a UTF-8 markdown file with
 * a `---`-delimited YAML frontmatter block followed by a markdown body
 * (OKF v0.2 SPEC §4).
 *
 * Ported from the OKF reference implementation
 * `projects/knowledge-catalog/okf/src/reference_agent/bundle/document.py`. The
 * `yaml` package keeps ISO 8601 datetimes as strings by default (it parses
 * `!!timestamp` only on opt-in), which is the round-trip fidelity `document.py`
 * reaches with its custom `_Loader`, so no loader configuration is needed here.
 *
 * @module @mindportalix/dsh-okf-core/document
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const FRONTMATTER_DELIM = '---'

/** A parsed concept: its frontmatter mapping and the markdown body after it. */
export interface OKFConcept {
  /** The YAML frontmatter as a plain object. `{}` when the file carries none. */
  readonly frontmatter: Record<string, unknown>
  /** Everything after the closing `---`, with one leading blank line trimmed. */
  readonly body: string
}

/** Thrown only for a structurally malformed file, never for a missing optional field (SPEC §11). */
export class OKFDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OKFDocumentError'
  }
}

/**
 * Split a concept file into `{ frontmatter, body }`.
 *
 * A file whose first line is not `---` is all body with empty frontmatter
 * (SPEC §8 index files, and SPEC §4 permits a bare body). An opening `---` with
 * no matching closing `---`, or frontmatter that is not a YAML mapping, is
 * malformed and throws {@link OKFDocumentError}.
 *
 * @param text - the full file contents.
 * @returns the parsed concept.
 */
export function parseConcept(text: string): OKFConcept {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    return { frontmatter: {}, body: text }
  }
  let endIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_DELIM) {
      endIdx = i
      break
    }
  }
  if (endIdx === -1) {
    throw new OKFDocumentError('Unterminated YAML frontmatter block')
  }
  let parsed: unknown
  try {
    parsed = parseYaml(lines.slice(1, endIdx).join('\n')) ?? {}
  } catch (error) {
    throw new OKFDocumentError(`Invalid YAML in frontmatter: ${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OKFDocumentError('Frontmatter must be a YAML mapping')
  }
  let body = lines.slice(endIdx + 1).join('\n')
  if (body.startsWith('\n')) body = body.slice(1)
  return { frontmatter: parsed as Record<string, unknown>, body }
}

/**
 * Serialize a concept back to file text: `---\n<yaml>\n---\n\n<body>\n`.
 * Frontmatter key order is preserved as given; the body always ends in exactly
 * one newline. An empty frontmatter object emits body only (index/log files).
 *
 * @param concept - the concept to serialize.
 * @returns the file contents.
 */
export function serializeConcept(concept: OKFConcept): string {
  const body = concept.body.endsWith('\n') ? concept.body : `${concept.body}\n`
  if (Object.keys(concept.frontmatter).length === 0) {
    return body
  }
  const fm = stringifyYaml(concept.frontmatter, { lineWidth: 0 }).replace(/\n+$/, '')
  return `${FRONTMATTER_DELIM}\n${fm}\n${FRONTMATTER_DELIM}\n\n${body}`
}

/**
 * Whether a frontmatter block satisfies OKF's one hard requirement: a non-empty
 * `type` (SPEC §11). Returns a reason when it does not, rather than throwing, so
 * a consumer can list a non-conformant file instead of rejecting the bundle.
 *
 * @param frontmatter - the parsed frontmatter.
 * @returns `null` when conformant, otherwise a human-readable reason.
 */
export function conformanceIssue(frontmatter: Record<string, unknown>): string | null {
  const type = frontmatter['type']
  if (type === undefined || type === null || type === '') {
    return 'missing required frontmatter key: type'
  }
  if (typeof type !== 'string') {
    return 'frontmatter key "type" must be a string'
  }
  return null
}
