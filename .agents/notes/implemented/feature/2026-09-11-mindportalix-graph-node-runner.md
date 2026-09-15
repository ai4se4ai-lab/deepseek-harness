# Agent Note: MindPortalix graph node runner

Status: implemented

English | [中文](2026-09-11-mindportalix-graph-node-runner.zh.md)

## Problem

MindPortalix users draw an agent architecture as a Mermaid flowchart with a YAML front-matter block, and the MindPortalix app compiles it into an executable graph. Each node of that graph executed as one stateless model call with a thin built-in tool surface and no durable workspace. This container already runs a full coding agent for the same tenant — shell, filesystem, web, skills, the OKF knowledge bundle — but it was reachable only through the browser iframe, so a diagram node could not use any of it. There was no way for the app to run a prompt here and read the result back.

## Decision

A host-plane function plugin, `@mindportalix/dsh-graph-node-runner`, registers three exact routes on `ctx.webServer` — `/api/mp/graph/node`, `/api/mp/graph/cancel`, `/api/mp/graph/release` — each resolving its tenant through `ctx.tenantContext` and failing closed without it, and each applying the composition's optional `connection` Host/Origin fence because an exact path is matched ahead of the prefix route that fence normally guards.

One node request creates or reuses one agent. Composition happens inside the agent factory's `setup` window, the only place a preset join, a persona shadow, and a tool restriction install while the agent is unpublished, so a rejected composition rolls the whole creation back rather than publishing a node that may use more than its diagram granted. The node's `systemPrompt` shadows `deployment:persona-prefix`; its requested tools are intersected with the composition's registered global names and applied as `tools.restrict({ allow })`; `model` and `maxTokens` become `AgentOptions`.

The session store is keyed by tenant, run, and node. A node keeps its own session for the whole run, so a reviewer's retry re-enters a node that remembers its first attempt. Nodes of one run share `$DSH_HOME/tenants/<tenantId>/runs/<runId>` as their working directory but not a conversation: the app's compiler hands each node only its direct predecessors' output, and one shared session would hand every node the whole transcript. Idle age and total size both bound the store, because a run abandoned mid-graph never sends its release.

`tools.restrict()` throws on an unknown name, so a requested tool this composition does not register is dropped from the grant and reported back in `droppedTools` instead of failing the node. The node's work does not depend on a missing tool being present, only on not being offered one it may not use.

## Alternatives considered

**Drive the existing Typert Remote surface from the app.** `session.create` / `session.prompt` already exist and the proxy forwards any path, so no new package would be needed. But a session controller call carries no per-node prompt, tool grant, or model, and the tenant session guard clamps `cwd` to the tenant root rather than to one run — a graph of nodes would have shared one session and one working directory, which is exactly the arrangement the app's input-flow contract forbids.

**Compile the diagram inside this repo.** Porting the app's Mermaid compiler here would put the whole graph on one side. It is ~1700 lines with its own gate, cycle, and HITL semantics and a large existing test suite in the app; re-implementing it under this repo's gates would duplicate the behaviour without moving any capability the app lacks.

**Per-node MCP clients.** A node's front-matter `mcps:` could spawn an agent-scoped `mcp-client` instance. That means carrying the server's spawn command over the wire from the app, so the entry is honoured only where the composition already registers that server's tools.

## Consequences

An app node that opts in runs as an ordinary session: composed preset sections and tools, the node prompt as its persona, the node input as one durable `user/message`, and nothing else injected — every model-visible input is reconstructable from the session log. Token cost scales with a run's node count rather than its turn count, because each node re-reads only its own session. Files a node writes land in the tenant tree the MindPortalix *DSH Files* tab already lists, and a node granted the OKF tools grows the same per-tenant bundle a chat does.

The route answers once at turn end; `RunNodeContext.onDelta` carries streamed assistant text out of a turn but no `text/event-stream` mode exists yet, so the app shows a node's output on completion. Usage is not reported. `agentPreset` is composition-wide, so a diagram cannot yet choose a different preset per node.

Unit and route tests cover the tenant gate, path containment, the grant intersection, session reuse and both eviction paths, cancellation, and the trust fence, at per-file 100% coverage. The real-composition test booting a test-only `cordis.yml` through the Loader is outstanding, as is the image rebuild that makes the row exist in the deployed container.
