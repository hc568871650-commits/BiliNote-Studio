import { READER_PAN_START, READER_PAN_END } from './readerPan'

export interface ReadingPosition { progress: number; block?: number; offset?: number }
const clamp = (value: number) => Math.max(0, Math.min(1, value))
export function parseReadingPosition(value: unknown): ReadingPosition | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { progress: clamp(value) }
  if (!value || typeof value !== 'object') return null
  const record = value as ReadingPosition
  if (!Number.isFinite(record.progress)) return null
  return { progress: clamp(record.progress), ...(Number.isInteger(record.block) && record.block! >= 0 && Number.isFinite(record.offset) ? { block: record.block, offset: record.offset } : {}) }
}
const blocks = (article: HTMLElement) => Array.from(article.querySelectorAll<HTMLElement>('.markdown-body > *'))
/** Reader blocks/headings follow document order; read live geometry so reflow needs no offset cache. */
export function findReadingAnchor(nodes: readonly HTMLElement[], top: number): number {
  let low = 0
  let high = nodes.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (nodes[middle].getBoundingClientRect().top <= top) low = middle + 1
    else high = middle
  }
  return low - 1
}
export function captureReadingPosition(viewport: HTMLElement, article: HTMLElement, nodes = blocks(article)): ReadingPosition {
  const max = viewport.scrollHeight - viewport.clientHeight
  const top = viewport.getBoundingClientRect().top + viewport.clientTop
  const block = findReadingAnchor(nodes, top + 1)
  return { progress: max > 0 ? clamp(viewport.scrollTop / max) : 0, ...(block >= 0 ? { block, offset: top - nodes[block].getBoundingClientRect().top } : {}) }
}
export function readingPositionTop(viewport: HTMLElement, article: HTMLElement, position: ReadingPosition) {
  const node = position.block === undefined ? undefined : blocks(article)[position.block]
  const top = node ? viewport.scrollTop + node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientTop + (position.offset || 0) : Math.max(0, viewport.scrollHeight - viewport.clientHeight) * position.progress
  return Math.max(0, top)
}

/** Only deliberate navigation writes progress; opening/resetting a reader never erases it. */
export function trackReadingPosition(viewport: HTMLElement, article: HTMLElement, options: {
  saved: ReadingPosition | null; autoRestore: boolean
  onProgress: (progress: number) => void; onSave: (position: ReadingPosition) => void
}) {
  let restoring = options.autoRestore ? options.saved : null
  let latest: ReadingPosition | null = null
  let intentUntil = 0
  let dragging = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let nodes = blocks(article)
  let reported = -1
  const report = () => {
    if (dragging) return
    const max = viewport.scrollHeight - viewport.clientHeight
    const progress = Math.round((max > 0 ? clamp(viewport.scrollTop / max) : 0) * 100)
    if (progress !== reported) { reported = progress; options.onProgress(progress) }
  }
  const save = () => { if (latest) options.onSave(latest) }
  const scheduleSave = () => {
    latest = captureReadingPosition(viewport, article, nodes)
    clearTimeout(timer); timer = setTimeout(save, 400)
  }
  const restore = () => {
    if (viewport.clientHeight === 0) return
    if (restoring) viewport.scrollTop = readingPositionTop(viewport, article, restoring)
    report()
  }
  const geometryChanged = () => {
    nodes = blocks(article)
    // ResizeObserver runs before paint. Deferring again exposes the top of a
    // reader mounted while hidden, or its old position after images reflow.
    restore()
  }
  const intent = () => { restoring = null; intentUntil = Date.now() + 1500 }
  const wheel = (event: Event) => { if (!(event as WheelEvent).ctrlKey) intent() }
  const key = (event: Event) => {
    const keyboard = event as KeyboardEvent
    if (keyboard.target === viewport && !keyboard.altKey && !keyboard.ctrlKey && !keyboard.metaKey && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(keyboard.key)) intent()
  }
  const pointer = (event: Event) => {
    const pointerEvent = event as PointerEvent
    const rect = viewport.getBoundingClientRect()
    if (pointerEvent.button === 0 && pointerEvent.target === viewport && pointerEvent.clientX >= rect.right - Math.max(8, viewport.offsetWidth - viewport.clientWidth)) { dragging = true; intent() }
  }
  const endDrag = () => {
    if (!dragging) return
    intent(); dragging = false; report()
  }
  const pointerEnd = (event: Event) => { if ((event as PointerEvent).pointerType === 'mouse') endDrag() }
  const panStart = () => { dragging = true; intent() }
  const panEnd = (event: Event) => {
    if ((event as CustomEvent<{ moved: boolean }>).detail.moved) scheduleSave()
    endDrag()
  }
  const blur = () => { dragging = false; intentUntil = 0; report() }
  const scrolled = () => {
    if (!viewport.clientHeight) return
    report()
    if (!restoring && (dragging || Date.now() < intentUntil)) scheduleSave()
  }
  const jump = () => { intent() }
  const observer = new ResizeObserver(geometryChanged)
  observer.observe(article); observer.observe(viewport)
  if (!restoring) viewport.scrollTop = 0
  restore()
  viewport.addEventListener('scroll', scrolled, { passive: true })
  viewport.addEventListener(READER_PAN_START, panStart)
  viewport.addEventListener(READER_PAN_END, panEnd)
  viewport.addEventListener('wheel', wheel, { passive: true })
  viewport.addEventListener('touchmove', intent, { passive: true })
  viewport.addEventListener('keydown', key)
  viewport.addEventListener('pointerdown', pointer)
  viewport.addEventListener('note-chapter-jump', jump)
  viewport.addEventListener('load', geometryChanged, true)
  window.addEventListener('pointerup', pointerEnd)
  window.addEventListener('pointercancel', pointerEnd)
  window.addEventListener('blur', blur)
  window.addEventListener('pagehide', save)
  return {
    refresh: restore,
    resume: (position: ReadingPosition) => { clearTimeout(timer); latest = null; intentUntil = 0; restoring = position; restore() },
    reset: () => { restoring = null; latest = null; intentUntil = 0; clearTimeout(timer); viewport.scrollTop = 0; report() },
    dispose: () => {
      clearTimeout(timer); save(); observer.disconnect()
      viewport.removeEventListener('scroll', scrolled); viewport.removeEventListener('wheel', wheel)
      viewport.removeEventListener(READER_PAN_START, panStart); viewport.removeEventListener(READER_PAN_END, panEnd)
      viewport.removeEventListener('touchmove', intent); viewport.removeEventListener('keydown', key)
      viewport.removeEventListener('pointerdown', pointer); viewport.removeEventListener('note-chapter-jump', jump)
      viewport.removeEventListener('load', geometryChanged, true)
      window.removeEventListener('pointerup', pointerEnd); window.removeEventListener('pointercancel', pointerEnd); window.removeEventListener('blur', blur); window.removeEventListener('pagehide', save)
    },
  }
}
