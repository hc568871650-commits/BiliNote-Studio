import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Check, Clock3, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import type { Task } from '@/store/taskStore'
import { generationElapsed, generationPhase, generationStages as stages, generationTitle } from '@/utils/taskProgress'
import { hasReadableContent } from '@/utils/readingStatus'
import { cancelGeneration } from '@/services/note'
import { CancelGenerationDialog, RegenerateConfirmDialog } from '@/components/RegenerateConfirmDialog'
import './generation.css'

const GenerationDetailsDialog = lazy(() => import('./GenerationDetailsDialog'))

const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

export default function GenerationProgress({
  task,
  onRetry,
  onResume,
}: {
  task: Task
  onRetry: () => Promise<void>
  onResume?: () => Promise<void>
}) {
  const [now, setNow] = useState(Date.now())
  const [retrying, setRetrying] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const attemptKey = `${task.id}:${task.formData?.request_id || ''}`
  const currentAttempt = useRef(attemptKey)
  const actionGuard = useRef(false)
  currentAttempt.current = attemptKey

  useEffect(() => {
    actionGuard.current = false
    setRetrying(false)
    setConfirmRegenerate(false)
    setDetailsOpen(false)
    setCancelRequested(false)
    setCancelling(false)
    setConfirmCancel(false)
    setCancelError('')
  }, [attemptKey])

  const failed = task.status === 'FAILED'
  const cancelled = failed && Boolean(task.cancelled)
  const needsDiagnostics = failed || task.status === 'SUBMISSION_UNKNOWN'
  const terminal = failed || task.status === 'SUCCESS'
  const current = generationPhase(task)
  const elapsed = generationElapsed(task, now)
  const recent = task.lastStatusAt ? now - task.lastStatusAt : Infinity
  const hasSavedVersion = hasReadableContent(task)
  const retryDisabled = retrying || Boolean(task.archived_at) || Boolean(task.submissionInFlight)
  const resumeDisabled = retrying || Boolean(task.archived_at) || Boolean(task.submissionInFlight)

  useEffect(() => {
    if (terminal) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [task.id, terminal])

  useEffect(() => {
    if (!terminal) window.dispatchEvent(new Event('bilinote-refresh-task'))
  }, [task.id, terminal])

  const handleConfirmRegenerate = async () => {
    if (actionGuard.current || retryDisabled) return
    actionGuard.current = true
    setRetrying(true)
    try {
      await onRetry()
    } catch {
      // Errors are surfaced by the store/toast; keep attempt guard clean.
    } finally {
      actionGuard.current = false
      if (currentAttempt.current === attemptKey) setRetrying(false)
    }
  }

  const handleResume = async () => {
    if (!onResume || actionGuard.current || resumeDisabled) return
    actionGuard.current = true
    setRetrying(true)
    try {
      await onResume()
    } catch {
      // Errors are surfaced by the store/toast.
    } finally {
      actionGuard.current = false
      if (currentAttempt.current === attemptKey) setRetrying(false)
    }
  }

  const handleConfirmCancel = async () => {
    setCancelling(true)
    setCancelError('')
    try {
      const response = await cancelGeneration(task.id, task.formData?.request_id)
      if (currentAttempt.current !== attemptKey) return
      setCancelRequested(Boolean(response.cancel_requested))
      window.dispatchEvent(new Event('bilinote-refresh-task'))
    } catch {
      if (currentAttempt.current === attemptKey) {
        setCancelError('取消结果暂未确认，请查看最新进度后重试。')
      }
    } finally {
      if (currentAttempt.current === attemptKey) setCancelling(false)
    }
  }

  return (
    <section
      className="generation-progress"
      data-running={!failed && task.status !== 'SUCCESS'}
      aria-label="笔记生成进度"
    >
      <div className="generation-progress-inner">
        <div className="generation-progress-header">
          <div className="generation-progress-icon">
            {failed ? (
              <TriangleAlert size={22} />
            ) : task.status === 'PENDING' ? (
              <Clock3 size={22} />
            ) : terminal ? (
              <Check size={22} />
            ) : (
              <Loader2 size={22} className="generation-spin" />
            )}
          </div>
          <div>
            <h2>{cancelled ? '已取消生成' : failed ? '这次生成未完成' : current.title}</h2>
            <p>{generationTitle(task)}</p>
          </div>
        </div>

        <div
          className="generation-stage-track"
          role="progressbar"
          aria-label="当前生成阶段"
          aria-valuetext={
            failed
              ? current.index < 0
                ? '生成未完成，未记录失败阶段'
                : `生成未完成，停在${stages[current.index]}`
              : current.title
          }
        >
          {stages.map((name, index) => (
            <span
              key={name}
              className={index < current.index ? 'is-done' : index === current.index ? 'is-current' : ''}
            />
          ))}
        </div>

        <ol className="generation-stage-list">
          {stages.map((name, index) => (
            <li
              key={name}
              className={index < current.index ? 'is-done' : index === current.index ? 'is-current' : ''}
              aria-current={index === current.index ? 'step' : undefined}
            >
              {index < current.index ? <Check size={12} /> : <span>{String(index + 1).padStart(2, '0')}</span>}
              {name}
            </li>
          ))}
        </ol>

        <div className="generation-progress-detail">
          <p aria-live="polite">
            {task.statusMessage || (failed ? '后台未能完成本次任务，请查看诊断或重试。' : current.detail)}
          </p>
          {failed && (
            <p>{current.index < 0 ? '此历史任务未记录失败阶段' : `停止阶段：${stages[current.index]}`}</p>
          )}
          <div className="generation-progress-meta">
            <span>
              {elapsed === undefined
                ? terminal
                  ? '未记录完整耗时'
                  : '等待开始时间'
                : `${terminal ? '用时' : '已用'} ${duration(elapsed)}`}
            </span>
            {!terminal && (
              <span>
                {task.lastStatusAt
                  ? `上次更新：${recent < 3000 ? '刚刚' : `${Math.floor(recent / 1000)} 秒前`}`
                  : '等待首次状态回传'}
              </span>
            )}
          </div>
          {!terminal && task.pollingError && (
            <p className="generation-progress-error">
              进度暂时未能更新，后台任务可能仍在处理。{task.pollingError}
            </p>
          )}
        </div>

        {task.status === 'SUBMISSION_UNKNOWN' && (
          <p className="mt-3 text-xs text-muted-foreground">
            正在核对是否受理；若未送达，可复用同一请求编号继续提交。
          </p>
        )}

        <div className="generation-progress-actions">
          <span>
            {failed
              ? hasSavedVersion
                ? '已保存的笔记版本仍然保留'
                : '可查看诊断确认结果或重试'
              : terminal
                ? '笔记已保存'
                : '可切换页面，任务会后台继续'}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setDetailsOpen(true)}>
              {needsDiagnostics ? '诊断与恢复' : '生成详情'}
            </button>
            {failed && (
              <button
                type="button"
                disabled={retryDisabled}
                onClick={() => setConfirmRegenerate(true)}
              >
                {retrying ? <Loader2 size={13} className="generation-spin" /> : <RefreshCw size={13} />}
                重新生成
              </button>
            )}
            {task.status === 'SUBMISSION_UNKNOWN' && onResume && (
              <button
                type="button"
                disabled={resumeDisabled}
                onClick={() => void handleResume()}
              >
                继续提交本次请求
              </button>
            )}
            {!terminal && task.status !== 'SUBMISSION_UNKNOWN' && (
              <button
                type="button"
                disabled={cancelRequested || cancelling || task.status === 'SAVING'}
                onClick={() => setConfirmCancel(true)}
              >
                {cancelRequested ? '正在取消…' : '取消生成'}
              </button>
            )}
          </div>
        </div>

        {cancelError && <p role="alert" className="generation-progress-error">{cancelError}</p>}

        <RegenerateConfirmDialog
          open={confirmRegenerate}
          onOpenChange={setConfirmRegenerate}
          disabled={retryDisabled}
          onConfirm={handleConfirmRegenerate}
        />

        <CancelGenerationDialog
          open={confirmCancel}
          onOpenChange={setConfirmCancel}
          disabled={cancelling || cancelRequested}
          onConfirm={handleConfirmCancel}
        />

        {detailsOpen && (
          <Suspense fallback={<p role="status">读取生成详情…</p>}>
            <GenerationDetailsDialog
              key={task.id}
              taskId={task.id}
              versionId=""
              modelName={task.formData?.model_name || ''}
              allowComparison={false}
              initialTab={needsDiagnostics ? 'diagnostics' : 'overview'}
              pollGenerationRuns={!terminal}
              onClose={() => setDetailsOpen(false)}
            />
          </Suspense>
        )}
      </div>
    </section>
  )
}
