/**
 * TenantLocalCredentialProvider tests. A real TenantContextService drives
 * tenant binding (matching production ALS propagation); each store's file
 * layer is exercised against a temp `$DSH_HOME` with two distinct tenant ids
 * to prove one tenant never reads or writes another's document, plus the
 * no-tenant fallback to the shared `$DSH_HOME/.credentials.yaml`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  credentialKey,
  credentialRef,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRef,
} from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { TenantContextService } from '@mindportalix/dsh-tenant-context'
import { CREDENTIALS_FILENAME, resolveSpec, TenantLocalCredentialProvider } from '../src/index.ts'

const TENANT_A = 'a'.repeat(32)
const TENANT_B = 'b'.repeat(32)
const KEY = credentialRef('DEEPSEEK_API_KEY')
const OTHER = credentialRef('OPENAI_API_KEY')
const RECORD = credentialKey('llm-pi-ai', 'openai-codex')

let dshHome: string
const cleanups: Array<() => Promise<void> | void> = []

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-tenant-cred-'))
})

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  rmSync(dshHome, { recursive: true, force: true })
})

interface BootOptions {
  /** Layers for the shared launch-environment snapshot; omit for none. */
  env?: Parameters<typeof createLaunchEnvironmentSnapshot>[0]
  watch?: boolean
}

async function boot(options: BootOptions = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TenantContextService)
  if (options.env !== undefined) {
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot(options.env))
  }
  const fiber = ctx.plugin(TenantLocalCredentialProvider, { dshHome, watch: options.watch ?? false })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

function tenantFile(tenantId: string): string {
  return join(dshHome, 'tenants', tenantId, CREDENTIALS_FILENAME)
}

async function seed(file: string, text: string): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
  await writeFile(file, text, { mode: 0o600 })
}

function refUpdates(ctx: Context): CredentialRef[] {
  const seen: CredentialRef[] = []
  ctx.on('credentials/reference-updated', (ref) => { seen.push(ref) })
  return seen
}

function recordUpdates(ctx: Context): CredentialKey[] {
  const seen: CredentialKey[] = []
  ctx.on('credentials/record-updated', (key) => { seen.push(key) })
  return seen
}

describe('resolveSpec', () => {
  it('defaults the shared document to .credentials.yaml under the resolved home, watching on', () => {
    const spec = resolveSpec({ dshHome: '/custom/home' })
    expect(spec).toEqual({
      home: resolve('/custom/home'),
      sharedFilename: resolve('/custom/home/.credentials.yaml'),
      watch: true,
      debounceMs: 100,
    })
  })

  it('lets an explicit sharedPath and watch flags win', () => {
    const spec = resolveSpec({ dshHome: '/home', sharedPath: '/etc/dsh/shared.yaml', watch: false, debounceMs: 5 })
    expect(spec.sharedFilename).toBe('/etc/dsh/shared.yaml')
    expect(spec.watch).toBe(false)
    expect(spec.debounceMs).toBe(5)
  })
})

describe('tenant routing', () => {
  it('resolves and stores each tenant against its own $DSH_HOME/tenants/<id>/.credentials.yaml', async () => {
    const ctx = await boot()

    await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.set(KEY, 'key-a'))
    await ctx.tenantContext.run(TENANT_B, () => ctx.credentials.set(KEY, 'key-b'))

    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.resolve(KEY)))
      .toEqual({ value: 'key-a', source: 'file' })
    expect(await ctx.tenantContext.run(TENANT_B, () => ctx.credentials.resolve(KEY)))
      .toEqual({ value: 'key-b', source: 'file' })

    expect(await readFile(tenantFile(TENANT_A), 'utf8')).toContain('key-a')
    expect(await readFile(tenantFile(TENANT_A), 'utf8')).not.toContain('key-b')
    expect(await readFile(tenantFile(TENANT_B), 'utf8')).toContain('key-b')
  })

  it('one tenant cannot see another tenant\'s stored key', async () => {
    const ctx = await boot()
    await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.set(KEY, 'only-a'))
    expect(await ctx.tenantContext.run(TENANT_B, () => ctx.credentials.resolve(KEY))).toBeUndefined()
    expect(await ctx.tenantContext.run(TENANT_B, () => ctx.credentials.describe(KEY)))
      .toEqual({ configured: false, writable: true })
  })

  it('reuses one store per tenant id across calls', async () => {
    const ctx = await boot()
    await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.set(KEY, 'first'))
    await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.set(OTHER, 'second'))
    const doc = await readFile(tenantFile(TENANT_A), 'utf8')
    expect(doc).toContain('first')
    expect(doc).toContain('second')
  })

  it('picks up a pre-existing tenant document on first use', async () => {
    await seed(tenantFile(TENANT_A), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: preexisting\n')
    const ctx = await boot()
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.resolve(KEY)))
      .toEqual({ value: 'preexisting', source: 'file' })
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.describe(KEY)))
      .toEqual({ configured: true, source: 'file', writable: true })
  })

  it('fans committed reference and record changes out on the shared ctx', async () => {
    const ctx = await boot()
    const refs = refUpdates(ctx)
    const records = recordUpdates(ctx)
    await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.set(KEY, 'v'))
    await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.unset(KEY))
    await ctx.tenantContext.run(TENANT_A, () =>
      ctx.credentials.modifyRecord(RECORD, () => Promise.resolve<CredentialRecord>({ kind: 'api-key', key: 'k' })))
    expect(refs).toEqual([KEY, KEY])
    expect(records).toEqual([RECORD])
  })
})

