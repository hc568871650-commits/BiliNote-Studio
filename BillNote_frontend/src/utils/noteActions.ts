import type { Task, Markdown } from '@/store/taskStore'

export function noteVersions(task: Pick<Task, 'markdown'>): Markdown[] {
  return Array.isArray(task.markdown) ? [...task.markdown].sort((a, b) => {
    const first = Date.parse(a.created_at)
    const second = Date.parse(b.created_at)
    return Number.isFinite(first) && Number.isFinite(second) ? second - first : 0
  }) : []
}

export function noteExportContent(task: Pick<Task, 'markdown'>, versionId: string): string {
  if (typeof task.markdown === 'string') return ['loading', 'empty'].includes(task.markdown.trim()) ? '' : task.markdown
  return task.markdown.find(version => version.ver_id === versionId)?.content || ''
}

export function noteMenuPosition(anchor: { left: number; right: number; top: number; bottom: number }, panel: { width: number; height: number }, viewport: { width: number; height: number }) {
  const margin = 8
  const below = anchor.bottom + 4
  const above = anchor.top - panel.height - 4
  return {
    left: Math.max(margin, Math.min(anchor.right - panel.width, viewport.width - panel.width - margin)),
    top: Math.max(margin, Math.min(below + panel.height <= viewport.height - margin ? below : above, viewport.height - panel.height - margin)),
  }
}
