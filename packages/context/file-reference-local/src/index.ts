/**
 * Local-filesystem implementation of `ctx.fileReferences`.
 *
 * @module @deepseek-ai/dsh-file-reference-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import FileReferenceService, {
  FILE_REFERENCE_PROMPT,
  type FileReferenceCandidate,
} from '@deepseek-ai/dsh-file-reference'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: pulls the `workspace/file-added` cordis event declaration.
import type {} from '@deepseek-ai/dsh-workspace-upload/types'
import {
  DEFAULT_INLINE_ENABLED,
  DEFAULT_INLINE_MAX_BYTES_PER_FILE,
  DEFAULT_INLINE_MAX_CHARS_PER_FILE,
  DEFAULT_INLINE_MAX_CHARS_TOTAL,
  DEFAULT_INLINE_MAX_FILES,
  type InlineConfig,
  ReferencedFileInliner,
} from './referenced-files.ts'
import {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
  WorkspaceFileSearch,
  type FileSearchConfig,
} from './search.ts'

export {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
  WorkspaceFileSearch,
} from './search.ts'
export type { FileSearchConfig } from './search.ts'
export { collectReferencedPaths, ReferencedFileInliner } from './referenced-files.ts'
export type { InlineConfig } from './referenced-files.ts'
export { FILE_REFERENCE_PROMPT } from '@deepseek-ai/dsh-file-reference'
export { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'

/** Local file-reference discovery configuration. */
export interface Config {
  /** Maximum ranked candidates returned for one query. */
  maxResults?: number
  /** Maximum indexed files and directories per agent workspace. */
  maxEntries?: number
  /** Directory basenames never traversed or offered. */
  excludedDirectories?: string[]
  /** Fold the contents of `@`-referenced files into the runtime context so the model need not call `read`. */
  inlineReferencedFiles?: boolean
  /** Maximum distinct referenced paths inlined per snapshot, newest first. */
  maxInlinedFiles?: number
  /** Byte cap on one referenced file before it is listed by name instead of inlined. */
  maxInlinedBytesPerFile?: number
  /** Character cap on one file's inlined text before a truncation line. */
  maxInlinedCharsPerFile?: number
  /** Character ceiling over every inlined file in one snapshot. */
  maxInlinedCharsTotal?: number
}

