import NoteHistory from '@/pages/HomePage/components/NoteHistory.tsx'
import FolderSidebar from '@/pages/HomePage/components/FolderSidebar.tsx'
import { useTaskStore } from '@/store/taskStore'
import { useFolderStore } from '@/store/folderStore'
import { PanelLeftClose } from 'lucide-react'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface HistoryProps { onSelectNote?: (taskId: string) => void; onCollapse?: () => void }

const History = ({ onSelectNote, onCollapse }: HistoryProps) => {
  const [archived, setArchived] = useState(false)
  const [folderDialog, setFolderDialog] = useState<{ mode: 'create' | 'rename' | 'delete', id?: string } | null>(null)
  const [folderName, setFolderName] = useState('')
  const [busy, setBusy] = useState(false)
  const currentTaskId = useTaskStore(state => state.currentTaskId)
  const setCurrentTask = useTaskStore(state => state.setCurrentTask)
  const tasks = useTaskStore(state => state.tasks)
  const folders = useFolderStore(state => state.folders)
  const loadState = useFolderStore(state => state.loadState)
  const errorMessage = useFolderStore(state => state.errorMessage)
  const loadFolders = useFolderStore(state => state.loadFolders)
  const createFolder = useFolderStore(state => state.createFolder)
  const renameFolder = useFolderStore(state => state.renameFolder)
  const deleteFolder = useFolderStore(state => state.deleteFolder)

  useEffect(() => { void loadFolders().catch(() => undefined) }, [loadFolders])
  const openCreate = () => { setFolderName(''); setFolderDialog({ mode: 'create' }) }
  const openRename = (id: string) => { setFolderName(folders.find(folder => folder.id === id)?.name || ''); setFolderDialog({ mode: 'rename', id }) }
  const submitFolder = async () => {
    if (!folderDialog || busy) return
    const name = folderName.trim()
    if (folderDialog.mode !== 'delete' && !name) { toast.error('请输入文件夹名称'); return }
    setBusy(true)
    try {
      if (folderDialog.mode === 'create') await createFolder(name)
      else if (folderDialog.mode === 'rename' && folderDialog.id) await renameFolder(folderDialog.id, name)
      else if (folderDialog.id) await deleteFolder(folderDialog.id)
      toast.success(folderDialog.mode === 'delete' ? '文件夹已删除，笔记已回到默认文件夹' : folderDialog.mode === 'create' ? '文件夹已创建' : '文件夹已重命名')
      setFolderDialog(null)
    } catch (error) { console.error('文件夹操作失败', error) } finally { setBusy(false) }
  }
  const foldersReady = loadState === 'ready'
  return <div className="flex h-full min-h-0 w-full flex-col gap-2 px-2 py-2">
    <header className="workspace-library-heading"><h2>笔记库</h2><span className="workspace-library-count">{tasks.length}</span>{onCollapse && <button type="button" className="workspace-icon" title="收起笔记栏" aria-label="收起笔记栏" onClick={onCollapse}><PanelLeftClose size={17} /></button>}</header>
    <div className="flex shrink-0 border-b border-border" role="tablist" aria-label="笔记分类">
      {([false, true] as const).map(value => <button key={String(value)} type="button" role="tab" aria-selected={archived === value} onClick={() => setArchived(value)} className={`min-w-0 flex-1 border-b-2 px-1 py-1.5 text-xs ${archived === value ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground'}`}>{value ? '归档区' : '正常笔记'}</button>)}
    </div>
    {loadState === 'error' ? <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"><p className="text-muted-foreground">{errorMessage}</p><Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void loadFolders().catch(() => undefined)}>重试</Button></div> :
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <FolderSidebar tasks={tasks} archived={archived} disabled={!foldersReady} onCreate={openCreate} onRename={openRename} onDelete={id => setFolderDialog({ mode: 'delete', id })} />
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden"><NoteHistory onSelect={id => { setCurrentTask(id); onSelectNote?.(id) }} selectedId={currentTaskId} archived={archived} foldersReady={foldersReady} /></div>
      </div>}
    <Dialog open={Boolean(folderDialog)} onOpenChange={open => { if (!open && !busy) setFolderDialog(null) }}>
      <DialogContent onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }}>
        <DialogHeader><DialogTitle>{folderDialog?.mode === 'create' ? '新建文件夹' : folderDialog?.mode === 'rename' ? '重命名文件夹' : '删除文件夹？'}</DialogTitle><DialogDescription>{folderDialog?.mode === 'delete' ? '文件夹中的笔记会回到默认文件夹，不会删除磁盘目录、原始文件或笔记内容。' : '文件夹仅用于应用内整理，不会创建或移动磁盘目录。'}</DialogDescription></DialogHeader>
        {folderDialog?.mode !== 'delete' && <input autoFocus disabled={busy} value={folderName} maxLength={60} onChange={event => setFolderName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void submitFolder() }} placeholder="文件夹名称" className="select-text w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary" />}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setFolderDialog(null)}>取消</Button><Button type="button" variant={folderDialog?.mode === 'delete' ? 'destructive' : 'default'} disabled={busy} onClick={() => void submitFolder()}>{busy ? '处理中…' : folderDialog?.mode === 'delete' ? '删除文件夹' : '保存'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

export default History
