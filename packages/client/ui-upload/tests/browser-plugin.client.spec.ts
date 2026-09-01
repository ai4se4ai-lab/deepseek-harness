// @vitest-environment jsdom
/**
 * ui-upload browser half: `/` source + hidden file input registration, locale
 * dictionary, fiber-teardown removal (HMR safety), the candidate filter, and
 * the pick → native-picker → upload → `@files/…` draft splice contract driven
 * directly on the captured source with fake composer and Remote faces.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CandidateRequest, ClientSessionContext, InputTriggerSource, TokenSpan,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { UploadPutResult } from '@deepseek-ai/dsh-workspace-upload/types'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const sid = (value: string): SessionId => value as SessionId
const session: ClientSessionContext = { sessionId: sid('target') }
const span = (start: number, end: number): TokenSpan => ({ start, end, draftRev: 0 })

function request(query: string): CandidateRequest {
  return { query, quoted: false, position: 'leading', signal: new AbortController().signal }
}

/** A minimal SessionInput fake: mutable draft, snapshot read, and captured notices. */
function fakeComposer(initial = '') {
  let draft = initial
  const notices: { level: string; text: string }[] = []
  return {
    setDraft: (next: string) => { draft = next },
    state: { getSnapshot: () => ({ draft }) },
    notify: (level: string, text: string) => { notices.push({ level, text }) },
    get draft() { return draft },
    notices,
  }
}

type PutResult =
  | { ok: true; value: UploadPutResult }
  | { ok: false; error: { code: string; message: string; details: object } }
type PutFn = (id: SessionId, req: { name: string; dataBase64: string }) => Promise<PutResult>

const putOk: PutFn = () => Promise.resolve({
  ok: true, value: { ok: true, value: { path: 'files/report.pdf', bytes: 12 } },
})

/** Boot the plugin over fake faces and return the source it registers. */
async function bench(put: PutFn = putOk, composer = fakeComposer()): Promise<{
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  source: InputTriggerSource
  composer: ReturnType<typeof fakeComposer>
}> {
  const ctx = new Context()
  let source: InputTriggerSource | undefined
  ctx.provide('inputTriggers', {
    registerSource(candidate: InputTriggerSource) { source = candidate; return () => { source = undefined } },
  })
  ctx.provide('sessions', {
    binding: (id: SessionId) => id === session.sessionId ? { sessionId: id, session: {}, ctx } : undefined,
  })
  ctx.provide('conversation', { input: { for: () => composer } })
  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
  }
  new RemoteService(ctx)
  ctx.provide('remote.workspaceUpload', { put })
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  if (source === undefined) throw new Error('upload source was not registered')
  return { ctx, fiber, source, composer }
}

/** Fire a `change` on the plugin's hidden input with `file` selected (or none). */
function chooseFile(file?: File): void {
  const input = document.querySelector<HTMLInputElement>('[data-dsh-upload-input]')
  if (input === null) throw new Error('hidden upload input is not mounted')
  Object.defineProperty(input, 'files', { value: file === undefined ? [] : [file], configurable: true })
  input.dispatchEvent(new Event('change'))
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const el of document.querySelectorAll('[data-dsh-upload-input]')) el.remove()
})

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual([
      'inputTriggers', 'sessions', 'conversation', 'locale', 'remote', 'remote.workspaceUpload',
    ])
  })

  it('the node half is an inert plugin body', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('registers the "/" upload source and a hidden file input; disposal frees both (HMR safety)', async () => {
    const { fiber, source } = await bench()
    expect(source.trigger).toBe('/')
    expect(source.name).toBe('upload')
    expect(document.querySelectorAll('[data-dsh-upload-input]')).toHaveLength(1)
    await fiber.dispose()
    expect(document.querySelectorAll('[data-dsh-upload-input]')).toHaveLength(0)
  })
})

describe('candidates', () => {
  it('offers the single upload row only while "upload" still starts with the query', async () => {
    const { source } = await bench()
    const [candidate, ...rest] = await source.candidates(session, request('up'))
    expect(rest).toEqual([])
    expect(candidate?.name).toBe('upload')
    expect(candidate?.description).toContain('10.0 MB')
    expect(await source.candidates(session, request('upload'))).toHaveLength(1)
    expect(await source.candidates(session, request('down'))).toEqual([])
  })
})

describe('pick', () => {
  it('onPick opens the native picker and returns "handled"', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    const { source } = await bench()
    const outcome = source.onPick({
      candidate: { name: 'upload' }, session, position: 'leading', via: 'menu', span: span(0, 7),
    })
    expect(outcome).toBe('handled')
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('a chosen file uploads and splices @files/<name> into the draft after clearing /upload', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    const composer = fakeComposer('look at /upload')
    const { source } = await bench(putOk, composer)
    source.onPick({
      candidate: { name: 'upload' }, session, position: 'inline', via: 'menu', span: span(8, 15),
    })
    chooseFile(new File([new Uint8Array(12)], 'report.pdf', { type: 'application/pdf' }))
    await vi.waitFor(() => { expect(composer.draft).toContain('@files/report.pdf') })
    expect(composer.draft.startsWith('look at ')).toBe(true)
    expect(composer.draft).not.toContain('/upload')
    expect(composer.notices.at(-1)?.level).toBe('info')
  })

  it('clears /upload and stays quiet when the picker is dismissed', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    const composer = fakeComposer('/upload')
    const { source } = await bench(putOk, composer)
    source.onPick({
      candidate: { name: 'upload' }, session, position: 'leading', via: 'menu', span: span(0, 7),
    })
    chooseFile(undefined)
    await vi.waitFor(() => { expect(composer.draft).toBe('') })
    expect(composer.notices).toEqual([])
  })

  it('refuses a file over the client size ceiling with an error notice and no upload', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    const put = vi.fn(putOk)
    const composer = fakeComposer('/upload')
    const { source } = await bench(put, composer)
    source.onPick({
      candidate: { name: 'upload' }, session, position: 'leading', via: 'menu', span: span(0, 7),
    })
    chooseFile(new File([new Uint8Array(11 * 1024 * 1024)], 'big.bin'))
    await vi.waitFor(() => { expect(composer.notices.at(-1)?.level).toBe('error') })
    expect(put).not.toHaveBeenCalled()
    expect(composer.draft).not.toContain('@files')
  })

  it('surfaces a host business rejection as an error notice', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    const put: PutFn = () => Promise.resolve({
      ok: true, value: { ok: false, error: { code: 'too-large', message: 'file is too big' } },
    })
    const composer = fakeComposer('/upload')
    const { source } = await bench(put, composer)
    source.onPick({
      candidate: { name: 'upload' }, session, position: 'leading', via: 'menu', span: span(0, 7),
    })
    chooseFile(new File([new Uint8Array(8)], 'x.txt'))
    await vi.waitFor(() => {
      const last = composer.notices.at(-1)
      expect(last?.level).toBe('error')
      expect(last?.text).toContain('too big')
    })
    expect(composer.draft).not.toContain('@files')
  })
})