/** Local-filesystem owner of the file-reference discovery service. */
export class LocalFileReferenceService extends FileReferenceService {
  static inject = ['agents']
  static Config: z<Config> = z.object({
    maxResults: z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_RESULTS),
    maxEntries: z.number().step(1).min(1).default(DEFAULT_FILE_SEARCH_MAX_ENTRIES),
    excludedDirectories: z.array(z.string()).default([...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES]),
    inlineReferencedFiles: z.boolean().default(DEFAULT_INLINE_ENABLED),
    maxInlinedFiles: z.number().step(1).min(1).default(DEFAULT_INLINE_MAX_FILES),
    maxInlinedBytesPerFile: z.number().step(1).min(1).default(DEFAULT_INLINE_MAX_BYTES_PER_FILE),
    maxInlinedCharsPerFile: z.number().step(1).min(1).default(DEFAULT_INLINE_MAX_CHARS_PER_FILE),
    maxInlinedCharsTotal: z.number().step(1).min(1).default(DEFAULT_INLINE_MAX_CHARS_TOTAL),
  })

  private readonly config: FileSearchConfig
  private readonly inlineConfig: InlineConfig
  private readonly searches = new Map<Agent, WorkspaceFileSearch>()
  private readonly promptFibers = new Map<Agent, ReturnType<Context['inject']>>()
  private readonly promptDisposals = new Set<Promise<void>>()
  private readonly inliners = new Map<Agent, ReferencedFileInliner>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.config = {
      maxResults: config.maxResults ?? DEFAULT_FILE_SEARCH_MAX_RESULTS,
      maxEntries: config.maxEntries ?? DEFAULT_FILE_SEARCH_MAX_ENTRIES,
      excludedDirectories: config.excludedDirectories ?? DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
    }
    validateConfig(this.config)
    this.inlineConfig = {
      enabled: config.inlineReferencedFiles ?? DEFAULT_INLINE_ENABLED,
      maxFiles: config.maxInlinedFiles ?? DEFAULT_INLINE_MAX_FILES,
      maxBytesPerFile: config.maxInlinedBytesPerFile ?? DEFAULT_INLINE_MAX_BYTES_PER_FILE,
      maxCharsPerFile: config.maxInlinedCharsPerFile ?? DEFAULT_INLINE_MAX_CHARS_PER_FILE,
      maxCharsTotal: config.maxInlinedCharsTotal ?? DEFAULT_INLINE_MAX_CHARS_TOTAL,
    }
    validateInlineConfig(this.inlineConfig)

    const installPrompt = (agent: Agent): void => {
      if (this.promptFibers.has(agent)) return
      const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
        scope.systemPrompt.section({
          name: 'context:file-reference',
          order: 99,
          text: () => agent.ctx.tools.get('read', agent) === undefined ? '' : FILE_REFERENCE_PROMPT,
        })
      })
      this.promptFibers.set(agent, fiber)
    }
    const disposePrompt = (agent: Agent): void => {
      const fiber = this.promptFibers.get(agent)
      if (fiber === undefined) return
      this.promptFibers.delete(agent)
      const task = fiber.dispose().catch((error: unknown) => {
        ctx.logger.warn(`file-reference-local: prompt cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      this.promptDisposals.add(task)
      void task.finally(() => {
        this.promptDisposals.delete(task)
      })
    }
    const installInliner = (agent: Agent): void => {
      if (this.inliners.has(agent)) return
      this.inliners.set(agent, new ReferencedFileInliner(agent, this.inlineConfig))
    }
    const disposeInliner = (agent: Agent): void => {
      this.inliners.get(agent)?.dispose()
      this.inliners.delete(agent)
    }
    for (const agent of ctx.agents.list()) {
      installPrompt(agent)
      installInliner(agent)
    }
    ctx.on('agent/created', ({ agent }) => { installPrompt(agent); installInliner(agent) })
    ctx.on('agent/disposed', ({ agent }) => {
      this.searches.get(agent)?.dispose()
      this.searches.delete(agent)
      disposePrompt(agent)
      disposeInliner(agent)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'tool/result') return
      const agent = ctx.agents.get(session.id)
      if (agent !== undefined) this.searches.get(agent)?.invalidate()
    })
    // A user upload writes into `files/` without any tool result; drop the
    // cached index so an `@files/…` completion sees the new file at once.
    ctx.on('workspace/file-added', ({ sessionId }) => {
      const agent = ctx.agents.get(sessionId)
      if (agent !== undefined) this.searches.get(agent)?.invalidate()
    })
    ctx.effect(() => async () => {
      for (const search of this.searches.values()) search.dispose()
      this.searches.clear()
      for (const inliner of this.inliners.values()) inliner.dispose()
      this.inliners.clear()
      const promptFibers = [...this.promptFibers.values()]
      this.promptFibers.clear()
      await Promise.all([
        ...promptFibers.map(fiber => fiber.dispose()),
        ...this.promptDisposals,
      ])
    }, 'file-reference-local: search cache')
  }

  override list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    let search = this.searches.get(agent)
    if (search === undefined) {
      search = new WorkspaceFileSearch(agent.session.header.cwd ?? process.cwd(), this.config)
      this.searches.set(agent, search)
    }
    return search.list(query, signal)
  }
}

function validateConfig(config: FileSearchConfig): void {
  if (!Number.isSafeInteger(config.maxResults) || config.maxResults <= 0) {
    throw new Error('file-reference-local: maxResults must be a positive safe integer')
  }
  if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) {
    throw new Error('file-reference-local: maxEntries must be a positive safe integer')
  }
  if (config.excludedDirectories.some(name => name.length === 0 || name.includes('/') || name.includes('\\'))) {
    throw new Error('file-reference-local: excludedDirectories entries must be non-empty directory basenames')
  }
}

/** Every inline bound counts files, bytes, or characters — a positive safe integer, or the caps misbehave. */
function validateInlineConfig(config: InlineConfig): void {
  const positives: ReadonlyArray<readonly [keyof Config, number]> = [
    ['maxInlinedFiles', config.maxFiles],
    ['maxInlinedBytesPerFile', config.maxBytesPerFile],
    ['maxInlinedCharsPerFile', config.maxCharsPerFile],
    ['maxInlinedCharsTotal', config.maxCharsTotal],
  ]
  for (const [name, value] of positives) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`file-reference-local: ${name} must be a positive safe integer`)
    }
  }
}

export default LocalFileReferenceService
