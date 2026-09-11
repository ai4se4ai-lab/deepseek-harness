/**
 * One credentials document on disk, with the reviewed read-modify-write
 * discipline of `@deepseek-ai/dsh-credentials-local` but no Cordis `Service`
 * identity and no environment/`.env` layering — those belong to the tenant
 * provider that owns a store per tenant (see `./index.ts`).
 *
 * A store is the file layer only: it reads, edits (comment-preserving), and
 * persists `<file>` at mode `0600` under a cross-process writer lock, and
 * publishes committed changes through the two `notify*` hooks. Parsing and the
 * pre-release flat-layout migration are reused verbatim from
 * `@deepseek-ai/dsh-credentials-local`; only the small comment-preserving
 * render helpers and the storable-value assertions are re-implemented here,
 * kept byte-aligned with that package's private helpers.
 * @module @mindportalix/dsh-tenant-credentials-local/local-store
 */

import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { type FSWatcher, watch as chokidarWatch } from 'chokidar'
import { Document, isMap, isScalar, parseDocument } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { canonicalizeWatchPath } from '@deepseek-ai/dsh-home-paths'
import { credentialRef, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  ApiKeyRecord,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
} from '@deepseek-ai/dsh-credentials'
import {
  DOCUMENT_VERSION,
  parseCredentialsDocument,
  renderFlatLayoutMigration,
} from '@deepseek-ai/dsh-credentials-local'

/**
 * How long a write waits for the cross-process document lock. A record
 * mutation runs its caller's decision — which for a token refresh includes a
 * network round trip — while holding the lock, so every writer of this
 * document is sized by that longest holder. Fixed with the write protocol,
 * exactly as in `@deepseek-ai/dsh-credentials-local`.
 */
const DOCUMENT_LOCK_WAIT_MS = 30_000

/** Permission bits outside the owner; a credentials document must have none of them. */
const GROUP_OTHER_BITS = 0o077

/** Minimal logger surface a store needs for non-fatal watcher/reload diagnostics. */
export interface StoreLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Commit-time hooks: a store fans a committed change out through these. */
export interface LocalCredentialStoreHooks {
  /** Non-fatal diagnostics (watcher errors, kept-last-good reloads, flat migration). */
  logger: StoreLogger
  /** Called after a reference write, delete, or observed external change commits. */
  notifyRef(ref: CredentialRef): void
  /** Called after a record write, delete, or observed external change commits. */
  notifyRecord(key: CredentialKey): void
}

/* jscpd:ignore-start -- these module helpers are a deliberate, byte-aligned
   fork of `@deepseek-ai/dsh-credentials-local`'s private helpers (its parser and
   flat-layout migration are imported above rather than copied; these small
   render/assert helpers are not exported by that package). Keeping them
   identical is the point — this is the "narrow, auditable diff against
   upstream" pattern the tenant packages use — so clone detection against that
   file is expected, not a smell to extract. */
/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Reject a credentials document other OS users can read, before its contents
 * are read at all. The store creates and replaces the file at `0600`, but a
 * hand-written or externally generated one carries whatever umask produced it.
 * POSIX only: Windows has no mode to inspect.
 * @param filename - absolute path of the document.
 * @throws when the path hierarchy is invalid or the file exists with group or other bits set.
 */
