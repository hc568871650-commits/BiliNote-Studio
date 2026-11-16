export const READER_PAN_START = 'reader-pan-start'
export const READER_PAN_END = 'reader-pan-end'

/** Pen drags pan the note; touch gestures stay with the browser (including pinch zoom). */
export function attachReaderPan(viewport: HTMLElement) {
  let gesture: { id: number; kind: 'pen' | 'touch'; x: number; y: number; top: number; nextTop: number; moved: boolean; native: boolean; image: HTMLElement | null } | null = null
  let frame = 0
  let suppressClickFor: number | null = null
  let nativeSettle: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    frame = 0
    if (gesture?.kind === 'pen' && gesture.moved && !gesture.native) viewport.scrollTop = gesture.nextTop
  }
  const finish = (commit: boolean, tap = false) => {
    if (!gesture) return
    const previous = gesture
    cancelAnimationFrame(frame); frame = 0; clearTimeout(nativeSettle)
    if (commit) flush()
    gesture = null
    viewport.removeAttribute('data-reader-pen-panning')
    if (viewport.hasPointerCapture(previous.id)) viewport.releasePointerCapture(previous.id)
    viewport.dispatchEvent(new CustomEvent(READER_PAN_END, { detail: { pointerId: previous.id, moved: previous.moved } }))
    if (tap && previous.image?.isConnected) {
      // Suppressing pen mouse-compatibility events also suppresses its image click.
      suppressClickFor = previous.id
      previous.image.click()
    }
  }
  const down = (event: PointerEvent) => {
    if (event.pointerType === 'pen') suppressClickFor = null
    if (gesture || !event.isPrimary || event.button !== 0 || !['pen', 'touch'].includes(event.pointerType)
      || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    const target = event.target instanceof Element ? event.target : null
    const control = target?.closest('button,a,input,textarea,select,[contenteditable="true"],[role="slider"],[role="separator"]')
    if (control && !control.matches('[data-note-image]')) return
    // Native scrollbar gestures are handled separately; never take over its thumb.
    const rect = viewport.getBoundingClientRect()
    if (event.target === viewport && event.clientX >= rect.right - Math.max(8, viewport.offsetWidth - viewport.clientWidth)) return
    if (viewport.scrollHeight <= viewport.clientHeight) return
    gesture = { id: event.pointerId, kind: event.pointerType as 'pen' | 'touch', x: event.clientX, y: event.clientY,
      top: viewport.scrollTop, nextTop: viewport.scrollTop, moved: false, native: event.pointerType === 'touch',
      image: control?.matches('[data-note-image]') ? control as HTMLElement : null }
    if (gesture.kind === 'pen') event.preventDefault() // Suppress compatibility mouse selection/HTML image dragging.
    viewport.dispatchEvent(new CustomEvent(READER_PAN_START, { detail: { pointerId: event.pointerId } }))
  }
  const move = (event: PointerEvent) => {
    if (!gesture || gesture.id !== event.pointerId || gesture.kind !== 'pen' || gesture.native) return
    const delta = event.clientY - gesture.y
    if (!gesture.moved && Math.abs(delta) < 5) return
    if (!gesture.moved) {
      gesture.moved = true
      suppressClickFor = event.pointerId
      viewport.setAttribute('data-reader-pen-panning', 'true')
      viewport.setPointerCapture(event.pointerId)
    }
    event.preventDefault()
    gesture.nextTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, gesture.top - delta))
    if (!frame) frame = requestAnimationFrame(flush)
  }
  const up = (event: PointerEvent) => {
    if (gesture?.id !== event.pointerId) return
    const tap = gesture.kind === 'pen' && !gesture.moved && !gesture.native && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5
    finish(true, tap)
  }
  const cancel = (event: PointerEvent) => {
    if (gesture?.id !== event.pointerId) return
    // A browser-native pan cancels pointer events. Stop our writes and let it own scrolling.
    gesture.native = true
    cancelAnimationFrame(frame); frame = 0
    clearTimeout(nativeSettle)
    if (gesture.kind === 'pen') nativeSettle = setTimeout(() => finish(false), 250)
  }
  const scrolled = () => {
    if (!gesture) return
    gesture.moved = true
    if (gesture.native && gesture.kind === 'pen') {
      clearTimeout(nativeSettle)
      nativeSettle = setTimeout(() => finish(false), 250)
    }
  }
  const scrollEnded = () => { if (gesture?.native) finish(false) }
  const touchEnded = (event: TouchEvent) => { if (!event.touches.length && gesture?.kind === 'touch') finish(false) }
  const blur = () => finish(true)
  const lostCapture = (event: PointerEvent) => {
    if (gesture?.id === event.pointerId && !gesture.native) finish(true)
  }
  const click = (event: MouseEvent) => {
    const pointer = event as PointerEvent
    if (pointer.pointerType === 'pen' && pointer.pointerId === suppressClickFor) {
      suppressClickFor = null; event.preventDefault(); event.stopPropagation()
    }
  }
  viewport.addEventListener('pointerdown', down, { passive: false })
  viewport.addEventListener('scroll', scrolled, { passive: true })
  viewport.addEventListener('scrollend', scrollEnded)
  viewport.addEventListener('click', click, true)
  viewport.addEventListener('lostpointercapture', lostCapture)
  window.addEventListener('pointermove', move, { passive: false })
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('touchend', touchEnded, { passive: true })
  window.addEventListener('touchcancel', touchEnded, { passive: true })
  window.addEventListener('blur', blur)
  return () => {
    const previous = gesture
    cancelAnimationFrame(frame); clearTimeout(nativeSettle); gesture = null
    if (previous && viewport.hasPointerCapture(previous.id)) viewport.releasePointerCapture(previous.id)
    viewport.removeAttribute('data-reader-pen-panning')
    viewport.removeEventListener('pointerdown', down); viewport.removeEventListener('scroll', scrolled)
    viewport.removeEventListener('scrollend', scrollEnded); viewport.removeEventListener('click', click, true)
    viewport.removeEventListener('lostpointercapture', lostCapture)
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel); window.removeEventListener('touchend', touchEnded)
    window.removeEventListener('touchcancel', touchEnded); window.removeEventListener('blur', blur)
  }
}
