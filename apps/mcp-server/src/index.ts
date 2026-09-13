#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { LlmWikiApiClient } from './api-client.js'
import { McpProjectBinding } from './project-binding.js'
import { createMcpServer } from './server.js'
import { VERSION } from './version.js'

const client = new LlmWikiApiClient()
const server = createMcpServer({ client, binding: new McpProjectBinding() })

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`LLM Wiki MCP server v${VERSION} connected to ${client.endpoint}`)
}

main().catch((err) => {
  console.error('Failed to start LLM Wiki MCP server:', err)
  process.exit(1)
})
