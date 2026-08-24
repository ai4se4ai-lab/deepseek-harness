# syntax=docker/dockerfile:1
#
# Builds and serves the `dsh --profile web` browser GUI (apps/cli + apps/web)
# from this pnpm workspace. See deploy/README.md for the full deployment
# story, including why the container must be reached only through a proxy
# that supplies its own authentication (this GUI has none of its own).

ARG NODE_VERSION=22.19-bookworm-slim

# ---- deps: install the full workspace (native addons need a toolchain) -----
FROM node:${NODE_VERSION} AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# Copy only what `pnpm install` resolves from before copying source, so
# dependency layers stay cached across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# scripts/install-lefthook.mjs runs as the root package's `postinstall`.
COPY scripts ./scripts
COPY patches ./patches
COPY vendor ./vendor
COPY native ./native
COPY packages ./packages
COPY apps ./apps
# website is a pnpm-workspace.yaml member (VitePress docs site) never built or
# run here, but scripts/project-doc-site.ts (compiled by the host tsc build)
# imports website/docs.ts, so the directory travels whole (128K, tiny).
COPY website ./website
RUN pnpm install --frozen-lockfile

# ---- build: compile every lib/ face and the web frontend bundle ------------
FROM deps AS build
COPY tsconfig*.json tsdown.config.ts ./
# The build stamps client artifacts with the source commit
# (scripts/client-build-environment.ts); .git is not part of this build
# context (see .dockerignore), so the caller supplies it explicitly instead
# of the script's git-rev-parse fallback. docker-compose.yml passes the real
# commit through `build.args`.
ARG DSH_CLIENT_COMMIT_HASH=0000000
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}
RUN pnpm run build

# ---- runtime: slim image, non-root, only the built output ------------------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# PRE-EXISTING GAP, discovered and fixed while validating MINDPORTALIX-TENANT-ISOLATION's
# sandbox fork: neither Linux confinement backend @deepseek-ai/dsh-sandbox-local (and
# therefore this fork) selects between was actually usable in this image before this line —
# bubblewrap ships in neither the node:*-bookworm-slim base nor this Dockerfile, and the
# Landlock launcher's native binary (native/landlock-run/packages/linux-*/bin/landlock-run)
# is a CI release artifact not checked into this git checkout, so ctx.sandbox.confine() threw
# SANDBOX_UNAVAILABLE for every request. This is not new to the tenant-isolation work — the
# unmodified upstream provider hits the identical failure in this same image — but it means
# the whole sandbox subsystem, tenant-scoped or not, was nonfunctional in this deployment
# until fixed. bwrap needs no special container privileges beyond ordinary unprivileged
# user-namespace creation, which Docker's default seccomp/apparmor profile permits.
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/vendor ./vendor
COPY --from=build /app/native ./native
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# MINDPORTALIX-TENANT-ISOLATION: shipped as its own --patch overlay (see the
# entrypoint script and deploy/tenant-isolation.cordis.patch.yml's header
# comment for why this is a --patch flag rather than a copy into $DSH_HOME).
COPY deploy/tenant-isolation.cordis.patch.yml /app/deploy/tenant-isolation.cordis.patch.yml
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data \
    && chown -R node:node /app /data

# $DSH_HOME (session/storage state) is bind-mounted at /data by compose; see
# the `deepseek-harness-data` volume in docker-compose.yml.
ENV DSH_HOME=/data
VOLUME ["/data"]

USER node
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DSH_WEB_PORT||3080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