async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (!isENOENT(error)) throw error
    await canonicalizeWatchPath(filename)
    return
  }
  /* v8 ignore next -- POSIX coverage cannot take the Windows peer. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- Windows has no POSIX mode enforcement. */
  const offending = mode & GROUP_OTHER_BITS
  if (offending === 0) return
  throw new Error(
    `tenant-credentials-local: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
    + ` run "chmod 600 ${filename}" before starting again`,
  )
  /* v8 ignore stop */
}

/**
 * The comment-preserving mutable tree one edit renders from; an absent
 * document starts a fresh one, stamped with this build's version.
 * @param text - the current document text, `undefined` while the file is absent.
 * @returns the tree to edit.
 */
function mutableDocument(text: string | undefined): Document {
  const document = text === undefined ? new Document({}) : parseDocument(text)
  document.setIn(['version'], DOCUMENT_VERSION)
  return document
}

/**
 * Remove one entry from a section, taking a section-level annotation with it
 * when the removed entry was the first — leaving it behind would re-annotate
 * whichever entry became first.
 * @param document - the mutable tree being edited.
 * @param section - the section holding the entry.
 * @param key - the entry to remove.
 */
function deleteSectionEntry(document: Document, section: 'refs' | 'records', key: string): void {
  const map: unknown = document.get(section, true)
  /* v8 ignore next -- callers render a delete only for an entry found in the parsed snapshot. */
  if (isMap(map)) {
    const first = map.items[0]
    /* v8 ignore next -- a map holding the entry has a first item with a scalar key. */
    if (first !== undefined && isScalar(first.key) && first.key.value === key) {
      map.commentBefore = null
    }
  }
  document.deleteIn([section, key])
}

/** Render the next document text with one reference set (`value`) or deleted (`undefined`). */
function renderRef(text: string | undefined, ref: CredentialRef, value: string | undefined): string {
  const document = mutableDocument(text)
  if (value === undefined) deleteSectionEntry(document, 'refs', ref)
  else document.setIn(['refs', ref], value)
  return document.toString()
}

/** Render the next document text with one record written or deleted; the node is replaced wholesale. */
function renderRecord(text: string | undefined, key: CredentialKey, record: CredentialRecord | undefined): string {
  const document = mutableDocument(text)
  if (record === undefined) deleteSectionEntry(document, 'records', key)
  else document.setIn(['records', key], record)
  return document.toString()
}

/**
 * Reject a payload that cannot survive a JSON round trip, in either direction:
 * a document may spell a non-finite number or a cycle, and an owner may hand
 * over a value JSON has no faithful spelling for. Neither the value nor any
 * nested value is quoted in a diagnostic.
 * @param where - the subject named in a diagnostic, already free of any value.
 * @param value - the payload or nested value to admit.
 * @param seen - objects on the current path, for cycle detection.
 */
export function assertJsonValue(where: string, value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new TypeError(`tenant-credentials-local: ${where} holds a non-finite number`)
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError(`tenant-credentials-local: ${where} is cyclic`)
    if (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)) {
      seen.add(value)
      for (const nested of Object.values(value)) assertJsonValue(where, nested, seen)
      seen.delete(value)
      return
    }
  }
  throw new TypeError(`tenant-credentials-local: ${where} holds a value JSON cannot represent`)
}

/**
 * Refuse an api-key record the read path could not admit, before it is
 * rendered: an empty key, an env name outside the reference grammar, or an
 * empty env value would persist a document the next boot rejects.
 * @param key - the record's credential key, for the failure message.
 * @param record - the api-key record a mutation returned.
 */
export function assertStorableApiKey(key: CredentialKey, record: ApiKeyRecord): void {
  if (record.key !== undefined && record.key.length === 0) {
    throw new TypeError(`tenant-credentials-local: record "${key}" has an empty key; omit the field instead`)
  }
  for (const [name, value] of Object.entries(record.env ?? {})) {
    credentialRef(name)
    if (value.length === 0) {
      throw new TypeError(`tenant-credentials-local: record "${key}" env "${name}" must be a non-empty string`)
    }
  }
}

/**
 * Structural equality over two admitted JSON values; key order is ignored
 * because an external editor may reorder a record's fields without changing
 * what it stores.
 * @param left - one value.
 * @param right - the other value.
 * @returns whether the two carry the same JSON content.
 */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => key in right
    && sameJsonValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}
/* jscpd:ignore-end */

/**
 * File-backed credentials document. One instance owns one path; the tenant
 * provider keeps a `Map<tenantId, LocalCredentialStore>` and a shared-root
 * store for the no-tenant fallback.
 */
export class LocalCredentialStore {
  /** Absolute path of the document this store owns. */
  readonly filename: string

  private readonly hooks: LocalCredentialStoreHooks
  /** Raw text of the last read or persisted document; `undefined` while absent. Watcher no-op key and self-write suppression. */
  private text: string | undefined
  /** Parsed reference snapshot; replaced wholesale on every reload. */
  private values = new Map<string, string>()
  /** Parsed record snapshot; replaced wholesale on every reload. */
  private records = new Map<string, CredentialRecord>()
  /** Single exclusive operation chain: watcher reloads and line edits run one at a time in queue order. */
  private operations: Promise<void> = Promise.resolve()
  /** Set at close: refuse new writes and let in-flight work no-op. */
  private closed = false
  /** Shared in-flight boot read; `start()` is idempotent. */
  private startPromise: Promise<void> | undefined
  private watcher: FSWatcher | undefined

  /**
   * @param filename - the document path; resolved against the current directory.
   * @param hooks - commit fan-out and non-fatal diagnostics.
   */
  constructor(filename: string, hooks: LocalCredentialStoreHooks) {
    this.filename = resolve(filename)
    this.hooks = hooks
  }

  /**
   * Boot read, idempotent and safe under concurrent callers. An absent file is
   * an empty store; an invalid one rejects, because a document that exists but
   * cannot be trusted must never read as "no credentials stored". The
   * recognized pre-release flat layout is upgraded in place first.
   */
  start(): Promise<void> {
    this.startPromise ??= this.loadInitial()
    return this.startPromise
  }

  /**
   * Watch the document and publish external edits. Used only by the shared
   * no-tenant store — one process serves every tenant, so a tenant store's
   * own in-process writes already update its snapshot and it never watches.
   * @param debounceMs - watcher write-settle window.
   * @returns a disposer that stops the watcher and drains queued work.
   */
  /* jscpd:ignore-start -- the watcher setup, the operation queue, and the
     reload/reconcile lifecycle below are the same reviewed contract as
     `@deepseek-ai/dsh-credentials-local` (and, through it, `dsh-settings-file`),
     deliberately mirrored; the only divergence is per-file rather than
     per-service ownership. Extracting a shared helper would couple three
     packages' teardown semantics. */
  async startWatch(debounceMs: number): Promise<() => Promise<void>> {
    const watcher = chokidarWatch(await canonicalizeWatchPath(this.filename), {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: debounceMs,
        pollInterval: Math.max(1, Math.min(debounceMs, 10)),
      },
    })
    this.watcher = watcher
    watcher.on('all', () => {
      if (this.closed) return
      this.queueRefresh()
    })
    watcher.on('ready', () => {
      // The initial load raced the watcher's own setup; one reconcile closes the gap.
      if (this.closed) return
      this.queueRefresh()
    })
    watcher.on('error', (error) => {
      this.hooks.logger.warn('tenant-credentials-local: watcher error on %s', this.filename)
      this.hooks.logger.warn(String(error))
    })
    return async () => {
      this.closed = true
      await watcher.close()
      await this.operations
    }
  }

  /** The file-layer value for a reference, or `undefined` when this document does not carry it. */
  getRef(ref: CredentialRef): string | undefined {
    return this.values.get(ref)
  }

  /** One stored record, as its owner wrote it. */
  readRecord(key: CredentialKey): CredentialRecord | undefined {
    return this.records.get(key)
  }

  /**
   * Presence and discriminant for one record; no layer ranks above the
   * document for a record, so presence alone is the whole fact.
   * @param key - the record to describe.
   * @returns the record's configured state, discriminant, and writability.
   */
  describeRecord(key: CredentialKey): CredentialRecordInfo {
    const stored = this.records.get(key)
    if (stored === undefined) return { configured: false, writable: true }
    return { configured: true, kind: stored.kind, writable: true }
  }

  /**
   * Enumerate every stored record's address and tag; the parser has proven
   * each stored key addressable.
   * @returns one entry per stored record, values excluded.
   */
  listRecords(): CredentialRecordEntry[] {
    return [...this.records].map(([key, record]) => ({ key: parseCredentialKey(key), kind: record.kind }))
  }

  /**
   * Queue one reference write (`value`) or delete (`undefined`) behind every
   * earlier operation. `assertWritable` runs inside the lock so a change to
   * the shadowing environment while the edit was queued is re-judged.
   * @param ref - the reference to write.
   * @param value - the new value, or `undefined` to delete the key.
   * @param assertWritable - throws when a read-only layer would shadow this write.
   */
  async setRef(ref: CredentialRef, value: string | undefined, assertWritable: () => void): Promise<void> {
    const verb = value === undefined ? 'unset' : 'set'
    if (this.closed) throw new Error(`tenant-credentials-local is closed: cannot ${verb} "${ref}"`)
    return this.enqueue(async () => {
      if (this.closed) throw new Error(`tenant-credentials-local was closed before the queued "${ref}" ${verb} ran`)
      assertWritable()
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      await withFileLock(this.filename, async () => {
        await this.reconcileFromDisk()
        const existing = this.values.get(ref)
        if (value === undefined && existing === undefined) return
        const nextText = renderRef(this.text, ref, value)
        await writeFileAtomic(this.filename, nextText, { mode: 0o600, dirMode: 0o700 })
        this.text = nextText
        if (value === undefined) this.values.delete(ref)
        else this.values.set(ref, value)
        this.hooks.notifyRef(ref)
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }

  /**
   * Serialized read-modify-write over one record — the only record write path.
   * `mutate` sees the record as it stands when the write is exclusive;
   * returning `undefined` leaves the entry untouched.
   * @param key - the record to modify.
   * @param mutate - receives the current record and returns its replacement, or `undefined`.
   * @returns the record after the write, or the current one when `mutate` declined.
   */
  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    if (this.closed) throw new Error(`tenant-credentials-local is closed: cannot modify "${key}"`)
    return this.enqueue(async () => {
      if (this.closed) throw new Error(`tenant-credentials-local was closed before the queued "${key}" modify ran`)
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      return withFileLock(this.filename, async () => {
        await this.reconcileFromDisk()
        const current = this.records.get(key)
        const next = await mutate(current)
        if (next === undefined) return current
        if (next.kind === 'grant') assertJsonValue(`record "${key}" payload`, next.payload, new Set())
        else assertStorableApiKey(key, next)
        const nextText = renderRecord(this.text, key, next)
        await writeFileAtomic(this.filename, nextText, { mode: 0o600, dirMode: 0o700 })
        this.text = nextText
        this.records.set(key, next)
        this.hooks.notifyRecord(key)
        return next
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }

  /**
   * Remove one record; removing an absent record is a no-op.
   * @param key - the record to remove.
   */
  async deleteRecord(key: CredentialKey): Promise<void> {
    if (this.closed) throw new Error(`tenant-credentials-local is closed: cannot delete "${key}"`)
    await this.enqueue(async () => {
      if (this.closed) throw new Error(`tenant-credentials-local was closed before the queued "${key}" delete ran`)
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      await withFileLock(this.filename, async () => {
        await this.reconcileFromDisk()
        if (!this.records.has(key)) return
        const nextText = renderRecord(this.text, key, undefined)
        await writeFileAtomic(this.filename, nextText, { mode: 0o600, dirMode: 0o700 })
        this.text = nextText
        this.records.delete(key)
        this.hooks.notifyRecord(key)
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }

  /** Refuse new operations, then settle the queued ones so close completes only once storage is quiescent. */
  async close(): Promise<void> {
    this.closed = true
    if (this.watcher !== undefined) await this.watcher.close()
    await this.operations
  }

  /** Queue one exclusive document operation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** Queue a reload; a poisoned commit is surfaced as an error but never ends the queue. */
  private queueRefresh(): void {
    void this.enqueue(() => this.refresh()).catch((error: unknown) => {
      this.hooks.logger.error('tenant-credentials-local: reload commit failed at %s', this.filename)
      this.hooks.logger.error(String(error))
    })
  }

  /** Boot read; see {@link start}. */
  private async loadInitial(): Promise<void> {
    await assertOwnerOnly(this.filename)
    let text: string
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      return
    }
    if (renderFlatLayoutMigration(text) !== undefined) text = await this.migrateFlatDocument()
    const document = parseCredentialsDocument(text, this.filename)
    this.values = document.refs
    this.records = document.records
    this.text = text
  }

  /**
   * One-shot upgrade of the recognized pre-release flat layout, under the
   * document's writer lock and re-reading first — a concurrent boot may have
   * migrated already. Values are carried verbatim.
   * @returns the document text this boot should parse.
   */
  private async migrateFlatDocument(): Promise<string> {
    return withFileLock(this.filename, async () => {
      const current = await readFile(this.filename, 'utf8')
      const migrated = renderFlatLayoutMigration(current)
      /* v8 ignore next 2 -- the losing side of the cross-process migration race is not deterministically schedulable. */
      if (migrated === undefined) return current
      await writeFileAtomic(this.filename, migrated, { mode: 0o600, dirMode: 0o700 })
      this.hooks.logger.info(
        'tenant-credentials-local: migrated %s to the version %d layout; values are unchanged',
        this.filename,
        DOCUMENT_VERSION,
      )
      return migrated
    }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
  }

  /**
   * Re-read after a watcher event. Unchanged content (including this store's
   * own writes) is a no-op; an unreadable document keeps the last good
   * snapshot and warns — a live reload must never take the process down.
   */
  private async refresh(): Promise<void> {
    if (this.closed) return
    try {
      await this.reconcileFromDisk()
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'INVARIANT') throw error
      this.hooks.logger.warn(
        'tenant-credentials-local: reload failed at %s; keeping the last good document', this.filename,
      )
      this.hooks.logger.warn(String(error))
    }
  }

  /**
   * Compare the on-disk text against the cache and publish any difference into
   * the seam. Absence publishes the empty store; an unreadable or invalid
   * document throws, so each caller picks its policy.
   */
  private async reconcileFromDisk(): Promise<void> {
    await assertOwnerOnly(this.filename)
    let text: string | undefined
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      text = undefined
    }
    if (text === this.text || this.closed) return
    const next = text === undefined
      ? { refs: new Map<string, string>(), records: new Map<string, CredentialRecord>() }
      : parseCredentialsDocument(text, this.filename)
    const changedRefs = this.changedRefs(this.values, next.refs)
    const changedRecords = this.changedRecords(this.records, next.records)
    this.text = text
    this.values = next.refs
    this.records = next.records
    for (const ref of changedRefs) this.hooks.notifyRef(ref)
    for (const key of changedRecords) this.hooks.notifyRecord(key)
  }

  /** Entries whose stored value changed; the parser has proven every key addressable. */
  private changedRefs(prev: Map<string, string>, next: Map<string, string>): CredentialRef[] {
    const changed: CredentialRef[] = []
    for (const key of new Set([...prev.keys(), ...next.keys()])) {
      if (prev.get(key) === next.get(key)) continue
      changed.push(credentialRef(key))
    }
    return changed
  }

  /** Records whose stored value changed; the parser has proven every key addressable. */
  private changedRecords(
    prev: Map<string, CredentialRecord>,
    next: Map<string, CredentialRecord>,
  ): CredentialKey[] {
    const changed: CredentialKey[] = []
    for (const key of new Set([...prev.keys(), ...next.keys()])) {
      if (sameJsonValue(prev.get(key), next.get(key))) continue
      changed.push(parseCredentialKey(key))
    }
    return changed
  }
  /* jscpd:ignore-end */
}
