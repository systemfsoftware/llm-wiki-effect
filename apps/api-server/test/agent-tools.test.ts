import { Effect, Result } from 'effect'
import { array, assert, asyncProperty, constantFrom, property, string } from 'fast-check'
import { Errors } from 'llm-wiki-protocol'
import { describe, expect, it } from 'vitest'
import {
  AGENT_WORKSPACE_DIR,
  allows,
  allowShellCommands,
  allowShellCommandsInWorkspace,
  apiDefaultPolicy,
  APPROVAL_REQUIRED_OBSERVATION,
  capabilitiesFor,
  denyAll,
  filePathGuard,
  guardSkillReadPath,
  guardWikiReadPath,
  guardWikiWritePath,
  guardWorkspaceWritePath,
  isShellCommandAllowedWithoutPrompt,
  isShellCommandApproved,
  isShellCommandScopedToAgentWorkspace,
  makeToolRegistry,
  requireCapability,
  requiresApproval,
  shellCommandFromCall,
  specFor,
  TOOL_SPECS,
} from '../src/agent/tools/index.js'
import type {
  AgentCapability,
  ToolCall,
  ToolEffect,
  ToolError,
  ToolExecutor,
  ToolRegistryOptions,
  ToolRegistryShape,
  ToolResult,
} from '../src/agent/tools/index.js'
import { isRecord } from '../src/json.js'

const PROJECT_ROOT = '/tmp/llm-wiki-agent-tools-project'
const WORKSPACE = `${PROJECT_ROOT}/${AGENT_WORKSPACE_DIR}`
const SESSION_ID = 's1'

const EXPECTED_TOOL_NAMES = [
  'wiki.search',
  'wiki.read_page',
  'source.search',
  'web.search',
  'graph.search',
  'anytxt.search',
  'deep_research.run',
  'wiki.write_page',
  'llm.generate',
  'skills.load',
  'skill.read_file',
  'workspace.write_file',
  'workspace.append_file',
  'shell.exec',
]

const EXPECTED_EFFECTS: Record<string, ReadonlyArray<ToolEffect>> = {
  'wiki.search': ['read'],
  'wiki.read_page': ['read'],
  'source.search': ['read'],
  'web.search': ['network'],
  'graph.search': ['read'],
  'anytxt.search': ['network', 'read'],
  'deep_research.run': ['network', 'read'],
  'wiki.write_page': ['write'],
  'llm.generate': ['network'],
  'skills.load': ['read'],
  'skill.read_file': ['read'],
  'workspace.write_file': ['write'],
  'workspace.append_file': ['write'],
  'shell.exec': ['read', 'process'],
}

const DEFAULT_CAPABILITIES: ReadonlyArray<AgentCapability> = [
  'read_project',
  'read_source',
  'search_wiki',
  'search_web',
  'search_any_txt',
  'write_wiki',
  'network',
  'process',
]

const EXPECTED_CAPABILITIES: Record<string, ReadonlyArray<AgentCapability>> = {
  'wiki.search': ['search_wiki'],
  'wiki.read_page': ['read_project'],
  'source.search': ['read_source'],
  'web.search': ['network'],
  'graph.search': ['read_project'],
  'anytxt.search': ['network'],
  'deep_research.run': ['run_deep_research'],
  'wiki.write_page': ['write_wiki'],
  'llm.generate': ['network'],
  'skills.load': ['read_project'],
  'skill.read_file': ['read_project'],
  'workspace.write_file': ['write_wiki'],
  'workspace.append_file': ['write_wiki'],
  'shell.exec': ['process'],
}

const call = (tool: string, input: Readonly<Record<string, unknown>> = {}): ToolCall => ({
  projectRoot: PROJECT_ROOT,
  tool,
  input,
})

interface Recorder {
  readonly calls: Array<ToolCall>
  readonly executor: ToolExecutor
}

const recorder = (output: unknown = { ok: true }): Recorder => {
  const calls: Array<ToolCall> = []
  return {
    calls,
    executor: (received) =>
      Effect.sync(() => {
        calls.push(received)
        return output
      }),
  }
}

const registryOf = (options: ToolRegistryOptions): ToolRegistryShape => makeToolRegistry(options)

const execute = (registry: ToolRegistryShape, request: ToolCall) =>
  Effect.runPromise(Effect.result(registry.execute(request, { sessionId: SESSION_ID })))

const successOf = (outcome: Result.Result<ToolResult, ToolError>): ToolResult | null =>
  Result.isSuccess(outcome) ? outcome.success : null

const failureName = (outcome: Result.Result<unknown, ToolError>): string =>
  Result.isFailure(outcome) ? outcome.failure.name : 'success'

const difference = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): Array<string> =>
  left.filter((item) => !right.includes(item))

