import { apiServerSocketPath, apiServerStatus, mcpServerEntryPath } from '@/commands/fs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiRelayClient } from '@/lib/api-relay'
import {
  API_RPC_STREAM_URL,
  API_RPC_URL,
  API_SERVER_BASE_URL,
  API_SERVER_REMOTE_BASE_URL,
} from '@/lib/api-server-constants'
import { generateApiToken } from '@/lib/api-token'
import { useWikiStore } from '@/stores/wiki-store'
import { Domain } from 'llm-wiki-protocol'
import { Copy, Eye, EyeOff, RefreshCw, Server, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DraftSetter, SettingsDraft } from '../settings-types'

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export const WORKER_STATUSES = ['starting', 'running', 'restarting', 'failed', 'missing-runtime'] as const

export type WorkerStatus = (typeof WORKER_STATUSES)[number] | 'unknown'

const WORKER_STATUS_LOOKUP: Record<string, true> = {
  starting: true,
  running: true,
  restarting: true,
  failed: true,
  'missing-runtime': true,
}

export const normalizeWorkerStatus = (raw: string): WorkerStatus =>
  WORKER_STATUS_LOOKUP[raw] === true ? (raw as WorkerStatus) : 'unknown'

const rpcFrame = (op: string, payload: unknown): string =>
  JSON.stringify({ _tag: 'Request', id: '1', tag: op, payload, headers: [] })

export interface RpcCurlInput {
  readonly url: string
  readonly op: string
  readonly payload: unknown
  readonly token: string | null
}

export const buildRpcCurl = (input: RpcCurlInput): string => {
  const lines = ['curl -X POST']
  if (input.token !== null && input.token !== '') {
    lines.push(`  -H "Authorization: Bearer ${input.token}"`)
  }
  lines.push(`  -H 'Content-Type: application/ndjson'`)
  lines.push(`  ${input.url}`)
  lines.push(`  --data-binary $'${rpcFrame(input.op, input.payload)}\\n'`)
  return lines.join(' \\\n')
}

export interface StreamSampleInput {
  readonly url: string
  readonly token: string | null
  readonly payload: Record<string, unknown>
}

export const buildStreamSample = (input: StreamSampleInput): string => {
  const target = input.token === null || input.token === ''
    ? `websocat ${input.url}`
    : `websocat -H "Authorization: Bearer ${input.token}" ${input.url}`
  return `echo '${rpcFrame('chatStream', input.payload)}' \\\n  | ${target}`
}

export const MCP_SOCKET_PATH_PLACEHOLDER = '<socket path>'

export interface McpConfigInput {
  readonly mode: 'local' | 'remote'
  readonly entryPath: string
  readonly socketPath: string
  readonly baseUrl: string
  readonly token: string
}

export const buildMcpConfig = (input: McpConfigInput): string => {
  const env = input.mode === 'local'
    ? { LLM_WIKI_SOCKET_PATH: input.socketPath || MCP_SOCKET_PATH_PLACEHOLDER }
    : { LLM_WIKI_API_TOKEN: input.token, LLM_WIKI_BASE_URL: input.baseUrl }
  return JSON.stringify(
    {
      mcpServers: {
        'llm-wiki': {
          command: 'node',
          args: [input.entryPath],
          env,
        },
      },
    },
    null,
    2,
  )
}

