---
"llm-wiki": minor
---

The API server now runs as its own supervised process, speaking a versioned RPC
protocol over a local socket rather than REST, standalone over HTTP and
WebSocket, with MCP clients unaffected.

- `mcpEnabled` is now enforced (the retired server ignored it): when off, all
  MCP-mapped operations except `health` reject non-supervisor callers with
  `McpDisabled`.
- Streaming is newline-delimited JSON over the `/rpc/stream` WebSocket (no
  SSE); `runId` rides the `meta` frame only.
- The bundled HTTP client sends `Authorization: Bearer <token>` only; the
  server still accepts `x-llm-wiki-token`.
- Failures are typed errors, not HTTP statuses; the `llm-wiki-protocol` package
  owns the retired-status-to-error mapping.

If you scripted the retired `/api/v1` HTTP API, those endpoints are gone with no
shim: point that tooling at the MCP server or the protocol client before you
upgrade.
