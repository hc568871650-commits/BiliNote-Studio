import ProviderCard from '@/components/Form/modelForm/components/providerCard.tsx'
import { useProviderStore } from '@/store/providerStore'
import { useNavigate } from 'react-router-dom'
import { classifyProvider } from '@/utils/providerProfiles'

const Provider = () => {
  const allProviders = useProviderStore(state => state.provider)
  const providers = allProviders.filter(provider => provider.id !== 'groq')
  const navigate = useNavigate()
  const groups = [
    { title: '官方预设地址', items: providers.filter(provider => classifyProvider(provider.id, provider.baseUrl).kind === 'official') },
    { title: '自定义连接', items: providers.filter(provider => classifyProvider(provider.id, provider.baseUrl).kind === 'custom') },
    { title: '本地连接', items: providers.filter(provider => classifyProvider(provider.id, provider.baseUrl).kind === 'local') },
    { title: '未配置连接', items: providers.filter(provider => classifyProvider(provider.id, provider.baseUrl).kind === 'unconfigured') },
  ]
  return <article className="settings-page">
    <header className="settings-page-header"><h1>模型服务商</h1><p>配置模型连接，并选择需要使用的服务商。</p></header>
    {groups.filter(group => group.items.length).map(group => <section key={group.title}>
      <h2 className="settings-section-title">{group.title}</h2>
      <div className="settings-card">
        {group.items.map(provider => <ProviderCard key={provider.id} id={provider.id} providerName={provider.name} endpoint={provider.baseUrl} />)}
        {!group.items.length && <div className="settings-row"><p className="settings-muted">暂无{group.title}。</p></div>}
      </div>
    </section>)}
    {!providers.length && <section className="settings-card"><div className="settings-row"><div><h2>添加第一个服务商</h2><p>配置连接后，可以为生成、阅读和整理分别选择模型。</p></div></div></section>}
    <div className="settings-actions"><button type="button" className="settings-button" onClick={() => navigate('/settings/model/new')}>添加服务商</button></div>
  </article>
}
export default Provider
