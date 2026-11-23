'use client'

import { AlignLeft, BookMarked, BookOpen, GitFork, MessageSquare, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { formatVersionLabel } from '@/utils/versionLabel'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTaskStore } from '@/store/taskStore'
import { fetchReviewBank } from '@/services/note'
import toast from 'react-hot-toast'
import { ReaderToolbarContext, useToolbarFocusGroup, useWorkspaceTopbar } from '@/layouts/WorkspaceTopbarContext'
import '@/layouts/topbar.css'

const GenerationDetailsDialog = lazy(() => import('./GenerationDetailsDialog'))
const ReviewBankDialog = lazy(() => import('@/components/ReviewBankDialog'))

interface VersionNote {
  ver_id: string
  model_name?: string
  style?: string
  created_at?: string
}

interface NoteHeaderProps {
  currentTask?: {
    id: string
    markdown: VersionNote[] | string
    archived_at?: string | null
  } | null
  isMultiVersion: boolean
  currentVerId: string
  setCurrentVerId: (id: string) => void
  modelName: string
  title?: string
  showTranscribe: boolean
  setShowTranscribe: (show: boolean) => void
  showChat?: false | 'half' | 'full'
  setShowChat?: (mode: false | 'half' | 'full') => void
  viewMode: 'map' | 'preview'
  setViewMode: (mode: 'map' | 'preview') => void
  children?: ReactNode
}

