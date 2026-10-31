import type { OrganizerScope } from '@/services/organizer'

interface FolderItem { id: string; name: string }

export function scopeLabel(scope: OrganizerScope['kind'], folderId: string, selectedIds: string[], folders: FolderItem[]) {
  if (scope === 'folder') return folders.find(folder => folder.id === folderId)?.name || '默认文件夹'
  if (scope === 'selected') return selectedIds.length ? `已选 ${selectedIds.length} 篇` : '选择笔记'
  return '全库'
}

// An empty note selection falls back to the whole library, which the backend treats as unauthorized for edits.
export function scopeRequest(scope: OrganizerScope['kind'], folderId: string, selectedIds: string[]): OrganizerScope {
  if (scope === 'folder') return { kind: 'folder', folder_id: folderId }
  if (scope === 'selected' && selectedIds.length) return { kind: 'selected', task_ids: selectedIds }
  return { kind: 'all' }
}
