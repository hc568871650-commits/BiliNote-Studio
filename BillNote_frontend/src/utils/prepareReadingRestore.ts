/** Keep the saved location off screen until its image/layout measurements settle. */
export function prepareReadingRestore(viewport: HTMLElement, article: HTMLElement, restore: () => void, ready: () => void) {
  let disposed = false
  let shown = false
  let frame = 0
  let previous = ''
  let stableFrames = 0
  let deadlineReached = false
  let fontsReady = !document.fonts || document.fonts.status === 'loaded'
  const placeholders = new Map<HTMLImageElement, string>()
  const images = () => Array.from(article.querySelectorAll('img'))
  const reservePendingImages = () => {
    // A stalled request must not hide the note forever. Keep a usable image box
    // until load/error; the position tracker compensates when it is replaced.
    images().filter(image => !image.complete).forEach(image => {
      if (placeholders.has(image)) return
      placeholders.set(image, image.style.minHeight)
      image.style.minHeight = '500px'
    })
  }
  const check = () => {
    frame = 0
    if (disposed || shown || !viewport.clientHeight) return
    if (!deadlineReached && (!fontsReady || images().some(image => !image.complete))) return
    restore()
    const box = viewport.getBoundingClientRect()
    const geometry = [box.top, box.width, box.height, article.getBoundingClientRect().height, viewport.scrollTop].join(':')
    stableFrames = geometry === previous ? stableFrames + 1 : 0
    previous = geometry
    if (stableFrames >= 2) {
      shown = true
      clearTimeout(deadline)
      observer.disconnect()
      ready()
    } else frame = requestAnimationFrame(check)
  }
  const schedule = () => {
    if (!disposed && !shown && !frame) frame = requestAnimationFrame(check)
  }
  const settled = (event: Event) => {
    const image = event.target
    if (image instanceof HTMLImageElement && placeholders.has(image)) {
      image.style.minHeight = placeholders.get(image)!
      placeholders.delete(image)
      restore()
    }
    schedule()
  }
  const observer = new ResizeObserver(schedule)
  observer.observe(viewport)
  observer.observe(article)
  article.addEventListener('load', settled, true)
  article.addEventListener('error', settled, true)
  if (!fontsReady) void document.fonts.ready.then(() => { fontsReady = true; schedule() })
  const deadline = setTimeout(() => {
    if (disposed || shown) return
    deadlineReached = true
    reservePendingImages()
    schedule()
  }, 2000)
  schedule()
  return () => {
    disposed = true
    clearTimeout(deadline)
    cancelAnimationFrame(frame)
    observer.disconnect()
    article.removeEventListener('load', settled, true)
    article.removeEventListener('error', settled, true)
    placeholders.forEach((minHeight, image) => { image.style.minHeight = minHeight })
  }
}
