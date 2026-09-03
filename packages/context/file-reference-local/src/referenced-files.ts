/**
 * Auto-inline the contents of files the user pointed at with `@`.
 *
 * `@path` selection contributes only a path — the model still has to call
 * `read` to see a byte of it, and a smaller or less tool-eager model often
 * does not, then answers about a document it never opened. This provider reads
 * the referenced files itself and folds their current text into the runtime
 * context snapshot, so "summarize this", "turn this into OKF concepts", and
 * follow-ups like "now do X with it" work without a `read` round-trip.
 *
 * It is bounded, not a file cache: at most `maxFiles` distinct paths (most
 * recent first across every user turn), each capped at `maxBytesPerFile` read
 * and `maxCharsPerFile` shown, with a `maxCharsTotal` ceiling over all of them.
 * A PDF is inlined as its extracted text layer (see
 * `@deepseek-ai/dsh-tool-fs`'s `extractDocumentText`); anything too large,
 * outside the workspace, or with no readable text is listed by name with the
 * reason instead, pointing the model at the `read` tool.
 *
 * @module @deepseek-ai/dsh-file-reference-local/referenced-files
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { extractDocumentText } from '@deepseek-ai/dsh-tool-fs'

/** The addressed agent's session (its event log and header carry the references and cwd). */
type Session = Agent['session']

/** Default: contribute referenced-file contents (the `inlineReferencedFiles` config). */
export const DEFAULT_INLINE_ENABLED = true

/** Default distinct paths inlined per snapshot (the `maxInlinedFiles` config). */
export const DEFAULT_INLINE_MAX_FILES = 5

/** Default per-file byte cap before a reference is listed, not inlined (`maxInlinedBytesPerFile`). */
export const DEFAULT_INLINE_MAX_BYTES_PER_FILE = 512 * 1024

/** Default per-file character cap on inlined text (`maxInlinedCharsPerFile`). */
export const DEFAULT_INLINE_MAX_CHARS_PER_FILE = 60_000

/** Default character ceiling over every inlined file in one snapshot (`maxInlinedCharsTotal`). */
export const DEFAULT_INLINE_MAX_CHARS_TOTAL = 160_000

/** Resolved inlining bounds (plugin config after defaulting; see `Config` in index.ts). */
export interface InlineConfig {
  /** Whether to contribute referenced-file contents at all. */
  enabled: boolean
  /** Maximum distinct referenced paths inlined, newest reference first. */
  maxFiles: number
  /** Byte cap on one referenced file before it is listed rather than inlined. */
  maxBytesPerFile: number
  /** Character cap on one file's inlined text before a truncation line. */
  maxCharsPerFile: number
  /** Character cap over every inlined file in one snapshot. */
  maxCharsTotal: number
}

/** `@path` / `@"path with spaces"` at input start or after whitespace, matching the editor grammar. */
const REFERENCE_RE = /(?:^|\s)@(?:"([^"\n]+)"|([^\s"]+))/gu

/** Trailing sentence punctuation stripped from a bare (unquoted) reference token. */
const TRAILING_PUNCT_RE = /[.,;:!?]+$/u

/**
 * Interpolation-safe form of inlined text. The runtime-context snapshot runs
 * every context through `{{name}}` variable interpolation, which throws on an
 * unknown or malformed group; a referenced Handlebars/Jinja/Vue file would
 * crash the turn. Splitting each `{{` and `}}` with a zero-width space keeps
 * the text visually identical while it can no longer open a variable group.
 */
function neutralizeBraces(text: string): string {
  return text.replace(/\{\{/gu, '{\u200b{').replace(/\}\}/gu, '}\u200b}')
}

/**
 * Distinct `@`-referenced paths across every user message, newest reference
 * first, capped at `limit`. Plugin-injected messages are ignored — only what a
 * person typed counts as a reference.
 * @param session - the addressed agent's session.
 * @param limit - maximum paths to return.
 * @returns workspace-relative or absolute path strings, in most-recently-referenced order.
 */
export function collectReferencedPaths(session: Session, limit: number): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (let i = session.events.length - 1; i >= 0 && paths.length < limit; i -= 1) {
    const event = session.events[i]
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    for (const match of text.matchAll(REFERENCE_RE)) {
      /* v8 ignore next -- one of the regex's two alternatives always captures, so `?? ''` is unreachable and satisfies the type only. */
      const raw = (match[1] ?? match[2] ?? '').trim()
      const path = match[1] === undefined ? raw.replace(TRAILING_PUNCT_RE, '') : raw
      if (path.length === 0 || seen.has(path)) continue
      seen.add(path)
      paths.push(path)
      if (paths.length >= limit) break
    }
  }
  return paths
}

/** One resolved reference: inlined text, or a reason it was only named. */
type LoadOutcome =
  | { kind: 'ok'; path: string; text: string; extracted: boolean; truncated: boolean }
  | { kind: 'skip'; path: string; reason: string }

/**
 * Per-agent contributor of referenced-file contents to the runtime context.
 * Registers one `system-prompt/assemble` listener on the agent's context and
 * caches each file's extraction against its filesystem version, so steps within
 * a turn re-stat but do not re-read unchanged files.
 */
export class ReferencedFileInliner {
  private readonly cache = new Map<string, { version: FsVersion; outcome: LoadOutcome }>()
  private readonly disposeListener: () => void

