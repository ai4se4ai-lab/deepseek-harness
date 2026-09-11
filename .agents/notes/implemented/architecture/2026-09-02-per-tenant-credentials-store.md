# Agent Note: Per-tenant credential store for the shared DSH container

Status: implemented

## Problem

The MindPortalix reverse proxy runs one DeepSeek Harness container for every
tenant, and `@mindportalix/dsh-tenant-session-guard` / `-sandbox-local` already
scope sessions, workspaces, the directory browser, the event downlinks, and the
tool sandbox to each caller's `$DSH_HOME/tenants/<tenantId>` root. The
credential seam was the hole: `@deepseek-ai/dsh-credentials-local` reads and
writes **one** `$DSH_HOME/.credentials.yaml` for the whole process, so the first
user to paste a `DEEPSEEK_API_KEY` into the harness's onboarding modal set it
for every other tenant — one shared key everyone's traffic is billed to and
rate-limited by, with no per-user attribution. The "bring your own key" flow the
outer repo documents was, in practice, "first person for all".

The blocker for a naive wrapper is that the agent loop resolves
`ctx.credentials.resolve(ref)` off the request's async chain: `session.prompt`
returns after `agent.followup()` and the turn runs later. But the driver is
started synchronously from that RPC via `wakeDriver()` →
`agents.withInitiator(this, () => this.kick())`, and the RPC dispatch runs inside
`tenantContext.run(tenantId, …)` (`@deepseek-ai/dsh-client-connection`'s
`rpc-host.ts`), so AsyncLocalStorage carries the tenant id through the
synchronously-created promise chain into the turn — the same guarantee
`dsh-tenant-sandbox-local`'s `confine()` already relies on.

## Decision

`@mindportalix/dsh-tenant-credentials-local` registers as `ctx.credentials`,
replacing the base `credentials` row (the tenant-isolation patch layer disables
it and inserts this one, exactly like the `sandbox` swap). `TenantLocalCredentialProvider`
routes every seam method — `resolve` / `describe` / `set` / `unset` and the
record half — on `ctx.tenantContext.current()`:

- **A bound tenant** resolves and persists against its own
  `$DSH_HOME/tenants/<tenantId>/.credentials.yaml`. One `LocalCredentialStore`
  per tenant id, created and booted on first use.
- **No tenant bound** (a bare `dsh` CLI run, a config-driven agent boot) falls
  back to the shared `$DSH_HOME/.credentials.yaml` with its filesystem watcher —
  unchanged single-store behavior, so the harness checkout's own local and e2e
  use is unaffected. This is the one deliberate departure from the fail-closed
  posture of the sibling tenant packages; a credential provider that returned
  nothing here would break `dsh` in the checkout, and no tenant is ever unbound
  on the proxy path. `static inject = ['tenantContext']` still fails a
  composition without the tenant-identity service loudly at boot.

The inherited process environment and the launcher's `.env` files stay a
**single shared layer** with upstream's exact precedence and read-only
semantics: env wins, the per-tenant document is next, then project/user `.env`.
`docker-compose.dsh.yml` therefore keeps `DEEPSEEK_API_KEY` unset — a value
there is still one operator-set credential for the whole deployment.

`LocalCredentialStore` is a plain per-file class forked from
`credentials-local`'s reviewed provider: same read-modify-write discipline,
comment-preserving edits, cross-process writer lock, `0600`-under-`0700` modes,
content-equality self-write suppression, and the pre-release flat-layout
migration (`parseCredentialsDocument` / `renderFlatLayoutMigration` are imported
from that package, not copied). Two differences from upstream: the file location
is per-tenant, and **tenant stores run no watcher** — one process is the only
writer of each tenant's document, so an in-process `set` already updates the
snapshot and there is no second process to observe. Only the shared fallback
store watches.

