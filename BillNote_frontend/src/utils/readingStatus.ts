import type { Task } from '@/store/taskStore'
import type { LearningStatus } from '@/services/noteLibrary'

// Keep persisted values compatible with existing library metadata.
export const readingLabels: Record<LearningStatus, string> = {
  unread: '待读', learning: '阅读中', done: '已读完',
}
export function hasReadableContent(task: Pick<Task, 'markdown'>): boolean {
  const readable = (text: string) => Boolean(text.trim()) && !['loading', 'empty'].includes(text.trim())
  return typeof task.markdown === 'string'
    ? readable(task.markdown)
    : Array.isArray(task.markdown) && task.markdown.some(version => readable(version.content || ''))
}