describe('shared layers', () => {
  it('the inherited environment wins over a tenant document and reads as read-only', async () => {
    const ctx = await boot({ env: [{ source: 'process', values: { DEEPSEEK_API_KEY: 'from-env' } }] })
    await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.set(OTHER, 'x')) // unrelated write still fine
    await seed(tenantFile(TENANT_A), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: from-file\n')

    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.resolve(KEY)))
      .toEqual({ value: 'from-env', source: 'env' })
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.describe(KEY)))
      .toEqual({ configured: true, source: 'env', writable: false })
  })

  it('rejects set/unset for an environment-shadowed reference', async () => {
    const ctx = await boot({ env: [{ source: 'process', values: { DEEPSEEK_API_KEY: 'from-env' } }] })
    await expect(ctx.tenantContext.run(TENANT_A, () => ctx.credentials.set(KEY, 'x')))
      .rejects.toThrow(/supplied read-only by the launching environment/)
    await expect(ctx.tenantContext.run(TENANT_A, () => ctx.credentials.unset(KEY)))
      .rejects.toThrow(/supplied read-only by the launching environment/)
  })

  it('falls back to the shared .env layers below the tenant document', async () => {
    const ctx = await boot({
      env: [
        { source: 'user-env', path: join(dshHome, '.env'), values: { OPENAI_API_KEY: 'home-env' } },
        { source: 'project-env', path: '/cwd/.env', values: { OPENAI_API_KEY: 'cwd-env' } },
      ],
    })
    // No tenant document entry for OTHER yet: the project .env wins over the user .env.
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.resolve(OTHER)))
      .toEqual({ value: 'cwd-env', source: 'project-env' })
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.describe(OTHER)))
      .toEqual({ configured: true, source: 'project-env', writable: true })

    // A stored tenant key outranks both .env layers.
    await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.set(OTHER, 'stored'))
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.resolve(OTHER)))
      .toEqual({ value: 'stored', source: 'file' })
  })

  it('reports an unconfigured reference', async () => {
    const ctx = await boot()
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.resolve(KEY))).toBeUndefined()
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.describe(KEY)))
      .toEqual({ configured: false, writable: true })
  })

  it('rejects an empty value outright', async () => {
    const ctx = await boot()
    await expect(ctx.tenantContext.run(TENANT_A, () => ctx.credentials.set(KEY, '')))
      .rejects.toThrow(/empty value cannot be stored/)
  })
})

