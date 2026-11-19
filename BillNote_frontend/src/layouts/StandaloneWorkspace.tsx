import type { ReactNode } from 'react'
import WorkspaceRail from './WorkspaceRail'
import './workspace.css'

export default function StandaloneWorkspace({ children }: { children: ReactNode }) {
  return (
    <div className="workspace workspace--collapsed">
      <WorkspaceRail active="organizer" />
      <div className="workspace-frame workspace-route-enter">
        <main className="workspace-main">{children}</main>
      </div>
    </div>
  )
}