describe('builtin tool specs', () => {
  it('exposes exactly the Rust tool set', () => {
    const registry = registryOf({})
    expect(registry.specs.map((spec) => spec.name)).toEqual(EXPECTED_TOOL_NAMES)
  })

  it.each(EXPECTED_TOOL_NAMES)('%s declares the ported effects and a description', (name) => {
    const spec = specFor(name)
    expect(spec).toBeDefined()
    expect(spec?.effects).toEqual(EXPECTED_EFFECTS[name])
    expect(spec?.description.trim()).not.toBe('')
  })

  it('publishes no approval field on any tool surface', () => {
    const registry = registryOf({})
    for (const spec of registry.specs) {
      const serialized = JSON.stringify(spec)
      expect(serialized).not.toContain('approval')
      expect(serialized).not.toContain('approvedShellCommands')
    }
  })

  it('declares shell.exec parameters with the command required and the 30s ceiling', () => {
    const parameters = specFor('shell.exec')?.parameters
    expect(parameters?.['required']).toEqual(['command'])
    const properties = parameters?.['properties']
    if (!isRecord(properties)) throw new Error('shell.exec parameters must declare properties')
    const timeout = properties['timeoutSeconds']
    const command = properties['command']
    if (!isRecord(timeout) || !isRecord(command)) {
      throw new Error('shell.exec must declare timeoutSeconds and command properties')
    }
    expect(timeout['maximum']).toBe(30)
    expect(command['type']).toBe('string')
  })

  it('leaves llm.generate and skills.load without parameters', () => {
    expect(specFor('llm.generate')?.parameters).toBeNull()
    expect(specFor('skills.load')?.parameters).toBeNull()
  })

  it('requires approval for shell.exec and for no other tool', () => {
    expect(TOOL_SPECS.filter(requiresApproval).map((spec) => spec.name)).toEqual(['shell.exec'])
  })
})

describe('capability policy', () => {
  it('defaults to every capability except deep research', () => {
    const { allowed } = apiDefaultPolicy()
    expect(difference(allowed, DEFAULT_CAPABILITIES)).toEqual([])
    expect(difference(DEFAULT_CAPABILITIES, allowed)).toEqual([])
    expect(allows(apiDefaultPolicy(), 'run_deep_research')).toBe(false)
  })

  it.each(EXPECTED_TOOL_NAMES)('%s requires the capabilities the runtime declares', (name) => {
    expect(capabilitiesFor(name)).toEqual(EXPECTED_CAPABILITIES[name])
  })

  it('refuses deep_research.run under the default policy without reaching an executor', async () => {
    const stub = recorder()
    const registry = registryOf({ executors: { 'deep_research.run': stub.executor } })
    const outcome = await execute(registry, call('deep_research.run', { query: 'x' }))
    expect(failureName(outcome)).toBe('AgentError')
    expect(stub.calls).toHaveLength(0)
  })

  it('runs deep_research.run once the policy allows the capability', async () => {
    const stub = recorder()
    const registry = registryOf({
      policy: { allowed: [...apiDefaultPolicy().allowed, 'run_deep_research'] },
      executors: { 'deep_research.run': stub.executor },
    })
    const outcome = await execute(registry, call('deep_research.run', { query: 'x' }))
    expect(Result.isFailure(outcome)).toBe(false)
    expect(stub.calls).toHaveLength(1)
  })

  it('refuses tools whose capability the policy omits', async () => {
    const stub = recorder()
    const registry = registryOf({
      policy: { allowed: ['read_project', 'network'] },
      executors: { 'wiki.write_page': stub.executor, 'shell.exec': stub.executor },
    })
    const write = await execute(registry, call('wiki.write_page', { path: 'wiki/a.md', content: '' }))
    const shell = await execute(registry, call('shell.exec', { command: 'echo hi' }))
    expect(failureName(write)).toBe('AgentError')
    expect(failureName(shell)).toBe('AgentError')
    expect(stub.calls).toHaveLength(0)
  })

  it('reports no capability at all for a tool outside the table', () => {
    expect(capabilitiesFor('wiki.search.v2')).toEqual([])
    expect(capabilitiesFor('')).toEqual([])
  })

  it('succeeds with true when the policy allows the capability and names the one it refuses', () => {
    const granted = requireCapability(apiDefaultPolicy(), 'process')
    expect(Result.isSuccess(granted) && granted.success).toBe(true)

    const refused = requireCapability(apiDefaultPolicy(), 'run_deep_research')
    expect(Result.isFailure(refused) && refused.failure.message).toBe(
      "Agent capability 'run_deep_research' is not allowed",
    )
  })
})

