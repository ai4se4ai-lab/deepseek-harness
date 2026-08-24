/**
 * Tenant-scoped fork of `@deepseek-ai/dsh-sandbox-local/src/profiles.ts`'s
 * Linux profile builders. Forked (not wrapped) because the change is to the
 * read-only grant itself, the security-critical line in the upstream file:
 * `bwrapProfileArgs`/`landlockProfileArgs` replace the blanket `--ro-bind / /`
 * / `readOnly: ['/']` grant — which handed every confined command read access
 * to the WHOLE container filesystem, including every other tenant's
 * `$DSH_HOME/tenants/<id>` directory — with an explicit allowlist of the
 * system paths the runtime and its tools actually need, plus exactly the
 * calling tenant's own root.
 *
 * `seatbeltProfileArgs` (macOS) and the Windows ACL rung are untouched and
 * irrelevant here: this container is Linux-only (see
 * `docker-compose.dsh.yml` / the Dockerfile's `node:*-bookworm-slim` base),
 * so this package re-exports them from upstream rather than forking them.
 * @module @mindportalix/dsh-tenant-sandbox-local/profiles
 */

import { existsSync } from 'node:fs'
import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-landlock-run'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

export { seatbeltProfileArgs } from '@deepseek-ai/dsh-sandbox-local/src/profiles.ts'

/**
 * Read-only system paths every confined command needs regardless of host:
 * the runtime binary tree (Node itself, spawned shells and tools) under a
 * Debian/Ubuntu-style merged-`/usr` layout (`node:*-bookworm-slim`, this
 * image's base). `/bin`, `/sbin`, and `/lib` are bound explicitly in addition
 * to `/usr` (rather than relying on their `/usr/*` symlinks resolving inside
 * the sandbox) so both spellings resolve regardless of exactly how the
 * confining backend materializes a bind over a symlinked source.
 */
const REQUIRED_SYSTEM_READ_ONLY_PATHS: readonly string[] = ['/usr', '/bin', '/sbin', '/lib']

/**
 * Read-only system paths bound only when present on the host, so a base
 * image variant missing one of them never turns into a hard sandbox-startup
 * failure (bwrap's `--ro-bind-try` / this file's own `existsSync` filter for
 * Landlock's grant list, both no-ops for an absent source):
 *
 * - `/lib64` — the compat dynamic-linker path some x86_64 distributions ship
 *   as a sibling of `/lib` (Debian ships it; not every base does).
 * - `/etc/resolv.conf`, `/etc/hosts` — DNS/hostname resolution; without
 *   these, `web_search`/`fetch`-style tools and any spawned network client
 *   cannot resolve names (loopback IP literals still work).
 * - `/etc/ssl` — TLS trust roots; without this, every HTTPS connection a
 *   confined process makes fails certificate verification.
 * - `/etc/passwd`, `/etc/nsswitch.conf` — uid/gid → name lookups and the
 *   name-service-switch order controlling how the above resolve; several
 *   shell builtins and tools (`git`, `ssh`, `id`, prompt expansion) call
 *   `getpwuid`/`getpwnam` and behave oddly or refuse to run without them.
 *
 * Validated by executing a real confined process inside the actual shipped
 * image (`mindportalix-dsh:local`, built via `docker compose -f
 * docker-compose.yml -f docker-compose.dsh.yml build deepseek-harness`),
 * under Landlock (the backend that actually engages in this deployment —
 * Docker's default security profile blocks bwrap's unprivileged
 * user-namespace creation) with full enforcement: bash builtins, spawning
 * `node`, reading `/etc/resolv.conf`/`/etc/passwd`/`/etc/ssl/certs`, and a
 * real DNS lookup all succeeded under confinement, and a cross-tenant read
 * of another tenant's root was denied with a kernel-level `Permission
 * denied` (see this package's README "Known Limitations and Deferred Work"
 * for the exact commands and output, and for what the exercised tool
 * surface did NOT cover).
 */
const OPTIONAL_SYSTEM_READ_ONLY_PATHS: readonly string[] = [
  '/lib64',
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/ssl',
  '/etc/passwd',
  '/etc/nsswitch.conf',
]

/**
 * Build the bwrap profile arguments for one file-effect policy, scoped to one
 * tenant.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @param tenantRoot - the calling tenant's `$DSH_HOME/tenants/<tenantId>` root; the
 * only non-system directory this profile ever grants read access to.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy, tenantRoot: string): string[] {
  const args: string[] = []
  for (const path of REQUIRED_SYSTEM_READ_ONLY_PATHS) args.push('--ro-bind', path, path)
  for (const path of OPTIONAL_SYSTEM_READ_ONLY_PATHS) args.push('--ro-bind-try', path, path)
  args.push('--ro-bind', tenantRoot, tenantRoot)
  args.push('--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent')
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy, scoped to
 * one tenant.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @param tenantRoot - the calling tenant's `$DSH_HOME/tenants/<tenantId>` root; the
 * only non-system directory this profile ever grants read access to.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy, tenantRoot: string): string[] {
  const readOnly = [
    ...REQUIRED_SYSTEM_READ_ONLY_PATHS,
    ...OPTIONAL_SYSTEM_READ_ONLY_PATHS.filter(path => existsSync(path)),
    tenantRoot,
  ]
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly, readWrite })
}
