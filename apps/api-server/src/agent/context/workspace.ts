/**
 * Workspace file context.
 *
 * Ported from apps/desktop/src-tauri/src/agent/workspace.rs: the Agent's
 * user-visible output directory is `<project>/agent-workspace`, and the prompt
 * always sees it with forward slashes so a Windows project path cannot produce
 * a half-escaped path inside the model context.
 */
import { join } from 'node:path'
import { AGENT_WORKSPACE_DIR } from '../tools/paths.js'

export const agentWorkspacePath = (
  projectRoot: string,
  ...segments: ReadonlyArray<string>
): string => join(projectRoot, AGENT_WORKSPACE_DIR, ...segments)

export const agentWorkspaceDisplay = (projectRoot: string): string =>
  agentWorkspacePath(projectRoot).replaceAll('\\', '/')
