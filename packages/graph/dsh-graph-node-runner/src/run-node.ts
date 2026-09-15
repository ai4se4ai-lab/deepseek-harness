/**
 * One node's turn: compose the agent from the node's front-matter, prompt it
 * with the input the MindPortalix compiler built, and read the durable result
 * back off its session log.
 *
 * Composition happens inside the agent factory's `setup` window, the only
 * place a preset join, a persona shadow, and a tool restriction are installed
 * while the agent is still unpublished — so a rejected composition rolls the
 * whole creation back instead of publishing a node that may use more than its
 * diagram granted.
 * @module @mindportalix/dsh-graph-node-runner/run-node
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
// Side-effect type imports: declaration-merge the services composition reads.
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { resolveToolGrant } from './grant.ts'
import { runWorkspacePath } from './paths.ts'
import type {
  GraphNodeRequest,
  GraphNodeResponse,
  GraphNodeStopReason,
  NodeStreamFrame,
  ToolCallRecord,
  ToolGrant,
} from './types.ts'
// Side-effect type import: declaration-merges `ctx.agentDefaultModel`.
import type {} from '@deepseek-ai/dsh-agent-default-model'

/** What one node execution needs from the composition and the request. */
export interface RunNodeContext {
  /** The host context owning the agent registry and the preset roster. */
  readonly ctx: Context
  /** The resolved tenant id; scopes the run workspace. */
  readonly tenantId: string
  /** The validated request. */
  readonly request: GraphNodeRequest
  /** Agent preset id each node is composed from. */
  readonly agentPreset: string
  /** Cancels the turn: the caller's disconnect, or a cancel request for this run. */
  readonly signal: AbortSignal
  /**
   * Receives each frame of the turn as it happens — assistant text, reasoning,
   * and tool activity — so a watching caller can render the turn live. Omitted
   * when the caller only wants the settled result.
   */
  readonly onFrame?: (frame: NodeStreamFrame) => void
}

/**
 * Map a turn's outcome onto the terminal vocabulary the app reads.
 * @param reason - the turn's end reason, or undefined when the turn never closed.
 * @returns the stop reason the app's graph state carries.
 */
export function toStopReason(reason: TurnEndReason | undefined): GraphNodeStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    // A rejected pre-step discarded the prompt: the node declined the work and
    // the app must not read the turn as an answer.
    case 'blocked':
      return 'refusal'
    default:
      return 'error'
  }
}

/**
 * Resolve one node's provider/model route.
 *
 * `GraphNodeRequest` carries only a model id, never a provider — the app's
 * diagrams have no notion of one — so the tenant's configured default model
 * (`ctx.agentDefaultModel`) supplies the provider always, and the model too
 * when the node's front-matter declared none. This is what makes an absent
 * `request.model` mean "the tenant's configured model" (see its doc comment):
 * without this resolution `AgentOptions` would carry neither field, and the
 * agent loop rejects a request with no provider and no model before it ever
 * reaches an adapter.
 * @param hostCtx - the host context owning the tenant's default model selection.
 * @param request - the validated node request.
 * @returns the provider and model to open this node's agent with.
 */
function resolveModelRoute(hostCtx: Context, request: GraphNodeRequest): { provider: string; model: string } {
  const fallback = hostCtx.agentDefaultModel.currentSelection()
  return { provider: fallback.provider, model: request.model ?? fallback.model }
}

/** Agent options carrying the resolved provider/model route and any declared ceiling. */
function agentOptionsFor(hostCtx: Context, request: GraphNodeRequest): { provider: string; model: string; maxTokens?: number } {
  return {
    ...resolveModelRoute(hostCtx, request),
    ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
  }
}

/**
 * Flatten selected output blocks to the plain text the app's graph state carries.
 * @param blocks - the selected output blocks, or undefined when the node produced none.
 * @returns the concatenated text, empty when the node produced no text.
 */
