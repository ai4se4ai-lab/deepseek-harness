/**
 * TenantSessionGuard tests. A real TenantContextService drives tenant
 * binding (matching production ALS propagation); apiProxy and
 * workspaceRegistry are hand-built fakes narrow enough to exercise every
 * wrapped method's clamp/filter/fail-closed behavior without booting the real
 * session/workspace stack.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RpcId, type ApiProxy, type RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { TenantContextService } from '@mindportalix/dsh-tenant-context'
import * as TenantSessionGuard from '../src/index.ts'
import { isUnderRoot, tenantRootFor } from '../src/index.ts'

interface FakeWorkspace {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

function makeWorkspace(workspaceId: string, path: string, sessionIds: string[] = []): FakeWorkspace {
  return { workspaceId, path, title: workspaceId, sessionIds, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }
}

/** Ancestor-chain breadcrumbs for `target`, matching the real browse backend's `ancestryCrumbs` shape. */
function fakeCrumbs(target: string): { name: string; path: string; hidden: boolean }[] {
  const crumbs: { name: string; path: string; hidden: boolean }[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (parent === current) return crumbs
    current = parent
  }
}

interface Fixture {
  sessions: { sessionId: string; updatedAt: number; running: boolean; blank: boolean; cwd?: string }[]
  searchItems: { sessionId: string; snippet: string }[]
  workspaces: FakeWorkspace[]
  archivedSessionIds: string[]
}

function fakeApiProxy(fixture: Fixture): ApiProxy {
  const sessions = {
    list: async (request: RpcRequest<{ cursor?: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { items: fixture.sessions } } }),
    search: async (request: RpcRequest<{ query: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { items: fixture.searchItems, hasMore: false } } }),
    create: async (request: RpcRequest<{ workspaceId?: string; cwd?: string; sessionId?: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { sessionId: request.payload.sessionId ?? 'created' } } }),
    // Each fake below echoes { reached: true } so tests can assert the call
    // actually reached the original implementation (pass-through), distinct
    // from a guard rejection (which never calls these).
    history: async (request: RpcRequest<{ sessionId: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { events: [], hasMore: false, reached: true } } }),
    models: async (request: RpcRequest<{ sessionId: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { reached: true } } }),
    selectModel: async (request: RpcRequest<{ sessionId: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { reached: true } } }),
    rename: async (request: RpcRequest<{ sessionId: string; title: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { title: request.payload.title, seq: 0, reached: true } } }),
    fork: async (request: RpcRequest<{ sessionId: string; atSeq?: number }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { sessionId: 'forked', reached: true } } }),
    prompt: async (request: RpcRequest<{ sessionId: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { accepted: true, reached: true } } }),
    attachment: async (request: RpcRequest<{ sessionId: string; attachmentId: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { reached: true } } }),
    updateQueue: async (request: RpcRequest<{ sessionId: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { accepted: true, reached: true } } }),
    cancel: async (request: RpcRequest<{ sessionId: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { accepted: true, reached: true } } }),
  }
  const workspace = {
    list: async (request: RpcRequest<{}>) => ({
      rpcId: request.rpcId,
      result: { ok: true, value: { items: fixture.workspaces, archivedSessionIds: fixture.archivedSessionIds } },
    }),
    create: async (request: RpcRequest<{ path: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { workspace: makeWorkspace('new', request.payload.path), created: true } } }),
    rename: async (request: RpcRequest<{ workspaceId: string; title: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { workspace: fixture.workspaces[0] } } }),
    delete: async (request: RpcRequest<{ workspaceId: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { deleted: true } } }),
    insertBefore: async (request: RpcRequest<{ workspaceId: string; beforeWorkspaceId?: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { workspaceIds: [] } } }),
    insertSessionBefore: async (request: RpcRequest<{ workspaceId: string; sessionId: string; beforeSessionId?: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { workspace: fixture.workspaces[0] } } }),
    archiveSession: async (request: RpcRequest<{ sessionId: string }>) => ({
      rpcId: request.rpcId,
      result: { ok: true, value: { archivedSessionIds: [...fixture.archivedSessionIds, request.payload.sessionId] } },
    }),
  }
  const host = {
    // Echoes an untouched (non-tenant-aware) listing: `home` fixed at the
    // container OS home, `path`/`crumbs` following whatever path the guard
    // actually forwarded — tests assert the guard's own rewrite of both.
    listDirectory: async (request: RpcRequest<{ path?: string }>) => {
      const target = request.payload.path ?? '/home/node'
      return {
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: { path: target, home: '/home/node', crumbs: fakeCrumbs(target), entries: [], truncated: false },
        },
      }
    },
    createDirectory: async (request: RpcRequest<{ path: string; name: string }>) =>
      ({ rpcId: request.rpcId, result: { ok: true, value: { path: join(request.payload.path, request.payload.name) } } }),
  }
  return { sessions, workspace, host } as unknown as ApiProxy
}

