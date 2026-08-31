/**
 * OKF v0.2 trust and lifecycle evaluation: `verified` → trust tier (SPEC §5.3),
 * and `stale_after` → staleness (SPEC §5.5). Ported from
 * `projects/knowledge-catalog/okf/src/reference_agent/bundle/document.py`.
 *
 * @module @mindportalix/dsh-okf-core/trust
 */

import { isHumanActor } from './actor.ts'

/** One verification event (SPEC §5.2). */
export interface VerifiedEvent {
  /** The verifying actor (SPEC §7). */
  readonly by?: unknown
  /** ISO 8601 datetime the verification happened. */
  readonly at?: unknown
}

/** Trust tiers, lowest to highest (SPEC §5.3). */
export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed'

/**
 * The `verified` events as an array (SPEC §5.2). A lone verifier MAY be written
 * as one `{ by, at }` mapping without the list dash; consumers MUST treat a
 * bare mapping as a one-element list. Non-object list members are dropped.
 *
 * @param frontmatter - the parsed frontmatter.
 * @returns the normalized event list.
 */
export function normalizeVerified(frontmatter: Record<string, unknown>): VerifiedEvent[] {
  const verified = frontmatter['verified']
  if (verified === undefined || verified === null) return []
  if (Array.isArray(verified)) {
    return verified.filter((v): v is VerifiedEvent => typeof v === 'object' && v !== null)
  }
  if (typeof verified === 'object') return [verified as VerifiedEvent]
  return []
}

/**
 * Derive a concept's trust tier from `verified` (SPEC §5.3):
 * - no `verified` key            → `unverified`
 * - only non-`human:` actors     → `machine-confirmed`
 * - any `human:<id>` actor       → `human-reviewed`
 *
 * @param frontmatter - the parsed frontmatter.
 * @returns the trust tier.
 */
export function trustTier(frontmatter: Record<string, unknown>): TrustTier {
  const events = normalizeVerified(frontmatter)
  if (events.length === 0) return 'unverified'
  for (const event of events) {
    if (isHumanActor(event.by)) return 'human-reviewed'
  }
  return 'machine-confirmed'
}

/** Latest `verified[].at`, or `null` when unverified or no event carries one. */
export function lastVerifiedAt(frontmatter: Record<string, unknown>): string | null {
  const ats = normalizeVerified(frontmatter)
    .map(event => event.at)
    .filter((at): at is string => typeof at === 'string' && at.length > 0)
    .sort()
  return ats.at(-1) ?? null
}

// SPEC §5: a staleness comparison must be a plain instant comparison, so
// `stale_after` is only honored when it carries an explicit UTC offset — a
// date-only `2026-12-31` or an offset-less `...T00:00:00` names a different
// instant in every timezone and is ignored rather than guessed at.
const OFFSET_QUALIFIED = /T.*(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * Whether a concept is stale per `stale_after` (SPEC §5.5): stale when
 * `now >= stale_after`. `false` when `stale_after` is absent, not a string, or
 * not an offset-qualified ISO 8601 datetime.
 *
 * @param frontmatter - the parsed frontmatter.
 * @param now - the instant to compare against; defaults to the current time.
 * @returns whether the concept is stale.
 */
export function isStale(frontmatter: Record<string, unknown>, now: Date = new Date()): boolean {
  const raw = frontmatter['stale_after']
  if (typeof raw !== 'string' || !OFFSET_QUALIFIED.test(raw)) return false
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) return false
  return now.getTime() >= parsed
}

/**
 * A concept's lifecycle status (SPEC §5.4). Absent `status` ⇒ `stable`.
 *
 * @param frontmatter - the parsed frontmatter.
 * @returns `draft`, `stable`, or `deprecated`; any other value passes through.
 */
export function lifecycleStatus(frontmatter: Record<string, unknown>): string {
  const status = frontmatter['status']
  return typeof status === 'string' && status.length > 0 ? status : 'stable'
}

/** Whether a concept carries an Attested Computation contract (SPEC §10.2). */
export function isAttestedComputation(frontmatter: Record<string, unknown>): boolean {
  return (
    frontmatter['type'] === 'Attested Computation' ||
    frontmatter['runtime'] !== undefined ||
    frontmatter['executor'] !== undefined ||
    frontmatter['attester'] !== undefined
  )
}
