import request from '@/utils/request'
import type { Task } from '@/store/taskStore'
import type { ProviderProtocol } from '@/store/providerProtocolStore'

export interface RefinementSelection { version_id: string; texts: string[] }
export interface RefinementContext {
  before: string; start_time: number | null; end_time: number | null
  video_available: boolean; transcript_count: number
}
export interface RefinementPreview {
  draft_id: string; before: string; after: string; start_time: number; end_time: number
  evidence: { transcript: { start: number; end: number; text: string }[]; frames: { time: number; reason: string; image_url: string }[] }
}
export interface RefinementRequest extends RefinementSelection {
  start_time: number; end_time: number; instruction: string
  provider_id: string; model_name: string; protocol: ProviderProtocol; use_video: boolean
}
const options = { timeout: 180000, suppressToast: true }
const path = (id: string) => `/notes/${encodeURIComponent(id)}/refine`
export const getRefinementContext = (id: string, selection: RefinementSelection) => request.post(`${path(id)}/context`, selection, options) as unknown as Promise<RefinementContext>
export const previewRefinement = (id: string, payload: RefinementRequest) => request.post(`${path(id)}/preview`, payload, options) as unknown as Promise<RefinementPreview>
export const applyRefinement = (id: string, draft_id: string) => request.post(`${path(id)}/apply`, { draft_id }, options) as unknown as Promise<Task>
