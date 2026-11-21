import { useMemo } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { HomePage } from '@/pages/HomePage/Home'
import { WorkspaceShellContext, type WorkspaceRouteMode } from '@/layouts/WorkspaceShellContext'
import DistillQueueHost from '@/components/DistillQueue/DistillQueueHost'

const Index = () => {
  const location = useLocation()
  const routeMode: WorkspaceRouteMode = location.pathname === '/'
    ? 'home'
    : location.pathname.startsWith('/organizer')
      ? 'organizer'
      : 'settings'

  const outlet = routeMode === 'home' ? null : <Outlet />
  const shellValue = useMemo(
    () => ({ shared: true, routeMode, outlet }),
    [routeMode, outlet],
  )

  return (
    <WorkspaceShellContext.Provider value={shellValue}>
      <HomePage />
      <DistillQueueHost />
    </WorkspaceShellContext.Provider>
  )
}
export default Index
