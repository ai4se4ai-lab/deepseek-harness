/**
 * Filesystem operations over one OKF bundle directory: traversal, concept
 * read/write, and `index.md` / `log.md` regeneration. Root-agnostic — the
 * caller supplies an absolute bundle root — so it is unit-testable against a
 * temp directory and the Cordis service in `index.ts` is a thin resolver over
 * it.
 *
 * Path containment mirrors the outer app's `services/dsh/dsh-tenant-files.js`
 * and the tenant-isolation packages: normalise, reject `..` / absolute / NUL,
 * then a `realpath` check that the resolved target is inside the root.
 *
 * @module @mindportalix/dsh-okf-bundle/store
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import {
  appendLogEntry,
  conformanceIssue,
  isAttestedComputation,
  isStale,
  lastVerifiedAt,
  lifecycleStatus,
  parseConcept,
  regenerateIndex,
  serializeConcept,
  trustTier,
  type IndexEntry,
  type LogEntry,
  type OKFConcept,
  type TrustTier,
} from '@mindportalix/dsh-okf-core'

/** Guards the walk against a pathological tree (matches the outer app's limits). */
const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_MAX_DEPTH = 12

/** Optional walk limits; tests lower them to exercise truncation. */
export interface StoreLimits {
  /** Stop the listing after this many entries (default 5000). */
  maxEntries?: number
  /** Do not descend past this depth (default 12). */
  maxDepth?: number
}

/** Largest concept body this store will read into memory. */
export const CONCEPT_MAX_BYTES = 512 * 1024

/** The two reserved filenames (OKF SPEC §3.1). */
const RESERVED = new Set(['index.md', 'log.md'])

/** Thrown for a bundle-relative path that is malformed or escapes the root. */
export class OkfPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OkfPathError'
  }
}

/** Thrown when a write would drop schema rows or sources without intent (SPEC-guided guard). */
export class OkfShrinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OkfShrinkError'
  }
}

/** One row of the flat concept listing. */
export interface ConceptSummary {
  /** Concept id: the file path within the bundle, `.md` removed (SPEC §2). */
  readonly id: string
  /** Bundle-relative file path. */
  readonly path: string
  /** File basename. */
  readonly name: string
  /** Whether this row is a directory rather than a concept. */
  readonly isDirectory: boolean
  /** Frontmatter `type`, or `null` (index/log carry none). */
  readonly type: string | null
  /** Frontmatter `title`, or `null`. */
  readonly title: string | null
  /** Frontmatter `description`, or `null`. */
  readonly description: string | null
  /** Frontmatter `tags`, or `[]`. */
  readonly tags: readonly string[]
  /** Lifecycle status, defaulting to `stable`. */
  readonly status: string
  /** Derived trust tier. */
  readonly trustTier: TrustTier
  /** Whether the concept is stale now. */
  readonly stale: boolean
  /** `generated.at`, or `null`. */
  readonly generatedAt: string | null
  /** Latest `verified[].at`, or `null`. */
  readonly verifiedAt: string | null
  /** Whether an Attested Computation contract is present. */
  readonly attested: boolean
  /** A SPEC §11 conformance reason when the file does not parse or lacks `type`; otherwise `null`. */
  readonly issue: string | null
}

/** A concept read in full. */
export interface ConceptRead extends OKFConcept {
  /** Concept id (path without `.md`). */
  readonly id: string
  /** Raw file text. */
  readonly raw: string
  /** Derived trust tier. */
  readonly trustTier: TrustTier
  /** Whether the concept is stale now. */
  readonly stale: boolean
}

/** Filter for {@link OkfBundleStore.search}. */
export interface ConceptFilter {
  /** Exact frontmatter `type` match. */
  type?: string
  /** Every listed tag must be present. */
  tags?: readonly string[]
  /** Case-insensitive substring match over id, title, description, and body. */
  text?: string
  /** Restrict to this trust tier. */
  trustTier?: TrustTier
  /** `true` → only stale, `false` → only fresh. */
  stale?: boolean
}

