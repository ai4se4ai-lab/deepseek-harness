/**
 * Request-body validation for the node-runner routes. This is a wire boundary:
 * the MindPortalix app is trusted to be the only caller, but its JSON is still
 * parsed input, so every field is checked here rather than assumed by the
 * TypeScript interface it produces.
 * @module @mindportalix/dsh-graph-node-runner/wire
 */

import { assertSafeSegment } from './paths.ts'
import type { GraphNodeRequest } from './types.ts'

/** Thrown when a request body cannot be read as the route's documented shape. */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(`dsh-graph-node-runner: ${message}`)
    this.name = 'InvalidRequestError'
  }
}

/** Read one required string field. */
function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRequestError(`${field} must be a non-empty string`)
  }
  return value
}

/** Read one optional positive-integer field. */
function optionalPositiveInt(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidRequestError(`${field} must be a positive integer when present`)
  }
  return value
}

/** Read one optional non-empty string field. */
function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRequestError(`${field} must be a non-empty string when present`)
  }
  return value
}

/** Read the optional string array of requested tool names. */
function toolNames(body: Record<string, unknown>): string[] {
  const value = body['tools']
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new InvalidRequestError('tools must be an array of strings when present')
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new InvalidRequestError('tools must be an array of strings when present')
    }
  }
  return value as string[]
}

/** Read the request body as a plain JSON object. */
function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidRequestError('request body must be a JSON object')
  }
  return raw as Record<string, unknown>
}

/**
 * Validate one node-execution body.
 * @param raw - the parsed JSON body.
 * @returns the validated request.
 * @throws {@link InvalidRequestError} or {@link import('./paths.ts').UnsafeSegmentError} on any malformed field.
 */
export function parseNodeRequest(raw: unknown): GraphNodeRequest {
  const body = asObject(raw)
  const model = body['model']
  if (model !== undefined && model !== null && typeof model !== 'string') {
    throw new InvalidRequestError('model must be a string when present')
  }
  const maxTokens = optionalPositiveInt(body, 'maxTokens')
  const timeoutMs = optionalPositiveInt(body, 'timeoutMs')
  const runTitle = optionalString(body, 'runTitle')
  return {
    runId: assertSafeSegment('runId', requireString(body, 'runId')),
    nodeId: assertSafeSegment('nodeId', requireString(body, 'nodeId')),
    systemPrompt: requireString(body, 'systemPrompt'),
    input: requireString(body, 'input'),
    tools: toolNames(body),
    ...typeof model === 'string' && model.length > 0 ? { model } : {},
    ...maxTokens === undefined ? {} : { maxTokens },
    ...timeoutMs === undefined ? {} : { timeoutMs },
    ...runTitle === undefined ? {} : { runTitle },
  }
}

/** One run-scoped control body (`release` and `cancel`). */
export interface RunScopeRequest {
  /** The run whose sessions the operation targets. */
  readonly runId: string
  /** One node within the run, or undefined for every node of it. */
  readonly nodeId?: string
}

/**
 * Validate one run-scoped control body.
 * @param raw - the parsed JSON body.
 * @returns the validated run scope.
 * @throws {@link InvalidRequestError} or {@link import('./paths.ts').UnsafeSegmentError} on any malformed field.
 */
export function parseRunScope(raw: unknown): RunScopeRequest {
  const body = asObject(raw)
  const nodeId = body['nodeId']
  if (nodeId !== undefined && nodeId !== null && typeof nodeId !== 'string') {
    throw new InvalidRequestError('nodeId must be a string when present')
  }
  return {
    runId: assertSafeSegment('runId', requireString(body, 'runId')),
    ...typeof nodeId === 'string' ? { nodeId: assertSafeSegment('nodeId', nodeId) } : {},
  }
}
