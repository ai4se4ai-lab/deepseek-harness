# @mindportalix/dsh-okf-dataplex

`ctx.okfDataplex` — sync a tenant's OKF bundle with a Google Cloud Knowledge
Catalog (Dataplex) EntryGroup.

## Translation (complete, tested)

`toStaging(cleanText, okfAspectKey, entryTypeKey)` / `fromStaging(stagedText,
okfAspectKey)` move the OKF v0.2 signal layer onto a custom `okf` Dataplex
aspect carried through the generic Documents Layout's `catalogEntry`
passthrough, and back. Ported verbatim from
`toolbox/mdcode/demo/okf/okf.ts`, including:

- `type` → `okf_type` on the aspect, `resource` → the entry's `resource.name`;
- `LAYOUT_KEYS` (`title`/`description`/`tags`) stay at the top level;
- every other SPEC signal key rides the aspect, list-shaped where SPEC allows a
  bare mapping (`verified`, `parameters`, `sources`);
- **any producer-defined key at any depth** is diverted to a single `extra`
  field as a JSON list of `[path, value]` pairs and restored on the way back —
  so the round-trip is lossless for any conformant bundle (SPEC §4.1, §11);
- a frontmatter-free `index.md` stages as just the entry type and unstages to
  body only.

`stageBundle()` applies `toStaging` to every concept in `ctx.okf`; `unstage()`
is `fromStaging` for one file.

## Sync (seam only)

`push(stagingDir)` / `pull(stagingDir)` delegate to an injectable `KcmdRunner`.
The default runner is **unavailable** — `kcmd` and authenticated `gcloud` are
not in this image — and rejects with that message. A companion plugin (or a
deployment that bundles `kcmd`) calls `setRunner(...)` to enable real sync.

`entryGroup()` resolves `entryGroupTemplate` (`{tenant}` → the caller's tenant
id, or `local`) and validates it against Dataplex's naming rule.

## Config

| key | default | meaning |
|-----|---------|---------|
| `project` | `''` | GCP project id (part of the aspect/entry-type keys). |
| `location` | `us-central1` | GCP location. |
| `entryGroupTemplate` | `okf_{tenant}` | Per-tenant EntryGroup name. |

## Model Experience

None — no tool, no prompt section. This is an operator/sync surface.

## Known Limitations and Deferred Work

- **No `kcmd` runner ships here.** `push` / `pull` are inert until a runner is
  injected; bundling `kcmd` + per-tenant GCP credentials into the container is
  deferred (it needs Bun and an auth story).
- **Non-`.md` attachments and in-body concept links do not round-trip** — only
  markdown files sync, and only directory-derived parent links are native
  Knowledge Catalog edges (same as the upstream demo).
- **Pull re-emits canonical frontmatter** (key order, block style), so a diff
  against a hand-authored flow-mapping bundle shows presentation churn with no
  data loss.
