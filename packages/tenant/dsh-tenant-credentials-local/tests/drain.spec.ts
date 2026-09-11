/**
 * Ported from `@deepseek-ai/dsh-credentials-local`'s drain.spec: the atomic
 * write is the gated hold point inside a queued write, so gating it makes the
 * dispose-versus-queued-write race deterministic. Here it also proves the
 * drain disposer closes every per-tenant store, not just the shared one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { TenantContextService } from '@mindportalix/dsh-tenant-context'
import { TenantLocalCredentialProvider } from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  let gate: Promise<void> = Promise.resolve()
  return {
    ...actual,
    writeFileAtomic: vi.fn(() => gate),
    __setGate: (next: Promise<void>) => { gate = next },
  }
})

async function setGate(next: Promise<void>): Promise<void> {
  const mocked = await import('@deepseek-ai/dsh-atomic-write') as unknown as { __setGate: (next: Promise<void>) => void }
  mocked.__setGate(next)
}

const TENANT_A = 'a'.repeat(32)
const KEY = credentialRef('DEEPSEEK_API_KEY')
const OTHER = credentialRef('OPENAI_API_KEY')
const RECORD = credentialKey('llm-drain', 'alpha')
const OTHER_RECORD = credentialKey('llm-drain', 'beta')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await setGate(Promise.resolve())
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function bootProvider(): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tenant-cred-drain-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(TenantContextService)
  const fiber = ctx.plugin(TenantLocalCredentialProvider, { dshHome: dir, watch: false })
  await fiber
  return { ctx, fiber }
}

describe('write-drain teardown', () => {
  it('lets the in-flight tenant write land and fails the queued one after disposal', async () => {
    const { ctx, fiber } = await bootProvider()
    const service = ctx.credentials
    const run = <T>(fn: () => Promise<T>): Promise<T> => ctx.tenantContext.run(TENANT_A, fn)

    let release!: () => void
    await setGate(new Promise<void>((resolveGate) => { release = resolveGate }))
    const first = run(() => service.set(KEY, 'one'))
    await new Promise(resolvePause => setTimeout(resolvePause, 10))
    const secondRejects = expect(run(() => service.set(OTHER, 'two'))).rejects.toThrow(/closed before the queued/)
    const disposal = fiber.dispose()
    await new Promise(resolvePause => setTimeout(resolvePause, 10))
    release()
    await disposal

    await expect(first).resolves.toBeUndefined()
    await secondRejects
  })

  it('fails a queued record write and delete after disposal on the same terms', async () => {
    const { ctx, fiber } = await bootProvider()
    const service = ctx.credentials
    const run = <T>(fn: () => Promise<T>): Promise<T> => ctx.tenantContext.run(TENANT_A, fn)

    let release!: () => void
    await setGate(new Promise<void>((resolveGate) => { release = resolveGate }))
    const first = run(() => service.modifyRecord(RECORD, () => Promise.resolve({ kind: 'grant', payload: { v: 1 } })))
    await new Promise(resolvePause => setTimeout(resolvePause, 10))
    const queuedModify = expect(run(() => service.modifyRecord(OTHER_RECORD, () => Promise.resolve({ kind: 'api-key' }))))
      .rejects.toThrow(/closed before the queued/)
    const queuedDelete = expect(run(() => service.deleteRecord(OTHER_RECORD))).rejects.toThrow(/closed before the queued/)
    const disposal = fiber.dispose()
    await new Promise(resolvePause => setTimeout(resolvePause, 10))
    release()
    await disposal

    await expect(first).resolves.toEqual({ kind: 'grant', payload: { v: 1 } })
    await queuedModify
    await queuedDelete
  })
})