export function ApiServerSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const [showToken, setShowToken] = useState(false)
  const [copiedField, setCopiedField] = useState<'token' | 'curl' | 'chat' | 'mcp' | null>(null)
  const [serverStatus, setServerStatus] = useState<WorkerStatus>('unknown')
  const [health, setHealth] = useState<Domain.Health | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [socketPath, setSocketPath] = useState('')
  const [mcpEntryPath, setMcpEntryPath] = useState<string | null>(null)
  const [mcpPathError, setMcpPathError] = useState<string | null>(null)
  const persistedApiConfig = useWikiStore((s) => s.apiConfig)

  useEffect(() => {
    let alive = true
    const loadStatus = async () => {
      try {
        const status = await apiServerStatus()
        if (alive) setServerStatus(normalizeWorkerStatus(status))
      } catch {
        if (alive) setServerStatus('unknown')
      }
    }
    const loadHealth = async () => {
      try {
        const snapshot = await apiRelayClient.health()
        if (!alive) return
        setHealth(snapshot)
        setHealthError(null)
      } catch (err) {
        if (!alive) return
        setHealth(null)
        setHealthError(err instanceof Error ? err.message : String(err))
      }
    }
    const loadSocketPath = async () => {
      try {
        const path = await apiServerSocketPath()
        if (alive) setSocketPath(path)
      } catch {
        if (alive) setSocketPath('')
      }
    }
    const loadMcpPath = async () => {
      try {
        const path = await mcpServerEntryPath()
        if (!alive) return
        setMcpEntryPath(path)
        setMcpPathError(null)
      } catch (err) {
        if (!alive) return
        setMcpEntryPath(null)
        setMcpPathError(err instanceof Error ? err.message : String(err))
      }
    }
    void loadStatus()
    void loadHealth()
    void loadSocketPath()
    void loadMcpPath()
    return () => {
      alive = false
    }
  }, [])

  const handleGenerate = useCallback(() => {
    setDraft('apiToken', generateApiToken())
    setShowToken(true)
  }, [setDraft])

  const handleCopyToken = useCallback(async () => {
    if (!draft.apiToken) return
    try {
      await navigator.clipboard.writeText(draft.apiToken)
      setCopiedField('token')
      setTimeout(() => setCopiedField(null), 1500)
    } catch (err) {
      console.error('[api-settings] copy token failed:', err)
    }
  }, [draft.apiToken])

  const sampleCurl = useMemo(
    () =>
      buildRpcCurl({
        url: API_RPC_URL,
        op: 'projects',
        payload: null,
        token: draft.apiAllowUnauthenticated ? null : draft.apiToken || '<your-token>',
      }),
    [draft.apiAllowUnauthenticated, draft.apiToken],
  )

  const sampleChatCurl = useMemo(() => {
    const tokenForExample = health?.tokenSource === 'env'
      ? '$LLM_WIKI_API_TOKEN'
      : draft.apiToken || '<your-token>'
    const payload = { message: 'Summarize this knowledge base.' }
    return [
      '# One aggregate agent turn (single JSON response)',
      buildRpcCurl({ url: API_RPC_URL, op: 'chat', payload, token: tokenForExample }),
      '',
      '# The same turn, streamed as ndjson frames over WebSocket',
      buildStreamSample({ url: API_RPC_STREAM_URL, token: tokenForExample, payload }),
    ].join('\n')
  }, [draft.apiToken, health?.tokenSource])

  const sampleMcpConfig = useMemo(() => {
    if (!mcpEntryPath) return ''
    return buildMcpConfig({
      mode: draft.apiAllowLanAccess ? 'remote' : 'local',
      entryPath: mcpEntryPath,
      socketPath,
      baseUrl: API_SERVER_REMOTE_BASE_URL,
      token: health?.tokenSource === 'env'
        ? '<same value as the LLM Wiki process environment>'
        : draft.apiToken || '<your-token>',
    })
  }, [draft.apiAllowLanAccess, draft.apiToken, health?.tokenSource, mcpEntryPath, socketPath])

  const hasUnsavedApiConfig = persistedApiConfig.enabled !== draft.apiEnabled ||
    persistedApiConfig.allowUnauthenticated !== draft.apiAllowUnauthenticated ||
    persistedApiConfig.allowLanAccess !== draft.apiAllowLanAccess ||
    persistedApiConfig.mcpEnabled !== draft.apiMcpEnabled ||
    persistedApiConfig.token !== draft.apiToken.trim()

  const handleCopyCurl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sampleCurl)
      setCopiedField('curl')
      setTimeout(() => setCopiedField(null), 1500)
    } catch (err) {
      console.error('[api-settings] copy curl failed:', err)
    }
  }, [sampleCurl])

  const handleCopyChatCurl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sampleChatCurl)
      setCopiedField('chat')
      setTimeout(() => setCopiedField(null), 1500)
    } catch (err) {
      console.error('[api-settings] copy streaming chat curl failed:', err)
    }
  }, [sampleChatCurl])

  const handleCopyMcpConfig = useCallback(async () => {
    if (!mcpEntryPath) return
    try {
      await navigator.clipboard.writeText(sampleMcpConfig)
      setCopiedField('mcp')
      setTimeout(() => setCopiedField(null), 1500)
    } catch (err) {
      console.error('[api-settings] copy MCP config failed:', err)
    }
  }, [mcpEntryPath, sampleMcpConfig])

  const statusLabel = useMemo(() => {
    if (!draft.apiEnabled) {
      return t('settings.sections.apiServer.statusDisabled', { defaultValue: 'Disabled' })
    }
    if (health?.allowUnauthenticated || draft.apiAllowUnauthenticated) {
      return t('settings.sections.apiServer.statusOpen', { defaultValue: 'Running, no auth' })
    }
    if (serverStatus === 'running' && health?.authConfigured === false && !draft.apiToken) {
      return t('settings.sections.apiServer.statusNoToken', { defaultValue: 'Running, no token' })
    }
    switch (serverStatus) {
      case 'running':
        return t('settings.sections.apiServer.statusRunning', { defaultValue: 'Running' })
      case 'starting':
        return t('settings.sections.apiServer.statusStarting', { defaultValue: 'Starting…' })
      case 'restarting':
        return t('settings.sections.apiServer.statusRestarting', { defaultValue: 'Restarting…' })
      case 'failed':
        return t('settings.sections.apiServer.statusFailed', { defaultValue: 'Failed' })
      case 'missing-runtime':
        return t('settings.sections.apiServer.statusMissingRuntime', {
          defaultValue: 'Node runtime missing',
        })
      default:
        return t('settings.sections.apiServer.statusUnknown', { defaultValue: 'Unknown' })
    }
  }, [draft.apiAllowUnauthenticated, draft.apiEnabled, draft.apiToken, health, serverStatus, t])

  const statusToneClass = !draft.apiEnabled
    ? 'text-muted-foreground'
    : (health?.allowUnauthenticated || draft.apiAllowUnauthenticated)
    ? 'text-amber-700 dark:text-amber-400'
    : serverStatus === 'running'
    ? 'text-emerald-600 dark:text-emerald-400'
    : serverStatus === 'starting' || serverStatus === 'restarting' || serverStatus === 'unknown'
    ? 'text-muted-foreground'
    : 'text-destructive'

  const tokenStrength: 'unused' | 'missing' | 'weak' | 'ok' = draft.apiAllowUnauthenticated
    ? 'unused'
    : !draft.apiToken
    ? 'missing'
    : draft.apiToken.length < 16
    ? 'weak'
    : 'ok'

  return (
    <div className='space-y-6'>
      <div>
        <h2 className='text-xl font-semibold'>
          {t('settings.sections.apiServer.title', { defaultValue: 'API + MCP' })}
        </h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          {t('settings.sections.apiServer.description', {
            defaultValue:
              'Expose LLM Wiki to your own tools through the local RPC server, and optionally through the bundled MCP server for agent clients.',
          })}
        </p>
      </div>

      {/* ── Enable + status ───────────────────────────────────────── */}
      <div className='space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4'>
        <label
          htmlFor='api-server-enabled'
          aria-label={t('settings.sections.apiServer.enable', { defaultValue: 'Enable the local API' })}
          className='flex items-start gap-3'
        >
          <input
            id='api-server-enabled'
            type='checkbox'
            checked={draft.apiEnabled}
            onChange={(event) => setDraft('apiEnabled', event.target.checked)}
            className='mt-1 h-4 w-4'
          />
          <div className='space-y-1'>
            <div className='flex items-center gap-2 text-sm font-semibold'>
              <Server className='h-4 w-4 text-muted-foreground' />
              {t('settings.sections.apiServer.enable', {
                defaultValue: 'Enable the local API',
              })}
            </div>
            <p className='text-xs leading-relaxed text-muted-foreground'>
              {t('settings.sections.apiServer.enableHint', {
                defaultValue:
                  'Disable to make every operation except health fail, even if a token is configured. Useful as a kill-switch without unsetting the token.',
              })}
            </p>
          </div>
        </label>

        <label
          htmlFor='api-server-allow-unauthenticated'
          aria-label={t('settings.sections.apiServer.allowUnauthenticated', {
            defaultValue: 'Allow access without a token',
          })}
          className='flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/30'
        >
          <input
            id='api-server-allow-unauthenticated'
            type='checkbox'
            checked={draft.apiAllowUnauthenticated}
            onChange={(event) => setDraft('apiAllowUnauthenticated', event.target.checked)}
            className='mt-1 h-4 w-4'
          />
          <div className='space-y-1'>
            <div className='text-sm font-semibold text-amber-900 dark:text-amber-200'>
              {t('settings.sections.apiServer.allowUnauthenticated', {
                defaultValue: 'Allow access without a token',
              })}
            </div>
            <p className='text-xs leading-relaxed text-amber-900 dark:text-amber-200'>
              {t('settings.sections.apiServer.allowUnauthenticatedHint', {
                defaultValue:
                  'Use only for trusted local agents. Any process or browser page on this machine can call the API while this is enabled.',
              })}
            </p>
          </div>
        </label>

        <label
          htmlFor='api-server-allow-lan-access'
          aria-label={t('settings.sections.apiServer.allowLanAccess', {
            defaultValue: 'Allow API and Clip server access from the local network',
          })}
          className='flex items-start gap-3 rounded-md border border-border/60 bg-background/40 px-3 py-2'
        >
          <input
            id='api-server-allow-lan-access'
            type='checkbox'
            checked={draft.apiAllowLanAccess}
            onChange={(event) => setDraft('apiAllowLanAccess', event.target.checked)}
            className='mt-1 h-4 w-4'
          />
          <div className='space-y-1'>
            <div className='text-sm font-semibold'>
              {t('settings.sections.apiServer.allowLanAccess', {
                defaultValue: 'Allow API and Clip server access from the local network',
              })}
            </div>
            <p className='text-xs leading-relaxed text-muted-foreground'>
              {t('settings.sections.apiServer.allowLanAccessHint', {
                defaultValue:
                  'After restarting the app, the API and Clip server listen on 0.0.0.0 instead of 127.0.0.1. Use only on trusted networks, and keep token auth enabled unless you fully trust the LAN.',
              })}
            </p>
          </div>
        </label>

        <div className='grid grid-cols-1 gap-3 rounded-md border border-border/60 bg-background/40 p-3 text-sm sm:grid-cols-2'>
          <div className='space-y-0.5'>
            <div className='text-[11px] uppercase tracking-wide text-muted-foreground'>
              {t('settings.sections.apiServer.status', { defaultValue: 'Status' })}
            </div>
            <div className={`font-mono text-xs ${statusToneClass}`}>{statusLabel}</div>
          </div>
          <div className='space-y-0.5'>
            <div className='text-[11px] uppercase tracking-wide text-muted-foreground'>
              {t('settings.sections.apiServer.baseUrl', { defaultValue: 'Base URL' })}
            </div>
            <div className='font-mono text-xs'>{API_SERVER_BASE_URL}</div>
          </div>
        </div>

        {healthError && <p className='text-[11px] leading-relaxed text-amber-700 dark:text-amber-400'>{healthError}</p>}
      </div>

      {/* ── Token ─────────────────────────────────────────────────── */}
      <div className='space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4'>
        <div>
          <h3 className='text-sm font-semibold'>
            {t('settings.sections.apiServer.token', { defaultValue: 'Access token' })}
          </h3>
          <p className='mt-1 text-xs leading-relaxed text-muted-foreground'>
            {t('settings.sections.apiServer.tokenHint', {
              defaultValue:
                'Send as `Authorization: Bearer <token>` or `X-LLM-Wiki-Token: <token>`. Read operations may omit it when unauthenticated access is enabled, but Agent chat and cancellation always require it. The environment variable LLM_WIKI_API_TOKEN overrides this field if set.',
            })}
          </p>
        </div>

        <Label htmlFor='api-token-input' className='sr-only'>
          {t('settings.sections.apiServer.token', { defaultValue: 'Access token' })}
        </Label>
        <div className='flex gap-2'>
          <Input
            id='api-token-input'
            type={showToken ? 'text' : 'password'}
            value={draft.apiToken}
            onChange={(event) => setDraft('apiToken', event.target.value)}
            placeholder={t('settings.sections.apiServer.tokenPlaceholder', {
              defaultValue: 'Paste an existing token or click Generate',
            })}
            className='font-mono'
            autoComplete='off'
            spellCheck={false}
          />
          <Button
            type='button'
            variant='outline'
            size='icon'
            onClick={() => setShowToken((value) => !value)}
            title={showToken
              ? t('settings.sections.apiServer.hide', { defaultValue: 'Hide' })
              : t('settings.sections.apiServer.show', { defaultValue: 'Show' })}
            aria-label={showToken
              ? t('settings.sections.apiServer.hide', { defaultValue: 'Hide' })
              : t('settings.sections.apiServer.show', { defaultValue: 'Show' })}
          >
            {showToken ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
          </Button>
          <Button
            type='button'
            variant='outline'
            size='icon'
            onClick={handleCopyToken}
            disabled={!draft.apiToken}
            title={t('settings.sections.apiServer.copy', { defaultValue: 'Copy' })}
            aria-label={t('settings.sections.apiServer.copy', { defaultValue: 'Copy' })}
          >
            <Copy className='h-4 w-4' />
          </Button>
        </div>

        <div className='flex items-center gap-2'>
          <Button type='button' variant='outline' size='sm' onClick={handleGenerate} className='gap-1.5'>
            <RefreshCw className='h-3.5 w-3.5' />
            {t('settings.sections.apiServer.generate', { defaultValue: 'Generate new token' })}
          </Button>
          {copiedField === 'token' && (
            <span className='text-xs text-emerald-600 dark:text-emerald-400'>
              {t('settings.sections.apiServer.copied', { defaultValue: 'Copied' })}
            </span>
          )}
          {tokenStrength === 'missing' && (
            <span className='text-xs text-amber-700 dark:text-amber-400'>
              {t('settings.sections.apiServer.tokenMissing', {
                defaultValue: 'No token — Agent chat is unavailable and protected operations are unauthorized',
              })}
            </span>
          )}
          {tokenStrength === 'unused' && health?.tokenSource !== 'env' && (
            <span className='text-xs text-amber-700 dark:text-amber-400'>
              {t('settings.sections.apiServer.tokenUnused', {
                defaultValue: 'Read operations are open, but Agent chat still uses this token',
              })}
            </span>
          )}
          {health?.tokenSource === 'env' && (
            <span className='text-xs text-amber-700 dark:text-amber-400'>
              {t('settings.sections.apiServer.envTokenActive', {
                defaultValue: 'LLM_WIKI_API_TOKEN is active and overrides this field',
              })}
            </span>
          )}
          {hasUnsavedApiConfig && (
            <span className='text-xs text-muted-foreground'>
              {t('settings.sections.apiServer.saveFirst', {
                defaultValue: 'Save settings to apply API changes',
              })}
            </span>
          )}
          {tokenStrength === 'weak' && (
            <span className='text-xs text-amber-700 dark:text-amber-400'>
              {t('settings.sections.apiServer.tokenWeak', {
                defaultValue: 'Token is short — consider Generate for 256-bit entropy',
              })}
            </span>
          )}
        </div>

        <div className='flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200'>
          <ShieldAlert className='mt-0.5 h-3.5 w-3.5 shrink-0' />
          <div className='space-y-1'>
            <div>
              {t('settings.sections.apiServer.tokenWarning', {
                defaultValue:
                  'Keep this token secret. Anyone with the token on this machine can read your project files via localhost.',
              })}
            </div>
            <div>
              {t('settings.sections.apiServer.tokenQueryWarning', {
                defaultValue:
                  'Prefer the Authorization header — passing ?token=… via URL leaks the value into shell history, logs, and Referer headers.',
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── Sample curl ───────────────────────────────────────────── */}
      <div className='space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4'>
        <div className='flex items-center justify-between gap-2'>
          <h3 className='text-sm font-semibold'>
            {t('settings.sections.apiServer.sample', { defaultValue: 'Example request' })}
          </h3>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={handleCopyCurl}
            disabled={hasUnsavedApiConfig}
            className='gap-1.5'
          >
            <Copy className='h-3.5 w-3.5' />
            {copiedField === 'curl'
              ? t('settings.sections.apiServer.copied', { defaultValue: 'Copied' })
              : t('settings.sections.apiServer.copy', { defaultValue: 'Copy' })}
          </Button>
        </div>
        <pre className='overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-background/60 px-3 py-2 text-[11px] font-mono leading-relaxed'>
          {hasUnsavedApiConfig
            ? t("settings.sections.apiServer.saveFirstExample", {
                defaultValue: "Save settings first, then copy an example request.",
              })
            : sampleCurl}
        </pre>
      </div>

      {/* ── Agent chat and streaming ──────────────────────────────── */}
      <div className='space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4'>
        <div className='flex items-start justify-between gap-3'>
          <div>
            <h3 className='text-sm font-semibold'>
              {t('settings.sections.apiServer.chatTitle', { defaultValue: 'Agent chat and streaming' })}
            </h3>
            <p className='mt-1 text-xs leading-relaxed text-muted-foreground'>
              {t('settings.sections.apiServer.chatHint', {
                defaultValue:
                  'The aggregate chat operation returns one JSON document after the Agent turn completes. chatStream emits ndjson frames over the WebSocket transport while the Agent works.',
              })}
            </p>
          </div>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={handleCopyChatCurl}
            disabled={hasUnsavedApiConfig}
            className='shrink-0 gap-1.5'
          >
            <Copy className='h-3.5 w-3.5' />
            {copiedField === 'chat'
              ? t('settings.sections.apiServer.copied', { defaultValue: 'Copied' })
              : t('settings.sections.apiServer.copy', { defaultValue: 'Copy' })}
          </Button>
        </div>
        <div className='grid gap-2 text-xs sm:grid-cols-2'>
          <div className='rounded-md border border-border/60 bg-background/40 px-3 py-2'>
            <div className='font-medium'>
              {t('settings.sections.apiServer.chatJsonTitle', { defaultValue: 'JSON mode' })}
            </div>
            <p className='mt-1 leading-relaxed text-muted-foreground'>
              {t('settings.sections.apiServer.chatJsonHint', {
                defaultValue: 'The request returns after the complete Agent turn.',
              })}
            </p>
          </div>
          <div className='rounded-md border border-border/60 bg-background/40 px-3 py-2'>
            <div className='font-medium'>
              {t('settings.sections.apiServer.chatStreamTitle', { defaultValue: 'Streaming (WebSocket)' })}
            </div>
            <p className='mt-1 leading-relaxed text-muted-foreground'>
              {t('settings.sections.apiServer.chatStreamHint', {
                defaultValue:
                  'Frames: meta, incremental agent events, then done. done carries the complete aggregate response.',
              })}
            </p>
          </div>
        </div>
        <div className='flex items-start gap-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400'>
          <ShieldAlert className='mt-0.5 h-3.5 w-3.5 shrink-0' />
          <span>
            {t('settings.sections.apiServer.chatTokenRequired', {
              defaultValue:
                'Agent chat and cancellation always require a token, even when read operations allow unauthenticated access.',
            })}
          </span>
        </div>
        <pre className='overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-background/60 px-3 py-2 text-[11px] font-mono leading-relaxed'>
          {hasUnsavedApiConfig
            ? t("settings.sections.apiServer.saveFirstExample", { defaultValue: "Save settings first, then copy an example request." })
            : sampleChatCurl}
        </pre>
      </div>

      {/* ── MCP ──────────────────────────────────────────────────── */}
      <div className='space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4'>
        <label
          htmlFor='api-server-mcp-enabled'
          aria-label={t('settings.sections.apiServer.mcpEnable', { defaultValue: 'Enable MCP access' })}
          className='flex items-start gap-3'
        >
          <input
            id='api-server-mcp-enabled'
            type='checkbox'
            checked={draft.apiMcpEnabled}
            onChange={(event) => setDraft('apiMcpEnabled', event.target.checked)}
            className='mt-1 h-4 w-4'
          />
          <div className='space-y-1'>
            <div className='text-sm font-semibold'>
              {t('settings.sections.apiServer.mcpEnable', {
                defaultValue: 'Enable MCP access',
              })}
            </div>
            <p className='text-xs leading-relaxed text-muted-foreground'>
              {t('settings.sections.apiServer.mcpEnableHint', {
                defaultValue:
                  'MCP uses the local API and the same token rules. Keep the HTTP API enabled, then connect an MCP client to the bundled Node server.',
              })}
            </p>
          </div>
        </label>

        <div className='rounded-md border border-border/50 bg-background/50 p-3'>
          <div className='flex items-center justify-between gap-2'>
            <h3 className='text-sm font-semibold'>
              {t('settings.sections.apiServer.mcpUsage', { defaultValue: 'MCP usage' })}
            </h3>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={handleCopyMcpConfig}
              disabled={hasUnsavedApiConfig || !draft.apiMcpEnabled || !mcpEntryPath}
              className='gap-1.5'
            >
              <Copy className='h-3.5 w-3.5' />
              {copiedField === 'mcp'
                ? t('settings.sections.apiServer.copied', { defaultValue: 'Copied' })
                : t('settings.sections.apiServer.copy', { defaultValue: 'Copy' })}
            </Button>
          </div>
          <p className='mt-2 text-xs leading-relaxed text-muted-foreground'>
            {t('settings.sections.apiServer.mcpUsageHint', {
              defaultValue:
                'Build once with `pnpm mcp:build`, then configure your MCP client to run the server below. Local mode connects over LLM_WIKI_SOCKET_PATH; remote mode needs LLM_WIKI_BASE_URL and LLM_WIKI_API_TOKEN.',
            })}
          </p>
          {mcpPathError && (
            <p className='mt-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400'>
              {mcpPathError}
            </p>
          )}
          <pre className='mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-background/60 px-3 py-2 text-[11px] font-mono leading-relaxed'>
            {hasUnsavedApiConfig
              ? t("settings.sections.apiServer.saveFirstExample", {
                  defaultValue: "Save settings first, then copy an example request.",
                })
              : !mcpEntryPath
                ? t("settings.sections.apiServer.mcpPathUnavailable", {
                    defaultValue:
                      "MCP server entry was not found. Run `pnpm mcp:build` from the LLM Wiki repository, then reopen Settings.",
                  })
              : sampleMcpConfig}
          </pre>
        </div>
      </div>
    </div>
  )
}
