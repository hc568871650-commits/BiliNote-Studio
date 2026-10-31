import ModelCapabilitiesPanel from '@/components/ModelCapabilitiesPanel'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Plus, Trash2, Check, Eye, EyeOff, RefreshCw, Save } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProviderStore } from '@/store/providerStore'
import { addModel, fetchEnableModelById, fetchModels, deleteModelById, testConnection, updateModelDisplayName } from '@/services/model'
import type { IProvider } from '@/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import ChoiceSelect from '@/components/ChoiceSelect'
import { isTranscriptionModel } from '@/utils/modelCapabilities'
import { classifyProvider, newProviderEnabled, officialProviderProtocol, providerPresets, resolveProviderProtocol, selectProviderPreset } from '@/utils/providerProfiles'
import { providerProtocolOptions, useProviderProtocolStore, type ProviderProtocol } from '@/store/providerProtocolStore'
import { modelDisplayName } from '@/utils/modelDisplay'
import './api-settings.css'

type Draft = Pick<IProvider, 'name' | 'apiKey' | 'baseUrl' | 'type'>
type EnabledModel = { id: number; model_name: string; display_name?: string | null }
const emptyDraft = (): Draft => ({ name: '', apiKey: '', baseUrl: '', type: 'custom' })
// Unsaved credentials exist only in memory and never in browser persistence.
const drafts = new Map<string, Draft>()

