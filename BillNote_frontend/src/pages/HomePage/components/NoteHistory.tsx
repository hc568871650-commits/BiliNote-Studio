import { useTaskStore } from '@/store/taskStore'
import { useFolderStore, ALL_FOLDER_ID, DEFAULT_FOLDER_ID } from '@/store/folderStore'
import { useLibraryStore, defaultLibraryEntry } from '@/store/libraryStore'
import { cn } from '@/lib/utils.ts'
import { Archive, CheckSquare, FolderInput, FolderOpen, RotateCcw, Square, Trash2, Star, Pin, Pencil, X, Search, SlidersHorizontal, Download, Info } from 'lucide-react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button.tsx'
import { FC, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import MoveNotesDialog from '@/pages/HomePage/components/MoveNotesDialog.tsx'
import LibraryMetadataDialog from '@/pages/HomePage/components/LibraryMetadataDialog.tsx'
import { defaultLibraryFilters, filterAndSortLibraryTasks, type LibraryFilters } from '@/utils/libraryFilters'
import type { LearningStatus } from '@/services/noteLibrary'
import { hasReadableContent, readingLabels } from '@/utils/readingStatus'
import { generationTitle } from '@/utils/taskProgress'
import { noteVersions } from '@/utils/noteActions'
import NoteActionsPopover from './NoteActionsPopover'
import NoteExportDialog from './NoteExportDialog'
import GenerationDetailsDialog from './GenerationDetailsDialog'

interface NoteHistoryProps { onSelect: (taskId: string) => void; selectedId: string | null; archived: boolean; foldersReady: boolean }

const NoteHistory: FC<NoteHistoryProps> = ({ onSelect, selectedId, archived, foldersReady }) => {
  const tasks = useTaskStore(state => state.tasks)
  const removeTask = useTaskStore(state => state.removeTask)
  const archiveTask = useTaskStore(state => state.archiveTask)
  const restoreTask = useTaskStore(state => state.restoreTask)
  const folders = useFolderStore(state => state.folders)
  const assignments = useFolderStore(state => state.assignments)
  const folderId = useFolderStore(state => state.selectedFolderId)
  const moveTasks = useFolderStore(state => state.moveTasks)
  const entries = useLibraryStore(state => state.entries)
  const libraryLoadState = useLibraryStore(state => state.loadState)
  const libraryError = useLibraryStore(state => state.errorMessage)
  const libraryMutating = useLibraryStore(state => state.isMutating)
  const loadLibrary = useLibraryStore(state => state.loadLibrary)
  const updateEntries = useLibraryStore(state => state.updateEntries)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filters, setFilters] = useState<LibraryFilters>(defaultLibraryFilters)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveBusy, setMoveBusy] = useState(false)
  const [metadataId, setMetadataId] = useState<string | null>(null)
  const [metadataBusy, setMetadataBusy] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [exportId, setExportId] = useState<string | null>(null)
  const [openingFolderId, setOpeningFolderId] = useState<string | null>(null)

  useEffect(() => { void loadLibrary().catch(() => undefined) }, [loadLibrary])
  const visibleTasks = useMemo(() => tasks.filter(task => Boolean(task.archived_at) === archived && (assignments[task.id] || DEFAULT_FOLDER_ID) === (folderId === ALL_FOLDER_ID ? DEFAULT_FOLDER_ID : folderId)), [tasks, archived, folderId, assignments])
  const filteredTasks = useMemo(() => filterAndSortLibraryTasks(visibleTasks, entries, filters), [visibleTasks, entries, filters])
  const filteredIds = useMemo(() => new Set(filteredTasks.map(task => task.id)), [filteredTasks])
  const selectedReadableIds = useMemo(() => filteredTasks.filter(task => selectedIds.includes(task.id) && hasReadableContent(task)).map(task => task.id), [filteredTasks, selectedIds])
  useEffect(() => { setSelectedIds([]); setMoveOpen(false) }, [archived, folderId, filters])
  useEffect(() => { setActionId(null) }, [archived, folderId, filters])
  useEffect(() => { setSelectedIds(current => current.filter(id => filteredIds.has(id))) }, [filteredIds])
  useEffect(() => { if (actionId && !filteredIds.has(actionId)) setActionId(null) }, [actionId, filteredIds])

  const perform = async (id: string, action: () => Promise<void>, success: string) => {
    if (busyId) return
    setBusyId(id)
    try { await action(); toast.success(success) } catch (error) { console.error('笔记操作失败', error); toast.error('操作失败，请稍后重试') } finally { setBusyId(null) }
  }
  const updateMetadata = async (taskIds: string[], changes: Parameters<typeof updateEntries>[1], success: string) => {
    try { await updateEntries(taskIds, changes); toast.success(success) } catch (error) { console.error('更新笔记库信息失败', error); toast.error('保存失败，请稍后重试') }
  }
  const toggleSelected = (id: string) => setSelectedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])
  const moveSelected = async (targetFolderId: string) => {
    if (!selectedIds.length || !foldersReady) return
    setMoveBusy(true)
    try { await moveTasks(selectedIds, targetFolderId); setSelectedIds([]); setMoveOpen(false); toast.success('笔记已移动') } catch (error) { console.error('移动笔记失败', error) } finally { setMoveBusy(false) }
  }
  const metadataTask = tasks.find(task => task.id === metadataId)
  const exportTask = tasks.find(task => task.id === exportId)
  const detailsTask = tasks.find(task => task.id === detailsId)
  const detailsVersion = detailsTask ? noteVersions(detailsTask)[0] : undefined
  const openFolder = async (id: string) => {
    if (!isTauri() || openingFolderId) return
    setOpeningFolderId(id)
    try { await invoke('open_note_folder', { taskId: id }) } catch (error) { toast.error(`无法打开教程文件夹：${String(error)}`) } finally { setOpeningFolderId(null) }
  }
  const hasActiveFilters = Boolean(filters.search || filters.favoriteOnly || filters.learningStatus !== 'all' || filters.taskStatus !== 'all')
  const libraryReady = libraryLoadState === 'ready' && !libraryMutating

  return <div className="flex h-full min-h-0 flex-col gap-1.5">
    <div className="flex shrink-0 items-center gap-2 rounded-md border border-input bg-background px-2 focus-within:ring-1 focus-within:ring-ring">
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input type="search" aria-label="搜索笔记" placeholder="搜索笔记…" className="select-text h-8 min-w-0 flex-1 bg-transparent text-xs outline-none" value={filters.search} onChange={event => setFilters(current => ({ ...current, search: event.target.value }))} />
    </div>
    <details className="shrink-0 rounded-md">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><SlidersHorizontal className="h-3 w-3" />筛选与排序{hasActiveFilters && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" aria-label="已启用筛选" />}</summary>
      <div className="flex flex-wrap items-center gap-1.5 px-1 py-1">
      <select aria-label="阅读状态筛选" disabled={!libraryReady} className="max-w-24 rounded border border-input bg-background px-2 py-1 text-xs" value={filters.learningStatus} onChange={event => setFilters(current => ({ ...current, learningStatus: event.target.value as LibraryFilters['learningStatus'] }))}><option value="all">全部阅读</option><option value="unread">{readingLabels.unread}</option><option value="learning">{readingLabels.learning}</option><option value="done">{readingLabels.done}</option></select>
      <select aria-label="任务状态筛选" className="max-w-24 rounded border border-input bg-background px-2 py-1 text-xs" value={filters.taskStatus} onChange={event => setFilters(current => ({ ...current, taskStatus: event.target.value as LibraryFilters['taskStatus'] }))}><option value="all">全部任务</option><option value="complete">生成完成</option><option value="pending">进行中</option><option value="failed">失败</option></select>
      <select aria-label="排序" className="max-w-24 rounded border border-input bg-background px-2 py-1 text-xs" value={filters.sort} onChange={event => setFilters(current => ({ ...current, sort: event.target.value as LibraryFilters['sort'] }))}><option value="newest">最新</option><option value="oldest">最旧</option><option value="title">标题</option></select>
      <Button type="button" size="sm" className="h-7 px-2 text-xs" variant={filters.favoriteOnly ? 'default' : 'outline'} disabled={!libraryReady} aria-pressed={filters.favoriteOnly} title="只看收藏" onClick={() => setFilters(current => ({ ...current, favoriteOnly: !current.favoriteOnly }))}><Star className="h-3 w-3" />收藏</Button>
      <Button type="button" size="sm" className="h-7 w-7 p-0" variant="ghost" title="清空筛选" aria-label="清空筛选" onClick={() => setFilters(defaultLibraryFilters)}><X className="h-3.5 w-3.5" /></Button>
      </div>
    </details>
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
      <span className="mr-auto">{filteredTasks.length} 篇{selectedIds.length > 0 && ` · 已选 ${selectedIds.length}`}</span>
      {libraryLoadState === 'error' && <span className="flex w-full items-center gap-1 text-destructive">{libraryError}<Button size="sm" className="h-6 px-2 text-xs" variant="outline" disabled={libraryMutating} onClick={() => void loadLibrary().catch(() => undefined)}>重试</Button></span>}
      {filteredTasks.length > 0 && <Button type="button" size="sm" className="h-6 px-1 text-[11px]" variant="ghost" onClick={selectedIds.length === filteredTasks.length ? () => setSelectedIds([]) : () => setSelectedIds(filteredTasks.map(task => task.id))}>{selectedIds.length === filteredTasks.length ? '取消全选' : '全选'}</Button>}
      {selectedIds.length > 0 && <>
        <Button type="button" size="sm" className="h-6 px-2 text-xs" variant="outline" disabled={!foldersReady} onClick={() => setMoveOpen(true)}><FolderInput className="h-3 w-3" />移动</Button>
        <select aria-label="批量阅读状态" title={selectedReadableIds.length ? '仅更新选中且有正文的笔记' : '选中的任务暂无正文，不能设置阅读状态'} disabled={!libraryReady || !selectedReadableIds.length} className="rounded border border-input bg-background px-1 py-1 text-[11px]" defaultValue="" onChange={event => { const status = event.target.value as LearningStatus; if (status && selectedReadableIds.length) void updateMetadata(selectedReadableIds, { learning_status: status }, '阅读状态已更新'); event.currentTarget.value = '' }}><option value="" disabled>阅读状态</option><option value="unread">{readingLabels.unread}</option><option value="learning">{readingLabels.learning}</option><option value="done">{readingLabels.done}</option></select>
        {selectedReadableIds.length !== selectedIds.length && <span className="w-full">{selectedReadableIds.length ? `阅读状态仅应用于 ${selectedReadableIds.length} 篇有正文笔记` : '选中的任务暂无正文，不能设置阅读状态'}</span>}
      </>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    {filteredTasks.length === 0 ? <div className="py-6 text-center"><p className="text-xs text-muted-foreground">{hasActiveFilters ? '没有匹配的笔记' : archived ? '归档区暂无笔记' : '此文件夹暂无笔记'}</p></div> : <div className="flex flex-col gap-0.5">{filteredTasks.map(task => {
      const entry = entries[task.id] || defaultLibraryEntry()
      const title = generationTitle(task)
      return <div key={task.id} data-note-current={selectedId === task.id} className={cn('group relative rounded-md px-1.5 py-1 transition-colors hover:bg-accent/60', selectedId === task.id && 'note-row-current')}>
        <div className="flex min-w-0 items-center gap-1.5">
          <button type="button" aria-label={`${selectedIds.includes(task.id) ? '取消选择' : '选择'}：${title}`} aria-pressed={selectedIds.includes(task.id)} className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[selected=true]:opacity-100" data-selected={selectedIds.includes(task.id)} onClick={() => toggleSelected(task.id)}>{selectedIds.includes(task.id) ? <CheckSquare className="h-3.5 w-3.5 text-primary" /> : <Square className="h-3.5 w-3.5" />}</button>
          <button type="button" data-note-select title={title} aria-current={selectedId === task.id ? 'true' : undefined} onClick={() => onSelect(task.id)} className="min-w-0 flex-1 rounded py-0.5 pr-7 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <span className="block truncate text-xs font-medium text-foreground">{title}</span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className={cn(task.status === 'FAILED' && 'text-destructive', !['SUCCESS', 'FAILED'].includes(task.status) && 'text-primary font-medium')}>{task.status === 'SUCCESS' ? '生成完成' : task.status === 'FAILED' ? '失败' : '进行中'}</span>
              {hasReadableContent(task) && <><span>·</span><span>{readingLabels[entry.learning_status]}</span></>}
              {entry.favorite && <Star aria-label="已收藏" className="h-2.5 w-2.5 fill-current" />}
              {entry.pinned && <Pin aria-label="已置顶" className="h-2.5 w-2.5" />}
            </span>
          </button>
        </div>
        <NoteActionsPopover title={title} open={actionId === task.id} onOpenChange={open => setActionId(open ? task.id : null)} actions={[
          { label: entry.favorite ? '取消收藏' : '收藏', icon: <Star />, pressed: entry.favorite, disabled: !libraryReady, onSelect: () => void updateMetadata([task.id], { favorite: !entry.favorite }, entry.favorite ? '已取消收藏' : '已收藏') },
          { label: entry.pinned ? '取消置顶' : '置顶', icon: <Pin />, pressed: entry.pinned, disabled: !libraryReady, onSelect: () => void updateMetadata([task.id], { pinned: !entry.pinned }, entry.pinned ? '已取消置顶' : '已置顶') },
          { label: '标签备注', icon: <Pencil />, disabled: !libraryReady, onSelect: () => setMetadataId(task.id) },
          { label: '移动', icon: <FolderInput />, disabled: !foldersReady, onSelect: () => { setSelectedIds([task.id]); setMoveOpen(true) } },
          { label: '打开文件夹', icon: <FolderOpen />, disabled: !isTauri() || Boolean(openingFolderId), description: !isTauri() ? '仅桌面版可打开本地教程文件夹' : '在文件资源管理器中打开该笔记的教程目录', onSelect: () => void openFolder(task.id) },
          { label: '导出', icon: <Download />, disabled: !hasReadableContent(task), description: !hasReadableContent(task) ? '暂无可导出的正文' : '选择该笔记的版本并导出 Markdown', onSelect: () => setExportId(task.id) },
          { label: '生成详情', icon: <Info />, onSelect: () => setDetailsId(task.id) },
          { label: archived ? '恢复' : '归档', icon: archived ? <RotateCcw /> : <Archive />, disabled: Boolean(busyId) || !['SUCCESS', 'FAILED'].includes(task.status), onSelect: () => { if (archived) void perform(task.id, () => restoreTask(task.id), '笔记已恢复'); else void perform(task.id, () => archiveTask(task.id), '笔记已归档') } },
        ]} deleteAction={archived ? { label: '彻底删除', icon: <Trash2 />, destructive: true, disabled: Boolean(busyId) || !['SUCCESS', 'FAILED'].includes(task.status), onSelect: () => setConfirmId(task.id) } : undefined} />
      </div>
    })}</div>}
    </div>
    <MoveNotesDialog open={moveOpen} folders={folders} count={selectedIds.length} busy={moveBusy} onOpenChange={open => { if (!moveBusy) setMoveOpen(open) }} onMove={target => void moveSelected(target)} />
    {exportTask && <NoteExportDialog key={exportTask.id} task={exportTask} onClose={() => setExportId(null)} />}
    {detailsTask && <GenerationDetailsDialog key={`${detailsTask.id}:${detailsVersion?.ver_id || ''}`} taskId={detailsTask.id} noteTitle={generationTitle(detailsTask)} versionId={detailsVersion?.ver_id || ''} modelName={detailsVersion?.model_name || detailsTask.formData?.model_name || ''} allowComparison={detailsTask.status === 'SUCCESS' && Boolean(detailsVersion)} pollGenerationRuns={!['SUCCESS', 'FAILED'].includes(detailsTask.status)} onClose={() => setDetailsId(null)} />}
    {metadataTask && <LibraryMetadataDialog open={Boolean(metadataId)} title={metadataTask.audioMeta?.title || '未命名笔记'} entry={entries[metadataTask.id] || defaultLibraryEntry()} busy={metadataBusy} showReadingStatus={hasReadableContent(metadataTask)} onOpenChange={open => { if (!open && !metadataBusy) setMetadataId(null) }} onSave={changes => { setMetadataBusy(true); void updateEntries([metadataTask.id], changes).then(() => { toast.success('笔记信息已保存'); setMetadataId(null) }).catch(error => { console.error('保存笔记信息失败', error); toast.error('保存失败，请稍后重试') }).finally(() => setMetadataBusy(false)) }} />}
    <Dialog open={Boolean(confirmId)} onOpenChange={open => { if (!open && !busyId) setConfirmId(null) }}><DialogContent onEscapeKeyDown={event => { if (busyId) event.preventDefault() }} onPointerDownOutside={event => { if (busyId) event.preventDefault() }}><DialogHeader><DialogTitle>彻底删除笔记？</DialogTitle><DialogDescription>将永久删除《{tasks.find(task => task.id === confirmId)?.audioMeta?.title || '未命名笔记'}》的笔记、历史版本、配图及关联记录，无法通过归档区恢复。不会删除原始视频和共享音视频缓存。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={Boolean(busyId)} onClick={() => setConfirmId(null)}>取消</Button><Button variant="destructive" disabled={Boolean(busyId)} onClick={() => { if (!confirmId) return; const id = confirmId; setBusyId(id); void removeTask(id).then(() => { toast.success('笔记已彻底删除'); setConfirmId(null) }).catch(error => { console.error('删除失败', error); toast.error('删除失败，请稍后重试') }).finally(() => setBusyId(null)) }}>{busyId ? '删除中…' : '彻底删除'}</Button></DialogFooter></DialogContent></Dialog>
  </div>
}

export default NoteHistory
