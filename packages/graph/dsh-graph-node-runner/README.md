# @mindportalix/dsh-graph-node-runner

Runs one node of a MindPortalix agent-architecture graph as a DSH agent turn.

MindPortalix users draw an agent architecture as a Mermaid flowchart with a YAML front-matter block. The MindPortalix app compiles that canvas into a LangGraph and keeps every graph decision: gate routing, reviewer cycles, human-in-the-loop pauses, loop bounds, and which predecessor's output each node reads. This package owns the other half — giving one node a real agent for the length of one turn, with the prompt, model, token ceiling, and tool grant its front-matter declared, inside the calling tenant's own workspace.

Three properties make a graph of these turns behave like a team rather than a row of strangers:

- **A node keeps its own session for the whole run.** A reviewer's `fail` edge re-enters a node that remembers its first attempt, so the retry revises rather than restarts.
- **Nodes of one run share one working directory.** Whatever one node writes is on disk for the next one to read. The directory is `$DSH_HOME/tenants/<tenantId>/runs/<runId>`, inside the tenant root the MindPortalix *DSH Files* tab already lists. When a `workspaceRegistry` is composed, the same directory backs one Workspace and every node of the run joins it, so the app's session sidebar groups a run's planner/reviewer/executor turns under one folder instead of leaving each as an unrelated top-level row.
- **Nodes do not share a conversation.** The app hands each node only its direct predecessors' output; one shared session would hand every node the whole transcript, and each would re-answer the original request instead of building on prior work.

## Routes

Every route is `POST`, JSON in and JSON out, and resolves its tenant from the trusted `x-mp-dsh-tenant` proxy header through `ctx.tenantContext`. A request with no valid tenant is refused with `401 tenant-required` before any session, directory, or agent exists.

These are exact paths, so the web server matches them ahead of the prefix route the composition's `/api` Host/Origin fence normally guards. They therefore apply that fence themselves through the optional `connection` service — not for tenant scoping, which is `ctx.tenantContext`'s job, but so a route under `/api` in this process is not the one place a rebound browser is answered. A composition without that service (headless, tests) passes through. A caller must send a `Host` the fence accepts, which is why the MindPortalix app reaches these routes over `node:http` with `Host: 127.0.0.1:<port>` rather than `fetch`, whose Host cannot be set.

| Route | Body | Answers |
|---|---|---|
| `/api/mp/graph/node` | `{runId, nodeId, systemPrompt, input, tools?, model?, maxTokens?, timeoutMs?, runTitle?}` | `{sessionId, output, thinking, stopReason, toolCalls[], droppedTools[]}` |
| `/api/mp/graph/cancel` | `{runId, nodeId?}` | `{cancelled}` — stops live turns, keeps the sessions |
| `/api/mp/graph/release` | `{runId, nodeId?}` | `{released}` — disposes the run's sessions |

