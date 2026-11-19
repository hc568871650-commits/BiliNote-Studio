import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import WorkspaceRail from './WorkspaceRail'
import './settings.css'
const positions = new Map<string, number>()
const sections = ['general', 'appearance', 'model', 'transcriber', 'download', 'monitor', 'about']

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
    <WorkspaceRail active="settings" libraryLabel="返回笔记库" />
    <div className="settings-frame workspace-route-enter">
      <aside className="settings-categories" aria-label="设置分类">{Menu}</aside>
      <div className={`settings-detail${providerDetail ? ' settings-detail--with-back' : ''}`}>
        {providerDetail && <nav className="settings-detail-navigation" aria-label="返回导航"><button type="button" className="settings-back-arrow" aria-label="返回模型与 API" title="返回模型与 API" onClick={() => navigate('/settings/model')}><ArrowLeft size={15} strokeWidth={1.6} aria-hidden="true" /><span>模型与 API</span></button></nav>}
        <main ref={content} className="settings-content" onScroll={event => positions.set(location.pathname, event.currentTarget.scrollTop)}><Outlet /></main>
      </div>
    </div>
  </div>
}
