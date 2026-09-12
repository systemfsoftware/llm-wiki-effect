import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAppDialogStore } from '@/stores/app-dialog-store'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

export function AppDialogHost() {
  const { t } = useTranslation()
  const current = useAppDialogStore((state) => state.current)
  const settle = useAppDialogStore((state) => state.settle)
  const confirmRef = useRef<HTMLButtonElement>(null)

  if (!current) return null

  const destructive = current.variant === 'destructive'
  return (
    <Dialog
      key={current.id}
      open
      onOpenChange={(open) => {
        if (!open) settle(current.id, false)
      }}
    >
      <DialogContent showCloseButton={false} initialFocus={confirmRef}>
        <DialogHeader>
          <DialogTitle>
            {current.title ?? t(current.kind === 'confirm' ? 'common.confirm' : 'common.notice')}
          </DialogTitle>
          <DialogDescription className='whitespace-pre-wrap break-words'>
            {current.message}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {current.kind === 'confirm' && (
            <Button variant='outline' onClick={() => settle(current.id, false)}>
              {current.cancelLabel ?? t('common.cancel')}
            </Button>
          )}
          <Button
            ref={confirmRef}
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => settle(current.id, true)}
          >
            {current.confirmLabel ?? t('common.ok')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
