'use client'

import { AlignLeft, BookMarked, BookOpen, Clock3, GitFork, Loader2, MessageSquare, SlidersHorizontal, TriangleAlert } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { formatVersionLabel } from '@/utils/versionLabel'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTaskStore } from '@/store/taskStore'
import { fetchReviewBank } from '@/services/note'
import { hasReadableContent } from '@/utils/readingStatus'
import { ReaderToolbarContext, useToolbarFocusGroup, useWorkspaceTopbar } from '@/layouts/WorkspaceTopbarContext'
import '@/layouts/topbar.css'

const GenerationDetailsDialog = lazy(() => import('./GenerationDetailsDialog'))
const ReviewBankDialog = lazy(() => import('@/components/ReviewBankDialog'))

interface VersionNote {
  ver_id: string
  content?: string
  structured?: unknown
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
  hasReadableBody?: boolean
  hasAnyReadableVersion?: boolean
  canUseMindmap?: boolean
  canUseTranscript?: boolean
  canUseChat?: boolean
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
  hasReadableBody = true,
  hasAnyReadableVersion,
  canUseMindmap,
  canUseTranscript = true,
  canUseChat = true,
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

  const effectiveHasAnyReadable = hasAnyReadableVersion ?? hasReadableContent(task ?? currentTask)
  const mindmapEnabled = canUseMindmap ?? hasReadableBody
  const failed = task?.status === 'FAILED'
  const submissionUnknown = task?.status === 'SUBMISSION_UNKNOWN'
  const runningInBackground = Boolean(task && task.status !== 'SUCCESS' && !failed && !submissionUnknown)
  const showCompactStatusPill = Boolean(effectiveHasAnyReadable && task && task.status !== 'SUCCESS')

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
      {showCompactStatusPill && task && (
        failed ? (
          <button
            type="button"
            className="workspace-topbar-status-pill is-failed"
            aria-label={task.cancelled ? '已取消生成，诊断与恢复' : '本次生成未完成，诊断与恢复'}
            title={task.cancelled ? '已取消生成 · 诊断与恢复' : '本次生成未完成 · 诊断与恢复'}
            onClick={() => setDiagnosticsId(task.id)}
          >
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={1.85} aria-hidden="true" />
            <span className="topbar-pill-label">
              <span className="topbar-pill-extra">{task.cancelled ? '已取消 · ' : '生成未完成 · '}</span>
              <span>恢复</span>
            </span>
          </button>
        ) : submissionUnknown ? (
          <button
            type="button"
            className="workspace-topbar-status-pill is-pending"
            aria-label="提交结果待确认，诊断与恢复"
            title="提交结果待确认 · 诊断与恢复"
            onClick={() => setDiagnosticsId(task.id)}
          >
            <Clock3 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.85} aria-hidden="true" />
            <span className="topbar-pill-label">
              <span className="topbar-pill-extra">提交</span>
              <span>待确认</span>
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="workspace-topbar-status-pill is-running"
            aria-label="正在后台重新生成，查看进度与详情"
            title="正在后台重新生成 · 查看进度或取消"
            onClick={() => setDiagnosticsId(task.id)}
          >
            <Loader2 className="h-3.5 w-3.5 shrink-0 generation-spin" strokeWidth={1.85} aria-hidden="true" />
            <span className="topbar-pill-label">生成中…</span>
          </button>
        )
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
          disabled={!mindmapEnabled}
          onClick={() => {
            if (!mindmapEnabled) return
            setViewMode(viewMode === 'preview' ? 'map' : 'preview')
          }}
          className="workspace-topbar-btn"
          aria-pressed={mindmapEnabled && viewMode === 'map'}
          title={!mindmapEnabled ? '暂无可读正文' : viewMode === 'preview' ? '思维导图' : '返回正文'}
          aria-label={viewMode === 'preview' ? '思维导图' : '返回正文'}
        >
          {viewMode === 'preview' ? <GitFork className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> : <BookOpen className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />}
          <span className="topbar-btn-label">{viewMode === 'preview' ? '思维导图' : '正文'}</span>
        </button>
        <button
          type="button"
          disabled={!canUseTranscript}
          onClick={() => {
            if (!canUseTranscript) return
            setShowTranscribe(!showTranscribe)
          }}
          className="workspace-topbar-btn"
          aria-pressed={canUseTranscript && showTranscribe}
          title={canUseTranscript ? '原文参照' : '暂无可读原文'}
          aria-label="原文参照"
        >
          <AlignLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          <span className="topbar-btn-label">原文参照</span>
        </button>
        {setShowChat && (
          <button
            type="button"
            disabled={!canUseChat}
            onClick={() => {
              if (!canUseChat) return
              setShowChat(showChat ? false : 'half')
            }}
            className="workspace-topbar-btn"
            aria-pressed={canUseChat && Boolean(showChat)}
            title={canUseChat ? 'AI 问答（Ctrl+.）' : '暂无可用于问答的内容'}
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
            noteTitle={title}
            initialTab={runningInBackground ? 'overview' : 'diagnostics'}
            pollGenerationRuns={runningInBackground}
            allowComparison={false}
            onClose={() => setDiagnosticsId(null)}
          />
        </Suspense>
      )}
    </ReaderToolbarContext.Provider>
  )
}
