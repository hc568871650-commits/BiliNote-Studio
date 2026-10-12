import request from '@/utils/request'
import type { AISettings, ContextUsage } from '@/utils/aiSettings'
export type ChatProtocol = 'openai-chat' | 'openai-responses' | 'anthropic'
export const chatProtocolLabels: Record<ChatProtocol, string> = { 'openai-chat': 'Chat Completions', 'openai-responses': 'Responses', anthropic: 'Anthropic' }
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

export interface AskResponse {
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
export const compactChat = (data: { task_id: string; provider_id: string; model_name: string; protocol?: ChatProtocol; history: ChatMessage[]; summary: string; keep_recent: 0 | 4 }, signal?: AbortSignal): Promise<CompactionResult> =>
  request.post('/chat/compact', data, { timeout: 120000, signal, suppressToast: true })

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
  return await request.post('/chat/ask', data, { timeout: 120000, signal, suppressToast: true })
}

export const getChatStatus = async (taskId: string): Promise<ChatStatusResponse> => {
  return await request.get(`/chat/status?task_id=${taskId}`)
}
