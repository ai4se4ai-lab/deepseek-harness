/**
 * `ctx.okf` — the per-tenant Open Knowledge Format bundle service.
 *
 * The bundle is a directory of markdown files with YAML frontmatter (OKF v0.2,
 * `projects/knowledge-catalog/okf/SPEC.md`). In the deployed MindPortalix
 * container it lives at `$DSH_HOME/tenants/<tenantId>/knowledge` — host-plane
 * state outside any session workspace, so this service uses `node:fs` directly
 * (like the tenant-isolation packages) rather than the sandbox-fenced `ctx.fs`.
 * With no tenant layer (local `dsh`), it falls back to a configured `root` or
 * `$DSH_HOME/knowledge`.
 *
 * The tenant id is read per call from `ctx.tenantContext` (async-local), so one
 * mounted service instance serves every tenant sharing the process.
 *
 * @module @mindportalix/dsh-okf-bundle
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
// Type-only: brings the `ctx.tenantContext` augmentation into scope. The service
// is optional at runtime and resolved through `ctx.get('tenantContext')`.
import type {} from '@mindportalix/dsh-tenant-context'
import {
  OkfBundleStore,
  type ConceptFilter,
  type ConceptRead,
  type ConceptSummary,
  type WriteConceptInput,
  type WriteConceptResult,
} from './store.ts'

export {
  OkfBundleStore,
  OkfPathError,
  OkfShrinkError,
  CONCEPT_MAX_BYTES,
  bundleKey,
} from './store.ts'
export type {
  ConceptFilter,
  ConceptRead,
  ConceptSummary,
  WriteConceptInput,
  WriteConceptResult,
} from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-tenant OKF bundle: traverse, read, and write concepts. */
    okf: OkfBundle
  }
}

/** Configuration for the OKF bundle service. */
export interface Config {
  /**
   * Absolute bundle root to use when no `ctx.tenantContext` is bound (local
   * `dsh` development and tests). Ignored when a tenant id is present — that
   * always resolves to `$DSH_HOME/tenants/<tenantId>/knowledge`. Omit to use
   * `$DSH_HOME/knowledge`.
   */
  root?: string
  /** The subdirectory of the tenant root the bundle lives in. Defaults to `knowledge`. */
  subdir?: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  root: z.string(),
  subdir: z.string().default('knowledge'),
})

/** The `ctx.okf` service. Methods resolve the current tenant's bundle per call. */
export class OkfBundle extends Service {
  /**
   * The Loader applies this when composing the plugin. It must live on the
   * class — for a Service-class plugin the Loader reads `static Config`, not a
   * module-level `Config` export — so a preset row that omits `config:` is
   * still coerced to `{ subdir: 'knowledge' }` rather than reaching the
   * constructor as `undefined`.
   */
  static Config = Config

  private readonly configuredRoot: string | undefined
  private readonly subdir: string

  constructor(ctx: Context, config: Config) {
    super(ctx, 'okf')
    this.configuredRoot = config?.root
    this.subdir = config?.subdir ?? 'knowledge'
  }

  /**
   * The absolute bundle root for the caller's current tenant. A bound
   * `ctx.tenantContext` wins; otherwise the configured `root`; otherwise
   * `$DSH_HOME/knowledge`.
   */
  resolveRoot(): string {
    const tenantId = this.ctx.get('tenantContext')?.current()
    if (tenantId !== undefined) return dshHomePath('tenants', tenantId, this.subdir)
    return this.configuredRoot ?? dshHomePath(this.subdir)
  }

  private store(): OkfBundleStore {
    return new OkfBundleStore(this.resolveRoot())
  }

  /** Whether the current tenant has a bundle directory yet. */
  exists(): Promise<boolean> {
    return this.store().exists()
  }

  /** Every concept and subdirectory in the current tenant's bundle. */
  list(): Promise<{ exists: boolean; concepts: ConceptSummary[]; truncated: boolean }> {
    return this.store().list()
  }

  /** Read one concept in full. */
  readConcept(id: string): Promise<ConceptRead> {
    return this.store().readConcept(id)
  }

  /** Concepts matching every {@link ConceptFilter} clause. */
  search(filter?: ConceptFilter): Promise<ConceptSummary[]> {
    return this.store().search(filter)
  }

  /** Create or update a concept, then regenerate indexes and append `log.md`. */
  writeConcept(id: string, input: WriteConceptInput): Promise<WriteConceptResult> {
    return this.store().writeConcept(id, input)
  }

  /** Append a `verified: { by, at }` event to a concept. */
  appendVerification(id: string, by: string, at?: string): Promise<ConceptRead> {
    return this.store().appendVerification(id, by, at)
  }

  /** Rewrite every `index.md`; returns the bundle-relative paths written. */
  regenerateIndexes(): Promise<string[]> {
    return this.store().regenerateIndexes()
  }
}

export default OkfBundle
