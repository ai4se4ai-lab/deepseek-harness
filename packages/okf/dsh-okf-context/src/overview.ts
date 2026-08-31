/**
 * Build the model-facing overview of a tenant's OKF bundle: the standing
 * guidance and the per-turn concept catalogue snapshot.
 *
 * @module @mindportalix/dsh-okf-context/overview
 */

import type { ConceptSummary } from '@mindportalix/dsh-okf-bundle'

/** Order-150 prompt section: what an OKF bundle is and when to write to it. */
export const OKF_GUIDANCE = [
  'You maintain an Open Knowledge Format (OKF) bundle for this user — a directory of markdown',
  'concepts with YAML frontmatter capturing durable knowledge: metric and term definitions, table',
  'and API descriptions, playbooks, and policies.',
  '',
  '- Before answering a question the bundle might already cover, consult it (okf_bundle_overview,',
  '  okf_search_concepts, okf_read_concept).',
  '- When you establish a durable fact, record it with okf_write_concept: a short `type`, a `title`,',
  '  a one-line `description`, and a structured body (headings, lists, tables). List the `sources`',
  '  you derived it from. Link related concepts with markdown links.',
  '- Keep the trust and lifecycle fields honest: never write `verified` yourself for content only you',
  '  produced — use okf_verify_concept, and `human:<id>` only when a person confirmed it. Set',
  '  `stale_after` when a fact has a known shelf life; set `status: deprecated` instead of deleting.',
  '- Treat a concept past its `stale_after` as possibly out of date, and say so when you rely on it.',
].join('\n')

/** One catalogue line: `id — title [type, trust, flags]`. */
export function conceptLine(c: ConceptSummary): string {
  const flags = [
    c.type ?? '(no type)',
    c.status !== 'stable' ? c.status : '',
    c.trustTier,
    c.stale ? 'stale' : '',
    c.attested ? 'attested' : '',
  ].filter(Boolean).join(', ')
  return `- ${c.id} — ${c.title ?? '(untitled)'} [${flags}]`
}

/**
 * The per-turn snapshot text for a bundle listing, or `''` when the bundle is
 * absent or empty (nothing to inject). Truncated to `maxBytes` on a line
 * boundary with a marker.
 *
 * @param listing - `ctx.okf.list()` output.
 * @param maxBytes - byte cap for the snapshot text.
 * @returns the snapshot, or `''`.
 */
export function bundleSnapshot(
  listing: { exists: boolean; concepts: readonly ConceptSummary[] },
  maxBytes: number,
): string {
  if (!listing.exists) return ''
  const concepts = listing.concepts.filter(c => !c.isDirectory && c.name !== 'index.md' && c.name !== 'log.md')
  if (concepts.length === 0) return ''
  const header = `OKF knowledge bundle — ${concepts.length} concept(s). Consult it before answering; keep it current.`
  const lines = [header, ...concepts.map(conceptLine)]
  let text = lines.join('\n')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const kept: string[] = [header]
  let size = Buffer.byteLength(header, 'utf8')
  const marker = '\n… (list truncated)'
  const budget = maxBytes - Buffer.byteLength(marker, 'utf8')
  for (const line of lines.slice(1)) {
    const next = size + 1 + Buffer.byteLength(line, 'utf8')
    if (next > budget) break
    kept.push(line)
    size = next
  }
  text = kept.join('\n') + marker
  return text
}
