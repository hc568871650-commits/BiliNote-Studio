import ModelCapabilitiesPanel from '@/components/ModelCapabilitiesPanel'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Plus, Trash2, Check, Eye, EyeOff, RefreshCw, Save, SlidersHorizontal, Zap, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useProviderStore } from '@/store/providerStore'
import {
  addModel,
  addModelsBatch,
  deleteModelById,
  deleteModelsBatch,
  fetchEnableModelById,
  fetchModels,
  testConnection,
  updateModelFull,
} from '@/services/model'
import type { IProvider } from '@/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import ChoiceSelect from '@/components/ChoiceSelect'
import { isTranscriptionModel } from '@/utils/modelCapabilities'
import { classifyProvider, newProviderEnabled, providerPresets, resolveProviderProtocol, selectProviderPreset } from '@/utils/providerProfiles'
import { providerProtocolOptions, useProviderProtocolStore, type ProviderProtocol } from '@/store/providerProtocolStore'
import { modelDisplayName } from '@/utils/modelDisplay'
import './api-settings.css'

type Draft = Pick<IProvider, 'name' | 'apiKey' | 'baseUrl' | 'type'>
type EnabledModel = { id: number; model_name: string; display_name?: string | null }
type ModelRowDraft = { model_name: string; display_name: string }
type PingState = 'idle' | 'testing' | 'ok' | 'err'

const emptyDraft = (): Draft => ({ name: '', apiKey: '', baseUrl: '', type: 'custom' })
// Unsaved credentials exist only in memory and never in browser persistence.
const drafts = new Map<string, Draft>()

