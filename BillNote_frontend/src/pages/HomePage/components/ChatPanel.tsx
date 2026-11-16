import { shouldSendMessage } from '@/utils/sendShortcut'
import { useInterfaceStore } from '@/store/interfaceStore'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Square, Paperclip, X, MessageSquare, Maximize2, Minimize2, ArrowRight, RotateCcw, Settings2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { Link, useNavigate } from 'react-router-dom'
import { useReadingAssistantStore, permanentSessionKey, temporarySessionKey, type ReadingAttachment } from '@/store/readingAssistantStore'
import { usePurposeModelStore } from '@/store/purposeModelStore'
import PurposeModelPicker from '@/components/PurposeModelPicker'
import AIControls from '@/components/AIControls'
import SlashCommandMenu from '@/components/SlashCommandMenu'
import { useCompactCommand } from '@/hooks/useCompactCommand'
import { defaultReadingSettings, requestEffortChoices, settingsForModel, estimateLocalContext } from '@/utils/aiSettings'
import { askQuestion, compactChat, chatProtocolLabels, type ChatErrorDetails, type ToolEvent } from '@/services/chat'
import { useEffectiveProviderProtocol } from '@/hooks/useEffectiveProviderProtocol'
import { activeReadingMessages, wireHistory, compressionPrefix, compactedMemory } from '@/utils/readingContext'
import type { ReadingSession } from '@/store/readingAssistantStore'
import { readAttachment, wireAttachment, MAX_ATTACHMENTS } from '@/utils/readingAttachments'
import './reading-assistant.css'
import { useChatStore } from '@/store/chatStore'
import { askQuestionStream } from '@/services/chatStream'
import { useTaskStore } from '@/store/taskStore'
import { useSourceNavigationStore } from '@/store/sourceNavigationStore'
import type { QuotePart } from '@/utils/quoteSource'
import { ReadingAttachmentCard, ReadingMessageItem } from './ReadingMessageItem'
import { useComposerTextarea } from '@/hooks/useComposerTextarea'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import { webSearchState } from '@/utils/webSearch'
import { useModelWebSearchSettings } from '@/hooks/useModelWebSearchSettings'
import WorkProgress from '@/components/WorkProgress'
import AssistantChatSettings from '@/components/AssistantChatSettings'
import useModelContext from '@/hooks/useModelContext'
import { openNoteSource } from '@/utils/openNoteSource'
import { beginReadingTurn, updateReadingTurn, readingRecoveryState, restoreReadingTurn } from '@/utils/readingRecovery'
import ReadingVisionStatus from '@/components/ReadingVisionStatus'
import './reading-recovery.css'

