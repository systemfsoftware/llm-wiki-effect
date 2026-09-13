#!/usr/bin/env node
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const appStatePath = flag('--app-state')
const approvalSocketPath = flag('--approval-socket')
const rpcSocketPath = process.env.LLM_WIKI_SOCKET_PATH
if (!appStatePath || !approvalSocketPath || !rpcSocketPath) process.exit(2)

const tracePath = process.env.LLM_WIKI_FAKE_TRACE
if (tracePath) {
  writeFileSync(
    tracePath,
    JSON.stringify({
      argv,
      socketEnv: process.env.LLM_WIKI_SOCKET_PATH ?? null,
      pid: process.pid,
      appStateContents: readFileSync(appStatePath, 'utf8'),
    }),
  )
}

const write = (socket, frame) => socket.write(JSON.stringify(frame) + '\n')

const ackWaiters = new Map()

function fail(socket, id, message) {
  write(socket, {
    _tag: 'Exit',
    requestId: id,
    exit: { _tag: 'Failure', cause: [{ _tag: 'Die', defect: { name: 'Error', message } }] },
  })
}

function chatStream(socket, frame) {
  const id = frame.id
  const sessionId = frame.payload?.sessionId ?? 's1'
  const runId = frame.payload?.runId ?? 'r1'
  const chunks = [
    [{ type: 'meta', projectId: 'p1', sessionId, runId }],
    [{ type: 'agentEvent', event: { type: 'messageDelta', text: 'one' } }],
    [{ type: 'agentEvent', event: { type: 'messageDelta', text: 'two' } }],
  ]
  const pump = (index) => {
    if (index >= chunks.length) {
      write(socket, { _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: { type: 'done' } } })
      return
    }
    write(socket, { _tag: 'Chunk', requestId: id, values: chunks[index] })
    ackWaiters.set(id, () => pump(index + 1))
  }
  pump(0)
}

const rpcServer = createServer((socket) => {
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const frame = JSON.parse(line)
      if (frame._tag === 'Ack') {
        const next = ackWaiters.get(frame.requestId)
        if (next) {
          ackWaiters.delete(frame.requestId)
          next()
        }
        continue
      }
      if (frame._tag !== 'Request') continue
      const payload = frame.payload ?? {}
      if (frame.tag === 'health') {
        write(socket, {
          _tag: 'Exit',
          requestId: frame.id,
          exit: { _tag: 'Success', value: { ok: true, status: 'running' } },
        })
      } else if (frame.tag === 'chatCancel') {
        write(socket, {
          _tag: 'Exit',
          requestId: frame.id,
          exit: { _tag: 'Success', value: { sessionId: payload.sessionId ?? '', cancelled: true } },
        })
      } else if (frame.tag === 'reloadConfig') {
        write(socket, {
          _tag: 'Exit',
          requestId: frame.id,
          exit: { _tag: 'Success', value: { reloaded: true } },
        })
      } else if (frame.tag === 'chatStream') {
        chatStream(socket, frame)
      } else {
        fail(socket, frame.id, `Unknown request tag: ${frame.tag}`)
      }
    }
  })
})

const approvalServer = createServer((socket) => {
  write(socket, {
    type: 'approval_request',
    id: 'req-1',
    projectId: 'p1',
    sessionId: 's1',
    commands: ['ls -la'],
  })
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      const frame = JSON.parse(line)
      if (frame.type !== 'approval_result' || frame.id !== 'req-1' || frame.approved !== true) {
        write(socket, { type: 'approval_problem', detail: line })
        continue
      }
      write(socket, {
        type: 'approval_request',
        id: 'req-2',
        projectId: 'p1',
        sessionId: 's1',
        commands: ['pwd'],
      })
    }
  })
})

let listeners = 0
function announceReady() {
  listeners += 1
  if (listeners < 2) return
  process.stdout.write(
    JSON.stringify({ protocolVersion: 1, serverVersion: '0.0.0-test', mode: 'worker', socketPath: rpcSocketPath })
      .replace(/^/, 'ready ') + '\n',
  )
}

for (const path of [rpcSocketPath, approvalSocketPath]) rmSync(path, { force: true })
rpcServer.listen(rpcSocketPath, announceReady)
approvalServer.listen(approvalSocketPath, announceReady)
