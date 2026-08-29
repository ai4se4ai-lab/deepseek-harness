/** Tool UI slot declarations and their composed component props. */
import type { HostDescriptionSource } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Keyed atomic Tool call view, dispatched by the wire Tool name. Register
     * with `key: '<tool name>'` to own how one tool's calls render inside a
     * turn — the key domain is open (any wire tool name, including a tool your
     * own package registered), so there is no compile-time key set to pick
     * from and a typo simply never renders.
     *
     * A key the shipped composition already covers is replaced, not shared;
     * an unclaimed key falls back to the generic tool row, so registering is
     * additive for your own tool and a takeover for a shipped one. The owner
     * passes the call's identity, its frozen running-or-settled node, and the
     * expansion state (see ToolCallOwnerProps), so the view stays a pure
     * function of what the turn already knows.
     */
    'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ToolCallOwnerProps }
  }
}

/** Standard owner currency supplied to every atomic Tool view. */
export interface ToolCallOwnerProps {
  /** Tool call identity, stable across running and settled forms. */
  callId: string
  /** Wire Tool name and keyed dispatch value. */
  toolName: string
  /** Frozen running call or settled result node. */
  block: ToolCallBlock
  /** Session workspace root for relative summaries. */
  cwd?: string | undefined
  /** Host account home; POSIX home-rooted summaries display as `~`. */
  home?: string | undefined
  /**
   * Open a Tool argument path through the Host; undefined when this
   * deployment cannot hand a path to a native application (ToolCallTree
   * already gated the caller's `openFile` on `isLoopback`/`canOpenPath` — a
   * view never needs to re-check). A file-tool view renders its path as
   * plain text instead of a link when absent, since the whole row still
   * expands to show that Tool's own content/diff.
   */
  openFile: ((path: string) => void) | undefined
  /** Inspect this call in the trajectory view when available. */
  inspect?: (() => void) | undefined
}

/** Full props of a registered atomic Tool view. */
export type ToolCallViewProps = PropsRuntime<'tool.call.toolview'>

/** Injected Host description for POSIX home-path display, plus the page-authority fact `openFile`'s gate needs. */
export type ToolHostDescriptionInjected = {
  /** Whether the current page authority is loopback; combines with `hostDescription().canOpenPath` to gate `openFile`. */
  isLoopback: boolean
  hooks: {
    /** Current generation's Host description, bound by the slot renderer. */
    hostDescription: HostDescriptionSource
  }
}

/** Full props of the Tool call-tree renderer registered as a `tool-call` Chat Node. */
export type ToolTreeProps = PropsRuntime<'conversation.chat.node', 'tool-call'>
  & PropsRenderSlots<'tool.call.toolview'>
  & PropsLocale<'conversation'>
  & InjectFace<ToolHostDescriptionInjected>

/** Full props of the selected Tool output renderer in the details panel. */
export type ToolDetailsProps = PropsRuntime<'conversation.details.tool'>
  & PropsLocale<'conversation'>
  & InjectFace<ToolHostDescriptionInjected>
