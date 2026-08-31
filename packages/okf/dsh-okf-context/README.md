# @mindportalix/dsh-okf-context

Makes the tenant's OKF bundle part of the agent's working context.

1. **Standing guidance** — an order-150 prompt section (`OKF_GUIDANCE`) telling the agent it maintains an OKF bundle, when to consult it, and how to keep the trust and lifecycle fields honest (don't self-`verify`; use `human:` only for real sign-off; set `stale_after` / `status: deprecated`).
2. **Per-turn catalogue snapshot** — an `agent/pre-step` listener that appends a durable `user/message` (source `plugin: okf-context`, form `snapshot`) listing every concept — id, title, type, trust tier, staleness — exactly like `@deepseek-ai/dsh-time-context` injects its clock reading. It is emitted only when the bundle exists and holds at least one concept, and re-emitted on the next step after a write, so a later "newest supersedes" snapshot reflects it.

## Config

| key | default | meaning |
|-----|---------|---------|
| `maxBytes` | `32768` | Byte cap for the snapshot; a longer list is truncated on a line boundary with a marker. Must be > 0. |
| `refreshIntervalMs` | `0` | Minimum ms between injections in one session. `0` injects at every eligible step (newest supersedes). |

## Model Experience

- **System prompt:** one static order-150 section (`OKF_GUIDANCE`), ~1.5 KB, stable across turns — cache-friendly.
- **Request history:** one durable `user/message` per eligible step (subject to `refreshIntervalMs`), up to `maxBytes`. Reconstructable from the session log.
- **Tools:** none — `@mindportalix/dsh-tool-okf` owns those.

## Known Limitations and Deferred Work

- **No change tracking.** Unlike `@deepseek-ai/dsh-agent-instructions`, this plugin does not diff successive snapshots or prune superseded ones; it relies on the runtime's "newest runtime-context snapshot supersedes" handling. A concept-level change feed is deferred.
- **Snapshot is a listing, not content.** It carries titles and signal flags, not bodies; the agent still calls `okf_read_concept` for detail.