function fakeWorkspaceRegistry(workspaces: FakeWorkspace[]): Context['workspaceRegistry'] {
  const byId = new Map(workspaces.map(w => [w.workspaceId, w]))
  return {
    get: (id: unknown) => byId.get(String(id)),
    list: () => workspaces,
  } as unknown as Context['workspaceRegistry']
}

let dshHome: string

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-tenant-guard-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(dshHome, { recursive: true, force: true })
})

const TENANT_A = 'a'.repeat(32)
const TENANT_B = 'b'.repeat(32)

async function setup(fixture: Fixture): Promise<{ ctx: Context; api: ApiProxy }> {
  const ctx = new Context()
  await ctx.plugin(TenantContextService)
  const api = fakeApiProxy(fixture)
  ctx.provide('apiProxy', api)
  ctx.provide('workspaceRegistry', fakeWorkspaceRegistry(fixture.workspaces))
  await ctx.plugin(TenantSessionGuard)
  return { ctx, api }
}

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('r-1'), payload }
}

describe('tenantRootFor / isUnderRoot', () => {
  it('computes the tenant root under $DSH_HOME/tenants/<id>', () => {
    expect(tenantRootFor(TENANT_A)).toBe(join(dshHome, 'tenants', TENANT_A))
  })

  it('isUnderRoot accepts the root itself and descendants, rejects siblings and ancestors', () => {
    const root = join(dshHome, 'tenants', TENANT_A)
    expect(isUnderRoot(root, root)).toBe(true)
    expect(isUnderRoot(root, join(root, 'sub', 'dir'))).toBe(true)
    expect(isUnderRoot(root, join(dshHome, 'tenants', TENANT_B))).toBe(false)
    expect(isUnderRoot(root, dshHome)).toBe(false)
    // A sibling directory that merely shares the root as a string PREFIX (not a path
    // component) must not pass — the classic "/tenants/a-evil" vs "/tenants/a" bug.
    expect(isUnderRoot(root, `${root}-evil`)).toBe(false)
  })
})

describe('session.create', () => {
  it('defaults an omitted cwd/workspaceId to the tenant root', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const response = await ctx.tenantContext.run(TENANT_A, () => api.sessions.create(request({})))
    expect(response.result.ok).toBe(true)
  })

  it('accepts a cwd under the tenant root', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const cwd = join(tenantRootFor(TENANT_A), 'project')
    const response = await ctx.tenantContext.run(TENANT_A, () => api.sessions.create(request({ cwd })))
    expect(response.result.ok).toBe(true)
  })

  it('rejects a cwd outside the tenant root with tenant-path-invalid', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const foreignCwd = join(tenantRootFor(TENANT_B), 'project')
    const response = await ctx.tenantContext.run(TENANT_A, () => api.sessions.create(request({ cwd: foreignCwd })))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'tenant-path-invalid' } })
  })

  it('rejects a cross-tenant workspaceId with workspace-not-found', async () => {
    const foreignWorkspace = makeWorkspace('ws-b', join(tenantRootFor(TENANT_B), 'proj'))
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [foreignWorkspace], archivedSessionIds: [] })
    const response = await ctx.tenantContext.run(TENANT_A, () => api.sessions.create(request({ workspaceId: 'ws-b' } as never)))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'workspace-not-found', details: { workspaceId: 'ws-b' } } })
  })

  it('accepts a same-tenant workspaceId', async () => {
    const ownWorkspace = makeWorkspace('ws-a', join(tenantRootFor(TENANT_A), 'proj'))
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [ownWorkspace], archivedSessionIds: [] })
    const response = await ctx.tenantContext.run(TENANT_A, () => api.sessions.create(request({ workspaceId: 'ws-a' } as never)))
    expect(response.result.ok).toBe(true)
  })

  it('rejects with tenant-required when no tenant identity is bound (never silently defaults)', async () => {
    const { api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    // Deliberately NOT wrapped in ctx.tenantContext.run(...).
    const response = await api.sessions.create(request({}))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'tenant-required' } })
  })
})

