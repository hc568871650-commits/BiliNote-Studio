import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Plus, Trash2, Check, Eye, EyeOff } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProviderStore } from '@/store/providerStore'
import { addModel, fetchEnableModelById, fetchModels, deleteModelById, testConnection } from '@/services/model'
import type { IProvider } from '@/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import ChoiceSelect from '@/components/ChoiceSelect'
import { isTranscriptionModel } from '@/utils/modelCapabilities'
import { classifyProvider, newProviderEnabled, providerPresets, selectProviderPreset } from '@/utils/providerProfiles'
import { providerProtocolOptions, useProviderProtocolStore, type ProviderProtocol } from '@/store/providerProtocolStore'

type Draft = Pick<IProvider, 'name' | 'apiKey' | 'baseUrl' | 'type'>
type EnabledModel = { id: number; model_name: string }
const emptyDraft = (): Draft => ({ name: '', apiKey: '', baseUrl: '', type: 'custom' })
// Unsaved credentials exist only in memory and never in browser persistence.
const drafts = new Map<string, Draft>()

export default function ProviderForm({ isCreate = false }: { isCreate?: boolean }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const key = isCreate ? 'new' : id || 'none'
  const [draft, setDraft] = useState<Draft>(drafts.get(key) || emptyDraft())
  const [builtIn, setBuiltIn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [modelName, setModelName] = useState('')
  const [models, setModels] = useState<EnabledModel[]>([])
  const [testModel, setTestModel] = useState('')
  const [options, setOptions] = useState<string[]>([])
  const [removeModel, setRemoveModel] = useState<EnabledModel | null>(null)
  const [customEditing, setCustomEditing] = useState(false)
  const [presetId, setPresetId] = useState('')
  const [protocol, setProtocol] = useState<ProviderProtocol>('openai-chat')
  const setProtocolPreference = useProviderProtocolStore(state => state.setProtocol)
  const profile = classifyProvider(isCreate ? presetId : id, draft.baseUrl)
  const urlReadOnly = profile.kind === 'official' && !customEditing
  const loadProviderById = useProviderStore(state => state.loadProviderById)
  const addNewProvider = useProviderStore(state => state.addNewProvider)
  const updateProvider = useProviderStore(state => state.updateProvider)
  const reloadModels = async () => { if (id) setModels(await fetchEnableModelById(id) as unknown as EnabledModel[]) }
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
          if (provider && id && !useProviderProtocolStore.getState().protocols[id] && provider.baseUrl.replace(/\/+$/, '') === 'https://api.anthropic.com') setProtocol('anthropic')
          setDraft(drafts.get(key) || (provider ? { name: provider.name, apiKey: provider.apiKey, baseUrl: provider.baseUrl, type: provider.type } : emptyDraft()))
          setBuiltIn(provider?.type === 'built-in'); setModels(enabled); setOptions([]); setModelName(''); setTestModel(enabled[0]?.model_name || '')
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
        setProtocolPreference(newId, protocol)
        drafts.delete(key); navigate(`/settings/model/${newId}`)
      } else if (id) {
        await updateProvider({ ...draft, id })
        setProtocolPreference(id, protocol)
        drafts.delete(key); setSaved(true)
      }
      toast.success('服务商配置已保存')
    } catch { /* Request layer displays the exact failure. */ }
    finally { setBusy(false) }
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try { await action() } catch { /* Request layer displays the exact failure. */ }
    finally { setBusy(false) }
  }
  if (loading) return <div className="settings-page">加载服务商配置…</div>
  if (error) return <div className="settings-page">无法加载配置，请切换分类后重试。</div>
  return <article className="settings-page">
    <header className="settings-page-header"><h1>{isCreate ? '添加模型服务商' : draft.name || '服务商配置'}</h1><p>保存连接配置后，启用用于笔记生成、阅读问答和整理助手的模型。语音模型请在音频转写中管理。</p></header>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <section className="settings-card">
        {isCreate && <div className="settings-field"><label>连接预设</label><ChoiceSelect label="连接预设" value={presetId} options={[{ value: '', label: '自定义连接' }, ...providerPresets.map(preset => ({ value: preset.id, label: preset.name }))]} onChange={value => {
          const selection = selectProviderPreset(draft, value)
          setPresetId(value); setCustomEditing(selection.customEditing)
          setDraft(selection.draft); drafts.set(key, selection.draft)
          if (selection.protocol) setProtocol(selection.protocol)
          setSaved(false)
        }} /><small>预设仅填充名称和默认地址，密钥保持不变。新建连接默认禁用，配置后需自行启用。Qwen 密钥与模型按区域分别管理，请选择密钥对应的北京或新加坡入口；工作空间专属地址可转为自定义编辑后填写。</small></div>}
        <div className="settings-field"><label htmlFor="provider-name">服务商名称</label><input id="provider-name" value={draft.name} disabled={builtIn} onChange={event => change('name', event.target.value)} placeholder="例如：我的模型服务" /></div>
        <div className="settings-field"><label htmlFor="provider-url">API 地址 · {customEditing && profile.kind === 'official' ? '自定义编辑' : profile.label}</label><input id="provider-url" value={draft.baseUrl} readOnly={urlReadOnly} onChange={event => change('baseUrl', event.target.value)} placeholder="https://example.com/v1" /><small>{profile.hostname ? `实际域名：${profile.hostname}。` : '请填写完整的 HTTP API 地址。'} 分类依据实际地址，不代表已经验证可用。</small>{urlReadOnly && <button type="button" className="settings-button" onClick={() => setCustomEditing(true)}>转为自定义编辑</button>}{customEditing && <small>地址修改在保存后生效；不会自动恢复官方地址。</small>}</div>
        <div className="settings-field"><label htmlFor="provider-key">API 密钥</label><div className="settings-key-input"><input id="provider-key" type={showKey ? 'text' : 'password'} autoComplete="off" value={draft.apiKey} onChange={event => change('apiKey', event.target.value)} placeholder="输入 API 密钥" /><button type="button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><small>已有密钥以掩码显示，保持不变即可沿用。未保存的修改只保留在本次会话内。</small></div>
        <div className="settings-field"><label>阅读聊天协议</label><ChoiceSelect label="阅读聊天协议" value={protocol} options={providerProtocolOptions} onChange={value => { setProtocol(value as ProviderProtocol); setSaved(false) }} /><small>仅影响阅读问答及其上下文压缩，不影响视频笔记生成。请按服务商实际支持的协议选择；此选择不代表连接测试通过，保存配置后生效。</small></div>
      </section>
      <div className="settings-actions"><button className="settings-button is-primary" disabled={busy} type="submit">{busy ? '处理中…' : '保存配置'}</button>{saved && <span className="settings-saved"><Check size={14} />已保存</span>}</div>
    </form>
    {!isCreate && <>
      <h2 className="settings-section-title">连接与模型测试</h2>
      <section className="settings-card"><div className="settings-row"><div><h2>测试生成模型连接（Chat Completions）</h2><p>使用保存后的地址、密钥和所选模型发出一条真实请求，可能产生少量 API 用量。最多等待约 60 秒。此测试不验证所选阅读聊天协议。</p></div><ChoiceSelect label="连接测试模型" value={models.some(model => model.model_name === testModel) ? testModel : ''} onChange={setTestModel} disabled={busy || !models.length} options={[{value:'',label:'请选择已添加模型'}, ...models.map(model => ({value:model.model_name,label:model.model_name}))]} /></div><div className="settings-row"><div><p>{models.length ? '选择后点击测试；只有收到可显示的模型回复才判定成功。' : '请先在下方添加聊天模型；音频转写模型在音频设置中测试。'}</p></div><button className="settings-button" disabled={busy || !models.some(model => model.model_name === testModel)} type="button" onClick={() => { if (drafts.has(key)) { toast.error('请先保存配置再测试'); return }; void run(async () => { await testConnection({ id, model:testModel }); toast.success(`${testModel} 生成模型连接测试成功`) }) }}>测试生成连接</button></div></section>
      <h2 className="settings-section-title">可用模型</h2>
      <section className="settings-card">
        <div className="settings-row"><div><h2>添加模型</h2><p>支持从服务商加载，也可直接输入完整模型名称。</p></div><button className="settings-button" disabled={busy} onClick={() => void run(async () => {
          const result = await fetchModels(id!) as unknown as { models?: { id: string }[] | { data: { id: string }[] } }
          const list = Array.isArray(result.models) ? result.models : result.models?.data || []
          setOptions(list.map(model => model.id).filter(name => !isTranscriptionModel(name)))
          if (!list.length) toast('未返回模型列表，可手动输入模型名称')
        })}>加载模型列表</button></div>
        <div className="settings-model-add"><input aria-label="模型名称" placeholder="输入完整模型名称" value={modelName} onChange={event => setModelName(event.target.value)} />{options.length > 0 && <ChoiceSelect label="从列表选择模型" value={options.includes(modelName) ? modelName : ''} onChange={setModelName} disabled={busy} options={[{ value: '', label: '从列表选择' }, ...options.map(name => ({ value: name, label: name }))]} />}<button className="settings-button" disabled={busy || !modelName.trim()} onClick={() => { if (isTranscriptionModel(modelName)) { toast.error('语音模型请在音频转写设置中管理'); return }; void run(async () => { await addModel({ provider_id: id!, model_name: modelName.trim() }); await reloadModels(); setModelName(''); toast.success('模型已添加') }) }}><Plus size={14} />添加</button></div>
        <p className="settings-footnote">语音转写模型不会出现在其他 AI 用途中。<Link className="settings-link" to="/settings/transcriber">管理音频转写 →</Link></p>
        <div className="settings-model-list">{models.length ? models.map(model => <div key={model.id}><span>{model.model_name}</span><button title="移除可用模型" aria-label={`移除模型 ${model.model_name}`} disabled={busy} onClick={() => setRemoveModel(model)}><Trash2 size={14} /></button></div>) : <p className="settings-muted">尚未添加模型。</p>}</div>
      </section>
    </>}
    <Dialog open={Boolean(removeModel)} onOpenChange={open => { if (!open && !busy) setRemoveModel(null) }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader><DialogTitle>移除可用模型？</DialogTitle><DialogDescription>将移除 {removeModel?.model_name}。已使用此模型的用途或会话需要重新选择模型，笔记内容不会改变。</DialogDescription></DialogHeader>
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setRemoveModel(null)}>取消</Button><Button type="button" variant="destructive" disabled={busy} onClick={() => { if (removeModel) void run(async () => { await deleteModelById(removeModel.id); await reloadModels(); setRemoveModel(null) }) }}>{busy ? '移除中…' : '确认移除'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </article>
}
