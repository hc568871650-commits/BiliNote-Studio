import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { get, set, del } from 'idb-keyval'
import type { ChatSource } from '@/services/chat'
import type { PurposeModelSelection } from '@/store/purposeModelStore'
import type { AISettings, ContextUsage } from '@/utils/aiSettings'

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
}
export interface ReadingMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: ReadingAttachment[]
  sources?: ChatSource[]
  incomplete?: boolean
  elapsed_seconds?: number
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
  attach: (key, attachments) => { const s = get().sessions[key] || emptySession(); if (s.attachments.length + attachments.length > 8) throw new Error('每条消息最多 8 个附件'); get().patch(key, { attachments: [...s.attachments, ...attachments] }) },
  clear: key => get().patch(key, { messages: [], input: '', attachments: [], context: undefined, memory: undefined }),
  remove: key => set(state => { const sessions = { ...state.sessions }; delete sessions[key]; return { sessions } }),
  transfer: (from, to) => {
    if (from === to) return
    const source = get().sessions[from]
    if (!source) return
    const target = get().sessions[to] || emptySession()
    if (target.attachments.length + source.attachments.length > 8) throw new Error('常驻对话草稿附件已满，请先发送或移除部分附件')
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
  partialize: state => ({ sessions: Object.fromEntries(Object.entries(state.sessions).filter(([key]) => key.startsWith('note:'))) }),
  storage: createJSONStorage(() => ({ getItem: async key => await get(key) ?? null, setItem: async (key, value) => { await set(key, value) }, removeItem: async key => { await del(key) } })),
}))
export const permanentSessionKey = (taskId: string) => `note:${taskId}`
export const temporarySessionKey = (taskId: string) => `temporary:${taskId}`
