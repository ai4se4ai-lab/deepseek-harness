/**
 * Model-facing tools for maintaining a tenant's Open Knowledge Format bundle
 * (`ctx.okf`, from `@mindportalix/dsh-okf-bundle`):
 *
 * - `okf_bundle_overview` — the current concept catalogue (types, trust tiers,
 *   staleness), a cheap first read before answering from the bundle.
 * - `okf_search_concepts` — filter by type / tags / text / trust / staleness.
 * - `okf_read_concept` — one concept's body + frontmatter + derived verdicts,
 *   with a stale warning (SPEC §5.5, §10.5).
 * - `okf_write_concept` — create or update a concept; `generated` is stamped,
 *   the no-shrink guard runs, and `index.md` / `log.md` are regenerated.
 * - `okf_verify_concept` — append a `verified: { by, at }` event (SPEC §5.2).
 *
 * `okf_attest` (SPEC §10) is registered separately by
 * `@mindportalix/dsh-okf-attest` when that engine is deployed.
 *
 * @module @mindportalix/dsh-tool-okf
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { formatAgentActor, type TrustTier } from '@mindportalix/dsh-okf-core'
import type { ConceptFilter, ConceptSummary } from '@mindportalix/dsh-okf-bundle'
// Type-only: brings the `ctx.okf` augmentation into scope.
import type {} from '@mindportalix/dsh-okf-bundle'

/** Widen a plain data object to the JSON value the tool schema declares. */
const asJson = (value: unknown): JsonValue => value as JsonValue

export const name = 'tool-okf'
export const inject = ['tools', 'okf']

const TRUST_TIERS = ['unverified', 'machine-confirmed', 'human-reviewed'] as const

/** Configuration for the OKF tool suite. */
export interface Config {
  /**
   * The producer half of the actor string stamped as `generated.by` /
   * `verified[].by` for machine writes (SPEC §7). Combined with {@link version}
   * as `<producer>/<version>`.
   */
  producer: string
  /** The version half of the machine actor string. Set from the deployment's build id. */
  version: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  producer: z.string().default('dsh'),
  version: z.string().default('unversioned'),
})

/** One line per concept for the overview / search results. */
function summaryLine(c: ConceptSummary): string {
  const flags = [
    c.type ?? '(no type)',
    c.status !== 'stable' ? c.status : '',
    c.trustTier,
    c.stale ? 'STALE' : '',
    c.attested ? 'attested' : '',
    c.issue ? `ISSUE: ${c.issue}` : '',
  ].filter(Boolean).join(', ')
  return `- ${c.id} — ${c.title ?? '(untitled)'} [${flags}]`
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  // A `type: 'json'` parameter admits any JSON value, and some models emit a
  // nested object argument JSON-encoded as a string. Accept that one encoding
  // level here rather than failing the write; a string that is not itself a
  // JSON object still fails.
  let candidate: unknown = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      throw new HarnessError(`${field} must be a JSON object`, 'OKF_TOOL_INVALID_INPUT')
    }
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new HarnessError(`${field} must be a JSON object`, 'OKF_TOOL_INVALID_INPUT')
  }
  return candidate as Record<string, unknown>
}

/**
 * Register the OKF tool suite on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry and `ctx.okf`.
 * @param config - the machine actor identity.
 */
