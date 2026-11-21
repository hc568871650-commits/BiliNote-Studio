import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { HairlineCloseIcon } from '@/pages/HomePage/components/StructuredNoteReader/AnnotationIcons'
import { useDistillQueueStore } from '@/store/distillQueueStore'
import { useTaskStore } from '@/store/taskStore'
import type { DistillJobRecord, DistillNotificationMode, JobKind } from '@/utils/distillNotifications'
import './distill-queue.css'

interface DistillQueuePanelProps {
  variant: 'popover' | 'inline'
  onClose?: () => void
  onPointerEnter?: () => void
  onPointerLeave?: () => void
}

const NOTIFY_OPTIONS: Array<{ value: DistillNotificationMode; label: string; title: string }> = [
  { value: 'all_done', label: '全完提醒', title: '蒸馏完队列中所有任务后合并提醒（默认）' },
  { value: 'each', label: '每篇', title: '每完成或失败一篇立即提醒' },
  { value: 'off', label: '关闭', title: '关闭蒸馏完成提醒' },
]

const KIND_LABELS: Record<JobKind, string> = {
  generate: '新建',
  regenerate: '重生成',
  upgrade_structured: '结构化升级',
  batch_item: '批量',
}

function formatElapsed(job: DistillJobRecord, nowMs: number): string {
  const startRaw = job.started_at || job.created_at
  const start = startRaw ? Date.parse(startRaw) : NaN
  if (!Number.isFinite(start)) return ''
  const end = job.finished_at ? Date.parse(job.finished_at) : nowMs
  const sec = Math.max(0, Math.floor((end - start) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  return `${min}m${rem < 10 ? `0${rem}` : rem}s`
}

export default function DistillQueuePanel({
  variant,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: DistillQueuePanelProps) {
  const navigate = useNavigate()
  const activeJobs = useDistillQueueStore(state => state.activeJobs)
  const recentJobs = useDistillQueueStore(state => state.recentJobs)
  const activeCount = useDistillQueueStore(state => state.activeCount)
  const notificationMode = useDistillQueueStore(state => state.notificationMode)
  const setNotificationMode = useDistillQueueStore(state => state.setNotificationMode)
  const busyJobIds = useDistillQueueStore(state => state.busyJobIds)
  const clearingFinished = useDistillQueueStore(state => state.clearingFinished)
  const cancel = useDistillQueueStore(state => state.cancel)
  const retry = useDistillQueueStore(state => state.retry)
  const clearFinished = useDistillQueueStore(state => state.clearFinished)

  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (activeJobs.length === 0) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activeJobs.length])

  // inline 模式在完全无任务时隐藏，保持新建页简洁
  if (variant === 'inline' && activeJobs.length === 0 && recentJobs.length === 0) {
    return null
  }

  const openNote = (taskId: string) => {
    const taskStore = useTaskStore.getState()
    taskStore.setCurrentTask(taskId)
    void taskStore.loadTask(taskId).catch(() => undefined)
    navigate('/?view=read')
    onClose?.()
  }

  const displayRecent = variant === 'inline' ? recentJobs.slice(0, 6) : recentJobs.slice(0, 20)

  return (
    <section
      id={variant === 'popover' ? 'distill-queue-popover' : undefined}
      role="region"
      aria-label="蒸馏队列"
      className={variant === 'popover' ? 'distill-queue-surface distill-queue-popover' : 'distill-queue-inline'}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <header className="distill-queue-header">
        <div className="distill-queue-title-group">
          <span className="distill-queue-title">蒸馏队列</span>
          {activeCount > 0 && (
            <span className="distill-queue-count-pill" aria-label={`进行中 ${activeCount} 项`}>
              {activeCount > 99 ? '99+' : activeCount}
            </span>
          )}
        </div>

        <div className="distill-queue-header-actions">
          <div className="distill-notify-switch" role="radiogroup" aria-label="完成提醒方式">
            {NOTIFY_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={notificationMode === option.value}
                title={option.title}
                className="distill-notify-option"
                onClick={() => setNotificationMode(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {variant === 'popover' && onClose && (
            <button
              type="button"
              className="distill-queue-close"
              aria-label="收起蒸馏队列"
              title="收起"
              onClick={onClose}
            >
              <HairlineCloseIcon size={14} />
            </button>
          )}
        </div>
      </header>

      <div className="distill-queue-body">
        {activeJobs.length === 0 && displayRecent.length === 0 ? (
          <div className="distill-queue-empty">当前没有正在蒸馏的任务</div>
        ) : (
          <>
            {activeJobs.length > 0 && (
              <>
                <div className="distill-queue-section-head">
                  <span>进行中（{activeJobs.length}）</span>
                </div>
                <div className="distill-queue-list">
                  {activeJobs.map(job => {
                    const busy = Boolean(busyJobIds[job.job_id])
                    const elapsed = formatElapsed(job, nowMs)
                    return (
                      <div key={job.job_id} className="distill-job-card">
                        <div className="distill-job-top">
                          <div className="distill-job-meta-main">
                            <span className="distill-job-title" title={job.title || job.task_id}>
                              {job.title || '视频标题待解析'}
                            </span>
                            <div className="distill-job-sub">
                              <span className="distill-job-status-dot distill-job-status-dot--active" aria-hidden="true" />
                              <span>{job.stage_message || '处理中'}</span>
                              {job.kind !== 'generate' && <span>· {KIND_LABELS[job.kind] || job.kind}</span>}
                              {job.model_name && <span>· {job.model_name}</span>}
                              {elapsed && <span>· {elapsed}</span>}
                            </div>
                          </div>
                          <div className="distill-job-actions">
                            <button
                              type="button"
                              className="distill-job-action-btn"
                              disabled={busy}
                              onClick={() => void cancel(job.job_id)}
                            >
                              {busy ? '取消中…' : '取消'}
                            </button>
                          </div>
                        </div>
                        <div
                          className="distill-job-progress-track"
                          role="progressbar"
                          aria-valuenow={job.progress}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`${job.title || '任务'}进度`}
                        >
                          <div
                            className="distill-job-progress-fill"
                            style={{ width: `${Math.max(4, Math.min(100, job.progress))}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {displayRecent.length > 0 && (
              <>
                <div className="distill-queue-section-head">
                  <span>近期记录（{recentJobs.length}）</span>
                  <button
                    type="button"
                    className="distill-queue-link-btn"
                    disabled={clearingFinished}
                    onClick={() => void clearFinished()}
                  >
                    {clearingFinished ? '清空中…' : '清空已完成'}
                  </button>
                </div>
                <div className="distill-queue-list">
                  {displayRecent.map(job => {
                    const busy = Boolean(busyJobIds[job.job_id])
                    const dotClass = job.status === 'SUCCESS'
                      ? 'distill-job-status-dot--success'
                      : job.status === 'FAILED'
                        ? 'distill-job-status-dot--failed'
                        : 'distill-job-status-dot--cancelled'
                    const statusLabel = job.status === 'SUCCESS'
                      ? '已完成'
                      : job.status === 'FAILED'
                        ? '失败'
                        : '已取消'

                    return (
                      <div key={job.job_id} className="distill-job-card">
                        <div className="distill-job-top">
                          <div className="distill-job-meta-main">
                            <span className="distill-job-title" title={job.title || job.task_id}>
                              {job.title || '未命名笔记'}
                            </span>
                            <div className="distill-job-sub">
                              <span className={`distill-job-status-dot ${dotClass}`} aria-hidden="true" />
                              <span>{statusLabel}</span>
                              {job.model_name && <span>· {job.model_name}</span>}
                            </div>
                          </div>
                          <div className="distill-job-actions">
                            {job.status === 'SUCCESS' ? (
                              <button
                                type="button"
                                className="distill-job-action-btn distill-job-action-btn--accent"
                                onClick={() => openNote(job.task_id)}
                              >
                                打开阅读
                              </button>
                            ) : (
                              <>
                                {job.retryable && (
                                  <button
                                    type="button"
                                    className="distill-job-action-btn"
                                    disabled={busy}
                                    onClick={() => void retry(job.job_id)}
                                  >
                                    {busy ? '重试中…' : '重试'}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="distill-job-action-btn"
                                  onClick={() => openNote(job.task_id)}
                                >
                                  详情
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        {job.status === 'FAILED' && job.error_summary && (
                          <p className="distill-job-error" title={job.error_summary}>
                            {job.error_summary}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  )
}
