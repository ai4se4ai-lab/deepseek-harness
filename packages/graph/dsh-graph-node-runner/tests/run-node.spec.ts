/**
 * Node-execution tests: what a node's front-matter turns into on its agent
 * (prompt, tool grant, model, workspace), and what the app reads back out of
 * the turn it produced. The session is real, so the result reading is exercised
 * against the durable log rather than a hand-built shape.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  blocksToText,
  composeNode,
  createNodeAgent,
  driveTurn,
  readTurn,
  runGraphNode,
  toStopReason,
} from '../src/run-node.ts'
import type { RunNodeContext } from '../src/run-node.ts'
import type { GraphNodeRequest, NodeStreamFrame, ToolGrant } from '../src/types.ts'

const TENANT = 'a'.repeat(32)
const NO_GRANT: ToolGrant = { allow: [], dropped: [] }

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'graph-node-runner-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  delete process.env['DSH_HOME']
  await rm(home, { recursive: true, force: true })
})

function request(overrides: Partial<GraphNodeRequest> = {}): GraphNodeRequest {
  return {
    runId: 'run1',
    nodeId: 'code_writer',
    systemPrompt: 'Implement the planned change.',
    input: '### code_planner\nStep 1.',
    tools: [],
    ...overrides,
  }
}

/** A session carrying one finished turn, built through the real append path. */
function turnSession(build: (session: Session) => void): { session: Session; from: SessionLogOffset } {
  const session = Session.create(SessionId('node-session'))
  const from = session.seq
  build(session)
  return { session, from }
}

const calls = new Map<string, number>()

function toolCall(session: Session, callId: string, name: string): void {
  const event = session.append(
    'tool/call',
    { turn: 1, step: 1, callId: callId as ToolCallId, name, arguments: '{}' },
  )
  calls.set(callId, event.seq)
}

function toolResult(session: Session, callId: string, isError = false): void {
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId as ToolCallId, content: [], ...isError ? { isError } : {} }],
      source: { kind: 'tool', callId: callId as ToolCallId, name: 'tool' },
    },
  } as never, { surfaceOp: 'append', ...calls.has(callId) ? { sourceEventSeqs: [calls.get(callId)] } : {} } as never)
}

function assistantText(session: Session, text: string): void {
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
    stream: [],
  } as never, { surfaceOp: 'append' } as never)
}

describe('toStopReason', () => {
  it.each([
    ['completed', 'completed'],
    ['max-tokens', 'max-tokens'],
    ['aborted', 'aborted'],
  ] as const)('maps %s through unchanged', (kind, expected) => {
    expect(toStopReason({ kind } as never)).toBe(expected)
  })

  it('reports a blocked turn as a refusal, never an answer', () => {
    expect(toStopReason({ kind: 'blocked' } as never)).toBe('refusal')
  })

  it('reports an errored turn as an error', () => {
    expect(toStopReason({ kind: 'error' } as never)).toBe('error')
  })

  it('reports a turn that never closed as an error rather than a success', () => {
    expect(toStopReason(undefined)).toBe('error')
  })
})

