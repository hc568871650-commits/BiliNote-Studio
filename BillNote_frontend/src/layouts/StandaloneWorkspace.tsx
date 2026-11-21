import type { ReactNode } from 'react'
import WorkspaceRail from './WorkspaceRail'
import { useWorkspaceShell } from './WorkspaceShellContext'
import './workspace.css'

export default function StandaloneWorkspace({ children }: { children: ReactNode }) {
  const { shared } = useWorkspaceShell()
  if (shared) return <>{children}</>
  return (
    <div className="workspace workspace--collapsed">
      <WorkspaceRail active="organizer" />
      <div className="workspace-frame workspace-route-enter">
        <main className="workspace-main">{children}</main>
      </div>
    </div>
  )
}