export default function ProviderForm({ isCreate = false }: { isCreate?: boolean }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const key = isCreate ? 'new' : id || 'none'
  const [draft, setDraft] = useState<Draft>(drafts.get(key) || emptyDraft())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [modelName, setModelName] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [models, setModels] = useState<EnabledModel[]>([])
  const [displayNameDrafts, setDisplayNameDrafts] = useState<Record<number, string>>({})
  const [testModel, setTestModel] = useState('')
  const [options, setOptions] = useState<string[]>([])
  const [removeModel, setRemoveModel] = useState<EnabledModel | null>(null)
  const [customEditing, setCustomEditing] = useState(false)
  const [presetId, setPresetId] = useState('')
  const [protocolPreference, setProtocol] = useState<ProviderProtocol>('openai-chat')
  const setProtocolPreference = useProviderProtocolStore(state => state.setProtocol)
  const profile = classifyProvider(isCreate ? presetId : id, draft.baseUrl)
  const urlReadOnly = profile.kind === 'official' && !customEditing
  const fixedProtocol = !customEditing ? officialProviderProtocol(draft.baseUrl) : undefined
  const assistantOnly = officialProviderProtocol(draft.baseUrl) === 'anthropic'
  const protocol = fixedProtocol || protocolPreference
  const savedProtocol = resolveProviderProtocol(draft.baseUrl, id ? useProviderProtocolStore.getState().protocols[id] : undefined)
  const loadProviderById = useProviderStore(state => state.loadProviderById)
  const addNewProvider = useProviderStore(state => state.addNewProvider)
  const updateProvider = useProviderStore(state => state.updateProvider)
  const reloadModels = async () => {
    if (!id) return
    const list = await fetchEnableModelById(id) as unknown as EnabledModel[]
    setModels(list)
    // Saving one row must not discard edits in another row.
    setDisplayNameDrafts(previous => Object.fromEntries(list.map(model => {
      const stored = model.display_name || '', entered = previous[model.id]
      return [model.id, entered === undefined || entered.trim() === stored ? stored : entered]
    })))
  }
  useEffect(() => {
    let active = true
    setLoading(true); setError(false); setSaved(false)
    setCustomEditing(false); setPresetId('')
    setProtocol(!isCreate && id ? useProviderProtocolStore.getState().protocols[id] || 'openai-chat' : 'openai-chat')
    const load = async () => {
      try {
        const provider = !isCreate && id ? await loadProviderById(id) : null
        const enabled = !isCreate && id ? await fetchEnableModelById(id) as unknown as EnabledModel[] : []
        if (active) {
          setDraft(drafts.get(key) || (provider ? { name: provider.name, apiKey: provider.apiKey, baseUrl: provider.baseUrl, type: provider.type } : emptyDraft()))
          setModels(enabled); setDisplayNameDrafts(Object.fromEntries(enabled.map(model => [model.id, model.display_name || '']))); setOptions([]); setModelName(''); setNewDisplayName(''); setTestModel(enabled[0]?.model_name || '')
        }
      } catch { if (active) setError(true) }
      finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [id, isCreate, key, loadProviderById])
  const change = (field: keyof Draft, value: string) => {
    const next = { ...draft, [field]: value }
    setDraft(next); drafts.set(key, next); setSaved(false)
  }
  const save = async () => {
    if (draft.name.trim().length < 2) { toast.error('服务商名称至少 2 个字符'); return }
    try { const url = new URL(draft.baseUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error() } catch { toast.error('请输入有效的 HTTP API 地址'); return }
    setBusy(true)
    try {
      if (isCreate) {
        const newId = await addNewProvider({ ...draft, logo: 'custom', enabled: newProviderEnabled })
        setProtocolPreference(newId, resolveProviderProtocol(draft.baseUrl, protocol))
        drafts.delete(key); navigate(`/settings/model/${newId}`)
      } else if (id) {
        await updateProvider({ ...draft, id })
        setProtocolPreference(id, resolveProviderProtocol(draft.baseUrl, protocol))
        drafts.delete(key); setSaved(true)
      }
      window.dispatchEvent(new Event('user-save-provider'))
      toast.success('服务商配置已保存')
    } catch { /* Request layer displays the exact failure. */ }
    finally { setBusy(false) }
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try { await action() } catch { /* Request layer displays the exact failure. */ }
    finally { setBusy(false) }
  }
  if (loading) return <div className="settings-page api-settings">加载配置…</div>
  if (error) return <div className="settings-page api-settings" role="alert">无法加载配置，请重新打开。</div>
  return <article className="settings-page api-settings">
    <header className="api-page-header"><h1>{isCreate ? '添加服务商' : draft.name || 'API 配置'}</h1><span className="api-tag">{isCreate ? '新连接默认关闭' : { official: '官方预设地址', custom: '自定义', local: '本地', unconfigured: '待配置' }[profile.kind]}</span></header>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <section className="api-surface api-connection-grid" aria-label="连接配置">
        {isCreate && <div className="api-field api-field-wide"><label>连接预设</label><ChoiceSelect label="连接预设" value={presetId} disabled={busy} options={[{ value: '', label: '自定义连接' }, ...providerPresets.map(preset => ({ value: preset.id, label: preset.name }))]} onChange={value => {
          const selection = selectProviderPreset(draft, value)
          setPresetId(value); setCustomEditing(selection.customEditing)
          setDraft(selection.draft); drafts.set(key, selection.draft)
          if (selection.protocol) setProtocol(selection.protocol)
          setSaved(false)
        }} />{presetId.startsWith('qwen') && <small>密钥与模型须匹配所选区域。</small>}</div>}
        <div className="api-field"><label htmlFor="provider-name">名称</label><input id="provider-name" value={draft.name} disabled={busy} onChange={event => change('name', event.target.value)} placeholder="服务商名称" /></div>
        <div className="api-field"><label title="用于阅读和资料库助手；视频笔记生成使用 Chat Completions">助手协议{fixedProtocol ? ' · 固定' : ''}</label><ChoiceSelect label="助手调用协议" value={protocol} disabled={busy || Boolean(fixedProtocol)} options={providerProtocolOptions.map(option => ({ ...option, label: { 'openai-chat': 'Chat Completions', 'openai-responses': 'Responses', anthropic: 'Messages', gemini: 'Gemini 原生' }[option.value] }))} onChange={value => { setProtocol(value as ProviderProtocol); setSaved(false) }} /></div>
        <div className="api-field api-field-wide"><label htmlFor="provider-url">API 地址{urlReadOnly ? ' · 固定' : ''}</label><div className="api-input-action"><input id="provider-url" value={draft.baseUrl} readOnly={urlReadOnly} disabled={busy} onChange={event => change('baseUrl', event.target.value)} placeholder="https://example.com/v1" /></div></div>
        <div className="api-field api-field-wide"><label htmlFor="provider-key">API Key</label><div className="api-input-action"><input id="provider-key" type={showKey ? 'text' : 'password'} autoComplete="off" value={draft.apiKey} disabled={busy} onChange={event => change('apiKey', event.target.value)} placeholder="API 密钥" /><button type="button" className="api-icon-button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} title={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></div>
        <div className="api-save-row api-field-wide"><span className="api-muted">{saved ? <span className="api-saved"><Check size={13} />已保存</span> : drafts.has(key) || protocol !== savedProtocol ? '有未保存修改' : assistantOnly ? '助手专用' : '生成协议：Chat Completions'}</span><button className="settings-button is-primary" disabled={busy} type="submit">{busy ? '处理中…' : '保存'}</button></div>
      </section>
    </form>
    {!isCreate && <>
      <section className="api-surface api-models" aria-label="可用模型">
        <div className="api-section-header"><h2>模型 <span>{models.length}</span></h2><button type="button" className="settings-button" disabled={busy} onClick={() => void run(async () => {
          const result = await fetchModels(id!) as unknown as { models?: { id: string }[] | { data: { id: string }[] } }
          const list = Array.isArray(result.models) ? result.models : result.models?.data || []
          setOptions(list.map(model => model.id).filter(name => !isTranscriptionModel(name)))
          if (!list.length) toast('未返回模型列表，可手动输入模型名称')
        })}><RefreshCw size={13} />获取列表</button></div>
        <div className="api-model-table-head" aria-hidden="true"><span>API 调用名</span><span>展示名（留空使用调用名）</span><span /></div>
        <div className="api-model-list">{models.map(model => <div key={model.id} className="api-model-row"><code title={model.model_name}>{model.model_name}</code><input aria-label={`${model.model_name} 展示名`} placeholder={model.model_name} maxLength={200} value={displayNameDrafts[model.id] ?? ''} disabled={busy} onChange={event => setDisplayNameDrafts(state => ({ ...state, [model.id]: event.target.value }))} /><div className="api-model-actions"><button type="button" className="api-icon-button" title="保存展示名" aria-label={`保存 ${model.model_name} 展示名`} disabled={busy || (displayNameDrafts[model.id] ?? '') === (model.display_name || '')} onClick={() => void run(async () => { await updateModelDisplayName({ id: model.id, display_name: (displayNameDrafts[model.id] || '').trim() || null }); await reloadModels(); toast.success('展示名已保存') })}><Save size={14} /></button><button type="button" className="api-icon-button" title="移除模型" aria-label={`移除模型 ${modelDisplayName(model)}`} disabled={busy} onClick={() => setRemoveModel(model)}><Trash2 size={14} /></button></div></div>)}</div>
        <div className="api-model-row api-model-add"><input aria-label="模型 API 调用名" placeholder="输入 API 调用名" disabled={busy} value={modelName} onChange={event => setModelName(event.target.value)} /><input aria-label="模型展示名" placeholder="自定义展示名（可选）" maxLength={200} disabled={busy} value={newDisplayName} onChange={event => setNewDisplayName(event.target.value)} /><button type="button" className="settings-button" disabled={busy || !modelName.trim()} onClick={() => { if (isTranscriptionModel(modelName.trim())) { toast.error('语音模型请在音频转写设置中管理'); return }; void run(async () => { await addModel({ provider_id: id!, model_name: modelName.trim(), display_name: newDisplayName.trim() || null }); await reloadModels(); setModelName(''); setNewDisplayName(''); toast.success('模型已添加') }) }}><Plus size={13} />添加</button></div>
        {options.length > 0 && <div className="api-model-options"><ChoiceSelect label="从列表选择模型" value={options.includes(modelName) ? modelName : ''} onChange={setModelName} disabled={busy} options={[{ value: '', label: '选择服务商模型' }, ...options.map(name => ({ value: name, label: name }))]} /></div>}
        <div className="api-model-footer"><span className="api-muted">{!models.length ? '手动添加，或获取服务商列表' : '展示名只影响界面显示'}</span><Link className="settings-link" to="/settings/transcriber">转写模型 →</Link></div>
      </section>
      {!assistantOnly && <section className="api-surface api-test-connection" aria-label="生成连接测试"><div className="api-section-header"><h2>生成连接</h2><span className="api-muted">非流式 Chat · 真实请求，可能计费</span></div><div className="api-test-actions"><ChoiceSelect label="连接测试模型" value={models.some(model => model.model_name === testModel) ? testModel : ''} onChange={setTestModel} disabled={busy || drafts.has(key) || !models.length} options={[{value:'',label:'选择模型'}, ...models.map(model => ({value:model.model_name,label:modelDisplayName(model)}))]} /><button className="settings-button" disabled={busy || drafts.has(key) || !models.some(model => model.model_name === testModel)} type="button" title="仅测试非流式 Chat Completions；不验证助手协议、流式或联网，最多等待60秒" onClick={() => void run(async () => { await testConnection({ id, model:testModel }); toast.success(`${modelDisplayName(models.find(model => model.model_name === testModel) || { model_name: testModel })} 非流式 Chat 连接成功`) })}>测试连接</button></div></section>}
      <details className="api-surface api-capability-fold"><summary>能力检测<span>回复 · 流式 · 联网 · 工具</span></summary><ModelCapabilitiesPanel providerId={id!} models={models} protocol={protocol} disabled={busy || drafts.has(key) || protocol !== savedProtocol} /></details>
    </>}
    <Dialog open={Boolean(removeModel)} onOpenChange={open => { if (!open && !busy) setRemoveModel(null) }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader><DialogTitle>移除可用模型？</DialogTitle><DialogDescription>将移除 {removeModel ? modelDisplayName(removeModel) : ''}。已使用此模型的用途或会话需要重新选择模型，笔记内容不会改变。</DialogDescription></DialogHeader>
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setRemoveModel(null)}>取消</Button><Button type="button" variant="destructive" disabled={busy} onClick={() => { if (removeModel) void run(async () => { await deleteModelById(removeModel.id); await reloadModels(); setRemoveModel(null) }) }}>{busy ? '移除中…' : '确认移除'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </article>
}
