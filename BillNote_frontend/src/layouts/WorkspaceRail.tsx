import { AnimatedNotebookIcon } from '@/components/AnimatedRailIcons'
import { BackendRailStatusButton } from '@/components/BackendHealth/BackendStatusButton'
import { isQuickEdition } from '@/utils/edition'
import { BotMessageSquare, Monitor, Moon, Settings2, SquarePen, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { Link, useLocation } from 'react-router-dom'
import './workspace.css'

export type WorkspaceRailActive = 'create' | 'library' | 'organizer' | 'settings'

interface WorkspaceRailProps {
  active: WorkspaceRailActive
  libraryExpanded?: boolean
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

// Remember the last visible rail state across route switches so the top highlight thumb
// and notebook open/close icon animate smoothly between Home, Organizer, and Settings.
let lastVisibleTopIndex: number | null = null
let lastVisibleNotebookOpen = false
let lastVisibleRouteKey = ''

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
  const hasSidebarToggle = typeof libraryExpanded === 'boolean'
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

  const [displayTopIndex, setDisplayTopIndex] = useState<number | null>(() => (
    isVisibleRoute && lastVisibleRouteKey && lastVisibleRouteKey !== location.pathname
      ? lastVisibleTopIndex
      : targetTopIndex
  ))
  const [displayNotebookOpen, setDisplayNotebookOpen] = useState<boolean>(() => (
    isVisibleRoute && lastVisibleRouteKey && lastVisibleRouteKey !== location.pathname
      ? lastVisibleNotebookOpen
      : targetNotebookOpen
  ))
  const [lastTopSlot, setLastTopSlot] = useState<number>(() => (
    (displayTopIndex ?? targetTopIndex ?? 1)
  ))
  const [suppressThumbTransition, setSuppressThumbTransition] = useState(false)
  const navGroupRef = useRef<HTMLDivElement>(null)
  const prevVisibleRef = useRef(isVisibleRoute)

  useLayoutEffect(() => {
    if (!isVisibleRoute) {
      prevVisibleRef.current = false
      return
    }
    const routeChanged = lastVisibleRouteKey !== '' && lastVisibleRouteKey !== location.pathname
    const returningFromOtherRoute = !prevVisibleRef.current && routeChanged
    prevVisibleRef.current = true

    if ((returningFromOtherRoute || routeChanged) && !prefersReducedMotion()) {
      const fromIndex = lastVisibleTopIndex
      const fromOpen = lastVisibleNotebookOpen
      if (fromIndex !== targetTopIndex || fromOpen !== targetNotebookOpen) {
        // Snap the thumb & notebook icon to the exact previous route position with transitions off,
        // then re-enable transitions on the next frame so it always slides from the true prior tab.
        setSuppressThumbTransition(true)
        setDisplayTopIndex(fromIndex)
        if (fromIndex !== null) setLastTopSlot(fromIndex)
        setDisplayNotebookOpen(fromOpen)
        let frame2 = 0
        const frame1 = window.requestAnimationFrame(() => {
          void navGroupRef.current?.offsetHeight
          setSuppressThumbTransition(false)
          frame2 = window.requestAnimationFrame(() => {
            setDisplayTopIndex(targetTopIndex)
            if (targetTopIndex !== null) setLastTopSlot(targetTopIndex)
            setDisplayNotebookOpen(targetNotebookOpen)
            lastVisibleTopIndex = targetTopIndex
            lastVisibleNotebookOpen = targetNotebookOpen
            lastVisibleRouteKey = location.pathname
          })
        })
        return () => {
          window.cancelAnimationFrame(frame1)
          if (frame2) window.cancelAnimationFrame(frame2)
        }
      }
    }

    setSuppressThumbTransition(false)
    setDisplayTopIndex(targetTopIndex)
    if (targetTopIndex !== null) setLastTopSlot(targetTopIndex)
    setDisplayNotebookOpen(targetNotebookOpen)
    lastVisibleTopIndex = targetTopIndex
    lastVisibleNotebookOpen = targetNotebookOpen
    lastVisibleRouteKey = location.pathname
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
        {onCreateClick ? (
          <button
            type="button"
            className={`workspace-icon ${active === 'create' ? 'workspace-icon--active' : ''}`}
            aria-pressed={active === 'create'}
            title="新建笔记"
            aria-label="新建笔记"
            onClick={onCreateClick}
          >
            <SquarePen size={17} strokeWidth={1.6} />
          </button>
        ) : (
          <Link
            to="/?view=create"
            className={`workspace-icon ${active === 'create' ? 'workspace-icon--active' : ''}`}
            aria-current={active === 'create' ? 'page' : undefined}
            title="新建笔记"
            aria-label="新建笔记"
          >
            <SquarePen size={17} strokeWidth={1.6} />
          </Link>
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
