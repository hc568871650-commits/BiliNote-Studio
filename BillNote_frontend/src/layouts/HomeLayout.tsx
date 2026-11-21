import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Layers, SlidersHorizontal } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { resolveSidebarTransition, type SidebarSnapshot } from '@/utils/sidebarTransition'
import { useDistillQueueStore } from '@/store/distillQueueStore'
import WorkspaceRail from './WorkspaceRail'
import { useWorkspaceShell } from './WorkspaceShellContext'
import { WorkspaceTopbarContext } from './WorkspaceTopbarContext'
import './topbar.css'
import './workspace.css'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

interface Props {
  NoteForm: ReactNode
  ConfigureForm?: ReactNode
  Preview: ReactNode
  History: (onCollapse: () => void) => ReactNode
  composing: boolean
  hasTask: boolean
  title: string
  onCreate: () => void
  onRead: () => void
  onConfigure: () => void
}

export default function HomeLayout({ NoteForm, ConfigureForm, Preview, History, composing, hasTask, title, onCreate, onRead, onConfigure }: Props) {
  const location = useLocation()
  const { shared, routeMode, outlet } = useWorkspaceShell()
  const isHomeRoute = !shared || routeMode === 'home'
  const isOrganizerRoute = shared && routeMode === 'organizer'
  const isSettingsRoute = shared && routeMode === 'settings'
  const previousView = useRef<SidebarSnapshot | null>(null)
  const previousRouteModeRef = useRef(routeMode)
  const previousEffectiveExpandedRef = useRef<boolean | null>(null)
  const [createExpanded, setCreateExpanded] = useState(false)
  const [sidebarAnimated, setSidebarAnimated] = useState(false)
  const [readingExpanded, setReadingExpanded] = useState(() => {
    try {
      const saved = localStorage.getItem('bilinote-reading-sidebar-v1')
      if (saved !== null) return saved === 'open'
    } catch { /* Sidebar remains usable when storage is unavailable. */ }
    return !window.matchMedia('(max-width: 760px)').matches
  })
  const transition = resolveSidebarTransition(previousView.current, {
    pathname: location.pathname, search: location.search, key: location.key,
    view: composing ? hasTask ? 'configure' : 'create' : 'read',
    createExpanded, readingExpanded,
  })
  const { creating, expanded, resetCreate, animate } = transition
  const effectiveExpanded = isHomeRoute ? expanded : false
  // Smoothly animate the real sidebar when switching between Home and sidebar-less Organizer,
  // avoid colliding with Settings' own category sidebar, and never cancel an in-flight
  // sidebar animation when same-route URL query sync commits a second render with unchanged expanded state.
  const homeOrganizerSwitch = shared && (
    (previousRouteModeRef.current === 'home' && routeMode === 'organizer')
    || (previousRouteModeRef.current === 'organizer' && routeMode === 'home')
  )
  const sameHomeRouteUnchanged = isHomeRoute
    && previousRouteModeRef.current === 'home'
    && previousView.current?.pathname === '/'
    && previousView.current?.expanded === effectiveExpanded
  const routeSidebarAnimate: boolean | null = homeOrganizerSwitch
    ? (previousEffectiveExpandedRef.current !== null && previousEffectiveExpandedRef.current !== effectiveExpanded ? true : null)
    : previousRouteModeRef.current !== routeMode
      ? false
      : sameHomeRouteUnchanged
        ? null
        : animate
  const effectiveSidebarAnimated = routeSidebarAnimate !== null ? routeSidebarAnimate : sidebarAnimated
  const sidebarRef = useRef<HTMLElement>(null)
  const expandRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [sidebarOverlaps, setSidebarOverlaps] = useState(false)

  const setExpanded = useCallback((open: boolean) => {
    setSidebarAnimated(true)
    if (open) window.dispatchEvent(new Event('bilinote-close-outline'))
    if (!open && sidebarRef.current?.contains(document.activeElement)) {
      requestAnimationFrame(() => expandRef.current?.focus())
    }
    if (creating) setCreateExpanded(open)
    else {
      setReadingExpanded(open)
      try { localStorage.setItem('bilinote-reading-sidebar-v1', open ? 'open' : 'closed') } catch { /* Session state still works. */ }
    }
  }, [creating])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const updateOverlap = () => setSidebarOverlaps(media.matches)
    const handleMediaChange = () => {
      setSidebarAnimated(false)
      setSidebarOverlaps(media.matches)
    }
    updateOverlap()
    media.addEventListener('change', handleMediaChange)
    return () => media.removeEventListener('change', handleMediaChange)
  }, [])

  // Clear the sidebar animation flag once the 320ms transition finishes so later
  // window resizes across the 760px breakpoint never replay a phantom width jump.
  useEffect(() => {
    if (!sidebarAnimated) return
    const timer = window.setTimeout(() => setSidebarAnimated(false), 380)
    return () => window.clearTimeout(timer)
  }, [sidebarAnimated, effectiveExpanded])

  useEffect(() => {
    if (!isHomeRoute) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const hasModalOrFocusReader = Boolean(
        document.querySelector('[role="dialog"], .fixed.z-40[aria-label="笔记阅读器"]'),
      )
      if (!event.altKey && !event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        if (hasModalOrFocusReader) return
        event.preventDefault()
        setExpanded(!expanded)
        return
      }
      if (event.key === 'Escape' && expanded) {
        if (hasModalOrFocusReader || document.querySelector('[data-radix-popper-content-wrapper], .reader-display-menu')) return
        if (sidebarOverlaps || sidebarRef.current?.contains(document.activeElement)) {
          setExpanded(false)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isHomeRoute, expanded, sidebarOverlaps, setExpanded])

  // Restore hidden routes before paint. Visible view changes animate in either
  // direction; manual toggles retain their own transition setting.
  useLayoutEffect(() => {
    if (routeSidebarAnimate !== null) setSidebarAnimated(routeSidebarAnimate)
    if (resetCreate) setCreateExpanded(false)
    previousView.current = transition.snapshot
    previousRouteModeRef.current = routeMode
    previousEffectiveExpandedRef.current = effectiveExpanded
  }, [routeSidebarAnimate, resetCreate, transition.snapshot, routeMode, effectiveExpanded])

  const [leftSlot, setLeftSlot] = useState<HTMLDivElement | null>(null)
  const [rightSlot, setRightSlot] = useState<HTMLDivElement | null>(null)
  const [hasTopbarOwner, setHasTopbarOwner] = useState(false)
  const activeQueueCount = useDistillQueueStore(state => state.activeCount)
  const queuePanelOpen = useDistillQueueStore(state => state.panelOpen)
  const toggleQueuePanel = useDistillQueueStore(state => state.togglePanel)
  const previewActive = isHomeRoute && !creating
  const closeSidebar = useCallback(() => setExpanded(false), [setExpanded])
  const topbarContext = useMemo(
    () => ({
      active: isHomeRoute,
      leftSlot,
      rightSlot,
      onConfigure: hasTask ? onConfigure : undefined,
      closeSidebar,
      setHasTopbarOwner,
    }),
    [isHomeRoute, leftSlot, rightSlot, hasTask, onConfigure, closeSidebar],
  )

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!effectiveExpanded || !sidebarOverlaps) return
    const target = event.target as Element | null
    if (target && !target.closest('[role="dialog"], [data-radix-popper-content-wrapper]')) {
      setExpanded(false)
    }
  }

  return <WorkspaceTopbarContext.Provider value={topbarContext}>
    <div
      className={`workspace ${effectiveSidebarAnimated ? 'workspace--sidebar-animate' : ''} ${!effectiveExpanded ? 'workspace--collapsed' : ''} ${effectiveExpanded ? 'workspace--notes-open' : ''}`}
      data-sidebar-overlaps={sidebarOverlaps ? 'true' : undefined}
    >
    <WorkspaceRail
      active={isSettingsRoute ? 'settings' : isOrganizerRoute ? 'organizer' : (creating ? 'create' : 'library')}
      libraryExpanded={effectiveExpanded}
      hasSidebarToggle={isHomeRoute}
      libraryButtonRef={expandRef}
      libraryLabel={isSettingsRoute ? '返回笔记库' : '笔记库'}
      onCreateClick={isHomeRoute ? () => {
        setSidebarAnimated(expanded)
        setCreateExpanded(false)
        onCreate()
      } : undefined}
      onLibraryClick={isHomeRoute ? () => {
        if (!creating) setExpanded(!expanded)
        else {
          setSidebarAnimated(readingExpanded)
          onRead()
        }
      } : undefined}
    />
    <div className="workspace-frame" style={isSettingsRoute ? { display: 'none' } : undefined} aria-hidden={isSettingsRoute}>
      <aside ref={sidebarRef} id="workspace-note-sidebar" className="workspace-sidebar" aria-label="笔记导航" aria-hidden={!effectiveExpanded} inert={!effectiveExpanded}>
        <div className="workspace-sidebar-inner">
          <div className="workspace-library" onClick={event => { if ((event.target as HTMLElement).closest('[data-note-select], [data-search-hit]') && sidebarOverlaps) setExpanded(false) }}>{History(closeSidebar)}</div>
        </div>
      </aside>
      <main className="workspace-main" style={isHomeRoute ? undefined : { display: 'none' }} aria-hidden={!isHomeRoute}>
        <header className="workspace-topbar" data-mode={creating ? 'create' : 'read'}>
          <div className="workspace-tab" title={creating ? '新建笔记' : title}>
            <span className={`workspace-tab-label ${creating ? 'is-active' : 'is-inactive'}`} aria-hidden={!creating}>新建笔记</span>
            <span className={`workspace-tab-label ${!creating ? 'is-active' : 'is-inactive'}`} aria-hidden={creating}>{title}</span>
          </div>
          <div ref={setLeftSlot} className="workspace-topbar-left" aria-hidden={creating} inert={creating} />
          <div ref={setRightSlot} className="workspace-topbar-right" aria-hidden={creating} inert={creating} />
          {creating && (
            <button
              type="button"
              data-queue-trigger="true"
              className={`workspace-toolbar-button workspace-queue-trigger ml-auto ${queuePanelOpen ? 'is-open' : ''}`}
              aria-expanded={queuePanelOpen}
              aria-controls={queuePanelOpen ? 'distill-queue-popover' : undefined}
              title={activeQueueCount > 0 ? `查看蒸馏队列（${activeQueueCount} 个进行中）` : '查看蒸馏队列'}
              onClick={toggleQueuePanel}
            >
              <Layers size={14} strokeWidth={1.65} aria-hidden="true" />
              <span>队列</span>
              {activeQueueCount > 0 && (
                <span className="workspace-queue-trigger-count" aria-hidden="true">
                  {activeQueueCount > 99 ? '99+' : activeQueueCount}
                </span>
              )}
            </button>
          )}
          {previewActive && hasTask && !hasTopbarOwner && <button type="button" className="workspace-toolbar-button ml-auto" onClick={onConfigure}><SlidersHorizontal size={15} strokeWidth={1.6} /><span>生成设置</span></button>}
        </header>
        <div ref={bodyRef} className="workspace-body" data-view={creating ? 'create' : 'read'}>
          <div
            className={`workspace-view-layer workspace-compose ${creating ? 'is-active' : 'is-inactive'}`}
            aria-hidden={!creating}
            inert={!creating}
            onPointerDown={handleCanvasPointerDown}
          >
            <div className="workspace-compose-inner">
              <div className="workspace-compose-heading"><h1>新建视频笔记</h1></div>
              <div className="workspace-composer">{NoteForm}</div>
            </div>
          </div>
          <div
            className={`workspace-view-layer workspace-preview ${!creating ? 'is-active' : 'is-inactive'}`}
            aria-hidden={creating}
            inert={creating}
            onPointerDown={handleCanvasPointerDown}
          >
            {Preview}
          </div>
        </div>
        {hasTask && <Dialog open={isHomeRoute && composing && !creating} onOpenChange={open => { if (!open) onRead() }}><DialogContent className="note-generation-window"><DialogHeader><DialogTitle>生成设置</DialogTitle><DialogDescription className="truncate">{title}</DialogDescription></DialogHeader><div className="note-generation-window-body">{ConfigureForm ?? NoteForm}</div></DialogContent></Dialog>}
      </main>
      {isOrganizerRoute && (
        <main className="workspace-main workspace-route-enter">
          {outlet}
        </main>
      )}
    </div>
    {isSettingsRoute && (
      <div className="workspace-settings-stage">
        {outlet}
      </div>
    )}
  </div>
  </WorkspaceTopbarContext.Provider>
}
