# `@deepseek-ai/dsh-client-ui-upload`

English | [中文](README.zh.md)

Web `/upload` command. Registers a `/` input-trigger source (`order: 3`, beside `ui-commands` and `ui-skill`) whose single `upload` candidate opens a native file picker driven from a persistent hidden `<input type="file">` the plugin owns for its lifetime. The chosen file is read as canonical base64 and sent to the host `workspaceUpload.put` Remote, which writes it under `<session cwd>/files/`. On success the source clears the `/upload` token and appends an `@files/<name>` reference (via the shared `@deepseek-ai/dsh-file-reference` grammar) to the draft, so the file rides the ordinary `@path` pipeline into the model's next turn.

A client-side 10 MB pre-check keeps an obviously oversized file out of the wire; `@deepseek-ai/dsh-workspace-upload`'s `maxBytes` config is the authority and re-checks the decoded payload. Byte-ceiling, read, and host rejections surface as composer notices through `SessionInput.notify`; the draft is never left holding a half-finished command.

## Model Experience

Indirectly. This plugin contributes no model-visible input of its own: an uploaded file reaches the model only as the `@files/<name>` path text it splices into the draft, which the host `file-reference` guidance tells the model to `read`.

#### KV Cache effect

None; this package neither assembles nor sends a provider request. The spliced `@files/<name>` text changes only the new user-message suffix.

## Known Limitations and Deferred Work

- **Menu pick only** — the source implements neither `matchSpace` nor `matchEnter`, so `/upload` submitted as a bare line with the menu already closed falls through to an ordinary prompt instead of opening the picker.
- **No progress or attachment card** — a large upload shows nothing until it settles into a notice; there is no rail entry or upload-progress affordance (that waits on the composer accepting non-image attachments).
- **One file per invocation** — the picker is single-select; uploading several files means running `/upload` several times.
