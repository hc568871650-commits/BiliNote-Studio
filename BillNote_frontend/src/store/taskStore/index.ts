import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { archiveNote, deleteNote, generateNote, getNote, importNotes, listNotes, restoreNote } from '@/services/note.ts'
import { useChatStore } from '@/store/chatStore'
import { useReadingAssistantStore, permanentSessionKey, temporarySessionKey } from '@/store/readingAssistantStore'
import { v4 as uuidv4 } from 'uuid'
import toast from 'react-hot-toast'
import { createTaskStorage } from '@/utils/taskStorage'
import { mergeTaskSnapshot } from '@/utils/taskProgress'


export type TaskStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | string

export interface AudioMeta {
  cover_url: string
  duration: number
  file_path: string
  platform: string
  raw_info: any
  title: string
  video_id: string
}

export interface Segment {
  start: number
  end: number
  text: string
}

export interface Transcript {
  full_text: string
  language: string
  raw: any
  segments: Segment[]
}
export interface Markdown {
  ver_id: string
  content: string
  style: string
  model_name: string
  provider_id?: string
  protocol?: 'openai-chat' | 'openai-responses' | 'anthropic'
  created_at: string
  resource_base?: string
}

export interface Task {
  id: string
  markdown: string|Markdown [] //为了兼容之前的笔记
  transcript: Transcript
  status: TaskStatus
  statusMessage?: string
  last_active_status?: string
  started_at?: string | null
  finished_at?: string | null
  status_updated_at?: string | null
  pollingError?: string
  lastStatusAt?: number
  phaseStartedAt?: number
  attemptStartedAt?: number
  submissionError?: string
  submissionInFlight?: boolean
  audioMeta: AudioMeta
  createdAt: string
  archived_at?: string | null
  resource_base?: string
  formData: {
    request_id?: string
    video_url: string
    link: undefined | boolean
    screenshot: undefined | boolean
    platform: string
    quality: string
    model_name: string
    provider_id: string
    style?: string
  }
}

interface TaskStore {
  tasks: Task[]
  currentTaskId: string | null
  addPendingTask: (taskId: string, platform: string, formData: any) => void
  updateTaskContent: (id: string, data: Partial<Omit<Task, 'id' | 'createdAt'>>) => void
  archiveTask: (id: string) => Promise<void>
  restoreTask: (id: string) => Promise<void>
  removeTask: (id: string) => Promise<void>
  syncNotes: () => Promise<void>
  loadTask: (id: string) => Promise<void>
  clearTasks: () => void
  setCurrentTask: (taskId: string | null) => void
  getCurrentTask: () => Task | null
  retryTask: (id: string, payload?: any) => Promise<void>
  resumeSubmission: (id: string) => Promise<void>
}

const taskStorage = createTaskStorage<TaskStore>()
const submittingTasks = new Set<string>()

