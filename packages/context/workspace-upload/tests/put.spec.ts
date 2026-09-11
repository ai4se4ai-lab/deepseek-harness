import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UploadPutResult } from '../src/index.ts'
import WorkspaceUploadService, { DEFAULT_MAX_UPLOAD_BYTES } from '../src/index.ts'

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose().catch(() => undefined)))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A service bound to a fresh Context, plus a fake Agent whose session cwd is `cwd`. */
function setup(cwd: string | undefined, maxBytes = DEFAULT_MAX_UPLOAD_BYTES): {
  service: WorkspaceUploadService
  agent: Agent
  events: { sessionId: SessionId; path: string }[]
} {
  const ctx = new Context()
  contexts.push(ctx)
  const events: { sessionId: SessionId; path: string }[] = []
  ctx.on('workspace/file-added', (payload) => { events.push(payload) })
  const service = new WorkspaceUploadService(ctx, { maxBytes })
  const agent = { session: { id: SessionId('s-1'), header: { cwd } } } as unknown as Agent
  return { service, agent, events }
}

/** base64 of `size` filler bytes. */
function payload(size: number): string {
  return Buffer.alloc(size, 0x61).toString('base64')
}

/** Narrow a result to its rejection arm or fail the test. */
function rejection(result: UploadPutResult): Extract<UploadPutResult, { ok: false }> {
  if (result.ok) throw new Error(`expected a rejection, got ${JSON.stringify(result)}`)
  return result
}

describe('workspaceUpload.put', () => {
  it('writes the decoded bytes under files/ and emits workspace/file-added', async () => {
    root = await mkdtemp(join(tmpdir(), 'wu-'))
    const { service, agent, events } = setup(root)

    const result = await service.put(agent, { name: 'notes.txt', dataBase64: payload(1024) })

    expect(result).toEqual({ ok: true, value: { path: 'files/notes.txt', bytes: 1024 } })
    expect(await readFile(join(root, 'files', 'notes.txt'))).toHaveLength(1024)
    expect(events).toEqual([{ sessionId: 's-1', path: 'files/notes.txt' }])
  })

  it('rejects a payload over the byte ceiling and writes nothing', async () => {
    root = await mkdtemp(join(tmpdir(), 'wu-'))
    const { service, agent, events } = setup(root, 4096)

    const error = rejection(await service.put(agent, { name: 'big.bin', dataBase64: payload(4097) })).error

    expect(error.code).toBe('too-large')
    expect(error.maxBytes).toBe(4096)
    expect(error.message).toContain('4097')
    expect(events).toEqual([])
  })

  it('rejects names with a separator, parent traversal, or a control character', async () => {
    root = await mkdtemp(join(tmpdir(), 'wu-'))
    const { service, agent } = setup(root)

    for (const name of ['../evil.txt', 'a/b.txt', 'c\\d.txt', '..', 'tab\there.txt']) {
      const error = rejection(await service.put(agent, { name, dataBase64: payload(8) })).error
      expect(error.code).toBe('invalid-name')
    }
  })

  it('rejects a payload that is not base64', async () => {
    root = await mkdtemp(join(tmpdir(), 'wu-'))
    const { service, agent } = setup(root)

    const error = rejection(await service.put(agent, { name: 'x.txt', dataBase64: 'not*base*64' })).error

    expect(error.code).toBe('invalid-encoding')
  })

  it('rejects a session with no working directory', async () => {
    const { service, agent } = setup(undefined)

    const error = rejection(await service.put(agent, { name: 'x.txt', dataBase64: payload(8) })).error

    expect(error.code).toBe('no-workspace')
  })

  it('disambiguates a name collision with a " (n)" suffix', async () => {
    root = await mkdtemp(join(tmpdir(), 'wu-'))
    await writeFile(join(root, '.keep'), '')
    const { service, agent } = setup(root)

    const first = await service.put(agent, { name: 'report.pdf', dataBase64: payload(10) })
    const second = await service.put(agent, { name: 'report.pdf', dataBase64: payload(20) })

    expect(first).toEqual({ ok: true, value: { path: 'files/report.pdf', bytes: 10 } })
    expect(second).toEqual({ ok: true, value: { path: 'files/report (1).pdf', bytes: 20 } })
  })
})
