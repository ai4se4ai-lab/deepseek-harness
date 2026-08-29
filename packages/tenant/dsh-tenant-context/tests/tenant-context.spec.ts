/**
 * TenantContextService tests: header resolution (accept/reject) and the async
 * propagation guarantee the rest of the tenant-isolation design depends on —
 * that the AsyncLocalStorage-bound tenant id survives `await` chains and
 * async-generator resumption, and stays isolated between concurrently running
 * tenants (the real WebSocket downlink shape: one long-lived async generator
 * per connection, interleaved with other connections on the same process).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TENANT_HEADER_NAME, TenantContextService, TenantRequiredError } from '../src/index.ts'

async function setup(): Promise<TenantContextService> {
  const ctx = new Context()
  await ctx.plugin(TenantContextService)
  return ctx.tenantContext
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('resolveTenant', () => {
  it('accepts a well-formed 32-character lowercase hex header', async () => {
    const service = await setup()
    const tenantId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'.slice(0, 32)
    expect(service.resolveTenant({ [TENANT_HEADER_NAME]: tenantId })).toBe(tenantId)
  })

  it('resolves undefined when the header is absent', async () => {
    const service = await setup()
    expect(service.resolveTenant({})).toBeUndefined()
    expect(service.resolveTenant({ 'x-other-header': 'value' })).toBeUndefined()
  })

  it.each([
    ['too short', 'a'.repeat(31)],
    ['too long', 'a'.repeat(33)],
    ['uppercase hex', 'A'.repeat(32)],
    ['non-hex characters', 'z'.repeat(32)],
    ['empty string', ''],
    ['whitespace padded', ` ${'a'.repeat(32)}`],
  ])('resolves undefined for a malformed header value (%s)', async (_label, value) => {
    const service = await setup()
    expect(service.resolveTenant({ [TENANT_HEADER_NAME]: value })).toBeUndefined()
  })

  it('resolves undefined for an explicitly undefined header entry', async () => {
    const service = await setup()
    expect(service.resolveTenant({ [TENANT_HEADER_NAME]: undefined })).toBeUndefined()
  })

  it('reads the first entry of a duplicated header, still validated', async () => {
    const service = await setup()
    const tenantId = 'b'.repeat(32)
    expect(service.resolveTenant({ [TENANT_HEADER_NAME]: [tenantId, 'c'.repeat(32)] })).toBe(tenantId)
    expect(service.resolveTenant({ [TENANT_HEADER_NAME]: ['not-a-tenant-id', tenantId] })).toBeUndefined()
  })

  it('never throws on hostile input', async () => {
    const service = await setup()
    expect(() => service.resolveTenant({ [TENANT_HEADER_NAME]: [] })).not.toThrow()
    expect(service.resolveTenant({ [TENANT_HEADER_NAME]: [] })).toBeUndefined()
  })
})

describe('current / requireCurrent', () => {
  it('current() is undefined outside any run()', async () => {
    const service = await setup()
    expect(service.current()).toBeUndefined()
  })

  it('requireCurrent() throws TenantRequiredError outside any run()', async () => {
    const service = await setup()
    expect(() => service.requireCurrent()).toThrow(TenantRequiredError)
  })

  it('requireCurrent() returns the bound tenant id inside run()', async () => {
    const service = await setup()
    const tenantId = 'd'.repeat(32)
    service.run(tenantId, () => {
      expect(service.requireCurrent()).toBe(tenantId)
    })
  })

  it('run(undefined, ...) fails requireCurrent() inside its callback (no silent default)', async () => {
    const service = await setup()
    service.run(undefined, () => {
      expect(service.current()).toBeUndefined()
      expect(() => service.requireCurrent()).toThrow(TenantRequiredError)
    })
  })
})

describe('async propagation (the WebSocket long-lived-generator shape)', () => {
  it('survives an await chain inside run()', async () => {
    const service = await setup()
    const tenantId = 'e'.repeat(32)
    await service.run(tenantId, async () => {
      expect(service.current()).toBe(tenantId)
      await delay(5)
      expect(service.current()).toBe(tenantId)
      await Promise.resolve()
      expect(service.current()).toBe(tenantId)
    })
  })

  it('survives suspension and resumption across an async-generator boundary', async () => {
    const service = await setup()
    const tenantId = 'f'.repeat(32)

    async function* iterate(): AsyncGenerator<string | undefined> {
      yield service.current()
      await delay(5)
      yield service.current()
      await Promise.resolve()
      yield service.current()
    }

    const seen: (string | undefined)[] = []
    await service.run(tenantId, async () => {
      for await (const value of iterate()) seen.push(value)
    })
    expect(seen).toEqual([tenantId, tenantId, tenantId])
  })

  it('keeps two concurrently running tenants isolated through interleaved async-generator resumption', async () => {
    // A non-tautological proof: two tenants run concurrently, each driving its
    // own long-lived async generator (the events.mux/events.host shape) with
    // DIFFERENT delay timings so their resumptions interleave on the event
    // loop. A shared mutable variable (instead of AsyncLocalStorage) would
    // leak one tenant's id into the other's generator body at some resumption
    // point; this test fails if that happens.
    const service = await setup()

    async function* iterate(delays: readonly number[]): AsyncGenerator<string | undefined> {
      for (const ms of delays) {
        await delay(ms)
        yield service.current()
      }
    }

    async function drive(tenantId: string, delays: readonly number[]): Promise<(string | undefined)[]> {
      const seen: (string | undefined)[] = []
      await service.run(tenantId, async () => {
        for await (const value of iterate(delays)) seen.push(value)
      })
      return seen
    }

    const tenantA = 'a'.repeat(32)
    const tenantB = 'b'.repeat(32)
    const [seenA, seenB] = await Promise.all([
      drive(tenantA, [3, 1, 5, 2]),
      drive(tenantB, [1, 4, 2, 3]),
    ])

    expect(seenA).toEqual([tenantA, tenantA, tenantA, tenantA])
    expect(seenB).toEqual([tenantB, tenantB, tenantB, tenantB])
    // Outside both run() calls, no tenant leaks into the ambient context.
    expect(service.current()).toBeUndefined()
  })
})
