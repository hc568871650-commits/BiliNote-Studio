import ProviderCard from '@/components/Form/modelForm/components/providerCard.tsx'
import { useProviderStore } from '@/store/providerStore'
import { useNavigate } from 'react-router-dom'
import { classifyProvider } from '@/utils/providerProfiles'
import { Plus } from 'lucide-react'
import './api-settings.css'

const Provider = () => {
  const allProviders = useProviderStore(state => state.provider)
  const providers = allProviders.filter(provider => provider.id !== 'groq')
  const navigate = useNavigate()
  const kind = (provider: typeof providers[number]) => classifyProvider(provider.id, provider.baseUrl).kind
  // Connections in use come first; unused official presets fold away so they do not push custom relays below the fold.
  const enabledOfficial = providers.filter(provider => kind(provider) === 'official' && provider.enabled === 1)
  const idleOfficial = providers.filter(provider => kind(provider) === 'official' && provider.enabled !== 1)
  const groups = [
    { title: '自定义连接', items: providers.filter(provider => kind(provider) === 'custom') },
    { title: '官方地址', items: enabledOfficial },
    { title: '本地连接', items: providers.filter(provider => kind(provider) === 'local') },
    { title: '未配置连接', items: providers.filter(provider => kind(provider) === 'unconfigured') },
  ]
  const list = (items: typeof providers) => <div className="api-surface api-provider-list">
    {items.map(provider => <ProviderCard key={provider.id} id={provider.id} providerName={provider.name} endpoint={provider.baseUrl} />)}
  </div>
  return <article className="settings-page api-settings">
    <header className="api-page-header"><h1>模型服务商</h1><button type="button" className="settings-button is-primary" onClick={() => navigate('/settings/model/new')}><Plus size={14} />添加</button></header>
    {groups.filter(group => group.items.length).map(group => <section key={group.title}>
      <h2 className="api-provider-group-title">{group.title}<span>{group.items.length}</span></h2>
      {list(group.items)}
    </section>)}
    {idleOfficial.length > 0 && <details className="api-provider-idle" open={!enabledOfficial.length && providers.every(provider => kind(provider) === 'official')}>
      <summary className="api-provider-group-title">未启用的官方预设<span>{idleOfficial.length}</span></summary>
      {list(idleOfficial)}
    </details>}
    {!providers.length && <section className="api-surface api-empty">尚未添加模型服务商。</section>}
  </article>
}
export default Provider
