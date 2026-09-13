import { Effect, Option, Schema, Scope } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { dirname } from 'node:path'
import type { Approver } from '../agent/tools/Approver.js'
import { shellCommandFromCall } from '../agent/tools/permissions.js'

export const APPROVAL_SOCKET_MODE = 0o600
export const DEFAULT_APPROVAL_TIMEOUT_MILLIS = 300_000
export const APPROVAL_REQUEST_TYPE = 'approval_request'
export const APPROVAL_RESULT_TYPE = 'approval_result'
export const SHELL_EXEC_TOOL = 'shell.exec'

export const ApprovalRequestFrame = Schema.Struct({
  type: Schema.Literal(APPROVAL_REQUEST_TYPE),
  id: Schema.String,
  projectId: Schema.String,
  sessionId: Schema.String,
  commands: Schema.Array(Schema.String),
})

export const ApprovalResultFrame = Schema.Struct({
  type: Schema.Literal(APPROVAL_RESULT_TYPE),
  id: Schema.String,
  approved: Schema.Boolean,
})

export type ApprovalRequestFrame = Schema.Schema.Type<typeof ApprovalRequestFrame>
export type ApprovalResultFrame = Schema.Schema.Type<typeof ApprovalResultFrame>

export interface ApprovalRequest {
  readonly projectId: string
  readonly sessionId: string
  readonly commands: ReadonlyArray<string>
}

export interface ApprovalChannel {
  readonly decide: (request: ApprovalRequest) => Effect.Effect<boolean>
}

export interface ApprovalChannelOptions {
  readonly path: string
  readonly timeoutMillis?: number | undefined
  readonly newId?: (() => string) | undefined
}

const parseResultFrame = Schema.decodeUnknownOption(ApprovalResultFrame)

const parseResultLine = (line: string): ApprovalResultFrame | undefined => {
  try {
    const frame = parseResultFrame(JSON.parse(line) as unknown)
    return Option.isSome(frame) ? frame.value : undefined
  } catch {
    return undefined
  }
}

const writeFrame = (socket: Socket, frame: ApprovalRequestFrame): boolean => {
  try {
    socket.write(`${JSON.stringify(frame)}\n`)
    return true
  } catch {
    return false
  }
}

const startServer = (
  path: string,
  connect: (socket: Socket) => void,
): Effect.Effect<Server, Errors.BindConflict> =>
  Effect.tryPromise({
    try: async () => {
      await rm(path, { force: true })
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const server = createServer(connect)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, () => {
          server.off('error', reject)
          resolve()
        })
      })
      await chmod(path, APPROVAL_SOCKET_MODE)
      return server
    },
    catch: (error) => new Errors.BindConflict({ message: `Cannot bind approval socket ${path}: ${String(error)}` }),
  })

export const makeApprovalChannel = (
  options: ApprovalChannelOptions,
): Effect.Effect<ApprovalChannel, Errors.BindConflict, Scope.Scope> =>
  Effect.gen(function*() {
    const timeoutMillis = options.timeoutMillis ?? DEFAULT_APPROVAL_TIMEOUT_MILLIS
    const newId = options.newId ?? randomUUID
    const waiting = new Map<string, (approved: boolean) => void>()
    let connection: Socket | undefined
    let buffered = ''

    const answer = (id: string, approved: boolean): void => {
      const resume = waiting.get(id)
      if (resume === undefined) return
      waiting.delete(id)
      resume(approved)
    }

    const denyWaiting = (): void => {
      for (const id of [...waiting.keys()]) answer(id, false)
    }

    const drop = (socket: Socket): void => {
      if (connection !== socket) return
      connection = undefined
      buffered = ''
      denyWaiting()
    }

    const drain = (): void => {
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')
        if (line.trim() === '') continue
        const frame = parseResultLine(line)
        if (frame !== undefined) answer(frame.id, frame.approved)
      }
    }

    const connect = (socket: Socket): void => {
      connection = socket
      buffered = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buffered += chunk
        drain()
      })
      socket.on('close', () => drop(socket))
      socket.on('error', () => drop(socket))
    }

    const server = yield* Effect.acquireRelease(startServer(options.path, connect), (running) =>
      Effect.sync(() => {
        denyWaiting()
        connection?.destroy()
        connection = undefined
        running.close()
      }).pipe(Effect.andThen(Effect.promise(() => rm(options.path, { force: true })))))
    server.on('error', () => {})

    const decide = (request: ApprovalRequest): Effect.Effect<boolean> =>
      Effect.callback<boolean>((resume) => {
        const socket = connection
        if (socket === undefined) {
          resume(Effect.succeed(false))
          return
        }
        const id = newId()
        waiting.set(id, (approved) => resume(Effect.succeed(approved)))
        const written = writeFrame(socket, { type: APPROVAL_REQUEST_TYPE, id, ...request })
        if (!written) {
          waiting.delete(id)
          resume(Effect.succeed(false))
          return
        }
      }).pipe(Effect.timeoutOption(timeoutMillis), Effect.map(Option.getOrElse(() => false)))

    return { decide }
  })

export interface SupervisorApproverOptions {
  readonly decide: ApprovalChannel['decide']
  readonly projectIdFor: (projectRoot: string) => Effect.Effect<string>
}

export const makeSupervisorApprover = (options: SupervisorApproverOptions): Approver => ({
  approve: (call, context) =>
    Effect.gen(function*() {
      if (call.tool !== SHELL_EXEC_TOOL) return false
      const command = shellCommandFromCall(call)
      if (command === undefined) return false
      const projectId = yield* options.projectIdFor(call.projectRoot)
      return yield* options.decide({
        projectId,
        sessionId: context.sessionId,
        commands: [command],
      })
    }),
})