describe('shell command extraction', () => {
  it('takes the first present of command, query, then content', () => {
    expect(shellCommandFromCall(call('shell.exec', { command: 'echo one' }))).toBe('echo one')
    expect(shellCommandFromCall(call('shell.exec', { query: 'echo two' }))).toBe('echo two')
    expect(shellCommandFromCall(call('shell.exec', { content: 'echo three' }))).toBe('echo three')
    expect(
      shellCommandFromCall(
        call('shell.exec', { command: 'echo one', query: 'echo two', content: 'echo three' }),
      ),
    ).toBe('echo one')
    expect(shellCommandFromCall(call('shell.exec', { query: 'echo two', content: 'echo three' }))).toBe(
      'echo two',
    )
  })

  it('trims the extracted command and reports blank or non-string input as absent', () => {
    expect(shellCommandFromCall(call('shell.exec', { command: '  echo hi  ' }))).toBe('echo hi')
    expect(shellCommandFromCall(call('shell.exec', { command: '   ' }))).toBeUndefined()
    expect(shellCommandFromCall(call('shell.exec', { query: '' }))).toBeUndefined()
    expect(shellCommandFromCall(call('shell.exec', { content: null }))).toBeUndefined()
    expect(shellCommandFromCall(call('shell.exec', { command: 7 }))).toBeUndefined()
    expect(shellCommandFromCall(call('shell.exec', {}))).toBeUndefined()
  })
})

describe('shell approval gate', () => {
  const command = 'echo skill-ok'

  it('denies every call when no approver is configured', async () => {
    const stub = recorder()
    const registry = registryOf({ executors: { 'shell.exec': stub.executor } })
    const outcome = await execute(registry, call('shell.exec', { command }))
    expect(successOf(outcome)).toEqual({
      status: 'approval_required',
      observation: APPROVAL_REQUIRED_OBSERVATION,
      detail: `approval required: ${command}`,
    })
    expect(stub.calls).toHaveLength(0)
  })

  it('denies every call under the explicit deny-all approver', async () => {
    const stub = recorder()
    const registry = registryOf({ approver: denyAll, executors: { 'shell.exec': stub.executor } })
    const outcome = await execute(registry, call('shell.exec', { command }))
    expect(Result.isSuccess(outcome) && outcome.success.status).toBe('approval_required')
    expect(stub.calls).toHaveLength(0)
  })

  it('ignores an approval list supplied in the call input', async () => {
    const stub = recorder()
    const registry = registryOf({
      approver: allowShellCommands([]),
      executors: { 'shell.exec': stub.executor },
    })
    const outcome = await execute(
      registry,
      call('shell.exec', { command, approvedShellCommands: [command] }),
    )
    expect(Result.isSuccess(outcome) && outcome.success.status).toBe('approval_required')
    expect(stub.calls).toHaveLength(0)
  })

  it('runs the approved call through the executor', async () => {
    const stub = recorder({ exitCode: 0 })
    const registry = registryOf({
      approver: allowShellCommands([command]),
      executors: { 'shell.exec': stub.executor },
    })
    const request = call('shell.exec', { command, timeoutSeconds: 5 })
    const outcome = await execute(registry, request)
    expect(Result.isFailure(outcome)).toBe(false)
    expect(stub.calls[0]).toBe(request)
  })

  it('approves only an exact trimmed command match', async () => {
    const approver = allowShellCommands([command, '  python3 gen.py  '])
    const approved = (input: Readonly<Record<string, unknown>>) =>
      Effect.runPromise(approver.approve(call('shell.exec', input), { sessionId: SESSION_ID }))
    expect(await approved({ command })).toBe(true)
    expect(await approved({ command: `  ${command}  ` })).toBe(true)
    expect(await approved({ command: 'python3 gen.py' })).toBe(true)
    expect(await approved({ command: 'echo skill-ok2' })).toBe(false)
    expect(await approved({ command: 'ECHO SKILL-OK' })).toBe(false)
    expect(await approved({ command: '' })).toBe(false)
    expect(await approved({ command: '   ' })).toBe(false)
    expect(await approved({})).toBe(false)
    expect(await approved({ query: 'echo skill-ok2' })).toBe(false)
  })

  it('refuses non-shell calls and fails closed on a failed approval channel', async () => {
    expect(
      await Effect.runPromise(
        allowShellCommands([command]).approve(call('wiki.search', { query: command }), {
          sessionId: SESSION_ID,
        }),
      ),
    ).toBe(false)
    const stub = recorder()
    const registry = registryOf({
      approver: { approve: () => Effect.fail(new Errors.AgentError({ message: 'channel closed' })) },
      executors: { 'shell.exec': stub.executor },
    })
    const outcome = await execute(registry, call('shell.exec', { command }))
    expect(failureName(outcome)).toBe('AgentError')
    expect(stub.calls).toHaveLength(0)
  })

  it('matches approved commands the way the Rust gate does', () => {
    expect(isShellCommandApproved('echo hi', ['echo hi'])).toBe(true)
    expect(isShellCommandApproved('  echo hi  ', [' echo hi '])).toBe(true)
    expect(isShellCommandApproved('echo hi', [])).toBe(false)
    expect(isShellCommandApproved('', ['echo hi'])).toBe(false)
    expect(isShellCommandApproved('echo hi', ['echo h'])).toBe(false)
    expect(isShellCommandApproved('echo hi', ['echo hi && rm -rf /'])).toBe(false)
    assert(
      property(array(string(), { minLength: 1, maxLength: 3 }), (entries) => {
        const listed = entries.join('\n')
        if (listed.trim() === '') return true
        return !isShellCommandApproved(`${listed}x`, entries)
      }),
      { numRuns: 200 },
    )
  })

  it('rejects only the blank command and compares every other spelling literally', () => {
    expect(isShellCommandApproved('', [''])).toBe(false)
    expect(isShellCommandApproved('   ', ['  '])).toBe(false)
    expect(isShellCommandApproved('echo hi', ['echo hi'])).toBe(true)
    for (const listed of ['Stryker was here!', 'echo hi', '\t']) {
      expect(isShellCommandApproved(listed, [listed])).toBe(listed.trim() !== '')
    }
  })
})

