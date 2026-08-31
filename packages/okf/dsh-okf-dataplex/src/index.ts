/**
 * `ctx.okfDataplex` — sync a tenant's OKF bundle with a Google Cloud Knowledge
 * Catalog (Dataplex) EntryGroup, via the generic Documents Layout plus a custom
 * `okf` aspect that carries the v0.2 signal layer losslessly.
 *
 * The frontmatter⇄aspect translation (`toStaging` / `fromStaging`) is complete
 * and tested. Actually invoking `kcmd push` / `kcmd pull` needs the `kcmd`
 * binary and authenticated `gcloud` in the environment, so it goes through an
 * injectable {@link KcmdRunner}; the default one is unavailable and says so.
 *
 * @module @mindportalix/dsh-okf-dataplex
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the `ctx.okf` augmentation.
import type {} from '@mindportalix/dsh-okf-bundle'
import { fromStaging, toStaging } from './staging.ts'

export { toStaging, fromStaging } from './staging.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** OKF ⇄ Knowledge Catalog (Dataplex) sync. */
    okfDataplex: OkfDataplex
  }
}

/** Runs a `kcmd` subcommand in a staging directory and resolves its stdout. */
export interface KcmdRunner {
  /**
   * @param args - `kcmd` argv, e.g. `['push']` or `['pull']`.
   * @param cwd - the staging directory the manifest and `catalog/` tree live in.
   * @returns the process stdout.
   */
  run(args: readonly string[], cwd: string): Promise<string>
}

/** The default runner: `kcmd` is not bundled in this image. */
class UnavailableKcmdRunner implements KcmdRunner {
  run(): Promise<string> {
    return Promise.reject(new Error(
      'okf-dataplex: no kcmd runner is configured. Knowledge Catalog sync needs the `kcmd` binary and '
      + 'authenticated `gcloud` in the environment; provide a KcmdRunner via config or a companion plugin.',
    ))
  }
}

/** Configuration for OKF ⇄ Dataplex sync. */
export interface Config {
  /** GCP project id. */
  project: string
  /** GCP location, e.g. `us-central1`. */
  location: string
  /**
   * EntryGroup name template. `{tenant}` is replaced with the caller's tenant id
   * (or `local` when there is no tenant layer). Must match Dataplex's rule
   * `/^[a-z][a-z0-9_-]{0,61}[a-z0-9]$/` after substitution.
   */
  entryGroupTemplate: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  project: z.string().default(''),
  location: z.string().default('us-central1'),
  entryGroupTemplate: z.string().default('okf_{tenant}'),
})

const ENTRY_GROUP_RE = /^[a-z][a-z0-9_-]{0,61}[a-z0-9]$/

/** The `ctx.okfDataplex` service. */
export class OkfDataplex extends Service {
  static inject = ['okf']

  /**
   * Applied by the Loader when composing the plugin. It must live on the class
   * — a Service-class plugin's config schema is read from `static Config`, not
   * a module-level export — so a row that omits `config:` is coerced to the
   * per-field defaults instead of reaching the constructor as `undefined`.
   */
  static Config = Config

  private runner: KcmdRunner = new UnavailableKcmdRunner()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'okfDataplex')
  }

  /** Install the runner that actually invokes `kcmd` (a companion plugin does this). */
  setRunner(runner: KcmdRunner): void {
    this.runner = runner
  }

  /** The Dataplex aspect-type key for the configured project/location. */
  get okfAspectKey(): string {
    return `${this.config.project}.${this.config.location}.okf`
  }

  /** The `okf-bundle` entry-type key for the configured project/location. */
  get entryTypeKey(): string {
    return `${this.config.project}.${this.config.location}.okf-bundle`
  }

  /** The resolved EntryGroup name for the caller's current tenant. */
  entryGroup(): string {
    const tenantId = this.ctx.get('tenantContext')?.current() ?? 'local'
    const name = this.config.entryGroupTemplate.replace('{tenant}', tenantId.slice(0, 40))
    if (!ENTRY_GROUP_RE.test(name)) {
      throw new Error(`okf-dataplex: resolved EntryGroup name "${name}" does not match ${String(ENTRY_GROUP_RE)}`)
    }
    return name
  }

  /**
   * Translate every concept in the tenant's bundle to Knowledge Catalog staging
   * form, keyed by bundle-relative path. The caller writes these into a staging
   * tree and runs `kcmd push`; {@link push} does that when a runner is set.
   *
   * @returns `path → staged file text`.
   */
  async stageBundle(): Promise<Record<string, string>> {
    const { concepts } = await this.ctx.okf.list()
    const staged: Record<string, string> = {}
    for (const concept of concepts) {
      if (concept.isDirectory) continue
      const read = await this.ctx.okf.readConcept(concept.id)
      staged[concept.path] = toStaging(read.raw, this.okfAspectKey, this.entryTypeKey)
    }
    return staged
  }

  /** Inverse of {@link toStaging} for a single staged file. */
  unstage(stagedFileText: string): string {
    return fromStaging(stagedFileText, this.okfAspectKey)
  }

  /**
   * Push the tenant's bundle to its EntryGroup. Requires a configured runner.
   *
   * @param stagingDir - a writable directory to build the staging tree in.
   * @returns `kcmd push` stdout.
   */
  async push(stagingDir: string): Promise<string> {
    await this.stageBundle() // surfaces bundle/translation errors before shelling out
    return this.runner.run(['push'], stagingDir)
  }

  /**
   * Pull the EntryGroup down. Requires a configured runner.
   *
   * @param stagingDir - the directory `kcmd pull` populated.
   * @returns `kcmd pull` stdout.
   */
  pull(stagingDir: string): Promise<string> {
    return this.runner.run(['pull'], stagingDir)
  }
}

export default OkfDataplex
