/** Footnote attribution extraction (SPEC §5.1). */

import { describe, expect, it } from 'vitest'
import { parseFootnoteAttributions, referencedFootnoteLabels } from '../src/footnotes.ts'

const BODY = [
  'The `events_` table is sharded daily.[^ga4-schema]',
  'It is corroborated by the dashboard.[^exec-rev-dash]',
  '',
  '[^ga4-schema]: GA4 BigQuery Export schema',
  '[^exec-rev-dash]:   Executive revenue dashboard  ',
].join('\n')

describe('parseFootnoteAttributions', () => {
  it('maps each definition label to its trimmed text', () => {
    const map = parseFootnoteAttributions(BODY)
    expect(map.get('ga4-schema')).toBe('GA4 BigQuery Export schema')
    expect(map.get('exec-rev-dash')).toBe('Executive revenue dashboard')
    expect(map.size).toBe(2)
  })

  it('returns an empty map when there are no definitions', () => {
    expect(parseFootnoteAttributions('plain prose, no footnotes').size).toBe(0)
  })
})

describe('referencedFootnoteLabels', () => {
  it('lists inline labels once, in first-seen order, excluding definitions', () => {
    expect(referencedFootnoteLabels(BODY)).toEqual(['ga4-schema', 'exec-rev-dash'])
  })

  it('is empty when nothing references a footnote', () => {
    expect(referencedFootnoteLabels('[^only-a-def]: text')).toEqual([])
  })
})
