import type { CustomJobStreamConnector, JobEventListener, JobSseEvent } from '@/services/jobs'
import {
  isJobActiveStatus,
  type DistillJobRecord,
  type DistillJobSnapshot,
  type JobKind,
  type JobStatus,
} from '@/utils/distillNotifications'

type TimerHandle = ReturnType<typeof setTimeout>

interface MockJobEntry {
  record: DistillJobRecord
  shouldFail: boolean
  timers: TimerHandle[]
  onComplete?: () => void
}

const listeners = new Set<JobEventListener>()
const entries = new Map<string, MockJobEntry>()

// 预置一条历史已完成记录，便于实测冷启动首包 snapshot 绝不误报历史任务
const seedNow = new Date(Date.now() - 1000 * 60 * 18).toISOString()
entries.set('preview-job-seed-1', {
  record: {
    job_id: 'preview-job-seed-1',
    task_id: 'ui-general-1',
    kind: 'generate',
    batch_id: null,
    title: '学习方法：用主动回忆巩固知识',
    status: 'SUCCESS',
    progress: 100,
    stage_message: '生成完成',
    model_name: '通用示例模型',
    provider_id: 'preview-1',
    created_at: seedNow,
    started_at: seedNow,
    finished_at: seedNow,
    updated_at: seedNow,
    error_summary: null,
    retryable: true,
  },
  shouldFail: false,
  timers: [],
})

function activeCount(): number {
  let count = 0
  for (const entry of entries.values()) {
    if (isJobActiveStatus(entry.record.status)) count += 1
  }
  return count
}

export function getPreviewJobsSnapshot(): DistillJobSnapshot {
  const all = Array.from(entries.values())
    .map(entry => ({ ...entry.record }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const active = all.filter(item => isJobActiveStatus(item.status))
  const recent = all.filter(item => !isJobActiveStatus(item.status)).slice(0, 50)
  return {
    active,
    recent,
    active_count: active.length,
  }
}

function broadcast(event: JobSseEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // 单个监听器异常不影响其它订阅者
    }
  }
}

function clearTimers(entry: MockJobEntry): void {
  entry.timers.forEach(timer => globalThis.clearTimeout(timer))
  entry.timers = []
}

const STAGES: Array<{ status: JobStatus; progress: number; stage_message: string; delayMs: number }> = [
  { status: 'DOWNLOADING', progress: 24, stage_message: '正在获取视频与音轨', delayMs: 850 },
  { status: 'TRANSCRIBING', progress: 52, stage_message: '正在转写字幕分段', delayMs: 1850 },
  { status: 'SUMMARIZING', progress: 78, stage_message: '模型正在提炼结构化知识', delayMs: 3000 },
  { status: 'SAVING', progress: 94, stage_message: '正在保存版本与索引', delayMs: 4050 },
]

function scheduleProgress(entry: MockJobEntry, offsetMs = 0): void {
  clearTimers(entry)
  const { record } = entry
  for (const step of STAGES) {
    const timer = globalThis.setTimeout(() => {
      if (!isJobActiveStatus(entry.record.status)) return
      const now = new Date().toISOString()
      entry.record.started_at = entry.record.started_at || now
      entry.record.status = step.status
      entry.record.progress = step.progress
      entry.record.stage_message = step.stage_message
      entry.record.updated_at = now
      broadcast({
        type: 'job.updated',
        data: { job: { ...entry.record }, active_count: activeCount() },
      })
    }, offsetMs + step.delayMs)
    ;(timer as { unref?: () => void }).unref?.()
    entry.timers.push(timer)
  }

  const endTimer = globalThis.setTimeout(() => {
    if (!isJobActiveStatus(entry.record.status)) return
    const now = new Date().toISOString()
    entry.record.progress = 100
    entry.record.finished_at = now
    entry.record.updated_at = now
    if (entry.shouldFail) {
      entry.record.status = 'FAILED'
      entry.record.stage_message = '执行失败'
      entry.record.error_summary = '【模拟】模型响应超时，可一键重试'
      const remaining = activeCount()
      broadcast({
        type: 'job.failed',
        data: { job: { ...entry.record }, active_count: remaining },
      })
      if (remaining === 0) {
        broadcast({ type: 'queue.drained', data: { active_count: 0, last_job: { ...entry.record } } })
      }
      return
    }
    entry.record.status = 'SUCCESS'
    entry.record.stage_message = '生成完成'
    entry.record.error_summary = null
    entry.onComplete?.()
    const remaining = activeCount()
    broadcast({
      type: 'job.completed',
      data: { job: { ...entry.record }, active_count: remaining },
    })
    if (remaining === 0) {
      broadcast({ type: 'queue.drained', data: { active_count: 0, last_job: { ...entry.record } } })
    }
  }, offsetMs + 4850)
  ;(endTimer as { unref?: () => void }).unref?.()
  entry.timers.push(endTimer)
}

