import ChoiceSelect from '@/components/ChoiceSelect'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { fetchEnableModels } from '@/services/model'
import { useProviderStore } from '@/store/providerStore'
import type { PurposeModelSelection } from '@/store/purposeModelStore'
import './purpose-model.css'
import { isTranscriptionModel } from '@/utils/modelCapabilities'
import { settingsForModel, type AISettings, type ReasoningEffort } from '@/utils/aiSettings'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import { useProviderProtocolStore } from '@/store/providerProtocolStore'

interface EnabledModel extends PurposeModelSelection { id: string }
interface Props {
  value: PurposeModelSelection | null
  onChange: (selection: PurposeModelSelection | null) => void
  label?: string
  compact?: boolean
  inline?: boolean
  disabled?: boolean
  controls?: AISettings
  onControlsChange?: (value: AISettings) => void
  reasoningModel?: string
}
const identity = (model: PurposeModelSelection) => JSON.stringify([String(model.provider_id), model.model_name])
let modelCache: { at: number; models: EnabledModel[] } | undefined
let pendingModels: Promise<EnabledModel[]> | undefined
const loadModels = () => {
  if (modelCache && Date.now() - modelCache.at < 15000) return Promise.resolve(modelCache.models)
  if (!pendingModels) pendingModels = fetchEnableModels().then(models => {
    const list = models as EnabledModel[]
    modelCache = { at: Date.now(), models: list }
    return list
  }).finally(() => { pendingModels = undefined })
  return pendingModels
}
const effortLabels: Record<ReasoningEffort, string> = { auto: '自动', none: '关闭', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' }

export default function PurposeModelPicker({ value, onChange, label = '模型', compact = false, inline = false, disabled = false, controls, onControlsChange, reasoningModel }: Props) {
  const protocol = useProviderProtocolStore(state => state.protocols[value?.provider_id || ''] || 'openai-chat')
  const { capabilities } = useModelCapabilities(controls ? value?.provider_id : undefined, controls ? value?.model_name : undefined, protocol)
  const efforts = (capabilities?.available_efforts || ['auto']).filter((item): item is ReasoningEffort => item in effortLabels)
  const providers = useProviderStore(state => state.provider)
  const fetchProviders = useProviderStore(state => state.fetchProviderList)
  const [models, setModels] = useState<EnabledModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ right: 12, bottom: 50 })
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const load = useCallback(async () => {
    setLoading(true); setError(false)
    try {
      const list = await loadModels()
      setModels(Array.isArray(list) ? list : [])
    } catch { setError(true) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (!providers.length) void fetchProviders().catch(() => { /* Request layer reports the error. */ }) }, [fetchProviders, providers.length])
  const options = models.filter(model => {
    if (isTranscriptionModel(model.model_name)) return false
    const provider = providers.find(item => String(item.id) === String(model.provider_id))
    return !provider || Boolean(provider.enabled)
  }).filter((model, index, all) => all.findIndex(item => identity(item) === identity(model)) === index)
  const selected = value ? identity(value) : ''
  const notListed = Boolean(value && !options.some(model => identity(model) === selected))
  const missing = !loading && !error && notListed
  const close = useCallback(() => { setOpen(false); trigger.current?.focus() }, [])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    const reposition = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    ;(menu.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]') || menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus()
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true) }
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const status = error ? '加载失败，点击重试' : missing ? '模型已不可用，请重新选择' : !loading && !options.length ? '暂无可用模型' : ''
  const effort = controls ? settingsForModel(controls, reasoningModel ?? value?.model_name, efforts) : undefined
  if (inline) return <div className="purpose-model-picker is-inline">
    <button ref={trigger} type="button" className="purpose-model-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled} title={status || [value?.model_name, effort && `思考：${effortLabels[effort.reasoning_effort]}`].filter(Boolean).join(' · ')} onClick={() => {
      if (open) { close(); return }
      const rect = trigger.current!.getBoundingClientRect()
      setPosition({ right: Math.max(12, Math.min(window.innerWidth - rect.right, window.innerWidth - 292)), bottom: Math.max(12, window.innerHeight - rect.top + 6) })
      setOpen(true); void load()
    }}><span>{value?.model_name || (loading ? '加载中…' : '选择模型')}</span><ChevronDown size={12} /></button>
    {open && createPortal(<div ref={menu} id={menuId} className="purpose-model-menu" role="dialog" aria-label={`${label}与思考等级`} style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) {
        const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        if (!buttons.length) return
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1) + buttons.length) % buttons.length
        event.preventDefault(); buttons[next].focus()
      }
    }}>
      <div className="purpose-model-menu-list" role="radiogroup" aria-label={label}>
        {options.map(option => <button type="button" role="radio" aria-checked={identity(option) === selected} key={identity(option)} onClick={() => { onChange({ provider_id: String(option.provider_id), model_name: option.model_name }); close() }}>
          <span><strong>{option.model_name}</strong><small>{providers.find(provider => String(provider.id) === String(option.provider_id))?.name || '服务商'}</small></span>{identity(option) === selected && <Check size={14} />}
        </button>)}
      </div>
      {status && <div className="purpose-model-menu-status">{status}{error && <button onClick={() => void load()}>重试</button>}</div>}
      {effort && onControlsChange && <div className="purpose-model-effort"><span>思考等级</span><div role="radiogroup" aria-label="思考等级">{efforts.map(item => <button type="button" role="radio" aria-checked={effort.reasoning_effort === item} key={item} onClick={() => onControlsChange({ ...effort, reasoning_effort: item })}>{effortLabels[item]}</button>)}</div>{efforts.length === 1 && <small>请在服务商设置中测试该模型的思考能力。</small>}</div>}
    </div>, document.body)}
  </div>
  return <div className={`purpose-model-picker ${compact ? 'is-compact' : ''} ${inline ? 'is-inline' : ''}`}>
    <div className="purpose-model-field"><span className="purpose-model-label">{label}</span><ChoiceSelect label={label} value={selected} disabled={loading || disabled} displayValue={!value ? loading ? '加载中…' : '选择模型' : undefined} onChange={value => {
      const model = options.find(option => identity(option) === value)
      onChange(model ? { provider_id: String(model.provider_id), model_name: model.model_name } : null)
    }} options={[
      ...(notListed ? [{ value: selected, label: `${value!.model_name}${missing ? '（配置已不可用）' : ''}`, disabled: true }] : []),
      ...options.map(model => ({ value: identity(model), label: `${model.model_name} · ${providers.find(provider => String(provider.id) === String(model.provider_id))?.name || '服务商'}` })),
    ]} /></div>
    {error ? <button type="button" onClick={() => void load()}>加载失败，重试</button> : !loading && !options.length ? <small>请先在模型服务商中添加并启用模型。</small> : missing ? <small>请重新选择可用模型，不会自动切换其他模型。</small> : null}
  </div>
}
