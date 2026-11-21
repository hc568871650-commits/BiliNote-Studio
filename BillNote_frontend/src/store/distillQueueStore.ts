import { create } from 'zustand'
import toast from 'react-hot-toast'
import {
  cancelJob,
  clearFinishedJobs,
  listJobs,
  retryJob,
  subscribeJobEvents,
  type JobConnectionState,
  type JobSseEvent,
} from '@/services/jobs'
import {
  createInitialTrackerState,
  evaluateNotificationTransition,
  isJobActiveStatus,
  normalizeNotificationMode,
  readNotificationMode,
  requestDesktopNotificationPermissionIfNeeded,
  sendSystemDesktopNotification,
  writeNotificationMode,
  type DistillJobRecord,
  type DistillNotificationItem,
  type DistillNotificationMode,
  type NotificationTrackerState,
} from '@/utils/distillNotifications'
import { useTaskStore } from '@/store/taskStore'

const MAX_RECENT_JOBS = 50
const MAX_VISIBLE_TOASTS = 3

interface DistillQueueState {
  activeJobs: DistillJobRecord[]
  recentJobs: DistillJobRecord[]
  activeCount: number
  connectionState: JobConnectionState
  notificationMode: DistillNotificationMode
  toasts: DistillNotificationItem[]
  panelOpen: boolean
  busyJobIds: Record<string, boolean>
  clearingFinished: boolean
  setNotificationMode: (mode: DistillNotificationMode) => void
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  dismissToast: (id: string) => void
  clearToasts: () => void
  connect: () => () => void
  disconnect: () => void
  refresh: () => Promise<void>
  cancel: (jobId: string) => Promise<void>
  retry: (jobId: string) => Promise<void>
  clearFinished: () => Promise<void>
  hasActiveJobForTask: (taskId: string) => DistillJobRecord | undefined
}

let activeUnsubscribe: (() => void) | null = null
let activeSubscribers = 0
let trackerState: NotificationTrackerState = createInitialTrackerState()
let noteSyncTimer: number | null = null

function sortByCreatedDesc(items: DistillJobRecord[]): DistillJobRecord[] {
  return [...items].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
}

function upsertJobLists(
  activeJobs: DistillJobRecord[],
  recentJobs: DistillJobRecord[],
  job: DistillJobRecord,
): { activeJobs: DistillJobRecord[]; recentJobs: DistillJobRecord[] } {
  const nextActive = activeJobs.filter(item => item.job_id !== job.job_id)
  const nextRecent = recentJobs.filter(item => item.job_id !== job.job_id)
  if (isJobActiveStatus(job.status)) {
    nextActive.unshift(job)
    return {
      activeJobs: sortByCreatedDesc(nextActive),
      recentJobs: nextRecent,
    }
  }
  nextRecent.unshift(job)
  return {
    activeJobs: nextActive,
    recentJobs: sortByCreatedDesc(nextRecent).slice(0, MAX_RECENT_JOBS),
  }
}

function scheduleNoteSync(taskId?: string): void {
  if (typeof window === 'undefined') return
  if (noteSyncTimer !== null) {
    window.clearTimeout(noteSyncTimer)
  }
  noteSyncTimer = window.setTimeout(() => {
    noteSyncTimer = null
    const taskStore = useTaskStore.getState()
    void taskStore.syncNotes().catch(() => undefined)
    if (taskId) {
      void taskStore.loadTask(taskId).catch(() => undefined)
    }
  }, 180)
}

