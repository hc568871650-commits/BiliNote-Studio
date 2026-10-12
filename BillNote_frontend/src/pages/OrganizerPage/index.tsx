import { shouldSendMessage, sendShortcutLabel } from '@/utils/sendShortcut'
import { scrollMotion } from '@/utils/motion'
import { useInterfaceStore } from '@/store/interfaceStore'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, FolderInput, Loader2, MessageSquare, RotateCcw, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import PurposeModelPicker from '@/components/PurposeModelPicker'
import ChoiceSelect from '@/components/ChoiceSelect'
import OrganizerRetentionDialog from '@/components/OrganizerRetentionDialog'
import AIControls from '@/components/AIControls'
import { usePurposeModelStore } from '@/store/purposeModelStore'
import { useOrganizerStore, type OrganizerMessage } from '@/store/organizerStore'
import { useTaskStore } from '@/store/taskStore'
import { useFolderStore, getFolderName } from '@/store/folderStore'
import { useLibraryStore } from '@/store/libraryStore'
import { getNoteFolders } from '@/services/noteFolders'
import { listNotes } from '@/services/note'
import type { OrganizerOperation, OrganizerPlan } from '@/services/organizer'
import './organizer.css'
import SlashCommandMenu from '@/components/SlashCommandMenu'
import { useCompactCommand } from '@/hooks/useCompactCommand'
import { settingsForModel } from '@/utils/aiSettings'
import { useComposerTextarea } from '@/hooks/useComposerTextarea'
import SourceList from '@/components/SourceList'
import { useProviderProtocolStore } from '@/store/providerProtocolStore'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'

const actionNames: Record<OrganizerOperation['type'], string> = {
  create_folder: '创建文件夹', rename_folder: '重命名文件夹', move_notes: '移动笔记',
  set_tags: '设置标签', archive: '归档笔记', restore: '恢复笔记',
}
const suggestions = ['查找笔记正文中的操作方法', '比较多篇笔记的做法与差异', '从相关笔记提炼操作步骤', '按主题整理文件夹与标签']

