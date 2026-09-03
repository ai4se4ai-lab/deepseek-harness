/**
 * Tenant-scoped `ctx.credentials` provider for the single shared DeepSeek
 * Harness container behind the MindPortalix reverse proxy. Every reference and
 * record resolves and persists against the caller's own
 * `$DSH_HOME/tenants/<tenantId>/.credentials.yaml` — read per call from
 * `ctx.tenantContext` (async-local) — so two tenants sharing one container can
 * never read or write each other's keys through the credential seam. The
 * inherited process environment and the launcher's `.env` files stay a single
 * shared layer, exactly as in `@deepseek-ai/dsh-credentials-local`: a
 * deployment that sets `DEEPSEEK_API_KEY` in the environment still shares that
 * one key, which is why the MindPortalix deployment leaves it unset and lets
 * each user store their own.
 *
 * With no tenant identity bound (a bare `dsh` CLI run, a config-driven agent
 * boot), the provider falls back to the shared `$DSH_HOME/.credentials.yaml`
 * with its watcher — the unchanged single-store behavior — so the harness
 * checkout's own local and e2e use is unaffected.
 *
 * Narrow, auditable diff against upstream: the file layer's read-modify-write
 * discipline, comment-preserving edits, cross-process lock, and pre-release
 * flat-layout migration are the same (see `./local-store.ts`, which reuses
 * `@deepseek-ai/dsh-credentials-local`'s parser and migration verbatim); only
 * the file *location* becomes per-tenant, and tenant stores skip the watcher
 * because one process is the only writer of each tenant's document.
 * @module @mindportalix/dsh-tenant-credentials-local
 */

import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { LaunchEnvironmentEntry } from '@deepseek-ai/dsh-launch-environment'
import { CREDENTIALS_FILENAME } from '@deepseek-ai/dsh-credentials-local'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
// Type-only: brings the `ctx.tenantContext` augmentation into scope. The row is
// mounted before this one by deploy/tenant-isolation.cordis.patch.yml, and
// `static inject` makes a composition without it fail loud at boot.
import type {} from '@mindportalix/dsh-tenant-context'
import { LocalCredentialStore, type LocalCredentialStoreHooks } from './local-store.ts'

export { CREDENTIALS_FILENAME } from '@deepseek-ai/dsh-credentials-local'

/** Plugin config: harness home override, shared fallback location, and its watcher. */
export interface Config {
  /** Harness home whose `tenants/<id>/` subtree holds each tenant's document; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** The no-tenant fallback document; defaults to `.credentials.yaml` directly under the harness home. */
  sharedPath?: string
  /** Watch the shared fallback document and hot-publish external edits; defaults to true. Tenant stores never watch. */
  watch?: boolean
  /** Shared-store watcher write-settle window in milliseconds; defaults to 100. */
  debounceMs?: number
}

/** Fully resolved runtime parameters; defaulting happens here, never inline. */
export interface ResolvedSpec {
  /** Absolute harness home. */
  home: string
  /** Absolute path of the no-tenant fallback document. */
  sharedFilename: string
  /** Whether the shared fallback store watches. */
  watch: boolean
  /** Shared-store watcher write-settle window. */
  debounceMs: number
}

/**
 * Resolve the runtime spec from plugin config.
 * @param config - raw plugin config.
 * @returns the resolved home, shared document location, and watch behavior.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  const home = resolveDshHome(config.dshHome)
  return {
    home,
    sharedFilename: config.sharedPath ?? join(home, CREDENTIALS_FILENAME),
    watch: config.watch ?? true,
    debounceMs: config.debounceMs ?? 100,
  }
}

/**
 * The per-tenant file-backed credential provider. Registers as `ctx.credentials`,
 * replacing `@deepseek-ai/dsh-credentials-local` (the tenant-isolation patch
 * layer disables the base `credentials` row and inserts this one). The Cordis
 * service key comes from {@link CredentialProvider}'s constructor, so no other
 * row changes.
 */
export class TenantLocalCredentialProvider extends CredentialProvider {
  /** A composition mounting this without the tenant-identity service fails loud at boot, not at first resolve(). */
  static inject = ['tenantContext']

  static Config: z<Config> = z.object({
    dshHome: z.string(),
    sharedPath: z.string(),
    watch: z.boolean().default(true),
    debounceMs: z.number().min(0).default(100),
  })

  private readonly spec: ResolvedSpec
  private readonly hooks: LocalCredentialStoreHooks
  /** One store per bound tenant id, created and booted on first use. */
  private readonly stores = new Map<string, LocalCredentialStore>()
  /** The no-tenant fallback store: shared `$DSH_HOME/.credentials.yaml`, watched. */
  private readonly shared: LocalCredentialStore

