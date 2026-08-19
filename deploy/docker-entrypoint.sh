#!/bin/sh
# Boots `dsh --profile web` bound for the container network. This GUI has no
# login of its own (see the Agent Note linked from deploy/README.md), so
# DSH_TRUSTED_HOST must name the public authority NGINX presents and nothing
# in front of this container may skip authenticating the request first.
set -eu

: "${DSH_TRUSTED_HOST:?DSH_TRUSTED_HOST must be set to the public authority (e.g. comp370.soc.ufv.ca) so the /api DNS-rebinding fence accepts proxied requests}"
: "${DSH_WEB_HOST:=0.0.0.0}"
: "${DSH_WEB_PORT:=3080}"

exec node apps/cli/lib/bin.js web \
  --host "$DSH_WEB_HOST" \
  --port "$DSH_WEB_PORT" \
  --no-open \
  --allow-all-interfaces \
  --trusted-host "$DSH_TRUSTED_HOST"
