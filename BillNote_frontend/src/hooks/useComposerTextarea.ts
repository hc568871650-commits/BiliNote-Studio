import { useLayoutEffect, useRef } from 'react'

export function useComposerTextarea(value: string, minHeight = 28) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    let width = element.clientWidth
    const fit = () => {
      element.style.height = '0px'
      element.style.height = `${Math.min(104, Math.max(minHeight, element.scrollHeight))}px`
    }
    fit()
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; fit() }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [value, minHeight])
  return ref
}
