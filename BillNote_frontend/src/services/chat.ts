import request from '@/utils/request'
import { withProviderProtocol } from './providerProtocol'
import type { AISettings, ContextUsage } from '@/utils/aiSettings'
export type ChatProtocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini'
export const chatProtocolLabels: Record<ChatProtocol, string> = { 'openai-chat': 'Chat Completions', 'openai-responses': 'Responses', anthropic: 'Anthropic', gemini: 'Gemini 原生' }
export interface ChatErrorDetails {
  http_status: number | null
  upstream_code: string | null
  request_id: string | null
  occurred_at: string
  kind: string
  detail: string
  protocol: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  attachments?: Array<{ type: string; name: string; text?: string; data_url?: string }>
}

export interface ChatSource {
  evidence_type?: 'snippet' | 'page'
  retrieved_at?: string
  truncated?: boolean
  read_complete?: boolean
  read_characters?: number
  total_length?: number
  search_provider?: 'google'
  search_suggestions_html?: string
  text: string
  source_type: 'markdown' | 'transcript' | 'note' | 'web'
  source_id?: string
  note_id?: string
  version_id?: string
  section_id?: string
  title?: string
  url?: string
  archived?: boolean
  section_title?: string
  start_time?: number
  end_time?: number
}

export interface ToolEvent {
  id: string
  tool: string
  status: 'succeeded' | 'failed' | 'cached' | 'blocked' | 'unconfirmed'
  service?: string
  query?: string
  url?: string
  offset?: number
  next_offset?: number | null
  characters?: number
  source_count?: number
  elapsed_ms?: number
  occurred_at?: string
  retrieved_at?: string
  truncated?: boolean
  budget_exhausted?: boolean
  error?: string
}

export interface AskResponse {
  work_log?: string[]
  tool_events?: ToolEvent[]
  answer: string
  sources: ChatSource[]
  context?: ContextUsage
  compaction?: CompactionResult
}
export interface CompactionResult {
  summary: string
  consumed_messages: number
  compacted: boolean
  before_tokens: number
  after_tokens: number
  context: ContextUsage
}
export const compactChat = async (data: { task_id: string; provider_id: string; model_name: string; protocol?: ChatProtocol; history: ChatMessage[]; summary: string; keep_recent: 0 | 4; context_limit?: number }, signal?: AbortSignal): Promise<CompactionResult> =>
  request.post('/chat/compact', await withProviderProtocol(data), { timeout: 120000, signal, suppressToast: true })

export type IndexStatus = 'idle' | 'indexing' | 'indexed' | 'failed'

export interface ChatStatusResponse {
  indexed: boolean
  status: IndexStatus
}

export const indexTask = async (taskId: string): Promise<void> => {
  return await request.post('/chat/index', { task_id: taskId })
}

export type AskPayload = {
  protocol?: ChatProtocol
  task_id: string
  question: string
  history: ChatMessage[]
  summary?: string
  provider_id: string
  model_name: string
  attachments?: Array<{ type: string; name: string; text?: string; data_url?: string }>
  context_mode?: 'note' | 'selection'
} & Partial<AISettings>
export const askQuestion = async (data: AskPayload, signal?: AbortSignal): Promise<AskResponse> => {
  return await request.post('/chat/ask', await withProviderProtocol(data), { timeout: 120000, signal, suppressToast: true })
}

export const getChatStatus = async (taskId: string): Promise<ChatStatusResponse> => {
  return await request.get(`/chat/status?task_id=${taskId}`)
}
