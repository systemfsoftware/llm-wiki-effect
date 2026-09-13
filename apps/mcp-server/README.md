# LLM Wiki MCP Server

This package exposes the LLM Wiki API server as a Model Context Protocol server.

It does **not** scan project folders directly and does **not** copy the app's search or graph logic. Every tool calls the `llm-wiki-protocol` RPC API, so MCP clients use the same project registry, file permissions, search backend, graph backend, and Source Watch rules as the app.

## Transports

The server picks its transport from the environment:

| Mode            | Env                    | Endpoint                                                                                            |
| --------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| Local (default) | `LLM_WIKI_SOCKET_PATH` | The desktop worker's unix socket, e.g. `/home/you/.local/share/llm-wiki/api-server.sock`            |
| Remote          | `LLM_WIKI_BASE_URL`    | The standalone API server's base URL, e.g. `http://127.0.0.1:19828` (RPC frames go to `<base>/rpc`) |
| Remote auth     | `LLM_WIKI_API_TOKEN`   | Optional bearer token for the standalone server                                                     |

`LLM_WIKI_SOCKET_PATH` wins when both are set. When neither is set, every tool fails with an instruction naming both variables.

The desktop app generates the correct config for local mode: **Settings → API + MCP → MCP usage**.

## Requirements

- Node.js 20+
- Either the LLM Wiki desktop app running (local mode), or a standalone API server (remote mode)
- Settings → API + MCP → "Enable MCP access" (server-side gate: MCP-mapped operations return `McpDisabled` while it is off)

## Build

Run both commands from the repository root. `apps/mcp-server/` is a pnpm workspace package, so the root install already provides its dependencies.

```bash
pnpm install
pnpm mcp:build        # bundles dist/src/index.js
```

## Run

```bash
LLM_WIKI_SOCKET_PATH=/path/to/api-server.sock node dist/src/index.js
```

Example MCP client config (local mode):

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/llm_wiki/apps/mcp-server/dist/src/index.js"],
      "env": {
        "LLM_WIKI_SOCKET_PATH": "/path/to/api-server.sock"
      }
    }
  }
}
```

Example MCP client config (standalone API server):

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/llm_wiki/apps/mcp-server/dist/src/index.js"],
      "env": {
        "LLM_WIKI_BASE_URL": "http://127.0.0.1:19828",
        "LLM_WIKI_API_TOKEN": "your-token"
      }
    }
  }
}
```

## Tools

- `llm_wiki_status`: health and current project summary. Answers even when MCP access is disabled.
- `llm_wiki_projects`: known projects and active project.
- `llm_wiki_set_project`: pin the MCP process session to a project. Once pinned, other project tools reject attempts to access a different project.
- `llm_wiki_files`: list project files. `project_id` can be a project UUID, a project filesystem path, or `current`.
- `llm_wiki_read_file`: read an allowed text file such as `wiki/index.md`.
- `llm_wiki_reviews`: list Review tab items. Defaults to unresolved items and supports `status`, `type`, and `limit` filters.
- `llm_wiki_search`: search with the app's shared keyword/vector backend.
- `llm_wiki_chat`: ask the backend Agent for one aggregate turn and receive answer text, references, usage, and tool events. `mode: deep` broadens backend evidence collection; full Deep Research workflows still live in the desktop app.
- `llm_wiki_graph`: query the app's knowledge graph.
- `llm_wiki_rescan_sources`: trigger a Source Watch rescan using the user's configured rules.
- `llm_wiki_embed_page`: create or replace the vector index of one wiki page.

Tool names, input schemas, and result text are unchanged from the REST era; only the transport underneath changed.

## Errors

Protocol failures surface as MCP errors:

- `McpDisabled` → `InvalidRequest` with "LLM Wiki MCP access is disabled. Enable Settings -> API + MCP -> Enable MCP access in the desktop app."
- `NotFound`, `InvalidRequest`, `PathViolation`, `UnsupportedMediaType`, `TooLarge` → `InvalidParams` (the tool arguments were rejected)
- Every other typed error (`Unauthorized`, `ApiDisabled`, `RateLimited`, `Busy`, `ChatCancelled`, `AgentError`, `EmbedError`, …) → `InternalError`
- Transport failures → `InternalError` with "LLM Wiki API request failed. Is the desktop app running?"

## Security model

The MCP server inherits the API server's security model:

- Local mode only dials the worker's socket, which the desktop creates with owner-only permissions (`0600`).
- Remote mode uses the same token or unauthenticated setting as the standalone server.
- File reads go through the API path allow-list. Internal app state files are not exposed.
- Review data is exposed only through the dedicated Review tools, which default to unresolved items rather than opening internal state files directly.
- Search and graph tools operate on projects known to the app; use `project_id: "current"` for the active project.
- For multi-project use, call `llm_wiki_set_project` once. The resolved project ID remains fixed for the lifetime of the MCP subprocess even if the desktop UI switches projects, and every project-tool response includes an `activeProject` marker.

Do not pass API tokens via command-line arguments. Prefer environment variables so they do not appear in shell history.
