export type DistillNotificationMode = 'all_done' | 'each' | 'off'

export const DEFAULT_DISTILL_NOTIFICATION_MODE: DistillNotificationMode = 'all_done'
export const DISTILL_NOTIFY_MODE_STORAGE_KEY = 'bilinote-distill-notify-mode-v1'

export type JobStatus =
  | 'QUEUED'
  | 'PARSING'
  | 'DOWNLOADING'
  | 'TRANSCRIBING'
  | 'SUMMARIZING'
  | 'FORMATTING'
  | 'SAVING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED'

export type JobKind = 'generate' | 'regenerate' | 'upgrade_structured' | 'batch_item'

export interface DistillJobRecord {
  job_id: string
  task_id: string
  kind: JobKind
  batch_id: string | null
  title: string
  status: JobStatus
  progress: number
  stage_message: string
  model_name: string
  provider_id: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
  error_summary: string | null
  retryable: boolean
}

export interface DistillJobSnapshot {
  active: DistillJobRecord[]
  recent: DistillJobRecord[]
  active_count: number
}

export interface DistillNotificationItem {
  id: string
  kind: 'single_success' | 'single_failed' | 'batch_done'
  title: string
  detail: string
  taskId?: string
  jobId?: string
  succeededCount: number
  failedCount: number
  createdAt: number
}

export interface NotificationTrackerState {
  initialized: boolean
  trackedActiveIds: Record<string, DistillJobRecord>
  batchSucceeded: number
  batchFailed: number
  batchCancelled: number
  lastSucceededJob: DistillJobRecord | null
  lastFailedJob: DistillJobRecord | null
}

export type QueueTransitionInput =
  | {
      type: 'snapshot'
      active: DistillJobRecord[]
      recent: DistillJobRecord[]
    }
  | {
      type: 'job_event'
      eventName: 'job.updated' | 'job.completed' | 'job.failed' | 'job.cancelled'
      job: DistillJobRecord
      activeCount?: number
    }

const ACTIVE_STATUS_SET = new Set<string>([
  'QUEUED',
  'PARSING',
  'DOWNLOADING',
  'TRANSCRIBING',
  'SUMMARIZING',
  'FORMATTING',
  'SAVING',
])

export function isJobActiveStatus(status?: string): boolean {
  return Boolean(status && ACTIVE_STATUS_SET.has(status))
}

export function createInitialTrackerState(): NotificationTrackerState {
  return {
    initialized: false,
    trackedActiveIds: {},
    batchSucceeded: 0,
    batchFailed: 0,
    batchCancelled: 0,
    lastSucceededJob: null,
    lastFailedJob: null,
  }
}

let notificationSeq = 0
function nextNotificationId(prefix: string): string {
  notificationSeq += 1
  return `${prefix}-${Date.now()}-${notificationSeq}`
}

function safeTitle(job: DistillJobRecord): string {
  const title = job.title?.trim()
  return title || '未命名笔记'
}

function buildSingleNotification(job: DistillJobRecord): DistillNotificationItem | null {
  if (job.status === 'SUCCESS') {
    return {
      id: nextNotificationId('single-ok'),
      kind: 'single_success',
      title: '蒸馏完成',
      detail: safeTitle(job),
      taskId: job.task_id,
      jobId: job.job_id,
      succeededCount: 1,
      failedCount: 0,
      createdAt: Date.now(),
    }
  }
  if (job.status === 'FAILED') {
    const err = job.error_summary?.trim() || job.stage_message?.trim() || '请查看失败详情'
    return {
      id: nextNotificationId('single-fail'),
      kind: 'single_failed',
      title: '蒸馏失败',
      detail: `${safeTitle(job)} · ${err}`,
      taskId: job.task_id,
      jobId: job.job_id,
      succeededCount: 0,
      failedCount: 1,
      createdAt: Date.now(),
    }
  }
  return null
}

