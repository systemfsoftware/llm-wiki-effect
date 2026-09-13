---
"llm-wiki": minor
---

The API server now runs as its own supervised process instead of living inside
the desktop app, and it speaks a versioned RPC protocol over a local socket
instead of a REST API. Project data again has a single writer — that server
process — and the same server can be run standalone, serving the API over HTTP
and WebSocket for remote use. The desktop app bundles the server, so updating
the desktop requires nothing on your side, and MCP clients are unaffected: the
same tools, with unchanged names, inputs, and results, and their configuration
still generated for you in Settings.

If you scripted the retired `/api/v1` HTTP API — curl calls, `Accept:
text/event-stream` streaming, or a `?token=` query parameter — those endpoints
are gone, with no compatibility shim. Point that tooling at the MCP server, or at
the protocol client from a repository checkout, before you upgrade.
