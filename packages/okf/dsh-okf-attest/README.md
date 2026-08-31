# @mindportalix/dsh-okf-attest

`ctx.okfAttest` and the `okf_attest` tool — the consumer side of an Attested Computation (OKF SPEC §10). Deterministic: no LLM, no network.

The agent runs the computation itself by following the concept's `executor` skill (its shell is the executor), then calls `okf_attest` with the run receipt. The engine verifies:

1. **Provenance** — `canonicalizeSql(receipt.executed_sql)` equals the `# Computation` body bound with the declared parameters (`expandComputation`), after stripping comments, collapsing whitespace, and upper-casing keywords. Ported from `okf/bundles/acme_retail/attesters/sql_equality.py`.
2. **Fidelity** — `claimed_value` equals the first cell of `receipt.result`.

A failing verdict means the value **must not** be reported.

## API

- `ctx.okfAttest.attestReceipt(id, parameters, receipt, claimedValue)` → `{ ok, reason, stale, details }`. `stale` reflects the concept's `stale_after` (SPEC §10.5 step 6) — a stale *definition* can still attest cleanly, but the agent should note it.
- `attestConcept(id)` — placeholder; returns guidance because this build has no executor runner.
- Pure exports: `canonicalizeSql`, `attestSqlReceipt`, `bindParameters`, `expandComputation`, `extractComputationBody`.

Only `runtime: bigquery` and `runtime: postgres` have a built-in attester; any other runtime returns a non-ok verdict naming the gap.

## Model Experience

One tool schema (`okf_attest`). No prompt section — the guidance to attest before reporting a computed value lives in `@mindportalix/dsh-okf-context`'s `OKF_GUIDANCE`.

## Known Limitations and Deferred Work

- **No executor runner.** `attestConcept` does not run the computation; the agent does, via bash. A sandboxed executor seam (BigQuery / dbt runners with per-tenant credentials) is deferred.
- **`computation:` file reference is not followed** — only the inline `# Computation` fence is read. A concept that points `computation:` at a file cannot be attested here yet.
- **`.py` / semantic-layer attesters are not executed** — the built-in SQL-equality check substitutes for `runtime: bigquery` / `postgres`; `attester.resource` is informational.
