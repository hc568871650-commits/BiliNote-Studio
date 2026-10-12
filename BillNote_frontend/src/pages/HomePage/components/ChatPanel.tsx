import { shouldSendMessage } from '@/utils/sendShortcut'
import { useInterfaceStore } from '@/store/interfaceStore'
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, Square, Paperclip, X, MessageSquare, Maximize2, Minimize2, ArrowRight, RotateCcw, Settings2, ChevronRight } from 'lucide-react'
import toast from 'react-hot-toast'
import { Link, useNavigate } from 'react-router-dom'
import { useReadingAssistantStore, permanentSessionKey, temporarySessionKey, type ReadingAttachment } from '@/store/readingAssistantStore'
import { usePurposeModelStore } from '@/store/purposeModelStore'
import PurposeModelPicker from '@/components/PurposeModelPicker'
import AIControls from '@/components/AIControls'
import SlashCommandMenu from '@/components/SlashCommandMenu'
import { useCompactCommand } from '@/hooks/useCompactCommand'
import { defaultAISettings, settingsForModel, estimateLocalContext } from '@/utils/aiSettings'
import { askQuestion, compactChat, chatProtocolLabels, type ChatErrorDetails } from '@/services/chat'
import { useProviderProtocolStore } from '@/store/providerProtocolStore'
import { activeReadingMessages, wireHistory, compressionPrefix, compactedMemory, AUTO_COMPACT_THRESHOLD } from '@/utils/readingContext'
import type { ReadingSession } from '@/store/readingAssistantStore'
import { readAttachment, wireAttachment, MAX_ATTACHMENTS } from '@/utils/readingAttachments'
import './reading-assistant.css'
import { useChatStore } from '@/store/chatStore'
import { askQuestionStream } from '@/services/chatStream'
import { useTaskStore } from '@/store/taskStore'
import { useSourceNavigationStore } from '@/store/sourceNavigationStore'
import type { QuotePart } from '@/utils/quoteSource'
import QuoteAttachment from './QuoteAttachment'
import { useComposerTextarea } from '@/hooks/useComposerTextarea'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import WebSearchControl from '@/components/WebSearchControl'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import SourceList from '@/components/SourceList'

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
  const protocol = useProviderProtocolStore(state => state.protocols[model?.provider_id || ''] || 'openai-chat')
  const controlModel = model?.model_name
  const { capabilities } = useModelCapabilities(model?.provider_id, model?.model_name, protocol)
  const controls = settingsForModel(session.controls || defaultAISettings, controlModel, capabilities?.available_efforts || ['auto'])
  const { patch, append, attach } = useReadingAssistantStore.getState()
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
      history: wireHistory(sent), summary: snapshot.memory?.summary || '', keep_recent: 0 }, abort.signal)
    if (abort.signal.aborted) return false
    const latest = useReadingAssistantStore.getState().sessions[sessionKey]
    if (!latest || latest.memory?.through_id !== snapshot.memory?.through_id) throw new Error('对话已变化，未应用过期摘要')
    if (!result.compacted) { setNotice('当前历史较短，无需压缩。'); setCompacting(false); return false }
    const memory = compactedMemory(latest, sent, result)
    const remaining = activeReadingMessages({ ...latest, memory })
    patch(sessionKey, { memory, context: { input_tokens: estimateLocalContext([memory?.summary, wireHistory(remaining)]) + 1024,
      estimated: true, limit: 272000, compacted: true, compacted_messages: memory?.compacted_messages } })
    setNotice(`已压缩 ${result.consumed_messages} 条消息`)
    setCompacting(false)
    return true
  }
  const send = async (override?: string) => {
    if (busy || readingFiles || !(override ?? session.input).trim()) return
    if (!model?.provider_id || !model.model_name) { setErrorDetails(null); setError('选择阅读模型后再发送'); return }
    const question = (override ?? session.input).trim()
    const attachments = session.attachments
    const manual = question.toLowerCase() === '/compact' || question === '压缩上下文'
    setError(''); setErrorDetails(null); setNotice(''); setCompacting(false); setBusy(true); setWaitSeconds(0); setStreamText(''); setStreamPhase(''); follow.current = true
    const abort = new AbortController(); controller.current = abort
    const startedAt = performance.now()
    waitTimer.current = setInterval(() => {
      if (controller.current === abort) setWaitSeconds(Math.floor((performance.now() - startedAt) / 1000))
    }, 1000)
    let userMessageId: string | undefined
    let streamed = ''
    let streamFrame: number | undefined
    try {
      if (!manual && controls.web_search && (controls.web_search_mode === 'external' ? !capabilities?.external_search_available : capabilities?.features.web_native?.status !== 'passed')) {
        throw new Error('当前联网方式尚不可用，请测试原生搜索或配置外部检索后再发送')
      }
      if (manual) {
        await compactOnce(session, abort)
        if (!abort.signal.aborted) patch(sessionKey, { input: '' })
        return
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = useReadingAssistantStore.getState().sessions[sessionKey] || session
        const active = activeReadingMessages(current)
        const localEstimate = estimateLocalContext([current.memory?.summary, wireHistory(active), question, attachments]) + 4096
        if (Math.max(localEstimate, current.context?.input_tokens || 0) < AUTO_COMPACT_THRESHOLD && active.length < 160 && JSON.stringify(wireHistory(active)).length < 10 * 1024 * 1024) break
        if (!await compactOnce(current, abort)) break
        if (abort.signal.aborted) return
      }
      if (abort.signal.aborted) return
      const current = useReadingAssistantStore.getState().sessions[sessionKey] || session
      const sent = activeReadingMessages(current)
      if (sent.length > 200) throw new Error('待处理历史仍较多，请先输入 /compact 再次压缩；原记录已保留。')
      const payload = { task_id: taskId, question, history: wireHistory(sent), summary: current.memory?.summary || '',
        provider_id: model.provider_id, model_name: model.model_name, protocol, ...controls,
        attachments: attachments.map(wireAttachment), context_mode: attachments.some(a => a.type === 'quote') ? 'selection' as const : 'note' as const }
      if (JSON.stringify(payload).length > 11 * 1024 * 1024) throw new Error('当前附件过大，请减少附件；原记录已保留。')
      userMessageId = crypto.randomUUID()
      append(sessionKey, { id: userMessageId, role: 'user', content: question, attachments })
      patch(sessionKey, { input: '', attachments: [] })
      const result = streamReading ? await askQuestionStream(payload, event => {
        if (abort.signal.aborted) return
        if (event.type === 'status') {
          setStreamPhase(event.phase || '')
          if (event.reset_text) { streamed = ''; setStreamText('') }
        }
        if (event.type === 'delta' && typeof event.text === 'string') {
          streamed += event.text
          if (streamFrame === undefined) streamFrame = requestAnimationFrame(() => { streamFrame = undefined; if (!abort.signal.aborted) setStreamText(streamed) })
        }
      }, abort.signal) : await askQuestion(payload, abort.signal)
      if (typeof result?.answer !== 'string' || !result.answer.trim()) throw new Error('模型未返回有效回答，请调整思考强度或检查服务商兼容性后重试。')
      if (!abort.signal.aborted) {
        const latest = useReadingAssistantStore.getState().sessions[sessionKey]
        const memory = result.compaction?.compacted ? compactedMemory(latest, sent, result.compaction) : latest.memory
        append(sessionKey, { id: crypto.randomUUID(), role: 'assistant', content: result.answer, sources: result.sources,
          elapsed_seconds: Math.max(1, Math.ceil((performance.now() - startedAt) / 1000)) })
        patch(sessionKey, { memory, context: result.context ? { ...result.context, compacted: Boolean(memory), compacted_messages: memory?.compacted_messages } : undefined })
        streamed = ''; setStreamText('')
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        const message = (e as { msg?: string; message?: string }).msg || (e as Error).message || '问答失败，请检查模型配置后重试。'
        const details = (e as { data?: { error_details?: ChatErrorDetails } }).data?.error_details
        setErrorDetails(details || null)
        setError(!details && /(?:request\s+timed\s+out|timeout|timed\s+out)/i.test(message)
          ? '模型服务响应超时，本次未收到完整回答。请稍后重试或选择其他可用模型。'
          : message)
        const now = useReadingAssistantStore.getState().sessions[sessionKey]
        if (now && userMessageId && !streamed.trim()) patch(sessionKey, { input: question, attachments, messages: now.messages.filter(m => m.id !== userMessageId) })
      }
    } finally {
      if (streamFrame !== undefined) cancelAnimationFrame(streamFrame)
      const latest = useReadingAssistantStore.getState().sessions[sessionKey]
      if (streamed.trim() && latest?.messages.at(-1)?.id === userMessageId) {
        append(sessionKey, { id: crypto.randomUUID(), role: 'assistant', content: streamed, incomplete: true,
          elapsed_seconds: Math.max(1, Math.ceil((performance.now() - startedAt) / 1000)) })
        setStreamText('')
      }
      if (controller.current === abort) {
        if (waitTimer.current !== null) clearInterval(waitTimer.current)
        waitTimer.current = null
        controller.current = null
        setBusy(false); setCompacting(false)
      }
    }
  }
  const slash = useCompactCommand(session.input, busy || readingFiles, () => { void send('/compact') })
  const jump = (a: ReadingAttachment, parts: QuotePart[]) => {
    const noteId = a.taskId || taskId
    if (!useTaskStore.getState().tasks.some(task => task.id === noteId)) {
      toast.error('原笔记已不可用，可用引用旁的小箭头查看保留的内容'); return
    }
    if (mode === 'full') onModeChange('half')
    useSourceNavigationStore.getState().open({ source_type: 'note', note_id: noteId, version_id: a.versionId,
      title: a.name, text: parts[0]?.text || a.text || '', quote_parts: parts })
    useTaskStore.getState().setCurrentTask(noteId)
    navigate('/?view=read')
  }
  const attachmentCard = (a: ReadingAttachment, removable = false) => a.type === 'quote' ? <QuoteAttachment key={a.id} attachment={a} onOriginal={parts => jump(a, parts)} onRemove={removable ? () => patch(sessionKey, { attachments: session.attachments.filter(item => item.id !== a.id) }) : undefined} /> : <div className="assistant-attachment" key={a.id}>
    <button className="assistant-attachment-content" onClick={() => setPreview(a)} title="预览附件">
      {a.type === 'image' ? <img src={a.data_url} alt={a.name} /> : <MessageSquare size={15} />}
      <span><strong>{a.name}</strong><small>{a.type === 'image' ? '图片' : a.text?.slice(0, 20)}</small></span>
    </button>{removable && <button aria-label={`移除 ${a.name}`} onClick={() => patch(sessionKey, { attachments: session.attachments.filter(item => item.id !== a.id) })}><X size={13} /></button>}
  </div>
  return <section className={`reading-chat ${temporary ? 'reading-chat--temporary' : ''}`} aria-label={temporary ? '临时聊天' : '常驻阅读对话'}>
    <header className="reading-chat-header"><MessageSquare size={14} /><strong>{temporary ? '临时聊天' : '阅读助手'}</strong><div className="flex-1" />
      {temporary && onTransfer && <button disabled={busy} onClick={onTransfer} title="转入阅读对话" aria-label="转入阅读对话"><ArrowRight size={14} /></button>}
      <button className="reading-default-model" title={controls.web_search ? "聊天设置 · 联网已开启" : "聊天设置"} aria-label="聊天设置" onClick={() => setChatSettingsOpen(true)}><Settings2 size={14} />{controls.web_search && <i className="reading-web-status" aria-label="联网已开启" />}</button>
      {!temporary && <button disabled={busy} title={mode === 'half' ? '展开对话' : '返回并排阅读'} aria-label={mode === 'half' ? '展开对话' : '返回并排阅读'} onClick={() => onModeChange(mode === 'half' ? 'full' : 'half')}>{mode === 'half' ? <Maximize2 size={15} /> : <Minimize2 size={15} />}</button>}
      <button title="清空本次对话" aria-label="清空本次对话" disabled={busy} onClick={() => setConfirmClear(true)}><RotateCcw size={15} /></button>
      {onClose && <button title="关闭聊天" aria-label="关闭聊天" onClick={onClose}><X size={16} /></button>}
    </header>
    <div ref={messages} className="reading-chat-messages" onScroll={() => { const el = messages.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}>
      {!session.messages.length && <div className="reading-chat-welcome"><h3>{temporary ? '问问这一段' : '阅读助手'}</h3><div className="reading-chat-prompts">{['解释这段', '整理步骤', '找出关键点'].map(text => <button key={text} onClick={() => { patch(sessionKey, { input: text }); textarea.current?.focus() }}>{text}</button>)}</div></div>}
      {session.messages.map(message => <article key={message.id} className={`reading-message reading-message--${message.role}`}>
        {message.role === 'assistant' && (message.elapsed_seconds != null || !!message.sources?.length || message.incomplete) && <details className="reading-reply-details">
          <summary aria-label={message.elapsed_seconds != null ? `用时 ${durationLabel(message.elapsed_seconds)}，展开详情` : '展开回复详情'} title="查看本轮详情"><span>{message.elapsed_seconds != null ? `用时 ${durationLabel(message.elapsed_seconds)}` : ''}</span><ChevronRight size={13} /></summary>
          <div className="reading-reply-detail-content">
            {message.incomplete && <p>回复已中断</p>}
            {message.sources?.length ? <SourceList sources={message.sources} /> : !message.incomplete && <p>未返回参考来源</p>}
          </div>
        </details>}
        {!!message.attachments?.length && <div className="reading-message-attachments">{message.attachments.map(a => attachmentCard(a))}</div>}
        {message.content.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown> : <p className="reading-chat-error">此前模型没有返回正文，请重新提问。</p>}
      </article>)}
      {busy && <article className={`reading-message reading-message--assistant ${streamText ? 'reading-message--streaming' : ''}`}>
        <details className="reading-reply-details"><summary aria-label="展开处理状态"><span aria-live="off">用时 {durationLabel(waitSeconds)}</span><ChevronRight size={13} /></summary><div className="reading-reply-detail-content" role="status">{compacting || streamPhase === 'compacting' ? '压缩上下文…' : streamPhase === 'searching' ? '搜索网络资料…' : ['tool', 'retrieving'].includes(streamPhase) ? '查阅笔记…' : streamText ? '回复中…' : '思考中…'}</div></details>
        {streamText && <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamText}</ReactMarkdown>}
      </article>}
      {notice && <p className="reading-thinking" role="status">{notice}</p>}<div ref={end} className="reading-scroll-end" />
    </div>
    {error && <div role="alert" className="reading-chat-error">{error}{errorDetails && <details className="reading-error-details"><summary>错误详情{errorDetails.http_status ? ` · HTTP ${errorDetails.http_status}` : ''}</summary><dl><dt>接口协议</dt><dd>{chatProtocolLabels[errorDetails.protocol as keyof typeof chatProtocolLabels] || errorDetails.protocol}</dd><dt>发生时间</dt><dd>{new Date(errorDetails.occurred_at).toLocaleString()}</dd><dt>HTTP 状态</dt><dd>{errorDetails.http_status ?? '未收到上游 HTTP 错误响应'}</dd><dt>上游错误码</dt><dd>{errorDetails.upstream_code || '未提供'}</dd><dt>请求 ID</dt><dd>{errorDetails.request_id || '未收到'}</dd></dl><pre>{errorDetails.detail}</pre></details>}</div>}
    <div className="reading-chat-composer" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addFiles(Array.from(event.dataTransfer.files)) }}>
      <SlashCommandMenu open={slash.open} id={slash.id} onSelect={slash.select} />
      <div className="reading-chat-attachments">{session.attachments.map(a => attachmentCard(a, true))}</div>
      <textarea ref={textarea} rows={1} aria-controls={slash.open ? slash.id : undefined} aria-activedescendant={slash.open ? `${slash.id}-compact` : undefined} onBlur={slash.dismiss} readOnly={busy} maxLength={20000} aria-label={temporary ? '临时聊天问题' : '阅读对话问题'} placeholder="输入问题…" value={session.input} onChange={event => patch(sessionKey, { input: event.target.value })}
        onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void addFiles(files) } }}
        onKeyDown={event => { if (slash.onKeyDown(event)) return; if (shouldSendMessage(event, useInterfaceStore.getState().sendKey)) { event.preventDefault(); void send() } }} />
      <div className="reading-chat-actions"><input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.markdown" hidden onChange={event => { void addFiles(Array.from(event.target.files || [])); event.target.value = '' }} /><button aria-label="添加图片或文本附件" title="添加图片、TXT、Markdown" disabled={readingFiles || busy} onClick={() => fileInput.current?.click()}><Paperclip size={14} /></button>{readingFiles && <span>读取中…</span>}<div className="flex-1" /><AIControls modelPicker={<PurposeModelPicker inline label="本会话模型" value={model} disabled={busy} controls={controls} onControlsChange={value => patch(sessionKey, { controls: value })} reasoningModel={controlModel || ''} onChange={value => patch(sessionKey, { model: value })} />} modelName={controlModel} value={controls} context={session.context} estimate={estimateLocalContext([session.memory?.summary, wireHistory(activeReadingMessages(session)), session.attachments])} draft={session.input} />{busy ? <button className="reading-send" aria-label="停止等待回答" title="停止回复" onClick={() => { cancelWait(); setBusy(false); setCompacting(false); setNotice('已停止') }}><Square size={11} /></button> : <button className="reading-send" aria-label="发送问题" disabled={!session.input.trim() || readingFiles} onClick={() => void send()}><ArrowUp size={15} /></button>}</div>
    </div>
    <Dialog open={chatSettingsOpen} onOpenChange={setChatSettingsOpen}><DialogContent className="reading-options-window"><DialogHeader><DialogTitle>聊天设置</DialogTitle><DialogDescription>仅调整当前会话，保留原有消息。</DialogDescription></DialogHeader><div className="reading-options-row"><span>允许联网搜索</span><WebSearchControl value={controls} onChange={value => patch(sessionKey, { controls: value })} providerId={model?.provider_id} modelName={model?.model_name} protocol={protocol} disabled={busy} /></div><Link to="/settings/purposes" onClick={() => setChatSettingsOpen(false)}>默认模型与检索服务设置 →</Link></DialogContent></Dialog>
    {confirmClear && <div className="reading-confirm" role="dialog" aria-label="确认清空对话"><p>清空这次对话及草稿？笔记内容不受影响。</p><button onClick={() => setConfirmClear(false)}>取消</button><button onClick={() => { useReadingAssistantStore.getState().clear(sessionKey); setConfirmClear(false) }}>清空对话</button></div>}
    {preview && <div className="reading-file-preview" role="dialog" aria-label="附件预览"><header><strong>{preview.name}</strong><button aria-label="关闭附件预览" onClick={() => setPreview(null)}><X size={18} /></button></header>{preview.type === 'image' ? <img src={preview.data_url} alt={preview.name} /> : <pre>{preview.text}</pre>}</div>}
  </section>
}
