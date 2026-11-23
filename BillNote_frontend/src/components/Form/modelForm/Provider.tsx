import { useEffect, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import ProviderCard from '@/components/Form/modelForm/components/providerCard.tsx'
import PurposeModelPicker from '@/components/PurposeModelPicker'
import WebSearchControl from '@/components/WebSearchControl'
import WebSearchSettings from '@/components/WebSearchSettings'
import ModelContextSettings from '@/components/ModelContextSettings'
import { useProviderStore } from '@/store/providerStore'
import { usePurposeModelStore, type ModelPurpose } from '@/store/purposeModelStore'
import { useEffectiveProviderProtocol } from '@/hooks/useEffectiveProviderProtocol'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import { useModelWebSearchSettings } from '@/hooks/useModelWebSearchSettings'
import { defaultReadingSettings, type AISettings } from '@/utils/aiSettings'
import { classifyProvider } from '@/utils/providerProfiles'
import { isQuickEdition } from '@/utils/edition'
import './api-settings.css'

const purposes: { key: ModelPurpose; name: string; description: string; allowFollowPrimary?: boolean }[] = [
  { key: 'generation', name: '笔记生成', description: '新建笔记或重蒸馏时默认选用' },
  { key: 'reading', name: '阅读问答', description: '阅读助手默认对话模型' },
  { key: 'organizer', name: '资料库助手', description: '全库检索、对比与整理' },
  { key: 'translation', name: '字幕翻译', description: '外语双语字幕翻译；默认跟随主模型，可单独选免费或轻量模型', allowFollowPrimary: true },
]

const Provider = () => {
  const allProviders = useProviderStore(state => state.provider)
  const fetchProviderList = useProviderStore(state => state.fetchProviderList)
  const defaults = usePurposeModelStore(state => state.defaults)
  const setDefault = usePurposeModelStore(state => state.setDefault)
  const syncFromServer = usePurposeModelStore(state => state.syncFromServer)
  const [savedPurpose, setSavedPurpose] = useState<ModelPurpose | null>(null)
  const [webDraft, setWebDraft] = useState<AISettings>(defaultReadingSettings)
  const navigate = useNavigate()

  useEffect(() => {
    void fetchProviderList().catch(() => undefined)
    void syncFromServer()
  }, [fetchProviderList, syncFromServer])

  const readingModel = defaults.reading
  const readingProtocol = useEffectiveProviderProtocol(readingModel?.provider_id)
  const { capabilities } = useModelCapabilities(readingModel?.provider_id, readingModel?.model_name, readingProtocol)
  const resolvedWebSettings = useModelWebSearchSettings(
    readingModel,
    webDraft,
    Boolean(readingModel),
    capabilities?.external_search_available,
  )

  const providers = allProviders.filter(provider => provider.id !== 'groq')
  const kind = (provider: typeof providers[number]) => classifyProvider(provider.id, provider.baseUrl).kind
  const enabledOfficial = providers.filter(provider => kind(provider) === 'official' && provider.enabled === 1)
  const idleOfficial = providers.filter(provider => kind(provider) === 'official' && provider.enabled !== 1)
  const groups = [
    { title: '自定义连接', items: providers.filter(provider => kind(provider) === 'custom') },
    { title: '官方地址', items: enabledOfficial },
    { title: '本地连接', items: providers.filter(provider => kind(provider) === 'local') },
    { title: '未配置连接', items: providers.filter(provider => kind(provider) === 'unconfigured') },
  ]
  const list = (items: typeof providers) => <div className="api-provider-list">
    {items.map(provider => <ProviderCard key={provider.id} id={provider.id} providerName={provider.name} endpoint={provider.baseUrl} protocol={provider.protocol} />)}
  </div>

  return <article className="settings-page api-settings">
    <header className="settings-page-header">
      <h1>模型与 API</h1>
      <p>统一管理默认用途模型、对话联网与上下文容量以及 API 服务商。</p>
    </header>

    <h2 className="settings-section-title">默认用途模型</h2>
    <section className="settings-card" aria-label="默认用途模型">
      {purposes.filter(purpose => !isQuickEdition || purpose.key !== 'organizer').map(purpose => (
        <div className="settings-row" key={purpose.key}>
          <div>
            <h2>{purpose.name}</h2>
            {purpose.description && <p>{purpose.description}</p>}
            {savedPurpose === purpose.key && <small className="settings-saved"><Check size={12} />已保存</small>}
          </div>
          <PurposeModelPicker
            label={`${purpose.name}模型`}
            value={defaults[purpose.key]}
            allowFollowPrimary={purpose.allowFollowPrimary}
            followLabel="跟随主模型（默认）"
            onChange={selection => {
              setDefault(purpose.key, selection)
              setSavedPurpose(purpose.key)
            }}
          />
        </div>
      ))}
    </section>

    <h2 className="settings-section-title">对话与联网</h2>
    <section className="settings-card" aria-label="对话与联网设置">
      <div className="settings-row">
        <div>
          <h2>联网方式</h2>
          <p>{readingModel ? `作用于默认阅读模型（${readingModel.model_name}），按模型保存。` : '请先选择默认阅读模型。'}</p>
        </div>
        <div className="settings-fixed-control">
          <WebSearchControl
            value={resolvedWebSettings}
            onChange={setWebDraft}
            providerId={readingModel?.provider_id}
            modelName={readingModel?.model_name}
            protocol={readingProtocol}
            disabled={!readingModel}
          />
        </div>
      </div>
      <ModelContextSettings providerId={readingModel?.provider_id} modelName={readingModel?.model_name} />
      <WebSearchSettings />
    </section>

    <div className="settings-section-header">
      <h2 className="settings-section-title">模型服务商</h2>
      <button type="button" className="settings-button is-primary" onClick={() => navigate('/settings/model/new')}>
        <Plus size={14} strokeWidth={1.7} />添加服务商
      </button>
    </div>
    {groups.filter(group => group.items.length).map(group => <section key={group.title}>
      <h3 className="api-provider-group-title">{group.title}<span>{group.items.length}</span></h3>
      {list(group.items)}
    </section>)}
    {idleOfficial.length > 0 && <details className="api-provider-idle" open={!enabledOfficial.length && providers.every(provider => kind(provider) === 'official')}>
      <summary className="api-provider-group-title">未启用的官方预设<span>{idleOfficial.length}</span></summary>
      {list(idleOfficial)}
    </details>}
    {!providers.length && <p className="api-empty">尚未添加模型服务商。</p>}
  </article>
}
export default Provider
