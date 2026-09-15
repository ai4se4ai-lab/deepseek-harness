/**
 * Route tests: the fail-closed tenant gate, the wire-boundary rejections, and
 * the run-control operations. The tenant gate is the one that matters most —
 * every path below the route trusts the bound tenant id to scope a filesystem
 * directory and a session key, so an unbound request must never reach it.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TenantContextService, { TENANT_HEADER_NAME } from '@mindportalix/dsh-tenant-context'
import * as runner from '../src/index.ts'

const TENANT = 'a'.repeat(32)

interface Captured {
  status: number
  body: unknown
}

/** One streamed frame, as the app's client parses it. */
interface Frame {
  kind: string
  text?: string
  name?: string
  result?: { output: string; thinking: string }
  message?: string
}

/** A response double recording what the handler wrote, streamed or not. */
function response(): { res: never; captured: () => Captured; frames: () => Frame[] } {
  let status = 0
  let body: unknown
  let ended = false
  let headersSent = false
  const chunks: string[] = []
  const res = {
    set statusCode(value: number) { status = value },
    get statusCode() { return status },
    get writableEnded() { return ended },
    get headersSent() { return headersSent },
    setHeader: () => { headersSent = true },
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: (payload?: string) => {
      ended = true
      headersSent = true
      if (payload !== undefined) body = JSON.parse(payload)
    },
  }
  return {
    res: res as never,
    captured: () => ({ status, body }),
    frames: () => chunks.map((chunk) => {
      const data = /data: (.*)\n\n$/s.exec(chunk)
      return JSON.parse(data?.[1] ?? '{}') as Frame
    }),
  }
}

/** A request double: raw body bytes, headers, and a `close` channel the test fires. */
function rawRequest(
  raw: string,
  headers: Record<string, string> = {},
  method = 'POST',
): { req: never; close: () => void } {
  const closeListeners = new Set<() => void>()
  const req = {
    method,
    headers,
    on: (event: string, listener: () => void) => {
      if (event === 'close') closeListeners.add(listener)
      return req
    },
    off: (event: string, listener: () => void) => {
      if (event === 'close') closeListeners.delete(listener)
      return req
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      yield Buffer.from(raw)
    },
  }
  return { req: req as never, close: () => { for (const listener of closeListeners) listener() } }
}

/** A request double carrying one JSON body. */
function request(body: unknown, headers: Record<string, string> = {}, method = 'POST'): never {
  return rawRequest(JSON.stringify(body), headers, method).req
}

/** The routes the plugin registered, by path. */
type Handler = (req: never, res: never) => Promise<void>

let home: string
let ctx: Context
let routes: Map<string, Handler>
let created: Record<string, unknown>[]
let sessions: Map<string, Session>

/** A web server double collecting registrations. */
class FakeWebServer extends Service {
  readonly registered = new Map<string, Handler>()
  constructor(context: Context) {
    super(context, 'webServer')
  }

  register(route: { path: string; handler: Handler }): () => void {
    this.registered.set(route.path, route.handler)
    return () => { this.registered.delete(route.path) }
  }
}

/** An agent registry double: each created agent answers with its node id. */
class FakeAgents extends Service {
  constructor(context: Context) {
    super(context, 'agents')
  }

  async create(options: Record<string, unknown>): Promise<unknown> {
    created.push(options)
    const id = String(options['sessionId'])
    const session = Session.create(SessionId(id))
    sessions.set(id, session)
    await (options['setup'] as (c: Context) => Promise<void>)(agentCtxDouble())
    const agent = {
      session,
      ctx: new Context(),
      followup: () => {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('assistant/message', {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: `answer from ${id}` }], source: { kind: 'model' } },
          stream: [],
        } as never, { surfaceOp: 'append' } as never)
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
      },
      whenIdle: async () => {},
      cancel: vi.fn(),
    }
    return { agent, dispose: async () => {} }
  }
}

