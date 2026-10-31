import type { AxiosResponse } from 'axios'
import request from '@/utils/request'
import type { Task } from '@/store/taskStore'

export interface NoteDiagnostics {
  task_id: string
  trace_id: string | null
  historical: boolean
  stages: { name: string; status: string; started_at?: string | null; finished_at?: string | null; duration_ms?: number | null }[]
  error: { category?: string; type?: string; message?: string; errno?: number | null; winerror?: number | null; http_status?: number | null; request_id?: string | null; frames?: unknown[] } | null
  outcomes: { model_completed: boolean | null; content_saved: boolean | null; index_saved: boolean | null }
  save_recovery: { available: boolean; reason: string }
  events: unknown[]
}
const options = { suppressToast: true, timeout: 15000 }
export const getNoteDiagnostics = (id: string, signal?: AbortSignal) => request.get(`/notes/${encodeURIComponent(id)}/diagnostics`, { ...options, signal }) as unknown as Promise<NoteDiagnostics>
export const retryNoteSave = (id: string, signal?: AbortSignal) => request.post(`/notes/${encodeURIComponent(id)}/retry-save`, undefined, { ...options, timeout: 30000, signal }) as unknown as Promise<{ task: Task; diagnostics: NoteDiagnostics }>
export async function exportNoteDiagnostics(id: string, signal?: AbortSignal) {
  const response = await request.get(`/notes/${encodeURIComponent(id)}/diagnostics/export`, { ...options, responseType: 'blob', signal }) as unknown as AxiosResponse<Blob>
  if (!(response.data instanceof Blob)) throw new Error('未收到诊断包，请刷新诊断后重试')
  const disposition = String(response.headers['content-disposition'] || '')
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  let filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `diagnostics-${id}.zip`
  if (encoded) { try { filename = decodeURIComponent(encoded) } catch { /* Fall back to the safe filename. */ } }
  return { blob: response.data, filename: Array.from(filename.replace(/[\\/:*?"<>|]/g, '_')).map(character => character.charCodeAt(0) < 32 ? '_' : character).join('') }
}
