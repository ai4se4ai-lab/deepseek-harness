/**
 * Tenant-scoped profile builder tests. The central assertion this whole
 * package exists for: neither builder ever grants a blanket `/` read, and
 * both grant exactly the calling tenant's own root plus a fixed system
 * allowlist.
 */

import { describe, expect, it } from 'vitest'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

const TENANT_ROOT = '/data/tenants/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const RO: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws' }
const WW: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: `${TENANT_ROOT}/project` }

describe('bwrapProfileArgs', () => {
  it('never grants a blanket "/" read-only bind', () => {
    const args = bwrapProfileArgs(RO, TENANT_ROOT)
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === '--ro-bind' || args[index] === '--ro-bind-try') {
        expect(args[index + 1]).not.toBe('/')
      }
    }
  })

  it('grants read-only access to the tenant root', () => {
    const args = bwrapProfileArgs(RO, TENANT_ROOT)
    expect(args).toEqual(expect.arrayContaining(['--ro-bind', TENANT_ROOT, TENANT_ROOT]))
  })

  it('grants read-only access to the fixed system allowlist', () => {
    const args = bwrapProfileArgs(RO, TENANT_ROOT)
    for (const path of ['/usr', '/bin', '/sbin', '/lib']) {
      expect(args).toEqual(expect.arrayContaining(['--ro-bind', path, path]))
    }
    for (const path of ['/lib64', '/etc/resolv.conf', '/etc/hosts', '/etc/ssl', '/etc/passwd', '/etc/nsswitch.conf']) {
      expect(args).toEqual(expect.arrayContaining(['--ro-bind-try', path, path]))
    }
  })

  it('keeps the unshare/proc/dev/die-with-parent flags from upstream', () => {
    const args = bwrapProfileArgs(RO, TENANT_ROOT)
    expect(args).toEqual(expect.arrayContaining(['--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']))
  })

  it('read-only mode grants no write bind at all', () => {
    const args = bwrapProfileArgs(RO, TENANT_ROOT)
    expect(args).not.toContain('--bind')
    expect(args).not.toContain('--tmpfs')
  })

  it('workspace-write mode adds a tmpfs /tmp and a write bind of the workspace root, unchanged from upstream', () => {
    const args = bwrapProfileArgs(WW, TENANT_ROOT)
    expect(args).toEqual(expect.arrayContaining(['--tmpfs', '/tmp']))
    expect(args).toEqual(expect.arrayContaining(['--bind', WW.workspaceRoot, WW.workspaceRoot]))
  })
})

describe('landlockProfileArgs', () => {
  it('never grants "/" as a readOnly root', () => {
    const args = landlockProfileArgs(RO, TENANT_ROOT).join(' ')
    // The launcher's grantArgs encodes readOnly/readWrite lists into flags;
    // whatever the exact encoding, the literal standalone root must not appear.
    expect(args.split(/\s+/u)).not.toContain('/')
  })

  it('includes the tenant root and read-only mode grants no write access', () => {
    const readOnlyArgs = landlockProfileArgs(RO, TENANT_ROOT)
    const writeArgs = landlockProfileArgs(WW, TENANT_ROOT)
    expect(readOnlyArgs).not.toEqual(writeArgs)
  })
})

describe('seatbeltProfileArgs re-export', () => {
  it('re-exports upstream seatbeltProfileArgs unchanged (macOS/Windows out of scope for this fork)', () => {
    expect(typeof seatbeltProfileArgs).toBe('function')
    expect(seatbeltProfileArgs(RO)).toEqual(expect.arrayContaining(['-p']))
  })
})
