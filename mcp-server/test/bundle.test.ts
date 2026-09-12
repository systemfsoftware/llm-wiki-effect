import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// The desktop app ships `dist/src/index.js`, not the TypeScript sources, and it
// runs without any node_modules next to it. This drives that exact artifact
// over stdio the way an MCP client does, so a bundle that lost its inlined
// dependencies fails here instead of on a user's machine.
const packageRoot = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error("no package.json above the test file")
    dir = parent
  }
})()

const bundlePath = path.join(packageRoot, "dist", "src", "index.js")

interface JsonRpcResponse {
  id?: number
  result?: {
    serverInfo?: { name?: string; version?: string }
    tools?: unknown[]
  }
}

test("the built bundle completes an MCP handshake on its own", async () => {
  assert.ok(
    existsSync(bundlePath),
    `bundle not found at ${bundlePath} -- run \`pnpm build\` first`,
  )

  const child = spawn(process.execPath, [bundlePath], { stdio: ["pipe", "pipe", "pipe"] })
  const answers = new Map<number, JsonRpcResponse>()

  // No wall-clock wait anywhere: the handshake resolves when both replies
  // arrive, and the process exiting first rejects it. A bundle that cannot
  // boot therefore fails the test immediately instead of slowly.
  let resolveHandshake = () => {}
  const handshake = new Promise<void>((resolve) => {
    resolveHandshake = resolve
  })
  const died = new Promise<never>((_, reject) => {
    child.on("error", reject)
    child.on("exit", (code, signal) =>
      reject(
        new Error(`bundle exited before answering the handshake (code ${code}, signal ${signal})`),
      ),
    )
  })
  died.catch(() => {}) // the kill in `finally` is not a failure

  let buffered = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      try {
        const message = JSON.parse(line) as JsonRpcResponse
        if (typeof message.id === "number") answers.set(message.id, message)
      } catch {
        // A stdio server may log on stdout; only JSON-RPC frames matter here.
      }
      if (answers.has(1) && answers.has(2)) resolveHandshake()
    }
  })
  child.stderr.resume()

  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bundle-smoke", version: "0" },
    },
  })
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })

  try {
    await Promise.race([handshake, died])
  } finally {
    child.kill()
  }

  assert.equal(answers.get(1)?.result?.serverInfo?.name, "llm-wiki")
  assert.match(
    answers.get(1)?.result?.serverInfo?.version ?? "",
    /^\d+\.\d+\.\d+$/,
    "the bundle must resolve its version from package.json",
  )
  assert.ok(
    (answers.get(2)?.result?.tools?.length ?? 0) > 0,
    "the bundle must expose at least one MCP tool",
  )
})
