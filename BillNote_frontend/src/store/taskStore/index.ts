import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { archiveNote, deleteNote, generateNote, getNote, importNotes, listNotes, restoreNote } from '@/services/note.ts'
import { useChatStore } from '@/store/chatStore'
import { useReadingAssistantStore, permanentSessionKey, temporarySessionKey } from '@/store/readingAssistantStore'
import { v4 as uuidv4 } from 'uuid'
import toast from 'react-hot-toast'
import { get, set, del } from 'idb-keyval'


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
  created_at: string
  resource_base?: string
}

export interface Task {
  id: string
  markdown: string|Markdown [] //为了兼容之前的笔记
  transcript: Transcript
  status: TaskStatus
  audioMeta: AudioMeta
  createdAt: string
  archived_at?: string | null
  resource_base?: string
  formData: {
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
}

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
                title: '',
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

              if (task.status === 'SUCCESS' && data.status === 'SUCCESS') return task

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
          return
        }
        const task = get().tasks.find(task => task.id === id)
        console.log('retry',task)
        if (!task) return
        if (task.archived_at) {
          toast.error('请先恢复归档笔记再重新生成')
          return
        }

        const newFormData = payload || task.formData
        try {
          await generateNote({
            ...newFormData,
            task_id: id,
          })
        } catch (e: any) {
          // 就绪门禁：转写模型未下载好。不要把任务标成 PENDING（会一直转），
          // 给提示让用户先去下载。
          if (e?.data?.reason === 'transcriber_model_not_ready') {
            toast.error(
              e?.data?.downloading
                ? '转写模型正在下载中，请稍候再重试'
                : '转写模型尚未下载，请先去「设置 → 音频转写配置」页下载',
            )
            return
          }
          console.error('重试任务失败：', e)
          return
        }

        set(state => ({
          tasks: state.tasks.map(t =>
              t.id === id
                  ? {
                    ...t,
                    formData: newFormData, // ✅ 显式更新 formData
                    status: 'PENDING',
                  }
                  : t
          ),
        }))
      },


      syncNotes: async () => {
        // Keep the old IndexedDB snapshot until the server confirms its import.
        const localTasks = get().tasks
        try {
          if (localTasks.length) await importNotes(localTasks)
          const remote = await listNotes()
          set(state => ({
            tasks: remote,
            currentTaskId: state.currentTaskId && remote.some(t => t.id === state.currentTaskId)
              ? state.currentTaskId : null,
          }))
        } catch (error) {
          console.error('笔记同步失败', error)
          toast.error('笔记同步失败，已保留本机记录，请稍后重试')
        }
      },
      loadTask: async id => {
        try {
          const detail = await getNote(id)
          set(state => ({ tasks: state.tasks.map(t => t.id === id ? detail : t) }))
        } catch (error) {
          console.error('加载笔记失败', error)
        }
      },
      archiveTask: async id => {
        const task = get().tasks.find(t => t.id === id)
        if (!task || !['SUCCESS', 'FAILED'].includes(task.status)) return
        const updated = await archiveNote(id)
        set(state => ({
          tasks: state.tasks.map(t => t.id === id ? updated : t),
        }))
      },
      restoreTask: async id => {
        const updated = await restoreNote(id)
        set(state => ({ tasks: state.tasks.map(t => t.id === id ? updated : t) }))
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
      storage: createJSONStorage(() => ({
        getItem: async (name: string): Promise<string | null> => {
          const value = await get(name)
          return value ?? null
        },
        setItem: async (name: string, value: string): Promise<void> => {
          await set(name, value)
        },
        removeItem: async (name: string): Promise<void> => {
          await del(name)
        },
      })),
    }
  )
)
