/**
 * The pre-step catalogue injector, driven through the agent/pre-step waterfall
 * directly (the `@deepseek-ai/dsh-time-context` test pattern) with a real
 * `ctx.okf` over a temp bundle.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import OkfBundle from '@mindportalix/dsh-okf-bundle'
import * as okfContext from '../src/index.ts'

const SIGNAL = new AbortController().signal

let root: string
let ctx: Context

async function mount(config: Partial<okfContext.Config> = {}): Promise<void> {
  ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(OkfBundle, { root })
  await ctx.plugin(okfContext, { maxBytes: 32768, refreshIntervalMs: 0, ...config })
}

function agentFor(session: Session): Agent {
  return {
    id: SessionId('agent'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('okf-context must append to the open step') },
    cancel() {},
    runMaintenance: (task: (signal: AbortSignal) => unknown) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
}

async function fire(agent: Agent, step: number, kind: 'enter' | 'reject' = 'enter'): Promise<string[]> {
  const proposed = createUserMessage({
    content: [{ type: 'text', text: 'proposal' }],
    source: { kind: 'plugin', plugin: 'okf-context-test' },
  })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: kind === 'enter' ? [proposed] : [], turn: 1, step, signal: SIGNAL },
    () => Promise.resolve(kind === 'enter' ? { kind: 'enter' as const, messages: [proposed] } : { kind: 'reject' as const, reason: 'no' }),
  )
  if (decision.kind !== 'enter') return []
  const injected: string[] = []
  for (const message of decision.messages) {
    if (message === proposed) continue
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    injected.push(message.content.find(b => b.type === 'text')?.text ?? '')
  }
  return injected
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'okf-ctx-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('config validation', () => {
  it('rejects a non-positive or non-integer maxBytes / refreshIntervalMs', async () => {
    await expect(mount({ maxBytes: 0 })).rejects.toThrow(/maxBytes must be greater than 0/)
    await expect(mount({ maxBytes: -1 })).rejects.toThrow(/non-negative safe integer/)
    await expect(mount({ refreshIntervalMs: 1.5 })).rejects.toThrow(/non-negative safe integer/)
  })
})

describe('prompt guidance', () => {
  it('registers the order-150 OKF section', async () => {
    await mount()
    await ctx.plugin(await import('@deepseek-ai/dsh-system-prompt').then(m => m.default))
    // The section registers lazily via ctx.inject(['systemPrompt']); assembling picks it up.
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(s => s.name === 'okf' && s.text.includes('okf_write_concept'))).toBe(true)
  })
})

describe('catalogue injection', () => {
  it('injects nothing when the bundle is empty', async () => {
    await mount()
    expect(await fire(agentFor(Session.create(SessionId('s1'))), 1)).toEqual([])
  })

  it('injects the catalogue once a concept exists', async () => {
    await mount()
    await ctx.okf.writeConcept('metrics/revenue', { frontmatter: { type: 'Metric', title: 'Revenue' }, body: 'x\n', actor: 'dsh/t' })
    const injected = await fire(agentFor(Session.create(SessionId('s2'))), 1)
    expect(injected).toHaveLength(1)
    expect(injected[0]).toMatch(/OKF knowledge bundle — 1 concept/)
    expect(injected[0]).toMatch(/metrics\/revenue — Revenue \[Metric, unverified\]/)
  })

  it('passes a reject decision straight through', async () => {
    await mount()
    await ctx.okf.writeConcept('m', { frontmatter: { type: 'Metric' }, body: 'x\n', actor: 'dsh/t' })
    expect(await fire(agentFor(Session.create(SessionId('s3'))), 1, 'reject')).toEqual([])
  })

  it('does not force a request on a no-step first turn', async () => {
    await mount()
    await ctx.okf.writeConcept('m', { frontmatter: { type: 'Metric' }, body: 'x\n', actor: 'dsh/t' })
    const agent = agentFor(Session.create(SessionId('s4')))
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(decision.kind === 'enter' && decision.messages.length).toBe(0)
  })

  it('throttles re-injection within refreshIntervalMs, skipping non-plugin messages', async () => {
    await mount({ refreshIntervalMs: 60_000 })
    await ctx.okf.writeConcept('m', { frontmatter: { type: 'Metric' }, body: 'x\n', actor: 'dsh/t' })
    const session = Session.create(SessionId('s5'))
    // A plain user turn message the throttle check must scan past.
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const agent = agentFor(session)
    expect(await fire(agent, 1)).toHaveLength(1) // first injects
    expect(await fire(agent, 2)).toHaveLength(0) // within the window → suppressed
  })
})