  /**
   * @param agent - the agent whose turns this contributes to.
   * @param config - resolved inlining bounds.
   */
  constructor(private readonly agent: Agent, private readonly config: InlineConfig) {
    this.disposeListener = agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      if (!this.config.enabled) return assembled
      const text = await this.render(context.signal)
      if (text === undefined) return assembled
      return { ...assembled, contexts: [...assembled.contexts, { name: 'context:referenced-files', text }] }
    })
  }

  /** Drop the assemble listener and the extraction cache. */
  dispose(): void {
    this.disposeListener()
    this.cache.clear()
  }

  /** Build the snapshot section, or `undefined` when nothing is referenced or inlinable. */
  private async render(signal: AbortSignal | undefined): Promise<string | undefined> {
    const fs = this.agent.ctx.get('fs')
    const cwd = this.agent.session.header.cwd
    if (fs === undefined || cwd === undefined || cwd.length === 0) return undefined

    const paths = collectReferencedPaths(this.agent.session, this.config.maxFiles)
    if (paths.length === 0) return undefined

    const shown: string[] = []
    const named: string[] = []
    let remaining = this.config.maxCharsTotal
    for (const path of paths) {
      if (signal?.aborted === true) break
      const outcome = await this.load(fs, path, cwd, signal)
      if (outcome === undefined) continue
      if (outcome.kind === 'skip') { named.push(`${outcome.path} — ${outcome.reason}`); continue }
      if (remaining <= 0) { named.push(`${outcome.path} — inline budget exhausted`); continue }

      const overBudget = outcome.text.length > remaining
      const body = overBudget ? outcome.text.slice(0, remaining) : outcome.text
      remaining -= body.length
      const suffix = overBudget || outcome.truncated
        ? '\n[… truncated; use the read tool for the rest …]'
        : ''
      const label = outcome.extracted ? `${outcome.path} (extracted text)` : outcome.path
      shown.push(`----- ${label} -----\n${neutralizeBraces(body)}${suffix}`)
    }

    if (shown.length === 0 && named.length === 0) return undefined
    const parts: string[] = []
    if (shown.length > 0) {
      parts.push(
        `The user referenced these files with @. Their current contents follow so you can use them directly; open a file with the read tool only for more than is shown.\n\n${shown.join('\n\n')}`,
      )
    }
    if (named.length > 0) {
      parts.push(`Referenced but not inlined (use the read tool): ${named.join('; ')}`)
    }
    return parts.join('\n\n')
  }

  /**
   * Resolve, bound, and extract one reference; `undefined` means "not a file
   * here — ignore quietly". Outcomes name the file by the reference token the
   * user typed, not the backend's absolute path.
   */
  private async load(
    fs: FileSystem,
    ref: string,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<LoadOutcome | undefined> {
    const target = await resolveOrUndefined(fs, ref, cwd, signal)
    if (target === undefined) return undefined
    const info = await statOrUndefined(fs, target, signal)
    if (info === undefined || info.type !== 'file') return undefined

    const root = await resolveOrUndefined(fs, '.', cwd, signal)
    if (root === undefined) return undefined
    if (!fs.contains(root, target)) return { kind: 'skip', path: ref, reason: 'outside the workspace' }
    if (info.size !== undefined && info.size > this.config.maxBytesPerFile) {
      return { kind: 'skip', path: ref, reason: `${info.size} bytes exceeds the inline limit` }
    }

    const cacheKey = target.displayPath
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined && cached.version === info.version) return cached.outcome

    const bytes = await readBytesOrError(fs, target, signal, this.config.maxBytesPerFile)
    if (bytes === undefined) return { kind: 'skip', path: ref, reason: 'exceeds the inline limit' }
    if (bytes === null) return { kind: 'skip', path: ref, reason: 'could not be read' }
    const extracted = await extractDocumentText(bytes, this.config.maxCharsPerFile)
    let outcome: LoadOutcome
    if (extracted.text.length === 0) {
      // extractDocumentText always returns a `note` alongside empty text; the
      // literal only satisfies the type.
      /* v8 ignore next */
      const reason = extracted.note ?? 'no readable text'
      outcome = { kind: 'skip', path: ref, reason }
    } else {
      outcome = { kind: 'ok', path: ref, text: extracted.text, extracted: extracted.kind === 'pdf', truncated: extracted.truncated }
    }
    this.cache.set(cacheKey, { version: info.version, outcome })
    return outcome
  }
}

/** `fs.resolve` that answers `undefined` for a path the backend namespace cannot represent. */
async function resolveOrUndefined(
  fs: FileSystem,
  path: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<FsTarget | undefined> {
  try {
    return await fs.resolve(path, signal === undefined ? { cwd } : { cwd, signal })
  } catch {
    // `resolve` rejects for an unsupported path form or one outside the backend
    // namespace; such a token is not a usable reference and is dropped like a
    // mistyped `@` mention.
    return undefined
  }
}

/** `fs.stat` that answers `undefined` on any backend read error, not only absence. */
async function statOrUndefined(fs: FileSystem, target: FsTarget, signal: AbortSignal | undefined) {
  try {
    return await fs.stat(target, signal)
  } catch {
    // A stat that fails on permissions or IO is treated as "nothing to inline
    // here"; the model can still try the read tool explicitly.
    return undefined
  }
}

/** Whole-file bytes, `undefined` when over the byte cap, `null` on any other read failure. */
async function readBytesOrError(
  fs: FileSystem,
  target: FsTarget,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<Uint8Array | undefined | null> {
  try {
    return await fs.readBytes(target, signal, maxBytes)
  } catch (error: unknown) {
    // FS_TOO_LARGE is the size-less-backend path (a known bound, reported as
    // such); any other failure is an unreadable file, reported generically.
    return error instanceof FsError && error.code === 'FS_TOO_LARGE' ? undefined : null
  }
}