describe('session.list / session.search', () => {
  it('filters session.list to sessions whose cwd is under the caller tenant root, dropping cwd-less rows', async () => {
    const ownSession = { sessionId: 'own', updatedAt: 1, running: false, blank: false, cwd: join(tenantRootFor(TENANT_A), 'p') }
    const foreignSession = { sessionId: 'foreign', updatedAt: 1, running: false, blank: false, cwd: join(tenantRootFor(TENANT_B), 'p') }
    const unrecordedSession = { sessionId: 'unrecorded', updatedAt: 1, running: false, blank: false }
    const { ctx, api } = await setup({
      sessions: [ownSession, foreignSession, unrecordedSession], searchItems: [], workspaces: [], archivedSessionIds: [],
    })
    const response = await ctx.tenantContext.run(TENANT_A, () => api.sessions.list(request({})))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.items.map(item => item.sessionId)).toEqual(['own'])
  })

  it('rejects session.list with tenant-required when no tenant identity is bound', async () => {
    const { api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const response = await api.sessions.list(request({}))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'tenant-required' } })
  })

  it('filters session.search results to sessions visible in the tenant-filtered session.list', async () => {
    const ownSession = { sessionId: 'own', updatedAt: 1, running: false, blank: false, cwd: join(tenantRootFor(TENANT_A), 'p') }
    const foreignSession = { sessionId: 'foreign', updatedAt: 1, running: false, blank: false, cwd: join(tenantRootFor(TENANT_B), 'p') }
    const { ctx, api } = await setup({
      sessions: [ownSession, foreignSession],
      searchItems: [{ sessionId: 'own', snippet: 'hit' }, { sessionId: 'foreign', snippet: 'hit' }],
      workspaces: [],
      archivedSessionIds: [],
    })
    const response = await ctx.tenantContext.run(TENANT_A, () =>
      api.sessions.search(request({ query: 'hit' }), new AbortController().signal))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.items.map(item => item.sessionId)).toEqual(['own'])
  })
})

