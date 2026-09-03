/**
 * The `read` tool's fallback for a file the backend refuses as non-UTF-8: it
 * reads raw bytes once and windows an extracted text layer (a PDF's), so a
 * `.pdf` reads like a `.md`. A layer with no recoverable text re-throws
 * `FS_NOT_TEXT` carrying the reason.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'

const pdf = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))))

interface OneFileConfig { name: string; bytes: Uint8Array; utf8: boolean; readError?: Error }

/** A provider that serves one file, optionally as non-UTF-8 bytes or a hard read error. */
class OneFileFs extends FileSystem {
  bytesRead = 0
  private readonly fileName: string
  private readonly bytes: Uint8Array
  private readonly utf8: boolean
  private readonly readError?: Error | undefined
  constructor(ctx: Context, config: OneFileConfig) {
    super(ctx)
    this.fileName = config.name
    this.bytes = config.bytes
    this.utf8 = config.utf8
    this.readError = config.readError
  }
  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: FsTargetKey(`key:${path}`), displayPath: path }
  }
  override processPath(t: FsTarget): string { return String(t.targetKey) }
  override fileUrl(t: FsTarget): string { return `file://${String(t.targetKey)}` }
  override contains(): boolean { return true }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    return String(target.targetKey) === `key:${this.fileName}`
      ? { version: FsVersion('v1'), type: 'file', size: this.bytes.length }
      : undefined
  }
  override async lstat(): Promise<FsPathInfo | undefined> { return undefined }
  override async readText(target: FsTarget): Promise<string> {
    if (this.readError) throw this.readError
    if (this.utf8) return new TextDecoder().decode(this.bytes)
    throw new FsError(`cannot read "${target.displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
  }
  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const text = await this.readText(target)
    return (async function* () { yield text })()
  }
  override async readBytes(_t: FsTarget, _s: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    this.bytesRead += 1
    if (this.bytes.length > maxBytes) throw new FsError('too large', 'FS_TOO_LARGE')
    return this.bytes
  }
  override async listDir(): Promise<FsDirEntry[]> { return [] }
  override writeText(): never { throw new Error('unused') }
  override editText(): never { throw new Error('unused') }
}

async function setup(config: OneFileConfig, toolFsConfig: Record<string, unknown> = {}): Promise<{ ctx: Context; fs: OneFileFs }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(OneFileFs, config)
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs, toolFsConfig)
  return { ctx, fs: ctx.fs as unknown as OneFileFs }
}

let n = 0
const read = (ctx: Context, file_path: string, extra: Record<string, unknown> = {}) =>
  ctx.tools.execute({ signal: new AbortController().signal, callId: CallId(`c${++n}`), name: 'read', arguments: { file_path, ...extra } })

const bodyText = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.filter(b => b.type === 'text').map(b => b.text).join('')

describe('read tool — non-UTF-8 fallback', () => {
  it('windows a PDF text layer as line-numbered content', async () => {
    const { ctx, fs } = await setup({ name: 'report.pdf', bytes: pdf('text-layer.pdf'), utf8: false })
    const result = await read(ctx, 'report.pdf')
    expect(result.isError).toBe(false)
    const out = bodyText(result)
    expect(out).toContain('<path>report.pdf</path>')
    expect(out).toContain('1: Quarterly Reliability Review')
    expect(out).toContain('99.94 percent')
    expect(fs.bytesRead).toBe(1)
  })

  it('honours offset and limit over the extracted layer', async () => {
    const { ctx } = await setup({ name: 'report.pdf', bytes: pdf('text-layer.pdf'), utf8: false })
    const out = bodyText(await read(ctx, 'report.pdf', { offset: 3, limit: 1 }))
    expect(out).toMatch(/^3: /mu)
    expect(out).not.toContain('1: Quarterly Reliability Review')
  })

  it('errors with the reason when a PDF has no text layer', async () => {
    const { ctx } = await setup({ name: 'scan.pdf', bytes: pdf('no-text-layer.pdf'), utf8: false })
    const result = await read(ctx, 'scan.pdf')
    expect(result.isError).toBe(true)
    expect(bodyText(result)).toMatch(/scanned or image-only/u)
  })

  it('still reads a normal UTF-8 file without touching the byte path', async () => {
    const { ctx, fs } = await setup({ name: 'a.txt', bytes: new TextEncoder().encode('one\ntwo'), utf8: true })
    expect(bodyText(await read(ctx, 'a.txt'))).toContain('1: one')
    expect(fs.bytesRead).toBe(0)
  })

  it('keeps the backend error for a non-PDF binary', async () => {
    const { ctx } = await setup({ name: 'logo.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), utf8: false })
    const result = await read(ctx, 'logo.png')
    expect(result.isError).toBe(true)
    expect(bodyText(result)).toContain('invalid UTF-8 text')
  })

  it('rethrows a read error that is not FS_NOT_TEXT without touching the byte path', async () => {
    const { ctx, fs } = await setup({
      name: 'x.txt', bytes: new Uint8Array(), utf8: false,
      readError: new Error('disk unavailable'),
    })
    const result = await read(ctx, 'x.txt')
    expect(result.isError).toBe(true)
    expect(bodyText(result)).toContain('disk unavailable')
    expect(fs.bytesRead).toBe(0)
  })

  it('appends a truncation line when the extracted layer exceeds the char cap', async () => {
    const { ctx } = await setup(
      { name: 'long.pdf', bytes: pdf('text-layer.pdf'), utf8: false },
      { readExtractMaxChars: 40 },
    )
    const out = bodyText(await read(ctx, 'long.pdf'))
    expect(out).toContain('document text truncated at 40 characters')
  })
})