/** A preset roster double. */
class FakePresets extends Service {
  constructor(context: Context) {
    super(context, 'agentPresets')
  }

  async mount(): Promise<void> {}
}

/** A tenant default-model double: every node request in these tests declares none. */
class FakeAgentDefaultModel extends Service {
  constructor(context: Context) {
    super(context, 'agentDefaultModel')
  }

  currentSelection(): { provider: string; model: string } {
    return { provider: 'deepseek', model: 'deepseek-chat' }
  }
}

/** The scoped context composition installs the node's identity on. */
function agentCtxDouble(): Context {
  return {
    systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
    tools: { schemas: () => [{ name: 'read' }, { name: 'glob' }, { name: 'grep' }, { name: 'bash' }], restrict: () => {} },
  } as unknown as Context
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'graph-node-routes-'))
  process.env['DSH_HOME'] = home
  created = []
  sessions = new Map()
  ctx = new Context()
  await ctx.plugin(TenantContextService)
  await ctx.plugin(FakeWebServer)
  await ctx.plugin(FakeAgents)
  await ctx.plugin(FakePresets)
  await ctx.plugin(FakeAgentDefaultModel)
  await ctx.plugin(runner, {})
  routes = (ctx.webServer as unknown as FakeWebServer).registered
})

afterEach(async () => {
  delete process.env['DSH_HOME']
  await rm(home, { recursive: true, force: true })
})

async function call(path: string, body: unknown, headers: Record<string, string> = { [TENANT_HEADER_NAME]: TENANT }, method = 'POST'): Promise<Captured> {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`no route at ${path}`)
  const { res, captured } = response()
  await handler(request(body, headers, method), res)
  return captured()
}

const node = {
  runId: 'run1',
  nodeId: 'code_writer',
  systemPrompt: 'Implement the planned change.',
  input: 'Step 1.',
}

describe('registration', () => {
  it('registers the node and run-control routes', () => {
    expect([...routes.keys()].sort()).toEqual([
      runner.CANCEL_ROUTE,
      runner.NODE_ROUTE,
      runner.RELEASE_ROUTE,
    ].sort())
  })

  it('removes its routes when the plugin fiber disposes', async () => {
    const fresh = new Context()
    await fresh.plugin(TenantContextService)
    await fresh.plugin(FakeWebServer)
    await fresh.plugin(FakeAgents)
    await fresh.plugin(FakePresets)
    await fresh.plugin(FakeAgentDefaultModel)
    const fiber = await fresh.plugin(runner, {})
    const registered = (fresh.webServer as unknown as FakeWebServer).registered
    expect(registered.size).toBe(3)
    await fiber.dispose()
    expect(registered.size).toBe(0)
  })
})

describe('api trust fence', () => {
  /** A composition whose connection service rejects everything. */
  async function fenced(rejection: 401 | 403): Promise<Map<string, Handler>> {
    const guarded = new Context()
    await guarded.plugin(TenantContextService)
    await guarded.plugin(FakeWebServer)
    await guarded.plugin(FakeAgents)
    await guarded.plugin(FakePresets)
    await guarded.plugin(FakeAgentDefaultModel)
    await guarded.plugin(class extends Service {
      constructor(context: Context) { super(context, 'connection') }
      requestRejection(): 401 | 403 { return rejection }
    })
    await guarded.plugin(runner, {})
    return (guarded.webServer as unknown as FakeWebServer).registered
  }

  it('refuses a request the composition does not trust', async () => {
    const handlers = await fenced(403)
    const { res, captured } = response()
    await handlers.get(runner.NODE_ROUTE)?.(request(node, { [TENANT_HEADER_NAME]: TENANT }), res)
    expect(captured().status).toBe(403)
    expect(created).toHaveLength(0)
  })

  it('passes the composition\'s own status through', async () => {
    const handlers = await fenced(401)
    const { res, captured } = response()
    await handlers.get(runner.CANCEL_ROUTE)?.(request({ runId: 'run1' }, { [TENANT_HEADER_NAME]: TENANT }), res)
    expect(captured().status).toBe(401)
  })

  it('answers normally in a composition with no connection service', async () => {
    const result = await call(runner.NODE_ROUTE, node)
    expect(result.status).toBe(200)
  })
})