describe('by-sessionId methods (history, models, selectModel, rename, fork, prompt, attachment, updateQueue, cancel)', () => {
  function ownAndForeignFixture(): Fixture {
    return {
      sessions: [
        { sessionId: 'own', updatedAt: 1, running: false, blank: false, cwd: join(tenantRootFor(TENANT_A), 'p') },
        { sessionId: 'foreign', updatedAt: 1, running: false, blank: false, cwd: join(tenantRootFor(TENANT_B), 'p') },
      ],
      searchItems: [],
      workspaces: [],
      archivedSessionIds: [],
    }
  }

  const cases: { name: string; call: (api: ApiProxy, sessionId: string) => Promise<{ result: { ok: boolean } }> }[] = [
    { name: 'history', call: (api, sessionId) => api.sessions.history(request({ sessionId } as never)) },
    { name: 'models', call: (api, sessionId) => api.sessions.models(request({ sessionId } as never)) },
    { name: 'selectModel', call: (api, sessionId) => api.sessions.selectModel(request({ sessionId, provider: 'p', model: 'm' } as never)) },
    { name: 'rename', call: (api, sessionId) => api.sessions.rename(request({ sessionId, title: 't' } as never)) },
    { name: 'fork', call: (api, sessionId) => api.sessions.fork(request({ sessionId } as never)) },
    { name: 'prompt', call: (api, sessionId) => api.sessions.prompt(request({ sessionId, mode: 'queue', content: [] } as never)) },
    { name: 'attachment', call: (api, sessionId) => api.sessions.attachment(request({ sessionId, attachmentId: 'a' } as never)) },
    { name: 'updateQueue', call: (api, sessionId) => api.sessions.updateQueue(request({ sessionId, itemId: 'i', action: { kind: 'remove' } } as never)) },
    { name: 'cancel', call: (api, sessionId) => api.sessions.cancel(request({ sessionId } as never)) },
  ]

  it.each(cases)('$name rejects a cross-tenant sessionId with session-not-found', async ({ call }) => {
    const { ctx, api } = await setup(ownAndForeignFixture())
    const response = await ctx.tenantContext.run(TENANT_A, () => call(api, 'foreign'))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'session-not-found', details: { sessionId: 'foreign' } } })
  })

  it.each(cases)('$name rejects an unknown sessionId with session-not-found', async ({ call }) => {
    const { ctx, api } = await setup(ownAndForeignFixture())
    const response = await ctx.tenantContext.run(TENANT_A, () => call(api, 'nonexistent'))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  })

  it.each(cases)('$name passes a same-tenant sessionId through to the original implementation', async ({ call }) => {
    const { ctx, api } = await setup(ownAndForeignFixture())
    const response = await ctx.tenantContext.run(TENANT_A, () => call(api, 'own'))
    expect(response.result.ok).toBe(true)
    // The fake echoes { reached: true } (never present on a guard rejection) so
    // this asserts the call reached the original implementation, not just "ok: true".
    expect((response.result as unknown as { value: { reached: boolean } }).value.reached).toBe(true)
  })

  it.each(cases)('$name rejects with tenant-required when no tenant identity is bound', async ({ call }) => {
    const { api } = await setup(ownAndForeignFixture())
    const response = await call(api, 'own')
    expect(response.result).toMatchObject({ ok: false, error: { code: 'tenant-required' } })
  })
})

describe('session.fork child cwd inheritance', () => {
  it('does not need independent clamping: the child inherits the verified source session\'s cwd verbatim (api-proxy.ts never takes a client-supplied cwd for fork)', async () => {
    // Documents the reasoning verified by reading packages/host/apiproxy/src/api-proxy.ts's
    // fork() implementation directly: meta.cwd is set from source.header.cwd, never from
    // the request payload, so proving the SOURCE session is tenant-owned (the guardBySessionId
    // check already covers this) is sufficient — there is no separate child-cwd input to clamp.
    const { ctx, api } = await setup({
      sessions: [{ sessionId: 'own', updatedAt: 1, running: false, blank: false, cwd: join(tenantRootFor(TENANT_A), 'p') }],
      searchItems: [],
      workspaces: [],
      archivedSessionIds: [],
    })
    const response = await ctx.tenantContext.run(TENANT_A, () => api.sessions.fork(request({ sessionId: 'own' } as never)))
    expect(response.result.ok).toBe(true)
  })
})

describe('workspace.list', () => {
  it('filters items by path and archivedSessionIds by tenant-visible workspace membership', async () => {
    const ownWorkspace = makeWorkspace('ws-a', join(tenantRootFor(TENANT_A), 'proj'), ['own-archived'])
    const foreignWorkspace = makeWorkspace('ws-b', join(tenantRootFor(TENANT_B), 'proj'), ['foreign-archived'])
    const { ctx, api } = await setup({
      sessions: [], searchItems: [], workspaces: [ownWorkspace, foreignWorkspace],
      archivedSessionIds: ['own-archived', 'foreign-archived'],
    })
    const response = await ctx.tenantContext.run(TENANT_A, () => api.workspace.list(request({})))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.items.map(item => item.workspaceId)).toEqual(['ws-a'])
    expect(response.result.value.archivedSessionIds).toEqual(['own-archived'])
  })
})