export function MarkdownHeader({
  currentTask,
  isMultiVersion,
  currentVerId,
  setCurrentVerId,
  modelName,
  title,
  showTranscribe,
  setShowTranscribe,
  showChat,
  setShowChat,
  viewMode,
  setViewMode,
  children,
}: NoteHeaderProps) {
  const workspaceTopbar = useWorkspaceTopbar()
  const task = useTaskStore(state => state.tasks.find(item => item.id === currentTask?.id))
  const [diagnosticsId, setDiagnosticsId] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [dueCount, setDueCount] = useState(0)
  const [statusSlot, setStatusSlot] = useState<HTMLDivElement | null>(null)
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null)
  const [hasReaderToolbar, setHasReaderToolbar] = useState(false)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const failed = task?.status === 'FAILED'

  const refreshDueCount = useCallback(() => {
    void fetchReviewBank({ kind: 'all', status: 'due', limit: 1 })
      .then(res => setDueCount(res.due_total ?? res.total ?? 0))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshDueCount()
  }, [currentTask?.id, refreshDueCount])

  useEffect(() => {
    const onOpenReview = () => setReviewOpen(true)
    window.addEventListener('bilinote-open-review-bank', onOpenReview)
    return () => window.removeEventListener('bilinote-open-review-bank', onOpenReview)
  }, [])

  const portalActive = !workspaceTopbar || workspaceTopbar.active

  useEffect(() => {
    if (!workspaceTopbar) return
    workspaceTopbar.setHasTopbarOwner(portalActive)
    return () => workspaceTopbar.setHasTopbarOwner(false)
  }, [workspaceTopbar, portalActive])

  useToolbarFocusGroup(toolbarRef, Boolean(portalActive && (!workspaceTopbar || workspaceTopbar.rightSlot)))

  const readerToolbarCtx = useMemo(
    () => ({ statusSlot, toolbarSlot, setHasReaderToolbar }),
    [statusSlot, toolbarSlot],
  )

  const versions: VersionNote[] = Array.isArray(currentTask?.markdown)
    ? currentTask.markdown
    : []
  const versionIndex = Math.max(0, versions.findIndex(v => v.ver_id === currentVerId))

  const leftControls = (
    <>
      {currentTask?.archived_at && <Badge variant="outline" className="shrink-0">已归档</Badge>}
      {isMultiVersion && versions.length > 1 && (
        <Select value={currentVerId} onValueChange={setCurrentVerId}>
          <SelectTrigger className="note-version-trigger" aria-label="笔记版本" title={formatVersionLabel(versions[versionIndex], versionIndex, versions.length)}>
            <span className="truncate">{formatVersionLabel(versions[versionIndex], versionIndex, versions.length)}</span>
          </SelectTrigger>
          <SelectContent>
            {versions.map((v, index) => (
              <SelectItem key={v.ver_id} value={v.ver_id}>
                <span className="flex flex-col gap-0.5">
                  <span>{formatVersionLabel(v, index, versions.length)}</span>
                  {v.model_name && <span className="text-[11px] text-muted-foreground">{v.model_name}</span>}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div ref={setStatusSlot} className="workspace-topbar-status" />
      {failed && (
        <>
          <span className="shrink-0 text-xs text-destructive">{task.cancelled ? '已取消生成' : '本次生成未完成'}</span>
          <Button variant="outline" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={() => setDiagnosticsId(task.id)}>诊断与恢复</Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            title="重新调用模型生成笔记，可能产生费用"
            disabled={Boolean(task.archived_at) || task.submissionInFlight}
            onClick={() => {
              void useTaskStore.getState().retryTask(task.id).catch((error: unknown) => {
                const failure = error as { msg?: string; message?: string }
                toast.error(failure?.msg || failure?.message || '提交失败，请检查任务状态')
              })
            }}
          >
            重新生成
          </Button>
        </>
      )}
    </>
  )

  const rightToolbar = (
    <div
      ref={toolbarRef}
      role="toolbar"
      {...({ focusgroup: 'toolbar wrap' } as Record<string, string>)}
      aria-label="阅读工具栏"
      className="workspace-topbar-toolbar"
    >
      <div ref={setToolbarSlot} role="group" aria-label="阅读控制" className="workspace-topbar-group" hidden={!hasReaderToolbar} />
      <div role="group" aria-label="视图与面板" className="workspace-topbar-group">
        <button
          type="button"
          onClick={() => setViewMode(viewMode === 'preview' ? 'map' : 'preview')}
          className="workspace-topbar-btn"
          aria-pressed={viewMode === 'map'}
          title={viewMode === 'preview' ? '思维导图' : '返回正文'}
          aria-label={viewMode === 'preview' ? '思维导图' : '返回正文'}
        >
          {viewMode === 'preview' ? <GitFork className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> : <BookOpen className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />}
          <span className="topbar-btn-label">{viewMode === 'preview' ? '思维导图' : '正文'}</span>
        </button>
        <button
          type="button"
          onClick={() => setShowTranscribe(!showTranscribe)}
          className="workspace-topbar-btn"
          aria-pressed={showTranscribe}
          title="原文参照"
          aria-label="原文参照"
        >
          <AlignLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          <span className="topbar-btn-label">原文参照</span>
        </button>
        {setShowChat && (
          <button
            type="button"
            onClick={() => setShowChat(showChat ? false : 'half')}
            className="workspace-topbar-btn"
            aria-pressed={Boolean(showChat)}
            title="AI 问答（Ctrl+.）"
            aria-label="AI 问答"
          >
            <MessageSquare className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            <span className="topbar-btn-label">AI 问答</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => setReviewOpen(true)}
          className="workspace-topbar-btn"
          title={dueCount > 0 ? `错题与高频避坑回顾（今日到期 ${dueCount} 项）` : '错题与高频避坑回顾'}
          aria-label={dueCount > 0 ? `复习库，今日到期 ${dueCount} 项` : '复习库'}
        >
          <BookMarked className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
          <span className="topbar-btn-label">复习库</span>
          {dueCount > 0 && (
            <span className="ml-0.5 inline-flex min-w-[16px] items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--reading-accent,var(--primary))_18%,transparent)] px-1 text-[10px] font-semibold leading-[15px] tabular-nums text-[var(--reading-accent,var(--primary))]">
              {dueCount > 99 ? '99+' : dueCount}
            </span>
          )}
        </button>
        {workspaceTopbar?.onConfigure && (
          <button
            type="button"
            onClick={workspaceTopbar.onConfigure}
            className="workspace-topbar-btn"
            title="生成设置"
            aria-label="生成设置"
          >
            <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            <span className="topbar-btn-label">生成设置</span>
          </button>
        )}
      </div>
    </div>
  )

  return (
    <ReaderToolbarContext.Provider value={readerToolbarCtx}>
      {workspaceTopbar ? (
        portalActive ? (
          <>
            {workspaceTopbar.leftSlot && createPortal(leftControls, workspaceTopbar.leftSlot)}
            {workspaceTopbar.rightSlot && createPortal(rightToolbar, workspaceTopbar.rightSlot)}
          </>
        ) : null
      ) : (
        <header className="workspace-topbar workspace-topbar--standalone">
          {title && <div className="workspace-tab" title={title}><span>{title}</span></div>}
          <div className="workspace-topbar-left">{leftControls}</div>
          <div className="workspace-topbar-right">{rightToolbar}</div>
        </header>
      )}
      {children}
      {reviewOpen && (
        <Suspense fallback={null}>
          <ReviewBankDialog
            open={reviewOpen}
            onOpenChange={open => {
              setReviewOpen(open)
              if (!open) refreshDueCount()
            }}
            onStatsChanged={refreshDueCount}
          />
        </Suspense>
      )}
      {task && diagnosticsId === task.id && (
        <Suspense fallback={<p role="status">读取诊断…</p>}>
          <GenerationDetailsDialog
            key={task.id}
            taskId={task.id}
            versionId={currentVerId}
            modelName={task.formData?.model_name || modelName}
            initialTab="diagnostics"
            allowComparison={false}
            onClose={() => setDiagnosticsId(null)}
          />
        </Suspense>
      )}
    </ReaderToolbarContext.Provider>
  )
}
