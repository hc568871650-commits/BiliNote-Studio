import request from '@/utils/request'

export type OrganizerScope = { kind: 'all' | 'folder' | 'selected'; folder_id?: string; task_ids?: string[] }
export type OrganizerOperation = {
  type: 'create_folder' | 'rename_folder' | 'move_notes' | 'set_tags' | 'archive' | 'restore'
  ref?: string
  name?: string
  folder_id?: string
  task_ids?: string[]
  tags?: string[]
}
export interface OrganizerPlan {
  plan_id: string
  status: 'planned' | 'answered'
  explanation: string
  operations: OrganizerOperation[]
  scope_count: number
  metadata_only: boolean
  notes?: { id: string; title: string }[]
  folders?: { id: string; name: string }[]
  query_note_ids?: string[]
  context?: OrganizerContext | null
}
export interface OrganizerResult {
  plan_id: string
  status: 'executed' | 'undone'
  operations?: OrganizerOperation[]
  explanation?: string
  undo_available: boolean
}
export interface OrganizerPlanRequest {
  instruction: string
  scope: OrganizerScope
  provider_id: string
  model_name: string
  reasoning_effort?: 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh'
  context_limit?: 272000
}
export interface OrganizerContext { input_tokens: number; estimated: boolean; limit: number; warning?: boolean; compacted?: boolean; compacted_messages?: number }
// Model calls can take longer than the ordinary metadata endpoints.
const options = { timeout: 120000, suppressToast: true }
export const planOrganization = (body: OrganizerPlanRequest) => request.post('/organizer/plan', body, options) as unknown as Promise<OrganizerPlan>
export const executeOrganization = (planId: string) => request.post('/organizer/execute', { plan_id: planId }, options) as unknown as Promise<OrganizerResult>
export const undoOrganization = (planId: string) => request.post('/organizer/undo', { plan_id: planId }, options) as unknown as Promise<OrganizerResult>

export interface OrganizerSession {
  memory?: { summary: string; through_id: string | null; compacted_messages: number }
  context?: OrganizerContext | null
  session_id: string
  revision: number
  status: 'idle' | 'planning' | 'executing' | 'undoing' | 'clarification' | 'refused' | 'awaiting_approval' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
  scope: OrganizerScope & { authorized: boolean; exclude_favorites: boolean; target_count: number; folder_name?: string }
  query_scope?: OrganizerScope
  history: { id: string; role: 'user' | 'assistant' | 'system'; content: string; created_at: number; phase?: 'pending' | 'superseded' | 'cancelled' | 'executed' | 'undone' }[]
  plan: OrganizerPlan | null
  result: OrganizerResult | null
  error: string | null
  events: { sequence: number; type: string; message: string; created_at: number }[]
  target_summary?: { count: number; note_ids: string[]; folder_name?: string; exclude_favorites: boolean; authorized: boolean }
  pending_plan_id?: string | null
  updated_at: number
}
export interface OrganizerRetention { limit: number; min_limit: number; max_limit: number; count: number; over_limit: boolean }
export interface OrganizerRetentionPreview {
  operation: 'create' | 'set_limit'; limit: number; current_limit: number; count: number; required_count: number
  evictions: { session_id: string; title: string; status: string; updated_at: number; created_at: number; message_count: number; revision: number; has_pending_plan: boolean; loses_undo: boolean }[]
  protected_count: number; blocked: boolean; confirmation_token: string | null; warning: string
}
export const retentionFailure = (error: unknown): OrganizerRetentionPreview | null => {
  const value = error as { code?: number; data?: OrganizerRetentionPreview & { kind?: string } }
  return value?.code === 409 && ['retention_required', 'retention_stale', 'retention_blocked'].includes(value.data?.kind || '') ? value.data! : null
}
export const getOrganizerRetention = () => request.get('/organizer/retention', options) as unknown as Promise<OrganizerRetention>
export const previewOrganizerRetention = (operation: 'create' | 'set_limit', limit?: number) => request.post('/organizer/retention/preview', { operation, ...(limit !== undefined ? { limit } : {}) }, options) as unknown as Promise<OrganizerRetentionPreview>
export const setOrganizerRetention = (limit: number, confirmation_token?: string, request_id: string = crypto.randomUUID()) => request.patch('/organizer/retention', { limit, confirmation_token, request_id }, options) as unknown as Promise<OrganizerRetention>
export const listOrganizerSessions = () => request.get('/organizer/sessions', options) as unknown as Promise<{ sessions: OrganizerSession[]; retention: OrganizerRetention; runtime_id?: string }>
export const createOrganizerSession = (scope: OrganizerScope, confirmation_token?: string, request_id: string = crypto.randomUUID()) => request.post('/organizer/sessions', { scope, confirmation_token, request_id }, options) as unknown as Promise<OrganizerSession>
export const getOrganizerSession = (id: string) => request.get(`/organizer/sessions/${encodeURIComponent(id)}`, options) as unknown as Promise<OrganizerSession>
export const messageOrganizerSession = (id: string, body: OrganizerPlanRequest & { expected_revision: number; request_id: string }) => request.post(`/organizer/sessions/${encodeURIComponent(id)}/message`, body, options) as unknown as Promise<OrganizerSession>
export const compactOrganizerSession = (id: string, body: { expected_revision: number; request_id: string; provider_id: string; model_name: string }) => request.post(`/organizer/sessions/${encodeURIComponent(id)}/compact`, body, options) as unknown as Promise<OrganizerSession>
export const actOrganizerSession = (id: string, action: 'approve' | 'cancel' | 'undo' | 'recover' | 'cancel-compaction', body: { expected_revision: number; request_id: string; plan_id?: string }) => request.post(`/organizer/sessions/${encodeURIComponent(id)}/${action}`, body, options) as unknown as Promise<OrganizerSession>