export function enqueuePreviewJob(options: {
  taskId: string
  title: string
  modelName?: string
  providerId?: string
  kind?: JobKind
  batchId?: string | null
  shouldFail?: boolean
  offsetMs?: number
  onComplete?: () => void
}): DistillJobRecord {
  const now = new Date().toISOString()
  const jobId = `preview-job-${crypto.randomUUID().slice(0, 8)}`
  const record: DistillJobRecord = {
    job_id: jobId,
    task_id: options.taskId,
    kind: options.kind || 'generate',
    batch_id: options.batchId ?? null,
    title: options.title,
    status: 'QUEUED',
    progress: 6,
    stage_message: '排队等待中',
    model_name: options.modelName || '通用示例模型',
    provider_id: options.providerId || 'preview-1',
    created_at: now,
    started_at: null,
    finished_at: null,
    updated_at: now,
    error_summary: null,
    retryable: true,
  }
  const entry: MockJobEntry = {
    record,
    shouldFail: Boolean(options.shouldFail),
    timers: [],
    onComplete: options.onComplete,
  }
  entries.set(jobId, entry)
  broadcast({
    type: 'job.updated',
    data: { job: { ...record }, active_count: activeCount() },
  })
  scheduleProgress(entry, options.offsetMs || 0)
  return { ...record }
}

export function cancelPreviewJob(jobId: string): boolean {
  const entry = entries.get(jobId)
  if (!entry || !isJobActiveStatus(entry.record.status)) return false
  clearTimers(entry)
  const now = new Date().toISOString()
  entry.record.status = 'CANCELLED'
  entry.record.progress = 100
  entry.record.stage_message = '任务已取消'
  entry.record.finished_at = now
  entry.record.updated_at = now
  const remaining = activeCount()
  broadcast({
    type: 'job.cancelled',
    data: { job: { ...entry.record }, active_count: remaining },
  })
  if (remaining === 0) {
    broadcast({ type: 'queue.drained', data: { active_count: 0, last_job: { ...entry.record } } })
  }
  return true
}

export function retryPreviewJob(jobId: string): DistillJobRecord {
  const old = entries.get(jobId)
  if (!old) throw new Error('任务不存在')
  return enqueuePreviewJob({
    taskId: old.record.task_id,
    title: old.record.title,
    modelName: old.record.model_name,
    providerId: old.record.provider_id,
    kind: old.record.kind,
    batchId: old.record.batch_id,
    shouldFail: false,
    onComplete: old.onComplete,
  })
}

export function clearPreviewFinishedJobs(): number {
  let cleared = 0
  for (const [id, entry] of Array.from(entries.entries())) {
    if (!isJobActiveStatus(entry.record.status)) {
      clearTimers(entry)
      entries.delete(id)
      cleared += 1
    }
  }
  broadcast({ type: 'snapshot', data: getPreviewJobsSnapshot() })
  return cleared
}

export function createPreviewJobStreamConnector(): CustomJobStreamConnector {
  return ({ onEvent, onStateChange }) => {
    listeners.add(onEvent)
    onStateChange?.('mock')
    // 异步发出首包 snapshot，模拟真实 SSE 建连首帧
    const timer = globalThis.setTimeout(() => {
      onEvent({ type: 'snapshot', data: getPreviewJobsSnapshot() })
    }, 30)
    ;(timer as { unref?: () => void }).unref?.()
    return () => {
      globalThis.clearTimeout(timer)
      listeners.delete(onEvent)
      onStateChange?.('idle')
    }
  }
}
