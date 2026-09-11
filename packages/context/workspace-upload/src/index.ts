/**
 * User file uploads into the session workspace.
 *
 * The composer's `/upload` command sends one chosen file here as base64; this
 * service decodes it, enforces the byte ceiling and a strict basename policy,
 * and writes it under `<session cwd>/files/`. The file then reaches the model
 * the same way any `@path` reference does — the user (or the `/upload` command
 * on their behalf) mentions `@files/<name>` and the model reads it.
 *
 * @module @deepseek-ai/dsh-workspace-upload
 */

import { Buffer } from 'node:buffer'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { UploadPutRequest, UploadPutResult, UploadRejectCode } from './types.ts'

export type * from './types.ts'

/** The workspace subdirectory every upload lands in, relative to the session cwd. */
export const UPLOAD_SUBDIR = 'files'

/** Default ceiling on one decoded upload, in bytes (10 MiB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Required deployment policy. */
export interface Config {
  /** Maximum decoded byte length accepted for one upload. */
  readonly maxBytes: number
}

/** Largest disambiguation suffix tried before a collision is a write failure. */
const MAX_COLLISION_ATTEMPTS = 999

/** Base64 alphabet with optional padding, after whitespace is stripped. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/u

/** Whether a string carries any C0 control character or DEL (0x00–0x1f, 0x7f). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceUpload: WorkspaceUploadService
  }
}

/** One rejection with a stable code and a composer-safe message. */
function reject(code: UploadRejectCode, message: string, maxBytes?: number): UploadPutResult {
  return { ok: false, error: maxBytes === undefined ? { code, message } : { code, message, maxBytes } }
}

/**
 * Validate a chosen file name as a bare basename. Path separators, traversal,
 * and control characters are refused; surrounding whitespace is trimmed.
 * @param raw - the `name` field as the client sent it.
 * @returns the safe basename, or a rejection.
 */
function safeName(raw: string): { ok: true; name: string } | { ok: false; result: UploadPutResult } {
  const name = raw.trim()
  const bad = (message: string): { ok: false; result: UploadPutResult } =>
    ({ ok: false, result: reject('invalid-name', message) })
  if (name.length === 0) return bad('file name is empty')
  if (name.length > 255) return bad('file name is too long')
  if (name.includes('/') || name.includes('\\')) return bad('file name must not contain a path separator')
  if (name === '.' || name === '..' || name.startsWith('..')) return bad('file name must not reference a parent directory')
  if (hasControlChar(name)) return bad('file name contains a control character')
  return { ok: true, name }
}

/** Decode canonical base64, rejecting a payload that is not base64 at all. */
function decodeBase64(dataBase64: string): { ok: true; bytes: Buffer } | { ok: false; result: UploadPutResult } {
  const compact = dataBase64.replace(/\s+/gu, '')
  if (!BASE64_RE.test(compact) || compact.length % 4 !== 0) {
    return { ok: false, result: reject('invalid-encoding', 'upload data was not valid base64') }
  }
  return { ok: true, bytes: Buffer.from(compact, 'base64') }
}

/** Insert a ` (n)` disambiguation suffix before the extension. */
function disambiguate(name: string, attempt: number): string {
  const ext = extname(name)
  const stem = ext.length > 0 ? name.slice(0, -ext.length) : name
  return `${stem} (${String(attempt)})${ext}`
}

/** Whether a path names an existing filesystem entry. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Host service for user file uploads into a session workspace.
 * It resolves the target session's cwd from the wire identity and never
 * creates or resumes an Agent of its own.
 */
export class WorkspaceUploadService extends TypertRemoteService {
  static inject = ['agents']

  static Config: s<Config> = s.object({
    maxBytes: s.number().step(1).min(1).default(DEFAULT_MAX_UPLOAD_BYTES),
  })

  private readonly maxBytes: number

  /**
   * @param ctx - Host context.
   * @param config - Required byte-ceiling policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'workspaceUpload')
    this.maxBytes = Number.isSafeInteger(config.maxBytes) && config.maxBytes > 0
      ? config.maxBytes
      : DEFAULT_MAX_UPLOAD_BYTES
  }

  /**
   * Decode, validate, and write one uploaded file under `<cwd>/files/`.
   * @param agent - exact live Agent resolved from the wire identity; its
   *   session cwd bounds the write.
   * @param request - the chosen file's name and base64 bytes.
   * @returns the stored workspace-relative path and size, or a stable failure.
   */
  @Remote('put')
  async put(agent: Agent, request: UploadPutRequest): Promise<UploadPutResult> {
    const named = safeName(request.name)
    if (!named.ok) return named.result

    const decoded = decodeBase64(request.dataBase64)
    if (!decoded.ok) return decoded.result
    if (decoded.bytes.byteLength > this.maxBytes) {
      return reject(
        'too-large',
        `file is ${String(decoded.bytes.byteLength)} bytes; the limit is ${String(this.maxBytes)} bytes`,
        this.maxBytes,
      )
    }

    const cwd = agent.session.header.cwd
    if (cwd === undefined || cwd.length === 0) {
      return reject('no-workspace', 'this session has no working directory to upload into')
    }

    try {
      const filesDir = join(cwd, UPLOAD_SUBDIR)
      await mkdir(filesDir, { recursive: true })
      // Guard against `cwd` or `files/` being a symlink that escapes the
      // workspace: the real target directory must sit directly under the real cwd.
      const realCwd = await realpath(cwd)
      const realFilesDir = await realpath(filesDir)
      if (realFilesDir !== join(realCwd, UPLOAD_SUBDIR)) {
        return reject('write-failed', 'the workspace files directory is outside the session workspace')
      }

      let target = join(realFilesDir, named.name)
      for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS && await exists(target); attempt++) {
        target = join(realFilesDir, disambiguate(named.name, attempt))
        if (attempt === MAX_COLLISION_ATTEMPTS && await exists(target)) {
          return reject('write-failed', 'too many files with this name already exist')
        }
      }
      // Belt and braces: the resolved target cannot leave `files/`.
      if (resolve(target) !== target || !target.startsWith(realFilesDir + sep)) {
        return reject('write-failed', 'resolved upload path escaped the workspace files directory')
      }

      await writeFile(target, decoded.bytes, { flag: 'wx' })

      const finalName = target.slice(realFilesDir.length + 1)
      const path = `${UPLOAD_SUBDIR}/${finalName}`
      this.ctx.emit('workspace/file-added', { sessionId: agent.session.id, path })
      return { ok: true, value: { path, bytes: decoded.bytes.byteLength } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`workspace-upload: write failed: ${message}`)
      return reject('write-failed', 'the file could not be written to the workspace')
    }
  }
}

export default WorkspaceUploadService
