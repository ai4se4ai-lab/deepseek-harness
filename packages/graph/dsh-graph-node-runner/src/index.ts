/**
 * Runs one node of a MindPortalix agent-architecture graph as a DSH agent turn.
 *
 * The MindPortalix app compiles the user's Mermaid canvas into a LangGraph and
 * keeps every graph decision — gate routing, reviewer cycles, human-in-the-loop
 * pauses, loop bounds, and which predecessor output each node reads. This
 * package owns the other half: giving one node a real agent for the length of
 * one turn, with the prompt, model, token ceiling, and tool grant its
 * front-matter declared, inside the tenant's own workspace.
 *
 * Three properties make a graph of these turns behave like a team rather than a
 * row of strangers:
 * - **A node keeps its own session** for the whole run, so a reviewer's retry
 *   re-enters a node that remembers its first attempt.
 * - **Nodes of one run share one working directory**, so whatever one node
 *   writes is on disk for the next one to read — the same directory the
 *   MindPortalix DSH Files tab already lists.
 * - **Nodes do not share a conversation**, because the app hands each node only
 *   its direct predecessors' output; one shared session would hand every node
 *   the whole transcript and each would re-answer the original request.
 *
 * The route trusts the reverse proxy's `x-mp-dsh-tenant` header, the same
 * header the rest of the tenant-isolation stack trusts, and fails closed
 * without it.
 * @module @mindportalix/dsh-graph-node-runner
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TenantRequiredError } from '@mindportalix/dsh-tenant-context'
import { UnsafeSegmentError } from './paths.ts'
import { runGraphNode } from './run-node.ts'
import { NodeSessionStore } from './session-store.ts'
import type { NodeStreamFrame } from './types.ts'
import { InvalidRequestError, parseNodeRequest, parseRunScope } from './wire.ts'
// Side-effect type imports: declaration-merge the services this plugin reads.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

export { BASELINE_TOOLS, resolveToolGrant } from './grant.ts'
export { assertSafeSegment, runWorkspacePath, UnsafeSegmentError } from './paths.ts'
export { blocksToText, readTurn, toStopReason } from './run-node.ts'
export { NodeSessionStore } from './session-store.ts'
export { InvalidRequestError, parseNodeRequest, parseRunScope } from './wire.ts'
export type { RunNodeContext } from './run-node.ts'
export type { SessionStoreOptions } from './session-store.ts'
export type { RunScopeRequest } from './wire.ts'
export type * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'graph-node-runner'

/** Services required by this plugin. */
export const inject = ['agentDefaultModel', 'agents', 'agentPresets', 'tenantContext', 'webServer']

/** Route serving one node turn. */
export const NODE_ROUTE = '/api/mp/graph/node'
/** Route cancelling a run's in-flight turns without dropping its sessions. */
export const CANCEL_ROUTE = '/api/mp/graph/cancel'
/** Route disposing a finished run's sessions. */
export const RELEASE_ROUTE = '/api/mp/graph/release'

/** Config for the node runner. */
export interface Config {
  /** Agent preset each node is composed from; its tools are what a node's grant may draw on. */
  agentPreset?: string
  /** Idle milliseconds after which an unreferenced node session is disposed. */
  idleTtlMs?: number
  /** Interval between idle sweeps. */
  sweepIntervalMs?: number
  /** Maximum live node sessions before the least recently used is evicted. */
  maxSessions?: number
  /** Default ceiling on one node turn when the request names none. */
  turnTimeoutMs?: number
  /** Maximum request body bytes. */
  maxBodyBytes?: number
}

/** Validated config schema. */
export const Config: z<Config> = z.object({
  agentPreset: z.string().default('standard'),
  idleTtlMs: z.number().step(1).min(1000).default(30 * 60 * 1000),
  sweepIntervalMs: z.number().step(1).min(1000).default(60 * 1000),
  maxSessions: z.number().step(1).min(1).default(64),
  turnTimeoutMs: z.number().step(1).min(1000).default(10 * 60 * 1000),
  maxBodyBytes: z.number().step(1).min(1024).default(4 * 1024 * 1024),
})

