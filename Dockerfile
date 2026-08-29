# syntax=docker/dockerfile:1
#
# MindPortalix-owned DSH image. scripts/docker-up.{sh,ps1} copy this file
# (and rebuild-sharp-x86-v1.sh) into projects/deepseek-harness/ before build.
#
# Builds and serves the `dsh --profile web` browser GUI (apps/cli + apps/web)
# from this pnpm workspace. See deploy/README.md for the full deployment
# story, including why the container must be reached only through a proxy
# that supplies its own authentication (this GUI has none of its own).
#
# MINDPORTALIX: on hosts without SSE4.2 (Common KVM / x86-64-v1), sharp's
# linux-x64 prebuilds refuse to load. deploy/rebuild-sharp-x86-v1.sh rebuilds
# libvips + sharp for baseline x86-64 during the deps stage (no-op when the
# build host already has SSE4.2).

ARG NODE_VERSION=22.19-bookworm-slim

# ---- deps: install the full workspace (native addons need a toolchain) -----
FROM node:${NODE_VERSION} AS deps
# musl-tools: needed to compile the static landlock-run launcher (see below).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ musl-tools \
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

# The landlock-run binary is a CI release artifact (gitignored under
# native/landlock-run/packages/linux-*/bin/). Without it, workspace-write bash
# fails closed with SANDBOX_UNAVAILABLE — agents talk about creating files but
# never write them, so My Workspace → DSH Files stays empty. Build it here from
# the checked-in C source so every MindPortalix image ships a working Landlock
# backend. (bwrap is still installed at runtime, but many Docker hosts set
# apparmor_restrict_unprivileged_userns=1, which makes bwrap unusable; Landlock
# is the backend that actually engages in that common case.)
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64|x86_64) ll_arch=x64 ;; \
      arm64|aarch64) ll_arch=arm64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH} for landlock-run"; exit 1 ;; \
    esac; \
    src=native/landlock-run/packages/entry/src/main.c; \
    out=native/landlock-run/packages/linux-${ll_arch}/bin/landlock-run; \
    mkdir -p "$(dirname "$out")"; \
    musl-gcc -std=c11 -Os -Wall -Wextra -Werror -static -s -o "$out" "$src"; \
    "$out" --probe

RUN pnpm install --frozen-lockfile

# MINDPORTALIX: sharp x86-64-v1 compat (see deploy/rebuild-sharp-x86-v1.sh).
COPY deploy/rebuild-sharp-x86-v1.sh /tmp/rebuild-sharp-x86-v1.sh
RUN chmod +x /tmp/rebuild-sharp-x86-v1.sh \
    && /tmp/rebuild-sharp-x86-v1.sh \
    && rm -f /tmp/rebuild-sharp-x86-v1.sh

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

# Sandbox backends for workspace-write (tenant isolation):
# - bubblewrap: installed here; often unusable under Docker when the host sets
#   apparmor_restrict_unprivileged_userns=1 (bwrap cannot create a user namespace).
# - landlock-run: compiled in the deps stage from native/landlock-run (see above)
#   and copied via /app/native — that is the backend that actually engages on
#   typical Docker Desktop / Ubuntu hosts. Without it, bash/npx fail with
#   SANDBOX_UNAVAILABLE and DSH Files stay empty for shell-created projects.
#
# Shared image libs: required when deps rebuilt sharp against /usr/local libvips
# (x86-64-v1 path). Harmless extras when the SSE4.2 prebuild path was used.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap \
      libglib2.0-0 libexpat1 \
      libjpeg62-turbo libpng16-16 libwebp7 libwebpmux3 libwebpdemux2 libtiff6 \
      libexif12 libfftw3-double3 liborc-0.4-0 \
    && rm -rf /var/lib/apt/lists/*

# Baseline libvips from the deps rebuild (directory may be mostly empty on v2 hosts).
COPY --from=deps /usr/local/lib /usr/local/lib
RUN ldconfig || true

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
    && mkdir -p /data /home/node/.npm /tmp/npm-cache /tmp/.cache /tmp/.config \
    && chown -R node:node /app /data /home/node /tmp/npm-cache /tmp/.cache /tmp/.config

# $DSH_HOME (session/storage state) is bind-mounted at /data by compose; see
# the `deepseek-harness-data` volume in docker-compose.yml.
ENV DSH_HOME=/data
ENV LD_LIBRARY_PATH=/usr/local/lib
VOLUME ["/data"]

USER node
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DSH_WEB_PORT||3080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
