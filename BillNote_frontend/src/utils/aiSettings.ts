export type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export interface AISettings { reasoning_effort: ReasoningEffort; context_limit: number; web_search?: boolean; web_search_mode?: 'native' | 'external' }
export interface ContextUsage { input_tokens: number; estimated: boolean; limit: number; warning?: boolean; compacted?: boolean; compacted_messages?: number; web_search_used?: boolean; trace_id?: string; request_id?: string | null; protocol?: string; model_context?: import('@/services/modelContext').ModelContextBudget }
export const defaultAISettings: AISettings = { reasoning_effort: 'auto', context_limit: 272000, web_search: true, web_search_mode: 'native' }
export const defaultReadingSettings: AISettings = { ...defaultAISettings, web_search: true, web_search_mode: 'native' }
export function automaticSearchSettings(settings?: AISettings): AISettings {
  // Old session switches no longer control tool access; retain the chosen route.
  return { ...defaultAISettings, ...settings, web_search: true, web_search_mode: settings?.web_search_mode || 'native' }
}
export function requestEffortChoices(model = '', protocol = 'openai-chat'): ReasoningEffort[] {
  if (protocol === 'gemini') {
    const name = model.toLowerCase().replace(/^models\//, '')
    if (!/^gemini-3(?:[.-]|$)/.test(name)) return ['auto']
    if (name.includes('image')) return ['auto', 'high']
    return /^gemini-3-pro(?:-|$)/.test(name) ? ['auto', 'low', 'high'] : ['auto', 'low', 'medium', 'high']
  }
  return ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']
}
export function reasoningChoices(model = ''): ReasoningEffort[] {
  const name = model.toLowerCase().split('/').pop() || ''
  if (/^gpt-6\.1-sol(?:-|$)/.test(name)) return ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
  if (/^gpt-6-(?:sol|astra)(?:-|$)/.test(name)) return name.includes('astra') ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] : ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']
  if (/^gpt-5\.[245](?:-|$)/.test(name)) return name.includes('-pro') ? ['auto', 'medium', 'high', 'xhigh'] : ['auto', 'none', 'low', 'medium', 'high', 'xhigh']
  if (/^(?:gpt-5(?:-|$)|o[134](?:-|$))/.test(name)) return ['auto', 'low', 'medium', 'high']
  if (/^gemini-(?:2\.5|3)(?:[.-]|$)/.test(name)) return name.includes('flash') ? ['auto', 'low', 'medium', 'high'] : ['auto', 'low', 'high']
  return ['auto']
}
export function settingsForModel(settings: AISettings, model = '', allowed?: readonly string[]): AISettings {
  const limit = Number.isInteger(settings.context_limit) && settings.context_limit >= 8192 && settings.context_limit <= 272000 ? settings.context_limit : 272000
  return { ...settings, context_limit: limit, reasoning_effort: (allowed || requestEffortChoices(model)).includes(settings.reasoning_effort) ? settings.reasoning_effort : 'auto' }
}
export const estimateTextContext = (text: string) => new TextEncoder().encode(text).length
export function estimateLocalContext(value: unknown): number {
  return estimateTextContext(JSON.stringify(value, (key, item) => key === 'data_url' && item ? '[image]' + 'x'.repeat(16384) : item))
}