/**
 * The Host/Origin trust surface consumed here. The browser-side connection
 * package owns the full type, so it is declared locally rather than depended on
 * (the `@deepseek-ai/dsh-host-open-in-app` pattern).
 */
interface TrustedConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/**
 * Apply the composition's `/api` Host/Origin fence to this route.
 *
 * These routes are exact paths, so they are matched ahead of the prefix route
 * the fence normally guards, and would otherwise sit outside it. Nothing here
 * relies on the fence for tenant scoping — that is `ctx.tenantContext`'s job —
 * but a route under `/api` in this process should not be the one place a
 * rebound browser is answered. A composition without the connection service
 * (headless, tests) has no browser to defend against and passes through.
 * @param ctx - the host context.
 * @param req - the incoming request.
 * @returns the rejection status, or undefined when the route may answer.
 */
function untrusted(ctx: Context, req: IncomingMessage): 401 | 403 | undefined {
  // `ctx.get` rather than the property proxy: the service is optional here, and
  // the proxy is topology-sensitive while `get` reads the global service store.
  const connection = ctx.get('connection') as TrustedConnection | undefined
  return connection?.requestRejection(req)
}

/** JSON response with the no-store headers a control API needs. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Whether this caller asked to watch the turn rather than only receive its result.
 * @param req - the incoming request.
 * @returns true when the caller accepts an event stream.
 */
export function wantsStream(req: IncomingMessage): boolean {
  const accept = req.headers['accept']
  return typeof accept === 'string' && accept.toLowerCase().includes('text/event-stream')
}

/**
 * Open one event stream and return the frame writer.
 *
 * Compression is declined explicitly: a buffered stream would deliver every
 * frame at turn end, which is the outcome streaming exists to avoid.
 * @param res - the response to stream over.
 * @returns a function writing one named frame.
 */
