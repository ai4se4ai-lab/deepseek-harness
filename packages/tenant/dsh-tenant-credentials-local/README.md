# @mindportalix/dsh-tenant-credentials-local

Tenant-scoped fork of [`@deepseek-ai/dsh-credentials-local`](../../credentials/credentials-local/README.md), for the single shared DSH container behind the MindPortalix reverse proxy. Registers as `ctx.credentials`, replacing the upstream provider (see `deploy/tenant-isolation.cordis.patch.yml`, which disables the base `credentials` row and inserts this one — an id-targeted patch cannot change which package a row loads).

Upstream reads and writes **one** `$DSH_HOME/.credentials.yaml` for the whole process. That is the cross-tenant path this package closes: the first user to paste a `DEEPSEEK_API_KEY` into the harness's onboarding modal would otherwise set it for every other tenant sharing the container (and pay for and be rate-limited by everyone else's traffic). Here every credential reference and record resolves and persists against the caller's own `$DSH_HOME/tenants/<tenantId>/.credentials.yaml`, with the tenant id read per call from `ctx.tenantContext` (async-local, bound by `@mindportalix/dsh-tenant-context` from the trusted proxy header).

## Layers

| Layer | Source id | Scope | Writable | Wins |
|---|---|---|---|---|
| Inherited process environment | `env` | **shared** (all tenants) | no | always |
| `$DSH_HOME/tenants/<tenantId>/.credentials.yaml` | `file` | per tenant | yes (`set`/`unset`) | over both `.env` layers |
| `<invocation cwd>/.env` | `project-env` | shared | not here | over the user `.env` |
| `$DSH_HOME/.env` | `user-env` | shared | not here | otherwise |

Only the `file` layer became per-tenant. The inherited environment and the launcher's `.env` files stay a single shared layer with the exact precedence and read-only semantics of upstream — a value there is one operator-set credential for the whole deployment. That is why `docker-compose.dsh.yml` leaves `DEEPSEEK_API_KEY` **unset**: with it set, every tenant would share that one key and the per-tenant document below could never take effect. `describe()` still reports `source: 'env', writable: false` for an environment-supplied reference, and `set`/`unset` still reject rather than write a change resolution would shadow.

## No tenant bound

With no tenant identity on the calling async chain — a bare `dsh` CLI run in the checkout, a config-driven agent boot, this package mounted without the rest of the patch layer — the provider resolves the **shared** `$DSH_HOME/.credentials.yaml` with its filesystem watcher, i.e. exactly upstream's single-store behavior. This is the one deliberate departure from the fail-closed posture of the sibling tenant packages (`dsh-tenant-sandbox-local` throws): a credential provider that returned nothing here would break the harness checkout's own local and e2e use, and no tenant is ever unbound on the proxy path. `static inject = ['tenantContext']` still makes a composition without the tenant-identity service fail loud at boot.

## Config

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home whose `tenants/<id>/` subtree holds each tenant's document. |
| `sharedPath` | `<harness home>/.credentials.yaml` | The no-tenant fallback document. |
| `watch` | `true` | Watch the **shared fallback** document and hot-publish external edits. Tenant documents never watch. |
| `debounceMs` | `100` | Shared-store watcher write-settle window. |

Tenant documents carry no watcher because one process is the only writer of each: an in-process `credentials.set` updates that tenant's snapshot directly, and there is no second process to observe. The shared fallback keeps its watcher so local `dsh` use is unchanged.

## The document

Identical to upstream, per file: a versioned YAML document with `refs:` and `records:` sections, `0600` under a `0700` directory. Parsing, the storable-value assertions, and the pre-release flat-layout migration are `@deepseek-ai/dsh-credentials-local`'s own (`parseCredentialsDocument` / `renderFlatLayoutMigration` are imported, not re-implemented); only the small comment-preserving render helpers are re-stated here, kept aligned with that package's private helpers. Each write re-reads under the cross-process writer lock of [`dsh-atomic-write`](../../util/atomic-write/README.md), folds in anything it had not observed, then commits atomically; a document that no longer parses fails the write rather than being overwritten. Committed changes fan out through `credentials/reference-updated` / `credentials/record-updated` on the shared `ctx`.

Note: `@mindportalix/dsh-tenant-session-guard` **drops** the `credentials/reference-updated` `host/remote-event` from every tenant downlink — the frame carries only the ref name and no originating tenant, so one tenant's key write must not wake another's Models page; a tenant's own second browser tab picks the change up on reload.

## Permissions

The provider creates each tenant directory and `tenants/<id>/` `0700` and creates or atomically replaces the document `0600`. On POSIX a document carrying any group or other permission bit fails before its contents are parsed — at boot and on every reload — and the error names the `chmod 600` repair. Windows has no mode to inspect; the check is skipped there rather than faked. The container's own perms-sidecar (`docker-compose.dsh.yml`'s `dsh-file-perms-sync`) keeps `tenants/` directories group-writable `770` and files `640`; a `.credentials.yaml` written `0600` by DSH's uid stays owner-only and is read back by that same uid, so the sidecar never loosens it past the assertion.

## Security boundary

Same as upstream: `0600` under `0700` stops other OS users, **not** the model — tool processes run as the same user and can read any file the user owns. What is narrower still holds: the harness never hands the model a resolved path to a credentials document and never loads one into the process environment. Additionally here, `@mindportalix/dsh-tenant-sandbox-local` confines each tenant's tool processes to that tenant's own `$DSH_HOME/tenants/<tenantId>` root, so tenant B's confined bash cannot read tenant A's `.credentials.yaml` at all — a kernel-level denial, not discretion. An OS-keychain provider (a store the model's processes cannot read even within their own tenant) remains the deferred answer for keeping provider keys from a deployment's own agent.

## Model Experience

Indirectly, through the consuming LLM adapters, which own every model-facing use the resolved value authorizes; this fork only changes which file the value comes from.

#### KV Cache effect

No direct invalidation; credentials never enter a request prefix.

## Known Limitations and Deferred Work

- **`credentials/reference-updated` is dropped, not scoped, on tenant downlinks** — see the note above; scoping would need the forwarded frame to carry the originating tenant. A tenant's own extra browser tab reflects a key change only after reload.
- **Same-reference concurrent writes are last-write-wins** — inherited from upstream: the writer lock and read-modify-write keep concurrent writers from dropping each other's entries, but two writers editing one reference resolve to the later write; there is no revision check.
- **A same-UID, same-tenant process can read the document** — the file-effect sandbox modes do not deny reads *within* a tenant root; cross-tenant reads are denied by `dsh-tenant-sandbox-local`. An OS-keychain provider is deferred.
- **Shared-fallback environment changes are invisible** — the launch environment snapshot is frozen at launch; changing an environment-sourced credential takes a restart.
- **Atomic, not crash-durable** — inherited from `dsh-atomic-write`; each store re-reads on boot.
- **A stale pre-change `$DSH_HOME/.credentials.yaml`** (written by the old shared flow) is now only the no-tenant fallback. It is harmless on the proxy path (a tenant is always bound) but is still parsed at boot; an operator upgrading a deployment that used the old single-key flow should move each user's key into `tenants/<id>/.credentials.yaml` or delete the shared file.
