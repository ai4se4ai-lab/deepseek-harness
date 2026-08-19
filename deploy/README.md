# Deploying `deepseek-harness` on the COMP 370 portal

This directory holds the operational pieces for running the `dsh --profile
web` browser GUI as a container behind the COMP 370 NGINX reverse proxy. It
is deployment paperwork, not product documentation — see the root
[`Dockerfile`](../Dockerfile), [`docker-compose.yml`](../docker-compose.yml),
and [`.env.example`](../.env.example) alongside it.

## Read this first: what you are exposing

`dsh web` is a local coding-agent GUI (like an in-browser Claude Code): once
a browser reaches it, it can run shell commands, read/write files, and spawn
subprocesses as the container's process. It ships with **no login, no user
accounts, no API key gate on the browser-facing API**. The only built-in
defense is a Host/Origin check that stops DNS-rebinding and cross-site
requests — the code says so directly:

> "Network reachability and authentication stay out of scope: binding policy
> belongs to the webserver config, and this fence is not an auth layer."
> — [`packages/client/connection/src/api-request-trust.ts`](../packages/client/connection/src/api-request-trust.ts)

The CLI used to refuse `--host 0.0.0.0` outright for exactly this reason. To
containerize it at all, this change added an explicit opt-in,
`--allow-all-interfaces` (see
[`packages/bundle/web-app/src/startup.ts`](../packages/bundle/web-app/src/startup.ts)
and the Agent Note at
[`.agents/notes/implemented/architecture/2026-08-19-web-all-interfaces-opt-in.md`](../.agents/notes/implemented/architecture/2026-08-19-web-all-interfaces-opt-in.md)).
**That flag silences the safety check; it does not replace it.** Before this
container is reachable from anywhere but your own machine, put real
authentication in front of it — NGINX Basic Auth, the university SSO, a VPN,
or an IP allowlist restricted to course staff. This deployment does not
include that layer; wiring it in is a prerequisite, not a follow-up.

## Application inspection summary

