/**
 * Wire and internal types for the graph node runner. Types only — no runtime code.
 * @module @mindportalix/dsh-graph-node-runner/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * One node execution request, as the MindPortalix app sends it. The app owns
 * graph semantics (gates, reviewer cycles, HITL, loop bounds) and sends only
 * what one node's turn needs: who it is, what it was told, and what it may use.
 */
export interface GraphNodeRequest {
  /** Run identity; every node of one run shares a workspace directory named by it. */
  readonly runId: string
  /**
   * Display title for the Workspace grouping this run's node sessions, used
   * only the first time a node of this run creates that Workspace. Undefined
   * falls back to the run directory's own basename.
   */
  readonly runTitle?: string
  /** Node identity within the run; owns one reusable session. */
  readonly nodeId: string
  /** The node's composed system prompt (front-matter `prompt` plus its inherited base). */
  readonly systemPrompt: string
  /** The node's user message: its predecessors' output, the request, and any injected context. */
  readonly input: string
  /** Harness tool names the node may use; an empty list grants the read-only baseline. */
  readonly tools: readonly string[]
  /** Front-matter `model`, or undefined to use the tenant's configured model. */
  readonly model?: string
  /** Front-matter `maxTokens`, or undefined for the provider default. */
  readonly maxTokens?: number
  /** Per-request ceiling on the turn, or undefined for the configured default. */
  readonly timeoutMs?: number
}

/** One tool the node called during its turn, as reported back for app-side audit. */
export interface ToolCallRecord {
  /** The tool's registered name. */
  readonly name: string
  /** Whether the call returned without an error result. */
  readonly ok: boolean
}

/**
 * One frame of a live node turn, for a caller that asked to watch it.
 *
 * The MindPortalix collaboration panel renders a node's reasoning, its tool
 * activity, and its answer as the turn runs. Without these the panel can only
 * show a node's final text after it finishes, so the frames carry exactly the
 * three things it draws — and the closing `end` frame carries the same result a
 * non-streaming caller receives, so neither mode is the poorer contract.
 */
export type NodeStreamFrame =
  /** Assistant text as the model produces it. */
  | { readonly kind: 'text'; readonly text: string }
  /** Model reasoning as it produces it, separate from the answer. */
  | { readonly kind: 'reasoning'; readonly text: string }
  /** A tool the node is about to call. */
  | { readonly kind: 'tool'; readonly name: string; readonly arguments: string }
  /** How that call came back. */
  | {
    readonly kind: 'tool_result'
    readonly name: string
    readonly ok: boolean
    /** A bounded excerpt of the result, or the failure message. */
    readonly preview: string
  }
  /** The settled turn. */
  | { readonly kind: 'end'; readonly result: GraphNodeResponse }
  /** The turn failed before it could settle. */
  | { readonly kind: 'error'; readonly code: string; readonly message: string }

/** Why a node's turn stopped, in the subagent seam's terminal vocabulary. */
export type GraphNodeStopReason = 'completed' | 'max-tokens' | 'aborted' | 'refusal' | 'error'

/** One node execution result. */
export interface GraphNodeResponse {
  /** The node session's id; stable across retries of the same node in one run. */
  readonly sessionId: SessionId
  /** The node's final assistant text. */
  readonly output: string
  /**
   * The model's reasoning for this turn, separate from the answer. Reasoning is
   * streamed and never lands in the assistant message, so it is accumulated
   * during the turn; empty when the model produced none.
   */
  readonly thinking: string
  /** Why the turn stopped. */
  readonly stopReason: GraphNodeStopReason
  /** Every tool call the node made, for post-hoc governance audit app-side. */
  readonly toolCalls: readonly ToolCallRecord[]
  /**
   * Requested tool names this composition does not register, dropped from the
   * grant rather than failing the node. The app surfaces them to the diagram
   * author, whose front-matter named a capability this deployment lacks.
   */
  readonly droppedTools: readonly string[]
}

/** The resolved tool grant for one node turn. */
export interface ToolGrant {
  /** Names passed to `tools.restrict({ allow })`; every one is registered. */
  readonly allow: readonly string[]
  /** Requested names no registered tool matches. */
  readonly dropped: readonly string[]
}