describe('tenant gate', () => {
  it('refuses a request with no tenant header', async () => {
    const result = await call(runner.NODE_ROUTE, node, {})
    expect(result.status).toBe(401)
    expect((result.body as { code: string }).code).toBe('tenant-required')
    expect(created).toHaveLength(0)
  })

  it('refuses a malformed tenant header rather than defaulting to a shared tenant', async () => {
    const result = await call(runner.NODE_ROUTE, node, { [TENANT_HEADER_NAME]: 'not-a-tenant' })
    expect(result.status).toBe(401)
    expect(created).toHaveLength(0)
  })

  it('scopes the run workspace to the calling tenant', async () => {
    await call(runner.NODE_ROUTE, node)
    expect((created[0]?.['meta'] as { cwd: string }).cwd)
      .toBe(join(home, 'tenants', TENANT, 'runs', 'run1'))
  })

  it('gives two tenants separate sessions for the same run and node', async () => {
    await call(runner.NODE_ROUTE, node)
    await call(runner.NODE_ROUTE, node, { [TENANT_HEADER_NAME]: 'b'.repeat(32) })
    expect(created).toHaveLength(2)
  })
})

describe('method and body handling', () => {
  it('refuses a GET', async () => {
    const result = await call(runner.NODE_ROUTE, node, { [TENANT_HEADER_NAME]: TENANT }, 'GET')
    expect(result.status).toBe(405)
  })

  it('refuses a body that is not JSON', async () => {
    const { res, captured } = response()
    await routes.get(runner.NODE_ROUTE)?.(rawRequest('{ not json', { [TENANT_HEADER_NAME]: TENANT }).req, res)
    expect(captured().status).toBe(400)
  })

  it('refuses a body past the configured ceiling', async () => {
    const small = new Context()
    await small.plugin(TenantContextService)
    await small.plugin(FakeWebServer)
    await small.plugin(FakeAgents)
    await small.plugin(FakePresets)
    await small.plugin(FakeAgentDefaultModel)
    await small.plugin(runner, { maxBodyBytes: 1024 })
    const handler = (small.webServer as unknown as FakeWebServer).registered.get(runner.NODE_ROUTE)
    const { res, captured } = response()
    await handler?.(request({ ...node, input: 'x'.repeat(4096) }, { [TENANT_HEADER_NAME]: TENANT }), res)
    expect(captured().status).toBe(413)
  })

  it('refuses a traversal runId with a 400, not a 500', async () => {
    const result = await call(runner.NODE_ROUTE, { ...node, runId: '../escape' })
    expect(result.status).toBe(400)
    expect((result.body as { code: string }).code).toBe('invalid-request')
  })

  it('refuses a missing required field', async () => {
    const result = await call(runner.NODE_ROUTE, { runId: 'run1', nodeId: 'a', input: 'x' })
    expect(result.status).toBe(400)
  })
})

