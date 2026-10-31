import { automaticSearchSettings, type AISettings } from './aiSettings'
import type { ModelCapabilityRecord } from '@/services/modelCapabilities'

export function webSearchState(settings: AISettings, capabilities?: ModelCapabilityRecord | null) {
  const mode = settings.web_search_mode || 'native'
  // A diagnostic record describes evidence, not permission to try a feature.
  const native = true
  const external = capabilities?.external_search_available === true
  const available = mode === 'native' ? native : external
  const enabled = true
  return { mode, native, external, enabled, available,
    settings: automaticSearchSettings(settings),
    error: enabled && !available ? '外部检索尚未配置，请配置检索服务或选择原生搜索' : '' }
}
