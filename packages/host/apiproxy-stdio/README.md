# `@deepseek-ai/dsh-host-apiproxy-stdio`

English | [中文](README.zh.md)

The newline-delimited JSON-RPC carrier for the transport-independent [`ctx.apiProxy`](../apiproxy/README.md). The plugin reserves stdout for protocol frames, reads requests from stdin, and keeps diagnostics on stderr. It injects `apiProxy` and launcher-owned `appExit`; booting it outside a launcher that provides both services fails loud.

## Protocol

Clients must call `dsh/initialize` once before any other request. `dsh/request` carries a full-form Host API `ClientRequest`, `dsh/respond` answers a Host-initiated interaction, and `dsh/subscribe` opens either the `mux` or `host` event stream. Stream frames arrive as `dsh/event` notifications with a carrier-minted subscription id and the original answerable server `rpcId`. `dsh/unsubscribe` cancels and settles one stream. The protocol vocabulary is exported from `@deepseek-ai/dsh-host-apiproxy-stdio/protocol` without importing Node runtime modules.

`dsh/shutdown`, stdin closure, and stdin failure all cancel active streams and request launcher exit after pending protocol output flushes. Plugin disposal cancels and awaits the same stream tasks before closing the transport. Host API payloads pass the same compiler-locked dispatcher and domain schemas as the fetch carrier; implementation failures remain carrier failures rather than business-error responses.

## Model Experience

None, as the carrier moves Host API messages and contributes no prompt, tool schema, message, or model call.

#### KV Cache effect

None; the carrier does not assemble or send provider requests.

## Known Limitations and Deferred Work

- **One initialized client per process** — reconnect starts a new DSH process; a second initialization on the same carrier is rejected.
- **No stream resume outside Host cursors** — `mux` accepts its existing per-session `since` cursors, while the `host` stream has no carrier-level replay buffer.
- **No authentication layer** — stdio inherits the parent-child process trust relationship and must not be exposed as a shared pipe without an outer authorization mechanism.