`runId` and `nodeId` become directory and session-key segments, so both must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`; anything else is refused as `400 invalid-request` rather than normalized.

`tools` names harness tools directly — the app has already mapped the diagram's `tools:` aliases. A node that requests nothing gets a read-only baseline (`read`, `glob`, `grep`, and the three read-only `okf_*` tools), mirroring the app-side rule that `context.read` is the only baseline capability; write, shell, and web access stay opt-in. A requested tool this composition does not register is **dropped and reported** in `droppedTools` rather than failing the node, because `tools.restrict()` throws on an unknown name and a node's work does not depend on a missing tool being present.

`toolCalls[]` exists so the app can audit in-container tool use after the fact. It is a report, not an enforcement point: the harness's own sandbox, tenant fence, and per-tenant credentials are what actually confine the turn.

`runTitle` names the Workspace grouping this run's node sessions in the app's session sidebar (see Model Experience below). It is read only the first time a node of a run creates that Workspace; later nodes of the same run rejoin it regardless of what `runTitle` they send. Omitting it falls back to the run directory's own basename.

## Watching a turn

A caller sending `Accept: text/event-stream` to `/api/mp/graph/node` receives the turn as it happens instead of one JSON body. MindPortalix renders a node's reasoning, its tool activity, and its answer while the node works; without these frames a node can only be drawn once it finishes, which is strictly less than an in-app node shows.

| Frame | Carries |
|---|---|
| `text` | assistant text, as the model produces it |
| `reasoning` | model reasoning, separate from the answer — it never lands in the assistant message |
| `tool` | `{name, arguments}` for a call about to run |
| `tool_result` | `{name, ok, preview}` — a bounded excerpt, or the failure message |
| `end` | `{result}`, the same object a non-streaming caller receives |
| `error` | `{code, message}` when the turn failed before it could settle |

The body is validated before any stream opens, so a malformed request still gets a JSON status; once frames are flowing there is no way back to a JSON error and a failure arrives as a closing `error` frame. Text and reasoning come from `agent/assistant-stream`; tool frames come from agent-scoped `tools/pre-execute` / `tools/post-execute` listeners, so a node sees only its own calls even while other nodes of the same run are executing. Every listener is disposed with the turn, so a reused session never accumulates a second set.

## Config

| Field | Default | Effect |
|---|---|---|
| `agentPreset` | `standard` | Preset each node is composed from; its tools are what a grant may draw on |
| `idleTtlMs` | `1800000` | Idle milliseconds before an unreferenced node session is disposed |
| `sweepIntervalMs` | `60000` | Interval between idle sweeps |
| `maxSessions` | `64` | Live node sessions before the least recently used is evicted |
| `turnTimeoutMs` | `600000` | Ceiling on one turn when the request names none |
| `maxBodyBytes` | `4194304` | Request body ceiling |

Both eviction paths exist because a run abandoned mid-graph — a closed tab, a crashed app process — never sends its `release`.

## Model Experience

One node turn reaches the model as an agent session composed from `agentPreset`, but with `systemPrompt` installed as the *complete* prompt: it replaces `deployment:persona-prefix` with `complete: true`, which drops the preset's own persona and every other prompt section (tool-usage prose, plan/team policy) for this turn. Every node joins the same composition-wide preset (see Known Limitations below), so without `complete` a diagram's narrow role — "you are a planner, only produce a plan" — would be one short section competing with the preset's own "finish the task end to end" framing; a node is one role for one graph, not a general coding session, so its own prompt is the only one that should reach the model. Tool schemas and dynamic runtime context are unaffected, so the node can still call whatever `tools:` granted it. The node's `input` reaches the model as a single durable `user/message`. Nothing else is injected, and every model-visible input is reconstructable from the session log. Token cost scales with the run's node count rather than its turn count, because each node re-reads only its own session.

## Known Limitations and Deferred Work

- **No per-node MCP servers.** A node's front-matter `mcps:` is honoured only where the deployment's composition already registers that server's tools; this package does not spawn per-node MCP clients, because doing so would carry spawn commands over the wire from the app. A node's `tools:` may still *name* such an already-registered tool directly — the app no longer requires every token to be one of its own aliases (see `mapToolsToHarness` in the MindPortalix app) — but this package never mounts a new MCP server on a node's behalf.
- **No usage reporting.** `toolCalls[]` and `stopReason` come back, but token usage does not; the app reads cost from its own provider path only.
- **One preset for every node.** `agentPreset` is composition-wide; a diagram cannot yet choose a different preset per node. This is also why `systemPrompt` must be installed as the complete prompt (see Model Experience above) rather than layered alongside the preset's own persona.
- **Workspace grouping is best-effort and time-boxed.** `workspaceRegistry` is read with `ctx.get`, not `inject`, so a composition without it — or any failure while creating or joining the run's Workspace — leaves every node ungrouped in the sidebar rather than failing the turn. The registry serializes create/delete on one durable queue shared by every caller in the composition, so joining also gives up after 5s rather than waiting behind an unrelated caller's slow or stuck operation — a live run once hung every node's creation on exactly this before the bound was added.

**Runtime invariant:** No runtime invariant companion is published; this package owns no relation two independent observations could disagree about. The session store is the single authority for which node sessions are live, and the tool grant is derived from the composition's own registry view at the moment it is applied.
