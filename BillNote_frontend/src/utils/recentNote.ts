import type { Task } from '@/store/taskStore'
import { hasReadableContent } from '@/utils/readingStatus'

export function resolveReadableNote(tasks: Task[], currentId: string | null, recentId: string | null) {
  const current = tasks.find(task => task.id === currentId && hasReadableContent(task))
  const recent = tasks.find(task => task.id === recentId && hasReadableContent(task))
  return current || recent || [...tasks].filter(task => !task.archived_at && hasReadableContent(task))
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))[0]
}
