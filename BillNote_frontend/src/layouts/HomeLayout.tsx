import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { resolveSidebarTransition, type SidebarSnapshot } from '@/utils/sidebarTransition'
import WorkspaceRail from './WorkspaceRail'
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
  const previousView = useRef<SidebarSnapshot | null>(null)
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
    updateOverlap()
    media.addEventListener('change', updateOverlap)
    return () => media.removeEventListener('change', updateOverlap)
  }, [])

  useEffect(() => {
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
  }, [expanded, sidebarOverlaps, setExpanded])

  // Restore hidden routes before paint. Visible view changes animate in either
  // direction; manual toggles retain their own transition setting.
  useLayoutEffect(() => {
    if (animate !== null) setSidebarAnimated(animate)
    if (resetCreate) setCreateExpanded(false)
    previousView.current = transition.snapshot
  }, [animate, resetCreate, transition.snapshot])

  const [leftSlot, setLeftSlot] = useState<HTMLDivElement | null>(null)
  const [rightSlot, setRightSlot] = useState<HTMLDivElement | null>(null)
  const [hasTopbarOwner, setHasTopbarOwner] = useState(false)
  const previewActive = !(composing && !hasTask)
  const closeSidebar = useCallback(() => setExpanded(false), [setExpanded])
  const topbarContext = useMemo(
    () => ({
      active: previewActive,
      leftSlot,
      rightSlot,
      onConfigure: hasTask ? onConfigure : undefined,
      closeSidebar,
      setHasTopbarOwner,
    }),
    [previewActive, leftSlot, rightSlot, hasTask, onConfigure, closeSidebar],
  )

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!expanded || !sidebarOverlaps) return
    const target = event.target as Element | null
    if (target && !target.closest('[role="dialog"], [data-radix-popper-content-wrapper]')) {
      setExpanded(false)
    }
  }

  return <WorkspaceTopbarContext.Provider value={topbarContext}>
    <div
      className={`workspace ${sidebarAnimated ? 'workspace--sidebar-animate' : ''} ${!expanded ? 'workspace--collapsed' : ''} ${expanded ? 'workspace--notes-open' : ''}`}
      data-sidebar-overlaps={sidebarOverlaps ? 'true' : undefined}
    >
    <WorkspaceRail
      active={composing && !hasTask ? 'create' : 'library'}
      libraryExpanded={expanded}
      libraryButtonRef={expandRef}
      onCreateClick={() => {
        setSidebarAnimated(location.pathname === '/' && expanded)
        setCreateExpanded(false)
        onCreate()
      }}
      onLibraryClick={() => {
        if (!composing) setExpanded(!expanded)
        else {
          onRead()
          setExpanded(true)
        }
      }}
    />
    <div className="workspace-frame">
    <aside ref={sidebarRef} id="workspace-note-sidebar" className="workspace-sidebar" aria-label="笔记导航" aria-hidden={!expanded} inert={!expanded}>
      <div className="workspace-sidebar-inner">
        <div className="workspace-library" onClick={event => { if ((event.target as HTMLElement).closest('[data-note-select], [data-search-hit]') && sidebarOverlaps) setExpanded(false) }}>{History(closeSidebar)}</div>
      </div>
    </aside>
    <main className="workspace-main">
      <header className="workspace-topbar">
        <div className="workspace-tab" title={composing && !hasTask ? '新建笔记' : title}><span>{composing && !hasTask ? '新建笔记' : title}</span></div>
        <div ref={setLeftSlot} className="workspace-topbar-left" />
        <div ref={setRightSlot} className="workspace-topbar-right" />
        {previewActive && hasTask && !hasTopbarOwner && <button type="button" className="workspace-toolbar-button ml-auto" onClick={onConfigure}><SlidersHorizontal size={15} strokeWidth={1.6} /><span>生成设置</span></button>}
      </header>
      <div ref={bodyRef} className="workspace-body">
        {!hasTask && <div className={composing ? 'workspace-compose' : 'hidden'} onPointerDown={handleCanvasPointerDown}>
          <div className="workspace-compose-inner">
            <div className="workspace-compose-heading"><h1>{hasTask ? '生成新的笔记版本' : '新建视频笔记'}</h1></div>
            <div className="workspace-composer">{NoteForm}</div>
          </div>
        </div>}
        <div className={composing && !hasTask ? 'hidden' : 'workspace-preview'} onPointerDown={handleCanvasPointerDown}>{Preview}</div>
      </div>
      {hasTask && <Dialog open={composing && location.pathname === '/'} onOpenChange={open => { if (!open) onRead() }}><DialogContent className="note-generation-window"><DialogHeader><DialogTitle>生成设置</DialogTitle><DialogDescription className="truncate">{title}</DialogDescription></DialogHeader><div className="note-generation-window-body">{ConfigureForm ?? NoteForm}</div></DialogContent></Dialog>}
    </main>
    </div>
  </div>
  </WorkspaceTopbarContext.Provider>
}