export const useTaskStore = create<TaskStore>()(
  persist(
    (set, get) => ({
      tasks: [],
      currentTaskId: null,

      addPendingTask: (taskId: string, platform: string, formData: any) =>

        set(state => ({
          tasks: [
            {
              formData: formData,
              id: taskId,
              status: 'PENDING',
              last_active_status: 'PENDING',
              phaseStartedAt: Date.now(),
              attemptStartedAt: Date.now(),
              markdown: '',
              platform: platform,
              transcript: {
                full_text: '',
                language: '',
                raw: null,
                segments: [],
              },
              createdAt: new Date().toISOString(),
              audioMeta: {
                cover_url: '',
                duration: 0,
                file_path: '',
                platform: '',
                raw_info: null,
                title: platform === 'local' ? formData.video_url?.split(/[\\/]/).pop() || '' : formData.title || '',
                video_id: '',
              },
            },
            ...state.tasks,
          ],
          currentTaskId: taskId, // 默认设置为当前任务
        })),

      updateTaskContent: (id, data) =>
          set(state => ({
            tasks: state.tasks.map(task => {
              if (task.id !== id) return task

              // Repeated SUCCESS must not append duplicate versions, but still refresh progress.
              if (task.status === 'SUCCESS' && data.status === 'SUCCESS' && typeof data.markdown === 'string') {
                const { markdown: _markdown, ...metadata } = data
                return { ...task, ...metadata }
              }

              // 如果是 markdown 字符串，封装为版本
              if (typeof data.markdown === 'string') {
                const prev = task.markdown
                const newVersion: Markdown = {
                  ver_id: `${task.id}-${uuidv4()}`,
                  content: data.markdown,
                  style: task.formData.style || '',
                  model_name: task.formData.model_name || '',
                  created_at: new Date().toISOString(),
                  resource_base: data.resource_base,
                }

                let updatedMarkdown: Markdown[]
                if (Array.isArray(prev)) {
                  updatedMarkdown = [newVersion, ...prev]
                } else {
                  updatedMarkdown = [
                    newVersion,
                    ...(typeof prev === 'string' && prev
                        ? [{
                          ver_id: `${task.id}-${uuidv4()}`,
                          content: prev,
                          style: task.formData.style || '',
                          model_name: task.formData.model_name || '',
                          created_at: new Date().toISOString(),
                        }]
                        : []),
                  ]
                }

                return {
                  ...task,
                  ...data,
                  markdown: updatedMarkdown,
                }
              }

              return { ...task, ...data }
            }),
          })),


      getCurrentTask: () => {
        const currentTaskId = get().currentTaskId
        return get().tasks.find(task => task.id === currentTaskId) || null
      },
      retryTask: async (id: string, payload?: any) => {

        if (!id){
          toast.error('任务不存在')
          throw new Error('任务不存在')
        }
        const task = get().tasks.find(task => task.id === id)
        if (!task) throw new Error('任务不存在')
        const resuming = Boolean(payload?.resume_submission && task.status === 'SUBMISSION_UNKNOWN' && payload.request_id === task.formData.request_id)
        if (submittingTasks.has(id) || (!resuming && !['SUCCESS', 'FAILED'].includes(task.status))) throw new Error('当前请求尚未结束，请等待自动核对结果，避免重复提交')
        if (task.archived_at) {
          toast.error('请先恢复归档笔记再重新生成')
          throw new Error('请先恢复归档笔记再重新生成')
        }

        const { resume_submission: _resume, ...submissionData } = payload || task.formData
        const newFormData = { ...submissionData, request_id: payload?.request_id || uuidv4() }
        submittingTasks.add(id)
        get().updateTaskContent(id, {
          formData: newFormData, status: 'SUBMISSION_UNKNOWN', submissionInFlight: true,
          statusMessage: '提交结果尚未确认，正在自动核对同一请求；请勿重复提交。',
          ...(resuming ? {} : { last_active_status: undefined, started_at: undefined, finished_at: undefined, status_updated_at: undefined, lastStatusAt: undefined, pollingError: undefined, attemptStartedAt: Date.now() }),
        })
        try {
          // Save the idempotency key before network I/O so a crash cannot lose this attempt.
          await taskStorage.flush()
          await generateNote({
            ...newFormData,
            task_id: id,
          }, { suppressToast: true })
        } catch (e: any) {
          console.error('重试任务失败：', e)
          const uncertain = !e?.code || e.code === -1 || e.code >= 500
          const current = get().tasks.find(t => t.id === id)
          if (!uncertain && !resuming && current?.status === 'SUBMISSION_UNKNOWN' && current.formData.request_id === newFormData.request_id) {
            set(state => ({ tasks: state.tasks.map(t => t.id === id ? { ...task, submissionInFlight: false, submissionError: e?.msg || e?.message || '提交被拒绝' } : t) }))
            throw e
          }
          get().updateTaskContent(id, {
            submissionError: e?.msg || e?.message || '提交结果未知，请按任务编号核对后再决定是否重新提交',
            ...(uncertain && current?.status === 'SUBMISSION_UNKNOWN' ? {
              formData: newFormData,
              status: 'SUBMISSION_UNKNOWN',
              statusMessage: '提交结果尚未确认，正在自动核对同一请求；请勿重复提交。',
              last_active_status: undefined,
              started_at: undefined,
              finished_at: undefined,
              lastStatusAt: undefined,
              pollingError: undefined,
            } : {}),
          })
          throw e
        } finally {
          submittingTasks.delete(id)
          get().updateTaskContent(id, { submissionInFlight: false })
        }

        set(state => ({
          tasks: state.tasks.map(t =>
              t.id === id && t.status === 'SUBMISSION_UNKNOWN' && t.formData.request_id === newFormData.request_id
                  ? {
                    ...t,
                    formData: newFormData, // ✅ 显式更新 formData
                    status: 'PENDING',
                    last_active_status: 'PENDING',
                    started_at: undefined,
                    finished_at: undefined,
                    status_updated_at: undefined,
                    statusMessage: '',
                    pollingError: undefined,
                    submissionError: undefined,
                    lastStatusAt: undefined,
                    phaseStartedAt: Date.now(),
                    attemptStartedAt: t.attemptStartedAt,
                  }
                  : t
          ),
        }))
      },

      resumeSubmission: async id => {
        const task = get().tasks.find(t => t.id === id)
        if (!task || task.status !== 'SUBMISSION_UNKNOWN' || !task.formData.request_id) throw new Error('没有待核对的提交请求')
        await get().retryTask(id, { ...task.formData, resume_submission: true })
      },


      syncNotes: async () => {
        // Keep the old IndexedDB snapshot until the server confirms its import.
        const localTasks = get().tasks
        try {
          if (localTasks.length) await importNotes(localTasks)
          const remote = await listNotes()
          set(state => ({
            tasks: remote.map(t => {
              const local = state.tasks.find(existing => existing.id === t.id)
              const before = localTasks.find(existing => existing.id === t.id)
              return local && local.formData?.request_id !== before?.formData?.request_id ? local : mergeTaskSnapshot(local, t)
            }),
            currentTaskId: state.currentTaskId && remote.some(t => t.id === state.currentTaskId)
              ? state.currentTaskId : null,
          }))
        } catch (error) {
          console.error('笔记同步失败', error)
          toast.error('笔记同步失败，已保留本机记录，请稍后重试')
        }
      },
      loadTask: async id => {
        const before = get().tasks.find(t => t.id === id)
        try {
          const detail = await getNote(id)
          set(state => ({ tasks: state.tasks.map(t => t.id === id && t.formData?.request_id === before?.formData?.request_id && t.attemptStartedAt === before?.attemptStartedAt ? mergeTaskSnapshot(t, detail) : t) }))
        } catch (error) {
          console.error('加载笔记失败', error)
        }
      },
      archiveTask: async id => {
        const task = get().tasks.find(t => t.id === id)
        if (!task || !['SUCCESS', 'FAILED'].includes(task.status)) return
        const updated = await archiveNote(id)
        set(state => ({
          tasks: state.tasks.map(t => t.id === id ? mergeTaskSnapshot(t, updated) : t),
        }))
      },
      restoreTask: async id => {
        const updated = await restoreNote(id)
        set(state => ({ tasks: state.tasks.map(t => t.id === id ? mergeTaskSnapshot(t, updated) : t) }))
      },
      removeTask: async id => {
        await deleteNote(id)
        set(state => ({ tasks: state.tasks.filter(t => t.id !== id),
          currentTaskId: state.currentTaskId === id ? null : state.currentTaskId }))
        useChatStore.getState().clearChat(id)
        useReadingAssistantStore.getState().remove(permanentSessionKey(id))
        useReadingAssistantStore.getState().remove(temporarySessionKey(id))
      },

      clearTasks: () => set({ tasks: [], currentTaskId: null }),

      setCurrentTask: taskId => set({ currentTaskId: taskId }),
    }),
    {
      name: 'task-storage',
      storage: taskStorage,
    }
  )
)
