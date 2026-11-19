import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'
import { noteMenuPosition } from '@/utils/noteActions'

export interface NoteAction {
  label: string
  icon: ReactNode
  onSelect: () => void
  disabled?: boolean
  description?: string
  pressed?: boolean
  destructive?: boolean
}

export default function NoteActionsPopover({ title, open, onOpenChange, actions, deleteAction }: { title: string; open: boolean; onOpenChange: (open: boolean) => void; actions: NoteAction[]; deleteAction?: NoteAction }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const [position, setPosition] = useState({ left: 0, top: 0 })
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return
    setPosition(noteMenuPosition(trigger.current.getBoundingClientRect(), panel.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }))
    panel.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) onOpenChange(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onOpenChange(false)
      trigger.current?.focus()
    }
    const viewportChanged = (event: Event) => { if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) onOpenChange(false) }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', viewportChanged)
    window.addEventListener('scroll', viewportChanged, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', viewportChanged)
      window.removeEventListener('scroll', viewportChanged, true)
    }
  }, [open, onOpenChange])
  const actionButton = (action: NoteAction, index: number) => <button key={index} type="button" role={action.pressed == null ? 'menuitem' : 'menuitemcheckbox'} aria-checked={action.pressed} disabled={action.disabled} title={action.description} className={`flex h-8 min-w-0 items-center gap-1.5 rounded-[8px] px-2.5 text-left text-[11px] outline-none transition-colors duration-150 hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-45 ${action.destructive ? 'text-destructive' : action.pressed ? 'bg-[var(--surface-selected)] font-medium text-[var(--text-emphasis)]' : 'text-foreground'}`} onClick={() => { onOpenChange(false); trigger.current?.focus(); action.onSelect() }}><span className="shrink-0 [&_svg]:h-3.5 [&_svg]:w-3.5">{action.icon}</span><span className="truncate">{action.label}</span></button>
  return <>
    <button ref={trigger} type="button" aria-label={`笔记操作：${title}`} title="笔记操作" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-[8px] text-muted-foreground opacity-75 transition-colors duration-150 hover:bg-[var(--surface-hover)] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--primary)]" onClick={() => onOpenChange(!open)}><MoreHorizontal className="h-3.5 w-3.5" /></button>
    {open && createPortal(<div ref={panel} id={menuId} role="menu" aria-label={`笔记操作：${title}`} className="fixed z-[70] w-[252px] max-w-[calc(100vw-16px)] rounded-2xl p-1.5 text-foreground" style={{ ...position, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', border: 'var(--glass-border)', background: 'var(--glass-bg-strong)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)', boxShadow: 'var(--glass-shadow), var(--glass-highlight)' }} onKeyDown={event => {
      const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const delta = event.key === 'ArrowDown' ? 2 : event.key === 'ArrowUp' ? -2 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (delta || event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + delta + buttons.length) % buttons.length]?.focus()
      }
      if (event.key === 'Tab') onOpenChange(false)
    }}><div className="grid grid-cols-2 gap-0.5">{actions.map(actionButton)}</div>{deleteAction && <div className="mt-1 border-t border-[var(--surface-hairline)] pt-1">{actionButton(deleteAction, actions.length)}</div>}</div>, document.body)}
  </>
}
