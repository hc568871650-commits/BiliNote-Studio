export type WorkspaceView = 'create' | 'read' | 'configure'
export interface SidebarSnapshot {
  pathname: string
  search: string
  key: string
  view: WorkspaceView
  expanded: boolean
}
interface Input {
  pathname: string
  search: string
  key: string
  view: WorkspaceView
  createExpanded: boolean
  readingExpanded: boolean
}

/** Route restoration is synchronous; animate only a change between visible views. */
export function resolveSidebarTransition(previous: SidebarSnapshot | null, input: Input) {
  const newRoute = !previous || previous.pathname !== input.pathname
    || previous.key !== input.key || previous.search !== input.search
  const request = newRoute && input.pathname === '/'
    ? new URLSearchParams(input.search).get('view') : null
  const view = request === 'create' ? 'create' : request === 'read' ? 'read' : input.view
  const navigationChanged = newRoute || previous?.view !== view
  const resetCreate = view === 'create' && (request === 'create' || previous?.view !== 'create')
  const expanded = resetCreate ? false : view === 'create' ? input.createExpanded : input.readingExpanded
  // null preserves the animation already enabled by a manual sidebar toggle.
  const animate = navigationChanged ? Boolean(previous
    && previous.pathname === '/' && input.pathname === '/'
    && previous.expanded !== expanded) : null
  return {
    snapshot: { pathname: input.pathname, search: input.search, key: input.key, view, expanded } satisfies SidebarSnapshot,
    creating: view === 'create', expanded, resetCreate, animate,
  }
}
