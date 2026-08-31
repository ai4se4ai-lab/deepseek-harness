/**
 * Open Knowledge Format (OKF) v0.2 core: framework-free parsing, trust and
 * lifecycle evaluation, footnote attribution, and index/log generation, shared
 * by the `okf-bundle` service, the `tool-okf` model tools, and the `okf-context`
 * prompt injector.
 *
 * The specification this implements is
 * `projects/knowledge-catalog/okf/SPEC.md` (OKF v0.2); behaviour is pinned
 * against the reference implementation's own tests
 * (`projects/knowledge-catalog/okf/tests/`).
 *
 * @module @mindportalix/dsh-okf-core
 */

export { parseConcept, serializeConcept, conformanceIssue, OKFDocumentError } from './document.ts'
export type { OKFConcept } from './document.ts'

export {
  normalizeVerified,
  trustTier,
  lastVerifiedAt,
  isStale,
  lifecycleStatus,
  isAttestedComputation,
} from './trust.ts'
export type { TrustTier, VerifiedEvent } from './trust.ts'

export { isHumanActor, isProcessActor, actorKind, formatAgentActor } from './actor.ts'
export type { ActorKind } from './actor.ts'

export { parseFootnoteAttributions, referencedFootnoteLabels } from './footnotes.ts'

export { regenerateIndex, appendLogEntry, SUBDIRECTORY_GROUP } from './bundle-index.ts'
export type { IndexEntry, LogEntry } from './bundle-index.ts'
