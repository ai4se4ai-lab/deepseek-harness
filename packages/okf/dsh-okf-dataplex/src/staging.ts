/**
 * Lossless translation between clean OKF frontmatter and the Knowledge Catalog
 * (Dataplex) "pushable" form, where the OKF v0.2 signal layer rides a custom
 * `okf` aspect carried through the generic Documents Layout's `catalogEntry`
 * passthrough.
 *
 * Ported from
 * `projects/knowledge-catalog/toolbox/mdcode/demo/okf/okf.ts`
 * (`toStaging` / `fromStaging`), including the `extra` divert sink that keeps
 * producer-defined keys at any depth round-tripping (SPEC §4.1, §11).
 *
 * @module @mindportalix/dsh-okf-dataplex/staging
 */

import { parseConcept, serializeConcept } from '@mindportalix/dsh-okf-core'

/** Keys the Documents Layout maps natively; they stay at the staged top level. */
const LAYOUT_KEYS = ['title', 'description', 'tags']

/** The OKF v0.2 signal keys carried on the `okf` aspect, in SPEC order. */
const SIGNAL_KEYS = [
  'generated', 'verified', 'status', 'stale_after', 'usage_window',
  'runtime', 'parameters', 'computation', 'executor', 'attester', 'sources',
]

/** `type` and `resource` are carried outside the signal record. */
const MODELED_KEYS = new Set([...LAYOUT_KEYS, ...SIGNAL_KEYS, 'type', 'resource'])

/** Field order within each signal record, and which signal keys hold a list of them. */
const RECORD_KEYS: Record<string, string[]> = {
  generated: ['by', 'at'],
  verified: ['by', 'at'],
  usage_window: ['from', 'to'],
  parameters: ['name', 'type', 'required'],
  executor: ['resource', 'receipt'],
  attester: ['resource'],
  sources: ['id', 'resource', 'title', 'author', 'usage_count', 'last_modified'],
}
const LIST_KEYS = new Set(['verified', 'parameters', 'sources'])

/** Where an unmodeled key sits: record fields are strings, list positions numbers. */
type Path = (string | number)[]
type Extra = [Path, unknown]

type Dict = Record<string, unknown>

function isDict(value: unknown): value is Dict {
  /* v8 ignore next -- each falsy branch is covered by malformed-input tests; v8's per-operand accounting misses that across call sites. */
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Keep only present keys, in a stable order. */
function pick(obj: unknown, keys: string[]): Dict {
  const out: Dict = {}
  /* v8 ignore next -- pick only ever receives a dict, so this guard is defensive; presence checks are covered by round-trip tests. */
  if (!isDict(obj)) return out
  for (const key of keys) {
    const value = obj[key]
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

function setAtPath(root: Dict, path: Path, value: unknown): void {
  let node: Dict | unknown[] = root
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i] as string | number
    const container = node as Record<string | number, unknown>
    /* v8 ignore next 3 -- the parent is rebuilt before the extra restore, so this container exists; defense for a hand-mangled aspect. */
    if (container[segment] === undefined) {
      container[segment] = typeof path[i + 1] === 'number' ? [] : {}
    }
    node = container[segment] as Dict | unknown[]
  }
  ;(node as Record<string | number, unknown>)[path[path.length - 1] as string | number] = value
}

/**
 * Translate clean OKF file text into the Knowledge Catalog staging form.
 *
 * @param content - the clean OKF concept file.
 * @param okfKey - the Dataplex `okf` aspect type key, e.g. `proj.loc.okf`.
 * @param entryTypeKey - the `okf-bundle` entry type key, e.g. `proj.loc.okf-bundle`.
 * @returns the staged file text.
 */
export function toStaging(content: string, okfKey: string, entryTypeKey: string): string {
  const { frontmatter: meta, body } = parseConcept(content)
  if (Object.keys(meta).length === 0) {
    // SPEC §8 index files carry no frontmatter — stage the entry type alone.
    return serializeConcept({ frontmatter: { type: entryTypeKey }, body })
  }

  const extras: Extra[] = []
  const divert = (value: Dict, fields: string[], path: Path): Dict => {
    const kept: Dict = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || item === null) continue
      if (fields.includes(key)) kept[key] = item
      else extras.push([[...path, key], item])
    }
    return pick(kept, fields)
  }

  const signal: Dict = {}
  if (meta['type'] !== undefined) signal['okf_type'] = meta['type']
  for (const [key, value] of Object.entries(pick(meta, SIGNAL_KEYS))) {
    const fields = RECORD_KEYS[key]
    if (!fields) {
      signal[key] = value
    } else if (LIST_KEYS.has(key)) {
      const list = Array.isArray(value) ? value : [value]
      signal[key] = list.map((item, i) => (isDict(item) ? divert(item, fields, [key, i]) : item))
    } else {
      signal[key] = isDict(value) ? divert(value, fields, [key]) : value
    }
  }

  for (const key of Object.keys(meta)) {
    if (!MODELED_KEYS.has(key)) extras.push([[key], meta[key]])
  }
  if (extras.length > 0) signal['extra'] = JSON.stringify(extras)

  const staged: Dict = { type: entryTypeKey, ...pick(meta, LAYOUT_KEYS) }
  staged['catalogEntry'] = {
    resource: { name: meta['resource'] },
    aspects: { [okfKey]: signal },
  }
  return serializeConcept({ frontmatter: staged, body })
}

/**
 * Translate Knowledge Catalog staging form back into clean OKF file text.
 *
 * @param content - the staged concept file (as `kcmd pull` produced it).
 * @param okfKey - the Dataplex `okf` aspect type key.
 * @returns the clean OKF concept file.
 */
export function fromStaging(content: string, okfKey: string): string {
  const { frontmatter: meta, body } = parseConcept(content)
  if (Object.keys(meta).length === 0) return content

  const ce = isDict(meta['catalogEntry']) ? (meta['catalogEntry'] as Dict) : {}
  const aspects = isDict(ce['aspects']) ? (ce['aspects'] as Dict) : {}
  const okf = isDict(aspects[okfKey]) ? (aspects[okfKey] as Dict) : {}
  const resourceName = isDict(ce['resource']) ? (ce['resource'] as Dict)['name'] : undefined

  if (Object.keys(okf).length === 0 && resourceName === undefined) {
    return `${body.trim()}\n`
  }

  const clean: Dict = {}
  if (okf['okf_type'] !== undefined) clean['type'] = okf['okf_type']
  if (resourceName !== undefined) clean['resource'] = resourceName
  Object.assign(clean, pick(meta, LAYOUT_KEYS))
  for (const [key, value] of Object.entries(pick(okf, SIGNAL_KEYS))) {
    const fields = RECORD_KEYS[key]
    if (!fields) {
      clean[key] = value
    } else if (LIST_KEYS.has(key)) {
      clean[key] = (value as unknown[]).map(item => (isDict(item) ? pick(item, fields) : item))
    } else {
      clean[key] = isDict(value) ? pick(value, fields) : value
    }
  }
  if (typeof okf['extra'] === 'string') {
    for (const [path, value] of JSON.parse(okf['extra']) as Extra[]) {
      setAtPath(clean, path, value)
    }
  }
  return serializeConcept({ frontmatter: clean, body })
}
