/**
 * Per-claim attribution in an OKF body uses a markdown footnote whose label is
 * a `sources[].id` (SPEC §5.1). This module extracts those footnote
 * definitions so a consumer can resolve a claim to its source entry by the
 * stable key, not by parsing the footnote prose.
 *
 * @module @mindportalix/dsh-okf-core/footnotes
 */

// A footnote definition line: `[^label]: text`, label = the join key into
// `sources`. Only definitions (not inline `[^label]` references) carry the
// prose, so that is what we return.
const FOOTNOTE_DEF = /^\[\^([^\]]+)\]:[ \t]*(.*)$/

/**
 * Map every footnote definition in a body to its text, keyed by label.
 *
 * @param body - the concept markdown body.
 * @returns label → footnote text.
 */
export function parseFootnoteAttributions(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of body.split(/\r?\n/)) {
    const match = FOOTNOTE_DEF.exec(line)
    if (match) out.set(match[1] as string, (match[2] as string).trim())
  }
  return out
}

/**
 * Labels referenced inline in the body as `[^label]` (excluding the definition
 * lines themselves), in first-seen order. Useful to spot a claim whose label
 * has no matching `sources[].id`.
 *
 * @param body - the concept markdown body.
 * @returns the distinct referenced labels.
 */
export function referencedFootnoteLabels(body: string): string[] {
  const seen = new Set<string>()
  for (const line of body.split(/\r?\n/)) {
    if (FOOTNOTE_DEF.test(line)) continue
    for (const match of line.matchAll(/\[\^([^\]]+)\]/g)) {
      seen.add(match[1] as string)
    }
  }
  return [...seen]
}
