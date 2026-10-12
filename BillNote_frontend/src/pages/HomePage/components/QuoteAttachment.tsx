import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronLeft, ChevronRight, CornerUpLeft, X } from 'lucide-react'
import type { ReadingAttachment } from '@/store/readingAssistantStore'
import { quoteParts, type QuotePart } from '@/utils/quoteSource'
import { quotePreview } from '@/utils/quotePreview'
import './quote-attachment.css'

interface Props {
  attachment: ReadingAttachment
  onOriginal: (parts: QuotePart[]) => void
  onRemove?: () => void
}

export default function QuoteAttachment({ attachment, onOriginal, onRemove }: Props) {
  const parts = quoteParts(attachment)
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null)
  const [index, setIndex] = useState(0)
  const anchor = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const firstAction = useRef<HTMLButtonElement>(null)
  const id = useId()
  const open = position !== null
  const count = attachment.blockCount || parts.length || 1
  const current = parts[index] || parts[0]
  const close = (focus = false) => { setPosition(null); if (focus) trigger.current?.focus() }
  const original = (selected: QuotePart[]) => { close(); onOriginal(selected) }

  useEffect(() => {
    if (!open) return
    firstAction.current?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!anchor.current?.contains(target) && !panel.current?.contains(target)) setPosition(null)
    }
    const scroll = (event: Event) => {
      const target = event.target
      if (target instanceof Node && panel.current?.contains(target)) return
      if (target === document || target === window || (target instanceof Element && anchor.current && target.contains(anchor.current))) setPosition(null)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setPosition(null); trigger.current?.focus() } }
    const resize = () => setPosition(null)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', resize)
    }
  }, [open])

  return <div ref={anchor} className="assistant-quote">
    <button className="assistant-quote-content" aria-label={`查看引用原文：${quotePreview(attachment.text, 20)}`} title={`查看原文${parts.length > 1 ? '（高亮全部引用段落）' : count > 1 ? '（返回起始位置）' : ''} · ${attachment.name}`} onClick={() => original(parts)}>
      {count > 1 ? `${count}段 · ${quotePreview(attachment.text, 8)}` : quotePreview(attachment.text, 12) || '引用'}
    </button>
    <button ref={trigger} type="button" className="assistant-quote-expand" title="预览引用内容" aria-label="预览引用内容" aria-expanded={Boolean(position)} aria-controls={position ? id : undefined} aria-haspopup="dialog" onClick={() => {
      if (position) { close(); return }
      const rect = anchor.current!.getBoundingClientRect()
      const width = Math.min(320, window.innerWidth - 24)
      const above = rect.top >= window.innerHeight - rect.bottom
      const maxHeight = Math.min(232, Math.max(96, (above ? rect.top : window.innerHeight - rect.bottom) - 18))
      setIndex(0)
      setPosition({ width, maxHeight, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        ...(above ? { bottom: Math.max(12, window.innerHeight - rect.top + 6) } : { top: Math.max(12, rect.bottom + 6) }) })
    }}><ChevronDown size={12} /></button>
    {onRemove && <button type="button" className="assistant-quote-remove" aria-label={`移除引用 ${quotePreview(attachment.text, 12)}`} onClick={onRemove}><X size={11} /></button>}
    {position && createPortal(<div ref={panel} id={id} className="reading-quote-peek" style={position} role="dialog" aria-label="引用内容预览">
      <header><span title={attachment.name}>{attachment.name}</span><button type="button" aria-label="关闭引用预览" onClick={() => close(true)}><X size={13} /></button></header>
      <pre tabIndex={0}>{current?.text || attachment.text}</pre>
      <footer>
        <button ref={firstAction} type="button" className="quote-original-action" onClick={() => original(current ? [current] : parts)}><CornerUpLeft size={12} />查看原文</button>
        {parts.length > 1 ? <div className="quote-part-controls"><button type="button" aria-label="上一引用段" disabled={index === 0} onClick={() => setIndex(index - 1)}><ChevronLeft size={13} /></button><span>{index + 1} / {parts.length}</span><button type="button" aria-label="下一引用段" disabled={index === parts.length - 1} onClick={() => setIndex(index + 1)}><ChevronRight size={13} /></button></div> : count > 1 && <small>旧引用 · 返回起始位置</small>}
      </footer>
    </div>, document.body)}
  </div>
}