describe('node execution', () => {
  it('returns the node\'s answer', async () => {
    const result = await call(runner.NODE_ROUTE, node)
    expect(result.status).toBe(200)
    expect((result.body as { output: string }).output).toMatch(/^answer from mp-run1-code_writer-/)
  })

  it('reuses one node\'s session across retries of that node', async () => {
    await call(runner.NODE_ROUTE, node)
    await call(runner.NODE_ROUTE, node)
    expect(created).toHaveLength(1)
  })

  it('gives a different node of the same run its own session', async () => {
    await call(runner.NODE_ROUTE, node)
    await call(runner.NODE_ROUTE, { ...node, nodeId: 'reviewer' })
    expect(created).toHaveLength(2)
  })

  it('reports a requested tool this composition does not register', async () => {
    const result = await call(runner.NODE_ROUTE, { ...node, tools: ['bash', 'kubernetes_apply'] })
    expect((result.body as { droppedTools: string[] }).droppedTools).toEqual(['kubernetes_apply'])
  })

  it('surfaces an agent-creation failure as a 500 rather than a hang', async () => {
    const broken = new Context()
    await broken.plugin(TenantContextService)
    await broken.plugin(FakeWebServer)
    await broken.plugin(class extends Service {
      constructor(context: Context) { super(context, 'agents') }
      async create(): Promise<unknown> { throw new Error('composition rejected') }
    })
    await broken.plugin(FakePresets)
    await broken.plugin(FakeAgentDefaultModel)
    await broken.plugin(runner, {})
    const handler = (broken.webServer as unknown as FakeWebServer).registered.get(runner.NODE_ROUTE)
    const { res, captured } = response()
    await handler?.(request(node, { [TENANT_HEADER_NAME]: TENANT }), res)
    expect(captured().status).toBe(500)
    expect((captured().body as { message: string }).message).toContain('composition rejected')
  })
})

describe('run control', () => {
  it('releases every session of a run', async () => {
    await call(runner.NODE_ROUTE, node)
    await call(runner.NODE_ROUTE, { ...node, nodeId: 'reviewer' })
    const result = await call(runner.RELEASE_ROUTE, { runId: 'run1' })
    expect((result.body as { released: number }).released).toBe(2)
  })

  it('releases one named node only', async () => {
    await call(runner.NODE_ROUTE, node)
    await call(runner.NODE_ROUTE, { ...node, nodeId: 'reviewer' })
    const result = await call(runner.RELEASE_ROUTE, { runId: 'run1', nodeId: 'reviewer' })
    expect((result.body as { released: number }).released).toBe(1)
  })

  it('never releases another tenant\'s run of the same name', async () => {
    await call(runner.NODE_ROUTE, node)
    const result = await call(runner.RELEASE_ROUTE, { runId: 'run1' }, { [TENANT_HEADER_NAME]: 'b'.repeat(32) })
    expect((result.body as { released: number }).released).toBe(0)
  })

  it('cancels a run\'s live turns without dropping its sessions', async () => {
    await call(runner.NODE_ROUTE, node)
    const cancelled = await call(runner.CANCEL_ROUTE, { runId: 'run1' })
    expect((cancelled.body as { cancelled: number }).cancelled).toBe(1)
    await call(runner.NODE_ROUTE, node)
    expect(created).toHaveLength(1)
  })

  it('refuses run control with no tenant', async () => {
    expect((await call(runner.CANCEL_ROUTE, { runId: 'run1' }, {})).status).toBe(401)
    expect((await call(runner.RELEASE_ROUTE, { runId: 'run1' }, {})).status).toBe(401)
  })

  it('refuses a malformed run scope', async () => {
    expect((await call(runner.RELEASE_ROUTE, {})).status).toBe(400)
    expect((await call(runner.CANCEL_ROUTE, { runId: '../x' })).status).toBe(400)
  })

  it('refuses a GET on the control routes', async () => {
    expect((await call(runner.CANCEL_ROUTE, {}, { [TENANT_HEADER_NAME]: TENANT }, 'GET')).status).toBe(405)
    expect((await call(runner.RELEASE_ROUTE, {}, { [TENANT_HEADER_NAME]: TENANT }, 'GET')).status).toBe(405)
  })
})