describe('workspace.create', () => {
  it('rejects a path outside the tenant root', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const response = await ctx.tenantContext.run(TENANT_A, () =>
      api.workspace.create(request({ path: join(tenantRootFor(TENANT_B), 'x') })))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'tenant-path-invalid' } })
  })

  it('accepts a path under the tenant root', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const response = await ctx.tenantContext.run(TENANT_A, () =>
      api.workspace.create(request({ path: join(tenantRootFor(TENANT_A), 'x') })))
    expect(response.result.ok).toBe(true)
  })
})

describe('workspace.rename / delete / insertBefore / insertSessionBefore', () => {
  it('rejects a cross-tenant workspaceId on every targeted method with workspace-not-found', async () => {
    const foreignWorkspace = makeWorkspace('ws-b', join(tenantRootFor(TENANT_B), 'proj'))
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [foreignWorkspace], archivedSessionIds: [] })
    const run = <T>(fn: () => Promise<T>): Promise<T> => ctx.tenantContext.run(TENANT_A, fn)

    await expect(run(() => api.workspace.rename(request({ workspaceId: 'ws-b', title: 't' } as never))))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'workspace-not-found' } } })
    await expect(run(() => api.workspace.delete(request({ workspaceId: 'ws-b' } as never))))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'workspace-not-found' } } })
    await expect(run(() => api.workspace.insertBefore(request({ workspaceId: 'ws-b' } as never))))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'workspace-not-found' } } })
    await expect(run(() => api.workspace.insertSessionBefore(request({ workspaceId: 'ws-b', sessionId: 's' } as never))))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'workspace-not-found' } } })
  })

  it('insertBefore also rejects a cross-tenant beforeWorkspaceId even when the primary id is same-tenant', async () => {
    const ownWorkspace = makeWorkspace('ws-a', join(tenantRootFor(TENANT_A), 'proj'))
    const foreignWorkspace = makeWorkspace('ws-b', join(tenantRootFor(TENANT_B), 'proj'))
    const { ctx, api } = await setup({
      sessions: [], searchItems: [], workspaces: [ownWorkspace, foreignWorkspace], archivedSessionIds: [],
    })
    const response = await ctx.tenantContext.run(TENANT_A, () =>
      api.workspace.insertBefore(request({ workspaceId: 'ws-a', beforeWorkspaceId: 'ws-b' } as never)))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'workspace-not-found', details: { workspaceId: 'ws-b' } } })
  })

  it('accepts a same-tenant workspaceId', async () => {
    const ownWorkspace = makeWorkspace('ws-a', join(tenantRootFor(TENANT_A), 'proj'))
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [ownWorkspace], archivedSessionIds: [] })
    const response = await ctx.tenantContext.run(TENANT_A, () => api.workspace.delete(request({ workspaceId: 'ws-a' } as never)))
    expect(response.result.ok).toBe(true)
  })
})

describe('workspace.archiveSession', () => {
  it('rejects a session owned by another tenant workspace with session-not-found', async () => {
    const foreignWorkspace = makeWorkspace('ws-b', join(tenantRootFor(TENANT_B), 'proj'), ['s-foreign'])
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [foreignWorkspace], archivedSessionIds: [] })
    const response = await ctx.tenantContext.run(TENANT_A, () => api.workspace.archiveSession(request({ sessionId: 's-foreign' } as never)))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  })

  it('rejects an ungrouped session (owned by no workspace) rather than allowing it through unverified', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const response = await ctx.tenantContext.run(TENANT_A, () =>
      api.workspace.archiveSession(request({ sessionId: 's-ungrouped' } as never)))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  })

  it('accepts a session owned by a same-tenant workspace', async () => {
    const ownWorkspace = makeWorkspace('ws-a', join(tenantRootFor(TENANT_A), 'proj'), ['s-own'])
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [ownWorkspace], archivedSessionIds: [] })
    const response = await ctx.tenantContext.run(TENANT_A, () => api.workspace.archiveSession(request({ sessionId: 's-own' } as never)))
    expect(response.result.ok).toBe(true)
  })
})

