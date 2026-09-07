# @mindportalix/dsh-tool-okf

Model-facing tools for maintaining a tenant's Open Knowledge Format bundle. Each is a thin adapter over `ctx.okf` (`@mindportalix/dsh-okf-bundle`).

| Tool | Purpose |
|------|---------|
| `okf_bundle_overview` | List every concept — id, type, trust tier, staleness, attested? A cheap first read. |
| `okf_search_concepts` | Filter by `type` / `tags` / `text` / `trust_tier` / `stale`; every clause must match. |
| `okf_read_concept` | One concept's body + frontmatter + derived trust tier and staleness, with a stale warning (SPEC §5.5, §10.5). |
| `okf_write_concept` | Create / update. `frontmatter` is a JSON object; `type` is required. `generated` is stamped; the no-shrink guard runs; `index.md` / `log.md` are regenerated. |
| `okf_verify_concept` | Append a `verified: { by, at }` event (SPEC §5.2). `human:<id>` only for a real human sign-off. |
| `okf_retrieve_context` | Ranked, chain-verified, budget-packed context for a question — seeds by meaning + name, walks the concept graph, verifies every supporting fact through the 4-gate chain, and packs to a token budget. Registered only when `retrieveUrl` is set. |

`okf_attest` (SPEC §10) is registered separately by `@mindportalix/dsh-okf-attest` when that engine is deployed.

## Config

`producer` (default `dsh`) and `version` (default `unversioned`) compose the machine actor string `<producer>/<version>` stamped as `generated.by` / `verified[].by` for machine writes (SPEC §7). Set `version` from the deployment's build id.

`retrieveUrl` (default `''`) — absolute URL of the MindPortalix app's `POST /api/okf/retrieve` (`docs/architecture/okf-retrieval.md`). Empty ⇒ `okf_retrieve_context` is not registered. The graph-aware retriever (embeddings, the 4-gate chain, MMR, budget packing) lives in the app, not the harness; this tool is the cross-container client. `retrieveAuthHeader` (default `''`) is sent verbatim as the `Authorization` header — supply a service credential, since the endpoint is `requireAuth`. `retrieveBudget` (default `8000`) is the token budget used when the model passes none; `retrieveTimeoutMs` (default `15000`) bounds the call.

## Model Experience

Five tool schemas always enter the catalogue; a sixth (`okf_retrieve_context`) is added when `retrieveUrl` is configured. The tools read and write the tenant's `knowledge/` bundle; the prompt guidance that tells the model *when* to use them is `@mindportalix/dsh-okf-context`. A retrieve call is a network round-trip to the app and does not touch `ctx.okf`; a failure maps to `OKF_TOOL_FAILED` and the model answers without OKF context rather than crashing.

## Known Limitations and Deferred Work

- **No session event.** A write is reconstructable from the tool call/result in the session log, but there is no dedicated `okf/*` `SessionEventMap` member or projection yet.
- **`frontmatter` is an opaque JSON object** in the tool schema — validation beyond "is an object" and "has a `type`" is left to `ctx.okf`, per OKF's permissive conformance rule (SPEC §11).
- **`okf_retrieve_context` cross-container auth is unwired.** `retrieveAuthHeader` is passed straight through; the app has no service-token auth path for `/api/okf/retrieve` yet, and there is no Loader-booted real-composition test for the tool (only stubbed-`fetch` unit coverage). Deferred with the DSH image rebuild.
