export interface SearchMatch { start: number; end: number; text: string }
const sourceLine = /^>\s*来源链接：[^\n]*\n*/m
export const renderedNoteMarkdown = (markdown: string) => markdown.replace(sourceLine, '')

export function resolveSearchTarget(root: HTMLElement, markdown: string, match: SearchMatch): { element: HTMLElement; range: Range | null } | null {
  // A stale version or edited body must not silently jump to a different hit.
  if (!Number.isInteger(match.start) || match.start < 0 || match.end <= match.start || markdown.slice(match.start, match.end) !== match.text) return null
  // The reader omits its duplicate source banner; parser offsets use that rendered text.
  const omitted = sourceLine.exec(markdown)
  if (omitted && match.start < omitted.index + omitted[0].length && match.end > omitted.index) return null
  const removed = omitted && match.start >= omitted.index + omitted[0].length ? omitted[0].length : 0
  const rendered = renderedNoteMarkdown(markdown)
  const start = match.start - removed
  const element = Array.from(root.querySelectorAll<HTMLElement>('[data-source-start][data-source-end]'))
    .find(block => Number(block.dataset.sourceStart) <= start && Number(block.dataset.sourceEnd) > start)
  if (!element) return null
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest('[data-block-pick]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  const visible = nodes.map(node => node.data).join('')
  const before = rendered.slice(Number(element.dataset.sourceStart), start)
  // Retain the occurrence within a long paragraph, including repeated keywords.
  const occurrence = before.split(match.text).length - 1
  let index = -1
  for (let count = 0; count <= occurrence; count++) {
    index = visible.indexOf(match.text, index + 1)
    if (index < 0) break
  }
  if (index < 0) return { element, range: null }
  const range = document.createRange()
  let offset = 0
  let started = false
  for (const node of nodes) {
    if (!started && index < offset + node.length) { range.setStart(node, index - offset); started = true }
    if (started && index + match.text.length <= offset + node.length) { range.setEnd(node, index + match.text.length - offset); return { element, range } }
    offset += node.length
  }
  return { element, range: null }
}

export function scrollToSearchMatch(target: { element: HTMLElement; range: Range | null }, behavior: ScrollBehavior) {
  const viewport = target.element.closest<HTMLElement>('[data-testid="reader-viewport"]')
  if (!viewport) return
  const rect = target.range?.getBoundingClientRect() || target.element.getBoundingClientRect()
  const top = viewport.scrollTop + rect.top - viewport.getBoundingClientRect().top - viewport.clientHeight / 3
  viewport.dispatchEvent(new CustomEvent('note-chapter-jump', { detail: { id: target.element.id, behavior } }))
  viewport.scrollTo({ top: Math.max(0, top), behavior })
}
