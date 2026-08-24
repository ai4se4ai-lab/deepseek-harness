# @mindportalix/dsh-tenant-context

Per-request tenant identity for the single shared DSH container behind the MindPortalix reverse proxy. Provides `ctx.tenantContext`, a Cordis service wrapping one process-wide `node:async_hooks` `AsyncLocalStorage<string | undefined>`.

- `resolveTenant(headers)` reads the trusted `x-mp-dsh-tenant` proxy header, validates it against `/^[0-9a-f]{32}$/`, and returns `undefined` for anything absent or malformed. It never throws.
- `run(tenantId, fn)` binds `tenantId` to the active async chain for `fn`'s whole lifetime, including every `await` and async-generator resumption inside it.
- `current()` reads the bound tenant id, or `undefined` outside any `run()` call.
- `requireCurrent()` is the fail-closed primitive every tenant-enforcing consumer must call at its point of enforcement: it throws `TenantRequiredError` instead of letting a caller silently proceed unscoped.

This package derives no tenant identity itself — it only carries whatever `resolveTenant` validated from the trusted header. Callers establishing tenant scope (the patched `packages/client/connection` entry points) are responsible for calling `resolveTenant`/`run` at the point they first see the header.

## Model Experience

This package has no model, token, or KV-cache effect: it is host-process plumbing with no system-prompt, tool, or session-log surface.

## Known Limitations and Deferred Work

- `resolveTenant` trusts its caller to hand it headers already stripped of any client-forgeable value. Enforcing that stripping is the MindPortalix reverse proxy's job (`src/services/dsh/dsh-proxy.js` in the outer repo), not this package's.
