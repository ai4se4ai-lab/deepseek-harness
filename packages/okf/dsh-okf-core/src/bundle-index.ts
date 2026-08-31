/**
 * Generate the two reserved files of an OKF bundle directory: `index.md`
 * (SPEC §8, a progressive-disclosure listing grouped by concept type) and
 * `log.md` (SPEC §9, a flat list of date-grouped entries, newest first).
 *
 * Pure string builders — the filesystem walk that feeds them lives in the
 * `okf-bundle` plugin. Ported from
 * `projects/knowledge-catalog/okf/src/reference_agent/bundle/index.py`.
 *
 * @module @mindportalix/dsh-okf-core/bundle-index
 */

/** One row in a directory's `index.md`. */
export interface IndexEntry {
  /** Concept `type` (SPEC §4), or a group label such as `Subdirectories`. */
  readonly type: string
  /** Display title (frontmatter `title`, else the file stem). */
  readonly title: string
  /** Directory-relative link target, for example `revenue.md` or `metrics/index.md`. */
  readonly link: string
  /** One-line description (frontmatter `description`), or `''`. */
  readonly description: string
}

// SPEC §8: subdirectories are listed under their own heading. Kept as a
// constant so the plugin and the generator agree on the label.
export const SUBDIRECTORY_GROUP = 'Subdirectories'

/**
 * Build the text of one directory's `index.md`: an `# <Type>` section per
 * distinct entry type (types sorted, `Subdirectories` last), each listing its
 * entries as `* [title](link) - description` sorted case-insensitively by title
 * (SPEC §8).
 *
 * @param entries - the directory's concept and subdirectory rows.
 * @returns the `index.md` contents, or `''` when there is nothing to list.
 */
export function regenerateIndex(entries: readonly IndexEntry[]): string {
  if (entries.length === 0) return ''
  const grouped = new Map<string, IndexEntry[]>()
  for (const entry of entries) {
    const key = entry.type || 'Other'
    const bucket = grouped.get(key)
    if (bucket) bucket.push(entry)
    else grouped.set(key, [entry])
  }
  const types = [...grouped.keys()].sort((a, b) => {
    if (a === SUBDIRECTORY_GROUP) return 1
    if (b === SUBDIRECTORY_GROUP) return -1
    return a.localeCompare(b)
  })
  const sections = types.map((type) => {
    const rows = [...(grouped.get(type) as IndexEntry[])]
      .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()))
      .map(row => `* [${row.title}](${row.link})${row.description ? ` - ${row.description}` : ''}`)
    return [`# ${type}`, '', ...rows].join('\n')
  })
  return `${sections.join('\n\n')}\n`
}

/** One `log.md` entry (SPEC §9). */
export interface LogEntry {
  /** ISO 8601 `YYYY-MM-DD` date the change happened. */
  readonly date: string
  /** Conventional leading bold word: `Update`, `Creation`, `Deprecation`, … (SPEC §9). */
  readonly kind: string
  /** Free-form prose describing the change. */
  readonly text: string
}

const LOG_TITLE = '# Update Log'
const DATE_HEADING = /^## (\d{4}-\d{2}-\d{2})$/

/**
 * Insert a log entry into an existing `log.md`, keeping the flat
 * date-grouped, newest-first shape (SPEC §9). A new date becomes a new
 * `## YYYY-MM-DD` section in the right position; an existing date gets the
 * entry prepended within its section. Passing `''` starts a fresh log.
 *
 * @param existingLog - current `log.md` contents (may be empty).
 * @param entry - the entry to add.
 * @returns the updated `log.md` contents.
 */
export function appendLogEntry(existingLog: string, entry: LogEntry): string {
  const line = `* **${entry.kind}**: ${entry.text}`
  const sections = splitLogSections(existingLog)
  const existing = sections.find(section => section.date === entry.date)
  if (existing) {
    existing.lines.unshift(line)
  } else {
    sections.push({ date: entry.date, lines: [line] })
    sections.sort((a, b) => b.date.localeCompare(a.date))
  }
  const body = sections
    .map(section => [`## ${section.date}`, ...section.lines].join('\n'))
    .join('\n\n')
  return `${LOG_TITLE}\n\n${body}\n`
}

interface LogSection {
  date: string
  lines: string[]
}

function splitLogSections(log: string): LogSection[] {
  const sections: LogSection[] = []
  let current: LogSection | undefined
  for (const rawLine of log.split(/\r?\n/)) {
    const heading = DATE_HEADING.exec(rawLine.trim())
    if (heading) {
      current = { date: heading[1] as string, lines: [] }
      sections.push(current)
      continue
    }
    if (current && rawLine.trim().length > 0 && rawLine.trim() !== LOG_TITLE) {
      current.lines.push(rawLine.trim())
    }
  }
  return sections
}
