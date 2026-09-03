/**
 * Shared no-tenant fallback store: the one store that watches. chokidar is the
 * nondeterministic OS boundary, faked here so the event pipeline (error
 * events, races with an unreadable or deleted file, invariant rethrow) is
 * driven deterministically. Also covers the small branches the provider spec
 * does not reach: an empty environment value, an unset of an absent key, and
 * the pre-release flat-layout migration at boot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialKey, credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { TenantContextService } from '@mindportalix/dsh-tenant-context'
import { CREDENTIALS_FILENAME, TenantLocalCredentialProvider } from '../src/index.ts'

const fsHarness = vi.hoisted(() => ({ nextReadError: undefined as NodeJS.ErrnoException | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (async (path: unknown, ...rest: never[]) => {
      const error = fsHarness.nextReadError
      if (error !== undefined) {
        fsHarness.nextReadError = undefined
        throw error
      }
      return (actual.readFile as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.readFile,
  }
})

vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWatcher extends EventEmitter {
    close = vi.fn(() => Promise.resolve())
  }
  const instances: Array<{ path: string; options: unknown; watcher: InstanceType<typeof FakeWatcher> }> = []
  return {
    watch: vi.fn((path: string, options: unknown) => {
      const watcher = new FakeWatcher()
      instances.push({ path, options, watcher })
      return watcher
    }),
    __instances: instances,
  }
})

interface FakeChokidar {
  __instances: Array<{
    path: string
    options: { awaitWriteFinish: { stabilityThreshold: number; pollInterval: number } }
    watcher: import('node:events').EventEmitter
  }>
}

async function fakeInstances(): Promise<FakeChokidar['__instances']> {
  return (await import('chokidar') as unknown as FakeChokidar).__instances
}

const KEY = credentialRef('DEEPSEEK_API_KEY')
const OTHER = credentialRef('OPENAI_API_KEY')
const RECORD = credentialKey('llm-pi-ai', 'openai-codex')

let dshHome: string
let sharedFile: string
const cleanups: Array<() => Promise<void> | void> = []

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-tenant-cred-watch-'))
  sharedFile = join(dshHome, CREDENTIALS_FILENAME)
})

afterEach(async () => {
  fsHarness.nextReadError = undefined
  while (cleanups.length > 0) await cleanups.pop()!()
  rmSync(dshHome, { recursive: true, force: true })
  ;(await fakeInstances()).length = 0
})

async function seed(text: string): Promise<void> {
  await writeFile(sharedFile, text, { mode: 0o600 })
}

async function boot(env?: Parameters<typeof createLaunchEnvironmentSnapshot>[0]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TenantContextService)
  if (env !== undefined) ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot(env))
  const fiber = ctx.plugin(TenantLocalCredentialProvider, { dshHome, debounceMs: 5 })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('shared-store watcher', () => {
  it('clamps the write-settle poll interval for a zero debounce', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantContextService)
    const fiber = ctx.plugin(TenantLocalCredentialProvider, { dshHome, debounceMs: 0 })
    cleanups.push(async () => { await fiber.dispose() })
    await fiber
    const [instance] = await fakeInstances()
    expect(instance!.options.awaitWriteFinish).toEqual({ stabilityThreshold: 0, pollInterval: 1 })
  })

  it('publishes an external edit and reconciles once at ready', async () => {
    const ctx = await boot()
    const seen: CredentialRef[] = []
    ctx.on('credentials/reference-updated', (ref) => { seen.push(ref) })
    const [instance] = await fakeInstances()

    await seed('version: 1\nrefs:\n  DEEPSEEK_API_KEY: arrived\n')
    instance!.watcher.emit('ready')
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'arrived', source: 'file' })
    })
    expect(seen).toEqual([KEY])

    // A second identical event is a content no-op.
    instance!.watcher.emit('all', 'change', sharedFile)
    await new Promise(r => setTimeout(r, 20))
    expect(seen).toEqual([KEY])
  })

  it('surfaces a non-ENOENT read failure during the boot load', async () => {
    const ctx = new Context()
    await ctx.plugin(TenantContextService)
    fsHarness.nextReadError = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    await expect(ctx.plugin(TenantLocalCredentialProvider, { dshHome, debounceMs: 5 })).rejects.toThrow(/EACCES/)
  })

  it('publishes only the entries that actually changed on a partial external edit', async () => {
    await seed([
      'version: 1',
      'refs:',
      '  DEEPSEEK_API_KEY: keep',
      '  OPENAI_API_KEY: change-me',
      'records:',
      '  llm-pi-ai/openai-codex:',
      '    kind: api-key',
      '    key: rec-keep',
      '  llm-pi-ai/other:',
      '    kind: api-key',
      '    key: rec-change',
      '',
    ].join('\n'))
    const ctx = await boot()
    const refs: string[] = []
    const records: string[] = []
    ctx.on('credentials/reference-updated', (r) => { refs.push(r) })
    ctx.on('credentials/record-updated', (k) => { records.push(k) })
    const [instance] = await fakeInstances()

    await seed([
      'version: 1',
      'refs:',
      '  DEEPSEEK_API_KEY: keep',
      '  OPENAI_API_KEY: changed',
      'records:',
      '  llm-pi-ai/openai-codex:',
      '    kind: api-key',
      '    key: rec-keep',
      '  llm-pi-ai/other:',
      '    kind: api-key',
      '    key: rec-changed',
      '',
    ].join('\n'))
    instance!.watcher.emit('all', 'change', sharedFile)
    await vi.waitFor(() => {
      expect(refs).toEqual([OTHER])
      expect(records).toEqual([credentialKey('llm-pi-ai', 'other')])
    })
  })

  it('survives a watcher error and keeps publishing later edits', async () => {
    const ctx = await boot()
    const [instance] = await fakeInstances()
    instance!.watcher.emit('error', new Error('watch backend failure'))
    expect(await ctx.credentials.resolve(KEY)).toBeUndefined()

    await seed('version: 1\nrefs:\n  DEEPSEEK_API_KEY: later\n')
    instance!.watcher.emit('all', 'change', sharedFile)
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'later', source: 'file' })
    })
  })

  it('keeps the last good snapshot when the file turns unreadable at runtime', async () => {
    await seed('version: 1\nrefs:\n  DEEPSEEK_API_KEY: good\n')
    const ctx = await boot()
    const [instance] = await fakeInstances()

    fsHarness.nextReadError = Object.assign(new Error('EIO'), { code: 'EIO' })
    instance!.watcher.emit('all', 'change', sharedFile)
    await new Promise(r => setTimeout(r, 20))
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'good', source: 'file' })
  })

  it('publishes reference and record deletions when the file disappears', async () => {
    await seed('version: 1\nrefs:\n  DEEPSEEK_API_KEY: gone\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: api-key\n    key: k\n')
    const ctx = await boot()
    const refs: CredentialRef[] = []
    const records: string[] = []
    ctx.on('credentials/reference-updated', (r) => { refs.push(r) })
    ctx.on('credentials/record-updated', (k) => { records.push(k) })
    const [instance] = await fakeInstances()

    await rm(sharedFile)
    instance!.watcher.emit('all', 'unlink', sharedFile)
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(KEY)).toBeUndefined()
    })
    expect(refs).toEqual([KEY])
    expect(records).toEqual([RECORD])
  })

  it('surfaces an INVARIANT failure escaping the update fan-out without ending the queue', async () => {
    const ctx = await boot()
    ctx.on('credentials/reference-updated', () => {
      throw Object.assign(new Error('invariant'), { code: 'INVARIANT' })
    })
    const [instance] = await fakeInstances()
    await seed('version: 1\nrefs:\n  DEEPSEEK_API_KEY: boom\n')
    instance!.watcher.emit('all', 'change', sharedFile)
    // The commit still lands; the invariant rethrow is logged by queueRefresh's catch.
    await vi.waitFor(async () => {
      expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'boom', source: 'file' })
    })
  })

  it('closes the watcher on disposal', async () => {
    await boot()
    const [instance] = await fakeInstances()
    const closeSpy = (instance!.watcher as unknown as { close: ReturnType<typeof vi.fn> }).close
    await cleanups.pop()!()
    expect(closeSpy).toHaveBeenCalled()
  })

  it('quiesces the refresh pipeline before dispose completes and ignores later events', async () => {
    await seed('version: 1\nrefs:\n  DEEPSEEK_API_KEY: initial\n')
    const ctx = new Context()
    await ctx.plugin(TenantContextService)
    const fiber = ctx.plugin(TenantLocalCredentialProvider, { dshHome, debounceMs: 5 })
    await fiber
    let disposed = false
    let postDisposeCommits = 0
    ctx.on('credentials/reference-updated', () => { if (disposed) postDisposeCommits += 1 })

    await seed('version: 1\nrefs:\n  DEEPSEEK_API_KEY: changed\n')
    const [instance] = await fakeInstances()
    // Two queued refreshes: dispose interrupts one mid-flight and the other
    // before it starts, so both closed guards hold; the emits after dispose
    // hit the watch handlers' own closed guards.
    instance!.watcher.emit('all', 'change', sharedFile)
    instance!.watcher.emit('all', 'change', sharedFile)
    await fiber.dispose()
    disposed = true
    instance!.watcher.emit('all', 'change', sharedFile)
    instance!.watcher.emit('ready')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(postDisposeCommits).toBe(0)
  })
})

describe('boot-time flat-layout migration', () => {
  it('upgrades a recognized pre-release flat document in place', async () => {
    await seed('DEEPSEEK_API_KEY: legacy\n')
    const ctx = await boot()
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'legacy', source: 'file' })
    const migrated = await (await import('node:fs/promises')).readFile(sharedFile, 'utf8')
    expect(migrated).toContain('version: 1')
    expect(migrated).toContain('refs:')
    expect(migrated).toContain('legacy')
  })
})

describe('layer edge cases', () => {
  it('treats an empty environment value as unset', async () => {
    const ctx = await boot([{ source: 'process', values: { DEEPSEEK_API_KEY: '' } }])
    await ctx.credentials.set(KEY, 'real')
    expect(await ctx.credentials.resolve(KEY)).toEqual({ value: 'real', source: 'file' })
  })

  it('treats an empty .env value as no fallback', async () => {
    const ctx = await boot([{ source: 'user-env', path: join(dshHome, '.env'), values: { OPENAI_API_KEY: '' } }])
    expect(await ctx.credentials.resolve(OTHER)).toBeUndefined()
  })

  it('unset of an absent reference is a no-op that writes nothing', async () => {
    const ctx = await boot()
    await expect(ctx.credentials.unset(KEY)).resolves.toBeUndefined()
    await expect((await import('node:fs/promises')).readFile(sharedFile, 'utf8')).rejects.toThrow()
  })
})
