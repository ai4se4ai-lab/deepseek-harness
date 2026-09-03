import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import LocalFileReferenceService, { collectReferencedPaths } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const PDF_FIXTURE = fileURLToPath(new URL('../../../fs/tool-fs/tests/fixtures/text-layer.pdf', import.meta.url))

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  return ctx
}

async function stubAgent(ctx: Context, id = 'inline-agent'): Promise<{ agent: Agent; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-referenced-files-'))
  roots.push(root)
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: root } })
  const agent = {
    id: session.id, options: {}, session, status: 'idle', acceptsNextStep: false, ctx,
    followup() {}, steer() {}, inject() {}, send() {}, updateInbox() { return 'not-found' as const },
    cancel() {}, whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  ctx.agents.register(agent)
  return { agent, root }
}

function userSays(agent: Agent, text: string): void {
  agent.session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
}

const snapshot = async (ctx: Context, signal?: AbortSignal): Promise<string> =>
  renderContextSnapshot(await ctx.systemPrompt.assemble(signal === undefined ? {} : { signal }))

describe('collectReferencedPaths', () => {
  const session = (texts: Array<{ text: string; plugin?: boolean }>): Parameters<typeof collectReferencedPaths>[0] => ({
    events: texts.map((t, i) => ({
      seq: i,
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: t.text }],
        source: t.plugin === true ? { kind: 'plugin', plugin: 'x' } : { kind: 'user' },
      },
    })),
  }) as never

  it('extracts plain and quoted references, newest first, deduplicated', () => {
    const paths = collectReferencedPaths(
      session([{ text: 'see @docs/a.md and @docs/a.md' }, { text: 'also @"my notes/b.md" please' }]),
      10,
    )
    expect(paths).toEqual(['my notes/b.md', 'docs/a.md'])
  })

  it('ignores plugin-authored messages and strips trailing sentence punctuation', () => {
    const paths = collectReferencedPaths(
      session([
        { text: 'runtime context @internal/state.md', plugin: true },
        { text: 'what is in @report/final.md?' },
      ]),
      10,
    )
    expect(paths).toEqual(['report/final.md'])
  })

  it('honours the limit', () => {
    expect(collectReferencedPaths(session([{ text: '@a @b @c @d' }]), 2)).toEqual(['a', 'b'])
  })
})