function createDistillQueueStore() {
  return create<DistillQueueState>((set, get) => {
  const dispatchNotifications = (items: DistillNotificationItem[]) => {
    if (!items.length) return
    items.forEach(item => sendSystemDesktopNotification(item))
    set(state => ({
      toasts: [...items, ...state.toasts].slice(0, MAX_VISIBLE_TOASTS),
    }))
  }

  const handleEvent = (event: JobSseEvent) => {
    const mode = get().notificationMode

    if (event.type === 'snapshot') {
      const active = sortByCreatedDesc(event.data.active || [])
      const recent = sortByCreatedDesc(event.data.recent || []).slice(0, MAX_RECENT_JOBS)
      const { next, notifications } = evaluateNotificationTransition(
        trackerState,
        { type: 'snapshot', active, recent },
        mode,
      )
      trackerState = next
      set({
        activeJobs: active,
        recentJobs: recent,
        activeCount: typeof event.data.active_count === 'number' ? event.data.active_count : active.length,
      })
      dispatchNotifications(notifications)
      return
    }

    if (event.type === 'queue.drained') {
      return
    }

    const job = event.data?.job
    if (!job) return
    const { activeJobs, recentJobs } = upsertJobLists(get().activeJobs, get().recentJobs, job)
    const activeCount = typeof event.data.active_count === 'number'
      ? event.data.active_count
      : activeJobs.length

    const { next, notifications } = evaluateNotificationTransition(
      trackerState,
      {
        type: 'job_event',
        eventName: event.type,
        job,
        activeCount,
      },
      mode,
    )
    trackerState = next

    set({
      activeJobs,
      recentJobs,
      activeCount,
    })

    if (event.type === 'job.completed' || event.type === 'job.failed') {
      scheduleNoteSync(job.task_id)
    }

    dispatchNotifications(notifications)
  }

  return {
    activeJobs: [],
    recentJobs: [],
    activeCount: 0,
    connectionState: 'idle',
    notificationMode: readNotificationMode(),
    toasts: [],
    panelOpen: false,
    busyJobIds: {},
    clearingFinished: false,

    setNotificationMode: (mode) => {
      const normalized = normalizeNotificationMode(mode)
      writeNotificationMode(normalized)
      if (normalized !== 'off') {
        requestDesktopNotificationPermissionIfNeeded()
      }
      set({ notificationMode: normalized })
    },

    setPanelOpen: (open) => set({ panelOpen: open }),
    togglePanel: () => set(state => ({ panelOpen: !state.panelOpen })),

    dismissToast: (id) => set(state => ({
      toasts: state.toasts.filter(item => item.id !== id),
    })),

    clearToasts: () => set({ toasts: [] }),

    connect: () => {
      activeSubscribers += 1
      if (!activeUnsubscribe) {
        trackerState = createInitialTrackerState()
        activeUnsubscribe = subscribeJobEvents(handleEvent, (connectionState) => {
          set({ connectionState })
        })
      }
      let released = false
      return () => {
        if (released) return
        released = true
        activeSubscribers = Math.max(0, activeSubscribers - 1)
        if (activeSubscribers === 0) {
          get().disconnect()
        }
      }
    },

    disconnect: () => {
      if (activeUnsubscribe) {
        activeUnsubscribe()
        activeUnsubscribe = null
      }
      activeSubscribers = 0
      set({ connectionState: 'idle' })
    },

    refresh: async () => {
      try {
        const snapshot = await listJobs()
        handleEvent({ type: 'snapshot', data: snapshot })
      } catch {
        // 刷新失败静默保留现有快照
      }
    },

    cancel: async (jobId) => {
      set(state => ({ busyJobIds: { ...state.busyJobIds, [jobId]: true } }))
      try {
        await cancelJob(jobId)
        toast.success('已请求取消任务')
      } catch (error) {
        const msg = (error as { msg?: string; message?: string })?.msg || '取消任务失败'
        toast.error(msg)
      } finally {
        set(state => {
          const next = { ...state.busyJobIds }
          delete next[jobId]
          return { busyJobIds: next }
        })
      }
    },

    retry: async (jobId) => {
      set(state => ({ busyJobIds: { ...state.busyJobIds, [jobId]: true } }))
      try {
        await retryJob(jobId)
        toast.success('已重新加入蒸馏队列')
      } catch (error) {
        const msg = (error as { msg?: string; message?: string })?.msg || '重试任务失败'
        toast.error(msg)
      } finally {
        set(state => {
          const next = { ...state.busyJobIds }
          delete next[jobId]
          return { busyJobIds: next }
        })
      }
    },

    clearFinished: async () => {
      if (get().clearingFinished) return
      set({ clearingFinished: true })
      try {
        await clearFinishedJobs()
        set({ recentJobs: [] })
      } catch (error) {
        const msg = (error as { msg?: string; message?: string })?.msg || '清空已完成记录失败'
        toast.error(msg)
      } finally {
        set({ clearingFinished: false })
      }
    },

    hasActiveJobForTask: (taskId) => get().activeJobs.find(job => job.task_id === taskId),
  }
  })
}

const DISTILL_STORE_GLOBAL_KEY = '__bilinote_distill_queue_store_v1__'
type DistillStoreGlobal = typeof globalThis & {
  [DISTILL_STORE_GLOBAL_KEY]?: ReturnType<typeof createDistillQueueStore>
}

export const useDistillQueueStore: ReturnType<typeof createDistillQueueStore> =
  (globalThis as DistillStoreGlobal)[DISTILL_STORE_GLOBAL_KEY]
  ?? ((globalThis as DistillStoreGlobal)[DISTILL_STORE_GLOBAL_KEY] = createDistillQueueStore())