/** Input to {@link OkfBundleStore.writeConcept}. */
export interface WriteConceptInput {
  /** The concept's frontmatter. `type` is required (SPEC §11); `generated` is stamped if absent. */
  frontmatter: Record<string, unknown>
  /** The markdown body. */
  body: string
  /** The actor to record as `generated.by` when the caller did not set it (SPEC §7). */
  actor: string
  /** Skip the no-shrink guard (an intentional schema/source reduction). */
  allowShrink?: boolean
}

/** Result of a successful write. */
export interface WriteConceptResult {
  /** The concept id written. */
  readonly id: string
  /** Whether the file was newly created or overwrote an existing concept. */
  readonly action: 'create' | 'update'
  /** The stamped `generated` block. */
  readonly generated: { by: string; at: string }
  /** Bundle-relative index files rewritten as a side effect. */
  readonly indexesWritten: readonly string[]
}

function assertRelId(id: string): string {
  if (typeof id !== 'string' || id.length === 0 || id.includes('\0')) {
    throw new OkfPathError('concept id must be a non-empty string')
  }
  const withMd = id.endsWith('.md') ? id : `${id}.md`
  const normalized = path.posix.normalize(withMd)
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new OkfPathError(`concept id escapes the bundle root: ${id}`)
  }
  return normalized
}

