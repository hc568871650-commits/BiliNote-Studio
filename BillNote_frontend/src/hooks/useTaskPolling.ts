import { useEffect } from 'react'
import { useTaskStore } from '@/store/taskStore'
import { getNote, get_task_status } from '@/services/note'
import { createTaskPollingScheduler, isActiveTask, pollingErrorMessage } from '@/utils/taskPolling'
import toast from 'react-hot-toast'
import { isKnownActivePhase } from '@/utils/taskProgress'

export const useTaskPolling = (interval = 3000) => {
  useEffect(() => {
    const scheduler = createTaskPollingScheduler({
      interval,
      concurrency: 3,
      getPending: () => {
        const state = useTaskStore.getState()
        return state.tasks.filter(isActiveTask).sort((a, b) => Number(b.id === state.currentTaskId) - Number(a.id === state.currentTaskId))
      },
      poll: async (task, signal) => {
        const current = () => useTaskStore.getState().tasks.find(t => t.id === task.id)
        const valid = () => !signal.aborted && current()?.attemptStartedAt === task.attemptStartedAt && Boolean(current() && isActiveTask(current()!))
        try {
          const res = await get_task_status(task.id, { signal, suppressToast: true })
          if (!valid()) return
          if (current()?.status === 'SUBMISSION_UNKNOWN' && res.request_id !== current()?.formData.request_id) return
          if (res.request_id && current()?.formData.request_id && res.request_id !== current()?.formData.request_id) return
          if (!res.status) throw new Error('服务未返回有效任务状态')
          const now = Date.now()
          const progress = {
            status: res.status, statusMessage: res.message || '', pollingError: undefined,
            submissionError: undefined,
            last_active_status: res.last_active_status || (isKnownActivePhase(res.status) ? res.status : current()?.last_active_status || (isKnownActivePhase(current()?.status) ? current()?.status : undefined)),
            started_at: res.started_at || current()?.started_at,
            finished_at: res.finished_at || current()?.finished_at,
            status_updated_at: res.status_updated_at || current()?.status_updated_at,
            ...(res.audio_meta?.title && current()?.audioMeta ? { audioMeta: { ...current()!.audioMeta, title: res.audio_meta.title } } : {}),
            lastStatusAt: now,
            phaseStartedAt: current()?.status === res.status ? current()?.phaseStartedAt : now,
          }
          if (res.status === 'SUCCESS') {
            // Read authoritative saved versions, not an intermediate markdown string.
            const detail = await getNote(task.id, { signal, suppressToast: true })
            if (!valid()) return
            if (detail.formData?.request_id && current()?.formData.request_id && detail.formData.request_id !== current()?.formData.request_id) return
            useTaskStore.getState().updateTaskContent(task.id, { ...detail, ...progress })
            toast.success('笔记生成成功', { id: `generation-${task.id}-${task.attemptStartedAt || task.createdAt}` })
          } else {
            useTaskStore.getState().updateTaskContent(task.id, progress)
          }
        } catch (error) {
          if (!valid()) return
          const message = pollingErrorMessage(error)
          // Transport failures cannot tell us whether the backend job failed.
          if (current()?.pollingError !== message) useTaskStore.getState().updateTaskContent(task.id, { pollingError: message })
        }
      },
    })
    const fingerprint = () => useTaskStore.getState().tasks.filter(isActiveTask).map(t => `${t.id}:${t.attemptStartedAt || ''}`).join('|')
    let pending = fingerprint()
    let selected = useTaskStore.getState().currentTaskId
    const unsubscribe = useTaskStore.subscribe(() => {
      const next = fingerprint()
      const currentId = useTaskStore.getState().currentTaskId
      const selectedChanged = currentId !== selected && useTaskStore.getState().tasks.some(t => t.id === currentId && isActiveTask(t))
      selected = currentId
      if (next !== pending || selectedChanged) { pending = next; scheduler.wake() }
    })
    const refresh = () => scheduler.wake()
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener('focus', refresh)
    window.addEventListener('bilinote-refresh-task', refresh)
    document.addEventListener('visibilitychange', visible)
    scheduler.wake()
    return () => {
      unsubscribe(); scheduler.stop()
      window.removeEventListener('focus', refresh)
      window.removeEventListener('bilinote-refresh-task', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [interval])
}