export function apply(ctx: Context, config: Config): void {
  const machineActor = formatAgentActor(config.producer, config.version)

  ctx.tools.register(defineTool({
    name: 'okf_bundle_overview',
    description:
      'List every concept in the knowledge bundle you maintain for this user — id, type, trust tier, '
      + 'staleness, and whether it is an attested computation. Read this before answering a question the '
      + 'bundle might already cover, and before writing so you build on what exists.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exists: { type: 'boolean', required: true },
          count: { type: 'integer', required: true },
          concepts: {
            type: 'array',
            required: true,
            items: { type: 'json' },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.exists
          ? (value.count === 0
            ? 'The knowledge bundle exists but has no concepts yet.'
            : `${value.count} concept(s):\n${(value.concepts as unknown as ConceptSummary[]).map(summaryLine).join('\n')}`)
          : 'No knowledge bundle exists yet. Create the first concept with okf_write_concept.',
      }],
    },
    async execute() {
      const { exists, concepts } = await ctx.okf.list()
      const files = concepts.filter(c => !c.isDirectory)
      return { exists, count: files.length, concepts: files.map(asJson) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'okf_search_concepts',
    description:
      'Search the knowledge bundle. Every provided filter must match. `text` is a case-insensitive '
      + 'substring over id, title, description, and body.',
    parameters: {
      type: { type: 'string', description: 'Exact frontmatter `type` (e.g. "Metric", "Policy").' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Every tag must be present.' },
      text: { type: 'string', description: 'Case-insensitive substring match.' },
      trust_tier: { type: 'string', enum: [...TRUST_TIERS], description: 'Restrict to this trust tier.' },
      stale: { type: 'boolean', description: 'true → only stale, false → only fresh.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          concepts: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count === 0
          ? 'No concepts match.'
          : `${value.count} match(es):\n${(value.concepts as unknown as ConceptSummary[]).map(summaryLine).join('\n')}`,
      }],
    },
    async execute(args) {
      const filter: ConceptFilter = {}
      if (typeof args.type === 'string') filter.type = args.type
      if (Array.isArray(args.tags)) filter.tags = args.tags.filter((t): t is string => typeof t === 'string')
      if (typeof args.text === 'string') filter.text = args.text
      if (typeof args.trust_tier === 'string') filter.trustTier = args.trust_tier as TrustTier
      if (typeof args.stale === 'boolean') filter.stale = args.stale
      const concepts = await ctx.okf.search(filter)
      return { count: concepts.length, concepts: concepts.map(asJson) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'okf_read_concept',
    description:
      'Read one concept in full: its markdown body, parsed frontmatter, and the derived trust tier and '
      + 'staleness. `id` is the file path within the bundle without the `.md` suffix (e.g. "metrics/revenue").',
    parameters: {
      id: { type: 'string', required: true, description: 'Concept id — bundle-relative path, no `.md`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          frontmatter: { type: 'json', required: true },
          body: { type: 'string', required: true },
          trust_tier: { type: 'string', required: true, enum: [...TRUST_TIERS] },
          stale: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const blocks: ContentBlock[] = []
        if (value.stale) {
          blocks.push({ type: 'text', text: '⚠ This concept is past its stale_after — treat its content as possibly out of date.' })
        }
        blocks.push({ type: 'text', text: `# ${value.id}\ntrust: ${value.trust_tier}\n\n${value.body}` })
        return blocks
      },
    },
    async execute(args) {
      const concept = await readConceptOrThrow(ctx, args.id)
      return {
        id: concept.id,
        frontmatter: asJson(concept.frontmatter),
        body: concept.body,
        trust_tier: concept.trustTier,
        stale: concept.stale,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'okf_write_concept',
    description:
      'Create or update a concept. `frontmatter` is a JSON object; `type` is required (OKF SPEC §11). '
      + '`generated` is stamped for you unless you set it. A write that drops schema identifiers or shrinks '
      + '`sources` is refused unless `allow_shrink` is true. `index.md` and `log.md` are regenerated.',
    parameters: {
      id: { type: 'string', required: true, description: 'Concept id — bundle-relative path, no `.md`.' },
      frontmatter: { type: 'json', required: true, description: 'The concept frontmatter as a JSON object.' },
      body: { type: 'string', required: true, description: 'The markdown body (favour headings, lists, tables).' },
      allow_shrink: { type: 'boolean', description: 'Permit an intentional schema/source reduction.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          action: { type: 'string', required: true, enum: ['create', 'update'] },
          generated_by: { type: 'string', required: true },
          generated_at: { type: 'string', required: true },
          indexes_written: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.action === 'create' ? 'Created' : 'Updated'} ${value.id} (generated.by ${value.generated_by}). `
          + `Rewrote ${value.indexes_written.length} index file(s).`,
      }],
    },
    async execute(args) {
      const frontmatter = asObject(args.frontmatter, 'frontmatter')
      const res = await writeConceptOrThrow(ctx, args.id, {
        frontmatter,
        body: args.body,
        actor: machineActor,
        ...(args.allow_shrink === true ? { allowShrink: true } : {}),
      })
      return {
        id: res.id,
        action: res.action,
        generated_by: res.generated.by,
        generated_at: res.generated.at,
        indexes_written: [...res.indexesWritten],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'okf_verify_concept',
    description:
      'Record that a concept has been confirmed against its sources or policy: appends a '
      + '`verified: { by, at }` event (OKF SPEC §5.2). Use `human:<id>` as `by` ONLY when a real person '
      + 'confirmed it in this session; otherwise omit `by` and the machine actor is recorded.',
    parameters: {
      id: { type: 'string', required: true, description: 'Concept id — bundle-relative path, no `.md`.' },
      by: { type: 'string', description: 'Verifying actor. `human:<id>` only for a genuine human sign-off.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          by: { type: 'string', required: true },
          trust_tier: { type: 'string', required: true, enum: [...TRUST_TIERS] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Recorded verification of ${value.id} by ${value.by}; trust tier is now ${value.trust_tier}.`,
      }],
    },
    async execute(args) {
      const by = typeof args.by === 'string' && args.by.length > 0 ? args.by : machineActor
      const concept = await appendVerificationOrThrow(ctx, args.id, by)
      return { id: concept.id, by, trust_tier: concept.trustTier }
    },
  }))

  // `okf_attest` (OKF SPEC §10) is registered by @mindportalix/dsh-okf-attest
  // when that engine is mounted — it needs a shell/runtime this package does
  // not depend on. Absent it, the agent simply has no attestation tool.
}

async function readConceptOrThrow(ctx: Context, id: unknown): ReturnType<Context['okf']['readConcept']> {
  try {
    return await ctx.okf.readConcept(String(id))
  } catch (error) {
    throw toHarnessError(error, id)
  }
}

async function writeConceptOrThrow(
  ctx: Context,
  id: unknown,
  input: Parameters<Context['okf']['writeConcept']>[1],
): ReturnType<Context['okf']['writeConcept']> {
  try {
    return await ctx.okf.writeConcept(String(id), input)
  } catch (error) {
    throw toHarnessError(error, id)
  }
}

async function appendVerificationOrThrow(ctx: Context, id: unknown, by: string): ReturnType<Context['okf']['appendVerification']> {
  try {
    return await ctx.okf.appendVerification(String(id), by)
  } catch (error) {
    throw toHarnessError(error, id)
  }
}

function toHarnessError(error: unknown, id: unknown): HarnessError {
  const err = error as { code?: string; name?: string; message?: string }
  if (err.code === 'ENOENT') return new HarnessError(`no concept "${String(id)}" in the bundle`, 'OKF_TOOL_NOT_FOUND')
  if (err.name === 'OkfPathError') return new HarnessError(String(err.message), 'OKF_TOOL_INVALID_INPUT')
  if (err.name === 'OkfShrinkError' || err.name === 'OKFDocumentError') {
    return new HarnessError(String(err.message), 'OKF_TOOL_REFUSED')
  }
  // `ctx.okf` always throws an Error subclass, so `.message` is present; the
  // `String(error)` fallback only guards a thrown non-Error and is unreachable here.
  /* v8 ignore next 2 */
  const message = typeof err.message === 'string' ? err.message : String(error)
  return new HarnessError(message, 'OKF_TOOL_FAILED')
}
