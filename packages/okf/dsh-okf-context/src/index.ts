/**
 * Makes the OKF bundle part of the agent's working context:
 *
 * 1. a standing order-150 prompt section explaining that the agent maintains an
 *    OKF bundle and how to keep its trust/lifecycle fields honest;
 * 2. a durable per-turn snapshot of the bundle's concept catalogue, appended to
 *    the request history at the first step and refreshed after a write — the
 *    same `agent/pre-step` + `createUserMessage` pattern as
 *    `@deepseek-ai/dsh-time-context`.
 *
 * The snapshot is injected only when the bundle exists and is non-empty, so a
 * user who never touches OKF pays no token cost.
 *
 * @module @mindportalix/dsh-okf-context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: the `ctx.okf` augmentation.
import type {} from '@mindportalix/dsh-okf-bundle'
import { OKF_GUIDANCE, bundleSnapshot } from './overview.ts'

export { OKF_GUIDANCE, bundleSnapshot, conceptLine } from './overview.ts'

/** Cordis plugin name; also the `user/message` source plugin tag. */
export const name = 'okf-context'
/** The agent registry (pre-step) and the bundle service. */
export const inject = ['agents', 'okf']

/** Configuration for OKF context injection. */
export interface Config {
  /** Byte cap for the injected catalogue snapshot. */
  maxBytes: number
  /** Minimum ms between durable injections in one session (0 = every eligible step). */
  refreshIntervalMs: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxBytes: z.number().default(32768),
  refreshIntervalMs: z.number().default(0),
})

/** The prompt order for both the guidance section and the catalogue snapshot. */
const OKF_ORDER = 150

function validate(config: Config): void {
  for (const [key, value] of [['maxBytes', config.maxBytes], ['refreshIntervalMs', config.refreshIntervalMs]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`okf-context: ${key} must be a non-negative safe integer, got ${String(value)}`)
    }
  }
  if (config.maxBytes === 0) {
    throw new TypeError('okf-context: maxBytes must be greater than 0')
  }
}

/** The latest okf-context injection time in a session, or undefined. */
function lastInjectionTime(agent: Agent): number | undefined {
  for (const event of [...agent.session.events].reverse()) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === name) {
      return event.time
    }
  }
  return undefined
}

/**
 * Register the guidance section and the pre-step catalogue injector.
 * @param ctx - plugin context; both registrations dispose with it.
 * @param config - snapshot byte cap and refresh throttle.
 */
export function apply(ctx: Context, config: Config): void {
  validate(config)

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({ name: 'okf', order: OKF_ORDER, text: OKF_GUIDANCE })
  })

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // A no-step first turn keeps context pending rather than forcing a request.
    if (step === 1 && decision.messages.length === 0) return decision

    if (config.refreshIntervalMs > 0) {
      const last = lastInjectionTime(agent)
      if (last !== undefined && Date.now() - last < config.refreshIntervalMs) return decision
    }

    let text: string
    try {
      text = bundleSnapshot(await ctx.okf.list(), config.maxBytes)
    } catch {
      /* v8 ignore next -- ctx.okf.list() is resilient by contract; a throw here means a broken filesystem. */
      return decision
    }
    if (text.length === 0) return decision

    void turn
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })
}
