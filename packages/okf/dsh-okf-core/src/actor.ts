/**
 * The OKF actor convention (SPEC §7): fields that record an identity
 * (`generated.by`, `verified[].by`) are one of
 * `<producer>/<version>` for agents/tools, `human:<id>` for a person, or
 * `process:<id>` for an automated process.
 *
 * @module @mindportalix/dsh-okf-core/actor
 */

/** The three actor kinds an OKF identity string can name. */
export type ActorKind = 'agent' | 'human' | 'process'

/** `human:<id>` — a hand-authored or human-confirmed identity (SPEC §5.3 keys off this). */
export function isHumanActor(actor: unknown): boolean {
  return typeof actor === 'string' && actor.startsWith('human:')
}

/** `process:<id>` — an automated process identity. */
export function isProcessActor(actor: unknown): boolean {
  return typeof actor === 'string' && actor.startsWith('process:')
}

/**
 * Classify an actor string. Anything that is neither `human:` nor `process:`
 * prefixed is treated as an agent/tool `<producer>/<version>` (SPEC §7).
 *
 * @param actor - the identity string.
 * @returns its {@link ActorKind}.
 */
export function actorKind(actor: string): ActorKind {
  if (isHumanActor(actor)) return 'human'
  if (isProcessActor(actor)) return 'process'
  return 'agent'
}

/**
 * Format an agent/tool actor as `<producer>/<version>` (SPEC §7).
 *
 * @param producer - the tool or agent name, for example `dsh`.
 * @param version - its version, for example `0.1.1-rc.2`.
 * @returns the actor string.
 */
export function formatAgentActor(producer: string, version: string): string {
  return `${producer}/${version}`
}
