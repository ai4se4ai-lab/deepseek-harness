#!/bin/sh
# Boots `dsh --profile web` bound for the container network. This GUI has no
# login of its own (see the Agent Note linked from deploy/README.md), so
# DSH_TRUSTED_HOST must name the public authority NGINX presents and nothing
# in front of this container may skip authenticating the request first.
set -eu

: "${DSH_TRUSTED_HOST:?DSH_TRUSTED_HOST must be set to the public authority (e.g. comp370.soc.ufv.ca) so the /api DNS-rebinding fence accepts proxied requests}"
: "${DSH_WEB_HOST:=0.0.0.0}"
: "${DSH_WEB_PORT:=3080}"

# Landlock workspace-write grants write access only to /tmp and the session
# workspace. npm/npx default to ~/.npm (EACCES under confinement). Compose
# redirects caches to /tmp; ensure those dirs exist on every boot.
mkdir -p /tmp/npm-cache /tmp/.cache /tmp/.config

# MINDPORTALIX-TENANT-ISOLATION: multi-tenant isolation for this single
# shared container (dsh-tenant-context / dsh-tenant-session-guard /
# dsh-tenant-sandbox-local / dsh-tenant-credentials-local — see
# deploy/tenant-isolation.cordis.patch.yml's
# header comment for why this is a --patch overlay and not a copy into
# $DSH_HOME/cordis.patch.yml).
#
# --patch MUST precede every app-owned flag below (--host, --port, ...): the
# `dsh web` launcher (apps/cli/src/args.ts) uses Commander's
# passThroughOptions(), so it stops recognizing its OWN options (--patch,
# --dump-config, --dump-default-config) at the first token that is not one of
# them and hands everything from there on to the web app verbatim. --patch
# placed after --host would silently become an inner app argument instead of
# a launcher patch overlay.
exec node apps/cli/lib/bin.js web \
  --patch /app/deploy/tenant-isolation.cordis.patch.yml \
  --host "$DSH_WEB_HOST" \
  --port "$DSH_WEB_PORT" \
  --no-open \
  --allow-all-interfaces \
  --trusted-host "$DSH_TRUSTED_HOST"