/** Count backtick-quoted identifiers in a body — the proxy the OKF reference guard uses for "schema rows". */
function backtickIdentifiers(body: string): Set<string> {
  const out = new Set<string>()
  for (const match of body.matchAll(/`([^`\n]+)`/g)) out.add(match[1] as string)
  return out
}

function sourceIds(frontmatter: Record<string, unknown>): number {
  const sources = frontmatter['sources']
  return Array.isArray(sources) ? sources.length : 0
}

/** Read/write access to one OKF bundle rooted at an absolute directory. */
export class OkfBundleStore {
  private readonly maxEntries: number
  private readonly maxDepth: number

  /**
   * @param root - absolute path to the bundle directory. It need not exist yet;
   *   {@link writeConcept} creates it.
   * @param limits - optional walk limits (tests lower them to hit truncation).
   */
  constructor(private readonly root: string, limits: StoreLimits = {}) {
    this.maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH
  }

  /** The absolute bundle root. */
  get bundleRoot(): string {
    return this.root
  }

  private async resolveInside(relPath: string): Promise<string> {
    const candidate = path.join(this.root, relPath)
    let realRoot: string
    let realCandidate: string
    try {
      realRoot = await fsp.realpath(this.root)
      realCandidate = await fsp.realpath(candidate)
    } catch (error) {
      /* v8 ignore next 3 -- a non-ENOENT realpath failure (EACCES, EIO) is re-raised; needs a broken filesystem to reproduce. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const notFound = new Error('Not found') as NodeJS.ErrnoException
      notFound.code = 'ENOENT'
      throw notFound
    }
    /* v8 ignore next 3 -- assertRelId rejects escapes earlier; only a symlink resolving outside the root reaches here. Defense in depth. */
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) {
      throw new OkfPathError('path escapes the bundle root')
    }
    return realCandidate
  }

  /** Whether the bundle directory exists. */
  async exists(): Promise<boolean> {
    try {
      return (await fsp.lstat(this.root)).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * Every markdown file in the bundle as a {@link ConceptSummary}, plus a
   * directory row per subdirectory, sorted by path. Never throws for "no
   * bundle" — returns `{ exists: false, concepts: [] }`.
   */
  async list(): Promise<{ exists: boolean; concepts: ConceptSummary[]; truncated: boolean }> {
    let rootStat
    try {
      rootStat = await fsp.lstat(this.root)
    } catch (error) {
      /* v8 ignore next -- a non-ENOENT lstat failure on the root (EACCES, EIO) is re-raised; needs a broken filesystem. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { exists: false, concepts: [], truncated: false }
    }
    if (!rootStat.isDirectory()) return { exists: false, concepts: [], truncated: false }

    const concepts: ConceptSummary[] = []
    let truncated = false
    let level: { abs: string; rel: string }[] = [{ abs: this.root, rel: '' }]

    for (let depth = 0; depth <= this.maxDepth && level.length > 0 && !truncated; depth++) {
      const nextLevel: { abs: string; rel: string }[] = []
      for (const { abs, rel } of level) {
        if (truncated) break
        let entries
        try {
          entries = await fsp.readdir(abs, { withFileTypes: true })
        } catch {
          /* v8 ignore next -- a readdir failing on a just-entered directory is a mid-walk race; skip it rather than abort the listing. */
          continue
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue
          const relPath = rel ? `${rel}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            concepts.push(directoryRow(relPath, entry.name))
            nextLevel.push({ abs: path.join(abs, entry.name), rel: relPath })
          } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            let text = ''
            try {
              text = await fsp.readFile(path.join(abs, entry.name), 'utf8')
            } catch {
              /* v8 ignore next -- a readFile that fails on a file readdir just reported is a mid-walk race; skip it. */
              continue
            }
            concepts.push(summarize(relPath, entry.name, text))
          }
          if (concepts.length >= this.maxEntries) {
            truncated = true
            break
          }
        }
      }
      level = nextLevel
    }

    concepts.sort((a, b) => a.path.localeCompare(b.path))
    return { exists: true, concepts, truncated }
  }

  /** Read one concept in full. `id` may be given with or without the `.md` suffix. */
  async readConcept(id: string): Promise<ConceptRead> {
    const rel = assertRelId(id)
    const abs = await this.resolveInside(rel)
    const stat = await fsp.stat(abs)
    if (!stat.isFile()) throw new OkfPathError('not a file')
    if (stat.size > CONCEPT_MAX_BYTES) throw new OkfPathError('concept file is too large to read')
    const raw = await fsp.readFile(abs, 'utf8')
    const parsed = parseConcept(raw)
    return {
      id: rel.replace(/\.md$/, ''),
      raw,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      trustTier: trustTier(parsed.frontmatter),
      stale: isStale(parsed.frontmatter),
    }
  }

  /** Concepts matching every provided {@link ConceptFilter} clause. */
  async search(filter: ConceptFilter = {}): Promise<ConceptSummary[]> {
    const { concepts } = await this.list()
    const needle = filter.text?.toLowerCase()
    const results: ConceptSummary[] = []
    for (const concept of concepts) {
      if (concept.isDirectory) continue
      if (RESERVED.has(concept.name)) continue // index.md / log.md are not concepts (SPEC §3.1)
      if (filter.type !== undefined && concept.type !== filter.type) continue
      if (filter.trustTier !== undefined && concept.trustTier !== filter.trustTier) continue
      if (filter.stale !== undefined && concept.stale !== filter.stale) continue
      if (filter.tags !== undefined && !filter.tags.every(tag => concept.tags.includes(tag))) continue
      if (needle !== undefined) {
        let body = ''
        try {
          body = (await this.readConcept(concept.id)).body
        } catch {
          /* v8 ignore next -- list() just parsed this file; a read failure here is a mid-search race. */
          body = ''
        }
        const hay = `${concept.id}\n${concept.title ?? ''}\n${concept.description ?? ''}\n${body}`.toLowerCase()
        if (!hay.includes(needle)) continue
      }
      results.push(concept)
    }
    return results
  }

  /**
   * Create or overwrite a concept, stamping `generated` (SPEC §5.2), enforcing
   * the no-shrink guard unless `allowShrink`, then regenerating every affected
   * `index.md` and appending a `log.md` entry (SPEC §8/§9).
   */
  async writeConcept(id: string, input: WriteConceptInput): Promise<WriteConceptResult> {
    const rel = assertRelId(id)
    const conceptId = rel.replace(/\.md$/, '')
    const issue = conformanceIssue(input.frontmatter)
    if (issue !== null) throw new OkfShrinkError(`refusing to write a non-conformant concept: ${issue}`)

    const abs = path.join(this.root, rel)
    let action: 'create' | 'update' = 'create'
    let priorBody = ''
    let priorFrontmatter: Record<string, unknown> = {}
    try {
      const prior = parseConcept(await fsp.readFile(abs, 'utf8'))
      action = 'update'
      priorBody = prior.body
      priorFrontmatter = prior.frontmatter
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    if (action === 'update' && !input.allowShrink) {
      const before = backtickIdentifiers(priorBody)
      const after = backtickIdentifiers(input.body)
      const dropped = [...before].filter(idn => !after.has(idn))
      if (dropped.length > 0) {
        throw new OkfShrinkError(
          `refusing to write: body drops ${dropped.length} identifier(s) present before (${dropped.map(d => `\`${d}\``).join(', ')}); pass allowShrink to override`,
        )
      }
      const priorSources = sourceIds(priorFrontmatter)
      if (priorSources > 0 && sourceIds(input.frontmatter) < priorSources) {
        throw new OkfShrinkError(
          `refusing to write: sources had ${priorSources} entr${priorSources === 1 ? 'y' : 'ies'}, fewer now; pass allowShrink to override`,
        )
      }
    }

    const generatedRaw = input.frontmatter['generated']
    const generated = isGeneratedBlock(generatedRaw)
      ? { by: String(generatedRaw.by), at: String(generatedRaw.at ?? new Date().toISOString()) }
      : { by: input.actor, at: new Date().toISOString() }
    const frontmatter: Record<string, unknown> = { ...input.frontmatter, generated }

    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, serializeConcept({ frontmatter, body: input.body }), 'utf8')

    const indexesWritten = await this.regenerateIndexes()
    await this.appendLog({
      date: generated.at.slice(0, 10),
      kind: action === 'create' ? 'Creation' : 'Update',
      text: `${action === 'create' ? 'Added' : 'Updated'} [${String(frontmatter['title'] ?? conceptId)}](/${conceptId}.md).`,
    })

    return { id: conceptId, action, generated, indexesWritten }
  }

  /**
   * Append a `verified: { by, at }` event to a concept (SPEC §5.2). `by` should
   * be `human:<id>` only for a real human confirmation (SPEC §7).
   */
  async appendVerification(id: string, by: string, at: string = new Date().toISOString()): Promise<ConceptRead> {
    const current = await this.readConcept(id)
    const existing = current.frontmatter['verified']
    const list = Array.isArray(existing)
      ? [...existing]
      : (existing && typeof existing === 'object' ? [existing] : [])
    list.push({ by, at })
    const rel = assertRelId(id)
    await fsp.writeFile(
      path.join(this.root, rel),
      serializeConcept({ frontmatter: { ...current.frontmatter, verified: list }, body: current.body }),
      'utf8',
    )
    return this.readConcept(id)
  }

  /**
   * Rewrite `index.md` in every directory that contains concepts, grouping by
   * type with subdirectories last (SPEC §8).
   * @returns the bundle-relative paths of the index files written.
   */
  async regenerateIndexes(): Promise<string[]> {
    if (!(await this.exists())) return []
    const written: string[] = []
    const dirs = await this.directoriesWithConcepts()
    // Deepest first, so a parent's subdirectory rows can reuse a child's
    // description. The bundle root is '' (depth 0), so it is always processed
    // last — `''.split('/')` is length 1, so compute depth explicitly.
    const depth = (dir: string): number => (dir === '' ? 0 : dir.split('/').length)
    dirs.sort((a, b) => depth(b) - depth(a) || a.localeCompare(b))
    const dirDescription = new Map<string, string>()
    for (const dir of dirs) {
      const absDir = dir ? path.join(this.root, dir) : this.root
      const entries: IndexEntry[] = []
      const names = (await fsp.readdir(absDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
      for (const dirent of names) {
        if (dirent.isSymbolicLink()) continue
        if (dirent.name === 'index.md') continue
        if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.md')) {
          let fm: Record<string, unknown> = {}
          try {
            fm = parseConcept(await fsp.readFile(path.join(absDir, dirent.name), 'utf8')).frontmatter
          } catch {
            continue
          }
          entries.push({
            type: typeof fm['type'] === 'string' ? (fm['type'] as string) : '',
            title: typeof fm['title'] === 'string' ? (fm['title'] as string) : dirent.name.replace(/\.md$/, ''),
            link: dirent.name,
            description: typeof fm['description'] === 'string' ? (fm['description'] as string) : '',
          })
        } else if (dirent.isDirectory()) {
          const childRel = dir ? `${dir}/${dirent.name}` : dirent.name
          entries.push({
            type: 'Subdirectories',
            title: dirent.name,
            link: `${dirent.name}/index.md`,
            description: dirDescription.get(childRel) ?? '',
          })
        }
      }
      const text = regenerateIndex(entries)
      if (text.length === 0) continue
      const relIndex = dir ? `${dir}/index.md` : 'index.md'
      await fsp.writeFile(path.join(absDir, 'index.md'), text, 'utf8')
      written.push(relIndex)
      if (dir) {
        const conceptRows = entries.filter(e => e.type !== 'Subdirectories')
        dirDescription.set(
          dir,
          conceptRows.length === 1 && conceptRows[0]?.description
            ? (conceptRows[0].description as string)
            : `${conceptRows.length} concept${conceptRows.length === 1 ? '' : 's'}`,
        )
      }
    }
    written.sort()
    return written
  }

  /** Append an entry to the bundle-root `log.md` (SPEC §9). */
  async appendLog(entry: LogEntry): Promise<void> {
    const logPath = path.join(this.root, 'log.md')
    let existing = ''
    try {
      existing = await fsp.readFile(logPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await fsp.mkdir(this.root, { recursive: true })
    await fsp.writeFile(logPath, appendLogEntry(existing, entry), 'utf8')
  }

  private async directoriesWithConcepts(): Promise<string[]> {
    const withConcepts = new Set<string>()
    const walk = async (rel: string): Promise<void> => {
      const absDir = rel ? path.join(this.root, rel) : this.root
      let entries
      try {
        entries = await fsp.readdir(absDir, { withFileTypes: true })
      } catch {
        /* v8 ignore next -- a readdir race on a directory just discovered; treat it as holding no concepts. */
        return
      }
      for (const dirent of entries) {
        if (dirent.isSymbolicLink()) continue
        if (dirent.isDirectory()) {
          await walk(rel ? `${rel}/${dirent.name}` : dirent.name)
        } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.md') && !RESERVED.has(dirent.name)) {
          withConcepts.add(rel)
          // Every ancestor also "contains" concepts for index purposes.
          const parts = rel.split('/').filter(Boolean)
          for (let i = 0; i < parts.length; i++) withConcepts.add(parts.slice(0, i).join('/'))
        }
      }
    }
    await walk('')
    return [...withConcepts]
  }
}

function directoryRow(relPath: string, name: string): ConceptSummary {
  return {
    id: relPath,
    path: relPath,
    name,
    isDirectory: true,
    type: null,
    title: null,
    description: null,
    tags: [],
    status: 'stable',
    trustTier: 'unverified',
    stale: false,
    generatedAt: null,
    verifiedAt: null,
    attested: false,
    issue: null,
  }
}

function summarize(relPath: string, name: string, text: string): ConceptSummary {
  const base = directoryRow(relPath, name)
  let frontmatter: Record<string, unknown>
  try {
    ({ frontmatter } = parseConcept(text))
  } catch (error) {
    return { ...base, isDirectory: false, issue: (error as Error).message }
  }
  return {
    ...base,
    isDirectory: false,
    id: relPath.replace(/\.md$/, ''),
    type: typeof frontmatter['type'] === 'string' ? (frontmatter['type'] as string) : null,
    title: typeof frontmatter['title'] === 'string' ? (frontmatter['title'] as string) : null,
    description: typeof frontmatter['description'] === 'string' ? (frontmatter['description'] as string) : null,
    tags: Array.isArray(frontmatter['tags']) ? (frontmatter['tags'] as string[]) : [],
    status: lifecycleStatus(frontmatter),
    trustTier: trustTier(frontmatter),
    stale: isStale(frontmatter),
    generatedAt: readAt(frontmatter['generated']),
    verifiedAt: lastVerifiedAt(frontmatter),
    attested: isAttestedComputation(frontmatter),
    issue: RESERVED.has(name) ? null : conformanceIssue(frontmatter),
  }
}

function readAt(generated: unknown): string | null {
  if (generated && typeof generated === 'object' && 'at' in generated) {
    const at = (generated as { at: unknown }).at
    return typeof at === 'string' ? at : null
  }
  return null
}

function isGeneratedBlock(value: unknown): value is { by: unknown; at?: unknown } {
  return value !== null && typeof value === 'object' && 'by' in value && Boolean((value as { by: unknown }).by)
}

/** Hash a bundle root to a short stable key (used by the service for logging, never for paths). */
export function bundleKey(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12)
}