describe('blocksToText', () => {
  it('joins text blocks', () => {
    expect(blocksToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
  })

  it('drops non-text blocks', () => {
    expect(blocksToText([{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'x' } as never])).toBe('a')
  })

  it('reads no output as an empty answer', () => {
    expect(blocksToText(undefined)).toBe('')
    expect(blocksToText([])).toBe('')
  })
})

describe('readTurn', () => {
  it('reads the node\'s final answer off the log', () => {
    const { session, from } = turnSession((s) => {
      s.append('turn/start', { turn: 1 })
      s.append('step/start', { turn: 1, step: 1 })
      assistantText(s, 'done')
      s.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    })
    const result = readTurn(session.snapshotEvents(from), false, session.id, NO_GRANT)
    expect(result.output).toBe('done')
    expect(result.stopReason).toBe('completed')
  })

  it('reports each tool the node called, for the app to audit', () => {
    const { session, from } = turnSession((s) => {
      s.append('turn/start', { turn: 1 })
      s.append('step/start', { turn: 1, step: 1 })
      toolCall(s, 'c1', 'bash')
      toolResult(s, 'c1')
      toolCall(s, 'c2', 'okf_write_concept')
      toolResult(s, 'c2')
      assistantText(s, 'done')
      s.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    })
    const result = readTurn(session.snapshotEvents(from), false, session.id, NO_GRANT)
    expect(result.toolCalls).toEqual([
      { name: 'bash', ok: true },
      { name: 'okf_write_concept', ok: true },
    ])
  })

  it('marks a failed tool call as failed', () => {
    const { session, from } = turnSession((s) => {
      s.append('turn/start', { turn: 1 })
      s.append('step/start', { turn: 1, step: 1 })
      toolCall(s, 'c1', 'bash')
      toolResult(s, 'c1', true)
      s.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    })
    expect(readTurn(session.snapshotEvents(from), false, session.id, NO_GRANT).toolCalls)
      .toEqual([{ name: 'bash', ok: false }])
  })

  it('ignores a result whose call is outside this turn', () => {
    const { session, from } = turnSession((s) => {
      s.append('turn/start', { turn: 1 })
      s.append('step/start', { turn: 1, step: 1 })
      toolResult(s, 'from-an-earlier-turn')
      s.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    })
    expect(readTurn(session.snapshotEvents(from), false, session.id, NO_GRANT).toolCalls).toEqual([])
  })

  it('keeps a partial answer when the turn was cancelled', () => {
    const { session, from } = turnSession((s) => {
      s.append('turn/start', { turn: 1 })
      s.append('step/start', { turn: 1, step: 1 })
      assistantText(s, 'half an answer')
      s.append('turn/end', { turn: 1, reason: { kind: 'aborted' } } as never)
    })
    const result = readTurn(session.snapshotEvents(from), true, session.id, NO_GRANT)
    expect(result.output).toBe('half an answer')
    expect(result.stopReason).toBe('aborted')
  })

  it('never reports a cancelled turn as completed', () => {
    const { session, from } = turnSession((s) => {
      s.append('turn/start', { turn: 1 })
      s.append('step/start', { turn: 1, step: 1 })
      s.append('turn/end', { turn: 1, reason: { kind: 'error' } } as never)
    })
    expect(readTurn(session.snapshotEvents(from), true, session.id, NO_GRANT).stopReason).toBe('aborted')
  })

  it('leaves a genuinely completed turn alone even when cancellation raced it', () => {
    const { session, from } = turnSession((s) => {
      s.append('turn/start', { turn: 1 })
      s.append('step/start', { turn: 1, step: 1 })
      s.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    })
    expect(readTurn(session.snapshotEvents(from), true, session.id, NO_GRANT).stopReason).toBe('completed')
  })

  it('carries the dropped tool names back to the app', () => {
    const { session, from } = turnSession((s) => {
      s.append('turn/start', { turn: 1 })
      s.append('step/start', { turn: 1, step: 1 })
      s.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    })
    const grant: ToolGrant = { allow: ['read'], dropped: ['kubernetes_apply'] }
    expect(readTurn(session.snapshotEvents(from), false, session.id, grant).droppedTools)
      .toEqual(['kubernetes_apply'])
  })
})

/** A context exposing only the services composition touches. */
function composeCtx(registered: string[]): {
  ctx: Context
  agentCtx: Context
  sections: { name: string; text: string; complete?: boolean }[]
  restrictions: string[][]
  mounted: string[]
} {
  const sections: { name: string; text: string; complete?: boolean }[] = []
  const restrictions: string[][] = []
  const mounted: string[] = []
  const agentCtx = {
    systemPrompt: {
      section: (s: { name: string; text: string; complete?: boolean }) => { sections.push(s) },
      getSectionOrder: () => 0,
    },
    tools: {
      schemas: () => registered.map(name => ({ name })),
      restrict: (filter: { allow?: string[] }) => { restrictions.push(filter.allow ?? []) },
    },
  } as unknown as Context
  const ctx = {
    agentPresets: { mount: async (_agentCtx: Context, id: string) => { mounted.push(id) } },
  } as unknown as Context
  return { ctx, agentCtx, sections, restrictions, mounted }
}

describe('composeNode', () => {
  it('joins the preset so the deployment\'s tools become visible', async () => {
    const harness = composeCtx(['read', 'glob', 'grep'])
    await composeNode(harness.ctx, harness.agentCtx, request(), 'standard')
    expect(harness.mounted).toEqual(['standard'])
  })

  it('installs the node\'s front-matter prompt as its persona', async () => {
    const harness = composeCtx(['read', 'glob', 'grep'])
    await composeNode(harness.ctx, harness.agentCtx, request({ systemPrompt: 'Grade the plan 0-10.' }), 'standard')
    expect(harness.sections).toEqual([
      { name: 'deployment:persona-prefix', order: 0, text: 'Grade the plan 0-10.', complete: true },
    ])
  })

  it('makes the node\'s prompt the complete system prompt, not one section among the preset\'s own', async () => {
    // Without `complete: true` a diagram's narrow role competes with the
    // preset's own persona and policy prose for every node, since every node
    // joins the same composition-wide preset (see the package README's Known
    // Limitations). This is the guard against that regression.
    const harness = composeCtx(['read', 'glob', 'grep'])
    await composeNode(harness.ctx, harness.agentCtx, request({ systemPrompt: 'You are a planner.' }), 'standard')
    expect(harness.sections[0]?.complete).toBe(true)
  })

  it('restricts the node to its granted tools', async () => {
    const harness = composeCtx(['read', 'glob', 'grep', 'bash', 'write'])
    await composeNode(harness.ctx, harness.agentCtx, request({ tools: ['bash'] }), 'standard')
    expect(harness.restrictions).toHaveLength(1)
    expect(harness.restrictions[0]).toContain('bash')
    expect(harness.restrictions[0]).not.toContain('write')
  })

  it('never asks restrict() for a tool this composition lacks', async () => {
    const harness = composeCtx(['read'])
    const grant = await composeNode(harness.ctx, harness.agentCtx, request({ tools: ['bash'] }), 'standard')
    expect(harness.restrictions[0]).toEqual(['read'])
    expect(grant.dropped).toEqual(['bash'])
  })

  it('skips the restriction entirely when nothing can be granted', async () => {
    const harness = composeCtx([])
    await composeNode(harness.ctx, harness.agentCtx, request({ tools: ['bash'] }), 'standard')
    expect(harness.restrictions).toEqual([])
  })
})

describe('createNodeAgent', () => {
  /** Capture what the agent factory was asked to build. */
  function creatingCtx(
    defaultSelection: { provider: string; model: string } = { provider: 'deepseek', model: 'deepseek-chat' },
    workspaceRegistry?: unknown,
  ): { ctx: Context; captured: Record<string, unknown>[] } {
    const captured: Record<string, unknown>[] = []
    const services: Record<string, unknown> = { workspaceRegistry }
    const ctx = {
      agents: {
        create: async (options: Record<string, unknown>) => {
          captured.push(options)
          await (options['setup'] as (c: Context) => Promise<void>)(
            composeCtx(['read', 'glob', 'grep', 'bash']).agentCtx,
          )
          return { agent: {}, dispose: async () => {} }
        },
      },
      agentPresets: { mount: async () => {} },
      agentDefaultModel: { currentSelection: () => defaultSelection },
      get: (name: string) => services[name],
      logger: { warn: () => {} },
    } as unknown as Context
    return { ctx, captured }
  }

  /** A fake `workspaceRegistry` recording every create/attach call. */
  function fakeWorkspaceRegistry(create?: (path: string, title: string | undefined) => Promise<unknown>): {
    registry: unknown
    created: { path: string; title: string | undefined }[]
    attached: string[]
  } {
    const created: { path: string; title: string | undefined }[] = []
    const attached: string[] = []
    const registry = {
      create: async (path: string, title: string | undefined) => {
        created.push({ path, title })
        if (create !== undefined) return await create(path, title)
        return { attachSession: async (sessionId: string) => { attached.push(sessionId) } }
      },
    }
    return { registry, created, attached }
  }

  function contextFor(ctx: Context, overrides: Partial<GraphNodeRequest> = {}): RunNodeContext {
    return {
      ctx,
      tenantId: TENANT,
      request: request(overrides),
      agentPreset: 'standard',
      signal: new AbortController().signal,
    }
  }

  it('points the node at its run\'s shared workspace', async () => {
    const { ctx, captured } = creatingCtx()
    await createNodeAgent(contextFor(ctx), () => {})
    expect((captured[0]?.['meta'] as { cwd: string }).cwd)
      .toBe(join(home, 'tenants', TENANT, 'runs', 'run1'))
  })

  it('creates the run workspace so the first node can write into it', async () => {
    const { ctx } = creatingCtx()
    await createNodeAgent(contextFor(ctx), () => {})
    const { stat } = await import('node:fs/promises')
    expect((await stat(join(home, 'tenants', TENANT, 'runs', 'run1'))).isDirectory()).toBe(true)
  })

  it('passes the node\'s declared model, the tenant\'s provider, and its token ceiling', async () => {
    const { ctx, captured } = creatingCtx({ provider: 'deepseek', model: 'deepseek-reasoner' })
    await createNodeAgent(contextFor(ctx, { model: 'deepseek-chat', maxTokens: 512 }), () => {})
    expect(captured[0]?.['agentOptions']).toEqual({ provider: 'deepseek', model: 'deepseek-chat', maxTokens: 512 })
  })

  it('runs the tenant\'s configured model and provider when the diagram declared none', async () => {
    const { ctx, captured } = creatingCtx({ provider: 'pi-ai', model: 'qwen3.8:27b' })
    await createNodeAgent(contextFor(ctx), () => {})
    expect(captured[0]?.['agentOptions']).toEqual({ provider: 'pi-ai', model: 'qwen3.8:27b' })
  })

  it('reports the resolved grant back out of the setup window', async () => {
    const { ctx } = creatingCtx()
    let grant: ToolGrant | undefined
    await createNodeAgent(contextFor(ctx, { tools: ['bash', 'nope'] }), (resolved) => { grant = resolved })
    expect(grant?.allow).toContain('bash')
    expect(grant?.dropped).toEqual(['nope'])
  })

  it('names the session after its run and node, so two nodes never collide', async () => {
    const { ctx, captured } = creatingCtx()
    await createNodeAgent(contextFor(ctx), () => {})
    expect(String(captured[0]?.['sessionId'])).toMatch(/^mp-run1-code_writer-/)
  })

  it('joins the run\'s node sessions into one Workspace, so the sidebar groups them', async () => {
    const { registry, created, attached } = fakeWorkspaceRegistry()
    const { ctx, captured } = creatingCtx(undefined, registry)
    await createNodeAgent(contextFor(ctx, { runTitle: 'Simple Python Script Review' }), () => {})
    expect(created).toEqual([
      { path: join(home, 'tenants', TENANT, 'runs', 'run1'), title: 'Simple Python Script Review' },
    ])
    expect(attached).toEqual([String(captured[0]?.['sessionId'])])
  })

  it('rejoins the same Workspace for a second node of the same run', async () => {
    const { registry, created } = fakeWorkspaceRegistry()
    const { ctx } = creatingCtx(undefined, registry)
    await createNodeAgent(contextFor(ctx, { nodeId: 'code_planner' }), () => {})
    await createNodeAgent(contextFor(ctx, { nodeId: 'code_writer' }), () => {})
    expect(created).toHaveLength(2)
    expect(created[0]?.path).toBe(created[1]?.path)
  })

  it('still creates the node\'s agent when no workspaceRegistry is composed', async () => {
    const { ctx } = creatingCtx()
    await expect(createNodeAgent(contextFor(ctx), () => {})).resolves.toBeDefined()
  })

  it('still creates the node\'s agent when the Workspace join fails', async () => {
    const { registry } = fakeWorkspaceRegistry(async () => { throw new Error('storage unavailable') })
    const { ctx, captured } = creatingCtx(undefined, registry)
    await expect(createNodeAgent(contextFor(ctx), () => {})).resolves.toBeDefined()
    expect(captured).toHaveLength(1)
  })

  it('does not let a Workspace registry stuck on an earlier caller\'s operation block the node\'s turn', async () => {
    // `workspaceRegistry` serializes create/delete on one durable queue shared
    // by every caller in the composition; a slow or wedged operation already
    // queued ahead of this one must never make a node's turn wait with it.
    // Real timers: this is the exact regression a live run hit (a stuck
    // registry queue silently hung every dsh node's creation), so it is worth
    // the ~5s of real wall-clock time to prove the bound actually elapses.
    const registry = { create: () => new Promise<never>(() => {}) }
    const { ctx, captured } = creatingCtx(undefined, registry)
    await expect(createNodeAgent(contextFor(ctx), () => {})).resolves.toBeDefined()
    expect(captured).toHaveLength(1)
  }, 10_000)
})

/** Dispatch one tool call through the agent's pipeline, as the registry would. */
function callTool(agent: Agent, name: string, args: unknown): Promise<unknown> {
  return agent.ctx.waterfall(
    'tools/pre-execute',
    { name, arguments: args } as never,
    (async () => ({ kind: 'allow' })) as never,
  )
}

/** Dispatch one tool result through the agent's pipeline. */
function finishTool(agent: Agent, name: string, result: unknown): Promise<unknown> {
  return agent.ctx.waterfall(
    'tools/post-execute',
    { name } as never,
    result as never,
    (async () => ({ kind: 'accept' })) as never,
  )
}

const cancelCalls: string[] = []

/** A minimal live agent: prompting it appends one assistant turn. */
function fakeAgent(session: Session, onFollowup: () => void): Agent {
  return {
    session,
    ctx: new Context(),
    followup: onFollowup,
    whenIdle: async () => {},
    cancel: () => { cancelCalls.push(String(session.id)) },
  } as unknown as Agent
}

describe('driveTurn', () => {
  function contextFor(signal: AbortSignal, onFrame?: (frame: NodeStreamFrame) => void): RunNodeContext {
    return {
      ctx: new Context(),
      tenantId: TENANT,
      request: request(),
      agentPreset: 'standard',
      signal,
      ...onFrame === undefined ? {} : { onFrame },
    }
  }

  it('prompts the node and returns only this turn\'s events', async () => {
    const session = Session.create(SessionId('node-session'))
    session.append('turn/start', { turn: 0 })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } } as never)
    const agent = fakeAgent(session, () => {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      assistantText(session, 'fresh')
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    })
    const { events, cancelled } = await driveTurn(agent, contextFor(new AbortController().signal))
    expect(cancelled).toBe(false)
    expect(events.some(event => event.type === 'turn/start' && event.data.turn === 0)).toBe(false)
    expect(events.some(event => event.type === 'turn/start' && event.data.turn === 1)).toBe(true)
  })

  it('never prompts a node whose run was already cancelled', async () => {
    const session = Session.create(SessionId('node-session'))
    const followup = vi.fn()
    const agent = fakeAgent(session, followup)
    const controller = new AbortController()
    controller.abort()
    const { cancelled } = await driveTurn(agent, contextFor(controller.signal))
    expect(cancelled).toBe(true)
    expect(followup).not.toHaveBeenCalled()
    expect(cancelCalls).toContain('node-session')
  })

  it('cancels the node when the run is stopped mid-turn', async () => {
    const session = Session.create(SessionId('node-session'))
    const controller = new AbortController()
    const agent = fakeAgent(session, () => { controller.abort() })
    const { cancelled } = await driveTurn(agent, contextFor(controller.signal))
    expect(cancelled).toBe(true)
    expect(cancelled).toBe(true)
    expect(cancelCalls).toContain('node-session')
  })

  it('forwards streamed assistant text to the caller', async () => {
    const session = Session.create(SessionId('node-session'))
    const frames: NodeStreamFrame[] = []
    const agent = fakeAgent(session, () => {})
    const promise = driveTurn(agent, contextFor(new AbortController().signal, f => frames.push(f)))
    agent.ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'hel' } },
    } as never)
    agent.ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'text-delta', index: 1, text: 'lo' } },
    } as never)
    await promise
    expect(frames.filter(f => f.kind === 'text').map(f => (f as { text: string }).text).join('')).toBe('hello')
  })

  it('forwards reasoning separately from the answer, and accumulates it', async () => {
    const session = Session.create(SessionId('node-session'))
    const frames: NodeStreamFrame[] = []
    const agent = fakeAgent(session, () => {})
    const promise = driveTurn(agent, contextFor(new AbortController().signal, f => frames.push(f)))
    agent.ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'first I will ' } },
    } as never)
    agent.ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 1, text: 'read the file' } },
    } as never)
    const { thinking } = await promise
    expect(frames.filter(f => f.kind === 'reasoning')).toHaveLength(2)
    expect(frames.some(f => f.kind === 'text')).toBe(false)
    expect(thinking).toBe('first I will read the file')
  })

  it('reports the turn with no reasoning as empty rather than absent', async () => {
    const session = Session.create(SessionId('node-session'))
    const agent = fakeAgent(session, () => {})
    const { thinking } = await driveTurn(agent, contextFor(new AbortController().signal))
    expect(thinking).toBe('')
  })

  it('forwards each tool call and how it came back', async () => {
    const session = Session.create(SessionId('node-session'))
    const frames: NodeStreamFrame[] = []
    const agent = fakeAgent(session, () => {})
    const promise = driveTurn(agent, contextFor(new AbortController().signal, f => frames.push(f)))
    // Dispatched without an intervening await: the fake turn settles on the
    // first microtask, and its `finally` disposes these listeners.
    await Promise.all([
      agent.ctx.waterfall(
        'tools/pre-execute',
        { name: 'bash', arguments: { command: 'ls' } } as never,
        async () => ({ kind: 'allow' }) as never,
      ),
      finishTool(agent, 'bash', { isError: false, content: [{ type: 'text', text: 'README.md' }] }),
    ])
    await promise
    const call = frames.find(f => f.kind === 'tool') as { name: string; arguments: string }
    const result = frames.find(f => f.kind === 'tool_result') as { name: string; ok: boolean; preview: string }
    expect(call.name).toBe('bash')
    expect(call.arguments).toContain('ls')
    expect(result).toEqual({ kind: 'tool_result', name: 'bash', ok: true, preview: 'README.md' })
  })

  it('forwards a failed tool call with its failure message, not its content', async () => {
    const session = Session.create(SessionId('node-session'))
    const frames: NodeStreamFrame[] = []
    const agent = fakeAgent(session, () => {})
    const promise = driveTurn(agent, contextFor(new AbortController().signal, f => frames.push(f)))
    await finishTool(agent, 'write', { isError: true, error: { message: 'file access denied under workspace-write mode' }, content: [] })
    await promise
    const result = frames.find(f => f.kind === 'tool_result') as { ok: boolean; preview: string }
    expect(result.ok).toBe(false)
    expect(result.preview).toBe('file access denied under workspace-write mode')
  })

  it('bounds a large tool result rather than streaming the whole thing', async () => {
    const session = Session.create(SessionId('node-session'))
    const frames: NodeStreamFrame[] = []
    const agent = fakeAgent(session, () => {})
    const promise = driveTurn(agent, contextFor(new AbortController().signal, f => frames.push(f)))
    await finishTool(agent, 'read', { isError: false, content: [{ type: 'text', text: 'x'.repeat(5000) }] })
    await promise
    const result = frames.find(f => f.kind === 'tool_result') as { preview: string }
    expect(result.preview).toHaveLength(300)
  })

  it('collects reasoning for the result even when no one is watching', async () => {
    const session = Session.create(SessionId('node-session'))
    const agent = fakeAgent(session, () => {})
    const promise = driveTurn(agent, contextFor(new AbortController().signal))
    agent.ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'quiet thought' } },
    } as never)
    agent.ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'text-delta', index: 1, text: 'answer' } },
    } as never)
    await Promise.all([
      callTool(agent, 'bash', undefined),
      finishTool(agent, 'bash', { isError: false, content: [] }),
    ])
    const { thinking } = await promise
    expect(thinking).toBe('quiet thought')
  })

  it('names a failure the tool reported without a message', async () => {
    const session = Session.create(SessionId('node-session'))
    const frames: NodeStreamFrame[] = []
    const agent = fakeAgent(session, () => {})
    const promise = driveTurn(agent, contextFor(new AbortController().signal, f => frames.push(f)))
    await finishTool(agent, 'bash', { isError: true, error: {}, content: [] })
    await promise
    expect((frames.find(f => f.kind === 'tool_result') as { preview: string }).preview).toBe('tool call failed')
  })

  it('carries every frame kind through a turn nobody is watching', async () => {
    // The fake turns above settle on the first microtask, which disposes the
    // listeners; this one stays open until the test releases it, so each case
    // is driven deterministically rather than racing the turn's end.
    const session = Session.create(SessionId('node-session'))
    const { promise: open, resolve: release } = Promise.withResolvers<undefined>()
    const agent = {
      session,
      ctx: new Context(),
      followup: () => {},
      whenIdle: async () => { await open },
      cancel: () => {},
    } as unknown as Agent
    const turn = driveTurn(agent, contextFor(new AbortController().signal))

    agent.ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'unwatched answer' } },
    } as never)
    agent.ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: '{' } },
    } as never)
    agent.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start' } } as never)
    agent.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end' } } as never)
    await callTool(agent, 'bash', undefined)
    await finishTool(agent, 'bash', { isError: false, content: [] })
    release(undefined)
    const { thinking } = await turn
    expect(thinking).toBe('')
  })

  it('sends empty arguments for a tool the model called with none', async () => {
    const session = Session.create(SessionId('node-session'))
    const frames: NodeStreamFrame[] = []
    const agent = fakeAgent(session, () => {})
    const promise = driveTurn(agent, contextFor(new AbortController().signal, f => frames.push(f)))
    await callTool(agent, 'list_agents', undefined)
    await promise
    expect((frames.find(f => f.kind === 'tool') as { arguments: string }).arguments).toBe('{}')
  })

  it('stops listening after the turn, so a reused session accumulates no listeners', async () => {
    const session = Session.create(SessionId('node-session'))
    const frames: NodeStreamFrame[] = []
    const agent = fakeAgent(session, () => {})
    const context = contextFor(new AbortController().signal, f => frames.push(f))
    await driveTurn(agent, context)
    await driveTurn(agent, context)
    agent.ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'late' } },
    } as never)
    expect(frames).toEqual([])
  })
})

