import { ChevronDown, ChevronUp, Folder, FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ALL_FOLDER_ID, DEFAULT_FOLDER_ID, useFolderStore } from '@/store/folderStore'
import type { Task } from '@/store/taskStore'

interface FolderSidebarProps {
  tasks: Task[]
  archived: boolean
  disabled: boolean
  onCreate: () => void
  onRename: (id: string) => void
  onDelete: (id: string) => void
}

const FolderSidebar = ({ tasks, archived, disabled, onCreate, onRename, onDelete }: FolderSidebarProps) => {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('bilinote-folder-section-v1') === 'collapsed' } catch { return false }
  })
  const toggleCollapsed = () => {
    setCollapsed(value => {
      const next = !value
      try { localStorage.setItem('bilinote-folder-section-v1', next ? 'collapsed' : 'expanded') } catch { /* Keep session usability. */ }
      return next
    })
  }
  const folders = useFolderStore(state => state.folders)
  const assignments = useFolderStore(state => state.assignments)
  const selectedFolderId = useFolderStore(state => state.selectedFolderId)
  const selectFolder = useFolderStore(state => state.selectFolder)
  const visibleTasks = tasks.filter(task => Boolean(task.archived_at) === archived)
  const count = (id: string) => id === ALL_FOLDER_ID
    ? visibleTasks.length
    : visibleTasks.filter(task => (assignments[task.id] || DEFAULT_FOLDER_ID) === id).length

  // Migrate an old virtual-folder selection without touching notes or assignments.
  useEffect(() => {
    if (selectedFolderId === ALL_FOLDER_ID) selectFolder(DEFAULT_FOLDER_ID)
  }, [selectedFolderId, selectFolder])
  const folderRows = folders
  const selectedFolderName = folderRows.find(folder => folder.id === selectedFolderId)?.name || '默认文件夹'
  return <aside aria-label="笔记文件夹" className="library-folders flex min-h-0 w-full shrink-0 flex-col border-b border-border pb-1">
    <div className="flex items-center justify-between px-1 pb-1">
      <button type="button" className="library-folders-toggle" aria-label={collapsed ? '展开文件夹区域' : '收起文件夹区域'} aria-expanded={!collapsed} aria-controls="library-folder-rows" onClick={toggleCollapsed} title={collapsed ? `当前：${selectedFolderName}，点击展开文件夹` : '收起文件夹，为笔记列表腾出空间'}>
        {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}<span>{collapsed ? selectedFolderName : '文件夹'}</span>{collapsed && <small>{count(selectedFolderId)}</small>}
      </button>
      <Button type="button" size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={disabled} onClick={onCreate} title="新建文件夹" aria-label="新建文件夹">
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
    <div id="library-folder-rows" className={`library-folders-collapse ${collapsed ? 'is-collapsed' : ''}`} aria-hidden={collapsed} inert={collapsed}><div className="library-folders-clip">
    <div className="library-folder-list flex min-h-0 min-w-0 flex-col overflow-y-auto pb-1">
      {folderRows.map(folder => {
        const system = folder.id === DEFAULT_FOLDER_ID
        const selected = selectedFolderId === folder.id
        return <div key={folder.id} className={cn('group flex min-w-0 items-center rounded-md', selected && 'bg-accent')}>
          <button type="button" disabled={disabled} aria-current={selected ? 'true' : undefined} onClick={() => selectFolder(folder.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed">
            {selected ? <FolderOpen className="h-4 w-4 shrink-0 text-primary" /> : <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{count(folder.id)}</span>
          </button>
          {!disabled && folder.id !== ALL_FOLDER_ID && !system && <div className="flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            <Button type="button" size="sm" variant="ghost" className="h-6 w-6 p-0" title="重命名文件夹" aria-label={`重命名${folder.name}`} onClick={() => onRename(folder.id)}><Pencil className="h-3 w-3" /></Button>
            <Button type="button" size="sm" variant="ghost" className="h-6 w-6 p-0" title="删除文件夹" aria-label={`删除${folder.name}`} onClick={() => onDelete(folder.id)}><Trash2 className="h-3 w-3 text-destructive" /></Button>
          </div>}
        </div>
      })}
    </div>
    </div></div>
  </aside>
}

export default FolderSidebar