export function blocksToText(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Install one node's identity on its unpublished agent context: the preset
 * join that makes the deployment's tools visible, the node's own prompt as
 * the *complete* system prompt, and the restriction narrowing the visible
 * tools to what its `tools:` granted.
 *
 * Every node joins the same `agentPreset` (composition-wide; see the package
 * README's Known Limitations), so without `complete: true` a diagram's role
 * — "you are a planner, only produce a plan" — would be one short section
 * among the preset's own persona, its tool-usage prose, and its plan/team
 * policy sections, all of which nudge toward finishing the task end to end.
 * A node's turn is one narrow role for one graph, not a general coding agent
 * session, so its own prompt must be the definitive identity: `complete`
 * drops every other prompt section for this turn while leaving the tool
 * schemas and dynamic runtime context untouched, so the node can still call
 * whatever `tools:` granted it.
 * @param hostCtx - the host context owning the preset roster.
 * @param agentCtx - the agent's own unpublished context.
 * @param request - the validated node request.
 * @param agentPreset - the preset id to join.
 * @returns the resolved tool grant, including the requested names nothing matched.
 */
export async function composeNode(
  hostCtx: Context,
  agentCtx: Context,
  request: GraphNodeRequest,
  agentPreset: string,
): Promise<ToolGrant> {
  await hostCtx.agentPresets.mount(agentCtx, agentPreset)
  agentCtx.systemPrompt.section({
    name: 'deployment:persona-prefix',
    order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: request.systemPrompt,
    complete: true,
  })
  // The global view is exactly the set `restrict()` accepts; an unmatched
  // request would otherwise throw and fail a node over a capability it never
  // needed present.
  const registered = new Set(agentCtx.tools.schemas().map(schema => schema.name))
  const grant = resolveToolGrant(request.tools, registered)
  if (grant.allow.length > 0) agentCtx.tools.restrict({ allow: grant.allow })
  return grant
}

/**
 * Ceiling on how long {@link joinRunWorkspace} waits for the registry before
 * giving up on grouping this turn. `workspaceRegistry` serializes its
 * create/delete operations on one durable queue shared by every caller in the
 * composition (chat sessions, other runs); a slow or stuck operation already
 * queued ahead of this one must never make a node's own turn wait with it.
 */
const WORKSPACE_JOIN_TIMEOUT_MS = 5000

/** Resolves after `ms`, distinguishable from a real result by its sentinel. */
const workspaceJoinTimedOut = Symbol('workspace-join-timed-out')
function afterTimeout(ms: number): Promise<typeof workspaceJoinTimedOut> {
  return new Promise((resolve) => { setTimeout(() => resolve(workspaceJoinTimedOut), ms).unref() })
}

/**
 * Fold this node's session into a Workspace shared by every node of the same
 * run, so the app's session sidebar groups a run's planner/reviewer/executor
 * turns under one folder instead of leaving each as an unrelated top-level
 * row. `workspaceRegistry.create` is idempotent on the run's canonical `cwd`,
 * so the first node of a run creates the Workspace and later nodes rejoin it.
 *
 * Best-effort and optional: grouping is a browsing convenience, never a turn
 * precondition. A composition without `workspaceRegistry`, any failure here (a
 * race with a concurrent sibling node, a transient storage fault), or the
 * registry simply not answering within {@link WORKSPACE_JOIN_TIMEOUT_MS}
 * leaves the node's turn unaffected — the node still runs, just ungrouped.
 * A timeout does not cancel the registry's own operation (it has no
 * cancellation to offer); it only stops this turn from waiting on it.
 * @param context - the composition, tenant, request, and cancellation inputs.
 * @param cwd - the run's shared workspace directory, already created on disk.
 * @param sessionId - the node's just-published session id.
 */
async function joinRunWorkspace(context: RunNodeContext, cwd: string, sessionId: SessionId): Promise<void> {
  // Optional service: this package does not `inject` it (see `index.ts`), so a
  // composition without it runs graph nodes ungrouped rather than failing to boot.
  const registry = context.ctx.get('workspaceRegistry')
  if (registry === undefined) return
  try {
    const outcome = await Promise.race([
      (async () => {
        const workspace = await registry.create(cwd, context.request.runTitle)
        await workspace.attachSession(sessionId)
      })(),
      afterTimeout(WORKSPACE_JOIN_TIMEOUT_MS),
    ])
    if (outcome === workspaceJoinTimedOut) {
      context.ctx.logger.warn(
        `graph-node-runner: grouping run '${context.request.runId}' session '${sessionId}' into a `
        + `workspace did not answer within ${WORKSPACE_JOIN_TIMEOUT_MS}ms; leaving it ungrouped`,
      )
    }
  } catch (error) {
    context.ctx.logger.warn(
      `graph-node-runner: could not group run '${context.request.runId}' session '${sessionId}' `
      + `into a workspace: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Create one node's agent, already composed and pointed at the run workspace.
 * @param context - the composition, tenant, request, and cancellation inputs.
 * @param grantSink - receives the resolved tool grant, which is known only inside setup.
 * @returns the published agent handle.
 */
export async function createNodeAgent(
  context: RunNodeContext,
  grantSink: (grant: ToolGrant) => void,
): Promise<AgentHandle> {
  const cwd = runWorkspacePath(context.tenantId, context.request.runId)
  await mkdir(cwd, { recursive: true })
  const sessionId = brandString<SessionId>(`mp-${context.request.runId}-${context.request.nodeId}-${randomUUID()}`)
  const handle = await context.ctx.agents.create({
    sessionId,
    meta: { cwd, agentPreset: context.agentPreset },
    agentOptions: agentOptionsFor(context.ctx, context.request),
    signal: context.signal,
    setup: async (agentCtx: Context) => {
      grantSink(await composeNode(context.ctx, agentCtx, context.request, context.agentPreset))
    },
  })
  await joinRunWorkspace(context, cwd, sessionId)
  return handle
}

/** Longest tool preview forwarded to a watching caller. */
const TOOL_PREVIEW_CHARS = 300
/** Longest argument string forwarded with a tool call. */
const TOOL_ARGUMENTS_CHARS = 400

/** Render a tool result's content blocks as the excerpt a watcher sees. */
function previewOf(result: { isError: boolean; content: readonly ContentBlock[]; error?: { message?: string } }): string {
  if (result.isError) return result.error?.message ?? 'tool call failed'
  return blocksToText(result.content).slice(0, TOOL_PREVIEW_CHARS)
}

/** What one turn's observation collected, plus the disposer that ends it. */
interface TurnObservation {
  /** Reasoning accumulated across the turn; the assistant message never carries it. */
  thinking: () => string
  /** Removes every listener; a reused session must not accumulate one set per turn. */
  stop: () => void
}

/**
 * Watch one turn: forward its assistant text, its reasoning, and its tool
 * activity to the caller, and accumulate the reasoning for the settled result.
 *
 * Reasoning and tool activity are what make a node's turn legible in the
 * MindPortalix collaboration panel; without them a harness node can only show
 * its final text, which is strictly less than an in-app node shows.
 * @param agent - the node's published agent.
 * @param onFrame - the caller's sink, or undefined when the caller is not watching.
 * @returns the accumulated reasoning reader and the disposer.
 */
function observeTurn(agent: Agent, onFrame: ((frame: NodeStreamFrame) => void) | undefined): TurnObservation {
  let reasoning = ''
  const disposers: (() => void)[] = []

  disposers.push(agent.ctx.on('agent/assistant-stream', ({ frame }) => {
    if (frame.type !== 'chunk') return
    if (frame.chunk.type === 'text-delta') onFrame?.({ kind: 'text', text: frame.chunk.text })
    else if (frame.chunk.type === 'reasoning-delta') {
      reasoning += frame.chunk.text
      onFrame?.({ kind: 'reasoning', text: frame.chunk.text })
    }
  }))

  // Scope-filtered on the agent's own context, so these see only this node's
  // calls even while other nodes of the same run are executing.
  disposers.push(agent.ctx.on('tools/pre-execute', async (exec, next) => {
    onFrame?.({
      kind: 'tool',
      name: exec.name,
      arguments: JSON.stringify(exec.arguments ?? {}).slice(0, TOOL_ARGUMENTS_CHARS),
    })
    return await next()
  }))
  disposers.push(agent.ctx.on('tools/post-execute', async (exec, result, next) => {
    onFrame?.({ kind: 'tool_result', name: exec.name, ok: !result.isError, preview: previewOf(result) })
    return await next()
  }))

  return {
    thinking: () => reasoning,
    stop: () => { for (const dispose of disposers) dispose() },
  }
}

/**
 * Prompt one composed node and wait for its turn to settle.
 * @param agent - the node's published agent.
 * @param context - the request and cancellation inputs.
 * @returns the events this turn appended, whether cancellation won, and the reasoning it streamed.
 */
export async function driveTurn(
  agent: Agent,
  context: RunNodeContext,
): Promise<{ events: readonly SessionEvent[]; cancelled: boolean; thinking: string }> {
  const boundary = agent.session.seq
  const flags = { cancelled: false }
  const onAbort = (): void => {
    flags.cancelled = true
    agent.cancel({ kind: 'user' })
  }
  context.signal.addEventListener('abort', onAbort, { once: true })
  if (context.signal.aborted) onAbort()
  const observation = observeTurn(agent, context.onFrame)
  try {
    if (!flags.cancelled) {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: context.request.input }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
    }
  } finally {
    observation.stop()
    context.signal.removeEventListener('abort', onAbort)
  }
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const events = agent.session.snapshotEvents(boundary)
  return { events, cancelled: flags.cancelled, thinking: observation.thinking() }
}

/**
 * Read the node's answer, tool calls, and outcome out of one turn's events.
 * @param events - the events this turn appended.
 * @param cancelled - whether the caller cancelled before the loop settled.
 * @param sessionId - the node session's id.
 * @param grant - the tool grant this node ran under.
 * @param thinking - reasoning accumulated while the turn streamed.
 * @returns the response the app consumes.
 */
export function readTurn(
  events: readonly SessionEvent[],
  cancelled: boolean,
  sessionId: SessionId,
  grant: ToolGrant,
  thinking = '',
): GraphNodeResponse {
  const calls = new Map<string, ToolCallRecord>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      calls.set(String(event.data.callId), { name: event.data.name, ok: true })
    } else if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      const existing = calls.get(String(block.toolCallId))
      if (existing === undefined) continue
      const failed = event.data.error !== undefined || block.isError === true
      calls.set(String(block.toolCallId), { name: existing.name, ok: !failed })
    }
  }
  const recorded = toStopReason(foldConsumedWork(events).end?.data.reason)
  return {
    sessionId,
    output: blocksToText(finalAssistantOutput(events)),
    thinking,
    // Teardown can beat the loop's own `aborted` end; a cancelled turn is never
    // reported as a clean completion.
    stopReason: cancelled && recorded !== 'completed' ? 'aborted' : recorded,
    toolCalls: [...calls.values()],
    droppedTools: grant.dropped,
  }
}

/**
 * Run one graph node: compose or reuse its session, prompt it, and read the result.
 * @param context - the composition, tenant, request, and cancellation inputs.
 * @param acquire - returns this node's session, creating it through the passed factory on first use.
 * @returns the node's answer and the facts the app audits.
 */
export async function runGraphNode(
  context: RunNodeContext,
  acquire: (create: () => Promise<AgentHandle>) => Promise<AgentHandle>,
): Promise<GraphNodeResponse> {
  // A reused session was composed on its first turn, so the grant is re-read
  // from that composition rather than resolved again here.
  let grant: ToolGrant = { allow: [], dropped: [] }
  const handle = await acquire(async () => await createNodeAgent(context, (resolved) => { grant = resolved }))
  const { events, cancelled, thinking } = await driveTurn(handle.agent, context)
  const result = readTurn(events, cancelled, handle.agent.session.id, grant, thinking)
  context.onFrame?.({ kind: 'end', result })
  return result
}
