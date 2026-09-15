/**
 * Request-validation tests. The MindPortalix app is the only caller, but its
 * JSON is still parsed input: every field the route reads is checked here, and
 * a malformed one must be a named rejection rather than an agent created from
 * a half-formed request.
 */

import { describe, expect, it } from 'vitest'
import { UnsafeSegmentError } from '../src/paths.ts'
import { InvalidRequestError, parseNodeRequest, parseRunScope } from '../src/wire.ts'

const minimal = {
  runId: 'run1',
  nodeId: 'code_writer',
  systemPrompt: 'Implement the planned change.',
  input: '### code_planner\nStep 1.',
}

describe('parseNodeRequest', () => {
  it('accepts the minimal body and defaults the tool grant to empty', () => {
    const request = parseNodeRequest(minimal)
    expect(request.runId).toBe('run1')
    expect(request.nodeId).toBe('code_writer')
    expect(request.tools).toEqual([])
    expect(request.model).toBeUndefined()
    expect(request.maxTokens).toBeUndefined()
    expect(request.timeoutMs).toBeUndefined()
  })

  it('carries the declared front-matter fields through', () => {
    const request = parseNodeRequest({
      ...minimal,
      tools: ['bash', 'write'],
      model: 'deepseek-chat',
      maxTokens: 2048,
      timeoutMs: 120_000,
    })
    expect(request.tools).toEqual(['bash', 'write'])
    expect(request.model).toBe('deepseek-chat')
    expect(request.maxTokens).toBe(2048)
    expect(request.timeoutMs).toBe(120_000)
  })

  it.each([
    ['a non-object body', 'not-an-object'],
    ['null', null],
    ['an array', []],
  ])('refuses %s', (_label, body) => {
    expect(() => parseNodeRequest(body)).toThrow(InvalidRequestError)
  })

  it.each(['runId', 'nodeId', 'systemPrompt', 'input'])('refuses a missing %s', (field) => {
    const body = Object.fromEntries(Object.entries(minimal).filter(([key]) => key !== field))
    expect(() => parseNodeRequest(body)).toThrow(InvalidRequestError)
  })

  it.each(['systemPrompt', 'input'])('refuses an empty %s', (field) => {
    expect(() => parseNodeRequest({ ...minimal, [field]: '' })).toThrow(InvalidRequestError)
  })

  it('refuses a traversal runId before it can become a directory', () => {
    expect(() => parseNodeRequest({ ...minimal, runId: '../../etc' })).toThrow(UnsafeSegmentError)
  })

  it('refuses a traversal nodeId', () => {
    expect(() => parseNodeRequest({ ...minimal, nodeId: '..' })).toThrow(UnsafeSegmentError)
  })

  it.each([
    ['a string', 'bash'],
    ['a number entry', [1]],
    ['an empty-string entry', ['']],
  ])('refuses tools given as %s', (_label, tools) => {
    expect(() => parseNodeRequest({ ...minimal, tools })).toThrow(InvalidRequestError)
  })

  it('treats a null tools field as no request', () => {
    expect(parseNodeRequest({ ...minimal, tools: null }).tools).toEqual([])
  })

  it('refuses a non-string model', () => {
    expect(() => parseNodeRequest({ ...minimal, model: 7 })).toThrow(InvalidRequestError)
  })

  it('ignores an empty model rather than sending it to the provider', () => {
    expect(parseNodeRequest({ ...minimal, model: '' }).model).toBeUndefined()
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '2048'],
  ])('refuses a %s maxTokens', (_label, maxTokens) => {
    expect(() => parseNodeRequest({ ...minimal, maxTokens })).toThrow(InvalidRequestError)
  })

  it('refuses a zero timeoutMs', () => {
    expect(() => parseNodeRequest({ ...minimal, timeoutMs: 0 })).toThrow(InvalidRequestError)
  })

  it('treats a null maxTokens as absent', () => {
    expect(parseNodeRequest({ ...minimal, maxTokens: null, timeoutMs: null }).maxTokens).toBeUndefined()
  })

  it('ignores a null model', () => {
    expect(parseNodeRequest({ ...minimal, model: null }).model).toBeUndefined()
  })

  it('defaults runTitle to undefined, so the Workspace falls back to the run directory name', () => {
    expect(parseNodeRequest(minimal).runTitle).toBeUndefined()
  })

  it('carries a declared runTitle through', () => {
    expect(parseNodeRequest({ ...minimal, runTitle: 'Simple Python Script Review' }).runTitle)
      .toBe('Simple Python Script Review')
  })

  it('treats a null runTitle as absent', () => {
    expect(parseNodeRequest({ ...minimal, runTitle: null }).runTitle).toBeUndefined()
  })

  it('refuses a non-string runTitle', () => {
    expect(() => parseNodeRequest({ ...minimal, runTitle: 7 })).toThrow(InvalidRequestError)
  })

  it('refuses an empty runTitle', () => {
    expect(() => parseNodeRequest({ ...minimal, runTitle: '' })).toThrow(InvalidRequestError)
  })
})

describe('parseRunScope', () => {
  it('accepts a whole-run scope', () => {
    const scope = parseRunScope({ runId: 'run1' })
    expect(scope.runId).toBe('run1')
    expect(scope.nodeId).toBeUndefined()
  })

  it('accepts a single-node scope', () => {
    expect(parseRunScope({ runId: 'run1', nodeId: 'reviewer' }).nodeId).toBe('reviewer')
  })

  it('refuses a missing runId', () => {
    expect(() => parseRunScope({})).toThrow(InvalidRequestError)
  })

  it('refuses a non-string nodeId', () => {
    expect(() => parseRunScope({ runId: 'run1', nodeId: 4 })).toThrow(InvalidRequestError)
  })

  it('refuses a traversal nodeId', () => {
    expect(() => parseRunScope({ runId: 'run1', nodeId: '../x' })).toThrow(UnsafeSegmentError)
  })

  it('treats a null nodeId as the whole run', () => {
    expect(parseRunScope({ runId: 'run1', nodeId: null }).nodeId).toBeUndefined()
  })

  it('refuses a non-object body', () => {
    expect(() => parseRunScope(42)).toThrow(InvalidRequestError)
  })
})
