import AccentSettings from '@/components/AccentSettings'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { BookOpen, PanelLeftClose, PanelLeftOpen, Settings2, SquarePen, SlidersHorizontal, BotMessageSquare } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { resolveSidebarTransition, type SidebarSnapshot } from '@/utils/sidebarTransition'
import './workspace.css'
import { isQuickEdition } from '@/utils/edition'

interface Props {
  NoteForm: ReactNode
  Preview: ReactNode
  History: ReactNode
  composing: boolean
  hasTask: boolean
  title: string
  onCreate: () => void
  onRead: () => void
  onConfigure: () => void
}

export default function HomeLayout({ NoteForm, Preview, History, composing, hasTask, title, onCreate, onRead, onConfigure }: Props) {
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
  const setExpanded = (open: boolean) => {
    setSidebarAnimated(true)
    if (!open && sidebarRef.current?.contains(document.activeElement)) requestAnimationFrame(() => expandRef.current?.focus())
    if (creating) setCreateExpanded(open)
    else {
      setReadingExpanded(open)
      try { localStorage.setItem('bilinote-reading-sidebar-v1', open ? 'open' : 'closed') } catch { /* Session state still works. */ }
    }
  }
  // Restore hidden routes before paint. Visible view changes animate in either
  // direction; manual toggles retain their own transition setting.
  useLayoutEffect(() => {
    if (animate !== null) setSidebarAnimated(animate)
    if (resetCreate) setCreateExpanded(false)
    previousView.current = transition.snapshot
  }, [animate, resetCreate, transition.snapshot])
  const closeMobileSidebar = () => {
    if (window.matchMedia('(max-width: 760px)').matches) setExpanded(false)
  }
  return <div className={`workspace ${sidebarAnimated ? 'workspace--sidebar-animate' : ''} ${!expanded ? 'workspace--collapsed' : ''} ${expanded ? 'workspace--notes-open' : ''}`}>
    <nav className="workspace-rail" aria-label="主导航">
      <button className={`workspace-icon ${composing && !hasTask ? 'workspace-icon--active' : ''}`} aria-pressed={composing && !hasTask} title="新建笔记" aria-label="新建笔记" onClick={() => { setSidebarAnimated(location.pathname === '/' && expanded); setCreateExpanded(false); onCreate() }}><SquarePen size={19} /></button>
      <button className={`workspace-icon ${!composing || hasTask ? 'workspace-icon--active' : ''}`} aria-pressed={!composing || hasTask} title="笔记库" aria-label="笔记库" onClick={() => { onRead() }}><BookOpen size={19} /></button>
      {!isQuickEdition && <Link className="workspace-icon" to="/organizer" title="整理助手" aria-label="整理助手"><BotMessageSquare size={19} /></Link>}
      <div className="flex-1" />
      <AccentSettings rail />
      <Link className="workspace-icon" to="/settings" title="设置" aria-label="设置"><Settings2 size={19} /></Link>
    </nav>
    <aside ref={sidebarRef} id="workspace-note-sidebar" className="workspace-sidebar" aria-label="笔记导航" aria-hidden={!expanded} inert={!expanded}>
      <div className="workspace-sidebar-inner">
      <header className="workspace-brand"><span>BiliNote Studio<span className="workspace-brand-sub">工作台</span></span><button className="workspace-icon" title="收起笔记栏" aria-label="收起笔记栏" onClick={() => { setExpanded(false) }}><PanelLeftClose size={17} /></button></header>
      <div className="workspace-library" onClick={event => { if ((event.target as HTMLElement).closest('[data-note-select]')) closeMobileSidebar() }}>{History}</div>
      </div>
    </aside>
    <button className="workspace-scrim" aria-label="关闭笔记导航" aria-hidden={!expanded} tabIndex={-1} disabled={!expanded} onClick={() => setExpanded(false)} />
    <main className="workspace-main">
      <header className="workspace-topbar">
        <button ref={expandRef} className="workspace-icon workspace-expand" title="展开笔记栏" aria-label="展开笔记栏" aria-expanded={expanded} aria-controls="workspace-note-sidebar" onClick={() => { setExpanded(true) }}><PanelLeftOpen size={18} /></button>
        <div className="workspace-tab">{composing && !hasTask && <SquarePen size={15} />}<span>{composing ? (hasTask ? '生成设置' : '新建笔记') : title}</span></div>
        <div className="flex-1" />
        {hasTask && <button className="workspace-toolbar-button" onClick={composing ? onRead : onConfigure}>{composing ? <BookOpen size={15} /> : <SlidersHorizontal size={15} />}{composing ? '返回阅读' : '生成设置'}</button>}
      </header>
      <div className={composing ? 'workspace-compose' : 'hidden'}>
        <div className="workspace-compose-inner">
          <div className="workspace-compose-heading"><div className="workspace-compose-symbol"><BookOpen size={27} strokeWidth={1.4} /></div><h1>{hasTask ? '调整这篇笔记' : '把视频，变成你的知识。'}</h1><p>{hasTask ? '调整模型与整理方式，生成一个新的笔记版本。' : '粘贴视频链接或上传文件，开始整理、阅读与学习。'}</p></div>
          <div className="workspace-composer">{NoteForm}</div>
          <p className="workspace-compose-hint">支持哔哩哔哩、YouTube、快手及本地视频</p>
        </div>
      </div>
      <div className={composing ? 'hidden' : 'workspace-preview'}>{Preview}</div>
    </main>
  </div>
}
