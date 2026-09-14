#!/usr/bin/env node
/**
 * Process-level smoke for the api-server bundle: boots the real worker over a
 * UNIX socket and the real standalone HTTP mount, completes one roundtrip on
 * each, and shuts both down with SIGTERM. Spawning is the point of this script
 * — it is the CI smoke, never a vitest test.
 */
import { Effect } from 'effect'
import { Client, PROTOCOL_VERSION } from 'llm-wiki-protocol'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const entries = Object.fromEntries(
  ['worker', 'standalone'].map((name) => [
    name,
    join(packageRoot, 'dist', 'src', 'entries', `${name}.js`),
  ]),
)

const missing = Object.values(entries).filter((path) => !existsSync(path))
if (missing.length > 0) {
  process.stderr.write(
    `The api-server bundle is not built: ${missing.join(', ')}\n` +
      'Run `pnpm api:build` from the repository root, then re-run this script.\n',
  )
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'llm-wiki-smoke-'))
const failures = []
let failuresCount = 0

const record = (name, ok, detail) => {
  process.stdout.write(`${ok ? 'ok' : 'FAIL'} ${name}: ${detail}\n`)
  if (!ok) {
    failuresCount += 1
    failures.push(name)
  }
}

const waitForReady = (child, name) =>
  new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const finish = (handshake) => {
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      resolve(handshake)
    }
    const onStdout = (chunk) => {
      stdout += String(chunk)
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('ready ')) continue
        try {
          finish(JSON.parse(line.slice('ready '.length)))
          return
        } catch {
          finish(undefined)
          return
        }
      }
    }
    const onStderr = (chunk) => {
      stderr += String(chunk)
    }
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('exit', (code) => reject(new Error(`${name} exited early (code ${code}): ${stderr}`)))
  })

const stop = (child) =>
  new Promise((resolve) => {
    child.once('exit', (code) => resolve(code))
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
  })

const socketHealth = (socketPath) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const client = yield* Client.SocketApiClient
        return yield* client.health()
      }).pipe(Effect.provide(Client.SocketApiClient.layer({ path: socketPath }))),
    ),
  )

const httpHealth = async (url) => {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/ndjson' },
    body: `${JSON.stringify({ _tag: 'Request', id: '1', tag: 'health', payload: null, headers: [] })}\n`,
  })
  return { status: response.status, body: await response.text() }
}

try {
  const appStatePath = join(scratch, 'app-state.json')
  writeFileSync(appStatePath, JSON.stringify({}), 'utf8')
  const socketPath = join(scratch, 'api-server.sock')
  const worker = spawn(
    process.execPath,
    [entries.worker, '--app-state', appStatePath],
    { env: { ...process.env, LLM_WIKI_SOCKET_PATH: socketPath }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const workerHandshake = await waitForReady(worker, 'worker')
  record(
    'worker ready handshake',
    workerHandshake !== undefined &&
      workerHandshake.protocolVersion === PROTOCOL_VERSION &&
      workerHandshake.socketPath === socketPath &&
      workerHandshake.serverVersion === packageJson.version,
    JSON.stringify(workerHandshake),
  )
  const health = await socketHealth(socketPath)
  record(
    'worker health roundtrip',
    health.ok && health.status === 'running',
    JSON.stringify({ ok: health.ok, status: health.status, version: health.version }),
  )
  const workerExit = await stop(worker)
  record(
    'worker clean shutdown',
    workerExit === 0 && !existsSync(socketPath),
    `exit=${workerExit} socketRemoved=${!existsSync(socketPath)}`,
  )
} catch (error) {
  record('worker smoke', false, String(error))
}

try {
  const configPath = join(scratch, 'server-config.json')
  writeFileSync(
    configPath,
    JSON.stringify({ api: { enabled: true, mcpEnabled: true, allowUnauthenticated: true } }),
    'utf8',
  )
  const standalone = spawn(process.execPath, [entries.standalone, '--config', configPath], {
    env: { ...process.env, LLM_WIKI_BIND_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const handshake = await waitForReady(standalone, 'standalone')
    record(
      'standalone ready handshake',
      handshake !== undefined &&
        handshake.protocolVersion === PROTOCOL_VERSION &&
        typeof handshake.url === 'string',
      JSON.stringify(handshake),
    )
    const response = await httpHealth(handshake.url ?? 'http://127.0.0.1:19828')
    record(
      'standalone health roundtrip',
      response.status === 200 && response.body.includes('"ok":true'),
      `status=${response.status} body=${response.body.trim()}`,
    )
  } finally {
    const exit = await stop(standalone)
    record('standalone clean shutdown', exit === 0, `exit=${exit}`)
  }
} catch (error) {
  record('standalone smoke', false, String(error))
}

rmSync(scratch, { recursive: true, force: true })
process.exit(failuresCount === 0 ? 0 : 1)