- **Language/runtime**: TypeScript on Node.js, `^22.19.0 || >=24.0.0`, ESM (`"type": "module"`), pnpm workspaces monorepo.
- **Entry point**: `apps/cli` (package `@deepseek-ai/dsh`, bin `dsh` → `lib/bin.js`). The browser GUI is one profile of that CLI: `dsh --profile web` (alias `dsh web`).
- **Package manager**: pnpm `11.7.0` (via corepack), `pnpm-workspace.yaml`.
- **Build**: `pnpm run build` = `build:lib` (tsc + tsdown across every package's host/client faces) + `build:web` (`vite build` for `apps/web`, output `apps/web/dist`).
- **Production start command**: `node apps/cli/lib/bin.js web --host 0.0.0.0 --port 3080 --no-open --allow-all-interfaces --trusted-host <public-authority>` (wrapped by [`deploy/docker-entrypoint.sh`](docker-entrypoint.sh)).
- **Dev command**: `pnpm dsh web` from a checkout (source launch via tsx); `pnpm run dev:web` alongside it enables client-plugin hot reload.
- **Listening port**: configurable, defaults to `3080`; host defaults to `127.0.0.1` and the CLI refuses `0.0.0.0` without `--allow-all-interfaces` (see above).
- **Frontend/backend**: one Node HTTP server ([`packages/host/webserver`](../packages/host/webserver)) serves both — the built React SPA as a static/SPA-fallback route ([`packages/host/frontend-static`](../packages/host/frontend-static)) and a JSON-RPC + WebSocket API under `/api` ([`packages/client/connection`](../packages/client/connection), [`packages/host/apiproxy`](../packages/host/apiproxy)). There is no separate backend process.
- **Database**: none. **Redis**: none.
- **External API / LLM**: DeepSeek's cloud API only, via [`packages/llm/llm-deepseek`](../packages/llm/llm-deepseek), authenticated by `DEEPSEEK_API_KEY` (optional `DEEPSEEK_BASE_URL`/`DEEPSEEK_SEARCH_BASE_URL` overrides).
- **Ollama**: not referenced anywhere in this codebase. There is no local-model runtime to wire up.
- **GPU**: not required by this application. Nothing here needs the NVIDIA Container Toolkit.
- **Filesystem / persistence**: all durable state — session logs, storage/projection data, installed profile plugins — lives under `$DSH_HOME` (default `~/.dsh`, [`packages/util/home-paths`](../packages/util/home-paths)). No separate uploads directory; no rotated log files (see Logging below).
- **WebSockets**: yes — `MUX_EVENTS_PATH`/`HOST_EVENTS_PATH` upgrade routes under `/api` ([`packages/client/connection/src/index.ts`](../packages/client/connection/src/index.ts)) carry live event/streaming traffic.
- **Health check**: no dedicated endpoint exists in the app. `GET /` is a genuine functional check anyway — it is served by `frontend-static`, which reads the built `index.html` off disk on every request, so it fails if the process is wedged or the frontend dist is missing/corrupt. That is what the Docker health check below uses; it is not a bare "return 200".
- **Existing Docker files**: none before this change.

## Architecture

```
INTERNET
   │  HTTPS
   ▼
comp370.soc.ufv.ca  (resolves off-VM; see "What this VM does not own" below)
   │
UFV network/NAT
   │
   ▼
COMP 370 VM
   │
   ▼
NGINX (deploy/nginx/deepseek-harness.conf, included from the portal's server{} block)
   │  http://deepseek-harness:3080  (internal Docker network only)
   ▼
deepseek-harness container ── DEEPSEEK_API_KEY ──▶ DeepSeek cloud API (api.deepseek.com)
   │
   ▼
/data  (named volume → $DSH_HOME: session logs, storage, installed profile state)
```

No database, no Redis, no Ollama, no GPU: none exist in this application.

### What this VM does not own

`comp370.soc.ufv.ca` resolves to `198.162.116.20`, not this VM's own address
(`172.30.255.29`). Something outside this VM — UFV's network/NAT — forwards
the public hostname here; this deployment does not touch DNS, does not
assume it owns public `443`, and does not modify firewall rules. It only
configures the pieces inside the VM: the container, the internal Docker
network, and the NGINX location block that the portal's existing NGINX
already terminates TLS for.

## Ports

| Port | Where | Public? |
|---|---|---|
| 443 | portal NGINX (already exists) | yes — the only public port |
| 3080 | `deepseek-harness` container | no — `expose:` only, reachable at `http://deepseek-harness:3080` from other containers on the `comp370` network |

`docker-compose.yml` as checked in also publishes `3080:3080` on `ports:` for
standalone local testing (`docker compose up -d` with no NGINX in front). The
portal deployment (merging the service into the real portal compose project)
must drop that `ports:` block — see the comment at the top of the file.

## Configuration (`.env`)

Copy [`.env.example`](../.env.example) to `.env` (repo root) and fill it in;
`.env` is gitignored and is never baked into the image (excluded via
[`.dockerignore`](../.dockerignore)). Variables actually read by this
application (no invented ones):

| Variable | Required | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | yes | DeepSeek API auth ([`packages/llm/llm-deepseek`](../packages/llm/llm-deepseek)) |
| `DEEPSEEK_BASE_URL` | no | overrides the DeepSeek endpoint |
| `DEEPSEEK_SEARCH_BASE_URL` | no | overrides the DeepSeek web-search endpoint |
| `DSH_TRUSTED_HOST` | yes in the portal deployment | public authority (`comp370.soc.ufv.ca`) the `/api` Host-fence must accept from a proxied request |
| `DSH_WEB_PORT` | no (default `3080`) | container-internal listen port |

`DSH_HOME` is set inside the image (`/data`, a mounted volume) and should
not be overridden.

## Ollama / LLM integration

There is no Ollama integration to configure. Every model call this
application makes goes to DeepSeek's hosted API over HTTPS from inside the
container, using `DEEPSEEK_API_KEY`. Nothing needs `localhost:11434`,
`host.docker.internal`, or an `ollama` service.

## GPU

Not required. Nothing in this codebase requests GPU access, and the compose
file grants none.

## Persistent data

| Path (in container) | Contents | Volume |
|---|---|---|
| `/data` (`$DSH_HOME`) | session logs, storage/projection cache, installed profile plugin state | named volume `deepseek-harness-data` |

Everything else in the container is rebuildable from the image; only `/data`
needs to survive `docker compose down` / recreation. The volume is declared
in `docker-compose.yml` and is never a host bind of the whole filesystem.

## Health check

```yaml
healthcheck:
  test: ["CMD", "node", "-e",
    "fetch('http://127.0.0.1:'+(process.env.DSH_WEB_PORT||3080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 30s
  timeout: 5s
  start_period: 20s
  retries: 3
```

This is baked into the [`Dockerfile`](../Dockerfile) `HEALTHCHECK` (compose
inherits it). It requests `/`, which `frontend-static` answers only by
successfully reading the built `index.html` from disk — a wedged process or
a missing/corrupt frontend build fails it, so this is a real functional
check, not a fixed 200.

## Subpath compatibility — read before wiring in the NGINX config

This is the one place this deployment does not fully match the ideal in
principle: **the application was not built with subpath hosting in mind.**
Two things are fixed, root-relative paths compiled into the app, not
deployment config:

- The built frontend (`apps/web`, Vite's default `base: '/'`) references its
  own assets as `/assets/...`, `/manifest.webmanifest`, `/favicon.svg` — all
  absolute from the origin root.
- The `/api` transport path is a protocol constant
  (`packages/client/connection/src/api-path.ts`), baked into the client
  bundle as the literal string `/api`, used for both the RPC fetch calls and
  the WebSocket upgrade paths. Per this repo's own conventions, protocol
  constants are supposed to stay fixed rather than become a configurable
  deployment knob — so the fix is not "make `/api` prefix-aware," it is
  giving the whole app one deployment-configurable root, which is a real
  feature this codebase does not have yet.

[`deploy/nginx/deepseek-harness.conf`](nginx/deepseek-harness.conf) works
around this the only way available without that feature: it serves the SPA
shell at `/projects/deepseek-harness/` (prefix-stripped) and **also** claims
`/api/`, `/assets/`, `/manifest.webmanifest`, and `/favicon.svg` at the
shared NGINX root, proxying all of them to the same container. This works
correctly, but **only if no other project behind the same NGINX also claims
those exact path segments** — confirm that with whoever owns the landing
page and the other `/projects/*` entries before enabling this file. If
there's a collision, the safe alternative is a dedicated subdomain for this
app (sidesteps the whole prefix question) rather than sharing the root.

A proper fix — a deployment-configurable base path threaded through
`host-webserver`, `frontend-static`, `client-connection`, and the Vite
build — is real, scoped feature work, not a config tweak; it belongs in its
own `proposed/` Agent Note before implementation, not folded silently into a
Docker packaging change.

## WebSocket / streaming support

Confirmed in use: `packages/client/connection` registers WebSocket upgrade
routes at `MUX_EVENTS_PATH`/`HOST_EVENTS_PATH` under `/api`, carrying live
event and token-streaming traffic. The NGINX config sets
`proxy_http_version 1.1`, `Upgrade`/`Connection: upgrade` headers (via a
`map` that only upgrades when the client actually asks), `proxy_buffering
off`, and 1-hour read/send timeouts on the `/projects/deepseek-harness/` and
`/api/` locations — not applied globally, only where streaming/upgrade
traffic actually flows.

## Landing page registration

No landing-page repository exists in this codebase or on this VM (only this
`deepseek-harness` repo was found), so there is nothing to edit directly.
The entry to add to the portal's centralized project config, once that repo
is available:

```typescript
{
  id: "deepseek-harness",
  name: "DeepSeek Harness",
  description: "A local coding-agent GUI backed by the DeepSeek API — chat-driven shell, filesystem, and subprocess tool execution in the browser.",
  path: "/projects/deepseek-harness/",
  status: "active",
  technologies: ["Docker", "Node.js", "TypeScript", "React", "DeepSeek API", "Vite"],
}
```

The landing page must not hardcode `localhost:3080` or the VM's internal
address anywhere — only the `path` above, resolved through NGINX. Because
the landing page is a separate service, `deepseek-harness` being down does
not affect it; the landing page simply reflects whatever `status` is
configured.

## Running

```bash
# Local/dev, standalone (this repo's docker-compose.yml as checked in):
cp .env.example .env   # fill in DEEPSEEK_API_KEY
docker compose up -d
docker compose ps
curl -sf http://localhost:3080/ | head -c 200

# Portal deployment: merge the `deepseek-harness` service and
# `deepseek-harness-data` volume from docker-compose.yml into the portal's
# own compose project (which owns nginx/landing/the comp370 network), drop
# this file's `ports:` block, include deploy/nginx/deepseek-harness.conf
# from the portal's NGINX server{} block, then:
docker compose up -d deepseek-harness
```

## Development without Docker

Unchanged from the existing workflow — Docker is not required for day-to-day
development:

```bash
pnpm install
pnpm run build          # or: pnpm run build:lib && pnpm run build:web
pnpm dsh web            # boots the web profile from source (tsx)
pnpm run dev:web        # optional, alongside the above: client-plugin HMR
```

## Stopping / logs / rebuilding

```bash
docker compose down                              # stop (keeps the named volume)
docker compose logs -f deepseek-harness           # stdout/stderr — no separate log files to hunt for
docker compose build --no-cache deepseek-harness
docker compose up -d deepseek-harness
docker compose restart deepseek-harness           # confirm recovery: curl /, or `docker compose logs`
```

## Security posture

- **Public**: only the portal's existing NGINX `443`.
- **Internal-only**: `deepseek-harness:3080`, reachable exclusively on the
  `comp370` Docker network — never published with a host `ports:` mapping in
  the portal deployment.
- **No secrets in the image**: `.env` is gitignored and excluded via
  `.dockerignore`; `DEEPSEEK_API_KEY` and `DSH_TRUSTED_HOST` arrive only as
  real container environment variables set by compose at run time.
- **Non-root**: the runtime stage runs as the image's built-in `node` user.
- **Restart-safe**: `restart: unless-stopped`; `init: true` gives the
  container a real PID 1 (Docker's built-in `tini`) so `SIGTERM` reaches the
  Node process directly and the app's own bounded graceful-shutdown
  (`apps/cli/src/process-shutdown.ts`, 5 s grace) runs before exit, and so
  subprocess children the agent spawns (bash tool calls, etc.) don't leak as
  zombies.
- **What is *not* mitigated here, by design of the upstream application**:
  authentication. `--allow-all-interfaces` plus `--trusted-host` only get a
  proxied request past the DNS-rebinding fence; they authenticate no one.
  Do not point this container's NGINX location at the public internet
  without adding real access control in front of it first (see "Read this
  first" above).

## Testing performed

All of the following ran for real in this session (`docker build`/`docker run` against the actual Docker daemon on this machine, not a dry run):

- `npx vitest run packages/bundle/web-app/tests/startup.spec.ts` — 6/6 pass, including the new `--allow-all-interfaces` case and the unchanged bare-`0.0.0.0` rejection.
- `npx tsx scripts/verify-agent-note-format.ts` — passes with the new Agent Note included.
- `docker build --build-arg DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) -t deepseek-harness:local .` — succeeds end to end (full `pnpm install`, `tsc -b`, `tsdown`, `vite build`).
- `docker run` with `DEEPSEEK_API_KEY`/`DSH_TRUSTED_HOST`/`DSH_WEB_PORT` set, port published for the test only:
  - Startup log: `dsh web: http://127.0.0.1:3080 (LAN: http://172.17.0.2:3080)`.
  - `HEALTHCHECK` reached `healthy` within the `start_period`.
  - `curl /` → `HTTP 200`, real boot-manifest HTML (not a placeholder).
  - `curl /api/rpc` with a forged `Host: evil.example.com` → `HTTP 403` (DNS-rebinding fence rejects it).
  - Same request with the trusted `Host` → passes the fence (reaches the route handler, `HTTP 404` for the unrelated method — not a fence rejection).
  - `docker exec whoami` → `node` (uid 1000, not root).
  - `docker exec ls /data` → `profiles/`, `storages/` materialized under the mounted volume ($DSH_HOME).
  - `docker stop` (SIGTERM) → container stopped in ~1.1s, well inside Docker's default 10s grace window — confirms `apps/cli/src/process-shutdown.ts`'s bounded shutdown runs rather than being force-killed.
  - `docker start` after that stop → `curl /` → `HTTP 200` again (clean recovery).
- Not verified in this session, because the infrastructure is outside this repository and this VM: the real NGINX config, the actual `comp370.soc.ufv.ca` DNS/NAT path, and the shared-root path-collision risk noted above — those need sign-off from whoever owns the portal NGINX.

**Known gap**: the resulting image is ~3 GB — this build copies the full monorepo's `node_modules` (including devDependencies used only by `tsc`/`tsdown`/`vite`, not needed at runtime) into the final stage rather than pruning to a production-only install. It runs correctly as validated above; trimming it further (e.g. a `pnpm deploy`-style prune) is a worthwhile follow-up, not a correctness issue.

## Remaining infrastructure dependencies

- The actual `comp370` portal `docker-compose.yml` (nginx + landing + the
  shared network) — not present in this repository or found on this
  machine; the service/network/volume above are written to be merged into
  it, not to replace it.
- Confirmation from whoever owns the portal NGINX config that `/api/`,
  `/assets/`, `/manifest.webmanifest`, and `/favicon.svg` are not already
  claimed by another `/projects/*` entry (see "Subpath compatibility").
- An authentication layer in front of `/projects/deepseek-harness/` — not
  included in this change; required before this location is wired into a
  publicly reachable NGINX config.
- DNS/NAT from `comp370.soc.ufv.ca` to this VM, and the VM's public `443` —
  both outside this repository, unmodified by this change.
