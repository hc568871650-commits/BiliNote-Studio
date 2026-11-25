import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface RegenerateConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void> | void
  disabled?: boolean
  title?: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
}

export function RegenerateConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  disabled = false,
  title = '重新生成笔记？',
  description = '按原设置重新发起生成请求，可能产生模型调用费用；已有版本将保留。',
  confirmLabel = '确认重新生成',
  cancelLabel = '取消',
}: RegenerateConfirmDialogProps) {
  const [submitting, setSubmitting] = useState(false)
  const guardRef = useRef(false)

  useEffect(() => {
    if (!open) {
      guardRef.current = false
      setSubmitting(false)
    }
  }, [open])

  const handleConfirm = async () => {
    if (guardRef.current || submitting || disabled) return
    guardRef.current = true
    setSubmitting(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch {
      // Caller handles error presentation; unlock so the user can close or retry.
    } finally {
      guardRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!submitting) onOpenChange(next)
      }}
    >
      <DialogContent
        role="alertdialog"
        showCloseButton={!submitting}
        onEscapeKeyDown={event => {
          if (submitting) event.preventDefault()
        }}
        onPointerDownOutside={event => {
          if (submitting) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            disabled={submitting || disabled}
            onClick={() => void handleConfirm()}
          >
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {submitting ? '提交中…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface CancelGenerationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void> | void
  disabled?: boolean
  title?: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
}

export function CancelGenerationDialog({
  open,
  onOpenChange,
  onConfirm,
  disabled = false,
  title = '取消这次生成？',
  description = '已发出的请求可能继续计费；结束后不再发起后续请求。已有笔记版本会保留。',
  confirmLabel = '确认取消',
  cancelLabel = '继续生成',
}: CancelGenerationDialogProps) {
  const [submitting, setSubmitting] = useState(false)
  const guardRef = useRef(false)

  useEffect(() => {
    if (!open) {
      guardRef.current = false
      setSubmitting(false)
    }
  }, [open])

  const handleConfirm = async () => {
    if (guardRef.current || submitting || disabled) return
    guardRef.current = true
    setSubmitting(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch {
      // Caller handles error presentation.
    } finally {
      guardRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!submitting) onOpenChange(next)
      }}
    >
      <DialogContent
        role="alertdialog"
        showCloseButton={!submitting}
        onEscapeKeyDown={event => {
          if (submitting) event.preventDefault()
        }}
        onPointerDownOutside={event => {
          if (submitting) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={submitting || disabled}
            onClick={() => void handleConfirm()}
          >
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {submitting ? '取消中…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
