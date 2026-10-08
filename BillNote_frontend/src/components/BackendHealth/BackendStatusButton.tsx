import { useEffect, useRef, useState } from 'react'
import { Server } from 'lucide-react'
import type { Health } from './BackendHealthIndicator'

const DOCK_GAP = 8
const DOCK_MARGIN = 12
type DockPosition = { left: number; top: number }

function visible(element: HTMLElement): boolean {
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

export default function BackendStatusButton({ health, label, onClick }: {
  health: Health
  label: string
  onClick: () => void
}) {
  const [dock, setDock] = useState<DockPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let frame = 0
    const root = document.documentElement
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const trigger = triggerRef.current
        if (!trigger) return
        const triggerRect = trigger.getBoundingClientRect()
        const panels = [
          ...document.querySelectorAll<HTMLElement>('.reading-chat-dock[data-open="true"], .reading-temporary-dock'),
        ].filter(visible)
        // With both chats open, clear the leftmost boundary of either panel.
        const panel = panels.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]
        const organizer = document.querySelector<HTMLElement>('.organizer-page')
        const organizerVisible = organizer && visible(organizer)

        if (panel) {
          const panelRect = panel.getBoundingClientRect()
          const left = Math.round(panelRect.left - triggerRect.width - DOCK_GAP)
          const top = Math.round(Math.max(DOCK_MARGIN, Math.min(panelRect.bottom - triggerRect.height - DOCK_MARGIN, window.innerHeight - triggerRect.height - DOCK_MARGIN)))
          const proposed = new DOMRect(left, top, triggerRect.width, triggerRect.height)
          const blockers = [...document.querySelectorAll<HTMLElement>('.workspace-rail, .workspace-sidebar, .workspace-scrim')].filter(visible)
          const blocked = blockers.some(element => overlaps(proposed, element.getBoundingClientRect()))
          if (left >= DOCK_MARGIN && !blocked) {
            setDock(current => current?.left === left && current.top === top ? current : { left, top })
            root.removeAttribute('data-backend-health-reserved')
            return
          }
          setDock(null)
          root.setAttribute('data-backend-health-reserved', 'true')
          return
        }

        setDock(null)
        if (organizerVisible) root.setAttribute('data-backend-health-reserved', 'organizer')
        else root.removeAttribute('data-backend-health-reserved')
      })
    }
    const resizeObserver = new ResizeObserver(measure)
    const observePanels = () => {
      resizeObserver.disconnect()
      document.querySelectorAll<HTMLElement>('.reading-chat-dock, .reading-temporary-dock, .organizer-page').forEach(element => resizeObserver.observe(element))
    }
    const mutationObserver = new MutationObserver(measure)
    mutationObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'data-open'] })
    const refreshObserver = new MutationObserver(() => { observePanels(); measure() })
    refreshObserver.observe(document.body, { subtree: true, childList: true })
    window.addEventListener('resize', measure)
    observePanels()
    measure()
    return () => {
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      refreshObserver.disconnect()
      window.removeEventListener('resize', measure)
      root.removeAttribute('data-backend-health-reserved')
    }
  }, [])

  const visibleLabel = health === 'green' ? null : health === 'yellow' ? label.includes('依赖待检查') ? '依赖待检查' : '连接异常' : health === 'red' ? '不可用' : label.includes('重启') ? '重启中' : '检查中'
  return <button
    ref={triggerRef}
    className="backend-status-trigger"
    style={dock ? { left: dock.left, top: dock.top, right: 'auto', bottom: 'auto' } : undefined}
    title={`后端状态：${label}`}
    aria-label={`打开后端管理，后端状态：${label}`}
    onClick={onClick}
  >
    <span className={`backend-dot backend-dot-${health}`} />
    <Server size={14} />
    <span>后端</span>
    {visibleLabel && <span className="backend-status-label">{visibleLabel}</span>}
  </button>
}
