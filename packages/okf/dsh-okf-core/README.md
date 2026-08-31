# @mindportalix/dsh-okf-core

Framework-free Open Knowledge Format (OKF) v0.2 primitives, shared by the OKF plugin bundle (`@mindportalix/dsh-okf-bundle`, `@mindportalix/dsh-tool-okf`, `@mindportalix/dsh-okf-context`). It has no Cordis, filesystem, or network surface — every export is a pure function of its arguments.

The specification is `projects/knowledge-catalog/okf/SPEC.md` (OKF v0.2, vendored alongside this repo). Behaviour is pinned against the OKF reference implementation's own tests (`projects/knowledge-catalog/okf/tests/`).

## Documents

- `parseConcept(text)` splits a concept file into `{ frontmatter, body }`. A file with no leading `---` is all body with empty frontmatter (SPEC §8 index files). An unterminated frontmatter block, or frontmatter that is not a mapping, throws `OKFDocumentError` — a structural defect, not a missing optional field.
- `serializeConcept({ frontmatter, body })` writes `---\n<yaml>\n---\n\n<body>\n`, preserving key order and normalising the body to one trailing newline. Empty frontmatter emits body only.
- `conformanceIssue(frontmatter)` returns a reason string when `type` is missing or non-string (OKF's one hard requirement, SPEC §11), otherwise `null`. It does not throw, so a consumer can still list a non-conformant file.

ISO 8601 datetimes round-trip as the strings the author wrote: the `yaml` package parses `!!timestamp` only on opt-in, matching the OKF reference loader.

## Trust and lifecycle

- `normalizeVerified(frontmatter)` returns `verified` as an array, treating a lone `{ by, at }` mapping as a one-element list (SPEC §5.2).
- `trustTier(frontmatter)` → `unverified` | `machine-confirmed` | `human-reviewed`, keyed off the `human:` actor prefix (SPEC §5.3).
- `lastVerifiedAt(frontmatter)` → the latest `verified[].at`, or `null`.
- `isStale(frontmatter, now?)` → `now >= stale_after`, and only when `stale_after` carries an explicit UTC offset (SPEC §5.5).
- `lifecycleStatus(frontmatter)` → `status`, defaulting to `stable` (SPEC §5.4).
- `isAttestedComputation(frontmatter)` → whether an Attested Computation contract is present (SPEC §10.2).

## Actors, footnotes, index/log

- `isHumanActor` / `isProcessActor` / `actorKind` / `formatAgentActor` implement the `<producer>/<version>` · `human:<id>` · `process:<id>` convention (SPEC §7).
- `parseFootnoteAttributions(body)` maps each `[^label]: text` definition to its text; `referencedFootnoteLabels(body)` lists the labels used inline. The label is the join key into `sources[].id` (SPEC §5.1).
- `regenerateIndex(entries)` builds one directory's `index.md` — an `# <Type>` section per concept type, `Subdirectories` last, entries sorted by title (SPEC §8).
- `appendLogEntry(existingLog, entry)` inserts a `* **Kind**: text` line under the right `## YYYY-MM-DD` heading, newest date first (SPEC §9).

## Model Experience

This package has no model, token, or KV-cache effect on its own. It is the library the OKF plugins call; those plugins own the system-prompt, tool, and session-log surface.

## Known Limitations and Deferred Work

- **No schema validation beyond `type`.** SPEC §11 forbids rejecting a document for any other missing or unknown field, so the optional families (`sources`, `generated`, computation contract, …) are read leniently and passed through untouched; this package derives verdicts from them but never vets their shape.
- **Deep lineage is out of scope** for OKF v0.2 (SPEC §5.1): `sources` credibility signals are surfaced as written, not recursed.
- **Attested-computation execution lives elsewhere** — this package reads the contract fields; running an executor/attester is `@mindportalix/dsh-okf-attest` (not yet built).
