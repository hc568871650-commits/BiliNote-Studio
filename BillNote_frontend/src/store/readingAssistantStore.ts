import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { get, set, del } from 'idb-keyval'
import type { ChatSource, ToolEvent } from '@/services/chat'
import type { PurposeModelSelection } from '@/store/purposeModelStore'
import { automaticSearchSettings, type AISettings, type ContextUsage } from '@/utils/aiSettings'
import { validateReadingAttachments } from '@/utils/readingAttachments'
import { interruptPendingReadingTurns } from '@/utils/readingRecovery'

export interface ReadingAttachment {
  id: string
  type: 'quote' | 'text' | 'image'
  name: string
  text?: string
  data_url?: string
  taskId?: string
  versionId?: string
  blockId?: string
  sourceText?: string
  blockCount?: number
  blocks?: { blockId?: string; start: number; end: number }[]
  imageSource?: { path: string; title: string; timestamp?: string }
}
export interface ReadingMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: ReadingAttachment[]
  sources?: ChatSource[]
  tool_events?: ToolEvent[]
  work_log?: string[]
  incomplete?: boolean
  delivery_status?: 'pending' | 'complete' | 'failed' | 'cancelled' | 'interrupted'
  reply_to?: string
  elapsed_seconds?: number
  request?: { protocol: string; stream: boolean; web_search: boolean; web_search_mode: 'native' | 'external'; web_search_used?: boolean; trace_id?: string; request_id?: string | null; provider_id?: string; model_name?: string; context_limit?: number; output_reserve?: number }
}
export interface ReadingSession {
  messages: ReadingMessage[]
  input: string
  attachments: ReadingAttachment[]
  model?: PurposeModelSelection | null
  controls?: AISettings
  context?: ContextUsage
  memory?: { summary: string; through_id: string; compacted_messages: number }
}
const emptySession = (): ReadingSession => ({ messages: [], input: '', attachments: [] })
interface State {
  sessions: Record<string, ReadingSession>
  patch: (key: string, value: Partial<ReadingSession>) => void
  append: (key: string, message: ReadingMessage) => void
  attach: (key: string, attachments: ReadingAttachment[]) => void
  clear: (key: string) => void
  remove: (key: string) => void
  transfer: (from: string, to: string) => void
}
export const useReadingAssistantStore = create<State>()(persist((set, get) => ({
  sessions: {},
  patch: (key, value) => set(state => ({ sessions: { ...state.sessions, [key]: { ...(state.sessions[key] || emptySession()), ...value } } })),
  append: (key, message) => { const s = get().sessions[key] || emptySession(); get().patch(key, { messages: [...s.messages, message] }) },
  attach: (key, attachments) => {
    const s = get().sessions[key] || emptySession()
    const combined = [...s.attachments, ...attachments]
    validateReadingAttachments(combined)
    get().patch(key, { attachments: combined })
  },
  clear: key => get().patch(key, { messages: [], input: '', attachments: [], context: undefined, memory: undefined }),
  remove: key => set(state => { const sessions = { ...state.sessions }; delete sessions[key]; return { sessions } }),
  transfer: (from, to) => {
    if (from === to) return
    const source = get().sessions[from]
    if (!source) return
    const target = get().sessions[to] || emptySession()
    if (target.attachments.length + source.attachments.length > 8) throw new Error('常驻对话草稿附件已满，请先发送或移除部分附件')
    validateReadingAttachments([...target.attachments, ...source.attachments])
    // One notification: subscribers never see a copied chat with the temporary
    // source still present. Preserve an existing permanent model/preferences.
    set(state => {
      const sessions = { ...state.sessions, [to]: { ...source, ...target,
        model: target.model === undefined ? source.model : target.model,
        controls: target.controls || source.controls,
        context: undefined,
        memory: undefined,
        messages: [...target.messages, ...source.messages], attachments: [...target.attachments, ...source.attachments],
        input: [target.input, source.input].filter(Boolean).join('\n') } }
      delete sessions[from]
      return { sessions }
    })
  },
}), {
  name: 'bilinote-reading-assistant-v1',
  merge: (persisted, current) => {
    const sessions = (persisted as Partial<State>)?.sessions || {}
    return { ...current, sessions: Object.fromEntries(Object.entries(sessions).map(([key, session]) => [key, { ...interruptPendingReadingTurns(session), controls: automaticSearchSettings(session.controls) }])) }
  },
  partialize: state => ({ sessions: Object.fromEntries(Object.entries(state.sessions).filter(([key]) => key.startsWith('note:'))) }),
  storage: createJSONStorage(() => ({ getItem: async key => await get(key) ?? null, setItem: async (key, value) => { await set(key, value) }, removeItem: async key => { await del(key) } })),
}))
export const permanentSessionKey = (taskId: string) => `note:${taskId}`
export const temporarySessionKey = (taskId: string) => `temporary:${taskId}`
