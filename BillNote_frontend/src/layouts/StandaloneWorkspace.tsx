import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen, BotMessageSquare, Settings2, SquarePen } from 'lucide-react'
import AccentSettings from '@/components/AccentSettings'
import './workspace.css'
import { isQuickEdition } from '@/utils/edition'
export default function StandaloneWorkspace({ children }: { children: ReactNode }) {
  return <div className="workspace workspace--collapsed"><nav className="workspace-rail" aria-label="主导航">
    <Link to="/?view=create" className="workspace-icon" title="新建笔记" aria-label="新建笔记"><SquarePen size={19} /></Link>
    <Link to="/?view=read" className="workspace-icon" title="笔记库" aria-label="笔记库"><BookOpen size={19} /></Link>
    {!isQuickEdition && <Link to="/organizer" className="workspace-icon workspace-icon--active" title="整理助手" aria-label="整理助手" aria-current="page"><BotMessageSquare size={19} /></Link>}
    <div className="flex-1" /><AccentSettings rail />
    <Link to="/settings" className="workspace-icon" title="设置" aria-label="设置"><Settings2 size={19} /></Link>
  </nav><main className="workspace-main">{children}</main></div>
}
