import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ReadingAttachment } from '@/store/readingAssistantStore'
import './reading-assistant.css'

// Operate on parsed Markdown blocks, preserving tables, lists and code as units.
export function rehypeReadingBlocks() {
  return (tree: { children: Array<{ type: string; tagName?: string; properties?: Record<string, unknown>; children?: unknown[]; position?: { start: { offset?: number }; end: { offset?: number } } }> }, file: { value: unknown }) => {
    let index = 0
    tree.children = tree.children.map(node => {
      if (node.type !== 'element') return node
      const id = `note-block-${index++}`
      const text = node.position?.start.offset != null && node.position?.end.offset != null ? String(file.value).slice(node.position.start.offset, node.position.end.offset) : ''
      return { type: 'element', tagName: 'div', properties: { className: ['reading-block'], 'data-note-block': id, 'data-note-text': text, id }, children: [
        { type: 'element', tagName: 'button', properties: { type: 'button', className: ['reading-block-pick'], 'data-block-pick': id, 'aria-label': `选择第 ${index} 段`, title: '选择段落' }, children: [{ type: 'text', value: '+' }] }, node,
      ] }
    })
  }
}
interface Props { children: ReactNode; taskId: string; versionId: string; title: string; onQuote: (quotes: ReadingAttachment[], temporary: boolean) => void }
export default function ReadingSelection({ children, taskId, versionId, title, onQuote }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [selection, setSelection] = useState<{ text: string; x: number; y: number; blockId?: string } | null>(null)
  const quote = (text: string, blockId?: string): ReadingAttachment => ({ id: crypto.randomUUID(), type: 'quote', name: title, text, taskId, versionId, blockId })
  useEffect(() => {
    container.current?.querySelectorAll<HTMLElement>('[data-note-block]').forEach(el => {
      const checked = selected.includes(el.dataset.noteBlock || '')
      el.classList.toggle('reading-block--selected', checked)
      el.querySelector('button')?.setAttribute('aria-pressed', String(checked))
    })
  }, [selected])
  useEffect(() => {
    const dismiss = () => setSelection(null)
    window.addEventListener('scroll', dismiss, true)
    return () => window.removeEventListener('scroll', dismiss, true)
  }, [])
  const addBlocks = (temporary: boolean) => {
    const blocks = Array.from(container.current?.querySelectorAll<HTMLElement>('[data-note-block]') || []).filter(el => selected.includes(el.dataset.noteBlock || ''))
    const quotes = blocks.map(el => quote(el.dataset.noteText || Array.from(el.children).filter(child => !child.matches('[data-block-pick]')).map(child => child.textContent).join('\n'), el.dataset.noteBlock)).filter(item => item.text?.trim())
    if (quotes.length) onQuote(quotes, temporary)
    setSelected([])
  }
  return <div ref={container} data-note-task={taskId} data-note-version={versionId} className={`reading-selection ${selected.length ? 'reading-selection--active' : ''}`}
    onKeyDown={event => { if (event.key === 'Escape') { setSelection(null); setSelected([]) } }}
    onMouseUp={event => {
      if ((event.target as HTMLElement).closest('button')) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !container.current?.contains(sel.anchorNode) || !container.current.contains(sel.focusNode)) { setSelection(null); return }
      const text = sel.toString().trim()
      if (!text) return
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      const blockId = (sel.anchorNode?.parentElement?.closest('[data-note-block]') as HTMLElement)?.dataset.noteBlock
      setSelection({ text, blockId, x: Math.max(8, Math.min(rect.left, window.innerWidth - 320)), y: Math.max(8, rect.top - 44) })
    }}
    onClick={event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-block-pick]')
      const block = (event.target as HTMLElement).closest<HTMLElement>('[data-note-block]')
      if (!button && (!selected.length || (event.target as HTMLElement).closest('a,button,input') || window.getSelection()?.toString())) return
      const id = button?.dataset.blockPick || block?.dataset.noteBlock
      if (id) { event.preventDefault(); setSelection(null); setSelected(old => old.includes(id) ? old.filter(x => x !== id) : [...old, id]) }
    }}>
    {selected.length > 0 && <div className="reading-multiselect" role="toolbar" aria-label="段落选择"><span>已选 {selected.length} 段</span><button onClick={() => addBlocks(false)}>添加到对话</button><button onClick={() => addBlocks(true)}>临时提问</button><button onClick={() => setSelected([])}>取消</button></div>}
    {children}
    {selection && <div className="reading-selection-popover" style={{ left: selection.x, top: selection.y }} role="toolbar" aria-label="选中文字操作" onMouseDown={event => event.preventDefault()}>
      <button onClick={() => { onQuote([quote(selection.text, selection.blockId)], false); setSelection(null); window.getSelection()?.removeAllRanges() }}>添加到对话</button>
      <button onClick={() => { onQuote([quote(selection.text, selection.blockId)], true); setSelection(null); window.getSelection()?.removeAllRanges() }}>在侧边聊天中提问</button>
    </div>}
  </div>
}
