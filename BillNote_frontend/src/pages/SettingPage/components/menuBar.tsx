import { type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'

export interface IMenuProps { id: string; name: string; icon: ReactNode; path: string }
export default function MenuBar({ menuItem }: { menuItem: IMenuProps }) {
  const { pathname } = useLocation()
  const active = pathname === menuItem.path || pathname.startsWith(menuItem.path + '/')
  return <Link to={menuItem.path} className={`settings-menu-item ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined}>{menuItem.icon}<span>{menuItem.name}</span></Link>
}
