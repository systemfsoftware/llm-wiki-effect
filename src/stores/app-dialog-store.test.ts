import { beforeEach, describe, expect, it } from 'vitest'
import { useAppDialog, useAppDialogStore } from './app-dialog-store'

function currentDialogId(): number {
  const current = useAppDialogStore.getState().current
  if (!current) throw new Error('expected a current dialog')
  return current.id
}

describe('app dialog store', () => {
  beforeEach(() => {
    useAppDialogStore.setState({ current: null, queue: [] })
  })

  it('queues dialogs and resolves them in order', async () => {
    const dialogs = useAppDialog()
    const first = dialogs.confirm({ message: 'first' })
    const second = dialogs.confirm({ message: 'second' })

    expect(useAppDialogStore.getState().current?.message).toBe('first')
    expect(useAppDialogStore.getState().queue).toHaveLength(1)

    const firstId = currentDialogId()
    useAppDialogStore.getState().settle(firstId, true)
    await expect(first).resolves.toBe(true)
    expect(useAppDialogStore.getState().current?.message).toBe('second')

    useAppDialogStore.getState().settle(currentDialogId(), false)
    await expect(second).resolves.toBe(false)
    expect(useAppDialogStore.getState().current).toBeNull()
  })

  it('resolves alerts after dismissal', async () => {
    const pending = useAppDialog().alert({ message: 'notice' })
    useAppDialogStore.getState().settle(currentDialogId(), false)
    await expect(pending).resolves.toBeUndefined()
  })

  it('ignores stale events from the previous dialog', async () => {
    const dialogs = useAppDialog()
    const first = dialogs.confirm({ message: 'first' })
    const second = dialogs.confirm({ message: 'second' })
    const firstId = currentDialogId()

    useAppDialogStore.getState().settle(firstId, true)
    useAppDialogStore.getState().settle(firstId, true)

    await expect(first).resolves.toBe(true)
    expect(useAppDialogStore.getState().current?.message).toBe('second')
    expect(useAppDialogStore.getState().queue).toHaveLength(0)
    useAppDialogStore.getState().settle(currentDialogId(), false)
    await expect(second).resolves.toBe(false)
  })
})