function buildBatchSummaryNotification(state: NotificationTrackerState): DistillNotificationItem | null {
  const { batchSucceeded, batchFailed, lastSucceededJob, lastFailedJob } = state
  if (batchSucceeded === 0 && batchFailed === 0) return null

  if (batchSucceeded === 1 && batchFailed === 0 && lastSucceededJob) {
    return {
      id: nextNotificationId('batch-single-ok'),
      kind: 'batch_done',
      title: '蒸馏完成',
      detail: safeTitle(lastSucceededJob),
      taskId: lastSucceededJob.task_id,
      jobId: lastSucceededJob.job_id,
      succeededCount: 1,
      failedCount: 0,
      createdAt: Date.now(),
    }
  }

  if (batchSucceeded > 1 && batchFailed === 0) {
    const tail = lastSucceededJob ? `最近完成：${safeTitle(lastSucceededJob)}` : `共 ${batchSucceeded} 篇笔记已就绪`
    return {
      id: nextNotificationId('batch-all-ok'),
      kind: 'batch_done',
      title: `全部蒸馏完成（${batchSucceeded} 篇）`,
      detail: tail,
      taskId: lastSucceededJob?.task_id,
      jobId: lastSucceededJob?.job_id,
      succeededCount: batchSucceeded,
      failedCount: 0,
      createdAt: Date.now(),
    }
  }

  if (batchSucceeded === 0 && batchFailed >= 1) {
    const firstDetail = lastFailedJob
      ? `${safeTitle(lastFailedJob)}${lastFailedJob.error_summary ? ` · ${lastFailedJob.error_summary}` : ''}`
      : '请打开队列查看失败详情'
    return {
      id: nextNotificationId('batch-fail'),
      kind: 'batch_done',
      title: batchFailed === 1 ? '蒸馏失败' : `蒸馏结束（${batchFailed} 篇失败）`,
      detail: firstDetail,
      taskId: lastFailedJob?.task_id,
      jobId: lastFailedJob?.job_id,
      succeededCount: 0,
      failedCount: batchFailed,
      createdAt: Date.now(),
    }
  }

  return {
    id: nextNotificationId('batch-mixed'),
    kind: 'batch_done',
    title: `队列已完成（成功 ${batchSucceeded} · 失败 ${batchFailed}）`,
    detail: lastSucceededJob
      ? `可直接打开《${safeTitle(lastSucceededJob)}》，失败项支持队列重试`
      : '部分任务失败，可在队列中重试',
    taskId: lastSucceededJob?.task_id || lastFailedJob?.task_id,
    jobId: lastSucceededJob?.job_id || lastFailedJob?.job_id,
    succeededCount: batchSucceeded,
    failedCount: batchFailed,
    createdAt: Date.now(),
  }
}

function resetBatchCounters(state: NotificationTrackerState): NotificationTrackerState {
  return {
    ...state,
    batchSucceeded: 0,
    batchFailed: 0,
    batchCancelled: 0,
    lastSucceededJob: null,
    lastFailedJob: null,
  }
}

function applyTerminalJob(
  state: NotificationTrackerState,
  job: DistillJobRecord,
  mode: DistillNotificationMode,
  remainingActiveCount: number,
  notifications: DistillNotificationItem[],
): NotificationTrackerState {
  let next: NotificationTrackerState = {
    ...state,
    trackedActiveIds: { ...state.trackedActiveIds },
  }
  delete next.trackedActiveIds[job.job_id]

  if (job.status === 'SUCCESS') {
    next.batchSucceeded += 1
    next.lastSucceededJob = job
  } else if (job.status === 'FAILED') {
    next.batchFailed += 1
    next.lastFailedJob = job
  } else if (job.status === 'CANCELLED') {
    next.batchCancelled += 1
  }

  if (mode === 'off') {
    return remainingActiveCount === 0 ? resetBatchCounters(next) : next
  }

  if (mode === 'each') {
    const item = buildSingleNotification(job)
    if (item) notifications.push(item)
    return remainingActiveCount === 0 ? resetBatchCounters(next) : next
  }

  // mode === 'all_done'
  if (remainingActiveCount === 0) {
    const summary = buildBatchSummaryNotification(next)
    if (summary) notifications.push(summary)
    return resetBatchCounters(next)
  }

  return next
}

