# Agent Note: Referenced-document inlining and PDF reads

Status: implemented

English | [中文](2026-09-01-referenced-document-inlining-and-pdf-read.zh.md)

## Problem

A person drops a document into a DSH chat and asks about it. Two things then fail.

First, a `@path` reference is only a path. [`@deepseek-ai/dsh-file-reference`](../../../packages/context/file-reference)'s guidance asks the model to `read` the file when it needs the contents, but that is one soft sentence; a smaller or less tool-eager model skips it and answers about a document it never opened. The `/upload` command lands the file under `files/` and splices the same `@files/…` mention, so it inherits the same gap.

Second, a PDF cannot be read at all. `read` decodes through `ctx.fs.readText`, which is `TextDecoder('utf-8', { fatal: true })`; a PDF throws `FS_NOT_TEXT` and the agent never sees a word. There was no document-extraction path anywhere in the harness, so "summarise this", "turn this into OKF concepts", and every follow-up were dead on a `.pdf`.

## Decision

Two changes, both on existing extension points — no `agent-loop` edit.

**`read` extracts a PDF text layer.** `@deepseek-ai/dsh-tool-fs` gains `extract-document.ts` (`extractDocumentText`, `looksLikePdf`) over `unpdf` — a bundled, dependency-free pdf.js build. When `ctx.fs.readText`/`streamText` rejects with `FS_NOT_TEXT`, `read` reads the raw bytes once (capped by the new `readExtractMaxBytes`) and, **only if the bytes are a PDF**, windows the extracted layer through the existing `buildWindow`/`formatReadOutput` envelope — so a `.pdf` reads exactly like a `.md`, line numbers and pagination footer included. A non-PDF binary keeps the backend's own `FS_NOT_TEXT` message unchanged. A PDF with no recoverable text (scanned, encrypted, corrupt) re-throws `FS_NOT_TEXT` carrying which. A layer longer than `readExtractMaxChars` ends with one explicit truncation line.

**Referenced files are inlined into the runtime context.** `@deepseek-ai/dsh-file-reference-local` installs one per-agent `system-prompt/assemble` contributor (`ReferencedFileInliner`). It re-scans every user turn for `@path` / `@"path"` tokens (newest first, deduplicated, capped at `maxInlinedFiles`), resolves each under the session cwd, and folds the current text — a PDF as its extracted layer — into the runtime-context snapshot as a `context:referenced-files` section. Each file's extraction is cached against its `FsVersion`, so steps within a turn re-stat but do not re-read. A file over `maxInlinedBytesPerFile`, outside the workspace, or with no readable text is listed by name with the reason and the model is pointed at `read`. The guidance sentence is reworded to say the contents may already be present.

Because the snapshot runs every context through `{{name}}` interpolation — which throws on an unknown or malformed group — inlined text has each `{{` and `}}` split with a zero-width space. A referenced Handlebars/Jinja/Vue file is then visually intact but cannot open a variable group.

## Alternatives considered

**Hand-rolled PDF parser (FlateDecode + text operators + ToUnicode).** Drafted, then dropped for `unpdf`: [the dependencies-over-hand-rolling policy](../process/2026-07-26-dependencies-over-hand-rolling.md) applies squarely — `unpdf` deletes ~350 lines of fragile parser and the per-file 100 % coverage it would owe, has zero runtime dependencies, bundles its own pdf.js, and matches the engines range. The hand-rolled version also garbled subset-font PDFs, which is most real-world output.

**Inline via a synchronous `systemPrompt.context()` provider instead of the assemble waterfall.** Rejected: `PromptContext.text` is `(ctx) => string`, and reading and extracting files is asynchronous. The `system-prompt/assemble` waterfall is the sanctioned async escape hatch (`agent/model-selection` mutates `variables` through it the same way), and appending to `assembly.contexts` still flows through `runtimeContext.project`, so the inlined text is committed as a logged `user/message` — model-visible ⟺ logged holds.

**Fold the contents as a real `user/message` through `agent/pre-step`, like `agent-instructions`.** Rejected as disproportionate: that path carries its own source kind, inbox reconciliation, and no-step-turn handling. Riding the runtime-context snapshot supersedes the previous inlining each turn for free; the only thing it costs is the `{{ }}` neutralisation, which is one `replace`.

**Extract every non-UTF-8 binary, not just PDFs.** Rejected: the only format with a text layer worth surfacing is PDF, and routing PNG/zip/etc. through extraction changed their long-standing `read` error message for no gain. `looksLikePdf` gates the fallback so every other binary is untouched.

**A dedicated `@deepseek-ai/dsh-document-extract` package.** Deferred: 80 lines with two in-repo consumers does not yet clear the bar for a new workspace member, tsconfig, invariant, and bilingual README. It lives in `tool-fs` (which already owns `read` and carries runtime dependencies); `file-reference-local` imports it through the package barrel.

## Testing

`extract-document.spec.ts` covers the sniff, a real text-layer PDF fixture, a valid PDF with no text operators (`note`), a corrupt PDF (`note`), the non-text binary case, and the character clamp. `read-extract.spec.ts` drives the tool: a PDF windows as line-numbered content, `offset`/`limit` apply over the layer, a no-text PDF is an `isError` with the reason, a UTF-8 file never touches the byte path, and a non-PDF binary keeps the backend error. `referenced-files.spec.ts` covers `collectReferencedPaths` (plain/quoted/dedupe/order/limit/plugin-message exclusion) and the inliner through a real composition: a markdown file and a PDF fold into the snapshot, an oversized file is listed, `{{ }}` is neutralised without throwing, each file is read once across assemblies, disposal removes the section, `inlineReferencedFiles: false` contributes nothing, and the tunables validate.

## Consequences

`read` works on a `.pdf`, and a referenced `.md` / `.txt` / `.pdf` is in the model's context with no tool call — the weak-model case the report started from. `unpdf` is a new runtime dependency of `tool-fs` (bundled pdf.js, no transitive deps). `file-reference-local` now depends on `tool-fs` and `dsh-fs`; both already ship in the web bundle, so there is no new weight.

Standing obligations: the `{{ }}` neutralisation is invisible but real — a model that needs a template file byte-exact must `read` it, and the guidance says so. Inlining is bounded per snapshot and supersedes each turn, but a session that references many large files spends those caps on the newest ones. Extraction is text-layer only: a scanned PDF, per-glyph CID fonts without `/ToUnicode`, XFA form data, and `.docx` are not covered.