describe('shell command workspace policy', () => {
  const denied: Array<[string, string]> = [
    ['network scheme', 'curl https://example.com/x'],
    ['http scheme', 'wget http://example.com/x'],
    ['ftp scheme', 'lftp ftp://example.com'],
    ['scp', 'scp out/a.svg user@host:/tmp'],
    ['ssh', 'ssh host uptime'],
    ['command substitution', 'echo $(whoami)'],
    ['backtick substitution', 'echo `whoami`'],
    ['home expansion', 'cat ~/secret.md'],
    ['home variable', 'cat $HOME/secret.md'],
    ['windows home variable', 'type %USERPROFILE%\\secret.md'],
    ['xdg variable', 'cat $XDG_CONFIG_HOME/x'],
    ['temp variable', 'cat $TMPDIR/x'],
    ['parent traversal', 'cat ../secret.md'],
    ['embedded traversal', 'cat out/../../secret.md'],
    ['absolute outside the workspace', 'cat /etc/passwd'],
    ['the filesystem root', 'cat /'],
    ['a doubled root separator', 'cat //'],
    ['a tripled root separator', 'cat ///'],
    ['absolute elsewhere in the project', `cat ${PROJECT_ROOT}/schema.md`],
    ['absolute windows path', 'type C:/Windows/win.ini'],
    ['unc path', 'cat \\\\server\\share\\x'],
    ['assignment to an absolute path', 'OUT=/etc/passwd python3 gen.py'],
    ['one-character assignment to an absolute path', 'a=/etc/passwd python3 gen.py'],
    ['a quoted argument that closes before the path', 'cat "a b" /etc/passwd'],
    ['a comma run before a root path', 'cat ,,/etc/passwd'],
    ['a trailing parent segment', 'cat secret/..'],
    ['a parent segment followed by a comma run', 'cat secret/..,,'],
  ]

  const allowed: Array<[string, string]> = [
    ['simple generator', 'python3 gen.py'],
    ['chained generator', 'mkdir -p out && python3 gen.py'],
    ['reads its own artifact', 'cat out/chart.svg'],
    ['quoted argument', 'pandoc "a b.md" -o out/b.pdf'],
    ['absolute path inside the workspace', `cat ${WORKSPACE}/out/chart.svg`],
    ['the workspace itself', `ls ${WORKSPACE}`],
    ['relative path with a dash', './out/chart.svg -o x'],
    ['assignment to a relative path', 'OUT=out/chart.svg python3 gen.py'],
    ['a quoted delimiter before a path', 'cat "x>/etc/passwd"'],
    ['a singly quoted delimiter before a path', "cat 'x>/etc/passwd'"],
    ['a comma run inside a path segment', 'cat out/x/,../b.svg'],
    ['a token that trims down to nothing', 'cat ,'],
    ['a doubled separator inside the workspace', `cat ${WORKSPACE}//out/chart.svg`],
    ['the workspace path with a trailing separator', `cat ${WORKSPACE}/`],
    ['a backslash path inside the workspace', `cat ${WORKSPACE}\\out\\chart.svg`],
  ]

  it.each(denied)('denies %s', (_label, command) => {
    expect(isShellCommandScopedToAgentWorkspace(command, PROJECT_ROOT)).toBe(false)
  })

  it.each(allowed)('allows %s', (_label, command) => {
    expect(isShellCommandScopedToAgentWorkspace(command, PROJECT_ROOT)).toBe(true)
  })

  it('never allows a blank command (property)', () => {
    assert(
      property(
        constantFrom('', ' ', '\t', '\n', '   ', ' \t '),
        (command) => !isShellCommandScopedToAgentWorkspace(command, PROJECT_ROOT),
      ),
      { numRuns: 100 },
    )
  })

  it('never allows a command carrying a network or substitution marker (property)', () => {
    const markers = ['http://', 'https://', 'ftp://', 'sftp://', '$(']
    assert(
      property(
        string(),
        constantFrom(...markers),
        (text, marker) => !isShellCommandScopedToAgentWorkspace(`${text}${marker}${text}`, PROJECT_ROOT),
      ),
      { numRuns: 200 },
    )
    assert(
      property(string(), (text) => !isShellCommandScopedToAgentWorkspace(`${text}\`${text}`, PROJECT_ROOT)),
      { numRuns: 200 },
    )
  })

  it('allows any workspace-relative token sequence (property)', () => {
    assert(
      property(
        array(constantFrom('python3', 'out/a.svg', '-o', 'b.md', '--flag', 'x=1'), {
          minLength: 1,
          maxLength: 5,
        }),
        (tokens) => isShellCommandScopedToAgentWorkspace(tokens.join(' '), PROJECT_ROOT),
      ),
      { numRuns: 200 },
    )
  })

  it('denies any token sequence carrying an escaping token (property)', () => {
    assert(
      property(
        array(constantFrom('python3', 'out/a.svg'), { minLength: 0, maxLength: 4 }),
        constantFrom(
          '../x',
          '..',
          '/etc/passwd',
          '~/x',
          '$HOME/x',
          '%USERPROFILE%/x',
          'a/../../b',
          '\\\\server\\x',
        ),
        (tokens, escaping) => !isShellCommandScopedToAgentWorkspace([...tokens, escaping].join(' '), PROJECT_ROOT),
      ),
      { numRuns: 200 },
    )
  })

  it('approves workspace-scoped commands only under the workspace-aware approver', async () => {
    const strict = allowShellCommands([])
    const workspace = allowShellCommandsInWorkspace([])
    const generator = call('shell.exec', { command: 'python3 gen.py' })
    const context = { sessionId: SESSION_ID }
    expect(await Effect.runPromise(strict.approve(generator, context))).toBe(false)
    expect(await Effect.runPromise(workspace.approve(generator, context))).toBe(true)
    expect(
      await Effect.runPromise(
        workspace.approve(call('shell.exec', { command: 'curl https://x' }), context),
      ),
    ).toBe(false)
    expect(
      await Effect.runPromise(
        workspace.approve(call('shell.exec', { command: 'cat ../secret.md' }), context),
      ),
    ).toBe(false)
  })

  it('runs approved and workspace-scoped commands without a prompt, and nothing else', () => {
    expect(isShellCommandAllowedWithoutPrompt('echo hi', ['echo hi'], PROJECT_ROOT)).toBe(true)
    expect(isShellCommandAllowedWithoutPrompt('python3 gen.py', [], PROJECT_ROOT)).toBe(true)
    expect(isShellCommandAllowedWithoutPrompt('cat /etc/passwd', [], PROJECT_ROOT)).toBe(false)
    expect(
      isShellCommandAllowedWithoutPrompt('cat /etc/passwd', ['cat /etc/passwd'], PROJECT_ROOT),
    ).toBe(true)
  })
})