  /**
   * @param ctx - owning Cordis context.
   * @param config - plugin config.
   */
  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.spec = resolveSpec(config)
    this.hooks = {
      logger: ctx.logger,
      notifyRef: (ref) => { this.notifyUpdated(ref) },
      notifyRecord: (key) => { this.notifyRecordUpdated(key) },
    }
    this.shared = new LocalCredentialStore(this.spec.sharedFilename, this.hooks)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      await Promise.all([this.shared.close(), ...[...this.stores.values()].map(store => store.close())])
    }
    await this.shared.start()
    if (!this.spec.watch) return
    const stopWatch = await this.shared.startWatch(this.spec.debounceMs)
    yield stopWatch
  }

  /**
   * The store for the caller's bound tenant, or the shared fallback store when
   * no tenant identity is bound. A tenant store is created and cached on first
   * use; every caller `await`s {@link LocalCredentialStore.start} before it reads.
   * @returns the store to resolve or write against.
   */
  private storeFor(): LocalCredentialStore {
    const tenantId = this.ctx.tenantContext.current()
    if (tenantId === undefined) return this.shared
    const existing = this.stores.get(tenantId)
    if (existing !== undefined) return existing
    const store = new LocalCredentialStore(
      join(this.spec.home, 'tenants', tenantId, CREDENTIALS_FILENAME),
      this.hooks,
    )
    this.stores.set(tenantId, store)
    return store
  }

  /* jscpd:ignore-start -- the shared environment / `.env` layering is
     intentionally identical to `@deepseek-ai/dsh-credentials-local`: only the
     file layer is tenant-scoped, and these two layers keep upstream's exact
     precedence and read-only semantics. */
  /** The inherited-environment value for a reference, or `undefined` when empty or unset. Shared across tenants. */
  private inherited(ref: CredentialRef): string | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    return entry !== undefined && entry.value.length > 0 ? entry.value : undefined
  }

  /** The `.env` fallback for a reference — below the per-tenant document, never above it. Shared across tenants. */
  private dotenvFallback(ref: CredentialRef): LaunchEnvironmentEntry | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['project-env', 'user-env'])
    return entry !== undefined && entry.value.length > 0 ? entry : undefined
  }
  /* jscpd:ignore-end */

  /** Reject a write the inherited environment would shadow into apparent no-effect. */
  private assertUnshadowed(ref: CredentialRef, verb: 'set' | 'unset'): void {
    if (this.inherited(ref) !== undefined) {
      throw new Error(
        `tenant-credentials-local: "${ref}" is supplied read-only by the launching environment, so ${verb} would be`
        + ' shadowed; unset it in the shell you start dsh from instead',
      )
    }
  }

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const inherited = this.inherited(ref)
    if (inherited !== undefined) return { value: inherited, source: 'env' }
    const store = this.storeFor()
    await store.start()
    const stored = store.getRef(ref)
    if (stored !== undefined) return { value: stored, source: 'file' }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return { value: fallback.value, source: fallback.source }
    return undefined
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (this.inherited(ref) !== undefined) return { configured: true, source: 'env', writable: false }
    const store = this.storeFor()
    await store.start()
    if (store.getRef(ref) !== undefined) return { configured: true, source: 'file', writable: true }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return { configured: true, source: fallback.source, writable: true }
    return { configured: false, writable: true }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error(`tenant-credentials-local: an empty value cannot be stored for "${ref}"; use unset`)
    }
    this.assertUnshadowed(ref, 'set')
    const store = this.storeFor()
    await store.start()
    await store.setRef(ref, value, () => { this.assertUnshadowed(ref, 'set') })
  }

  override async unset(ref: CredentialRef): Promise<void> {
    this.assertUnshadowed(ref, 'unset')
    const store = this.storeFor()
    await store.start()
    await store.setRef(ref, undefined, () => { this.assertUnshadowed(ref, 'unset') })
  }

  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const store = this.storeFor()
    await store.start()
    return store.readRecord(key)
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const store = this.storeFor()
    await store.start()
    return store.describeRecord(key)
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    const store = this.storeFor()
    await store.start()
    return store.listRecords()
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const store = this.storeFor()
    await store.start()
    return store.modifyRecord(key, mutate)
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    const store = this.storeFor()
    await store.start()
    await store.deleteRecord(key)
  }
}

export default TenantLocalCredentialProvider
