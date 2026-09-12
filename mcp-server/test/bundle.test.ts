import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The desktop app ships `dist/src/index.js`, not the TypeScript sources, and it
// runs without any node_modules next to it. This drives that exact artifact
// over stdio the way an MCP client does, so a bundle that lost its inlined
// dependencies fails here instead of on a user's machine.
const packageRoot = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('no package.json above the test file')
    dir = parent
  }
})()

const bundlePath = path.join(packageRoot, 'dist', 'src', 'index.js')

interface JsonRpcResponse {
  id: number
  result?: {
    serverInfo?: { name?: string; version?: string }
    tools?: unknown[]
  }
}

function readResponse(line: string): JsonRpcResponse | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) return null
  if (typeof parsed.id !== 'number') return null

  const response: JsonRpcResponse = { id: parsed.id }
  if (!('result' in parsed) || typeof parsed.result !== 'object' || parsed.result === null) {
    return response
  }

  const result: NonNullable<JsonRpcResponse['result']> = {}
  if (
    'serverInfo' in parsed.result &&
    typeof parsed.result.serverInfo === 'object' &&
    parsed.result.serverInfo !== null
  ) {
    const serverInfo: NonNullable<NonNullable<JsonRpcResponse['result']>['serverInfo']> = {}
    if ('name' in parsed.result.serverInfo && typeof parsed.result.serverInfo.name === 'string') {
      serverInfo.name = parsed.result.serverInfo.name
    }
    if ('version' in parsed.result.serverInfo && typeof parsed.result.serverInfo.version === 'string') {
      serverInfo.version = parsed.result.serverInfo.version
    }
    result.serverInfo = serverInfo
  }
  if ('tools' in parsed.result && Array.isArray(parsed.result.tools)) {
    result.tools = parsed.result.tools
  }
  response.result = result
  return response
}

void test('the built bundle completes an MCP handshake on its own', async () => {
  assert.ok(
    existsSync(bundlePath),
    `bundle not found at ${bundlePath} -- run \`pnpm build\` first`,
  )

  const child = spawn(process.execPath, [bundlePath], { stdio: ['pipe', 'pipe', 'pipe'] })
  const answers = new Map<number, JsonRpcResponse>()

  // No wall-clock wait anywhere: the handshake resolves when both replies
  // arrive, and the process exiting first rejects it. A bundle that cannot
  // boot therefore fails the test immediately instead of slowly.
  let resolveHandshake = () => {}
  const handshake = new Promise<void>((resolve) => {
    resolveHandshake = resolve
  })
  const died = new Promise<never>((_, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) =>
      reject(
        new Error(`bundle exited before answering the handshake (code ${code}, signal ${signal})`),
      ))
  })
  died.catch(() => {}) // the kill in `finally` is not a failure

  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      // A stdio server may log on stdout; only JSON-RPC frames matter here.
      const message = readResponse(line)
      if (message) answers.set(message.id, message)
      if (answers.has(1) && answers.has(2)) resolveHandshake()
    }
  })
  child.stderr.resume()

  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'bundle-smoke', version: '0' },
    },
  })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

  try {
    await Promise.race([handshake, died])
  } finally {
    child.kill()
  }

  assert.equal(answers.get(1)?.result?.serverInfo?.name, 'llm-wiki')
  assert.match(
    answers.get(1)?.result?.serverInfo?.version ?? '',
    /^\d+\.\d+\.\d+$/,
    'the bundle must resolve its version from package.json',
  )
  assert.ok(
    (answers.get(2)?.result?.tools?.length ?? 0) > 0,
    'the bundle must expose at least one MCP tool',
  )
})
