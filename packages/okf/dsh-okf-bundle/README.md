# @mindportalix/dsh-okf-bundle

`ctx.okf` — the per-tenant Open Knowledge Format bundle service. The bundle is a
directory of markdown files with YAML frontmatter (OKF v0.2,
`projects/knowledge-catalog/okf/SPEC.md`).

## Root resolution

`resolveRoot()` is evaluated per call:

1. a bound `ctx.tenantContext` (the deployed MindPortalix container) →
   `$DSH_HOME/tenants/<tenantId>/<subdir>` (`subdir` defaults to `knowledge`);
2. else the configured `root` (local `dsh` dev and tests);
3. else `$DSH_HOME/<subdir>`.

This is host-plane state outside any session workspace, so the service uses
`node:fs` directly — like the tenant-isolation packages — not the
sandbox-fenced `ctx.fs`.

## Operations

- `exists()` / `list()` — `list()` returns a flat, path-sorted array of concept
  summaries (type, title, tags, trust tier, staleness, attested?, and a SPEC §11
  `issue` for a file that will not parse or lacks `type`) plus a directory row
  per subdirectory.
- `readConcept(id)` — raw text, parsed `{ frontmatter, body }`, and the derived
  `trustTier` / `stale`. `id` is the file path without `.md`; a traversal id or
  an oversize file throws `OkfPathError`.
- `search(filter)` — `{ type, tags, text, trustTier, stale }`; every provided
  clause must match. `text` is a case-insensitive substring over id, title,
  description, and body.
- `writeConcept(id, { frontmatter, body, actor, allowShrink? })` — stamps
  `generated: { by: actor, at: <now> }` when the caller did not set it, runs a
  no-shrink guard (refuses a body that drops backtick-quoted identifiers or a
  `sources` list that shrinks — `allowShrink` overrides), writes the file, then
  regenerates every affected `index.md` and appends a `log.md` entry. Refuses a
  concept without a `type` (`OkfShrinkError`).
- `appendVerification(id, by, at?)` — adds a `verified: { by, at }` event
  (SPEC §5.2); `by` should be `human:<id>` only for a real human confirmation.
- `regenerateIndexes()` — rewrites `index.md` in every directory that contains
  concepts, grouped by type with `Subdirectories` last (SPEC §8).

## Model Experience

This package registers no tool or prompt section. `@mindportalix/dsh-tool-okf`
and `@mindportalix/dsh-okf-context` are the model-facing consumers.

## Known Limitations and Deferred Work

- **Concurrent writers.** Two sessions of the same tenant writing the same
  concept race on the file; the outcome is last-write-wins. A lock or an
  event-sourced write log is deferred.
- **The no-shrink guard is heuristic** — it counts backtick-quoted identifiers
  as a proxy for "schema rows", matching the OKF reference agent's guard. It is
  advisory, not a schema check.
- **No attestation.** Running an Attested Computation's executor/attester is
  `@mindportalix/dsh-okf-attest`.
