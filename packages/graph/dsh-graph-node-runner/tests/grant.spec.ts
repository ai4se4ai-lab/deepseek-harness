/**
 * Tool-grant tests. The grant is what turns a diagram's `tools:` line into what
 * a node may actually call, so the two failure modes that matter are granting
 * more than the diagram asked for and failing a node over a tool this
 * deployment does not carry.
 */

import { describe, expect, it } from 'vitest'
import { BASELINE_TOOLS, resolveToolGrant } from '../src/grant.ts'

const registered = new Set([
  'read',
  'glob',
  'grep',
  'write',
  'edit',
  'bash',
  'web_search',
  'web_fetch',
  'okf_bundle_overview',
  'okf_search_concepts',
  'okf_read_concept',
  'okf_write_concept',
  'run_code',
])

describe('resolveToolGrant', () => {
  it('grants the read-only baseline to a node that declared no tools', () => {
    const grant = resolveToolGrant([], registered)
    expect(grant.allow).toEqual([...BASELINE_TOOLS])
    expect(grant.dropped).toEqual([])
  })

  it('never grants write or shell without an explicit request', () => {
    const grant = resolveToolGrant([], registered)
    expect(grant.allow).not.toContain('write')
    expect(grant.allow).not.toContain('bash')
    expect(grant.allow).not.toContain('edit')
  })

  it('adds a requested tool on top of the baseline', () => {
    const grant = resolveToolGrant(['bash'], registered)
    expect(grant.allow).toContain('bash')
    expect(grant.allow).toEqual(expect.arrayContaining([...BASELINE_TOOLS]))
  })

  it('grants a whole file-update family in one request', () => {
    const grant = resolveToolGrant(['read', 'write', 'edit', 'glob', 'grep'], registered)
    expect(grant.allow).toEqual(expect.arrayContaining(['write', 'edit']))
    expect(grant.dropped).toEqual([])
  })

  it('grants OKF write tools only when asked', () => {
    expect(resolveToolGrant([], registered).allow).not.toContain('okf_write_concept')
    expect(resolveToolGrant(['okf_write_concept'], registered).allow).toContain('okf_write_concept')
  })

  it('drops a requested tool this composition does not register', () => {
    const grant = resolveToolGrant(['bash', 'kubernetes_apply'], registered)
    expect(grant.allow).toContain('bash')
    expect(grant.allow).not.toContain('kubernetes_apply')
    expect(grant.dropped).toEqual(['kubernetes_apply'])
  })

  it('reports every unmatched request, not just the first', () => {
    expect(resolveToolGrant(['nope_one', 'nope_two'], registered).dropped).toEqual(['nope_one', 'nope_two'])
  })

  it('refuses the reserved run_code transport by name', () => {
    const grant = resolveToolGrant(['run_code'], registered)
    expect(grant.allow).not.toContain('run_code')
    expect(grant.dropped).toEqual(['run_code'])
  })

  it('de-duplicates a request that repeats a baseline tool', () => {
    const grant = resolveToolGrant(['read', 'read', 'bash'], registered)
    expect(grant.allow.filter(name => name === 'read')).toHaveLength(1)
  })

  it('stays silent about a baseline tool this composition lacks', () => {
    const grant = resolveToolGrant([], new Set(['read']))
    expect(grant.allow).toEqual(['read'])
    expect(grant.dropped).toEqual([])
  })

  it('reports a baseline name the composition lacks when the node asked for it explicitly', () => {
    const grant = resolveToolGrant(['grep'], new Set(['read']))
    expect(grant.dropped).toEqual(['grep'])
  })

  it('produces an empty allow list when nothing is registered', () => {
    expect(resolveToolGrant(['bash'], new Set()).allow).toEqual([])
  })
})
