interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}
export function outlineText(node: Node): string {
  return node.type === 'text' ? node.value || '' : (node.children || []).map(outlineText).join('')
}
export function chapterLabel(text: string): string {
  return text.replace(/\s*\*?Content\s*-\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\*?/gi, '').trim()
}
export function chapterKey(text: string): string {
  return chapterLabel(text).normalize('NFKC').toLowerCase()
    .replace(/^(?:第[一二三四五六七八九十百\d]+[章节]|[ivxlcdm]+[.、:：)\s]|\d+(?:\.\d+)*[.、:：)\s])\s*/i, '')
    .replace(/[\p{P}\p{S}\s]/gu, '')
}
const heading = (node: Node) => node.type === 'element' && /^h[1-6]$/.test(node.tagName || '')
const tocMarker = (node: Node) => node.type === 'element' && /^(目录|内容目录|笔记目录|table of contents|contents)$/i.test(outlineText(node).trim().replace(/[：:]$/, '')) && (heading(node) || node.tagName === 'p')

/** Render-only: source Markdown remains untouched for copy, export and quotation. */
export function rehypeNoteOutline() {
  return (tree: Node) => {
    const children = tree.children || []
    const marker = children.findIndex(tocMarker)
    let tocEnd = marker + 1
    if (marker >= 0) {
      while (tocEnd < children.length && !heading(children[tocEnd])) tocEnd++
      // A list-only document has no body outline to rebuild; keep its content.
      if (tocEnd >= children.length) return
      // Some generators emit the directory entries as standalone headings.
      // Only consume repeated headings with no intervening body block.
      while (tocEnd < children.length && heading(children[tocEnd])) {
        const key = chapterKey(outlineText(children[tocEnd]))
        const repeated = children.slice(tocEnd + 1).some(node => heading(node) && chapterKey(outlineText(node)) === key)
        if (!repeated) break
        const next = children.slice(tocEnd + 1).find(node => node.type !== 'text' || outlineText(node).trim())
        if (next && next.tagName !== 'hr' && !heading(next)) break
        tocEnd++
        while (tocEnd < children.length && (children[tocEnd].type === 'text' || children[tocEnd].tagName === 'hr')) tocEnd++
      }
      children.splice(marker, tocEnd - marker)
    }
    const entries: { id: string; text: string; level: number }[] = []
    const visit = (node: Node) => {
      if (heading(node)) {
        const id = `note-chapter-${entries.length + 1}`
        const text = chapterLabel(outlineText(node)) || '未命名章节'
        const stamp = outlineText(node).match(/Content\s*-\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]/i)?.[1]
        const seconds = stamp?.split(':').reduce((total, part) => total * 60 + Number(part), 0)
        entries.push({ id, text, level: Number(node.tagName!.slice(1)) })
        node.properties = { ...node.properties, 'data-note-original-id': node.properties?.id || '', 'data-note-heading': true, 'data-note-label': text, ...(seconds === undefined ? {} : { 'data-note-time': seconds }), id }
      }
      node.children?.forEach(visit)
    }
    children.forEach(visit)
    if (!entries.length) return
    const minLevel = Math.min(...entries.map(entry => entry.level))
    const nav: Node = { type: 'element', tagName: 'nav', properties: { className: ['note-outline'], 'aria-label': '笔记目录' }, children: [
      { type: 'element', tagName: 'p', properties: { className: ['note-outline-title'] }, children: [{ type: 'text', value: '目录' }] },
      { type: 'element', tagName: 'ul', children: entries.map(entry => ({ type: 'element', tagName: 'li', properties: { 'data-outline-depth': Math.min(3, entry.level - minLevel) }, children: [
        { type: 'element', tagName: 'a', properties: { href: `#${entry.id}` }, children: [{ type: 'text', value: entry.text }] },
      ] })) },
    ] }
    children.splice(marker >= 0 ? marker : 0, 0, nav)
  }
}

export function resolveChapter(root: HTMLElement, href: string, label: string): HTMLElement | null {
  let id = href.slice(1)
  try { id = decodeURIComponent(id) } catch { /* Legacy malformed escapes are plain text. */ }
  const headings = Array.from(root.querySelectorAll<HTMLElement>('[data-note-heading]'))
  const exact = headings.find(node => node.id === id || node.dataset.noteOriginalId === id)
  if (exact) return exact
  const key = chapterKey(label)
  if (key) {
    const matches = headings.filter(node => chapterKey(node.dataset.noteLabel || node.textContent || '') === key)
    if (matches.length === 1) return matches[0]
  }
  const idKey = chapterKey(id)
  const matches = idKey ? headings.filter(node => chapterKey(node.dataset.noteLabel || node.textContent || '') === idKey) : []
  return matches.length === 1 ? matches[0] : null
}

export function scrollToChapter(target: HTMLElement, behavior: ScrollBehavior) {
  const viewport = target.closest<HTMLElement>('[data-testid="reader-viewport"]')
  if (!viewport) return
  // Use current geometry rather than offsetTop (headings may be nested in quote wrappers).
  const top = viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientTop - 16
  viewport.dispatchEvent(new Event('note-chapter-jump'))
  viewport.scrollTo({ top: Math.max(0, top), behavior })
}
