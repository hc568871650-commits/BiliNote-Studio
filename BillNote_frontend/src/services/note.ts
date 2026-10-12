import request from '@/utils/request'
import toast from 'react-hot-toast'
import type { Task } from '@/store/taskStore'
import type { AxiosRequestConfig } from 'axios'
import type { GenerationOptions } from './generationRuns'

export type NoteRequestOptions = Pick<AxiosRequestConfig, 'signal' | 'timeout' | 'suppressToast'>
export interface GenerateNoteResponse { task_id: string }
export interface TaskStatusResponse {
  task_id: string
  request_id?: string
  status: string
  message?: string
  last_active_status?: string
  started_at?: string | null
  finished_at?: string | null
  status_updated_at?: string | null
  audio_meta?: { title?: string }
  result?: { markdown?: Task['markdown']; transcript?: Task['transcript']; audio_meta?: Task['audioMeta']; resource_base?: string }
}

export const listNotes = () => request.get('/notes') as unknown as Promise<Task[]>
export const getNote = (id: string, options: NoteRequestOptions = {}) => request.get(`/notes/${encodeURIComponent(id)}`, options) as unknown as Promise<Task>
export const importNotes = (tasks: Task[]) => request.post('/notes/import', { tasks }) as unknown as Promise<Task[]>
export const archiveNote = (id: string) => request.post(`/notes/${encodeURIComponent(id)}/archive`) as unknown as Promise<Task>
export const restoreNote = (id: string) => request.post(`/notes/${encodeURIComponent(id)}/restore`) as unknown as Promise<Task>
export const deleteNote = (id: string) => request.delete(`/notes/${encodeURIComponent(id)}`)

export interface GenerateNotePayload {
  video_url: string
  platform: string
  quality: string
  model_name: string
  provider_id: string
  task_id?: string
  format: Array<string>
  style: string
  extras?: string
  video_understand?: boolean
  video_interval?: number
  frame_mode?: 'dynamic' | 'fixed'
  grid_size: Array<number>
  link?: boolean
  screenshot?: boolean
  video_understanding?: boolean
  request_id?: string
  generation_options?: GenerationOptions
}

// An interrupted response can still represent an accepted job. Never automatically retry.
export const generateNote = (data: GenerateNotePayload, options: NoteRequestOptions = {}) =>
  request.post('/generate_note', data, options) as unknown as Promise<GenerateNoteResponse>

export const delete_task = async ({ video_id, platform }: { video_id: string; platform: string }) => {
  try {
    const data = {
      video_id,
      platform,
    }
    const res = await request.post('/delete_task', data)


      toast.success('任务已成功删除')
      return res
  } catch (e) {
    toast.error('请求异常，删除任务失败')
    console.error('❌ 删除任务失败:', e)
    throw e
  }
}

export const get_task_status = (task_id: string, options: NoteRequestOptions = {}) =>
  request.get('/task_status/' + encodeURIComponent(task_id), { suppressToast: true, ...options }) as unknown as Promise<TaskStatusResponse>
