import { filterAndSortLibraryTasks, type LibraryFilters } from './libraryFilters'
import type { Task } from '@/store/taskStore'

const task = (id: string, title: string, createdAt: string, status: string) => ({
  id,
  audioMeta: { title },
  createdAt,
  status,
}) as unknown as Task

const filters: LibraryFilters = {
  search: '', favoriteOnly: false, learningStatus: 'all', taskStatus: 'all', sort: 'newest',
}
const tasks = [
  task('a', 'Gamma', '2026-01-01', 'SUCCESS'),
  task('b', 'Alpha', '2026-02-01', 'PENDING'),
  task('c', 'Beta', '2026-03-01', 'FAILED'),
]
const entries = {
  a: { favorite: true, pinned: false, learning_status: 'done' as const, tags: ['3D'], remark: 'old' },
  b: { favorite: false, pinned: true, learning_status: 'learning' as const, tags: ['Blender'], remark: 'target' },
  c: { favorite: true, pinned: false, learning_status: 'unread' as const, tags: [], remark: 'error' },
}
const ids = (nextFilters: LibraryFilters) => filterAndSortLibraryTasks(tasks, entries, nextFilters).map(item => item.id).join(',')

if (ids(filters) !== 'b,c,a') throw new Error('置顶笔记没有优先排序')
if (ids({ ...filters, search: 'target' }) !== 'b') throw new Error('备注搜索失败')
if (ids({ ...filters, favoriteOnly: true, taskStatus: 'complete' }) !== 'a') throw new Error('组合筛选失败')

console.log('libraryFilters behavior passed')
