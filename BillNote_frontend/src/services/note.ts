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
  cancelled?: boolean
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
export const cancelGeneration = (id: string, requestId?: string) =>
  request.post(`/notes/${encodeURIComponent(id)}/cancel`, { request_id: requestId }) as unknown as Promise<{ cancel_requested?: boolean }>

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

export interface UpgradeStructuredPayload {
  provider_id?: string
  model_name?: string
  protocol?: string
  style?: 'knowledge' | 'tutorial'
  extras?: string
}

export const upgradeNoteStructured = (taskId: string, payload: UpgradeStructuredPayload = {}) =>
  request.post(`/notes/${encodeURIComponent(taskId)}/upgrade-structured`, payload, { timeout: 180000 }) as unknown as Promise<Task>

export interface QuizAttemptRecord {
  picked_key: string
  correct_key?: string
  is_correct: boolean
  question?: string
  section_title?: string
  explanation?: string
  updated_at?: number
}

export interface NoteLearningState {
  task_id: string
  quiz_attempts: Record<string, QuizAttemptRecord>
  pinned_annotations: Record<string, { pinned: boolean; note?: string; updated_at?: number }>
  checklist_states: Record<string, boolean>
  updated_at?: number
}

export const getNoteLearningState = (taskId: string) =>
  request.get(`/notes/${encodeURIComponent(taskId)}/learning-state`, { suppressToast: true }) as unknown as Promise<NoteLearningState>

export const updateNoteLearningState = (
  taskId: string,
  payload: Partial<Pick<NoteLearningState, 'quiz_attempts' | 'pinned_annotations' | 'checklist_states'>>,
) =>
  request.put(`/notes/${encodeURIComponent(taskId)}/learning-state`, payload, { suppressToast: true }) as unknown as Promise<NoteLearningState>

export interface ReviewBankItem {
  kind: 'wrong_quiz' | 'pit_annotation'
  task_id: string
  note_title: string
  section_id: string
  section_title: string
  question?: string
  picked_key?: string
  correct_key?: string
  explanation?: string
  hint?: string
  detail?: string
  timestamp?: number | null
  timestamp_label?: string
  updated_at?: number
}

export interface ReviewBankResponse {
  total: number
  wrong_quiz_count: number
  pit_count: number
  items: ReviewBankItem[]
}

export const fetchReviewBank = (params: { kind?: 'all' | 'wrong_quiz' | 'pit'; limit?: number } = {}) =>
  request.get('/learning/review-bank', { params, suppressToast: true }) as unknown as Promise<ReviewBankResponse>

export const noteMediaStreamUrl = (baseURL: string, taskId: string) => {
  const apiBase = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
  if (/^https?:\/\//i.test(apiBase)) {
    return `${apiBase}/notes/${encodeURIComponent(taskId)}/media`
  }
  const origin = (baseURL || '').replace(/\/$/, '')
  return `${origin}${apiBase}/notes/${encodeURIComponent(taskId)}/media`
}