describe('ReferencedFileInliner', () => {
  it('folds a referenced markdown file into the runtime context snapshot', async () => {
    const ctx = await harness()
    const { agent, root } = await stubAgent(ctx)
    await writeFile(join(root, 'plan.md'), '# Plan\n\nShip the checklist to 100% of new signups.')
    await ctx.plugin(LocalFileReferenceService)

    userSays(agent, 'Summarise @plan.md')
    // Pass a live signal so the resolve path that forwards it is exercised.
    const text = await snapshot(ctx, new AbortController().signal)
    expect(text).toContain('----- plan.md -----')
    expect(text).toContain('Ship the checklist to 100% of new signups.')
  })

  it("inlines a referenced PDF's extracted text and labels it", async () => {
    const ctx = await harness()
    const { agent, root } = await stubAgent(ctx)
    copyFileSync(PDF_FIXTURE, join(root, 'review.pdf'))
    await ctx.plugin(LocalFileReferenceService)

    userSays(agent, 'What does @review.pdf say?')
    const text = await snapshot(ctx)
    expect(text).toContain('----- review.pdf (extracted text) -----')
    expect(text).toContain('Quarterly Reliability Review')
  })

  it('lists an oversized file by name instead of inlining it', async () => {
    const ctx = await harness()
    const { agent, root } = await stubAgent(ctx)
    await writeFile(join(root, 'big.txt'), 'x'.repeat(4096))
    await ctx.plugin(LocalFileReferenceService, { maxInlinedBytesPerFile: 1024 })

    userSays(agent, 'Check @big.txt')
    const text = await snapshot(ctx)
    expect(text).toMatch(/Referenced but not inlined \(use the read tool\): big\.txt — 4096 bytes exceeds the inline limit/u)
  })

  it('neutralises {{ }} in inlined content so interpolation cannot throw', async () => {
    const ctx = await harness()
    const { agent, root } = await stubAgent(ctx)
    await writeFile(join(root, 'tpl.hbs'), 'Hello {{name}}, your total is {{amount}}.')
    await ctx.plugin(LocalFileReferenceService)

    userSays(agent, 'Explain @tpl.hbs')
    const text = await snapshot(ctx)
    expect(text).toContain('----- tpl.hbs -----')
    const zwsp = String.fromCharCode(0x200b)
    expect(text).not.toContain('{{name}}')
    expect(text).toContain(`Hello {${zwsp}{name}${zwsp}}, your total is {${zwsp}{amount}${zwsp}}.`)
  })

  it('reads each file once across repeated assemblies and stops after disposal', async () => {
    const ctx = await harness()
    const { agent, root } = await stubAgent(ctx)
    await writeFile(join(root, 'doc.md'), 'stable content')
    const readBytes = vi.spyOn(LocalFileSystem.prototype, 'readBytes')
    const fiber = ctx.plugin(LocalFileReferenceService)
    await fiber

    userSays(agent, 'Use @doc.md')
    await snapshot(ctx)
    await snapshot(ctx)
    expect(readBytes).toHaveBeenCalledTimes(1)

    await fiber.dispose()
    expect(await snapshot(ctx)).not.toContain('stable content')
  })

  it('contributes nothing when disabled', async () => {
    const ctx = await harness()
    const { agent, root } = await stubAgent(ctx)
    await writeFile(join(root, 'doc.md'), 'hidden content')
    await ctx.plugin(LocalFileReferenceService, { inlineReferencedFiles: false })

    userSays(agent, 'Use @doc.md')
    expect(await snapshot(ctx)).not.toContain('hidden content')
  })

  it('validates the inline tunables', async () => {
    const cases: Array<[string, Partial<ConstructorParameters<typeof LocalFileReferenceService>[1]>]> = [
      ['maxInlinedFiles', { maxInlinedFiles: 0 }],
      ['maxInlinedCharsPerFile', { maxInlinedCharsPerFile: 0 }],
      ['maxInlinedBytesPerFile', { maxInlinedBytesPerFile: 1.5 }],
      ['maxInlinedCharsTotal', { maxInlinedCharsTotal: 1.5 }],
    ]
    for (const [key, config] of cases) {
      const ctx = await harness()
      expect(() => new LocalFileReferenceService(ctx, config)).toThrow(key)
    }
  })

  it('contributes nothing without a user reference or a session cwd', async () => {
    const ctx = await harness()
    const { agent } = await stubAgent(ctx)
    await ctx.plugin(LocalFileReferenceService)
    expect(await snapshot(ctx)).toBe('')                       // no @ reference yet
    userSays(agent, 'just chatting, no files here')
    expect(await snapshot(ctx)).toBe('')                       // reference regex finds nothing
    userSays(agent, 'look at @nowhere/missing.md')
    expect(await snapshot(ctx)).toBe('')                       // resolves to nothing under cwd
  })

  it('skips a directory reference and one outside the workspace', async () => {
    const ctx = await harness()
    const { agent, root } = await stubAgent(ctx)
    await mkdir(join(root, 'notes'))
    await ctx.plugin(LocalFileReferenceService)
    userSays(agent, 'see @notes and @/etc/hostname')
    const text = await snapshot(ctx)
    expect(text).not.toContain('----- notes')
    expect(text).toContain('/etc/hostname — outside the workspace')
  })

  it('re-extracts a referenced file after its bytes change', async () => {
    const ctx = await harness()
    const { agent, root } = await stubAgent(ctx)
    const p = join(root, 'live.md')
    await writeFile(p, 'first revision')
    await ctx.plugin(LocalFileReferenceService)
    userSays(agent, 'watch @live.md')
    expect(await snapshot(ctx)).toContain('first revision')
    await new Promise(r => setTimeout(r, 12))
    await writeFile(p, 'second revision')
    expect(await snapshot(ctx)).toContain('second revision')
  })

  it('truncates a long file and then reports the total budget as exhausted', async () => {
    const ctx = await harness()
    const { agent, root } = await stubAgent(ctx)
    await writeFile(join(root, 'a.md'), 'A'.repeat(400))
    await writeFile(join(root, 'b.md'), 'B'.repeat(400))
    await ctx.plugin(LocalFileReferenceService, { maxInlinedCharsPerFile: 500, maxInlinedCharsTotal: 120 })
    userSays(agent, 'compare @a.md and @b.md')
    const text = await snapshot(ctx)
    expect(text).toContain('[… truncated; use the read tool for the rest …]')
    expect(text).toMatch(/b\.md — inline budget exhausted/u)
  })

  it('names a referenced binary that has no readable text', async () => {
    const ctx = await harness()
    const { agent, root } = await stubAgent(ctx)
    await writeFile(join(root, 'logo.bin'), Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]))
    await ctx.plugin(LocalFileReferenceService)
    userSays(agent, 'what is @logo.bin')
    const text = await snapshot(ctx)
    expect(text).not.toContain('----- logo.bin')
    expect(text).toMatch(/logo\.bin — .*(?:text|PDF)/u)
  })

  it('stops inlining when the assembly is already aborted', async () => {
    const ctx = await harness()
    const { agent, root } = await stubAgent(ctx)
    await writeFile(join(root, 'doc.md'), 'unreachable while aborted')
    await ctx.plugin(LocalFileReferenceService)
    userSays(agent, 'use @doc.md')
    expect(await snapshot(ctx, AbortSignal.abort())).not.toContain('unreachable while aborted')
  })

  it('installs one inliner per agent and drops it on disposal', async () => {
    const ctx = await harness()
    const { agent, root } = await stubAgent(ctx)
    await writeFile(join(root, 'd.md'), 'kept content')
    await ctx.plugin(LocalFileReferenceService)
    ctx.emit('agent/created', { agent } as never) // second announcement: no-op
    userSays(agent, 'use @d.md')
    expect(await snapshot(ctx)).toContain('kept content')
    ctx.emit('agent/disposed', { agent } as never)
    expect(await snapshot(ctx)).not.toContain('kept content')
  })
})

