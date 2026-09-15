/**
 * Path derivation for per-run node workspaces, and the identifier rule that
 * keeps a caller-supplied `runId` or `nodeId` inside one tenant's subtree.
 * Every run directory lives under the same tenant root the session guard and
 * the MindPortalix DSH Files tab already scope to, so a run's files appear in
 * that tab with no further wiring.
 * @module @mindportalix/dsh-graph-node-runner/paths
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/**
 * One path segment: a leading alphanumeric then alphanumerics, dot, dash, or
 * underscore. Anchored and length-capped, so `..`, `.`, an empty string, an
 * absolute path, a nested path, a NUL byte, and a leading dot all fail. The
 * pattern is the containment rule itself, not a convenience filter: it is the
 * only check standing between a wire value and a filesystem path.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Thrown when a wire identifier cannot be used as a path segment. */
export class UnsafeSegmentError extends Error {
  constructor(label: string, value: string) {
    super(`dsh-graph-node-runner: ${label} ${JSON.stringify(value)} is not a safe path segment`)
    this.name = 'UnsafeSegmentError'
  }
}

/**
 * Assert one wire identifier is usable as a single path segment.
 * @param label - the field name, for the error message.
 * @param value - the caller-supplied value.
 * @returns the value, unchanged.
 * @throws {@link UnsafeSegmentError} when the value is not a safe segment.
 */
export function assertSafeSegment(label: string, value: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new UnsafeSegmentError(label, value)
  return value
}

/**
 * The directory every node of one run shares: `$DSH_HOME/tenants/<tenant>/runs/<runId>`.
 * @param tenantId - the resolved tenant id.
 * @param runId - the run identity, already asserted safe.
 * @returns the absolute run workspace path.
 */
export function runWorkspacePath(tenantId: string, runId: string): string {
  return dshHomePath('tenants', tenantId, 'runs', runId)
}
