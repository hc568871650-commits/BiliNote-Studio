import type { Task } from '@/store/taskStore'
import type { LearningStatus, NoteLibraryEntry } from '@/services/noteLibrary'
import { hasReadableContent } from '@/utils/readingStatus'

export type LibrarySort = 'newest' | 'oldest' | 'title'
export type TaskStatusFilter = 'all' | 'complete' | 'pending' | 'failed'

export interface LibraryFilters {
  search: string
  favoriteOnly: boolean
  learningStatus: 'all' | LearningStatus
  taskStatus: TaskStatusFilter
  sort: LibrarySort
}

export const defaultLibraryFilters: LibraryFilters = {
  search: '', favoriteOnly: false, learningStatus: 'all', taskStatus: 'all', sort: 'newest',
}

const normalized = (value: string | undefined) => (value || '').toLocaleLowerCase()
const createdAt = (task: Task) => Date.parse(task.createdAt || '') || 0
const title = (task: Task) => task.audioMeta?.title || '未命名笔记'

export const filterAndSortLibraryTasks = (
  tasks: Task[], entries: Record<string, NoteLibraryEntry>, filters: LibraryFilters,
) => {
  const query = normalized(filters.search.trim())
  return tasks.filter(task => {
    const entry = entries[task.id]
    const metadata = entry || { favorite: false, learning_status: 'unread' as const, tags: [], remark: '' }
    if (filters.favoriteOnly && !metadata.favorite) return false
    if (filters.learningStatus !== 'all' && (!hasReadableContent(task) || metadata.learning_status !== filters.learningStatus)) return false
    if (filters.taskStatus === 'complete' && task.status !== 'SUCCESS') return false
    if (filters.taskStatus === 'pending' && ['SUCCESS', 'FAILED'].includes(task.status)) return false
    if (filters.taskStatus === 'failed' && task.status !== 'FAILED') return false
    if (!query) return true
    return [title(task), ...metadata.tags, metadata.remark].some(value => normalized(value).includes(query))
  }).sort((left, right) => {
    const leftEntry = entries[left.id]
    const rightEntry = entries[right.id]
    if (Boolean(leftEntry?.pinned) !== Boolean(rightEntry?.pinned)) return leftEntry?.pinned ? -1 : 1
    if (filters.sort === 'title') return title(left).localeCompare(title(right), 'zh-CN')
    return filters.sort === 'oldest' ? createdAt(left) - createdAt(right) : createdAt(right) - createdAt(left)
  })
}
