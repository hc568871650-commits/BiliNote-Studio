import { AnimatedCreateNoteIcon, AnimatedNotebookIcon } from '@/components/AnimatedRailIcons'
import { BackendRailStatusButton } from '@/components/BackendHealth/BackendStatusButton'
import DistillQueuePanel from '@/components/DistillQueue/DistillQueuePanel'
import { useDistillQueueStore } from '@/store/distillQueueStore'
import { isQuickEdition } from '@/utils/edition'
import { BotMessageSquare, Monitor, Moon, Settings2, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { Link, useLocation } from 'react-router-dom'
import './workspace.css'

export type WorkspaceRailActive = 'create' | 'library' | 'organizer' | 'settings'

interface WorkspaceRailProps {
  active: WorkspaceRailActive
  libraryExpanded?: boolean
  hasSidebarToggle?: boolean
  libraryButtonRef?: RefObject<HTMLButtonElement | null>
  onCreateClick?: () => void
  onLibraryClick?: () => void
  libraryLabel?: string
}

const themeModes = [
  { id: 'light', label: '浅色模式', Icon: Sun },
  { id: 'dark', label: '深色模式', Icon: Moon },
  { id: 'system', label: '跟随系统', Icon: Monitor },
] as const

type ThemeModeId = (typeof themeModes)[number]['id']

type ViewTransitionLike = {
  finished: Promise<void>
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (updateCallback: () => void | Promise<void>) => ViewTransitionLike
}

function resolveTargetDark(mode: ThemeModeId): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return true
  return (
    document.documentElement.dataset.reducedMotion === 'true'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function routeMatchesRail(pathname: string, active: WorkspaceRailActive): boolean {
  if (active === 'settings') return pathname.startsWith('/settings')
  if (active === 'organizer') return pathname.startsWith('/organizer')
  return pathname === '/'
}

export default function WorkspaceRail({
  active,
  libraryExpanded,
  hasSidebarToggle: hasSidebarToggleProp,
  libraryButtonRef,
  onCreateClick,
  onLibraryClick,
  libraryLabel = '笔记库',
}: WorkspaceRailProps) {
  const location = useLocation()
  const { theme, setTheme } = useTheme()
  const [pendingMode, setPendingMode] = useState<ThemeModeId | null>(null)
  const transitionSeqRef = useRef(0)
  const slideTimerRef = useRef<number | null>(null)
  const committedMode: ThemeModeId = theme === 'light' || theme === 'dark' ? theme : 'system'
  const activeMode: ThemeModeId = pendingMode ?? committedMode
  const activeThemeIndex = activeMode === 'light' ? 0 : activeMode === 'dark' ? 1 : 2
  const hasSidebarToggle = hasSidebarToggleProp ?? (typeof libraryExpanded === 'boolean')
  const libraryTitle = hasSidebarToggle
    ? `${libraryExpanded ? '收起笔记库' : '展开笔记库'}（Ctrl+B）`
    : libraryLabel

  const isVisibleRoute = routeMatchesRail(location.pathname, active)
  const targetTopIndex: number | null = active === 'create'
    ? 0
    : active === 'library'
      ? (hasSidebarToggle ? (libraryExpanded ? 1 : null) : 1)
      : active === 'organizer'
        ? 2
        : null
  const targetNotebookOpen = hasSidebarToggle ? Boolean(libraryExpanded) : false

  const [displayTopIndex, setDisplayTopIndex] = useState<number | null>(targetTopIndex)
  const [displayNotebookOpen, setDisplayNotebookOpen] = useState<boolean>(targetNotebookOpen)
  const [lastTopSlot, setLastTopSlot] = useState<number>(() => targetTopIndex ?? 1)
  const [suppressThumbTransition, setSuppressThumbTransition] = useState(false)
  const navGroupRef = useRef<HTMLDivElement>(null)
  const prevTopIndexRef = useRef<number | null>(targetTopIndex)
  const lastTopSlotRef = useRef<number>(targetTopIndex ?? 1)

  const activeCount = useDistillQueueStore(state => state.activeCount)
  const recentCount = useDistillQueueStore(state => state.recentJobs.length)
  const panelOpen = useDistillQueueStore(state => state.panelOpen)
  const setPanelOpen = useDistillQueueStore(state => state.setPanelOpen)
  const [hoverPopoverOpen, setHoverPopoverOpen] = useState(false)
  const createWrapRef = useRef<HTMLDivElement>(null)
  const hoverOpenTimerRef = useRef<number | null>(null)
  const hoverCloseTimerRef = useRef<number | null>(null)

  const clearHoverTimers = useCallback(() => {
    if (hoverOpenTimerRef.current !== null) {
      window.clearTimeout(hoverOpenTimerRef.current)
      hoverOpenTimerRef.current = null
    }
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current)
      hoverCloseTimerRef.current = null
    }
  }, [])

  const isCreateView = active === 'create'
  const showQueuePopover = panelOpen || (isCreateView && hoverPopoverOpen)
  const badgeText = activeCount > 99 ? '99+' : String(activeCount)
  const createTitle = activeCount > 0
    ? (isCreateView
        ? `新建笔记（${activeCount} 个任务蒸馏中，悬停或点击角标查看队列）`
        : `新建笔记（${activeCount} 个任务蒸馏中，点击右下角数字查看队列）`)
    : (isCreateView ? '新建笔记（右键查看蒸馏队列）' : '新建笔记')

  const handleQueueHoverEnter = useCallback(() => {
    clearHoverTimers()
    if (!isCreateView) return
    if (activeCount === 0 && recentCount === 0) return
    hoverOpenTimerRef.current = window.setTimeout(() => {
      setHoverPopoverOpen(true)
    }, 200)
  }, [activeCount, clearHoverTimers, isCreateView, recentCount])

  const handleQueueHoverLeave = useCallback(() => {
    clearHoverTimers()
    if (!isCreateView) return
    hoverCloseTimerRef.current = window.setTimeout(() => {
      setHoverPopoverOpen(false)
    }, 220)
  }, [clearHoverTimers, isCreateView])

  useEffect(() => {
    if (!isCreateView) {
      clearHoverTimers()
      setHoverPopoverOpen(false)
    }
  }, [clearHoverTimers, isCreateView])

  useEffect(() => () => clearHoverTimers(), [clearHoverTimers])

  useEffect(() => {
    if (!showQueuePopover) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target) return
      if (createWrapRef.current?.contains(target)) return
      if (target.closest('#distill-queue-popover, [data-queue-trigger]')) return
      setPanelOpen(false)
      setHoverPopoverOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPanelOpen(false)
        setHoverPopoverOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [setPanelOpen, showQueuePopover])

  useLayoutEffect(() => {
    if (!isVisibleRoute) return
    const prevTopIndex = prevTopIndexRef.current
    prevTopIndexRef.current = targetTopIndex
    setDisplayNotebookOpen(targetNotebookOpen)

    // Re-appearing from null (e.g. Settings -> Notes or collapsed -> expanded):
    // snap the hidden thumb directly onto the target slot first so it fades in place
    // instead of flashing or sliding from a stale slot such as Create.
    if (
      prevTopIndex === null
      && targetTopIndex !== null
      && lastTopSlotRef.current !== targetTopIndex
      && !prefersReducedMotion()
    ) {
      lastTopSlotRef.current = targetTopIndex
      setSuppressThumbTransition(true)
      setLastTopSlot(targetTopIndex)
      setDisplayTopIndex(null)
      let frame2 = 0
      const frame1 = window.requestAnimationFrame(() => {
        void navGroupRef.current?.offsetHeight
        setSuppressThumbTransition(false)
        frame2 = window.requestAnimationFrame(() => {
          setDisplayTopIndex(targetTopIndex)
        })
      })
      return () => {
        window.cancelAnimationFrame(frame1)
        if (frame2) window.cancelAnimationFrame(frame2)
      }
    }

    setSuppressThumbTransition(false)
    setDisplayTopIndex(targetTopIndex)
    if (targetTopIndex !== null) {
      lastTopSlotRef.current = targetTopIndex
      setLastTopSlot(targetTopIndex)
    }
  }, [isVisibleRoute, location.pathname, targetTopIndex, targetNotebookOpen])

  useEffect(() => () => {
    if (slideTimerRef.current !== null) window.clearTimeout(slideTimerRef.current)
  }, [])

  const handleThemeSelect = (nextMode: ThemeModeId, event: MouseEvent<HTMLButtonElement>) => {
    if (nextMode === activeMode) return

    if (slideTimerRef.current !== null) {
      window.clearTimeout(slideTimerRef.current)
      slideTimerRef.current = null
    }

    const root = document.documentElement
    const currentIsDark = root.classList.contains('dark')
    const targetIsDark = resolveTargetDark(nextMode)
    const doc = document as DocumentWithViewTransition

    // If visual polarity doesn't change (e.g., dark -> system when OS is dark), slide only the thumb.
    if (currentIsDark === targetIsDark || !doc.startViewTransition || prefersReducedMotion()) {
      setPendingMode(null)
      setTheme(nextMode)
      return
    }

    const buttonEl = event.currentTarget
    const seq = ++transitionSeqRef.current

    // Slide the pill thumb onto the clicked button first so the radial wave emerges right from it.
    setPendingMode(nextMode)

    slideTimerRef.current = window.setTimeout(() => {
      slideTimerRef.current = null
      if (transitionSeqRef.current !== seq) return

      const rect = buttonEl.getBoundingClientRect()
      const vw = Math.max(1, root.clientWidth || window.innerWidth)
      const vh = Math.max(1, root.clientHeight || window.innerHeight)
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      const startRadius = Math.min(rect.width, rect.height) / 2
      const maxRadius = Math.hypot(Math.max(x, vw - x), Math.max(y, vh - y))

      // Use percentage coordinates & percentage radii so ::view-transition-*(root) stays locked
      // to the exact button center across all Windows DPI scaling levels (100% / 125% / 150% / 200%).
      const xPct = ((x / vw) * 100).toFixed(3)
      const yPct = ((y / vh) * 100).toFixed(3)
      const refLength = Math.hypot(vw, vh) / Math.SQRT2
      const startPct = ((startRadius / refLength) * 100).toFixed(3)
      const endPct = (((maxRadius / refLength) * 100) + 1).toFixed(3)

      let styleEl = document.getElementById('bilinote-theme-vt-style') as HTMLStyleElement | null
      if (!styleEl) {
        styleEl = document.createElement('style')
        styleEl.id = 'bilinote-theme-vt-style'
        document.head.appendChild(styleEl)
      }
      styleEl.textContent = targetIsDark
        ? `@keyframes bilinote-theme-radial{from{clip-path:circle(${startPct}% at ${xPct}% ${yPct}%)}to{clip-path:circle(${endPct}% at ${xPct}% ${yPct}%)}}html[data-theme-transition="to-dark"]::view-transition-new(root){animation:bilinote-theme-radial 380ms cubic-bezier(0.4,0,0.2,1) both;}`
        : `@keyframes bilinote-theme-radial{from{clip-path:circle(${endPct}% at ${xPct}% ${yPct}%)}to{clip-path:circle(${startPct}% at ${xPct}% ${yPct}%)}}html[data-theme-transition="to-light"]::view-transition-old(root){animation:bilinote-theme-radial 360ms cubic-bezier(0.4,0,0.2,1) both;}`

      root.dataset.themeTransition = targetIsDark ? 'to-dark' : 'to-light'

      const transition = doc.startViewTransition!(() => {
        root.classList.remove(targetIsDark ? 'light' : 'dark')
        root.classList.add(targetIsDark ? 'dark' : 'light')
        root.style.colorScheme = targetIsDark ? 'dark' : 'light'
        flushSync(() => {
          setPendingMode(null)
          setTheme(nextMode)
        })
      })

      transition.finished
        .catch(() => undefined)
        .finally(() => {
          if (transitionSeqRef.current !== seq) return
          delete root.dataset.themeTransition
          document.getElementById('bilinote-theme-vt-style')?.remove()
        })
    }, 95)
  }

  const libraryButtonClass = hasSidebarToggle
    ? libraryExpanded
      ? 'workspace-icon workspace-icon--active'
      : active === 'library'
        ? 'workspace-icon workspace-icon--current'
        : 'workspace-icon'
    : `workspace-icon ${active === 'library' ? 'workspace-icon--active' : ''}`

  return (
    <nav className="workspace-rail" aria-label="主导航">
      <div
        ref={navGroupRef}
        className="workspace-rail-nav-group"
        data-active-slot={displayTopIndex ?? lastTopSlot}
        data-has-active={displayTopIndex !== null ? 'true' : 'false'}
        data-no-transition={suppressThumbTransition ? 'true' : undefined}
      >
        <span className="workspace-rail-active-thumb" aria-hidden="true" />
        <div
          ref={createWrapRef}
          className="workspace-rail-create-wrap"
          onPointerEnter={handleQueueHoverEnter}
          onPointerLeave={handleQueueHoverLeave}
          onContextMenu={(event) => {
            event.preventDefault()
            clearHoverTimers()
            setHoverPopoverOpen(false)
            setPanelOpen(!panelOpen)
          }}
        >
          {onCreateClick ? (
            <button
              type="button"
              className={`workspace-icon ${active === 'create' ? 'workspace-icon--active' : ''}`}
              aria-pressed={active === 'create'}
              aria-expanded={showQueuePopover}
              aria-controls={showQueuePopover ? 'distill-queue-popover' : undefined}
              title={createTitle}
              aria-label={createTitle}
              onClick={() => {
                setPanelOpen(false)
                setHoverPopoverOpen(false)
                onCreateClick()
              }}
            >
              <AnimatedCreateNoteIcon active={activeCount > 0} size={17} />
            </button>
          ) : (
            <Link
              to="/?view=create"
              className={`workspace-icon ${active === 'create' ? 'workspace-icon--active' : ''}`}
              aria-current={active === 'create' ? 'page' : undefined}
              title={createTitle}
              aria-label={createTitle}
              onClick={() => {
                setPanelOpen(false)
                setHoverPopoverOpen(false)
              }}
            >
              <AnimatedCreateNoteIcon active={activeCount > 0} size={17} />
            </Link>
          )}
          <button
            type="button"
            className="workspace-rail-badge"
            data-visible={activeCount > 0 ? 'true' : 'false'}
            data-wide={activeCount >= 10 ? 'true' : 'false'}
            tabIndex={activeCount > 0 ? 0 : -1}
            aria-hidden={activeCount === 0}
            aria-label={`正在蒸馏 ${activeCount} 个任务，点击查看队列`}
            title={`查看蒸馏队列（${activeCount} 个进行中）`}
            onClick={(event) => {
              event.stopPropagation()
              clearHoverTimers()
              setHoverPopoverOpen(false)
              setPanelOpen(!panelOpen)
            }}
          >
            {activeCount > 0 ? badgeText : ''}
          </button>
        </div>
        {showQueuePopover && (
          <DistillQueuePanel
            variant="popover"
            onClose={() => {
              setPanelOpen(false)
              setHoverPopoverOpen(false)
            }}
            onPointerEnter={clearHoverTimers}
            onPointerLeave={handleQueueHoverLeave}
          />
        )}

        {onLibraryClick ? (
          <button
            ref={libraryButtonRef}
            type="button"
            className={libraryButtonClass}
            aria-pressed={Boolean(libraryExpanded)}
            aria-expanded={libraryExpanded}
            aria-controls={hasSidebarToggle ? 'workspace-note-sidebar' : undefined}
            title={libraryTitle}
            aria-label={libraryTitle}
            onClick={onLibraryClick}
          >
            <AnimatedNotebookIcon open={displayNotebookOpen} size={17} />
          </button>
        ) : (
          <Link
            to="/?view=read"
            className={libraryButtonClass}
            aria-current={active === 'library' ? 'page' : undefined}
            title={libraryLabel}
            aria-label={libraryLabel}
          >
            <AnimatedNotebookIcon open={displayNotebookOpen} size={17} />
          </Link>
        )}

        {!isQuickEdition && (
          <Link
            to="/organizer"
            className={`workspace-icon ${active === 'organizer' ? 'workspace-icon--active' : ''}`}
            aria-current={active === 'organizer' ? 'page' : undefined}
            title="资料库助手"
            aria-label="资料库助手"
          >
            <BotMessageSquare size={17} strokeWidth={1.6} />
          </Link>
        )}
      </div>

      <div className="flex-1" />
      <BackendRailStatusButton />

      <div
        className="workspace-theme-pill"
        role="group"
        aria-label="外观模式"
        data-active-index={activeThemeIndex}
      >
        <span className="workspace-theme-thumb" aria-hidden="true" />
        {themeModes.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className="workspace-theme-btn"
            aria-pressed={activeMode === id}
            title={label}
            aria-label={label}
            onClick={event => handleThemeSelect(id, event)}
          >
            <Icon size={13} strokeWidth={1.6} aria-hidden="true" />
          </button>
        ))}
      </div>

      {active === 'settings' ? (
        <span
          className="workspace-icon workspace-icon--active workspace-icon--settings-enter"
          title="设置"
          aria-label="设置"
          aria-current="page"
        >
          <Settings2 size={17} strokeWidth={1.6} />
        </span>
      ) : (
        <Link
          to="/settings"
          className="workspace-icon"
          title="设置"
          aria-label="设置"
        >
          <Settings2 size={17} strokeWidth={1.6} />
        </Link>
      )}
    </nav>
  )
}
