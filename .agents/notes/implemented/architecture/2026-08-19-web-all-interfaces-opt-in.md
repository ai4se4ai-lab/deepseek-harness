# Agent Note: `dsh web --allow-all-interfaces` — an explicit opt-in past the loopback-only default

Status: implemented

English | [中文](2026-08-19-web-all-interfaces-opt-in.zh.md)

## Problem

`dsh --profile web` refused `--host 0.0.0.0` unconditionally: the Web GUI's `/api` surface has no login of its own (the Host/Origin fence in `dsh-client-connection` defends against DNS rebinding and cross-site requests, not authentication — [`api-request-trust.ts`](../../../packages/client/connection/src/api-request-trust.ts)), so any socket that can reach the port gets full tool execution (shell, filesystem, subprocess) as the process's user. Binding all interfaces on a bare host would hand that out to the whole network. A reverse-proxy deployment (containerized, behind nginx, with its own authentication and network isolation) is a legitimate exception the CLI had no way to express: the only escape was deleting the check, which would silently remove the protection for every other invocation too.

## Decision

`--host 0.0.0.0` still fails loud by default with the original message. A second flag, `--allow-all-interfaces`, must be present in the same invocation to proceed; omitting it while passing `--host 0.0.0.0` keeps the exact prior error text. The flag adds no protection of its own — no auth, no additional fence — it only records that the operator has already put one in place outside this process. `--help` documents the combination together with the caveat that it silences the check rather than closing the gap.

## Consequences

An operator can now run `dsh --profile web --host 0.0.0.0 --allow-all-interfaces --trusted-host <public-authority>` to serve the GUI to a reverse proxy on a container network, provided that proxy (or another layer in front of it) supplies real authentication — `--allow-all-interfaces` does not. `--trusted-host` remains required for the same deployment to pass the DNS-rebinding fence at all: the fence's default `trustedHosts` is empty, so every request whose `Host` is neither loopback nor a declared authority is refused regardless of the bind host. The default invocation (`dsh web` with no flags, or `--host 127.0.0.1`) is unchanged. `packages/bundle/web-app/tests/startup.spec.ts` covers both the unchanged rejection and the new opt-in path.

## Alternatives considered

- **Delete the check entirely** — restores exactly the blanket footgun the original guard existed to prevent for the common case (a developer running `dsh web` on their own machine), for the sake of one deployment shape.
- **Make the bind host fully free-form (`z.string()`), no flag at all** — loses the loud-failure default; a typo'd or copy-pasted `--host 0.0.0.0` in a normal local invocation would silently expose the port instead of erroring.
- **Gate on `--trusted-host` being non-empty instead of a dedicated flag** — conflates two independent facts (which Host headers the DNS-rebinding fence accepts vs. whether the operator has accepted the all-interfaces risk); a deployment could have trusted hosts configured for an unrelated reason without intending to bind wide open.
