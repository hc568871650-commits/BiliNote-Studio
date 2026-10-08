export type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh'
export interface AISettings { reasoning_effort: ReasoningEffort; context_limit: 272000 }
export interface ContextUsage { input_tokens: number; estimated: boolean; limit: number; warning?: boolean; compacted?: boolean; compacted_messages?: number }
export const defaultAISettings: AISettings = { reasoning_effort: 'auto', context_limit: 272000 }
export function reasoningChoices(model = ''): ReasoningEffort[] {
  const name = model.toLowerCase().split('/').pop() || ''
  if (/^gpt-6-(?:sol|astra)(?:-|$)/.test(name)) return name.includes('astra') ? ['auto', 'low', 'medium', 'high', 'xhigh'] : ['auto', 'none', 'low', 'medium', 'high', 'xhigh']
  if (/^gpt-5\.[245](?:-|$)/.test(name)) return name.includes('-pro') ? ['auto', 'medium', 'high', 'xhigh'] : ['auto', 'none', 'low', 'medium', 'high', 'xhigh']
  if (/^(?:gpt-5(?:-|$)|o[134](?:-|$))/.test(name)) return ['auto', 'low', 'medium', 'high']
  if (/^gemini-(?:2\.5|3)(?:[.-]|$)/.test(name)) return name.includes('flash') ? ['auto', 'low', 'medium', 'high'] : ['auto', 'low', 'high']
  return ['auto']
}
export function settingsForModel(settings: AISettings, model = ''): AISettings {
  return { ...settings, context_limit: 272000, reasoning_effort: reasoningChoices(model).includes(settings.reasoning_effort) ? settings.reasoning_effort : 'auto' }
}
export const estimateTextContext = (text: string) => new TextEncoder().encode(text).length
export function estimateLocalContext(value: unknown): number {
  return estimateTextContext(JSON.stringify(value, (key, item) => key === 'data_url' && item ? '[image]' + 'x'.repeat(16384) : item))
}
