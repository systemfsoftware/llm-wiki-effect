---
"llm-wiki": minor
---

The local API server now runs as its own supervised process instead of living inside the desktop app, and it speaks a versioned RPC protocol over IPC rather than a REST API. The same server can also be run standalone to serve the API over HTTP and WebSocket for remote use. Nothing is required on your side when updating the desktop app.
