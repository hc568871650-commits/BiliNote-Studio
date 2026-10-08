import { Switch } from '@/components/ui/switch'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProviderStore } from '@/store/providerStore'
import { classifyProvider } from '@/utils/providerProfiles'

export interface IProviderCardProps {
  id: string
  providerName: string
  endpoint: string
}

const ProviderCard = ({
  providerName,
  id,
  endpoint,
}: IProviderCardProps) => {
  const navigate = useNavigate()
  const updateProvider = useProviderStore(state => state.updateProvider)
  const enabled = useProviderStore(state => state.provider.find(p => p.id === id)?.enabled)

  const isChecked = enabled === 1
  const [busy, setBusy] = useState(false)
  const profile = classifyProvider(id, endpoint)

  const handleToggle = async (checked: boolean) => {
    const allProviders = useProviderStore.getState().provider
    const provider = allProviders.find(p => p.id === id)
    if (!provider) return
    setBusy(true)
    try { await updateProvider({
      ...provider,
      enabled: checked ? 1 : 0,
    }) } catch { /* Request layer reports the failure. */ }
    finally { setBusy(false) }
  }

  return (
    <div className="settings-row">
      <div className="min-w-0">
        <h2>{providerName}</h2>
        <p>{profile.label}{profile.hostname ? ` · 实际域名：${profile.hostname}` : ''}</p>
        <p className="break-all">{endpoint || '尚未配置 API 地址'}</p>
      </div>

      <div className="settings-row-controls">
        <Switch
          aria-label={`启用 ${providerName}`}
          checked={isChecked}
          disabled={busy}
          onCheckedChange={checked => void handleToggle(checked)}
        />
        <button type="button" className="settings-button" aria-label={`编辑 ${providerName}`} onClick={() => navigate(`/settings/model/${id}`)}>编辑</button>
      </div>
    </div>
  )
}
export default ProviderCard
