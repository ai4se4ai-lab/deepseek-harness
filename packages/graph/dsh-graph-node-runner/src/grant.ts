/**
 * Resolve one node's requested tool names against what this composition
 * actually registers.
 *
 * `tools.restrict()` throws on an unknown name, so a diagram naming a
 * capability this deployment does not carry would fail the whole node. That is
 * the wrong failure: the node's work does not depend on the missing tool being
 * present, only on not being offered something it may not use. The grant is
 * therefore the intersection, and the unmatched names travel back to the app
 * so the diagram's author learns which of their `tools:` entries this
 * deployment cannot serve.
 * @module @mindportalix/dsh-graph-node-runner/grant
 */

import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { ToolGrant } from './types.ts'

/**
 * Tools every node may use with no `tools:` entry of its own. Reading is how a
 * node inspects what earlier nodes of the run wrote; the write, shell, and web
 * capabilities stay opt-in, mirroring the app-side rule that `context.read` is
 * the only baseline governance action.
 */
export const BASELINE_TOOLS: readonly string[] = Object.freeze([
  'read',
  'glob',
  'grep',
  'okf_bundle_overview',
  'okf_search_concepts',
  'okf_read_concept',
])

/**
 * Intersect a node's requested tools with the registered ones.
 * @param requested - the node's `tools:` entries, already mapped to harness tool names by the app.
 * @param registered - every tool name this composition registers globally.
 * @returns the allow list to restrict with, and the requested names nothing matched.
 */
export function resolveToolGrant(
  requested: readonly string[],
  registered: ReadonlySet<string>,
): ToolGrant {
  const wanted = requested.length === 0 ? BASELINE_TOOLS : [...new Set([...BASELINE_TOOLS, ...requested])]
  const allow: string[] = []
  const dropped: string[] = []
  for (const name of wanted) {
    // `restrict()` refuses the reserved PTC transport by name; a node reaches
    // its end capabilities through the grant below instead.
    if (registered.has(name) && name !== RUN_CODE_NAME) allow.push(name)
    // A baseline name this composition lacks is not the author's mistake, so
    // only an explicitly requested one is reported back.
    else if (requested.includes(name)) dropped.push(name)
  }
  return { allow, dropped }
}