const protocolChoiceLabels: Record<ProviderProtocol, string> = {
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
  gemini: 'Gemini 原生',
}

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
  const [rowDrafts, setRowDrafts] = useState<Record<number, ModelRowDraft>>({})
  const [selectedModelIds, setSelectedModelIds] = useState<number[]>([])
  const [pingStates, setPingStates] = useState<Record<number, PingState>>({})
  const [remoteOptions, setRemoteOptions] = useState<string[]>([])
  const [remoteFilter, setRemoteFilter] = useState('')
  const [remotePicked, setRemotePicked] = useState<string[]>([])
  const [removeModel, setRemoveModel] = useState<EnabledModel | null>(null)
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState(false)
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false)
  const [presetId, setPresetId] = useState('')
  const [protocol, setProtocol] = useState<ProviderProtocol>('openai-chat')
  const [savedProtocol, setSavedProtocol] = useState<ProviderProtocol>('openai-chat')

  const setProtocolPreference = useProviderProtocolStore(state => state.setProtocol)
  const loadProviderById = useProviderStore(state => state.loadProviderById)
  const addNewProvider = useProviderStore(state => state.addNewProvider)
  const updateProvider = useProviderStore(state => state.updateProvider)
  const deleteProvider = useProviderStore(state => state.deleteProvider)
  const profile = classifyProvider(isCreate ? presetId : id, draft.baseUrl)
  const canDeleteProvider = !isCreate && Boolean(id) && draft.type !== 'built-in'

  const reloadModels = async () => {
    if (!id) return
    const list = await fetchEnableModelById(id) as unknown as EnabledModel[]
    setModels(list)
    setSelectedModelIds(current => current.filter(mid => list.some(item => item.id === mid)))
    setRowDrafts(previous => Object.fromEntries(list.map(model => {
      const prev = previous[model.id]
      const storedName = model.model_name
      const storedDisplay = model.display_name || ''
      if (!prev) return [model.id, { model_name: storedName, display_name: storedDisplay }]
      return [model.id, {
        model_name: prev.model_name.trim() === storedName ? storedName : prev.model_name,
        display_name: prev.display_name.trim() === storedDisplay ? storedDisplay : prev.display_name,
      }]
    })))
  }

  useEffect(() => {
    let active = true
    setLoading(true); setError(false); setSaved(false); setPresetId('')
    setRemoteOptions([]); setRemotePicked([]); setRemoteFilter(''); setSelectedModelIds([]); setPingStates({})
    const load = async () => {
      try {
        const provider = !isCreate && id ? await loadProviderById(id) : null
        const enabled = !isCreate && id ? await fetchEnableModelById(id) as unknown as EnabledModel[] : []
        if (!active) return
        const nextDraft = drafts.get(key) || (provider ? { name: provider.name, apiKey: provider.apiKey, baseUrl: provider.baseUrl, type: provider.type } : emptyDraft())
        const resolvedProto = provider?.protocol
          || resolveProviderProtocol(nextDraft.baseUrl, id ? useProviderProtocolStore.getState().protocols[id] : undefined)
        setDraft(nextDraft)
        setProtocol(resolvedProto)
        setSavedProtocol(resolvedProto)
        setModels(enabled)
        setRowDrafts(Object.fromEntries(enabled.map(model => [model.id, { model_name: model.model_name, display_name: model.display_name || '' }])))
        setModelName(''); setNewDisplayName('')
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
        const newId = await addNewProvider({ ...draft, protocol, logo: 'custom', enabled: newProviderEnabled })
        setProtocolPreference(newId, protocol)
        drafts.delete(key)
        navigate(`/settings/model/${newId}`)
      } else if (id) {
        await updateProvider({ ...draft, protocol, id })
        setProtocolPreference(id, protocol)
        setSavedProtocol(protocol)
        drafts.delete(key)
        setSaved(true)
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

  const pingModel = async (model: EnabledModel) => {
    if (!id || drafts.has(key) || protocol !== savedProtocol) {
      toast('请先保存当前服务商连接配置')
      return
    }
    setPingStates(prev => ({ ...prev, [model.id]: 'testing' }))
    try {
      await testConnection({ id, model: model.model_name, protocol })
      setPingStates(prev => ({ ...prev, [model.id]: 'ok' }))
      toast.success(`${modelDisplayName(model)} 连通正常`)
    } catch {
      setPingStates(prev => ({ ...prev, [model.id]: 'err' }))
    }
  }

  const existingNames = useMemo(() => new Set(models.map(item => item.model_name)), [models])
  const filteredRemoteOptions = useMemo(() => {
    const q = remoteFilter.trim().toLowerCase()
    return q ? remoteOptions.filter(name => name.toLowerCase().includes(q)) : remoteOptions
  }, [remoteOptions, remoteFilter])

  const hasUnsavedProvider = drafts.has(key) || protocol !== savedProtocol

  if (loading) return <div className="settings-page api-settings">加载配置…</div>
  if (error) return <div className="settings-page api-settings" role="alert">无法加载配置，请重新打开。</div>

  return <article className="settings-page api-settings">
    <header className="api-page-header">
      <h1>{isCreate ? '添加服务商' : draft.name || 'API 配置'}</h1>
      <div className="api-header-actions">
        <span className="api-tag">{isCreate ? '新连接默认关闭' : { official: '官方预设', custom: '自定义', local: '本地', unconfigured: '待配置' }[profile.kind]}</span>
        {!isCreate && models.length > 0 && (
          <button
            type="button"
            className="settings-button"
            disabled={busy || hasUnsavedProvider}
            title={hasUnsavedProvider ? '请先保存服务商配置' : '展开高阶能力检测'}
            onClick={() => setCapabilitiesOpen(true)}
          >
            <SlidersHorizontal size={13} strokeWidth={1.6} />能力检测
          </button>
        )}
      </div>
    </header>

    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <section className="api-surface api-connection-grid" aria-label="连接配置">
        {isCreate && (
          <div className="api-field api-field-wide">
            <label>连接预设（可选，填入后仍可自由修改）</label>
            <ChoiceSelect
              label="连接预设"
              value={presetId}
              disabled={busy}
              options={[{ value: '', label: '自定义连接' }, ...providerPresets.map(preset => ({ value: preset.id, label: preset.name }))]}
              onChange={value => {
                const selection = selectProviderPreset(draft, value)
                setPresetId(value)
                setDraft(selection.draft)
                drafts.set(key, selection.draft)
                if (selection.protocol) setProtocol(selection.protocol)
                setSaved(false)
              }}
            />
          </div>
        )}
        <div className="api-field">
          <label htmlFor="provider-name">名称</label>
          <input id="provider-name" value={draft.name} disabled={busy} onChange={event => change('name', event.target.value)} placeholder="服务商名称" />
        </div>
        <div className="api-field">
          <label>调用协议（统一用于生成与问答）</label>
          <ChoiceSelect
            label="调用协议"
            value={protocol}
            disabled={busy}
            options={providerProtocolOptions.map(option => ({ ...option, label: protocolChoiceLabels[option.value] }))}
            onChange={value => { setProtocol(value as ProviderProtocol); setSaved(false) }}
          />
        </div>
        <div className="api-field api-field-wide">
          <label htmlFor="provider-url">API 地址</label>
          <div className="api-input-action">
            <input id="provider-url" value={draft.baseUrl} disabled={busy} onChange={event => change('baseUrl', event.target.value)} placeholder="https://example.com/v1" />
          </div>
        </div>
        <div className="api-field api-field-wide">
          <label htmlFor="provider-key">API Key（本机 DPAPI 加密存储）</label>
          <div className="api-input-action">
            <input id="provider-key" type={showKey ? 'text' : 'password'} autoComplete="off" value={draft.apiKey} disabled={busy} onChange={event => change('apiKey', event.target.value)} placeholder="API 密钥（留空或掩码表示保留现有密钥）" />
            <button type="button" className="api-icon-button" aria-label={showKey ? '隐藏密钥' : '显示密钥'} title={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}>
              {showKey ? <EyeOff size={15} strokeWidth={1.6} /> : <Eye size={15} strokeWidth={1.6} />}
            </button>
          </div>
        </div>
        <div className="api-save-row api-field-wide">
          <span className="api-muted">
            {saved ? <span className="api-saved"><Check size={13} />已保存</span> : hasUnsavedProvider ? '有未保存修改' : '支持 4 协议全场景调用'}
          </span>
          <div className="api-save-actions">
            {canDeleteProvider && (
              <button type="button" className="settings-button" disabled={busy} onClick={() => setConfirmDeleteProvider(true)}>
                <Trash2 size={13} strokeWidth={1.6} />删除服务商
              </button>
            )}
            <button className="settings-button is-primary" disabled={busy} type="submit">{busy ? '处理中…' : '保存'}</button>
          </div>
        </div>
      </section>
    </form>

    {!isCreate && (
      <section className="api-surface api-models" aria-label="可用模型">
        <div className="api-section-header">
          <h2>可用模型 <span>{models.length}</span></h2>
          <div className="api-section-tools">
            {selectedModelIds.length > 0 && (
              <button
                type="button"
                className="settings-button"
                disabled={busy}
                onClick={() => void run(async () => {
                  await deleteModelsBatch(selectedModelIds)
                  await reloadModels()
                  setSelectedModelIds([])
                  toast.success(`已移除 ${selectedModelIds.length} 个模型`)
                })}
              >
                <Trash2 size={13} strokeWidth={1.6} />批量移除 ({selectedModelIds.length})
              </button>
            )}
            <button
              type="button"
              className="settings-button"
              disabled={busy || hasUnsavedProvider}
              title={hasUnsavedProvider ? '请先保存服务商配置' : '拉取服务商模型列表'}
              onClick={() => void run(async () => {
                const result = await fetchModels(id!) as unknown as { models?: { id: string }[] | { data: { id: string }[] } }
                const list = Array.isArray(result.models) ? result.models : result.models?.data || []
                const names = list.map(model => model.id).filter(name => !isTranscriptionModel(name))
                setRemoteOptions(names)
                setRemotePicked([])
                if (!names.length) toast('未返回模型列表，可直接在下方手动添加')
              })}
            >
              <RefreshCw size={13} strokeWidth={1.6} />获取列表
            </button>
          </div>
        </div>

        <div className="api-model-table-head" aria-hidden="true">
          <span />
          <span>API 调用名</span>
          <span>展示名（可选）</span>
          <span />
        </div>

        <div className="api-model-list">
          {models.map(model => {
            const row = rowDrafts[model.id] || { model_name: model.model_name, display_name: model.display_name || '' }
            const dirty = row.model_name.trim() !== model.model_name || row.display_name.trim() !== (model.display_name || '')
            const ping = pingStates[model.id] || 'idle'
            const checked = selectedModelIds.includes(model.id)
            return (
              <div key={model.id} className="api-model-row">
                <input
                  type="checkbox"
                  className="api-model-checkbox"
                  aria-label={`选择模型 ${modelDisplayName(model)}`}
                  checked={checked}
                  disabled={busy}
                  onChange={event => setSelectedModelIds(prev => event.target.checked ? [...prev, model.id] : prev.filter(item => item !== model.id))}
                />
                <input
                  aria-label={`${model.model_name} API 调用名`}
                  placeholder="API 调用名"
                  maxLength={200}
                  value={row.model_name}
                  disabled={busy}
                  onChange={event => setRowDrafts(state => ({ ...state, [model.id]: { ...row, model_name: event.target.value } }))}
                />
                <input
                  aria-label={`${model.model_name} 展示名`}
                  placeholder={row.model_name || model.model_name}
                  maxLength={200}
                  value={row.display_name}
                  disabled={busy}
                  onChange={event => setRowDrafts(state => ({ ...state, [model.id]: { ...row, display_name: event.target.value } }))}
                />
                <div className="api-model-actions">
                  <button
                    type="button"
                    className={`api-ping-btn${ping === 'ok' ? ' is-ok' : ping === 'err' ? ' is-err' : ''}`}
                    title={`使用 ${protocolChoiceLabels[protocol]} 测试连通（真实请求）`}
                    disabled={busy || ping === 'testing' || hasUnsavedProvider || dirty}
                    onClick={() => void pingModel(model)}
                  >
                    {ping === 'testing' ? <Loader2 size={12} className="animate-spin" /> : ping === 'ok' ? <Check size={12} /> : <Zap size={12} strokeWidth={1.6} />}
                    <span>{ping === 'testing' ? '检测中' : ping === 'ok' ? '已连通' : ping === 'err' ? '失败' : '连通'}</span>
                  </button>
                  <button
                    type="button"
                    className="api-icon-button"
                    title="保存模型修改"
                    aria-label={`保存 ${model.model_name}`}
                    disabled={busy || !dirty || !row.model_name.trim()}
                    onClick={() => void run(async () => {
                      await updateModelFull({
                        id: model.id,
                        model_name: row.model_name.trim(),
                        display_name: row.display_name.trim() || null,
                      })
                      await reloadModels()
                      toast.success('模型配置已更新')
                    })}
                  >
                    <Save size={14} strokeWidth={1.6} />
                  </button>
                  <button
                    type="button"
                    className="api-icon-button api-icon-button--danger"
                    title="移除模型"
                    aria-label={`移除模型 ${modelDisplayName(model)}`}
                    disabled={busy}
                    onClick={() => setRemoveModel(model)}
                  >
                    <Trash2 size={14} strokeWidth={1.6} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="api-model-add">
          <input aria-label="模型 API 调用名" placeholder="输入新的 API 调用名" disabled={busy} value={modelName} onChange={event => setModelName(event.target.value)} />
          <input aria-label="模型展示名" placeholder="自定义展示名（可选）" maxLength={200} disabled={busy} value={newDisplayName} onChange={event => setNewDisplayName(event.target.value)} />
          <button
            type="button"
            className="settings-button"
            disabled={busy || !modelName.trim()}
            onClick={() => {
              if (isTranscriptionModel(modelName.trim())) { toast.error('语音模型请在音频转写设置中管理'); return }
              void run(async () => {
                await addModel({ provider_id: id!, model_name: modelName.trim(), display_name: newDisplayName.trim() || null })
                await reloadModels()
                setModelName(''); setNewDisplayName('')
                toast.success('模型已添加')
              })
            }}
          >
            <Plus size={13} strokeWidth={1.7} />添加
          </button>
        </div>

        {remoteOptions.length > 0 && (
          <div className="api-remote-picker" aria-label="批量选择远程模型">
            <div className="api-remote-picker-head">
              <input
                aria-label="筛选拉取的模型"
                placeholder={`筛选 ${remoteOptions.length} 个远程模型…`}
                value={remoteFilter}
                onChange={event => setRemoteFilter(event.target.value)}
              />
              <button
                type="button"
                className="settings-button is-primary"
                disabled={busy || !remotePicked.length}
                onClick={() => void run(async () => {
                  await addModelsBatch({
                    provider_id: id!,
                    models: remotePicked.map(name => ({ model_name: name })),
                  })
                  await reloadModels()
                  toast.success(`已批量加入 ${remotePicked.length} 个模型`)
                  setRemotePicked([])
                })}
              >
                加入已选 ({remotePicked.length})
              </button>
              <button type="button" className="settings-button" onClick={() => { setRemoteOptions([]); setRemotePicked([]) }}>收起</button>
            </div>
            <div className="api-remote-list">
              {filteredRemoteOptions.map(name => {
                const added = existingNames.has(name)
                const picked = remotePicked.includes(name)
                return (
                  <label key={name} className={`api-remote-item${added ? ' is-added' : ''}`}>
                    <input
                      type="checkbox"
                      className="api-model-checkbox"
                      disabled={added || busy}
                      checked={added || picked}
                      onChange={event => {
                        if (added) return
                        setRemotePicked(prev => event.target.checked ? [...prev, name] : prev.filter(item => item !== name))
                      }}
                    />
                    <span title={name}>{name}{added ? '（已添加）' : ''}</span>
                  </label>
                )
              })}
            </div>
          </div>
        )}

        <div className="api-model-footer">
          <span className="api-muted">{!models.length ? '可手动添加模型，或点击「获取列表」批量勾选加入。' : '行内可直接修改 API 调用名与展示名；连通测试使用当前所选协议。'}</span>
        </div>
      </section>
    )}

    <Dialog open={capabilitiesOpen} onOpenChange={setCapabilitiesOpen}>
      <DialogContent className="api-capability-dialog">
        <DialogHeader>
          <DialogTitle>高阶能力检测</DialogTitle>
          <DialogDescription>按需探测流式回复、看图、联网与工具调用（真实模型请求，可能计费）。</DialogDescription>
        </DialogHeader>
        {!isCreate && id && <ModelCapabilitiesPanel providerId={id} models={models} protocol={protocol} disabled={busy || hasUnsavedProvider} />}
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(removeModel)} onOpenChange={open => { if (!open && !busy) setRemoveModel(null) }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>移除可用模型？</DialogTitle>
          <DialogDescription>将移除 {removeModel ? modelDisplayName(removeModel) : ''}。已使用此模型的用途或会话需要重新选择模型，笔记内容不会改变。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setRemoveModel(null)}>取消</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => { if (removeModel) void run(async () => { await deleteModelById(removeModel.id); await reloadModels(); setRemoveModel(null) }) }}>{busy ? '移除中…' : '确认移除'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={confirmDeleteProvider} onOpenChange={open => { if (!open && !busy) setConfirmDeleteProvider(false) }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>删除自定义服务商？</DialogTitle>
          <DialogDescription>将永久删除「{draft.name || id}」及其已登记的全部可用模型，不影响已生成的笔记内容。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmDeleteProvider(false)}>取消</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => { if (id) void run(async () => { await deleteProvider(id); drafts.delete(key); setConfirmDeleteProvider(false); toast.success('自定义服务商已删除'); navigate('/settings/model', { replace: true }) }) }}>{busy ? '删除中…' : '确认删除'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </article>
}