describe('cancellation', () => {
  it('cancels the node when the caller disconnects mid-turn', async () => {
    const { res, captured } = response()
    const { req, close } = rawRequest(JSON.stringify(node), { [TENANT_HEADER_NAME]: TENANT })
    const pending = routes.get(runner.NODE_ROUTE)?.(req, res)
    // The close listener is installed after the body read, one turn of the
    // microtask queue in; disconnecting before that would test nothing.
    await new Promise(resolve => setImmediate(resolve))
    close()
    await pending
    expect(captured().status).toBe(200)
  })

  it('stops a node whose turn outruns the request\'s ceiling', async () => {
    const cancels: string[] = []
    const slow = new Context()
    await slow.plugin(TenantContextService)
    await slow.plugin(FakeWebServer)
    await slow.plugin(class extends Service {
      constructor(context: Context) { super(context, 'agents') }
      async create(options: Record<string, unknown>): Promise<unknown> {
        const session = Session.create(SessionId(String(options['sessionId'])))
        await (options['setup'] as (c: Context) => Promise<void>)(agentCtxDouble())
        // The turn ends only when something cancels it, so the ceiling is the
        // only thing that can settle this request.
        const { promise, resolve } = Promise.withResolvers<undefined>()
        return {
          agent: {
            session,
            ctx: new Context(),
            followup: () => {},
            whenIdle: async () => { await promise },
            cancel: () => { cancels.push('cancelled'); resolve(undefined) },
          },
          dispose: async () => {},
        }
      }
    })
    await slow.plugin(FakePresets)
    await slow.plugin(FakeAgentDefaultModel)
    await slow.plugin(runner, {})
    const { res, captured } = response()
    await (slow.webServer as unknown as FakeWebServer).registered
      .get(runner.NODE_ROUTE)?.(request({ ...node, timeoutMs: 1 }, { [TENANT_HEADER_NAME]: TENANT }), res)
    expect(cancels).toEqual(['cancelled'])
    expect(captured().status).toBe(200)
    expect((captured().body as { stopReason: string }).stopReason).toBe('aborted')
  })
})

describe('failure reporting', () => {
  it('reports a non-Error failure without leaking its shape', async () => {
    const odd = new Context()
    await odd.plugin(TenantContextService)
    await odd.plugin(FakeWebServer)
    await odd.plugin(class extends Service {
      constructor(context: Context) { super(context, 'agents') }
      async create(): Promise<unknown> {
        throw 'a bare string from somewhere deep'
      }
    })
    await odd.plugin(FakePresets)
    await odd.plugin(FakeAgentDefaultModel)
    await odd.plugin(runner, {})
    const { res, captured } = response()
    await (odd.webServer as unknown as FakeWebServer).registered
      .get(runner.NODE_ROUTE)?.(request(node, { [TENANT_HEADER_NAME]: TENANT }), res)
    expect(captured().status).toBe(500)
    expect((captured().body as { message: string }).message).toBe('a bare string from somewhere deep')
  })
})

