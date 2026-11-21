import { createContext, useContext, type ReactNode } from 'react'

export type WorkspaceRouteMode = 'home' | 'organizer' | 'settings'

export interface WorkspaceShellContextValue {
  shared: boolean
  routeMode: WorkspaceRouteMode
  outlet: ReactNode
}

const defaultValue: WorkspaceShellContextValue = {
  shared: false,
  routeMode: 'home',
  outlet: null,
}

export const WorkspaceShellContext = createContext<WorkspaceShellContextValue>(defaultValue)

export function useWorkspaceShell() {
  return useContext(WorkspaceShellContext)
}
