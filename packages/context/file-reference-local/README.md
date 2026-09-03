# `@deepseek-ai/dsh-file-reference-local`

English | [中文](README.zh.md)

Local-filesystem implementation of `ctx.fileReferences`. It maintains one bounded `WorkspaceFileSearch` per agent, rooted at that session's `cwd` and falling back to the host process cwd. The index ranks direct directory listings for queries containing `/`, otherwise fuzzy-ranks a bounded recursive index; it never follows directory symlinks.

Tool-result events invalidate the addressed agent's reusable index so later completion observes likely workspace mutations. Agent disposal releases that index and its scoped prompt contribution; plugin disposal awaits every prompt fiber and releases all cached searches.

## Referenced-file inlining

Selecting an `@path` contributes only a path; a smaller or less tool-eager model then answers about a file it never opened. When `inlineReferencedFiles` is on (the default), the provider installs one per-agent `system-prompt/assemble` contributor that reads the files a person referenced with `@` — across every user turn, newest reference first — and folds their current text into the runtime-context snapshot, so a `.md`, `.txt`, or `.pdf` is present without a `read` call. A PDF is inlined as its extracted text layer ([`@deepseek-ai/dsh-tool-fs`](../../fs/tool-fs)'s `extractDocumentText`). Each file's extraction is cached against its filesystem version, so steps within a turn re-stat but do not re-read. A file over `maxInlinedBytesPerFile`, outside the workspace, or with no readable text is listed by name with the reason and the model is pointed at `read`. `{{` and `}}` in inlined text are split with a zero-width space so a referenced template file cannot crash `{{variable}}` interpolation of the snapshot.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `maxResults` | `20` | Maximum ranked candidates returned for one query. |
| `maxEntries` | `10000` | Maximum files and directories indexed per agent workspace. |
| `excludedDirectories` | `[".git", "node_modules"]` | Directory basenames omitted from traversal and candidates. |
| `inlineReferencedFiles` | `true` | Fold the contents of `@`-referenced files into the runtime context. |
| `maxInlinedFiles` | `5` | Maximum distinct referenced paths inlined per snapshot, newest first. |
| `maxInlinedBytesPerFile` | `524288` | Byte cap on one referenced file before it is listed by name instead of inlined. |
| `maxInlinedCharsPerFile` | `60000` | Character cap on one file's inlined text before a truncation line. |
| `maxInlinedCharsTotal` | `160000` | Character ceiling over every inlined file in one snapshot. |

Every numeric value must be a positive safe integer. Excluded names must be non-empty basenames without `/` or `\`.

## Model Experience

### File-reference guidance when `read` is available

#### What the model sees

When the addressed agent has an effective `read` tool, the provider contributes this stable system-prompt section:

##### File-reference instruction

```markdown
Paths prefixed with @ are files explicitly referenced by the user. A small referenced file may already appear with its contents in the runtime context; when it does not, or you need more of it, use the read tool. Never claim to have inspected a file you have not seen.
```

#### Token effect

Conditional and fixed: the one sentence is present while `read` is visible to the addressed agent; candidate lookup itself adds no tokens, and a selected path contributes only its ordinary user-message characters.

#### KV Cache effect

The stable sentence joins the system-prompt prefix. Mounting or removing this provider, or changing whether `read` is visible, changes that prefix; queries, candidates, and index invalidations do not.

### Referenced-file contents in the runtime context

#### What the model sees

While `inlineReferencedFiles` is on and the session's user turns carry `@path` references that resolve to readable files under the workspace, the runtime-context snapshot gains one `context:referenced-files` section: a short lead line, then each file as `----- <path> -----` (a PDF as `----- <path> (extracted text) -----`) followed by its text, truncated with `[… truncated; use the read tool for the rest …]` at the per-file or total character cap. Files that could not be inlined are named on a trailing `Referenced but not inlined (use the read tool): …` line.

#### Token effect

Bounded by `maxInlinedFiles`, `maxInlinedCharsPerFile`, and `maxInlinedCharsTotal`. The section rides the runtime-context snapshot, which supersedes its prior version each turn rather than accumulating.

#### KV Cache effect

The snapshot sits after the stable system-prompt prefix, so inlined contents do not disturb prefix reuse; a changed set of referenced files re-emits the snapshot as an ordinary appended runtime-context message.

## Known Limitations and Deferred Work

- **Host-local namespace** — the provider scans the Harness host filesystem, so remote or virtual `read` implementations require a provider whose namespace matches the tool.
- **Bounded advisory index** — very large workspaces may omit paths after `maxEntries`, and excluded or unreadable directories do not appear.
- **No ignore-file semantics** — `.gitignore` and other project ignore files do not influence discovery; only configured directory basenames are excluded.
- **Inlining is text and PDF only** — a referenced image, archive, or other binary is named but not inlined; use `read_image` for images. PDF inlining is text-layer extraction, not OCR.
- **Reference detection is grammar-only** — `collectReferencedPaths` re-scans user-message text for `@path` / `@"path"` tokens; it does not consult the editor's structured reference table, so a reference broken up by an edit is not inlined.
