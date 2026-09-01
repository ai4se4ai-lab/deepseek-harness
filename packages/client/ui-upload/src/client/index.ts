/**
 * `/upload` command, browser half.
 *
 * Registers a `/` input-trigger source whose single candidate opens a native
 * file picker. The chosen file is read as base64 and sent to the host
 * `workspaceUpload.put` Remote, which writes it under `<session cwd>/files/`.
 * On success the source splices an `@files/<name>` reference into the draft, so
 * the file rides the ordinary `@path` pipeline into the model's next turn — the
 * host `file-reference` guidance tells the model to `read` it.
 *
 * The picker is driven from a persistent hidden `<input type="file">` the
 * plugin owns for its lifetime; `onPick` clicks it inside the menu-pick user
 * gesture. Playwright drives the same element with `setInputFiles`, bypassing
 * the OS dialog.
 *
 * @module @deepseek-ai/dsh-client-ui-upload/client
 */
// Type-only: pulls the generated Remote API and the ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the conversation plugin's Context merge (ctx.conversation).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ClientSessionContext, InputTriggerServiceContract, InputTriggerSource, TokenSpan,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { UploadPutResult } from '@deepseek-ai/dsh-workspace-upload/types'
import { en, NS, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The `/upload` command's menu row and composer notices. */
    upload: import('./locales.ts').UploadKey
  }
}

/**
 * Client courtesy pre-check only; `@deepseek-ai/dsh-workspace-upload`'s
 * `maxBytes` config is the authority and re-checks the decoded payload.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Required services: the trigger registry, the Remote namespace, the composer face, and the copy. */
export const inject = ['inputTriggers', 'sessions', 'conversation', 'locale', 'remote', 'remote.workspaceUpload']

/** One `KiB`/`MiB` rounding for notice copy. */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${String(bytes)} B`
}

/** Read a File as canonical base64 (the data-URI prefix stripped). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(new Error('read failed')) }
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : ''
      const comma = value.indexOf(',')
      resolve(comma >= 0 ? value.slice(comma + 1) : value)
    }
    reader.readAsDataURL(file)
  })
}

/** Append `mention` to `draft` with exactly one separating space and a trailing space. */
function withMention(draft: string, mention: string): string {
  const head = draft.replace(/\s+$/u, '')
  return head.length === 0 ? `${mention} ` : `${head} ${mention} `
}

/** Remove `[span.start, span.end)` from `draft` when it still looks like the `/upload` token. */
function stripTriggerToken(draft: string, span: TokenSpan): string {
  const slice = draft.slice(span.start, span.end)
  if (!/^\/\S*$/u.test(slice)) return draft
  return draft.slice(0, span.start) + draft.slice(span.end)
}

/** Client plugin body: register the `/` upload source and its hidden file input. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-upload: dictionaries')
  const t = ctx.locale.bind(NS)

  const inputTriggers: InputTriggerServiceContract | undefined = ctx.get('inputTriggers')
  if (inputTriggers === undefined) return

  // One hidden picker for the plugin's lifetime; `onPick` clicks it inside the
  // menu-pick user gesture so the browser opens the OS dialog.
  let fileInput: HTMLInputElement | undefined
  /** The session and trigger span captured when the picker was opened. */
  let pending: { sessionId: ClientSessionContext['sessionId']; span: TokenSpan } | undefined

  /** Resolve the per-session composer face for draft writes and notices. */
  function composerFor(sessionId: ClientSessionContext['sessionId']) {
    const sessions = ctx.get('sessions')
    const actx = sessions?.binding(sessionId)?.ctx
    if (actx === undefined) return undefined
    return ctx.get('conversation')?.input.for(actx)
  }

  /** Drop the `/upload` token; used on both a chosen file and a dismissed dialog. */
  function clearTriggerToken(claim: { sessionId: ClientSessionContext['sessionId']; span: TokenSpan }): void {
    const composer = composerFor(claim.sessionId)
    if (composer !== undefined) {
      composer.setDraft(stripTriggerToken(composer.state.getSnapshot().draft, claim.span))
    }
  }

  function onPickerDismissed(): void {
    const claim = pending
    pending = undefined
    if (claim !== undefined) clearTriggerToken(claim)
  }

  async function onFileChosen(): Promise<void> {
    const claim = pending
    pending = undefined
    const file = fileInput?.files?.[0]
    if (claim === undefined) return
    clearTriggerToken(claim)
    if (file === undefined) return
    const composer = composerFor(claim.sessionId)

    if (file.size > MAX_UPLOAD_BYTES) {
      composer?.notify('error', t('notice.tooLarge', {
        name: file.name, size: humanBytes(file.size), limit: humanBytes(MAX_UPLOAD_BYTES),
      }))
      return
    }

    let dataBase64: string
    try {
      dataBase64 = await readAsBase64(file)
    } catch {
      composer?.notify('error', t('notice.readFailed', { name: file.name }))
      return
    }

    const call = await ctx.remote.workspaceUpload.put(claim.sessionId, { name: file.name, dataBase64 })
    if (!call.ok) {
      composer?.notify('error', t('notice.failed', { reason: call.error.message }))
      return
    }
    const outcome: UploadPutResult = call.value
    if (!outcome.ok) {
      composer?.notify('error', t('notice.failed', { reason: outcome.error.message }))
      return
    }

    const { path } = outcome.value
    const mention = formatFileMention({ kind: 'file', path }, false) ?? `@${path}`
    if (composer !== undefined) {
      composer.setDraft(withMention(composer.state.getSnapshot().draft, mention))
      composer.notify('info', t('notice.uploaded', { path }))
    }
  }

  ctx.effect(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.style.display = 'none'
    input.setAttribute('data-dsh-upload-input', '')
    const changeHandler = (): void => { void onFileChosen() }
    const cancelHandler = (): void => { onPickerDismissed() }
    input.addEventListener('change', changeHandler)
    input.addEventListener('cancel', cancelHandler)
    document.body.appendChild(input)
    fileInput = input
    return () => {
      input.removeEventListener('change', changeHandler)
      input.removeEventListener('cancel', cancelHandler)
      input.remove()
      fileInput = undefined
      pending = undefined
    }
  }, 'ui-upload: file input')

  const source: InputTriggerSource = {
    trigger: '/',
    name: 'upload',
    order: 3,
    candidates(_session, { query }) {
      if (!'upload'.startsWith(query)) return Promise.resolve([])
      return Promise.resolve([{
        name: 'upload',
        description: t('menu.description', { limit: humanBytes(MAX_UPLOAD_BYTES) }),
      }])
    },
    onPick({ session, span }) {
      if (fileInput === undefined) return undefined
      pending = { sessionId: session.sessionId, span }
      fileInput.value = ''
      fileInput.click()
      return 'handled'
    },
  }

  ctx.effect(() => inputTriggers.registerSource(source), 'ui-upload: source')
}