describe('runGraphNode', () => {
  it('acquires the node\'s session, prompts it, and reads the answer back', async () => {
    const session = Session.create(SessionId('node-session'))
    const agent = fakeAgent(session, () => {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      assistantText(session, 'the node answered')
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    })
    const handle = { agent, dispose: async () => {} }
    const factories: unknown[] = []
    const result = await runGraphNode(
      {
        ctx: new Context(),
        tenantId: TENANT,
        request: request(),
        agentPreset: 'standard',
        signal: new AbortController().signal,
      },
      async (create) => {
        factories.push(create)
        return handle
      },
    )
    expect(result.output).toBe('the node answered')
    expect(result.stopReason).toBe('completed')
    // The store decides whether to build; the runner only offers the factory.
    expect(factories).toHaveLength(1)
  })

  it('reports the grant resolved while building a first-use session', async () => {
    const session = Session.create(SessionId('node-session'))
    const agent = fakeAgent(session, () => {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      assistantText(session, 'built and answered')
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    })
    const ctx = {
      agents: {
        create: async (options: Record<string, unknown>) => {
          await (options['setup'] as (c: Context) => Promise<void>)(
            composeCtx(['read', 'glob', 'grep', 'bash']).agentCtx,
          )
          return { agent, dispose: async () => {} }
        },
      },
      agentPresets: { mount: async () => {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
      get: () => undefined,
      logger: { warn: () => {} },
    } as unknown as Context
    const result = await runGraphNode(
      {
        ctx,
        tenantId: TENANT,
        request: request({ tools: ['bash', 'kubernetes_apply'] }),
        agentPreset: 'standard',
        signal: new AbortController().signal,
      },
      async create => await create(),
    )
    expect(result.output).toBe('built and answered')
    expect(result.droppedTools).toEqual(['kubernetes_apply'])
  })

  it('reports an empty grant for a session the store already had', async () => {
    const session = Session.create(SessionId('node-session'))
    const agent = fakeAgent(session, () => {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
    })
    const handle = { agent, dispose: async () => {} }
    const result = await runGraphNode(
      {
        ctx: new Context(),
        tenantId: TENANT,
        request: request(),
        agentPreset: 'standard',
        signal: new AbortController().signal,
      },
      async () => handle,
    )
    expect(result.droppedTools).toEqual([])
  })
})