describe('windows project roots', () => {
  const WINDOWS_ROOT = 'C:\\proj\\'
  const WINDOWS_WORKSPACE = 'C:\\proj\\agent-workspace'

  const workspacePaths: Array<[string, string]> = [
    ['a backslash path inside the workspace', `cat ${WINDOWS_WORKSPACE}\\out\\chart.svg`],
    ['a doubled separator inside the workspace', 'cat C:/proj//agent-workspace/out/a.svg'],
    ['the workspace root itself', 'cat C:/proj//agent-workspace'],
    ['the workspace below a single separator', 'cat C:/proj/agent-workspace'],
    ['a path below the single-separator workspace', 'cat C:/proj/agent-workspace/out/a.svg'],
  ]

  it.each(workspacePaths)('allows %s', (_label, command) => {
    expect(isShellCommandScopedToAgentWorkspace(command, WINDOWS_ROOT)).toBe(true)
  })

  it('keeps denying absolute paths outside the windows workspace', () => {
    expect(isShellCommandScopedToAgentWorkspace('type C:/Windows/win.ini', WINDOWS_ROOT)).toBe(false)
    expect(isShellCommandScopedToAgentWorkspace('type C:/proj/notes.txt', WINDOWS_ROOT)).toBe(false)
  })
})

describe('file tool path guards', () => {
  const wikiReadRows: Array<[string, boolean]> = [
    ['wiki/index.md', true],
    ['wiki/concepts/attention.md', true],
    ['wiki/../secret.md', false],
    ['../secret.md', false],
    ['purpose.md', false],
    ['raw/sources/a.md', false],
    ['wiki/.hidden.md', false],
    ['', false],
    ['C:/wiki/a.md', false],
    ['/etc/passwd', false],
    ['\\0', false],
  ]

  const wikiWriteRows: Array<[string, boolean]> = [
    ['wiki/page.md', true],
    ['wiki/queries/new-page.md', true],
    ['wiki/page.txt', false],
    ['src/page.md', false],
    ['wiki/.hidden.md', false],
    ['wiki/../page.md', false],
    ['wiki/CON.md', false],
    ['wiki/page.', false],
    ['wiki/page ', false],
    ['wiki/a<b.md', false],
    ['wiki/a//b.md', false],
    ['wiki/a\u0000b.md', false],
    ['', false],
  ]

  const workspaceWriteRows: Array<[string, boolean]> = [
    ['cover-image/cover.svg', true],
    ['out/a.html', true],
    ['wiki/a.md', false],
    ['raw/a.md', false],
    ['.hidden/a.md', false],
    ['../a.md', false],
    ['C:/a.md', false],
    ['a/NUL.txt', false],
    ['', false],
  ]

  const skillRows: Array<[string, boolean]> = [
    ['references/types.md', true],
    ['SKILL.md', true],
    ['../SKILL.md', false],
    ['/etc/passwd', false],
    ['C:/x.md', false],
    ['', false],
  ]

  it.each(wikiReadRows)('wiki.read_page(%j) accepted: %s', (path, accepted) => {
    expect(Result.isSuccess(guardWikiReadPath(path))).toBe(accepted)
  })

  it.each(wikiWriteRows)('wiki.write_page(%j) accepted: %s', (path, accepted) => {
    expect(Result.isSuccess(guardWikiWritePath(path))).toBe(accepted)
  })

  it.each(workspaceWriteRows)('workspace.write_file(%j) accepted: %s', (path, accepted) => {
    expect(Result.isSuccess(guardWorkspaceWritePath(path))).toBe(accepted)
  })

  it.each(skillRows)('skill.read_file(%j) accepted: %s', (path, accepted) => {
    expect(Result.isSuccess(guardSkillReadPath(path))).toBe(accepted)
  })

  it('names the tool in workspace write rejections', () => {
    const appended = guardWorkspaceWritePath('wiki/a.md', 'workspace.append_file')
    expect(Result.isFailure(appended) && appended.failure.message).toContain('workspace.append_file')
  })

  it('guards only the file tools', () => {
    expect(filePathGuard('wiki.read_page')).toBeDefined()
    expect(filePathGuard('workspace.append_file')).toBeDefined()
    expect(filePathGuard('skill.read_file')).toBeDefined()
    expect(filePathGuard('wiki.search')).toBeUndefined()
    expect(filePathGuard('shell.exec')).toBeUndefined()
  })

  const RESERVED_STEMS = [
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9',
  ]

  it.each(RESERVED_STEMS)('rejects the windows device name %s in both write guards', (stem) => {
    const wiki = guardWikiWritePath(`wiki/${stem.toLowerCase()}.md`)
    const workspace = guardWorkspaceWritePath(`out/${stem}.txt`)
    expect(Result.isFailure(wiki) && wiki.failure.message).toBe(
      'wiki.write_page path uses a Windows reserved device name',
    )
    expect(Result.isFailure(workspace) && workspace.failure.message).toBe(
      'workspace.write_file path uses a Windows reserved device name',
    )
  })

  it('matches reserved stems after trailing spaces but not after interior spaces', () => {
    const spaced = guardWikiWritePath('wiki/con  .md')
    expect(Result.isFailure(spaced) && spaced.failure.message).toBe(
      'wiki.write_page path uses a Windows reserved device name',
    )
    expect(Result.isSuccess(guardWikiWritePath('wiki/co n.md'))).toBe(true)
  })

  it('names the read rejection reason for every non-public or non-wiki path', () => {
    const message = 'wiki.read_page path must stay under wiki/'
    for (
      const path of [
        '',
        'purpose.md',
        'raw/sources/a.md',
        'wiki/../secret.md',
        'wiki/.hidden.md',
        'C:/wiki/a.md',
        '/etc/passwd',
      ]
    ) {
      const outcome = guardWikiReadPath(path)
      expect(Result.isFailure(outcome) && outcome.failure.message).toBe(message)
    }
  })

  it('names the branch and the tool in every wiki write rejection', () => {
    const cases: Array<[string, string]> = [
      ['wiki/page.txt', 'wiki.write_page path must be a Markdown file under wiki/'],
      ['raw/page.md', 'wiki.write_page path must be a Markdown file under wiki/'],
      ['wiki/.hidden/page.md', 'wiki.write_page cannot write hidden paths'],
      ['wiki/a\u0000.md', 'wiki.write_page path must stay inside the project'],
      ['wiki//page.md', 'wiki.write_page path contains an empty segment'],
      [
        'wiki/page /x.md',
        'wiki.write_page path contains a segment ending with a space or dot, which is not portable to Windows',
      ],
      [
        'wiki/page?x.md',
        'wiki.write_page path contains characters that are invalid on Windows',
      ],
      [
        'wiki/\u001fpage.md',
        'wiki.write_page path contains characters that are invalid on Windows',
      ],
      ['wiki/con.md', 'wiki.write_page path uses a Windows reserved device name'],
    ]
    for (const [path, message] of cases) {
      const outcome = guardWikiWritePath(path)
      expect(Result.isFailure(outcome) && outcome.failure.message).toBe(message)
    }
  })

  it('names the branch and the tool in every workspace write rejection', () => {
    const cases: Array<[string, string]> = [
      ['', 'workspace.write_file path must be a relative file under agent-workspace'],
      ['wiki/a.md', 'workspace.write_file path must be a relative file under agent-workspace'],
      ['raw/a.md', 'workspace.write_file path must be a relative file under agent-workspace'],
      ['.hidden/a.md', 'workspace.write_file path must be a relative file under agent-workspace'],
      ['a\u0000b.txt', 'workspace.write_file path must stay inside agent-workspace'],
      ['out//a.txt', 'workspace.write_file path contains an empty segment'],
      [
        'out/name /a.txt',
        'workspace.write_file path contains a segment ending with a space or dot, which is not portable to Windows',
      ],
      [
        'out/a<b.txt',
        'workspace.write_file path contains characters that are invalid on Windows',
      ],
      ['out/PRN.txt', 'workspace.write_file path uses a Windows reserved device name'],
    ]
    for (const [path, message] of cases) {
      const outcome = guardWorkspaceWritePath(path)
      expect(Result.isFailure(outcome) && outcome.failure.message).toBe(message)
    }

    const marker = guardWorkspaceWritePath('Stryker was here!')
    expect(Result.isSuccess(marker) && marker.success).toBe('Stryker was here!')
  })

  it('names the single skill read rejection reason', () => {
    const message = 'skill.read_file path must be a safe relative path inside the skill directory'
    for (const path of ['', '   ', '/etc/passwd', '../SKILL.md', 'a/../../b.md', '\\']) {
      const outcome = guardSkillReadPath(path)
      expect(Result.isFailure(outcome) && outcome.failure.message).toBe(message)
    }

    const trimmed = guardSkillReadPath('  references/types.md  ')
    expect(Result.isSuccess(trimmed) && trimmed.success).toBe('references/types.md')

    for (const path of ['SKILL.md', 'references/types.md', 'Stryker was here!']) {
      const outcome = guardSkillReadPath(path)
      expect(Result.isSuccess(outcome) && outcome.success).toBe(path)
    }
  })

  it('labels workspace.append_file rejections from the tool table', () => {
    const outcome = filePathGuard('workspace.append_file')?.('wiki/a.md')
    expect(outcome !== undefined && Result.isFailure(outcome) && outcome.failure.message).toBe(
      'workspace.append_file path must be a relative file under agent-workspace',
    )
  })

  it('normalizes separators, leading slashes, and surrounding whitespace before guarding', () => {
    const backs = guardWikiReadPath('  \\wiki\\concepts\\attention.md  ')
    expect(Result.isSuccess(backs) && backs.success).toBe('wiki/concepts/attention.md')

    const slashes = guardWikiReadPath('//wiki/index.md')
    expect(Result.isSuccess(slashes) && slashes.success).toBe('wiki/index.md')
  })

  const PATH_PARTS = [
    '..',
    '.',
    'wiki',
    'raw',
    'sources',
    'out',
    'a.md',
    'a.svg',
    'C:',
    '/etc',
    '\0',
    '..\\',
    '',
    'con',
    'x<y',
    'a.',
    'b ',
  ]

  const generatedPaths = () =>
    array(constantFrom(...PATH_PARTS), { minLength: 0, maxLength: 6 }).map((parts) => parts.join('/'))

  const FILE_TOOLS = [
    'wiki.read_page',
    'wiki.write_page',
    'workspace.write_file',
    'workspace.append_file',
    'skill.read_file',
  ]

  it('never accepts a path that escapes the tool root (property)', () => {
    assert(
      property(generatedPaths(), (path) => {
        for (const tool of FILE_TOOLS) {
          const guard = filePathGuard(tool)
          if (guard === undefined) return false
          const outcome = guard(path)
          if (Result.isFailure(outcome)) continue
          const accepted = outcome.success
          if (accepted.includes('\0')) return false
          if (accepted.split('/').includes('..')) return false
          if (tool.startsWith('wiki.') && !accepted.toLowerCase().startsWith('wiki/')) return false
          if (tool.startsWith('workspace.') && accepted.toLowerCase().startsWith('wiki/')) {
            return false
          }
        }
        return true
      }),
      { numRuns: 200 },
    )
  })

  it('guards exactly what the registry enforces (property)', async () => {
    const stub = recorder()
    const registry = registryOf({ executors: { 'wiki.read_page': stub.executor } })
    const nonBlankPaths = array(
      constantFrom(...PATH_PARTS.filter((part) => part !== '')),
      { minLength: 1, maxLength: 6 },
    ).map((parts) => parts.join('/'))
    await assert(
      asyncProperty(nonBlankPaths, async (path) => {
        const guarded = guardWikiReadPath(path)
        const outcome = await execute(registry, call('wiki.read_page', { path }))
        return Result.isFailure(outcome)
          ? outcome.failure._tag === 'PathViolation' && Result.isFailure(guarded)
          : Result.isSuccess(guarded)
      }),
      { numRuns: 100 },
    )
  })
})

