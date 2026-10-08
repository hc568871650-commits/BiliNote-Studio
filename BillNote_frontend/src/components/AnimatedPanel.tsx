import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { prefersReducedMotion } from '@/utils/motion'

/** Delay only visual removal; a closed panel becomes inert immediately. */
export default function AnimatedPanel({ open, animate = true, className, children }: {
  open: boolean; animate?: boolean; className: string; children: ReactNode
}) {
  const [present, setPresent] = useState(open)
  const [shown, setShown] = useState(open)
  const [moving, setMoving] = useState(false)
  const previous = useRef({ open, animate })
  const root = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = { open, animate }
    if (open && !before.open) opener.current = document.activeElement as HTMLElement
    if (!open && root.current?.contains(document.activeElement) && opener.current?.isConnected) opener.current.focus()
    const shouldMove = before.open !== open && animate && before.animate && !prefersReducedMotion()
    if (!shouldMove) {
      setPresent(open); setShown(open); setMoving(false)
      return
    }
    let frame = 0, nextFrame = 0, timer: ReturnType<typeof setTimeout> | undefined
    setMoving(true)
    if (open) {
      setPresent(true)
      frame = requestAnimationFrame(() => {
        nextFrame = requestAnimationFrame(() => {
          setShown(true)
          timer = setTimeout(() => setMoving(false), 200)
        })
      })
    } else {
      setShown(false)
      timer = setTimeout(() => { setPresent(false); setMoving(false) }, 200)
    }
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(nextFrame); clearTimeout(timer) }
  }, [open, animate])
  if (!present && !open) return null
  return <div ref={root} className={`panel-motion ${className}`} data-open={shown} data-moving={moving}
    aria-hidden={!open} inert={!open}>
    <div className="panel-motion-content">{children}</div>
  </div>
}
