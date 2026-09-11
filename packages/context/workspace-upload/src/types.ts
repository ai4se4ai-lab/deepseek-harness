/**
 * Public request, value, and failure vocabulary for user file uploads into the
 * session workspace. Types only, so generated Remote clients can consume it
 * without importing Host runtime code.
 * @module @deepseek-ai/dsh-workspace-upload/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One file the user chose in the composer, carried as canonical base64. */
export interface UploadPutRequest {
  /** Display name of the chosen file; interpreted as a bare basename, never a path. */
  readonly name: string
  /** Canonical base64 encoding of the file bytes (no data-URI prefix). */
  readonly dataBase64: string
}

/** The stored file's workspace-relative location and decoded size. */
export interface UploadPutValue {
  /** Path relative to the session cwd, always under `files/` (e.g. `files/report.pdf`). */
  readonly path: string
  /** Decoded byte length written to disk. */
  readonly bytes: number
}

/** Stable business failure codes for {@link UploadPutResult}. */
export type UploadRejectCode =
  /** The decoded payload exceeds the configured byte ceiling. */
  | 'too-large'
  /** `name` is empty, contains a path separator or `..`, or has a control character. */
  | 'invalid-name'
  /** `dataBase64` is not valid base64. */
  | 'invalid-encoding'
  /** The addressed session has no working directory to write into. */
  | 'no-workspace'
  /** The filesystem write itself failed (permissions, disk, realpath escape). */
  | 'write-failed'

/** One rejected upload with a stable, user-presentable reason. */
export interface UploadRejected {
  readonly ok: false
  readonly error: {
    readonly code: UploadRejectCode
    /** Human-readable, safe to show in a composer notice. */
    readonly message: string
    /** Present for `too-large`: the ceiling that was exceeded. */
    readonly maxBytes?: number
  }
}

/** One successful upload. */
export interface UploadAccepted {
  readonly ok: true
  readonly value: UploadPutValue
}

/** Result of the `workspaceUpload.put` operation. */
export type UploadPutResult = UploadAccepted | UploadRejected

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One file was written into a session's `files/` workspace directory by a
     * user action (not the model). Host-internal and one-way: file-reference
     * discovery listens for it to drop its cached workspace index so an
     * `@files/…` completion sees the new file without waiting for the next
     * tool result.
     * @param payload - the session whose workspace changed and the new
     *   workspace-relative path.
     * @mode normal
     */
    'workspace/file-added'(payload: { readonly sessionId: SessionId; readonly path: string }): void
  }
}