describe('tool execution', () => {
  it('rejects an unknown tool before any executor runs', async () => {
    const stub = recorder()
    const registry = registryOf({ executors: { 'wiki.search': stub.executor } })
    const outcome = await execute(registry, call('wiki.search.v2', { query: 'x' }))
    expect(failureName(outcome)).toBe('InvalidRequest')
    expect(Result.isFailure(outcome) && outcome.failure.message).toContain('wiki.search.v2')
    expect(stub.calls).toHaveLength(0)
  })

  it('fails closed when no executor is registered', async () => {
    const outcome = await execute(registryOf({}), call('wiki.search', { query: 'x' }))
    expect(failureName(outcome)).toBe('AgentError')
    expect(Result.isFailure(outcome) && outcome.failure.message).toContain('wiki.search')
  })

  it('hands each executor exactly the call it was given, once', async () => {
    const stub = recorder({ references: [] })
    const searchCall = call('wiki.search', { query: 'attention', topK: 5 })
    const shellCall = call('shell.exec', { command: 'python3 gen.py' })
    const search = await execute(
      registryOf({ executors: { 'wiki.search': stub.executor } }),
      searchCall,
    )
    const shell = await execute(
      registryOf({
        approver: allowShellCommands(['python3 gen.py']),
        executors: { 'shell.exec': stub.executor },
      }),
      shellCall,
    )
    expect(Result.isFailure(search)).toBe(false)
    expect(Result.isFailure(shell)).toBe(false)
    expect(stub.calls[0]).toBe(searchCall)
    expect(stub.calls[1]).toBe(shellCall)
    expect(stub.calls).toHaveLength(2)
  })

  it('rejects an escaping file path before the executor runs', async () => {
    const stub = recorder()
    const registry = registryOf({
      executors: {
        'wiki.read_page': stub.executor,
        'wiki.write_page': stub.executor,
        'workspace.write_file': stub.executor,
      },
    })
    const requests: Array<ToolCall> = [
      call('wiki.read_page', { path: '../app-state.json' }),
      call('wiki.write_page', { path: 'raw/secret.md', content: 'x' }),
      call('workspace.write_file', { path: '../escape.txt', content: 'x' }),
    ]
    for (const request of requests) {
      const outcome = await execute(registry, request)
      expect(failureName(outcome)).toBe('PathViolation')
    }
    expect(stub.calls).toHaveLength(0)
  })

  it('requires a path for every guarded file tool', async () => {
    const stub = recorder()
    const registry = registryOf({
      executors: { 'wiki.read_page': stub.executor, 'skill.read_file': stub.executor },
    })
    const missing = await execute(registry, call('wiki.read_page', {}))
    const blank = await execute(registry, call('skill.read_file', { path: '  ' }))
    const present = await execute(
      registry,
      call('skill.read_file', { path: 'references/types.md', skill: 'demo' }),
    )
    expect(failureName(missing)).toBe('InvalidRequest')
    expect(failureName(blank)).toBe('InvalidRequest')
    expect(failureName(present)).toBe('success')
    expect(stub.calls).toHaveLength(1)
  })

  it('surfaces executor failures unchanged', async () => {
    const registry = registryOf({
      executors: {
        'wiki.read_page': () => Effect.fail(new Errors.TooLarge({ message: 'page is too large' })),
        'anytxt.search': () => Effect.fail(new Errors.InvalidRequest({ message: 'bad query' })),
      },
    })
    const tooLarge = await execute(registry, call('wiki.read_page', { path: 'wiki/index.md' }))
    const invalid = await execute(registry, call('anytxt.search', { query: 'x' }))
    expect(failureName(tooLarge)).toBe('TooLarge')
    expect(failureName(invalid)).toBe('InvalidRequest')
  })
})
