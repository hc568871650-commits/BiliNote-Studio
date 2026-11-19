import { Switch } from '@/components/ui/switch'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProviderStore } from '@/store/providerStore'
import { ChevronRight } from 'lucide-react'

export interface IProviderCardProps {
  id: string
  providerName: string
  endpoint: string
  protocol?: string
}

const protocolLabels: Record<string, string> = {
  'openai-chat': 'Chat',
  'openai-responses': 'Responses',
  anthropic: 'Messages',
  gemini: 'Gemini',
}

const ProviderCard = ({
  providerName,
  id,
  endpoint,
  protocol,
}: IProviderCardProps) => {
  const navigate = useNavigate()
  const updateProvider = useProviderStore(state => state.updateProvider)
  const enabled = useProviderStore(state => state.provider.find(p => p.id === id)?.enabled)

  const isChecked = enabled === 1
  const [busy, setBusy] = useState(false)

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
    <div className="api-provider-row">
      <button type="button" className="api-provider-info" onClick={() => navigate(`/settings/model/${id}`)} aria-label={`配置 ${providerName}`}>
        <div className="api-provider-info-head">
          <strong>{providerName}</strong>
          {protocol && protocolLabels[protocol] && <span className="api-provider-protocol">{protocolLabels[protocol]}</span>}
        </div>
        <span title={endpoint}>{endpoint || '未配置地址'}</span>
      </button>

      <div className="settings-row-controls">
        <Switch
          aria-label={`启用 ${providerName}`}
          checked={isChecked}
          disabled={busy}
          onCheckedChange={checked => void handleToggle(checked)}
        />
        <button type="button" className="api-icon-button" title="配置" aria-label={`编辑 ${providerName}`} onClick={() => navigate(`/settings/model/${id}`)}><ChevronRight size={15} strokeWidth={1.6} /></button>
      </div>
    </div>
  )
}
export default ProviderCard