describe('host.listDirectory', () => {
  it('defaults an omitted path to the tenant root, never the container OS home', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const response = await ctx.tenantContext.run(TENANT_A, () =>
      api.host.listDirectory(request({}), new AbortController().signal))
    expect(response.result).toMatchObject({ ok: true, value: { path: tenantRootFor(TENANT_A) } })
  })

  it('rewrites home to the tenant root and clips crumbs to start there', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const target = join(tenantRootFor(TENANT_A), 'project')
    const response = await ctx.tenantContext.run(TENANT_A, () =>
      api.host.listDirectory(request({ path: target }), new AbortController().signal))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.home).toBe(tenantRootFor(TENANT_A))
    expect(response.result.value.crumbs[0]?.path).toBe(tenantRootFor(TENANT_A))
    expect(response.result.value.crumbs.some(crumb => crumb.path === '/')).toBe(false)
  })

  it('accepts a path under the tenant root', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const target = join(tenantRootFor(TENANT_A), 'project')
    const response = await ctx.tenantContext.run(TENANT_A, () =>
      api.host.listDirectory(request({ path: target }), new AbortController().signal))
    expect(response.result).toMatchObject({ ok: true, value: { path: target } })
  })

  it('rejects a path outside the tenant root with tenant-path-invalid', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const foreignPath = join(tenantRootFor(TENANT_B), 'project')
    const response = await ctx.tenantContext.run(TENANT_A, () =>
      api.host.listDirectory(request({ path: foreignPath }), new AbortController().signal))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'tenant-path-invalid', details: { path: foreignPath } } })
  })

  it('fails closed with tenant-required when no tenant identity is bound', async () => {
    const { api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const response = await api.host.listDirectory(request({}), new AbortController().signal)
    expect(response.result).toMatchObject({ ok: false, error: { code: 'tenant-required' } })
  })
})

describe('host.createDirectory', () => {
  it('accepts a parent path under the tenant root', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const response = await ctx.tenantContext.run(TENANT_A, () =>
      api.host.createDirectory(request({ path: tenantRootFor(TENANT_A), name: 'new-folder' })))
    expect(response.result).toMatchObject({ ok: true, value: { path: join(tenantRootFor(TENANT_A), 'new-folder') } })
  })

  it('rejects a parent path outside the tenant root with tenant-path-invalid', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const response = await ctx.tenantContext.run(TENANT_A, () =>
      api.host.createDirectory(request({ path: '/home/node', name: 'new-folder' })))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'tenant-path-invalid', details: { path: '/home/node' } } })
  })

  it('fails closed with tenant-required when no tenant identity is bound', async () => {
    const { api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    const response = await api.host.createDirectory(request({ path: '/home/node', name: 'x' }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'tenant-required' } })
  })
})

describe('HMR safety', () => {
  it('restores the original apiProxy methods when the plugin fiber is disposed', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    // oxlint-disable-next-line typescript/unbound-method -- identity comparison only, never invoked unbound.
    const wrappedCreate = api.sessions.create
    // Disposing the whole context tears down every mounted fiber, including this plugin's.
    await ctx.fiber.dispose()
    // oxlint-disable-next-line typescript/unbound-method -- identity comparison only, never invoked unbound.
    expect(api.sessions.create).not.toBe(wrappedCreate)
    // The restored method is the original fake (no tenant clamp, no tenant-required rejection).
    const response = await api.sessions.create(request({}))
    expect(response.result.ok).toBe(true)
  })

  it('restores the original host.listDirectory/createDirectory when the plugin fiber is disposed', async () => {
    const { ctx, api } = await setup({ sessions: [], searchItems: [], workspaces: [], archivedSessionIds: [] })
    // oxlint-disable-next-line typescript/unbound-method -- identity comparison only, never invoked unbound.
    const wrappedListDirectory = api.host.listDirectory
    await ctx.fiber.dispose()
    // oxlint-disable-next-line typescript/unbound-method -- identity comparison only, never invoked unbound.
    expect(api.host.listDirectory).not.toBe(wrappedListDirectory)
    // The restored method is the original fake: no tenant-required rejection,
    // and `home` stays the container OS home (the guard's rewrite is gone).
    const response = await api.host.listDirectory(request({}), new AbortController().signal)
    expect(response.result).toMatchObject({ ok: true, value: { home: '/home/node' } })
  })
})