describe('idle sweep', () => {
  it('disposes a node session left idle past the ttl', async () => {
    vi.useFakeTimers()
    try {
      const swept = new Context()
      await swept.plugin(TenantContextService)
      await swept.plugin(FakeWebServer)
      await swept.plugin(FakeAgents)
      await swept.plugin(FakePresets)
      await swept.plugin(FakeAgentDefaultModel)
      await swept.plugin(runner, { idleTtlMs: 1000, sweepIntervalMs: 1000 })
      const handlers = (swept.webServer as unknown as FakeWebServer).registered
      const first = response()
      await handlers.get(runner.NODE_ROUTE)?.(request(node, { [TENANT_HEADER_NAME]: TENANT }), first.res)
      expect(created).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(5000)
      const second = response()
      await handlers.get(runner.NODE_ROUTE)?.(request(node, { [TENANT_HEADER_NAME]: TENANT }), second.res)
      // The swept session is gone, so the node is composed again.
      expect(created).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})


describe('streaming a node turn', () => {
  const sse = { [TENANT_HEADER_NAME]: TENANT, accept: 'text/event-stream' }

  it('answers with frames rather than one JSON body', async () => {
    const { res, captured, frames } = response()
    await routes.get(runner.NODE_ROUTE)?.(request(node, sse), res)
    expect(captured().status).toBe(200)
    expect(captured().body).toBeUndefined()
    expect(frames().length).toBeGreaterThan(0)
  })

  it('closes with an end frame carrying the same result a plain caller receives', async () => {
    const streamed = response()
    await routes.get(runner.NODE_ROUTE)?.(request(node, sse), streamed.res)
    const plain = response()
    await routes.get(runner.NODE_ROUTE)?.(request({ ...node, nodeId: 'other' }, { [TENANT_HEADER_NAME]: TENANT }), plain.res)
    const end = streamed.frames().find(f => f.kind === 'end')
    expect(end?.result?.output).toMatch(/^answer from mp-run1-code_writer-/)
    expect(Object.keys(end?.result ?? {}).sort())
      .toEqual(Object.keys(plain.captured().body as object).sort())
  })

  it('still refuses an unbound tenant before opening a stream', async () => {
    const { res, captured, frames } = response()
    await routes.get(runner.NODE_ROUTE)?.(request(node, { accept: 'text/event-stream' }), res)
    expect(captured().status).toBe(401)
    expect(frames()).toEqual([])
  })

  it('still refuses a malformed body with a JSON status, not a frame', async () => {
    const { res, captured, frames } = response()
    await routes.get(runner.NODE_ROUTE)?.(request({ ...node, runId: '../escape' }, sse), res)
    expect(captured().status).toBe(400)
    expect(frames()).toEqual([])
  })

  it('reports a mid-turn failure as a closing error frame', async () => {
    const broken = new Context()
    await broken.plugin(TenantContextService)
    await broken.plugin(FakeWebServer)
    await broken.plugin(class extends Service {
      constructor(context: Context) { super(context, 'agents') }
      async create(): Promise<unknown> { throw new Error('composition rejected') }
    })
    await broken.plugin(FakePresets)
    await broken.plugin(FakeAgentDefaultModel)
    await broken.plugin(runner, {})
    const { res, frames } = response()
    await (broken.webServer as unknown as FakeWebServer).registered
      .get(runner.NODE_ROUTE)?.(request(node, sse), res)
    const error = frames().find(f => f.kind === 'error')
    expect(error?.message).toContain('composition rejected')
  })

  it('drops a frame written after the response closed', async () => {
    // A frame already in flight must not throw on a socket the caller has gone
    // from; the writer checks the response rather than trusting its disposer.
    const { res, frames } = response()
    const emit = runner.openStream(res)
    emit({ kind: 'text', text: 'in time' })
    ;(res as unknown as { end: () => void }).end()
    emit({ kind: 'text', text: 'too late' })
    expect(frames().map(f => f.text)).toEqual(['in time'])
  })

  it('cancels a stream when the caller goes away mid-turn', async () => {
    const slow = new Context()
    await slow.plugin(TenantContextService)
    await slow.plugin(FakeWebServer)
    await slow.plugin(class extends Service {
      constructor(context: Context) { super(context, 'agents') }
      async create(options: Record<string, unknown>): Promise<unknown> {
        const session = Session.create(SessionId(String(options['sessionId'])))
        await (options['setup'] as (c: Context) => Promise<void>)(agentCtxDouble())
        const agentCtx = new Context()
        return {
          agent: {
            session,
            ctx: agentCtx,
            followup: () => {},
            whenIdle: async () => {},
            cancel: () => {},
          },
          dispose: async () => {},
        }
      }
    })
    await slow.plugin(FakePresets)
    await slow.plugin(FakeAgentDefaultModel)
    await slow.plugin(runner, {})
    const { res, frames } = response()
    await (slow.webServer as unknown as FakeWebServer).registered
      .get(runner.NODE_ROUTE)?.(request(node, sse), res)
    expect(frames().some(f => f.kind === 'end')).toBe(true)
  })

  it('leaves a plain caller on the JSON path', async () => {
    const { res, captured, frames } = response()
    await routes.get(runner.NODE_ROUTE)?.(request(node, { [TENANT_HEADER_NAME]: TENANT }), res)
    expect(frames()).toEqual([])
    expect((captured().body as { output: string }).output).toBeDefined()
  })
})
