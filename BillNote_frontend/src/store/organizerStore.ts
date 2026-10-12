import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { defaultAISettings, type AISettings } from '@/utils/aiSettings'
import { actOrganizerSession, compactOrganizerSession, createOrganizerSession, getOrganizerSession, listOrganizerSessions, messageOrganizerSession, previewOrganizerRetention, retentionFailure, type OrganizerRetentionPreview, type OrganizerPlan, type OrganizerPlanRequest, type OrganizerResult, type OrganizerScope, type OrganizerSession } from '@/services/organizer'
import type { PurposeModelSelection } from '@/store/purposeModelStore'
import type { ChatErrorDetails, ChatSource } from '@/services/chat'

export interface OrganizerMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  scopeLabel?: string
  plan?: OrganizerPlan
  result?: OrganizerResult
  phase?: 'pending' | 'executed' | 'undone' | 'cancelled' | 'superseded'
  sources?: ChatSource[]
}
interface OrganizerStore {
  messages: OrganizerMessage[]
  session: OrganizerSession | null
  sessions: OrganizerSession[]
  initialized: boolean
  draft: string
  scope: OrganizerScope['kind']
  folderId: string
  selectedIds: string[]
  model: PurposeModelSelection | null
  modelOverridden: boolean
  controls: AISettings
  setControls: (controls: AISettings) => void
  busy: 'planning' | 'executing' | 'undoing' | 'loading' | 'cancelling' | 'compacting' | null
  compactNotice: string | null
  error: string | null
  errorDetails: ChatErrorDetails | null
  retentionPreview: OrganizerRetentionPreview | null
  confirmCreation: () => Promise<void>
  cancelCreation: () => void
  setDraft: (draft: string) => void
  setScope: (scope: OrganizerScope['kind']) => void
  setFolderId: (folderId: string) => void
  toggleNote: (id: string) => void
  setSelectedIds: (ids: string[]) => void
  setModel: (model: PurposeModelSelection | null) => void
  initialize: () => Promise<void>
  restore: (id: string) => Promise<void>
  refresh: () => Promise<void>
  recover: () => Promise<void>
  send: (request: OrganizerPlanRequest, scopeLabel: string) => Promise<void>
  execute: (messageId: string) => Promise<boolean>
  undo: (messageId: string) => Promise<boolean>
  cancel: (messageId?: string) => Promise<void>
  clear: () => Promise<void>
}
const storageKey = 'bilinote-organizer-active-session-v1' + (typeof location !== 'undefined' && new URLSearchParams(location.search).get('engine') === 'graph' ? '-graph' : '')
const remember = (id: string) => { try { localStorage.setItem(storageKey, id) } catch { /* Storage is optional. */ } }
const remembered = () => { try { return localStorage.getItem(storageKey) } catch { return null } }
const errorText = (error: unknown) => { const detail = error as { msg?: string; message?: string }; return detail?.msg || detail?.message || '请求未完成，请检查连接后重试。' }
const errorDetails = (error: unknown): ChatErrorDetails | null => (error as { data?: { error_details?: ChatErrorDetails } })?.data?.error_details || null
const missingSession = (error: unknown) => (error as { code?: number })?.code === 404
const supported = ['create_folder', 'rename_folder', 'move_notes', 'set_tags', 'archive', 'restore']
const snapshotMessages = (session: OrganizerSession): OrganizerMessage[] => {
  if (!session.session_id || !Number.isInteger(session.revision) || !Array.isArray(session.history)) throw new Error('会话返回格式无效，请重新读取。')
  if (session.plan && (!Array.isArray(session.plan.operations) || session.plan.operations.some(operation => !supported.includes(operation.type)) || (session.plan.operations.length && (!session.plan.plan_id || session.plan.metadata_only !== true)))) throw new Error('计划缺少安全确认信息，未执行任何操作。')
  const messages: OrganizerMessage[] = session.history.filter(item => item.role !== 'system').map(item => ({ id: item.id, role: item.role as 'user' | 'assistant', text: item.content, sources: item.sources?.map(source => ({ ...source })), phase: item.phase === 'pending' ? undefined : item.phase }))
  let lastAssistant = -1
  messages.forEach((item, index) => { if (item.role === 'assistant') lastAssistant = index })
  if (session.status === 'awaiting_approval') {
    // Keep the approval card attached to its proposal when a confirmation hint
    // adds another assistant reply without replacing the bound plan.
    const proposalIds = new Set(session.history.filter(item => item.role === 'assistant' && (item.phase as string) === 'awaiting_approval').map(item => item.id))
    messages.forEach((item, index) => { if (proposalIds.has(item.id)) lastAssistant = index })
  }
  if (session.plan && lastAssistant >= 0) messages[lastAssistant] = { ...messages[lastAssistant], plan: session.plan, result: session.result || undefined, phase: session.status === 'awaiting_approval' ? 'pending' : session.result?.status === 'undone' ? 'undone' : session.result?.status === 'executed' ? 'executed' : session.status === 'cancelled' ? 'cancelled' : undefined }
  return messages
}
let epoch = 0
export const useOrganizerStore = create<OrganizerStore>()(persist((set, get) => {
  let trustedSnapshot = true
  let runtimeId: string | null = null
  const acceptRuntime = (next?: string) => {
    if (!next) return // Compatibility with old servers and UI-only fixtures.
    let previous = runtimeId
    try { previous ||= localStorage.getItem(storageKey + '-runtime') } catch { /* optional */ }
    runtimeId = next
    if (previous !== next) {
      ++epoch
      pendingCreation = null
      try { localStorage.removeItem(storageKey) } catch { /* optional */ }
      set({ session: null, messages: [], error: null, errorDetails: null, retentionPreview: null, scope: 'all', folderId: 'default', selectedIds: [] })
    }
    try { localStorage.setItem(storageKey + '-runtime', next) } catch { /* optional */ }
  }
  let pendingCreation: { scope: OrganizerScope; request?: OrganizerPlanRequest; requestId: string } | null = null
  const forgetMissing = () => { const id = get().session?.session_id || remembered(); try { localStorage.removeItem(storageKey) } catch { /* optional */ }; set(state => ({ session: null, messages: [], sessions: state.sessions.filter(item => item.session_id !== id), error: '当前整理对话已被清理。请选择历史对话，或直接输入需求继续。' })) }
  const handleRetention = (preview: OrganizerRetentionPreview) => {
    if (preview.blocked) { pendingCreation = null; set({ retentionPreview: null, error: '运行中或已中断的整理会话受到保护，目前无法腾出位置。请先完成或恢复这些会话，再新建对话。' }); return }
    set({ retentionPreview: preview, error: '会话列表可能已变化，请审阅当前清理名单后确认。' })
  }
  const createNew = async (confirmed = false) => {
    const pending = pendingCreation; if (!pending || get().busy) return
    const token = ++epoch; set({ busy: 'loading', error: null })
    let id: string | undefined
    try {
      if (!confirmed) {
        const preview = await previewOrganizerRetention('create')
        if (preview.blocked) { handleRetention(preview); return }
        if (preview.evictions.length) { set({ retentionPreview: preview }); return }
      }
      const session = await createOrganizerSession(pending.scope, confirmed ? get().retentionPreview?.confirmation_token || undefined : undefined, pending.requestId)
      if (token !== epoch) return
      id = session.session_id
      const data = await listOrganizerSessions(); set({ sessions: data.sessions, retentionPreview: null }); apply(session, token)
      pendingCreation = null
      if (pending.request) {
        set({ busy: 'planning', draft: get().draft.trim() === pending.request.instruction ? '' : get().draft })
        apply(await messageOrganizerSession(id, { ...pending.request, expected_revision: session.revision, request_id: crypto.randomUUID() }), token)
      } else set({ draft: '' })
    } catch (error) {
      const preview = retentionFailure(error)
      if (preview && token === epoch) handleRetention(preview)
      else if (id) await reloadAfterError(id, token, error)
      else if (token === epoch) set({ error: errorText(error) })
      if (pending.request && token === epoch && !get().draft) set({ draft: pending.request.instruction })
    } finally { if (token === epoch) set({ busy: null }) }
  }
  const apply = (session: OrganizerSession, token = epoch, restoreScope = false) => {
    if (token !== epoch) return
    const current = get().session
    if (current?.session_id === session.session_id && current.revision > session.revision) return
    if (current?.session_id === session.session_id && current.revision === session.revision) {
      const currentSequence = Math.max(0, ...current.events.map(event => event.sequence))
      const nextSequence = Math.max(0, ...session.events.map(event => event.sequence))
      if (session.updated_at < current.updated_at || nextSequence < currentSequence) return
      const active = ['planning', 'executing', 'undoing']
      if (active.includes(session.status) && !active.includes(current.status) && session.updated_at <= current.updated_at && nextSequence <= currentSequence) return
    }
    trustedSnapshot = false
    const messages = snapshotMessages(session)
    trustedSnapshot = true
    remember(session.session_id)
    set(state => ({ session, messages, error: session.error, errorDetails: session.error_details || null, ...(restoreScope ? { scope: 'all' as const, folderId: 'default', selectedIds: [] } : {}), sessions: [session, ...state.sessions.filter(item => item.session_id !== session.session_id)] }))
  }
  const reloadAfterError = async (id: string, token: number, error: unknown) => {
    try { apply(await getOrganizerSession(id), token) } catch (reloadError) { if (token === epoch && missingSession(reloadError)) { forgetMissing(); return } }
    if (token === epoch) set({ error: errorText(error), errorDetails: errorDetails(error) || get().session?.error_details || null })
  }
  const action = async (kind: 'approve' | 'undo', messageId: string) => {
    const state = get(), session = state.session, message = state.messages.find(item => item.id === messageId)
    if (!trustedSnapshot || state.busy || !session || !message?.plan || message.plan.plan_id !== session.plan?.plan_id || (kind === 'approve' ? session.status !== 'awaiting_approval' : !session.result?.undo_available)) return false
    const token = ++epoch
    set({ busy: kind === 'approve' ? 'executing' : 'undoing', error: null })
    try {
      const result = await actOrganizerSession(session.session_id, kind, { expected_revision: session.revision, plan_id: message.plan.plan_id, request_id: crypto.randomUUID() })
      apply(result, token)
      if (result.status !== 'completed' || result.result?.plan_id !== message.plan.plan_id || result.result.status !== (kind === 'approve' ? 'executed' : 'undone')) throw new Error(kind === 'approve' ? '后端未确认执行成功，请重新读取会话与笔记库核查。' : '后端未确认撤销成功，请重新读取会话与笔记库核查。')
      return token === epoch
    } catch (error) { await reloadAfterError(session.session_id, token, error); return false }
    finally { if (token === epoch) set({ busy: null }) }
  }
  return {
    messages: [], session: null, sessions: [], initialized: false, draft: '', scope: 'all', folderId: 'default', selectedIds: [], model: null, modelOverridden: false, controls: defaultAISettings, busy: null, error: null, errorDetails: null, retentionPreview: null, compactNotice: null,
    setControls: controls => set({ controls: { ...controls, context_limit: 272000 } }),
    confirmCreation: () => createNew(true),
    cancelCreation: () => { if (!get().busy) { pendingCreation = null; set({ retentionPreview: null, error: null }) } },
    setDraft: draft => set({ draft }), setScope: scope => set({ scope }), setFolderId: folderId => set({ folderId }),
    toggleNote: id => set(state => ({ selectedIds: state.selectedIds.includes(id) ? state.selectedIds.filter(value => value !== id) : [...state.selectedIds, id] })),
    setSelectedIds: selectedIds => set({ selectedIds }), setModel: model => set({ model, modelOverridden: true }),
    initialize: async () => {
      if (get().busy) return
      set({ busy: 'loading' })
      try {
        const data = await listOrganizerSessions(); acceptRuntime(data.runtime_id); set({ sessions: data.sessions })
        const id = remembered(); if (id && data.sessions.some(item => item.session_id === id)) apply(await getOrganizerSession(id), epoch, true)
        else if (id) forgetMissing()
      } catch (error) { if (missingSession(error)) forgetMissing(); else set({ error: errorText(error) }) }
      finally { set({ initialized: true, busy: null }) }
    },
    restore: async id => {
      if (get().busy) return
      const token = ++epoch; set({ busy: 'loading', error: null })
      try { apply(await getOrganizerSession(id), token, true); set({ draft: '' }) }
      catch (error) { if (token === epoch) { if (missingSession(error)) forgetMissing(); else set({ error: errorText(error) }) } }
      finally { if (token === epoch) set({ busy: null }) }
    },
    refresh: async () => { const id = get().session?.session_id; if (!id) return; const token = epoch; try { const session = await getOrganizerSession(id); if (get().session?.session_id === id) apply(session, token) } catch (error) { if (token === epoch && get().session?.session_id === id) { if (missingSession(error)) { forgetMissing(); try { set({ sessions: (await listOrganizerSessions()).sessions }) } catch { /* clear active even if list unavailable */ } } else set({ error: errorText(error) }) } } },
    recover: async () => {
      const session = get().session
      if (!session || get().busy || session.status !== 'interrupted') return
      const token = ++epoch; set({ busy: 'loading', error: null })
      try { apply(await actOrganizerSession(session.session_id, 'recover', { expected_revision: session.revision, request_id: crypto.randomUUID() }), token) }
      catch (error) { await reloadAfterError(session.session_id, token, error) }
      finally { if (token === epoch) set({ busy: null }) }
    },
    send: async request => {
      if (get().busy || get().retentionPreview || ['planning', 'executing', 'undoing'].includes(get().session?.status || '')) return
      if (['/compact', '压缩上下文'].includes(request.instruction.trim().toLowerCase())) {
        const session = get().session
        if (!session) { set({ compactNotice: '当前没有对话上下文，无需压缩', draft: '' }); return }
        const token = ++epoch
        set({ busy: 'compacting', error: null, compactNotice: null, draft: '' })
        try {
          const result = await compactOrganizerSession(session.session_id, { expected_revision: session.revision, request_id: crypto.randomUUID(), provider_id: request.provider_id, model_name: request.model_name, protocol: request.protocol || 'openai-chat' })
          apply(result, token)
          if (token === epoch) set({ compactNotice: (result.memory?.compacted_messages || 0) > (session.memory?.compacted_messages || 0) ? '上下文压缩完成，完整记录与待确认计划已保留' : '当前上下文无需压缩' })
        } catch (error) { await reloadAfterError(session.session_id, token, error); if (token === epoch) set({ draft: request.instruction }) }
        finally { if (token === epoch) set({ busy: null }) }
        return
      }
      set({ compactNotice: null })
      set({ busy: 'loading', error: null })
      try {
        const data = await listOrganizerSessions()
        acceptRuntime(data.runtime_id)
        set({ sessions: data.sessions })
      } catch (error) { set({ error: errorText(error) }); return }
      finally { set({ busy: null }) }
      if (!get().session) { pendingCreation = { scope: request.scope, request, requestId: crypto.randomUUID() }; await createNew(); return }
      const token = ++epoch; set({ busy: 'planning', error: null, draft: '' })
      let id = get().session?.session_id
      try {
        if (!id) { const session = await createOrganizerSession(request.scope); apply(session, token); id = session.session_id }
        const session = get().session!
        apply(await messageOrganizerSession(id, { ...request, expected_revision: session.revision, request_id: crypto.randomUUID() }), token)
      } catch (error) { if (id) await reloadAfterError(id, token, error); else if (token === epoch) set({ error: errorText(error) }); if (token === epoch && !get().draft) set({ draft: request.instruction }) }
      finally { if (token === epoch) set({ busy: null }) }
    },
    execute: id => action('approve', id), undo: id => action('undo', id),
    cancel: async () => {
      const session = get().session; if (!session || get().busy === 'cancelling' || get().busy === 'executing' || get().busy === 'undoing') return
      const stoppingCompaction = get().busy === 'compacting'
      const token = ++epoch; set({ busy: 'cancelling', error: null })
      try {
        // The message request may already have advanced the server revision.
        const latest = await getOrganizerSession(session.session_id)
        apply(await actOrganizerSession(session.session_id, stoppingCompaction ? 'cancel-compaction' : 'cancel', { expected_revision: latest.revision, request_id: crypto.randomUUID() }), token)
        if (stoppingCompaction && token === epoch) set({ compactNotice: '上下文压缩已停止，完整记录与待确认计划已保留' })
      }
      catch (error) { await reloadAfterError(session.session_id, token, error) }
      finally { if (token === epoch) set({ busy: null }) }
    },
    clear: async () => {
      if (get().busy || get().retentionPreview || !get().messages.length) return
      pendingCreation = { scope: { kind: 'all' }, requestId: crypto.randomUUID() }
      await createNew()
    },
  }
}, { name: storageKey + '-composer', storage: createJSONStorage(() => localStorage), partialize: state => ({ model: state.model, modelOverridden: state.modelOverridden, controls: state.controls }) }))
