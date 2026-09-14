import { Effect } from 'effect'
import { Errors } from 'llm-wiki-protocol'
import { isShellCommandAllowedWithoutPrompt, isShellCommandApproved, shellCommandFromCall } from './permissions.js'
import type { ToolCall, ToolCallContext } from './types.js'

export interface Approver {
  readonly approve: (
    call: ToolCall,
    context: ToolCallContext,
  ) => Effect.Effect<boolean, Errors.AgentError>
}

export const denyAll: Approver = { approve: () => Effect.succeed(false) }

const shellDecision = (decide: (command: string, call: ToolCall) => boolean): Approver => ({
  approve: (call) => {
    if (call.tool !== 'shell.exec') return Effect.succeed(false)
    const command = shellCommandFromCall(call)
    if (command === undefined) return Effect.succeed(false)
    return Effect.succeed(decide(command, call))
  },
})

export const allowShellCommands = (commands: ReadonlyArray<string>): Approver =>
  shellDecision((command) => isShellCommandApproved(command, commands))

export const allowShellCommandsInWorkspace = (commands: ReadonlyArray<string>): Approver =>
  shellDecision((command, call) => isShellCommandAllowedWithoutPrompt(command, commands, call.projectRoot))
