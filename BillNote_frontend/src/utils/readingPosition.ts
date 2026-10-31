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
export function captureReadingPosition(viewport: HTMLElement, article: HTMLElement): ReadingPosition {
  const max = viewport.scrollHeight - viewport.clientHeight
  const top = viewport.getBoundingClientRect().top + viewport.clientTop
  const nodes = blocks(article)
  let block = -1
  for (let index = 0; index < nodes.length; index++) {
    if (nodes[index].getBoundingClientRect().top > top + 1) break
    block = index
  }
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
  const report = () => options.onProgress(Math.round(captureReadingPosition(viewport, article).progress * 100))
  const save = () => { if (latest) options.onSave(latest) }
  const scheduleSave = () => {
    latest = captureReadingPosition(viewport, article)
    clearTimeout(timer); timer = setTimeout(save, 400)
  }
  const restore = () => {
    if (viewport.clientHeight === 0) return
    if (restoring) viewport.scrollTop = readingPositionTop(viewport, article, restoring)
    report()
  }
  const geometryChanged = () => {
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
  const pointerEnd = () => { if (dragging) intent(); dragging = false }
  const blur = () => { dragging = false; intentUntil = 0 }
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
      viewport.removeEventListener('touchmove', intent); viewport.removeEventListener('keydown', key)
      viewport.removeEventListener('pointerdown', pointer); viewport.removeEventListener('note-chapter-jump', jump)
      viewport.removeEventListener('load', geometryChanged, true)
      window.removeEventListener('pointerup', pointerEnd); window.removeEventListener('pointercancel', pointerEnd); window.removeEventListener('blur', blur); window.removeEventListener('pagehide', save)
    },
  }
}
