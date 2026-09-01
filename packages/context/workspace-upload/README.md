# `@deepseek-ai/dsh-workspace-upload`

English | [中文](README.zh.md)

Host service for user file uploads into a session workspace. The composer's `/upload` command sends one chosen file as canonical base64 to the unary `workspaceUpload/put` Remote method (`@Remote` on the Service Definition, agent resolved from the wire identity). The service decodes the payload, enforces a configurable byte ceiling (`maxBytes`, default 10 MiB), applies a strict basename policy (no path separator, no parent-directory traversal, no control characters), disambiguates name collisions with a ` (n)` suffix, and writes the file under `<session cwd>/files/` behind a `realpath` guard that keeps the target inside the session workspace.

On a successful write the service emits the host-internal one-way `workspace/file-added` cordis event so file-reference discovery can drop its cached workspace index and offer the new file to `@files/…` completion immediately.

## Model Experience

Indirectly. This service never adds request tokens or Session-log content of its own: an uploaded file becomes model-visible only when it is named as an ordinary `@files/<name>` path reference and the model calls its `read` tool, exactly as for any other workspace file.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No upload history** — the service writes the file and returns; it keeps no record of what was uploaded and offers no list or delete operation (the workspace directory browser is the authority).
- **Whole-payload transfer** — the file crosses the wire as one base64 string with no chunking or resumable transfer, so the byte ceiling is also a practical single-request-size limit.
- **Last-writer collisions only within one call** — concurrent uploads of the same name from two clients race on the `wx` create flag; the loser retries against the next free ` (n)` name.
