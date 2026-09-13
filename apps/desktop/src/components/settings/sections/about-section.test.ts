import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { type ApiServerHealth, formatApiServerRow } from './about-section'
import { WORKER_STATUSES } from './api-server-section'

const t = ((key: string) => key.split('.').pop() ?? key) as unknown as TFunction

const SOCKET = '/run/llm-wiki/api-server.sock'

interface RowOverrides {
  readonly rawStatus?: string | null
  readonly socketPath?: string
  readonly health?: ApiServerHealth | null
}

const row = (overrides: RowOverrides = {}): string =>
  formatApiServerRow(
    { rawStatus: 'running', socketPath: SOCKET, health: null, ...overrides },
    t,
  )

describe('About API-server row', () => {
  it('addresses the worker by the socket the supervisor publishes', () => {
    for (const rawStatus of WORKER_STATUSES) {
      expect(row({ rawStatus })).toBe(`${rawStatus}  @  ${SOCKET}`)
    }
  })

  it('omits the address until the worker has published its socket', () => {
    for (const rawStatus of WORKER_STATUSES) {
      expect(row({ rawStatus, socketPath: '' })).toBe(rawStatus)
      expect(row({ rawStatus, socketPath: '   ' })).toBe(rawStatus)
    }
  })

  it('never prints a TCP address, a REST port, or an /api/v1 path', () => {
    const values = [
      ...WORKER_STATUSES.map((rawStatus) => row({ rawStatus })),
      row({ rawStatus: 'port_conflict' }),
      row({ socketPath: '' }),
    ]
    for (const value of values) {
      expect(value).not.toMatch(/127\.0\.0\.1|https?:|\/api\/v1/)
    }
  })

  it('reports the retired REST-era statuses as unknown', () => {
    expect(row({ rawStatus: 'port_conflict' })).toBe(`unknown  @  ${SOCKET}`)
    expect(row({ rawStatus: 'error', socketPath: '' })).toBe('unknown')
  })

  it('shows the loading placeholder until the first status read settles', () => {
    expect(row({ rawStatus: null })).toBe('...')
  })

  it('appends the socket to the gating copy from a live health snapshot', () => {
    expect(row({ health: { enabled: false, authConfigured: true, allowUnauthenticated: false } })).toBe(
      `apiDisabled  @  ${SOCKET}`,
    )
    expect(row({ health: { enabled: true, authConfigured: true, allowUnauthenticated: true } })).toBe(
      `apiOpen  @  ${SOCKET}`,
    )
    expect(row({ health: { enabled: true, authConfigured: false, allowUnauthenticated: false } })).toBe(
      `apiNoToken  @  ${SOCKET}`,
    )
  })

  it('only overlays gating copy while the worker is running', () => {
    expect(
      row({
        rawStatus: 'failed',
        health: { enabled: false, authConfigured: false, allowUnauthenticated: true },
      }),
    ).toBe(`failed  @  ${SOCKET}`)
  })
})
