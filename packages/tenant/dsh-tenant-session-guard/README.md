# @mindportalix/dsh-tenant-session-guard

Tenant-scoping wrapper over `ctx.apiProxy`'s session and workspace RPC methods, for the single shared DSH container behind the MindPortalix reverse proxy. Requires `ctx.tenantContext` (`@mindportalix/dsh-tenant-context`) as the sole source of tenant identity.

On activation, it monkey-patches the plain closures `ctx.apiProxy.sessions.{create,list,search}` and `ctx.apiProxy.workspace.*`, restoring the originals on disposal:

- `session.create`: an explicit `cwd` or `workspaceId` must resolve under the caller's `$DSH_HOME/tenants/<tenantId>` root, or the call is rejected (`tenant-path-invalid` / `workspace-not-found`); an omitted `cwd`/`workspaceId` defaults to the tenant root explicitly (never the process's shared default project directory).
- `session.list` / `session.search`: results are filtered to sessions whose `cwd` falls under the caller's tenant root (a session with no recorded `cwd` is dropped, not shown — fail closed); `search` reuses the filtered `session.list` as its visibility allowlist, since search results carry no `cwd` of their own.
- `workspace.list`: `items` are filtered by `path`; `archivedSessionIds` is filtered to ids that appear in a tenant-visible workspace's `sessionIds` account (archived sessions carry no path of their own).
- `workspace.create`: the `path` must resolve under the tenant root.
- `workspace.rename` / `delete` / `insertBefore` / `insertSessionBefore`: the targeted `workspaceId` (and `beforeWorkspaceId` where present) must resolve to a tenant-visible workspace, or the call is rejected with `workspace-not-found` — the same code a genuinely unknown id produces, so existence is never disclosed cross-tenant.
- `workspace.archiveSession`: ownership is proved by workspace membership (a workspace accounts every session it owns, including archived ones); a session owned by no tenant-visible workspace is rejected with `session-not-found`.

Every wrapped method calls `ctx.tenantContext.requireCurrent()` first; with no tenant identity bound, it returns the structured `tenant-required` RPC error rather than proceeding unscoped.

## Model Experience

This package has no model, token, or KV-cache effect: it is an RPC-gateway wrapper with no system-prompt, tool, or session-log surface.

## Known Limitations and Deferred Work

- Only `session.{create,list,search}` and `workspace.*` are wrapped, matching this package's scope. Other by-`sessionId` methods on `ctx.apiProxy.sessions` (`history`, `fork`, `prompt`, `rename`, `cancel`, `updateQueue`, `attachment`, `models`, `selectModel`) are **not** guarded here: a caller that already knows another tenant's `sessionId` (e.g. through a future leak elsewhere) can still call these directly. Closing that gap is out of this package's current scope.
- `workspace.archiveSession` rejects every session with no owning tenant-visible workspace, including a caller's own genuinely ungrouped session — deliberately conservative (fail closed) rather than allowing an unverified session through.
- The `danger-full-access` sandbox-mode escalation is not interceptable here: `session.create`'s wire payload carries no mode field at all (see `packages/host/apiproxy/src/api/sessions.schema.ts`), and that mode is reached only through a selected permission preset (`@deepseek-ai/dsh-permission-presets`). `deploy/tenant-isolation.cordis.patch.yml` closes this path at the composition level instead, by dropping the `danger-full-access` preset from the `permission` row.