export default function OrganizerPage() {
  const state = useOrganizerStore()
  const sendKey = useInterfaceStore(current => current.sendKey)
  const defaultModel = usePurposeModelStore(current => current.defaults.organizer)
  const model = state.modelOverridden ? state.model : defaultModel
  const tasks = useTaskStore(current => current.tasks)
  const folders = useFolderStore(current => current.folders)
  const loadFolders = useFolderStore(current => current.loadFolders)
  const loadLibrary = useLibraryStore(current => current.loadLibrary)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const { controls, setControls } = state
  const protocol = useProviderProtocolStore(current => model ? current.protocols[model.provider_id] || 'openai-chat' : 'openai-chat')
  const { capabilities } = useModelCapabilities(model?.provider_id, model?.model_name, protocol)
  const composer = useComposerTextarea(state.draft, 54)
  const bottom = useRef<HTMLDivElement>(null)
  const busy = Boolean(state.busy) || state.session?.status === 'executing' || state.session?.status === 'undoing'
  const pendingMessage = state.messages.find(message => message.phase === 'pending')
  const pending = Boolean(pendingMessage)
  const target = state.session?.scope
  const targetLabel = target?.kind === 'folder' ? `${target.folder_name || getFolderName(folders, target.folder_id || 'default')} · ${target.target_count} 篇` : target?.kind === 'selected' ? `指定笔记 · ${target.target_count} 篇` : target?.authorized ? `整个笔记库 · ${target.target_count} 篇` : '尚未明确整理对象'
  const statusNames = { idle: '可以开始对话', planning: '正在理解需求', executing: '正在执行操作', undoing: '正在撤销操作', clarification: '需要补充信息', refused: '等待调整需求', awaiting_approval: '等待确认计划', completed: '本轮已完成', cancelled: '已停止，可继续对话', failed: '请求未完成', interrupted: '上次处理已中断' }

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true); setCatalogError(null)
    try {
      const [notes] = await Promise.all([listNotes(), loadFolders(), loadLibrary()])
      useTaskStore.setState({ tasks: notes })
    }
    catch { setCatalogError('笔记库读取失败，请重试后再提交指令。') }
    finally { setCatalogLoading(false) }
  }, [loadFolders, loadLibrary])
  useEffect(() => { void loadCatalog() }, [loadCatalog]) // Initial catalog read never changes note data.
  useEffect(() => {
    const initialize = () => { void useOrganizerStore.getState().initialize() }
    initialize()
    window.addEventListener('focus', initialize)
    return () => window.removeEventListener('focus', initialize)
  }, [])
  useEffect(() => {
    if (!state.busy && !['planning', 'executing', 'undoing'].includes(state.session?.status || '')) return
    const timer = window.setInterval(() => { void useOrganizerStore.getState().refresh() }, 1200)
    return () => window.clearInterval(timer)
  }, [state.busy, state.session?.status])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end', behavior: scrollMotion() }) }, [state.messages, state.busy, state.error])
  const refreshAfterChange = async () => {
    setCatalogLoading(true)
    try {
      const folderData = await getNoteFolders()
      useFolderStore.setState({ ...folderData, loadState: 'ready', errorMessage: null })
      const [notes] = await Promise.all([listNotes(), loadLibrary()])
      useTaskStore.setState({ tasks: notes })
      setCatalogError(null)
    } catch { setCatalogError('操作已由后端确认，但笔记库刷新失败。请重试刷新以核对当前状态。') }
    finally { setCatalogLoading(false) }
  }
  const send = (override?: string) => {
    const instruction = (override ?? state.draft).trim()
    if (!instruction || !model || busy || state.session?.status === 'planning') return
    // This page searches the library; a saved web toggle must not enable hidden network search.
    void state.send({ instruction, ...settingsForModel({ ...controls, web_search: false, web_search_mode: undefined }, model.model_name, capabilities?.available_efforts || ['auto']), protocol, provider_id: model.provider_id, model_name: model.model_name, scope: { kind: 'all' } }, '整个资料库')
  }
  const slash = useCompactCommand(state.draft, busy || state.session?.status === 'planning', () => send('/compact'))
  const perform = async (message: OrganizerMessage, undo = false) => {
    if (await (undo ? state.undo(message.id) : state.execute(message.id))) await refreshAfterChange()
  }
  const noteTitle = (plan: OrganizerPlan, id: string) => plan.notes?.find(note => note.id === id)?.title || tasks.find(task => task.id === id)?.audioMeta?.title || `笔记 ${id}`
  const folderTitle = (plan: OrganizerPlan, id?: string) => plan.operations.find(operation => operation.type === 'create_folder' && operation.ref === id)?.name || plan.folders?.find(folder => folder.id === id)?.name || folders.find(folder => folder.id === id)?.name || (id === 'default' ? '默认文件夹' : id || '未指定目标')
  const disabled = busy || state.session?.status === 'planning' || !model || !state.draft.trim()

  return <main className={`organizer-page ${!state.messages.length ? 'organizer-page--empty' : ''}`}>
    <header className="organizer-topbar">
      <span className="organizer-title"><FolderInput size={16} />资料库助手</span>
      <ChoiceSelect className="organizer-session-select" label="整理会话" value={state.session?.session_id || ''} disabled={busy} onChange={id => { if (id) void state.restore(id) }} options={[{ value: '', label: '选择历史对话' }, ...state.sessions.map(session => ({ value: session.session_id, label: `${session.history.find(item => item.role === 'user')?.content.slice(0, 22) || '新对话'} · ${new Date(session.updated_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` }))]} />
      <button className="organizer-text-button" onClick={() => void state.clear()} disabled={busy || !state.messages.length}><MessageSquare size={14} />新对话</button>
    </header>
    {!!state.messages.length && <div className="organizer-current-target"><span title={`当前目标：${targetLabel}`}>{target?.authorized ? targetLabel : '对话'}{target?.exclude_favorites && ' · 排除收藏'}</span><span>{state.busy === 'compacting' ? '压缩中' : state.busy === 'loading' ? '读取中' : state.session ? statusNames[state.session.status] : ''}</span></div>}
    {state.compactNotice && <div className="organizer-current-target" role="status">{state.compactNotice}</div>}
    {state.session?.status === 'interrupted' && <aside className="organizer-pending-summary" role="status"><span>上次处理已中断，恢复后可继续对话；不会自动执行计划。</span><button disabled={busy} onClick={() => void state.recover()}><RotateCcw size={13} />恢复对话</button></aside>}
    {pendingMessage && <aside className="organizer-pending-summary" aria-label="待确认计划"><div><strong title="核对计划后执行；输入新要求可修改计划">待确认 · {pendingMessage.plan!.operations.length} 项操作</strong></div><div><button onClick={() => document.getElementById(`organizer-plan-${pendingMessage.id}`)?.scrollIntoView({ block: 'start', behavior: scrollMotion() })}>详情</button><button disabled={busy} onClick={() => void state.cancel(pendingMessage.id)}>取消</button><button className="organizer-primary" disabled={busy} onClick={() => void perform(pendingMessage)}><Check size={13} />确认执行</button></div></aside>}
    <section className="organizer-thread" aria-label="资料库对话" aria-live="polite">
      <div className="organizer-thread-inner">
        {!state.messages.length && <div className="organizer-welcome">
          <h1>查找、理解与整理资料</h1>
          <div className="organizer-suggestions">{suggestions.map(text => <button key={text} disabled={busy} onClick={() => state.setDraft(text)}>{text}<ArrowUp size={13} /></button>)}</div>
        </div>}
        {state.messages.map(message => <article className={`organizer-message organizer-message--${message.role}`} key={message.id}>
          {message.scopeLabel && <div className="organizer-message-scope" aria-label="本轮整理范围">{message.scopeLabel}</div>}
          <p className="organizer-message-text">{message.text}</p>
          {!!message.sources?.length && <SourceList sources={message.sources} />}
          {message.phase === 'superseded' && <div className="organizer-result">旧计划已被后续需求替代，不能再执行。</div>}
          {message.plan?.query_note_ids?.length ? <ul className="organizer-query-results">{message.plan.query_note_ids.map(id => <li key={id}>{noteTitle(message.plan!, id)}</li>)}</ul> : null}
          {message.plan && message.plan.operations.length > 0 && <div className="organizer-plan" id={`organizer-plan-${message.id}`}>
            <div className="organizer-plan-heading"><span>整理计划</span><span>{message.plan.operations.length} 项操作 · 影响 {new Set(message.plan.operations.flatMap(operation => operation.task_ids || [])).size} 篇笔记</span></div>
            <ol>{message.plan.operations.map((operation, index) => <li key={index}>
              <div className="organizer-operation-title"><span className="organizer-operation-number">{index + 1}</span>{actionNames[operation.type]}</div>
              {operation.type === 'create_folder' && <p>新文件夹：{operation.name}</p>}
              {operation.type === 'rename_folder' && <p>{folderTitle(message.plan!, operation.folder_id)} → {operation.name}</p>}
              {operation.task_ids?.length ? <ul className="organizer-note-titles">{operation.task_ids.map(id => <li key={id}>{noteTitle(message.plan!, id)}</li>)}</ul> : null}
              {operation.type === 'move_notes' && <p className="organizer-operation-target">目标文件夹：{folderTitle(message.plan!, operation.folder_id)}</p>}
              {operation.type === 'set_tags' && <p className="organizer-operation-target">新标签：{operation.tags?.length ? operation.tags.join('、') : '清空标签'}</p>}
              {operation.type === 'archive' && <p className="organizer-operation-target">移入归档区，可恢复</p>}
              {operation.type === 'restore' && <p className="organizer-operation-target">从归档区恢复到笔记库</p>}
            </li>)}</ol>
            {message.phase === 'pending' && <div className="organizer-plan-footer"><span>确认以上笔记与目标后执行；也可继续输入修改。</span><div><button disabled={busy} onClick={() => void state.cancel(message.id)}><X size={13} />取消计划</button><button className="organizer-primary" disabled={busy} onClick={() => void perform(message)}>{state.busy === 'executing' ? <Loader2 className="organizer-spin" size={13} /> : <Check size={13} />}确认执行</button></div></div>}
            {message.phase === 'cancelled' && <div className="organizer-result">计划已取消，未执行。</div>}
            {message.phase === 'executed' && <div className="organizer-result"><Check size={14} /><span>已按这份计划完成修改。</span>{message.result?.undo_available && <button disabled={busy || pending} onClick={() => void perform(message, true)}><RotateCcw size={13} />撤销这次操作</button>}</div>}
            {message.phase === 'undone' && <div className="organizer-result"><RotateCcw size={14} />已撤销这次修改，笔记库已恢复。</div>}
          </div>}
        </article>)}
        {(state.busy || state.session?.status === 'planning') && <div className="organizer-working" role="status"><Loader2 size={14} className="organizer-spin" />{state.busy === 'compacting' ? '正在压缩上下文…' : state.busy === 'executing' ? '正在执行已确认计划…' : state.busy === 'undoing' ? '正在撤销操作…' : state.busy === 'loading' ? '正在读取会话…' : state.busy === 'cancelling' ? '正在停止处理…' : '正在理解需求并核对整理对象…'}</div>}
        {state.error && <div className="organizer-error" role="alert">{state.error}{state.errorDetails && <details className="organizer-error-details"><summary>查看错误详情</summary><dl><dt>类别</dt><dd>{state.errorDetails.kind}</dd><dt>HTTP 状态</dt><dd>{state.errorDetails.http_status ?? '未提供'}</dd><dt>供应商代码</dt><dd>{state.errorDetails.upstream_code || '未提供'}</dd><dt>请求 ID</dt><dd>{state.errorDetails.request_id || '未提供'}</dd><dt>协议</dt><dd>{state.errorDetails.protocol}</dd><dt>时间</dt><dd>{state.errorDetails.occurred_at}</dd></dl><p>{state.errorDetails.detail}</p></details>}</div>}
        <div ref={bottom} />
      </div>
    </section>
    <div className="organizer-compose-area">
      <div className="organizer-compose-inner">
        {catalogError && <div className="organizer-error" role="alert">{catalogError}<button disabled={busy || catalogLoading} onClick={() => void loadCatalog()}>重新读取</button></div>}
        {!model && <div className="organizer-config-hint">选择资料库助手模型后即可对话。<Link to="/settings/model">前往模型设置</Link></div>}
        <div className="organizer-composer">
          <SlashCommandMenu open={slash.open} id={slash.id} onSelect={slash.select} />
          <textarea ref={composer} aria-controls={slash.open ? slash.id : undefined} aria-activedescendant={slash.open ? `${slash.id}-compact` : undefined} onBlur={slash.dismiss} aria-label="资料库问题或整理指令" maxLength={4000} placeholder={pending ? '继续修改计划…' : '询问资料、比较方法或整理笔记…'} value={state.draft} onChange={event => state.setDraft(event.target.value)} onKeyDown={event => { if (slash.onKeyDown(event)) return; if (shouldSendMessage(event, useInterfaceStore.getState().sendKey)) { event.preventDefault(); send() } }} rows={1} />
          <div className="organizer-compose-toolbar">
            <AIControls modelPicker={<PurposeModelPicker inline value={model} onChange={state.setModel} label="整理模型" disabled={busy} controls={controls} onControlsChange={setControls} />} modelName={model?.model_name} value={controls} context={state.session?.context || undefined} draft={state.draft} />
            {(state.busy === 'planning' || state.busy === 'compacting' || state.session?.status === 'planning') && state.session ? <button className="organizer-send" aria-label="停止整理处理" title="停止当前处理" onClick={() => void state.cancel()}><X size={17} /></button> : <button className="organizer-send" aria-label="发送整理指令" title={sendShortcutLabel(sendKey)} disabled={disabled} onClick={() => send()}>{busy ? <Loader2 size={17} className="organizer-spin" /> : <ArrowUp size={18} />}</button>}
          </div>
        </div>
      </div>
    </div>
    <OrganizerRetentionDialog preview={state.retentionPreview} busy={Boolean(state.busy)} error={state.error} onCancel={state.cancelCreation} onConfirm={() => void state.confirmCreation()} />
  </main>
}
