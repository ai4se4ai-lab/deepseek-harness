/**
 * Extract the sanctioned computation from an Attested Computation concept's
 * body: the single fenced (or 4-space-indented) code block under the
 * `# Computation` heading (SPEC §10.3).
 *
 * @module @mindportalix/dsh-okf-attest/computation
 */

/**
 * The text of the computation block under `# Computation`, or `null` when the
 * body has no such heading or no code block follows it.
 *
 * @param body - the concept markdown body.
 * @returns the raw computation text (fence markers / indentation removed).
 */
export function extractComputationBody(body: string): string | null {
  const lines = body.split(/\r?\n/)
  const headingIdx = lines.findIndex(line => /^#{1,6}\s+Computation\s*$/i.test(line.trim()))
  if (headingIdx === -1) return null

  let i = headingIdx + 1
  while (i < lines.length && lines[i]?.trim() === '') i++

  const fence = lines[i]?.match(/^(\s*)(`{3,}|~{3,})/)
  if (fence) {
    const marker = fence[2] as string
    const markerChar = marker[0] as string
    const close = lines.findIndex((line, idx) =>
      idx > i && line.trim().startsWith(markerChar) && line.trim().length >= marker.length)
    if (close === -1) return null
    return lines.slice(i + 1, close).join('\n').trim()
  }

  // 4-space (or tab) indented block: consecutive indented lines.
  const indented: string[] = []
  for (; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.trim() === '') {
      /* v8 ignore next -- leading blanks are consumed above; this guard only matters for blank lines between indented lines. */
      if (indented.length > 0) indented.push('')
      continue
    }
    if (/^( {4}|\t)/.test(line)) {
      indented.push(line.replace(/^( {4}|\t)/, ''))
    } else {
      break
    }
  }
  const text = indented.join('\n').trim()
  return text.length > 0 ? text : null
}