describe('no tenant bound', () => {
  it('resolves and writes the shared $DSH_HOME/.credentials.yaml', async () => {
    const ctx = await boot()
    await ctx.credentials.set(KEY, 'shared-key')
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'shared-key', source: 'file' })
    expect(await readFile(join(dshHome, CREDENTIALS_FILENAME), 'utf8')).toContain('shared-key')
    // A bound tenant does not see the shared value.
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.resolve(KEY))).toBeUndefined()
  })

  it('surfaces a non-ENOENT stat failure while asserting the document mode', async () => {
    await writeFile(join(dshHome, 'not-a-dir'), 'x', { mode: 0o600 })
    const ctx = new Context()
    await ctx.plugin(TenantContextService)
    await expect(ctx.plugin(TenantLocalCredentialProvider, {
      dshHome,
      sharedPath: join(dshHome, 'not-a-dir', CREDENTIALS_FILENAME),
      watch: false,
    })).rejects.toThrow(/ENOTDIR/)
  })

  it('fails loud at boot on a group-readable shared document', async () => {
    await writeFile(join(dshHome, CREDENTIALS_FILENAME), 'version: 1\nrefs: {}\n', { mode: 0o600 })
    await chmod(join(dshHome, CREDENTIALS_FILENAME), 0o644)
    const ctx = new Context()
    await ctx.plugin(TenantContextService)
    await expect(ctx.plugin(TenantLocalCredentialProvider, { dshHome, watch: false }))
      .rejects.toThrow(/readable beyond its owner/)
  })
})

describe('records', () => {
  it('stores, reads, describes, lists, and deletes a record per tenant', async () => {
    const ctx = await boot()
    await ctx.tenantContext.run(TENANT_A, () =>
      ctx.credentials.modifyRecord(RECORD, () => Promise.resolve<CredentialRecord>({
        kind: 'grant', payload: { token: 'abc' },
      })))

    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.readRecord(RECORD)))
      .toEqual({ kind: 'grant', payload: { token: 'abc' } })
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.describeRecord(RECORD)))
      .toEqual({ configured: true, kind: 'grant', writable: true })
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.listRecords()))
      .toEqual([{ key: RECORD, kind: 'grant' }])

    // Invisible to another tenant.
    expect(await ctx.tenantContext.run(TENANT_B, () => ctx.credentials.readRecord(RECORD))).toBeUndefined()
    expect(await ctx.tenantContext.run(TENANT_B, () => ctx.credentials.listRecords())).toEqual([])

    await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.deleteRecord(RECORD))
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.describeRecord(RECORD)))
      .toEqual({ configured: false, writable: true })
  })

  it('leaves the record untouched when the mutation returns undefined', async () => {
    const ctx = await boot()
    const result = await ctx.tenantContext.run(TENANT_A, () =>
      ctx.credentials.modifyRecord(RECORD, () => Promise.resolve(undefined)))
    expect(result).toBeUndefined()
    expect(await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.listRecords())).toEqual([])
  })

  it('rejects a grant payload that cannot round-trip through JSON', async () => {
    const ctx = await boot()
    await expect(ctx.tenantContext.run(TENANT_A, () =>
      ctx.credentials.modifyRecord(RECORD, () => Promise.resolve<CredentialRecord>({
        kind: 'grant', payload: Number.POSITIVE_INFINITY,
      })))).rejects.toThrow(/non-finite number/)
  })

  it('rejects an api-key record with an empty key', async () => {
    const ctx = await boot()
    await expect(ctx.tenantContext.run(TENANT_A, () =>
      ctx.credentials.modifyRecord(RECORD, () => Promise.resolve<CredentialRecord>({ kind: 'api-key', key: '' }))))
      .rejects.toThrow(/empty key/)
  })

  it('deleting an absent record is a no-op', async () => {
    const ctx = await boot()
    await expect(ctx.tenantContext.run(TENANT_A, () => ctx.credentials.deleteRecord(RECORD))).resolves.toBeUndefined()
  })
})

describe('disposal', () => {
  it('rejects a write after the provider is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantContextService)
    const fiber = ctx.plugin(TenantLocalCredentialProvider, { dshHome, watch: false })
    await fiber
    await ctx.tenantContext.run(TENANT_A, () => ctx.credentials.set(KEY, 'v'))
    const provider = ctx.credentials
    await fiber.dispose()
    await expect(ctx.tenantContext.run(TENANT_A, () => provider.set(KEY, 'again')))
      .rejects.toThrow(/closed/)
    await expect(ctx.tenantContext.run(TENANT_A, () => provider.unset(KEY)))
      .rejects.toThrow(/closed/)
    await expect(ctx.tenantContext.run(TENANT_A, () =>
      provider.modifyRecord(RECORD, () => Promise.resolve<CredentialRecord>({ kind: 'api-key', key: 'k' }))))
      .rejects.toThrow(/closed/)
    await expect(ctx.tenantContext.run(TENANT_A, () => provider.deleteRecord(RECORD)))
      .rejects.toThrow(/closed/)
  })
})
