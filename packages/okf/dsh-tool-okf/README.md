# @mindportalix/dsh-tool-okf

Model-facing tools for maintaining a tenant's Open Knowledge Format bundle. Each
is a thin adapter over `ctx.okf` (`@mindportalix/dsh-okf-bundle`).

| Tool | Purpose |
|------|---------|
| `okf_bundle_overview` | List every concept — id, type, trust tier, staleness, attested? A cheap first read. |
| `okf_search_concepts` | Filter by `type` / `tags` / `text` / `trust_tier` / `stale`; every clause must match. |
| `okf_read_concept` | One concept's body + frontmatter + derived trust tier and staleness, with a stale warning (SPEC §5.5, §10.5). |
| `okf_write_concept` | Create / update. `frontmatter` is a JSON object; `type` is required. `generated` is stamped; the no-shrink guard runs; `index.md` / `log.md` are regenerated. |
| `okf_verify_concept` | Append a `verified: { by, at }` event (SPEC §5.2). `human:<id>` only for a real human sign-off. |

`okf_attest` (SPEC §10) is registered separately by
`@mindportalix/dsh-okf-attest` when that engine is deployed.

## Config

`producer` (default `dsh`) and `version` (default `unversioned`) compose the
machine actor string `<producer>/<version>` stamped as `generated.by` /
`verified[].by` for machine writes (SPEC §7). Set `version` from the
deployment's build id.

## Model Experience

Five tool schemas enter the catalogue. The tools read and write the tenant's
`knowledge/` bundle; the prompt guidance that tells the model *when* to use
them is `@mindportalix/dsh-okf-context`.

## Known Limitations and Deferred Work

- **No session event.** A write is reconstructable from the tool call/result
  in the session log, but there is no dedicated `okf/*` `SessionEventMap` member
  or projection yet.
- **`frontmatter` is an opaque JSON object** in the tool schema — validation
  beyond "is an object" and "has a `type`" is left to `ctx.okf`, per OKF's
  permissive conformance rule (SPEC §11).
