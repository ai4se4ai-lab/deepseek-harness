/** index.md (SPEC §8) and log.md (SPEC §9) generation. */

import { describe, expect, it } from 'vitest'
import { appendLogEntry, regenerateIndex, SUBDIRECTORY_GROUP } from '../src/bundle-index.ts'

describe('regenerateIndex (SPEC §8)', () => {
  it('groups by type, sorts types, keeps Subdirectories last, sorts entries by title', () => {
    const text = regenerateIndex([
      { type: 'Metric', title: 'Revenue', link: 'revenue.md', description: 'Recognized revenue.' },
      { type: 'Metric', title: 'Gross margin', link: 'gross-margin.md', description: '' },
      { type: 'Attested Computation', title: 'Revenue YTD', link: 'revenue-ytd.md', description: 'Sanctioned SQL.' },
      { type: SUBDIRECTORY_GROUP, title: 'policies', link: 'policies/index.md', description: 'Finance policies.' },
    ])
    expect(text).toBe(
      [
        '# Attested Computation',
        '',
        '* [Revenue YTD](revenue-ytd.md) - Sanctioned SQL.',
        '',
        '# Metric',
        '',
        '* [Gross margin](gross-margin.md)',
        '* [Revenue](revenue.md) - Recognized revenue.',
        '',
        `# ${SUBDIRECTORY_GROUP}`,
        '',
        '* [policies](policies/index.md) - Finance policies.',
        '',
      ].join('\n'),
    )
  })

  it('falls back to an Other heading for an empty type', () => {
    expect(regenerateIndex([{ type: '', title: 'X', link: 'x.md', description: '' }])).toBe('# Other\n\n* [X](x.md)\n')
  })

  it('orders the Subdirectories heading last regardless of input order', () => {
    const before = regenerateIndex([
      { type: SUBDIRECTORY_GROUP, title: 'sub', link: 'sub/index.md', description: '' },
      { type: 'Zeta', title: 'z', link: 'z.md', description: '' },
    ])
    const after = regenerateIndex([
      { type: 'Alpha', title: 'a', link: 'a.md', description: '' },
      { type: SUBDIRECTORY_GROUP, title: 'sub', link: 'sub/index.md', description: '' },
    ])
    expect(before.indexOf('# Zeta')).toBeLessThan(before.indexOf(`# ${SUBDIRECTORY_GROUP}`))
    expect(after.indexOf('# Alpha')).toBeLessThan(after.indexOf(`# ${SUBDIRECTORY_GROUP}`))
  })

  it('returns an empty string for no entries', () => {
    expect(regenerateIndex([])).toBe('')
  })
})

describe('appendLogEntry (SPEC §9)', () => {
  it('starts a fresh log from an empty string', () => {
    expect(appendLogEntry('', { date: '2026-07-01', kind: 'Creation', text: 'Established the bundle.' })).toBe(
      '# Update Log\n\n## 2026-07-01\n* **Creation**: Established the bundle.\n',
    )
  })

  it('prepends within an existing date section', () => {
    const first = appendLogEntry('', { date: '2026-07-01', kind: 'Creation', text: 'A.' })
    const second = appendLogEntry(first, { date: '2026-07-01', kind: 'Update', text: 'B.' })
    expect(second).toBe('# Update Log\n\n## 2026-07-01\n* **Update**: B.\n* **Creation**: A.\n')
  })

  it('inserts a newer date section above older ones', () => {
    const older = appendLogEntry('', { date: '2026-07-01', kind: 'Creation', text: 'A.' })
    const newer = appendLogEntry(older, { date: '2026-07-05', kind: 'Update', text: 'B.' })
    expect(newer).toBe(
      '# Update Log\n\n## 2026-07-05\n* **Update**: B.\n\n## 2026-07-01\n* **Creation**: A.\n',
    )
  })

  it('parses back a log it wrote, ignoring the title line and blanks', () => {
    const log = '# Update Log\n\n## 2026-07-01\n\n* **Creation**: A.\n'
    expect(appendLogEntry(log, { date: '2026-07-02', kind: 'Update', text: 'B.' })).toBe(
      '# Update Log\n\n## 2026-07-02\n* **Update**: B.\n\n## 2026-07-01\n* **Creation**: A.\n',
    )
  })
})
