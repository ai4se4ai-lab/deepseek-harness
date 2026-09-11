/**
 * The pure value assertions forked from `@deepseek-ai/dsh-credentials-local`'s
 * private helpers, exercised directly. `modifyRecord` runs these on every
 * record write; the store specs drive the common paths, these pin every
 * branch.
 */

import { describe, expect, it } from 'vitest'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { ApiKeyRecord } from '@deepseek-ai/dsh-credentials'
import { assertJsonValue, assertStorableApiKey, sameJsonValue } from '../src/local-store.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')

/** `assertJsonValue` as a nullary thunk, since it returns void. */
const json = (value: unknown): (() => void) => {
  return () => { assertJsonValue('payload', value, new Set()) }
}

/** `assertStorableApiKey` as a nullary thunk, since it returns void. */
const apiKey = (record: ApiKeyRecord): (() => void) => {
  return () => { assertStorableApiKey(KEY, record) }
}

describe('assertJsonValue', () => {
  it('admits primitives, plain objects, and arrays', () => {
    for (const value of [null, 'x', true, false, 0, 3.5, -1, { a: 1, b: [{ c: 'd' }] }, [1, 'two', null]]) {
      expect(json(value)).not.toThrow()
    }
  })

  it('rejects a non-finite number, at the top level and nested', () => {
    expect(json(Number.POSITIVE_INFINITY)).toThrow(/non-finite number/)
    expect(json(Number.NaN)).toThrow(/non-finite number/)
    expect(json({ nested: Number.NEGATIVE_INFINITY })).toThrow(/non-finite/)
  })

  it('rejects a cyclic object', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(json(cyclic)).toThrow(/is cyclic/)
  })

  it('rejects a value JSON cannot represent', () => {
    for (const value of [() => 1, new Date(), 10n, Symbol('s'), new Map()]) {
      expect(json(value)).toThrow(/JSON cannot represent/)
    }
  })
})

describe('assertStorableApiKey', () => {
  it('admits a key, an env map, both, or neither', () => {
    for (const record of [
      { kind: 'api-key', key: 'k' },
      { kind: 'api-key', env: { AWS_PROFILE: 'prod' } },
      { kind: 'api-key', key: 'k', env: { AWS_PROFILE: 'prod' } },
      { kind: 'api-key' },
    ] satisfies ApiKeyRecord[]) {
      expect(apiKey(record)).not.toThrow()
    }
  })

  it('rejects an empty key', () => {
    expect(apiKey({ kind: 'api-key', key: '' })).toThrow(/empty key/)
  })

  it('rejects an env name outside the reference grammar', () => {
    expect(apiKey({ kind: 'api-key', env: { '1BAD': 'v' } })).toThrow()
  })

  it('rejects an empty env value', () => {
    expect(apiKey({ kind: 'api-key', env: { AWS_PROFILE: '' } })).toThrow(/must be a non-empty string/)
  })
})

describe('sameJsonValue', () => {
  it('is true for identical primitives and structurally equal trees regardless of key order', () => {
    expect(sameJsonValue(1, 1)).toBe(true)
    expect(sameJsonValue('a', 'a')).toBe(true)
    expect(sameJsonValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(sameJsonValue([1, { x: 2 }], [1, { x: 2 }])).toBe(true)
  })

  it('is false across a type boundary, an array/object mismatch, a differing key count, and a missing key', () => {
    expect(sameJsonValue(1, '1')).toBe(false)
    expect(sameJsonValue({ a: 1 }, null)).toBe(false)
    expect(sameJsonValue([1], { 0: 1 })).toBe(false)
    expect(sameJsonValue({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(sameJsonValue({ a: 1 }, { b: 1 })).toBe(false)
    expect(sameJsonValue({ a: 1 }, { a: 2 })).toBe(false)
  })
})