export function openStream(res: ServerResponse): (frame: NodeStreamFrame) => void {
  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-no-compression', '1')
  return (frame) => {
    if (res.writableEnded) return
    res.write(`event: ${frame.kind}\ndata: ${JSON.stringify(frame)}\n\n`)
  }
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(res: ServerResponse): void {
  res.statusCode = 405
  res.setHeader('allow', 'POST')
  res.end()
}

/** Thrown when a request body exceeds the configured ceiling. */
class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`dsh-graph-node-runner: request body exceeds ${limit} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Read and parse one JSON request body under a byte ceiling.
 * @param req - the incoming request.
 * @param limit - the maximum accepted body size in bytes.
 * @returns the parsed JSON value.
 */
export async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new BodyTooLargeError(limit)
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    // Swallows the parser's own message: the caller only needs to know the
    // body was not JSON, and the raw text must not travel back in an error.
    throw new InvalidRequestError('request body must be valid JSON')
  }
}

/**
 * Map one handler failure onto its status and model-free message.
 * @param error - the thrown value from a route handler.
 * @returns the HTTP status and the JSON body to answer with.
 */
export function errorResponse(error: unknown): { status: number; body: { code: string; message: string } } {
  if (error instanceof TenantRequiredError) {
    return { status: 401, body: { code: 'tenant-required', message: 'no tenant identity on this request' } }
  }
  if (error instanceof UnsafeSegmentError || error instanceof InvalidRequestError) {
    return { status: 400, body: { code: 'invalid-request', message: error.message } }
  }
  if (error instanceof BodyTooLargeError) {
    return { status: 413, body: { code: 'body-too-large', message: error.message } }
  }
  return {
    status: 500,
    body: { code: 'node-run-failed', message: error instanceof Error ? error.message : String(error) },
  }
}

/**
 * Wire the node-execution and run-control routes onto the web server.
 * @param ctx - the host context.
 * @param config - the validated config.
 */
export function apply(ctx: Context, config: Required<Config>): void {
  const store = new NodeSessionStore({ idleTtlMs: config.idleTtlMs, maxSessions: config.maxSessions })
  ctx.effect(() => {
    const timer = setInterval(() => { void store.sweep() }, config.sweepIntervalMs)
    timer.unref()
    return () => {
      clearInterval(timer)
      void store.disposeAll()
    }
  }, 'graph-node-runner: node sessions')

  /** Bind the request's tenant, then run `handler` inside that binding. */
  const withTenant = async (
    req: IncomingMessage,
    res: ServerResponse,
    handler: (tenantId: string, body: unknown) => unknown,
  ): Promise<void> => {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res)
      return
    }
    const rejection = untrusted(ctx, req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    const tenantId = ctx.tenantContext.resolveTenant(req.headers)
    try {
      const payload = await ctx.tenantContext.run(tenantId, async () => {
        // Inside the binding, so the same fail-closed error every other
        // tenant-scoped consumer raises is what the caller sees.
        const bound = ctx.tenantContext.requireCurrent()
        return await handler(bound, await readJsonBody(req, config.maxBodyBytes))
      })
      // A streaming handler has already answered with frames and closed the
      // response; a JSON body here would append a second payload to that
      // stream. It also owns its own failures, so the catch below only ever
      // sees one that happened before any stream opened.
      if (!res.headersSent) sendJson(res, 200, payload)
    } catch (error: unknown) {
      const { status, body } = errorResponse(error)
      sendJson(res, status, body)
    }
  }

  /**
   * Run one node, optionally streaming its turn.
   *
   * The body is validated before any stream opens, so a malformed request is
   * still answered with a JSON status; once frames are flowing there is no way
   * back to a JSON error, and a failure is reported as a closing `error` frame.
   */
  const runNode = async (
    req: IncomingMessage,
    res: ServerResponse,
    tenantId: string,
    body: unknown,
  ): Promise<unknown> => {
    const request = parseNodeRequest(body)
    const controller = new AbortController()
    const timeout = setTimeout(() => { controller.abort() }, request.timeoutMs ?? config.turnTimeoutMs)
    // A disconnected caller has no one left to answer; the turn stops with it.
    const onClose = (): void => { controller.abort() }
    req.on('close', onClose)
    const emit = wantsStream(req) ? openStream(res) : undefined
    try {
      const result = await runGraphNode(
        {
          ctx,
          tenantId,
          request,
          agentPreset: config.agentPreset,
          signal: controller.signal,
          ...emit === undefined ? {} : { onFrame: emit },
        },
        async create => await store.acquire(tenantId, request.runId, request.nodeId, create),
      )
      if (emit === undefined) return result
      // `runGraphNode` already emitted the `end` frame carrying this result.
      res.end()
      return undefined
    } catch (error: unknown) {
      if (emit === undefined) throw error
      const { body: failure } = errorResponse(error)
      emit({ kind: 'error', code: failure.code, message: failure.message })
      res.end()
      return undefined
    } finally {
      clearTimeout(timeout)
      req.off('close', onClose)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: NODE_ROUTE,
    handler: async (req, res) => {
      await withTenant(req, res, async (tenantId, body) => await runNode(req, res, tenantId, body))
    },
  }), `graph-node-runner: POST ${NODE_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CANCEL_ROUTE,
    handler: async (req, res) => {
      await withTenant(req, res, (tenantId, body) => {
        const scope = parseRunScope(body)
        return { cancelled: store.cancel(tenantId, scope.runId, scope.nodeId) }
      })
    },
  }), `graph-node-runner: POST ${CANCEL_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RELEASE_ROUTE,
    handler: async (req, res) => {
      await withTenant(req, res, async (tenantId, body) => {
        const scope = parseRunScope(body)
        return { released: await store.release(tenantId, scope.runId, scope.nodeId) }
      })
    },
  }), `graph-node-runner: POST ${RELEASE_ROUTE}`)
}
