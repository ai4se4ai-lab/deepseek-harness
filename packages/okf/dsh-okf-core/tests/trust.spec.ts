/**
 * Trust-tier, staleness, lifecycle, and actor helpers. Mirrors
 * projects/knowledge-catalog/okf/tests/test_document.py's trust cases.
 */

import { describe, expect, it } from 'vitest'
import { actorKind, formatAgentActor, isHumanActor, isProcessActor } from '../src/actor.ts'
import {
  isAttestedComputation,
  isStale,
  lastVerifiedAt,
  lifecycleStatus,
  normalizeVerified,
  trustTier,
} from '../src/trust.ts'

describe('normalizeVerified (SPEC §5.2)', () => {
  it('treats a bare mapping as a one-element list', () => {
    expect(normalizeVerified({ verified: { by: 'human:ahormati', at: '2026-06-25T09:00:00Z' } })).toEqual([
      { by: 'human:ahormati', at: '2026-06-25T09:00:00Z' },
    ])
  })

  it('returns [] for absent, null, or non-object verified', () => {
    expect(normalizeVerified({})).toEqual([])
    expect(normalizeVerified({ verified: null })).toEqual([])
    expect(normalizeVerified({ verified: 'nope' })).toEqual([])
  })

  it('drops non-object list members', () => {
    expect(normalizeVerified({ verified: [{ by: 'a', at: 'b' }, 'x', null] })).toEqual([{ by: 'a', at: 'b' }])
  })
})

describe('trustTier (SPEC §5.3)', () => {
  it('classifies by the human: actor prefix', () => {
    expect(trustTier({})).toBe('unverified')
    expect(trustTier({ verified: [{ by: 'process:finance-nightly', at: 'x' }] })).toBe('machine-confirmed')
    expect(trustTier({ verified: [{ by: 'process:x', at: 'x' }, { by: 'human:a', at: 'y' }] })).toBe('human-reviewed')
    expect(trustTier({ verified: { by: 'human:a', at: 'z' } })).toBe('human-reviewed')
  })
})

describe('lastVerifiedAt', () => {
  it('returns the latest at, or null', () => {
    expect(
      lastVerifiedAt({ verified: [{ by: 'a', at: '2026-01-01T00:00:00Z' }, { by: 'b', at: '2026-06-01T00:00:00Z' }] }),
    ).toBe('2026-06-01T00:00:00Z')
    expect(lastVerifiedAt({})).toBeNull()
    expect(lastVerifiedAt({ verified: [{ by: 'a' }] })).toBeNull()
  })
})

describe('isStale (SPEC §5.5)', () => {
  const ref = new Date('2026-09-23T12:00:00Z')
  it('compares now against an offset-qualified stale_after', () => {
    expect(isStale({ stale_after: '2026-09-23T00:00:00Z' }, ref)).toBe(true)
    expect(isStale({ stale_after: '2026-09-24T00:00:00Z' }, ref)).toBe(false)
    expect(isStale({ stale_after: '2026-09-23T00:00:00+00:00' }, ref)).toBe(true)
  })

  it('ignores absent, non-string, date-only, or offset-less values', () => {
    expect(isStale({}, ref)).toBe(false)
    expect(isStale({ stale_after: 20260101 }, ref)).toBe(false)
    expect(isStale({ stale_after: 'not-a-date' }, ref)).toBe(false)
    expect(isStale({ stale_after: '2026-09-23' }, ref)).toBe(false)
    expect(isStale({ stale_after: '2026-09-23T00:00:00' }, ref)).toBe(false)
  })

  it('rejects an unparseable but offset-shaped value', () => {
    expect(isStale({ stale_after: '2026-13-45T99:00:00Z' }, ref)).toBe(false)
  })

  it('defaults now to the current time', () => {
    expect(isStale({ stale_after: '2000-01-01T00:00:00Z' })).toBe(true)
    expect(isStale({ stale_after: '2999-01-01T00:00:00Z' })).toBe(false)
  })
})

describe('lifecycleStatus (SPEC §5.4)', () => {
  it('defaults to stable', () => {
    expect(lifecycleStatus({})).toBe('stable')
    expect(lifecycleStatus({ status: '' })).toBe('stable')
    expect(lifecycleStatus({ status: 42 })).toBe('stable')
    expect(lifecycleStatus({ status: 'deprecated' })).toBe('deprecated')
  })
})

describe('isAttestedComputation (SPEC §10.2)', () => {
  it('detects the contract by type or any contract field', () => {
    expect(isAttestedComputation({ type: 'Attested Computation' })).toBe(true)
    expect(isAttestedComputation({ runtime: 'bigquery' })).toBe(true)
    expect(isAttestedComputation({ executor: {} })).toBe(true)
    expect(isAttestedComputation({ attester: {} })).toBe(true)
    expect(isAttestedComputation({ type: 'Metric' })).toBe(false)
  })
})

describe('actor convention (SPEC §7)', () => {
  it('classifies the three kinds', () => {
    expect(isHumanActor('human:ahormati')).toBe(true)
    expect(isHumanActor(42)).toBe(false)
    expect(isProcessActor('process:nightly')).toBe(true)
    expect(isProcessActor(null)).toBe(false)
    expect(actorKind('human:a')).toBe('human')
    expect(actorKind('process:a')).toBe('process')
    expect(actorKind('reference_agent/gemini-2.5-pro')).toBe('agent')
  })

  it('formats an agent actor', () => {
    expect(formatAgentActor('dsh', '0.1.1-rc.2')).toBe('dsh/0.1.1-rc.2')
  })
})
