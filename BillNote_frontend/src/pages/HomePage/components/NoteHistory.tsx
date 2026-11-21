import { useTaskStore } from '@/store/taskStore'
import { useFolderStore, ALL_FOLDER_ID, DEFAULT_FOLDER_ID } from '@/store/folderStore'
import { useLibraryStore, defaultLibraryEntry } from '@/store/libraryStore'
import { cn } from '@/lib/utils.ts'
import { Archive, CheckSquare, FolderInput, FolderOpen, RotateCcw, Sparkles, Square, Trash2, Star, Pin, Pencil, X, Download, Info } from 'lucide-react'
import { AnimatedFilterSlidersIcon } from '@/components/AnimatedRailIcons'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button.tsx'
import { FC, lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import MoveNotesDialog from '@/pages/HomePage/components/MoveNotesDialog.tsx'
import LibraryMetadataDialog from '@/pages/HomePage/components/LibraryMetadataDialog.tsx'
import { defaultLibraryFilters, filterAndSortLibraryTasks, type LibraryFilters } from '@/utils/libraryFilters'
import type { LearningStatus } from '@/services/noteLibrary'
import { hasReadableContent, readingLabels } from '@/utils/readingStatus'
import { generationStatusLabel, generationTitle } from '@/utils/taskProgress'
import { noteVersions } from '@/utils/noteActions'
import { batchUpgradeStructured } from '@/services/note'
import { useModelStore } from '@/store/modelStore'
import { usePurposeModelStore } from '@/store/purposeModelStore'
import { modelDisplayName } from '@/utils/modelDisplay'
import NoteActionsPopover from './NoteActionsPopover'
import LibrarySearch from './LibrarySearch'
import { useLibrarySearchStore } from '@/store/librarySearchStore'
import { useDistillQueueStore } from '@/store/distillQueueStore'
import ChoiceSelect from '@/components/ChoiceSelect'

const NoteExportDialog = lazy(() => import('./NoteExportDialog'))
const GenerationDetailsDialog = lazy(() => import('./GenerationDetailsDialog'))

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
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveBusy, setMoveBusy] = useState(false)
  const [metadataId, setMetadataId] = useState<string | null>(null)
  const [metadataBusy, setMetadataBusy] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [exportId, setExportId] = useState<string | null>(null)
  const [openingFolderId, setOpeningFolderId] = useState<string | null>(null)
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState(false)
  const [upgradeBusy, setUpgradeBusy] = useState(false)
  const [upgradeModelKey, setUpgradeModelKey] = useState('')
  const upgradeDialogRef = useRef<HTMLDialogElement | null>(null)
  const upgradeDialogTitleId = useId()
  const modelList = useModelStore(state => state.modelList)
  const loadEnabledModels = useModelStore(state => state.loadEnabledModels)
  const generationDefault = usePurposeModelStore(state => state.defaults.generation)
  const searching = useLibrarySearchStore(state => Boolean(state.query.trim()))
  const activeQueueJobs = useDistillQueueStore(state => state.activeJobs)
  const activeQueueTaskIds = useMemo(() => new Set(activeQueueJobs.map(job => job.task_id)), [activeQueueJobs])

  useEffect(() => { void loadLibrary().catch(() => undefined) }, [loadLibrary])
  const visibleTasks = useMemo(
    () => tasks.filter(task => {
      if (Boolean(task.archived_at) !== archived) return false
      if ((assignments[task.id] || DEFAULT_FOLDER_ID) !== (folderId === ALL_FOLDER_ID ? DEFAULT_FOLDER_ID : folderId)) return false
      // 书架保持纯粹：默认隐藏首次蒸馏中且尚无可读正文的占位任务（统一在导轨与蒸馏队列管理）
      const isInitialProducing = !hasReadableContent(task)
        && !['SUCCESS', 'FAILED', 'SUBMISSION_UNKNOWN'].includes(task.status)
      if (!archived && filters.taskStatus !== 'pending' && isInitialProducing) return false
      return true
    }),
    [tasks, archived, folderId, assignments, filters.taskStatus],
  )
  const filteredTasks = useMemo(() => filterAndSortLibraryTasks(visibleTasks, entries, filters), [visibleTasks, entries, filters])
  const filteredIds = useMemo(() => new Set(filteredTasks.map(task => task.id)), [filteredTasks])
  const selectedReadableIds = useMemo(() => filteredTasks.filter(task => selectedIds.includes(task.id) && hasReadableContent(task)).map(task => task.id), [filteredTasks, selectedIds])
  const selectedUpgradeableIds = useMemo(() => {
    return filteredTasks
      .filter(task => {
        if (!selectedIds.includes(task.id) || task.archived_at) return false
        const latest = noteVersions(task)[0]
        const structured = latest?.structured as { schema_version?: number; sections?: unknown[] } | undefined
        if (structured?.schema_version === 1 && Array.isArray(structured.sections) && structured.sections.length > 0) {
          return false
        }
        const hasTranscript = Boolean(task.transcript?.segments?.length)
        return hasReadableContent(task) || hasTranscript
      })
      .map(task => task.id)
  }, [filteredTasks, selectedIds])
  const selectedUpgradeSkippedCount = Math.max(0, selectedIds.length - selectedUpgradeableIds.length)

  useEffect(() => {
    const dialog = upgradeDialogRef.current
    if (!dialog) return
    if (upgradeDialogOpen) {
      void loadEnabledModels()
      if (!upgradeModelKey) {
        const preferred = generationDefault && modelList.some(m => m.provider_id === generationDefault.provider_id && m.model_name === generationDefault.model_name)
          ? generationDefault
          : modelList[0]
        if (preferred) {
          setUpgradeModelKey(JSON.stringify([preferred.provider_id, preferred.model_name]))
        }
      }
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [generationDefault, loadEnabledModels, modelList, upgradeDialogOpen, upgradeModelKey])

  const confirmBatchUpgrade = async () => {
    if (upgradeBusy || !selectedUpgradeableIds.length) return
    let providerId = ''
    let modelName = ''
    try {
      const parsed = JSON.parse(upgradeModelKey) as [string, string]
      providerId = parsed[0] || ''
      modelName = parsed[1] || ''
    } catch {
      const fallback = modelList[0]
      if (fallback) {
        providerId = fallback.provider_id
        modelName = fallback.model_name
      }
    }
    if (!providerId || !modelName) {
      toast.error('请先选择可用模型')
      return
    }
    setUpgradeBusy(true)
    try {
      const result = await batchUpgradeStructured({
        task_ids: selectedIds,
        provider_id: providerId,
        model_name: modelName,
      })
      void useDistillQueueStore.getState().refresh()
      setUpgradeDialogOpen(false)
      setSelectedIds([])
      if (result.enqueued.length > 0) {
        const skipTip = result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 篇` : ''
        toast.success(`已将 ${result.enqueued.length} 篇旧笔记加入结构化升级队列${skipTip}`)
      } else {
        toast('所选笔记无需升级或缺少正文与字幕')
      }
    } catch (error) {
      const msg = (error as { msg?: string; message?: string })?.msg || (error as { message?: string })?.message || '批量升级提交失败'
      toast.error(msg)
    } finally {
      setUpgradeBusy(false)
    }
  }
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
    <LibrarySearch
      onSelect={onSelect}
      trailing={!searching ? (
        <button
          type="button"
          className={cn('library-filter-toggle', filtersOpen && 'is-open')}
          aria-expanded={filtersOpen}
          aria-controls="library-filter-drawer"
          aria-label="筛选与排序"
          title="筛选与排序"
          onClick={() => setFiltersOpen(open => !open)}
        >
          <AnimatedFilterSlidersIcon open={filtersOpen} className="h-3.5 w-3.5" />
          <span className="library-filter-dot" data-active={hasActiveFilters} aria-hidden={!hasActiveFilters} />
        </button>
      ) : undefined}
    />
    {!searching && <>
    <div
      id="library-filter-drawer"
      className={cn('library-filter-collapse shrink-0', filtersOpen && 'is-open')}
      aria-hidden={!filtersOpen}
      inert={!filtersOpen}
    >
      <div className="library-filter-clip">
        <div className="library-filter-panel">
          <ChoiceSelect label="阅读状态筛选" className="choice-compact" menuClassName="choice-menu-compact" disabled={!libraryReady} value={filters.learningStatus} onChange={value => setFilters(current => ({ ...current, learningStatus: value as LibraryFilters['learningStatus'] }))} options={[{ value: 'all', label: '全部阅读' }, { value: 'unread', label: readingLabels.unread }, { value: 'learning', label: readingLabels.learning }, { value: 'done', label: readingLabels.done }]} />
          <ChoiceSelect label="任务状态筛选" className="choice-compact" menuClassName="choice-menu-compact" value={filters.taskStatus} onChange={value => setFilters(current => ({ ...current, taskStatus: value as LibraryFilters['taskStatus'] }))} options={[{ value: 'all', label: '全部任务' }, { value: 'complete', label: '生成完成' }, { value: 'pending', label: '进行中' }, { value: 'failed', label: '失败' }]} />
          <ChoiceSelect label="排序" className="choice-compact" menuClassName="choice-menu-compact" value={filters.sort} onChange={value => setFilters(current => ({ ...current, sort: value as LibraryFilters['sort'] }))} options={[{ value: 'newest', label: '最新' }, { value: 'oldest', label: '最旧' }, { value: 'title', label: '标题' }]} />
          <Button type="button" size="sm" className="h-7 px-2 text-xs" variant={filters.favoriteOnly ? 'default' : 'outline'} disabled={!libraryReady} aria-pressed={filters.favoriteOnly} title="只看收藏" onClick={() => setFilters(current => ({ ...current, favoriteOnly: !current.favoriteOnly }))}><Star className={cn('library-filter-star h-3 w-3', filters.favoriteOnly && 'is-active')} />收藏</Button>
          {hasActiveFilters && <Button type="button" size="sm" className="h-7 w-7 p-0" variant="ghost" title="清空筛选" aria-label="清空筛选" onClick={() => setFilters(defaultLibraryFilters)}><X className="h-3.5 w-3.5" /></Button>}
        </div>
      </div>
    </div>
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground">
      <span className="mr-auto">{filteredTasks.length} 篇{selectedIds.length > 0 && ` · 已选 ${selectedIds.length}`}</span>
      {libraryLoadState === 'error' && <span className="flex w-full items-center gap-1 text-destructive">{libraryError}<Button size="sm" className="h-6 px-2 text-xs" variant="outline" disabled={libraryMutating} onClick={() => void loadLibrary().catch(() => undefined)}>重试</Button></span>}
      {filteredTasks.length > 0 && <Button type="button" size="sm" className="h-7 px-2 text-[11px]" variant="ghost" onClick={selectedIds.length === filteredTasks.length ? () => setSelectedIds([]) : () => setSelectedIds(filteredTasks.map(task => task.id))}>{selectedIds.length === filteredTasks.length ? '取消全选' : '全选'}</Button>}
      {selectedIds.length > 0 && <>
        <Button type="button" size="sm" className="h-6 px-2 text-xs" variant="outline" disabled={!foldersReady} onClick={() => setMoveOpen(true)}><FolderInput className="h-3 w-3" />移动</Button>
        {!archived && (
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-xs"
            variant="outline"
            disabled={!selectedUpgradeableIds.length}
            title={selectedUpgradeableIds.length ? `批量升级 ${selectedUpgradeableIds.length} 篇旧笔记为结构化版本` : '所选笔记已是结构化版本或暂无可用正文'}
            onClick={() => setUpgradeDialogOpen(true)}
          >
            <Sparkles className="h-3 w-3" />升级结构化
          </Button>
        )}
        <ChoiceSelect label="批量阅读状态" className="choice-compact" menuClassName="choice-menu-compact" title={selectedReadableIds.length ? '仅更新选中且有正文的笔记' : '选中的任务暂无正文，不能设置阅读状态'} disabled={!libraryReady || !selectedReadableIds.length} value="" displayValue="阅读状态" onChange={value => { if (value && selectedReadableIds.length) void updateMetadata(selectedReadableIds, { learning_status: value as LearningStatus }, '阅读状态已更新') }} options={[{ value: 'unread', label: readingLabels.unread }, { value: 'learning', label: readingLabels.learning }, { value: 'done', label: readingLabels.done }]} />
        {selectedReadableIds.length !== selectedIds.length && <span className="w-full">{selectedReadableIds.length ? `阅读状态仅应用于 ${selectedReadableIds.length} 篇有正文笔记` : '选中的任务暂无正文，不能设置阅读状态'}</span>}
      </>}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    {filteredTasks.length === 0 ? <div className="py-6 text-center"><p className="text-xs text-muted-foreground">{hasActiveFilters ? '没有匹配的笔记' : archived ? '归档区暂无笔记' : '此文件夹暂无笔记'}</p></div> : <div className="flex flex-col gap-0.5">{filteredTasks.map(task => {
      const entry = entries[task.id] || defaultLibraryEntry()
      const title = generationTitle(task)
      return <div key={task.id} data-note-current={selectedId === task.id} className={cn('group relative rounded-[10px] px-2 py-1.5 transition-[background-color,box-shadow] duration-150 hover:bg-[var(--surface-hover)]', selectedId === task.id && 'note-row-current')}>
        <div className="flex min-w-0 items-center gap-1.5">
          <button type="button" aria-label={`${selectedIds.includes(task.id) ? '取消选择' : '选择'}：${title}`} aria-pressed={selectedIds.includes(task.id)} className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[selected=true]:opacity-100" data-selected={selectedIds.includes(task.id)} onClick={() => toggleSelected(task.id)}>{selectedIds.includes(task.id) ? <CheckSquare className="h-3.5 w-3.5 text-primary" /> : <Square className="h-3.5 w-3.5" />}</button>
          <button type="button" data-note-select title={title} aria-current={selectedId === task.id ? 'true' : undefined} onClick={() => onSelect(task.id)} className="min-w-0 flex-1 rounded py-0.5 pr-7 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <span className="flex items-center gap-1.5">
              <span className="min-w-0 truncate text-xs font-medium text-foreground">{title}</span>
              {activeQueueTaskIds.has(task.id) && (
                <span className="note-row-distilling-dot" title="后台更新中" aria-label="后台更新中" />
              )}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={cn(task.status === 'FAILED' && 'text-destructive', !['SUCCESS', 'FAILED'].includes(task.status) && 'text-primary font-medium')}>{generationStatusLabel(task)}</span>
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
          { label: ['FAILED', 'SUBMISSION_UNKNOWN'].includes(task.status) ? '诊断与恢复' : '生成详情', icon: <Info />, onSelect: () => setDetailsId(task.id) },
          { label: archived ? '恢复' : '归档', icon: archived ? <RotateCcw /> : <Archive />, disabled: Boolean(busyId) || !['SUCCESS', 'FAILED'].includes(task.status), onSelect: () => { if (archived) void perform(task.id, () => restoreTask(task.id), '笔记已恢复'); else void perform(task.id, () => archiveTask(task.id), '笔记已归档') } },
        ]} deleteAction={archived ? { label: '彻底删除', icon: <Trash2 />, destructive: true, disabled: Boolean(busyId) || !['SUCCESS', 'FAILED'].includes(task.status), onSelect: () => setConfirmId(task.id) } : undefined} />
      </div>
    })}</div>}
    </div>
    </>}
    <MoveNotesDialog open={moveOpen} folders={folders} count={selectedIds.length} busy={moveBusy} onOpenChange={open => { if (!moveBusy) setMoveOpen(open) }} onMove={target => void moveSelected(target)} />
    {exportTask && (
      <Suspense fallback={null}>
        <NoteExportDialog key={exportTask.id} task={exportTask} onClose={() => setExportId(null)} />
      </Suspense>
    )}
    {detailsTask && (
      <Suspense fallback={null}>
        <GenerationDetailsDialog key={`${detailsTask.id}:${detailsVersion?.ver_id || ''}`} taskId={detailsTask.id} noteTitle={generationTitle(detailsTask)} versionId={detailsVersion?.ver_id || ''} modelName={detailsVersion?.model_name || detailsTask.formData?.model_name || ''} initialTab={['FAILED', 'SUBMISSION_UNKNOWN'].includes(detailsTask.status) ? 'diagnostics' : 'overview'} allowComparison={detailsTask.status === 'SUCCESS' && Boolean(detailsVersion)} pollGenerationRuns={!['SUCCESS', 'FAILED'].includes(detailsTask.status)} onClose={() => setDetailsId(null)} />
      </Suspense>
    )}
    {metadataTask && <LibraryMetadataDialog open={Boolean(metadataId)} title={metadataTask.audioMeta?.title || '未命名笔记'} entry={entries[metadataTask.id] || defaultLibraryEntry()} busy={metadataBusy} showReadingStatus={hasReadableContent(metadataTask)} onOpenChange={open => { if (!open && !metadataBusy) setMetadataId(null) }} onSave={changes => { setMetadataBusy(true); void updateEntries([metadataTask.id], changes).then(() => { toast.success('笔记信息已保存'); setMetadataId(null) }).catch(error => { console.error('保存笔记信息失败', error); toast.error('保存失败，请稍后重试') }).finally(() => setMetadataBusy(false)) }} />}
    <dialog
      ref={upgradeDialogRef}
      className="batch-upgrade-dialog"
      aria-labelledby={upgradeDialogTitleId}
      onCancel={event => {
        if (upgradeBusy) {
          event.preventDefault()
          return
        }
        setUpgradeDialogOpen(false)
      }}
      onClose={event => {
        event.currentTarget.returnValue = ''
        setUpgradeDialogOpen(false)
      }}
    >
      <div className="batch-upgrade-dialog-inner">
        <div className="batch-upgrade-dialog-head">
          <h2 id={upgradeDialogTitleId} className="batch-upgrade-dialog-title">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
            <span>批量升级结构化笔记</span>
          </h2>
          <button
            type="button"
            className="collection-close-btn"
            aria-label="关闭弹窗"
            disabled={upgradeBusy}
            onClick={() => setUpgradeDialogOpen(false)}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        <p className="batch-upgrade-dialog-desc">
          将为选中的 <strong>{selectedUpgradeableIds.length}</strong> 篇旧笔记生成全新结构化版本（保留原有历史版本不覆盖）
          {selectedUpgradeSkippedCount > 0 ? `，自动跳过 ${selectedUpgradeSkippedCount} 篇已结构化或无正文的条目。` : '。'}
        </p>
        <div className="batch-upgrade-dialog-field">
          <label className="batch-upgrade-dialog-label" htmlFor="batch-upgrade-model-select">
            升级所用模型
          </label>
          <select
            id="batch-upgrade-model-select"
            className="batch-upgrade-dialog-select"
            disabled={upgradeBusy || !modelList.length}
            value={upgradeModelKey}
            onChange={event => setUpgradeModelKey(event.target.value)}
          >
            {modelList.length === 0 ? (
              <option value="">暂无可用模型</option>
            ) : (
              modelList.map(model => (
                <option
                  key={`${model.provider_id}:${model.model_name}`}
                  value={JSON.stringify([model.provider_id, model.model_name])}
                >
                  {modelDisplayName(model)}
                </option>
              ))
            )}
          </select>
        </div>
        <p className="batch-upgrade-dialog-notice">
          费用提示：本次操作将对 {selectedUpgradeableIds.length} 篇笔记分别发起模型调用并按实际用量计费；任务会进入后台蒸馏队列，单篇失败不影响其他笔记。
        </p>
        <div className="batch-upgrade-dialog-actions">
          <Button
            type="button"
            variant="outline"
            autoFocus
            disabled={upgradeBusy}
            onClick={() => setUpgradeDialogOpen(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={upgradeBusy || !selectedUpgradeableIds.length || !modelList.length}
            onClick={() => void confirmBatchUpgrade()}
          >
            {upgradeBusy ? '正在入队…' : `确认升级 (${selectedUpgradeableIds.length} 篇)`}
          </Button>
        </div>
      </div>
    </dialog>
    <Dialog open={Boolean(confirmId)} onOpenChange={open => { if (!open && !busyId) setConfirmId(null) }}><DialogContent onEscapeKeyDown={event => { if (busyId) event.preventDefault() }} onPointerDownOutside={event => { if (busyId) event.preventDefault() }}><DialogHeader><DialogTitle>彻底删除笔记？</DialogTitle><DialogDescription>将永久删除《{tasks.find(task => task.id === confirmId)?.audioMeta?.title || '未命名笔记'}》的笔记、历史版本、配图及关联记录，无法通过归档区恢复。不会删除原始视频和共享音视频缓存。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={Boolean(busyId)} onClick={() => setConfirmId(null)}>取消</Button><Button variant="destructive" disabled={Boolean(busyId)} onClick={() => { if (!confirmId) return; const id = confirmId; setBusyId(id); void removeTask(id).then(() => { toast.success('笔记已彻底删除'); setConfirmId(null) }).catch(error => { console.error('删除失败', error); toast.error('删除失败，请稍后重试') }).finally(() => setBusyId(null)) }}>{busyId ? '删除中…' : '彻底删除'}</Button></DialogFooter></DialogContent></Dialog>
  </div>
}

export default NoteHistory
