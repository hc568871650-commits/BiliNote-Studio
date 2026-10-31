import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Expand, Type } from 'lucide-react'
import { Button } from '@/components/ui/button'

const SIZES = [14, 16, 18, 20, 22]

interface Props {
  fontSize: number
  onFontSize: (size: number) => void
  wide: boolean
  onWide: (wide: boolean) => void
  onFocus: () => void
}

// Rendered in a portal: the reader toolbar clips overflow for its collapse animation.
export default function ReaderDisplayMenu({ fontSize, onFontSize, wide, onWide, onFocus }: Props) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const open = Boolean(position)

  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      const target = event.target as Node
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return
      setPosition(null)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPosition(null); trigger.current?.focus() } }
    const dismiss = () => setPosition(null)
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  const toggle = () => {
    if (open) { setPosition(null); return }
    const rect = trigger.current?.getBoundingClientRect()
    if (rect) setPosition({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)) })
  }

  return <>
    <Button ref={trigger} size="sm" variant="ghost" aria-label="阅读显示设置" title="字号与宽度" aria-expanded={open} aria-haspopup="dialog" onClick={toggle}>
      <Type className="h-4 w-4" />
    </Button>
    {position && createPortal(<div ref={panel} role="dialog" aria-label="阅读显示设置" className="reader-display-menu" style={position}>
      <div className="reader-display-group">
        <span>字号</span>
        <div className="reader-display-segment" role="group" aria-label="阅读字号">
          {SIZES.map(size => <button key={size} type="button" aria-pressed={fontSize === size} onClick={() => onFontSize(size)}>{size}</button>)}
        </div>
      </div>
      <div className="reader-display-group">
        <span>宽度</span>
        <div className="reader-display-segment" role="group" aria-label="阅读宽度">
          <button type="button" aria-pressed={!wide} onClick={() => onWide(false)}>舒适</button>
          <button type="button" aria-pressed={wide} onClick={() => onWide(true)}>铺满</button>
        </div>
      </div>
      <button type="button" className="reader-display-focus" onClick={() => { setPosition(null); onFocus() }}>
        <Expand className="h-3.5 w-3.5" />专注阅读<kbd>Esc 退出</kbd>
      </button>
    </div>, document.body)}
  </>
}
