/**
 * Session-store tests. The store is what makes a reviewer's retry re-enter the
 * same node rather than a cold one, and what keeps two tenants' runs of the
 * same name apart. Both eviction paths are exercised because an abandoned run
 * never sends its release.
 */

import { describe, expect, it, vi } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { NodeSessionStore } from '../src/session-store.ts'

interface FakeHandle extends AgentHandle {
  readonly disposed: () => boolean
  readonly cancels: () => number
}

/** One stand-in agent handle; only the lifecycle members the store touches are real. */
function fakeHandle(id: string): FakeHandle {
  let disposed = false
  let cancels = 0
  const handle = {
    agent: { cancel: () => { cancels += 1 }, session: { id } },
    dispose: async () => { disposed = true },
    disposed: () => disposed,
    cancels: () => cancels,
  }
  return handle as unknown as FakeHandle
}

function store(options: { idleTtlMs?: number; maxSessions?: number } = {}, now = () => 0): NodeSessionStore {
  return new NodeSessionStore(
    { idleTtlMs: options.idleTtlMs ?? 1000, maxSessions: options.maxSessions ?? 8 },
    now,
  )
}

const TENANT = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

describe('acquire', () => {
  it('creates a session on first use', async () => {
    const created = fakeHandle('one')
    const handle = await store().acquire(TENANT, 'run1', 'planner', async () => created)
    expect(handle).toBe(created)
  })

  it('reuses one node session across retries instead of creating a second', async () => {
    const subject = store()
    const create = vi.fn(async () => fakeHandle('one'))
    const first = await subject.acquire(TENANT, 'run1', 'planner', create)
    const second = await subject.acquire(TENANT, 'run1', 'planner', create)
    expect(second).toBe(first)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('gives two nodes of one run separate sessions', async () => {
    const subject = store()
    const planner = await subject.acquire(TENANT, 'run1', 'planner', async () => fakeHandle('planner'))
    const writer = await subject.acquire(TENANT, 'run1', 'writer', async () => fakeHandle('writer'))
    expect(writer).not.toBe(planner)
    expect(subject.size).toBe(2)
  })

  it('keeps two tenants apart when the run and node ids collide', async () => {
    const subject = store()
    const mine = await subject.acquire(TENANT, 'run1', 'planner', async () => fakeHandle('mine'))
    const theirs = await subject.acquire(OTHER, 'run1', 'planner', async () => fakeHandle('theirs'))
    expect(theirs).not.toBe(mine)
  })

  it('shares one creation between concurrent callers for the same node', async () => {
    const subject = store()
    const create = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return fakeHandle('one')
    })
    const [a, b] = await Promise.all([
      subject.acquire(TENANT, 'run1', 'planner', create),
      subject.acquire(TENANT, 'run1', 'planner', create),
    ])
    expect(a).toBe(b)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('leaves no pending entry behind when creation fails', async () => {
    const subject = store()
    await expect(subject.acquire(TENANT, 'run1', 'planner', async () => {
      throw new Error('composition rejected')
    })).rejects.toThrow('composition rejected')
    expect(subject.size).toBe(0)
    const retried = await subject.acquire(TENANT, 'run1', 'planner', async () => fakeHandle('one'))
    expect(retried.agent.session.id).toBe('one')
  })

  it('evicts the least recently used session past the size bound', async () => {
    const subject = store({ maxSessions: 2 })
    const first = fakeHandle('first')
    await subject.acquire(TENANT, 'run1', 'a', async () => first)
    await subject.acquire(TENANT, 'run1', 'b', async () => fakeHandle('second'))
    await subject.acquire(TENANT, 'run1', 'c', async () => fakeHandle('third'))
    expect(subject.size).toBe(2)
    expect(first.disposed()).toBe(true)
  })

  it('counts a reuse as recent, so the untouched session is evicted instead', async () => {
    const subject = store({ maxSessions: 2 })
    const first = fakeHandle('first')
    const second = fakeHandle('second')
    await subject.acquire(TENANT, 'run1', 'a', async () => first)
    await subject.acquire(TENANT, 'run1', 'b', async () => second)
    await subject.acquire(TENANT, 'run1', 'a', async () => fakeHandle('unused'))
    await subject.acquire(TENANT, 'run1', 'c', async () => fakeHandle('third'))
    expect(first.disposed()).toBe(false)
    expect(second.disposed()).toBe(true)
  })
})

describe('release', () => {
  it('disposes every session of one run', async () => {
    const subject = store()
    const planner = fakeHandle('planner')
    const writer = fakeHandle('writer')
    await subject.acquire(TENANT, 'run1', 'planner', async () => planner)
    await subject.acquire(TENANT, 'run1', 'writer', async () => writer)
    expect(await subject.release(TENANT, 'run1')).toBe(2)
    expect(planner.disposed()).toBe(true)
    expect(writer.disposed()).toBe(true)
    expect(subject.size).toBe(0)
  })

  it('disposes one named node and leaves its siblings running', async () => {
    const subject = store()
    const planner = fakeHandle('planner')
    const writer = fakeHandle('writer')
    await subject.acquire(TENANT, 'run1', 'planner', async () => planner)
    await subject.acquire(TENANT, 'run1', 'writer', async () => writer)
    expect(await subject.release(TENANT, 'run1', 'planner')).toBe(1)
    expect(writer.disposed()).toBe(false)
  })

  it('never releases another tenant\'s run of the same name', async () => {
    const subject = store()
    const theirs = fakeHandle('theirs')
    await subject.acquire(OTHER, 'run1', 'planner', async () => theirs)
    expect(await subject.release(TENANT, 'run1')).toBe(0)
    expect(theirs.disposed()).toBe(false)
  })

  it('reports zero for an unknown run', async () => {
    expect(await store().release(TENANT, 'never-started')).toBe(0)
  })

  it('reports zero for a named node the run never started', async () => {
    const subject = store()
    await subject.acquire(TENANT, 'run1', 'planner', async () => fakeHandle('planner'))
    expect(await subject.release(TENANT, 'run1', 'writer')).toBe(0)
    expect(subject.size).toBe(1)
  })

  it('drops a session whose disposal fails rather than keeping a dead key', async () => {
    const subject = store()
    const handle = { agent: {}, dispose: async () => { throw new Error('stuck') } } as unknown as AgentHandle
    await subject.acquire(TENANT, 'run1', 'planner', async () => handle)
    expect(await subject.release(TENANT, 'run1')).toBe(1)
    expect(subject.size).toBe(0)
  })
})

describe('cancel', () => {
  it('cancels every node of a run without disposing the sessions', async () => {
    const subject = store()
    const planner = fakeHandle('planner')
    await subject.acquire(TENANT, 'run1', 'planner', async () => planner)
    expect(subject.cancel(TENANT, 'run1')).toBe(1)
    expect(planner.cancels()).toBe(1)
    expect(planner.disposed()).toBe(false)
    expect(subject.size).toBe(1)
  })

  it('cancels one named node only', async () => {
    const subject = store()
    const planner = fakeHandle('planner')
    const writer = fakeHandle('writer')
    await subject.acquire(TENANT, 'run1', 'planner', async () => planner)
    await subject.acquire(TENANT, 'run1', 'writer', async () => writer)
    expect(subject.cancel(TENANT, 'run1', 'writer')).toBe(1)
    expect(planner.cancels()).toBe(0)
  })

  it('reports zero for an unknown node', () => {
    expect(store().cancel(TENANT, 'run1', 'absent')).toBe(0)
  })
})

describe('sweep', () => {
  it('disposes a session idle past the ttl', async () => {
    let clock = 0
    const subject = store({ idleTtlMs: 100 }, () => clock)
    const handle = fakeHandle('one')
    await subject.acquire(TENANT, 'run1', 'planner', async () => handle)
    clock = 500
    expect(await subject.sweep()).toBe(1)
    expect(handle.disposed()).toBe(true)
  })

  it('keeps a session still inside the ttl', async () => {
    let clock = 0
    const subject = store({ idleTtlMs: 1000 }, () => clock)
    await subject.acquire(TENANT, 'run1', 'planner', async () => fakeHandle('one'))
    clock = 100
    expect(await subject.sweep()).toBe(0)
    expect(subject.size).toBe(1)
  })

  it('measures idleness from the last acquire, not from creation', async () => {
    let clock = 0
    const subject = store({ idleTtlMs: 100 }, () => clock)
    await subject.acquire(TENANT, 'run1', 'planner', async () => fakeHandle('one'))
    clock = 90
    await subject.acquire(TENANT, 'run1', 'planner', async () => fakeHandle('unused'))
    clock = 150
    expect(await subject.sweep()).toBe(0)
  })
})

describe('disposeAll', () => {
  it('releases every live session', async () => {
    const subject = store()
    const a = fakeHandle('a')
    const b = fakeHandle('b')
    await subject.acquire(TENANT, 'run1', 'a', async () => a)
    await subject.acquire(OTHER, 'run2', 'b', async () => b)
    await subject.disposeAll()
    expect(subject.size).toBe(0)
    expect(a.disposed()).toBe(true)
    expect(b.disposed()).toBe(true)
  })
})
