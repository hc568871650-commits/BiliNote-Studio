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
      return { type: 'element', tagName: 'div', properties: { className: ['reading-block'], 'data-note-block': id, 'data-note-text': text, 'data-source-start': node.position?.start.offset, 'data-source-end': node.position?.end.offset, id }, children: [
        { type: 'element', tagName: 'button', properties: { type: 'button', className: ['reading-block-pick'], 'data-block-pick': id, 'aria-label': `选择第 ${index} 段`, title: '选择段落，可加入 AI 问答' }, children: [
          { type: 'element', tagName: 'svg', properties: { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', className: ['reading-block-pick-icon'] }, children: [
            { type: 'element', tagName: 'path', properties: { className: ['pick-plus'], d: 'M8 3.5v9M3.5 8h9' }, children: [] },
            { type: 'element', tagName: 'path', properties: { className: ['pick-check'], d: 'M3.5 8.4 6.5 11.4 12.5 5' }, children: [] },
          ] },
        ] }, node,
      ] }
    })
  }
}
interface Props { children: ReactNode; taskId: string; versionId: string; title: string; onQuote: (quotes: ReadingAttachment[], openChat: boolean) => boolean; onRefine?: (texts: string[]) => void }
export default function ReadingSelection({ children, taskId, versionId, title, onQuote, onRefine }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [selection, setSelection] = useState<{ text: string; x: number; y: number; blockId?: string; sourceText?: string } | null>(null)
  const quote = (text: string, blockId?: string, sourceText?: string): ReadingAttachment => ({ id: crypto.randomUUID(), type: 'quote', name: title, text, taskId, versionId, blockId, ...(sourceText ? { sourceText } : {}) })
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
  const addBlocks = (openChat: boolean) => {
    const blocks = Array.from(container.current?.querySelectorAll<HTMLElement>('[data-note-block]') || []).filter(el => selected.includes(el.dataset.noteBlock || ''))
    const parts = blocks.map(el => ({ text: el.dataset.noteText || Array.from(el.children).filter(child => !child.matches('[data-block-pick]')).map(child => child.textContent).join('\n'), blockId: el.dataset.noteBlock })).filter(part => part.text.trim())
    if (!parts.length) return
    let offset = 0
    const blockRanges = parts.map(part => {
      const range = { blockId: part.blockId, start: offset, end: offset + part.text.length }
      offset = range.end + 2
      return range
    })
    const combined = { ...quote(parts.map(part => part.text).join('\n\n'), parts[0].blockId), blockCount: parts.length, blocks: blockRanges }
    if (onQuote([combined], openChat)) setSelected([])
  }
  return <div ref={container} data-note-task={taskId} data-note-version={versionId} className={`reading-selection ${selected.length ? 'reading-selection--active' : ''}`}
    onKeyDown={event => { if (event.key === 'Escape') { setSelection(null); setSelected([]) } }}
    onMouseUp={event => {
      if ((event.target as HTMLElement).closest('button')) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !container.current?.contains(sel.anchorNode) || !container.current.contains(sel.focusNode)) { setSelection(null); return }
      const text = sel.toString().trim()
      if (!text) return
      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      const start = range.startContainer
      const block = (start instanceof HTMLElement ? start : start.parentElement)?.closest<HTMLElement>('[data-note-block]')
      // A mouse selection can span blocks. Keep a bounded anchor excerpt from
      // its first block while retaining the complete selected text for the chat.
      let sourceText: string | undefined
      if (block && !block.contains(range.endContainer)) {
        const first = range.cloneRange()
        first.setEnd(block, block.childNodes.length)
        const fragment = first.cloneContents()
        fragment.querySelectorAll('[data-block-pick]').forEach(control => control.remove())
        sourceText = fragment.textContent?.trim().slice(0, 512) || undefined
      }
      setSelection({ text, blockId: block?.dataset.noteBlock, sourceText, x: Math.max(8, Math.min(rect.left, window.innerWidth - 320)), y: Math.max(8, rect.top - 44) })
    }}
    onClick={event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-block-pick]')
      const block = (event.target as HTMLElement).closest<HTMLElement>('[data-note-block]')
      if (!button && (!selected.length || (event.target as HTMLElement).closest('a,button,input') || window.getSelection()?.toString())) return
      const id = button?.dataset.blockPick || block?.dataset.noteBlock
      if (id) { event.preventDefault(); setSelection(null); setSelected(old => old.includes(id) ? old.filter(x => x !== id) : [...old, id]) }
    }}>
    {selected.length > 0 && <div className="reading-multiselect-anchor"><div className="reading-multiselect" role="toolbar" aria-label="段落选择"><span>已选 {selected.length} 段</span><button type="button" onClick={() => addBlocks(true)}>问 AI 助手</button><button type="button" onClick={() => addBlocks(false)}>加入引用</button>{onRefine && <button type="button" onClick={() => {
      const blocks = Array.from(container.current?.querySelectorAll<HTMLElement>('[data-note-block]') || [])
      const indices = blocks.map((block, index) => selected.includes(block.dataset.noteBlock || '') ? index : -1).filter(index => index >= 0)
      const texts = indices.map(index => blocks[index].dataset.noteText || '').filter(text => text.trim())
      if (texts.length) onRefine(texts)
    }}>重新蒸馏</button>}<button type="button" onClick={() => setSelected([])}>取消</button></div></div>}
    {children}
    {selection && <div className="reading-selection-popover" style={{ left: selection.x, top: selection.y }} role="toolbar" aria-label="选中文字操作" onMouseDown={event => event.preventDefault()}>
      <button type="button" onClick={() => { if (onQuote([quote(selection.text, selection.blockId, selection.sourceText)], true)) { setSelection(null); window.getSelection()?.removeAllRanges() } }}>问 AI 助手</button>
      <button type="button" onClick={() => { if (onQuote([quote(selection.text, selection.blockId, selection.sourceText)], false)) { setSelection(null); window.getSelection()?.removeAllRanges() } }}>加入引用</button>
    </div>}
  </div>
}
