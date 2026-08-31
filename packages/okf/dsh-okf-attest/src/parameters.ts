/**
 * Bind an agent-supplied set of values to an Attested Computation's declared
 * `parameters` (SPEC §10.2), and expand them into the computation template the
 * way the executor does, so the attester can re-derive exactly what should have
 * run (SPEC §10.3).
 *
 * The agent supplies *values* only; it never authors or edits the computation.
 *
 * @module @mindportalix/dsh-okf-attest/parameters
 */

/** One declared parameter of an Attested Computation. */
export interface ParameterSpec {
  /** Parameter name. */
  name: string
  /** Declared type — interpreted per `runtime` (`integer`, `string`, `date`, `float`, `boolean`). */
  type: string
  /** Whether the agent must supply it. */
  required?: boolean
}

/** The outcome of binding supplied values to declared parameters. */
export interface BindResult {
  /** The accepted `{ name: value }` map (only declared names, coerced by type). */
  bound: Record<string, unknown>
  /** Required parameters with no supplied value. */
  missing: string[]
  /** Supplied names that are not declared. */
  unexpected: string[]
  /** `name: reason` for a supplied value that does not match its declared type. */
  typeErrors: Record<string, string>
}

/** Whether a bind result is clean enough to proceed. */
export function bindOk(result: BindResult): boolean {
  return result.missing.length === 0 && result.unexpected.length === 0 && Object.keys(result.typeErrors).length === 0
}

function checkType(type: string, value: unknown): string | null {
  switch (type) {
    case 'integer':
      return Number.isInteger(value) ? null : 'expected an integer'
    case 'float':
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'expected a number'
    case 'boolean':
      return typeof value === 'boolean' ? null : 'expected a boolean'
    case 'string':
      return typeof value === 'string' ? null : 'expected a string'
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : 'expected a YYYY-MM-DD date string'
    default:
      // An unknown declared type is accepted as-is; the runtime owns its meaning.
      return null
  }
}

/**
 * Validate and coerce `values` against `declared`.
 *
 * @param declared - the concept's `parameters` list.
 * @param values - the agent-supplied `{ name: value }` map.
 * @returns the {@link BindResult}.
 */
export function bindParameters(declared: readonly ParameterSpec[], values: Record<string, unknown>): BindResult {
  const byName = new Map(declared.map(spec => [spec.name, spec]))
  const bound: Record<string, unknown> = {}
  const missing: string[] = []
  const typeErrors: Record<string, string> = {}

  for (const spec of declared) {
    if (!(spec.name in values) || values[spec.name] === undefined) {
      if (spec.required) missing.push(spec.name)
      continue
    }
    const value = values[spec.name]
    const error = checkType(spec.type, value)
    if (error !== null) {
      typeErrors[spec.name] = error
      continue
    }
    bound[spec.name] = value
  }

  const unexpected = Object.keys(values).filter(name => !byName.has(name))
  return { bound, missing, unexpected, typeErrors }
}

/** SQL literal for a bound value (BigQuery-flavoured: quoted strings/dates, bare numbers/bools). */
function sqlLiteral(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `'${String(value).replace(/'/g, "\\'")}'`
}

/**
 * Expand `bound` values into a computation template for the given runtime, the
 * same substitution the executor performs (SPEC §10.3). Supported forms:
 *
 * - `bigquery` / `postgres`: `@name` → SQL literal.
 * - `dbt`: `{{ var('name') }}` (and `{{var("name")}}`) → SQL literal.
 * - `python`: `{name}` → repr-ish literal.
 * - anything else: `{{name}}` → `String(value)`.
 *
 * @param runtime - the concept's `runtime`.
 * @param template - the raw computation body.
 * @param bound - accepted parameter values.
 * @returns the expanded artifact.
 */
export function expandComputation(runtime: string, template: string, bound: Record<string, unknown>): string {
  let out = template
  for (const [name, value] of Object.entries(bound)) {
    if (runtime === 'bigquery' || runtime === 'postgres') {
      out = out.replaceAll(`@${name}`, sqlLiteral(value))
    } else if (runtime === 'dbt') {
      out = out.replace(
        new RegExp(`\\{\\{\\s*var\\(\\s*['"]${escapeRe(name)}['"]\\s*\\)\\s*\\}\\}`, 'g'),
        sqlLiteral(value),
      )
    } else if (runtime === 'python') {
      out = out.replaceAll(`{${name}}`, typeof value === 'string' ? JSON.stringify(value) : String(value))
    } else {
      out = out.replaceAll(`{{${name}}}`, String(value))
    }
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