/** A provider whose primitives can be armed to fail, for the load()-path branches. */
class ArmedFs extends FileSystem {
  mode: 'ok' | 'resolve-throws' | 'stat-throws' | 'no-root' | 'too-large' | 'read-throws' | 'sizeless' = 'ok'
  constructor(ctx: Context) { super(ctx) }
  override async resolve(path: string): Promise<FsTarget> {
    if (this.mode === 'resolve-throws') throw new Error('bad path')
    if (this.mode === 'no-root' && path === '.') throw new Error('no root')
    return { targetKey: FsTargetKey(`k:${path}`), displayPath: path }
  }
  override processPath(t: FsTarget): string { return String(t.targetKey) }
  override fileUrl(t: FsTarget): string { return `file://${String(t.targetKey)}` }
  override contains(): boolean { return true }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    if (this.mode === 'stat-throws') throw new Error('stat failed')
    if (String(target.targetKey) === 'k:.') return { version: FsVersion('v1'), type: 'directory' }
    return { version: FsVersion('v1'), type: 'file', ...this.mode === 'sizeless' ? {} : { size: 12 } }
  }
  override async lstat(): Promise<undefined> { return undefined }
  override async readText(): Promise<string> { return '' }
  override async streamText(): Promise<AsyncIterable<string>> { return (async function* () { /* empty */ })() }
  override async readBytes(): Promise<Uint8Array> {
    if (this.mode === 'too-large') throw new FsError('too large', 'FS_TOO_LARGE')
    if (this.mode === 'read-throws') throw new Error('io error')
    return new TextEncoder().encode('armed body')
  }
  override async listDir(): Promise<never[]> { return [] }
  override writeText(): never { throw new Error('unused') }
  override editText(): never { throw new Error('unused') }
}

describe('ReferencedFileInliner — backend failure paths', () => {
  async function armed(mode: ArmedFs['mode']): Promise<string> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ArmedFs)
    ;(ctx.fs as unknown as ArmedFs).mode = mode
    const session = ctx.sessions.create(SessionId(`armed-${mode}`), { meta: { cwd: '/ws' } })
    const agent = { id: session.id, options: {}, session, status: 'idle', acceptsNextStep: false, ctx, followup() {}, steer() {}, inject() {}, send() {}, updateInbox() { return 'not-found' as const }, cancel() {}, whenIdle: () => Promise.resolve() } as unknown as Agent
    ctx.agents.register(agent)
    await ctx.plugin(LocalFileReferenceService)
    userSays(agent, 'inspect @thing.md')
    return renderContextSnapshot(await ctx.systemPrompt.assemble())
  }

  it('drops a reference whose resolve or stat throws', async () => {
    expect(await armed('resolve-throws')).toBe('')
    expect(await armed('stat-throws')).toBe('')
  })

  it('drops a reference when the workspace root cannot be resolved', async () => {
    expect(await armed('no-root')).toBe('')
  })

  it('names a reference the backend refuses to read', async () => {
    expect(await armed('too-large')).toMatch(/thing\.md — exceeds the inline limit/u)
    expect(await armed('read-throws')).toMatch(/thing\.md — could not be read/u)
  })

  it('inlines a size-less backend read', async () => {
    expect(await armed('sizeless')).toContain('armed body')
  })
})