type ChatMode = 'half' | 'full'
const durationLabel = (seconds: number) => seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟 ${seconds % 60} 秒`
interface Props { taskId: string; mode: ChatMode; onModeChange: (mode: ChatMode) => void; temporary?: boolean; active?: boolean; onClose?: () => void; onTransfer?: () => void }
const empty: ReadingSession = { messages: [], input: '', attachments: [], controls: undefined, context: undefined, model: undefined }
export default function ChatPanel({ taskId, mode, onModeChange, temporary = false, active = true, onClose, onTransfer }: Props) {
  const navigate = useNavigate()
  const sessionKey = temporary ? temporarySessionKey(taskId) : permanentSessionKey(taskId)
  const session = useReadingAssistantStore(state => state.sessions[sessionKey]) || empty
  const defaultModel = usePurposeModelStore(state => state.defaults.reading)
  const model = session.model === undefined ? defaultModel : session.model
  const protocol = useEffectiveProviderProtocol(model?.provider_id)
  const controlModel = model?.model_name
  const { capabilities } = useModelCapabilities(model?.provider_id, model?.model_name, protocol)
  const [readingHydrated, setReadingHydrated] = useState(useReadingAssistantStore.persist.hasHydrated())
  useEffect(() => {
    setReadingHydrated(useReadingAssistantStore.persist.hasHydrated())
    return useReadingAssistantStore.persist.onFinishHydration(() => setReadingHydrated(true))
  }, [])
  const modelSettings = useModelWebSearchSettings(model, { ...defaultReadingSettings, ...session.controls }, active && readingHydrated, capabilities?.external_search_available)
  const search = webSearchState(settingsForModel(modelSettings, controlModel, requestEffortChoices(controlModel, protocol)), capabilities)
  const controls = search.settings
  const { budget: contextBudget } = useModelContext(model?.provider_id, model?.model_name)
  const { patch, attach } = useReadingAssistantStore.getState()
  const [busy, setBusy] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [waitSeconds, setWaitSeconds] = useState(0)
  const [notice, setNotice] = useState('')
  const [readingFiles, setReadingFiles] = useState(false)
  const [error, setError] = useState('')
  const [errorDetails, setErrorDetails] = useState<ChatErrorDetails | null>(null)
  const [preview, setPreview] = useState<ReadingAttachment | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [chatSettingsOpen, setChatSettingsOpen] = useState(false)
  const streamReading = useInterfaceStore(state => state.streamReading)
  const [streamText, setStreamText] = useState('')
  const [streamPhase, setStreamPhase] = useState('')
  const [streamTools, setStreamTools] = useState<ToolEvent[]>([])
  const [streamWork, setStreamWork] = useState<string[]>([])
  const messages = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const controller = useRef<AbortController | null>(null)
  const waitTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const textarea = useComposerTextarea(session.input)
  const end = useRef<HTMLDivElement>(null)
  const cancelWait = () => {
    controller.current?.abort()
    controller.current = null
    if (waitTimer.current !== null) clearInterval(waitTimer.current)
    waitTimer.current = null
  }
  useEffect(() => { if (!active) { cancelWait(); setBusy(false); setCompacting(false) } }, [active])
  useEffect(() => {
    if (temporary) return
    const migrate = () => {
      if (useReadingAssistantStore.getState().sessions[sessionKey]) return
      const old = useChatStore.getState().chatHistory[taskId]
      if (old?.length) patch(sessionKey, { messages: old.map(message => ({ ...message, id: crypto.randomUUID() })) })
    }
    if (useReadingAssistantStore.persist.hasHydrated()) migrate()
    return useReadingAssistantStore.persist.onFinishHydration(migrate)
  }, [sessionKey, taskId, temporary, patch])
  useEffect(() => {
    setBusy(false); setCompacting(false); setError(''); setErrorDetails(null); setNotice(''); setWaitSeconds(0); setStreamText(''); setStreamPhase('')
    return cancelWait
  }, [sessionKey])
  useEffect(() => { if (follow.current) end.current?.scrollIntoView({ block: 'nearest' }) }, [session.messages.length, busy, streamText])
  useEffect(() => { if (session.attachments.length) textarea.current?.focus() }, [session.attachments.length])
  const addFiles = async (files: File[]) => {
    if (readingFiles || busy) return
    setReadingFiles(true)
    try {
      const current = useReadingAssistantStore.getState().sessions[sessionKey]?.attachments || []
      if (current.length + files.length > MAX_ATTACHMENTS) throw new Error('每条消息最多 8 个附件')
      const items = await Promise.all(files.map(readAttachment))
      if (JSON.stringify([...current, ...items]).length > 8 * 1024 * 1024) throw new Error('本条消息附件总量过大，请减少图片')
      attach(sessionKey, items)
    } catch (e) { toast.error((e as Error).message) } finally { setReadingFiles(false) }
  }
  const compactOnce = async (snapshot: ReadingSession, abort: AbortController) => {
    const sent = compressionPrefix(activeReadingMessages(snapshot))
    if (!sent.length) { setNotice('较早历史不足，无需压缩。'); return false }
    setCompacting(true)
    const result = await compactChat({ task_id: taskId, provider_id: model!.provider_id, model_name: model!.model_name, protocol,
      history: wireHistory(sent), summary: snapshot.memory?.summary || '', keep_recent: 0,
      context_limit: contextBudget.user_limit }, abort.signal)
    if (abort.signal.aborted) return false
    const latest = useReadingAssistantStore.getState().sessions[sessionKey]
    if (!latest || latest.memory?.through_id !== snapshot.memory?.through_id) throw new Error('对话已变化，未应用过期摘要')
    if (!result.compacted) { setNotice('当前历史较短，无需压缩。'); setCompacting(false); return false }
    const memory = compactedMemory(latest, sent, result)
    const remaining = activeReadingMessages({ ...latest, memory })
    patch(sessionKey, { memory, context: { input_tokens: estimateLocalContext([memory?.summary, wireHistory(remaining)]) + 1024,
      estimated: true, limit: result.context.limit, compacted: true, compacted_messages: memory?.compacted_messages } })
    setNotice(`已压缩 ${result.consumed_messages} 条消息`)
    setCompacting(false)
    return true
  }
  const send = async (override?: string) => {
    if (controller.current || busy || readingFiles || !(override ?? session.input).trim()) return
    if (!model?.provider_id || !model.model_name) { setErrorDetails(null); setError('选择阅读模型后再发送'); return }
    const originalInput = override ?? session.input
    const question = originalInput.trim()
    const attachments = session.attachments
    const manual = question.toLowerCase() === '/compact' || question === '压缩上下文'
    setError(''); setErrorDetails(null); setNotice(''); setCompacting(false); setBusy(true); setWaitSeconds(0); setStreamText(''); setStreamTools([]); setStreamWork([]); setStreamPhase(''); follow.current = true
    const abort = new AbortController(); controller.current = abort
    const startedAt = performance.now()
    waitTimer.current = setInterval(() => {
      if (controller.current === abort) setWaitSeconds(Math.floor((performance.now() - startedAt) / 1000))
    }, 1000)
    let userMessageId: string | undefined
    let answerMessageId: string | undefined
    let completed = false
    let streamed = ''
    let traced: ToolEvent[] = []
    let work: string[] = []
    const requestSnapshot = { protocol, stream: streamReading, web_search: Boolean(controls.web_search),
      web_search_mode: controls.web_search_mode || 'native' as const, provider_id: model.provider_id,
      model_name: model.model_name, context_limit: contextBudget.input_limit, output_reserve: contextBudget.output_reserve }
    let streamFrame: number | undefined
    let persistTimer: ReturnType<typeof setTimeout> | undefined
    let lastPersist = -Infinity
    const persistStream = () => {
      if (!userMessageId) return
      const next = updateReadingTurn(useReadingAssistantStore.getState().sessions[sessionKey], userMessageId,
        { content: streamed, tool_events: traced, work_log: work })
      if (next) patch(sessionKey, { messages: next.messages })
      lastPersist = performance.now()
    }
    const schedulePersist = () => {
      if (performance.now() - lastPersist >= 400) persistStream()
      else if (persistTimer === undefined) persistTimer = setTimeout(() => { persistTimer = undefined; persistStream() }, 400)
    }
    try {
      if (manual) {
        await compactOnce(session, abort)
        if (!abort.signal.aborted && useReadingAssistantStore.getState().sessions[sessionKey]?.input === originalInput) patch(sessionKey, { input: '' })
        return
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = useReadingAssistantStore.getState().sessions[sessionKey] || session
        const active = activeReadingMessages(current)
        const localEstimate = estimateLocalContext([current.memory?.summary, wireHistory(active), question, attachments]) + 4096
        if (Math.max(localEstimate, current.context?.input_tokens || 0) < contextBudget.compact_threshold && active.length < 160 && JSON.stringify(wireHistory(active)).length < 10 * 1024 * 1024) break
        if (!await compactOnce(current, abort)) break
        if (abort.signal.aborted) return
      }
      if (abort.signal.aborted) return
      const current = useReadingAssistantStore.getState().sessions[sessionKey] || session
      const sent = activeReadingMessages(current)
      if (sent.length > 200) throw new Error('待处理历史仍较多，请先输入 /compact 再次压缩；原记录已保留。')
      const payload = { task_id: taskId, question, history: wireHistory(sent), summary: current.memory?.summary || '',
        provider_id: model.provider_id, model_name: model.model_name, protocol, ...controls, context_limit: contextBudget.user_limit,
        attachments: attachments.map(wireAttachment), context_mode: attachments.some(a => a.type === 'quote') ? 'selection' as const : 'note' as const }
      if (JSON.stringify(payload).length > 11 * 1024 * 1024) throw new Error('当前附件过大，请减少附件；原记录已保留。')
      userMessageId = crypto.randomUUID()
      answerMessageId = crypto.randomUUID()
      patch(sessionKey, beginReadingTurn(current, { id: userMessageId, role: 'user', content: originalInput, attachments, request: requestSnapshot }, answerMessageId))
      const result = streamReading ? await askQuestionStream(payload, event => {
        if (abort.signal.aborted) return
        if (event.type === 'tool_event' && event.event) {
          traced = [...traced.filter(record => record.id !== event.event!.id), event.event].slice(-32)
          setStreamTools(traced)
        }
        if (event.type === 'status') {
          setStreamPhase(event.phase || '')
          if (event.reset_text) { streamed = ''; setStreamText('') }
        }
        if (event.type === 'work_log') {
          if (event.text?.trim()) work = [...work, event.text]
          streamed = ''; setStreamText(''); setStreamWork(work)
        }
        if (event.type === 'delta' && typeof event.text === 'string') {
          streamed += event.text
          if (streamFrame === undefined) streamFrame = requestAnimationFrame(() => { streamFrame = undefined; if (!abort.signal.aborted) setStreamText(streamed) })
        }
        schedulePersist()
      }, abort.signal) : await askQuestion(payload, abort.signal)
      if (typeof result?.answer !== 'string' || !result.answer.trim()) throw new Error('模型未返回有效回答，请调整思考强度或检查服务商兼容性后重试。')
      if (!abort.signal.aborted) {
        const latest = useReadingAssistantStore.getState().sessions[sessionKey]
        if (!latest) return
        const memory = result.compaction?.compacted ? compactedMemory(latest, sent, result.compaction) : latest.memory
        const next = updateReadingTurn(latest, userMessageId, { content: result.answer, sources: result.sources,
          tool_events: result.tool_events || traced, work_log: result.work_log || work,
          request: { ...requestSnapshot, context_limit: result.context?.model_context?.input_limit ?? requestSnapshot.context_limit,
            output_reserve: result.context?.model_context?.output_reserve ?? requestSnapshot.output_reserve,
            protocol: result.context?.protocol || requestSnapshot.protocol, web_search_used: result.context?.web_search_used === true, trace_id: result.context?.trace_id, request_id: result.context?.request_id },
          elapsed_seconds: Math.max(1, Math.ceil((performance.now() - startedAt) / 1000)) }, 'complete')
        if (next) patch(sessionKey, { messages: next.messages, memory, context: result.context ? { ...result.context, compacted: Boolean(memory), compacted_messages: memory?.compacted_messages } : undefined })
        completed = true
        streamed = ''; traced = []; work = []
        if (controller.current === abort) { setStreamText(''); setStreamTools([]); setStreamWork([]) }
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        const message = (e as { msg?: string; message?: string }).msg || (e as Error).message || '问答失败，请检查模型配置后重试。'
        const details = (e as { data?: { error_details?: ChatErrorDetails } }).data?.error_details
        const returnedEvents = (e as { data?: { tool_events?: ToolEvent[] } }).data?.tool_events
        if (returnedEvents?.length) traced = returnedEvents
        if (controller.current === abort) {
          setErrorDetails(details || null)
          setError(!details && /(?:request\s+timed\s+out|timeout|timed\s+out)/i.test(message)
            ? '模型服务响应超时，本次未收到完整回答。请稍后重试或选择其他可用模型。'
            : message)
        }
      }
    } finally {
      if (streamFrame !== undefined) cancelAnimationFrame(streamFrame)
      if (persistTimer !== undefined) clearTimeout(persistTimer)
      const latest = useReadingAssistantStore.getState().sessions[sessionKey]
      if (!completed && userMessageId && answerMessageId) {
        const next = updateReadingTurn(latest, userMessageId, { content: streamed, tool_events: traced, work_log: work,
          elapsed_seconds: Math.max(1, Math.ceil((performance.now() - startedAt) / 1000)) }, abort.signal.aborted ? 'cancelled' : 'failed')
        if (next) patch(sessionKey, !streamed.trim() ? restoreReadingTurn(next, answerMessageId) : next)
      }
      if (controller.current === abort) {
        if (waitTimer.current !== null) clearInterval(waitTimer.current)
        waitTimer.current = null
        controller.current = null
        setBusy(false); setCompacting(false)
        setStreamText('')
        setStreamTools([])
        setStreamWork([])
      }
    }
  }
  const restoreQuestion = useCallback((answerId: string) => {
    if (busy || controller.current) return
    const current = useReadingAssistantStore.getState().sessions[sessionKey]
    if (!current) return
    const restored = restoreReadingTurn(current, answerId)
    if (restored === current) return
    patch(sessionKey, { input: restored.input, attachments: restored.attachments })
    textarea.current?.focus()
  }, [busy, sessionKey, patch, textarea])
  const slash = useCompactCommand(session.input, busy || readingFiles, () => { void send('/compact') })
  const jump = useCallback((a: ReadingAttachment, parts: QuotePart[]) => {
    const noteId = a.taskId || taskId
    if (!useTaskStore.getState().tasks.some(task => task.id === noteId)) {
      toast.error('原笔记已不可用，可用引用旁的小箭头查看保留的内容'); return
    }
    if (mode === 'full') onModeChange('half')
    useSourceNavigationStore.getState().open({ source_type: 'note', note_id: noteId, version_id: a.versionId,
      title: a.name, text: parts[0]?.text || a.text || '', quote_parts: parts })
    useTaskStore.getState().setCurrentTask(noteId)
    navigate('/?view=read')
  }, [taskId, mode, onModeChange, navigate])
  const jumpImage = useCallback(async (attachment: ReadingAttachment) => {
    if (!attachment.taskId || !attachment.imageSource) return
    try {
      const opened = await openNoteSource({ source_type: 'note', note_id: attachment.taskId,
        version_id: attachment.versionId, title: attachment.imageSource.title, text: '',
        image_source: { path: attachment.imageSource.path, blockId: attachment.blockId } })
      if (opened) { if (mode === 'full') onModeChange('half'); navigate('/?view=read') }
    } catch { toast.error('原笔记或版本不可用，附件中的图片仍可查看') }
  }, [mode, onModeChange, navigate])
  const activeMessages = useMemo(() => activeReadingMessages({ messages: session.messages, memory: session.memory } as ReadingSession), [session.messages, session.memory])
  const historyHasImages = useMemo(() => activeMessages.some(message => message.attachments?.some(attachment => attachment.type === 'image')), [activeMessages])
  const estimate = useMemo(() => estimateLocalContext([session.memory?.summary, wireHistory(activeMessages), session.attachments]), [session.memory?.summary, activeMessages, session.attachments])
  const messageById = useMemo(() => new Map(session.messages.map(message => [message.id, message])), [session.messages])
  const visibleMessages = useMemo(() => session.messages.filter(message => message.role !== 'assistant' || !message.reply_to || messageById.get(message.reply_to)?.delivery_status !== 'pending'), [session.messages, messageById])
  const hasImages = session.attachments.some(attachment => attachment.type === 'image')
    || historyHasImages

  return <section className={`reading-chat ${temporary ? 'reading-chat--temporary' : ''}`} aria-label={temporary ? '临时聊天' : '常驻阅读对话'}>
    <header className="reading-chat-header"><MessageSquare size={14} /><strong>{temporary ? '临时聊天' : '阅读助手'}</strong><div className="flex-1" />
      {temporary && onTransfer && <button disabled={busy} onClick={onTransfer} title="转入阅读对话" aria-label="转入阅读对话"><ArrowRight size={14} /></button>}
      <button className="reading-default-model" title={search.error ? `聊天设置 · ${search.error}` : search.enabled ? "聊天设置 · 联网已开启" : "聊天设置"} aria-label="聊天设置" onClick={() => setChatSettingsOpen(true)}><Settings2 size={14} />{search.enabled && search.available && <i className="reading-web-status" aria-label="联网已开启" />}</button>
      {!temporary && <button disabled={busy} title={mode === 'half' ? '展开对话' : '返回并排阅读'} aria-label={mode === 'half' ? '展开对话' : '返回并排阅读'} onClick={() => onModeChange(mode === 'half' ? 'full' : 'half')}>{mode === 'half' ? <Maximize2 size={15} /> : <Minimize2 size={15} />}</button>}
      <button title="清空本次对话" aria-label="清空本次对话" disabled={busy} onClick={() => setConfirmClear(true)}><RotateCcw size={15} /></button>
      {onClose && <button title="关闭聊天" aria-label="关闭聊天" onClick={onClose}><X size={16} /></button>}
    </header>
    <div ref={messages} className="reading-chat-messages" onScroll={() => { const el = messages.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}>
      {!session.messages.length && <div className="reading-chat-welcome"><h3>{temporary ? '问问这一段' : '问问这篇笔记'}</h3><div className="reading-chat-prompts">{['解释这段', '整理步骤', '找出关键点'].map(text => <button key={text} onClick={() => { patch(sessionKey, { input: text }); textarea.current?.focus() }}>{text}</button>)}</div></div>}
      {visibleMessages.map(message => <ReadingMessageItem key={message.id} message={message}
        onQuote={jump} onImage={jumpImage} onPreview={setPreview}
        recovery={message.incomplete ? readingRecoveryState(session, message.id) : undefined}
        questionStatus={message.incomplete ? messageById.get(message.reply_to || '')?.delivery_status : undefined}
        busy={message.incomplete && busy} onRestore={message.incomplete ? restoreQuestion : undefined} />)}
      {busy && <article className="reading-message reading-message--assistant">
        <WorkProgress active entries={streamWork} text={streamText} events={streamTools} phase={compacting ? 'compacting' : streamPhase} elapsed={durationLabel(waitSeconds)} />
      </article>}
      {notice && <p className="reading-thinking" role="status">{notice}</p>}<div ref={end} className="reading-scroll-end" />
    </div>
    {error && <div role="alert" className="reading-chat-error">{error}{errorDetails && <details className="reading-error-details"><summary>错误详情{errorDetails.http_status ? ` · HTTP ${errorDetails.http_status}` : ''}</summary><dl><dt>接口协议</dt><dd>{chatProtocolLabels[errorDetails.protocol as keyof typeof chatProtocolLabels] || errorDetails.protocol}</dd><dt>发生时间</dt><dd>{new Date(errorDetails.occurred_at).toLocaleString()}</dd><dt>HTTP 状态</dt><dd>{errorDetails.http_status ?? '未收到上游 HTTP 错误响应'}</dd><dt>上游错误码</dt><dd>{errorDetails.upstream_code || '未提供'}</dd><dt>请求 ID</dt><dd>{errorDetails.request_id || '未收到'}</dd></dl><pre>{errorDetails.detail}</pre></details>}</div>}
    {error && model && <Link className="reading-thinking" to={`/settings/model/${encodeURIComponent(model.provider_id)}`}>前往服务商手动检测</Link>}
    <div className="reading-chat-composer" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addFiles(Array.from(event.dataTransfer.files)) }}>
      <SlashCommandMenu open={slash.open} id={slash.id} onSelect={slash.select} />
      <div className="reading-chat-attachments">{session.attachments.map(a => <ReadingAttachmentCard key={a.id} attachment={a} onQuote={jump} onImage={jumpImage} onPreview={setPreview} onRemove={() => patch(sessionKey, { attachments: session.attachments.filter(item => item.id !== a.id) })} />)}</div>
      {hasImages && <ReadingVisionStatus model={model} protocol={protocol} capabilities={capabilities} disabled={busy} onModelChange={value => patch(sessionKey, { model: value })} />}
      <textarea ref={textarea} rows={1} aria-controls={slash.open ? slash.id : undefined} aria-activedescendant={slash.open ? `${slash.id}-compact` : undefined} onBlur={slash.dismiss} readOnly={busy} maxLength={20000} aria-label={temporary ? '临时聊天问题' : '阅读对话问题'} placeholder="输入问题…" value={session.input} onChange={event => patch(sessionKey, { input: event.target.value })}
        onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void addFiles(files) } }}
        onKeyDown={event => { if (slash.onKeyDown(event)) return; if (shouldSendMessage(event, useInterfaceStore.getState().sendKey)) { event.preventDefault(); void send() } }} />
      <div className="reading-chat-actions"><input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.markdown" hidden onChange={event => { void addFiles(Array.from(event.target.files || [])); event.target.value = '' }} /><button aria-label="添加图片或文本附件" title="添加图片、TXT、Markdown" disabled={readingFiles || busy} onClick={() => fileInput.current?.click()}><Paperclip size={14} /></button>{readingFiles && <span>读取中…</span>}<div className="flex-1" /><AIControls contextBudget={contextBudget} modelPicker={<PurposeModelPicker inline label="本会话模型" value={model} disabled={busy} controls={controls} onControlsChange={value => patch(sessionKey, { controls: value })} reasoningModel={controlModel || ''} onChange={value => patch(sessionKey, { model: value })} />} modelName={controlModel} value={controls} context={session.context} estimate={estimate} draft={session.input} />{busy ? <button className="reading-send" aria-label="停止等待回答" title="停止回复" onClick={() => { cancelWait(); setBusy(false); setCompacting(false); setNotice('已停止') }}><Square size={11} /></button> : <button className="reading-send" aria-label="发送问题" disabled={!session.input.trim() || readingFiles} onClick={() => void send()}><ArrowUp size={15} /></button>}</div>
    </div>
    <AssistantChatSettings open={chatSettingsOpen} onOpenChange={setChatSettingsOpen} providerId={model?.provider_id} modelName={model?.model_name} protocol={protocol} value={controls} onChange={value => patch(sessionKey, { controls: value })} disabled={busy} />
    {confirmClear && <div className="reading-confirm" role="dialog" aria-label="确认清空对话"><p>清空这次对话及草稿？笔记内容不受影响。</p><button onClick={() => setConfirmClear(false)}>取消</button><button onClick={() => { useReadingAssistantStore.getState().clear(sessionKey); setConfirmClear(false) }}>清空对话</button></div>}
    {preview && <div className="reading-file-preview" role="dialog" aria-label="附件预览"><header><strong>{preview.name}</strong><button aria-label="关闭附件预览" onClick={() => setPreview(null)}><X size={18} /></button></header>{preview.type === 'image' ? <img src={preview.data_url} alt={preview.name} /> : <pre>{preview.text}</pre>}</div>}
  </section>
}
