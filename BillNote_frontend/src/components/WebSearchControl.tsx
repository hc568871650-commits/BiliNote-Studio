import ChoiceSelect from '@/components/ChoiceSelect'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import type { AISettings } from '@/utils/aiSettings'
import type { ProviderProtocol } from '@/store/providerProtocolStore'
import './web-search-control.css'
import { webSearchState } from '@/utils/webSearch'
import { useModelWebSearchStore, type WebSearchMode } from '@/store/modelWebSearchStore'

interface Props { value: AISettings; onChange: (value: AISettings) => void; providerId?: string; modelName?: string; protocol: ProviderProtocol; disabled?: boolean }
export default function WebSearchControl({ value, onChange, providerId, modelName, protocol, disabled }: Props) {
  const { capabilities } = useModelCapabilities(providerId, modelName, protocol)
  const { native, external, mode, error } = webSearchState(value, capabilities)
  const changeMode = (mode: string) => {
    if (!providerId || !modelName) return
    useModelWebSearchStore.getState().setMode(providerId, modelName, mode as WebSearchMode)
    onChange({ ...value, web_search: true, web_search_mode: mode as WebSearchMode })
  }
  return <div className="assistant-web-control">
    <ChoiceSelect label="联网方式" value={mode} disabled={disabled || !providerId || !modelName} className="assistant-web-mode" onChange={changeMode} options={[{value:'native',label:'原生搜索',disabled:!native},{value:'external',label:external?'外部检索':'外部检索（不可用）',disabled:!external}]} />
    {error && <span className="assistant-web-error" role="status" title={error}>联网方式不可用</span>}
  </div>
}
