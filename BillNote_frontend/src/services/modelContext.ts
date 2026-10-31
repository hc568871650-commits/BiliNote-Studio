import request from '@/utils/request'

export interface ModelContextProfile { model_window: number | null; user_limit: number; output_reserve: number }
export interface ModelContextBudget extends ModelContextProfile {
  provider_id: string
  model_name: string
  source: 'manual' | 'unknown'
  source_label: string
  verified: false
  effective_window: number
  input_limit: number
  compact_threshold: number
}
const options = { suppressToast: true, timeout: 15000 }
const cache = new Map<string, ModelContextBudget>()
const pending = new Map<string, Promise<ModelContextBudget>>()
const revisions = new Map<string, number>()
export const modelContextKey = (providerId: string, modelName: string) => JSON.stringify([providerId, modelName])
export const defaultModelContext = (providerId = '', modelName = ''): ModelContextBudget => ({
  provider_id: providerId, model_name: modelName, model_window: null, user_limit: 272000,
  output_reserve: 4096, source: 'unknown', source_label: '容量未知（按 65,536 处理）', verified: false,
  effective_window: 65536, input_limit: 61440, compact_threshold: 49152,
})
export const cachedModelContext = (providerId: string, modelName: string) => cache.get(modelContextKey(providerId, modelName))
export function getModelContext(providerId: string, modelName: string, refresh = false): Promise<ModelContextBudget> {
  const key = modelContextKey(providerId, modelName)
  const saved = cache.get(key)
  if (saved && !refresh) return Promise.resolve(saved)
  const active = pending.get(key)
  if (active) return active
  const revision = revisions.get(key) || 0
  const load = (request.get('/model_context/settings', { ...options, params: { provider_id: providerId, model_name: modelName } }) as unknown as Promise<ModelContextBudget>)
    .then(value => {
      if ((revisions.get(key) || 0) !== revision) return cache.get(key) || value
      cache.set(key, value); return value
    }).finally(() => { if (pending.get(key) === load) pending.delete(key) })
  pending.set(key, load)
  return load
}
export async function saveModelContext(providerId: string, modelName: string, profile: ModelContextProfile) {
  const value = await request.put('/model_context/settings', profile, { ...options, params: { provider_id: providerId, model_name: modelName } }) as unknown as ModelContextBudget
  const key = modelContextKey(providerId, modelName)
  revisions.set(key, (revisions.get(key) || 0) + 1)
  cache.set(key, value)
  window.dispatchEvent(new CustomEvent('bilinote-model-context-updated', { detail: key }))
  return value
}
