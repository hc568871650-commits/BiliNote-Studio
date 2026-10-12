import { Globe } from 'lucide-react'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import type { AISettings } from '@/utils/aiSettings'
import type { ProviderProtocol } from '@/store/providerProtocolStore'
import './web-search-control.css'

interface Props { value: AISettings; onChange: (value: AISettings) => void; providerId?: string; modelName?: string; protocol: ProviderProtocol; disabled?: boolean }
export default function WebSearchControl({ value, onChange, providerId, modelName, protocol, disabled }: Props) {
  const { capabilities, loading } = useModelCapabilities(providerId, modelName, protocol)
  const native = capabilities?.features.web_native?.status === 'passed' && protocol === 'openai-responses'
  const external = capabilities?.external_search_available === true
  const available = native || external
  const mode = native && external ? value.web_search_mode || 'native' : native ? 'native' : 'external'
  return <div className="assistant-web-control" style={{display:'flex',alignItems:'center',gap:4}}>
    <button type="button" aria-label="联网搜索" aria-pressed={Boolean(value.web_search)} disabled={disabled || (!value.web_search && (!available || loading))}
      title={available ? value.web_search ? '已开启联网搜索，点击关闭' : '允许搜索网络资料' : '请先在服务商设置测试原生联网，或在 AI 用途与模型配置外部检索'}
      onClick={() => onChange({...value,web_search:!value.web_search,web_search_mode:mode})}><Globe size={14} /><span>联网</span></button>
    {value.web_search && native && external && <select aria-label="联网方式" value={mode} disabled={disabled} onChange={e=>onChange({...value,web_search_mode:e.target.value as 'native'|'external'})} style={{background:'var(--surface-input)',color:'var(--surface-text)',fontSize:11,maxWidth:90}}><option value="native">原生搜索</option><option value="external">外部检索</option></select>}
  </div>
}
