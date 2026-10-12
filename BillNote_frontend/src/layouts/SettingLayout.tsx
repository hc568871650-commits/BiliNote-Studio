import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { BookOpen, Settings2, SquarePen, BotMessageSquare, ArrowLeft } from 'lucide-react'
import './settings.css'
import { isQuickEdition } from '@/utils/edition'
const positions = new Map<string, number>()
const sections = ['general', 'purposes', 'appearance', 'model', 'transcriber', 'download', 'monitor', 'about']

export default function SettingLayout({ Menu }: { Menu: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const providerDetail = /^\/settings\/model\/[^/]+\/?$/.test(location.pathname)
  const content = useRef<HTMLElement>(null)
  useEffect(() => {
    if (sections.some(section => location.pathname === `/settings/${section}` || location.pathname.startsWith(`/settings/${section}/`))) {
      try { sessionStorage.setItem('bilinote-last-setting', location.pathname) } catch { /* Navigation still works. */ }
    }
  }, [location.pathname])
  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    const position = positions.get(location.pathname) || 0
    element.scrollTop = position
    const observer = new ResizeObserver(() => { if (element.scrollTop < position) element.scrollTop = position })
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    const timeout = window.setTimeout(() => observer.disconnect(), 1500)
    return () => { observer.disconnect(); clearTimeout(timeout) }
  }, [location.pathname])
  return <div className="settings-shell">
    <nav className="settings-rail" aria-label="主导航">
      <Link to="/?view=create" className="settings-rail-icon" title="新建笔记" aria-label="新建笔记"><SquarePen size={19} /></Link>
      <Link to="/?view=read" className="settings-rail-icon" title="返回笔记库" aria-label="返回笔记库"><BookOpen size={19} /></Link>
      {!isQuickEdition && <Link to="/organizer" className="settings-rail-icon" title="资料库助手" aria-label="资料库助手"><BotMessageSquare size={19} /></Link>}
      <div className="flex-1" />
      <span className="settings-rail-icon is-active" aria-label="设置" aria-current="page"><Settings2 size={19} /></span>
    </nav>
    <div className="settings-frame">
      <aside className="settings-categories" aria-label="设置分类">{Menu}</aside>
      <div className={`settings-detail${providerDetail ? ' settings-detail--with-back' : ''}`}>
        {providerDetail && <nav className="settings-detail-navigation" aria-label="返回导航"><button type="button" className="settings-back-arrow" aria-label="返回服务商列表" title="返回服务商列表" onClick={() => navigate('/settings/model')}><ArrowLeft size={20} aria-hidden="true" /></button></nav>}
        <main ref={content} className="settings-content" onScroll={event => positions.set(location.pathname, event.currentTarget.scrollTop)}><Outlet /></main>
      </div>
    </div>
  </div>
}