export function evaluateNotificationTransition(
  prev: NotificationTrackerState,
  input: QueueTransitionInput,
  mode: DistillNotificationMode,
): { next: NotificationTrackerState; notifications: DistillNotificationItem[] } {
  const notifications: DistillNotificationItem[] = []

  if (input.type === 'snapshot') {
    const activeMap: Record<string, DistillJobRecord> = {}
    for (const job of input.active) {
      if (isJobActiveStatus(job.status)) {
        activeMap[job.job_id] = job
      }
    }

    // 冷启动首包：仅登记活跃任务，绝不回放历史终态任务提醒
    if (!prev.initialized) {
      return {
        next: {
          ...createInitialTrackerState(),
          initialized: true,
          trackedActiveIds: activeMap,
        },
        notifications,
      }
    }

    // 断线重连后的增量收敛：找出之前在追踪、现已进入终态的任务
    const recentById = new Map<string, DistillJobRecord>()
    for (const item of input.recent) {
      recentById.set(item.job_id, item)
    }

    let state: NotificationTrackerState = {
      ...prev,
      trackedActiveIds: { ...prev.trackedActiveIds },
    }
    const newlyTerminated: DistillJobRecord[] = []
    for (const oldId of Object.keys(prev.trackedActiveIds)) {
      if (!activeMap[oldId]) {
        const finished = recentById.get(oldId)
        if (finished && !isJobActiveStatus(finished.status)) {
          newlyTerminated.push(finished)
        } else {
          delete state.trackedActiveIds[oldId]
        }
      }
    }
    // 合并最新仍在运行的任务
    for (const [id, job] of Object.entries(activeMap)) {
      state.trackedActiveIds[id] = job
    }

    const totalNewTerminals = newlyTerminated.length
    newlyTerminated.forEach((finished, idx) => {
      const remaining = Object.keys(activeMap).length + (totalNewTerminals - 1 - idx)
      state = applyTerminalJob(state, finished, mode, remaining, notifications)
    })

    if (Object.keys(activeMap).length === 0 && notifications.length === 0) {
      state = resetBatchCounters(state)
    }

    return { next: state, notifications }
  }

  // 增量 job_event 处理
  const { job } = input
  if (isJobActiveStatus(job.status)) {
    return {
      next: {
        ...prev,
        initialized: true,
        trackedActiveIds: {
          ...prev.trackedActiveIds,
          [job.job_id]: job,
        },
      },
      notifications,
    }
  }

  // 终态事件：仅在之前已初始化或任务处于当前追踪集内时结算
  const wasTracked = Boolean(prev.trackedActiveIds[job.job_id])
  if (!wasTracked && !prev.initialized) {
    return { next: { ...prev, initialized: true }, notifications }
  }

  const nextActiveIds = { ...prev.trackedActiveIds }
  delete nextActiveIds[job.job_id]
  const remainingActive = typeof input.activeCount === 'number'
    ? Math.max(0, input.activeCount)
    : Object.keys(nextActiveIds).length

  const nextState = applyTerminalJob(
    { ...prev, initialized: true },
    job,
    mode,
    remainingActive,
    notifications,
  )
  return { next: nextState, notifications }
}

export function normalizeNotificationMode(raw: unknown): DistillNotificationMode {
  if (raw === 'all_done' || raw === 'each' || raw === 'off') return raw
  return DEFAULT_DISTILL_NOTIFICATION_MODE
}

export function readNotificationMode(): DistillNotificationMode {
  if (typeof window === 'undefined') return DEFAULT_DISTILL_NOTIFICATION_MODE
  try {
    return normalizeNotificationMode(window.localStorage.getItem(DISTILL_NOTIFY_MODE_STORAGE_KEY))
  } catch {
    return DEFAULT_DISTILL_NOTIFICATION_MODE
  }
}

export function writeNotificationMode(mode: DistillNotificationMode): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DISTILL_NOTIFY_MODE_STORAGE_KEY, mode)
  } catch {
    // 存储不可用时保持内存生效
  }
}

export function sendSystemDesktopNotification(item: DistillNotificationItem): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (!document.hidden) return
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  try {
    const notice = new Notification(`BiliNote Studio · ${item.title}`, {
      body: item.detail,
      tag: item.jobId || item.id,
      silent: false,
    })
    notice.onclick = () => {
      try {
        window.focus()
      } catch {
        // 忽略聚焦失败
      }
      notice.close()
    }
  } catch {
    // 无桌面通知支持时静默回退应用内浮卡
  }
}

export function requestDesktopNotificationPermissionIfNeeded(): void {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return
  if (Notification.permission === 'default') {
    void Notification.requestPermission().catch(() => undefined)
  }
}