`dsh-tenant-session-guard`'s `scopedHostFrame` now **drops** the
`credentials/reference-updated` `host/remote-event` from every tenant downlink:
the credential plane is per-tenant, and the frame carries only the ref name with
no originating tenant to scope against. A tenant's own second browser tab picks
up its key change on reload; key writes are rare.

## Alternatives considered

- **A monkey-patch wrapper over `ctx.credentials.{resolve,set,…}` (the
  `dsh-tenant-session-guard` shape).** Rejected: the base `CredentialProvider`
  constructor registers the `credentials` service unconditionally, so a
  per-tenant inner `LocalCredentialProvider` cannot be instantiated without
  clobbering the wrapper's own registration or fighting Cordis isolates. A
  fork that owns the file layer directly is smaller and matches the sanctioned
  "tenant-scoped fork" pattern (`dsh-tenant-sandbox-local` forks
  `sandbox-local`).
- **App-side per-user key vault + injection at `src/services/dsh/dsh-proxy.js`.**
  The proxy already authenticates every request and knows `req.user.id`, but
  the harness resolves credentials from its own store at agent-run time, not
  from a per-request header, so this still needs a harness seam that accepts a
  per-tenant credential — i.e. this package anyway.
- **Fail closed with no tenant bound, like the sibling packages.** Rejected: it
  would break `dsh` in the harness checkout (its e2e and local runs read
  `$DSH_HOME/.credentials.yaml` / `.env`), and the proxy path always binds a
  tenant, so the strict posture buys nothing here.
- **Keep the watcher on tenant stores.** Rejected: it exists upstream for
  cross-*process* hot reload, which this single-container deployment does not
  have; dropping it removes the chokidar reconcile-race surface for the common
  path.
- **Scope, rather than drop, the `credentials/reference-updated` downlink
  frame.** Deferred: the forwarded frame would need to carry its originating
  tenant. Until then dropping it is correct — a tenant must not be told another
  tenant touched a credential.

## Consequences

- Each tenant's DeepSeek usage is billed to and rate-limited by that tenant's
  own key; onboarding prompts every user, not just the first.
- Cost: a fork that must be kept byte-aligned with `credentials-local`'s
  private render/assert helpers (marked `jscpd:ignore`, mirroring how that
  package tracks `dsh-settings-file`). If upstream changes those helpers, this
  copy needs the same edit.
- A pre-change `$DSH_HOME/.credentials.yaml` written by the old shared flow
  becomes only the no-tenant fallback: harmless on the proxy path (a tenant is
  always bound) but still parsed at boot. An operator upgrading a deployment
  that used the single-key flow should move each user's key into
  `tenants/<id>/.credentials.yaml` or delete the shared file.
- No migration path moves an existing shared key into per-tenant documents;
  users re-enter their key once through the onboarding modal.

## Testing

`packages/tenant/dsh-tenant-credentials-local/tests/` (100% per-file coverage):
tenant routing and cross-tenant invisibility with two distinct 32-hex tenant
ids, the shared env/`.env` layering and its shadow-rejection, the no-tenant
fallback to the shared document, the record half, boot-time flat migration, the
shared-store watcher pipeline (external edits, partial-change diffing, watcher
errors, unreadable-at-runtime, invariant rethrow), and the dispose-versus-queued-write
drain. `dsh-tenant-session-guard`'s spec gains the dropped-credential-remote-event
case. End-to-end verification on a live two-tenant stack (each user sets a
distinct key; each `.credentials.yaml` lands under its own `tenants/<id>/`;
neither sees the other's; agent prompts run on the per-tenant key) is a
deployment step, not covered here.

## Related

- `deploy/tenant-isolation.cordis.patch.yml` — the patch row that mounts this.
- [Splitting the credential store from the user environment layer](2026-08-04-credentials-yaml-and-user-environment-layer.md) — the `.credentials.yaml` / `.env` split this fork inherits.
- [Request-level LLM config and credentials](2026-07-29-request-level-llm-config-credentials.md) — per-request credential resolution, which is what makes async-local tenant routing possible.
