/**
 * TenantSandboxLocalProvider tests: the fail-closed tenant-resolution diff
 * against upstream `LocalSandboxProvider`. `runnerCommand` injects a
 * deterministic runner argv (no real bwrap/Landlock assumed present), mirroring
 * upstream `dsh-sandbox-local`'s own test setup.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { TenantContextService, TenantRequiredError } from '@mindportalix/dsh-tenant-context'
import { TenantSandboxLocalProvider } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const TENANT_A = 'a'.repeat(32)
const TENANT_B = 'b'.repeat(32)

async function setup(config: Config = {}): Promise<{ ctx: Context; sandbox: TenantSandboxLocalProvider }> {
  const ctx = new Context()
  await ctx.plugin(TenantContextService)
  await ctx.plugin(TenantSandboxLocalProvider, {
    runnerCommand: ['fake-runner'],
    runnerFailureSignatures: ['fake-runner: refused'],
    ...config,
  })
  const sandbox = ctx.sandbox as TenantSandboxLocalProvider
  return { ctx, sandbox }
}

describe('confine() tenant resolution', () => {
  it('throws (fails closed) when no tenant identity is bound — never falls back to an unconfined profile', async () => {
    const { sandbox } = await setup()
    const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws' }
    expect(() => sandbox.confine(['true'], policy)).toThrow(TenantRequiredError)
  })

  it('produces argv scoped to the bound tenant\'s own root, using runnerCommand', async () => {
    const { ctx, sandbox } = await setup()
    const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws' }
    const confined = ctx.tenantContext.run(TENANT_A, () => sandbox.confine(['true'], policy))
    expect(confined.argv[0]).toBe('fake-runner')
    expect(confined.argv.some(arg => arg.includes(TENANT_A))).toBe(true)
  })

  it('two tenants confining concurrently never see each other\'s tenant root in their own argv', async () => {
    const { ctx, sandbox } = await setup()
    const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws' }
    const confinedA = ctx.tenantContext.run(TENANT_A, () => sandbox.confine(['true'], policy))
    const confinedB = ctx.tenantContext.run(TENANT_B, () => sandbox.confine(['true'], policy))
    const joinedA = confinedA.argv.join(' ')
    const joinedB = confinedB.argv.join(' ')
    expect(joinedA).toContain(TENANT_A)
    expect(joinedA).not.toContain(TENANT_B)
    expect(joinedB).toContain(TENANT_B)
    expect(joinedB).not.toContain(TENANT_A)
  })

  it('refuses a workspace-write policy whose workspaceRoot escapes the resolved tenant root', async () => {
    const { ctx, sandbox } = await setup()
    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/some/other/place' }
    expect(() => ctx.tenantContext.run(TENANT_A, () => sandbox.confine(['true'], policy))).toThrow(/outside tenant root/)
  })

  it('accepts a workspace-write policy whose workspaceRoot is under the resolved tenant root', async () => {
    const { ctx, sandbox } = await setup()
    // Resolve the real tenant root the provider computes and nest the workspace under it.
    const probe = ctx.tenantContext.run(TENANT_A, () => sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: '/ws' }))
    const tenantRootArg = probe.argv.find(arg => arg.includes(TENANT_A))
    expect(tenantRootArg).toBeDefined()
    const nestedPolicy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: `${tenantRootArg}/project` }
    expect(() => ctx.tenantContext.run(TENANT_A, () => sandbox.confine(['true'], nestedPolicy))).not.toThrow()
  })
})
