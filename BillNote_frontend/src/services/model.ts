import request from '@/utils/request.ts'
import { isTranscriptionModel } from '@/utils/modelCapabilities'

// opts.silent: 让本次请求失败时不弹全局红 toast（调用方自行 catch 处理，
// 比如 onboarding 撞名重试这种预期内失败）
interface CallOpts { silent?: boolean }
const cfg = (o?: CallOpts) => (o?.silent ? { suppressToast: true } : undefined)
export interface RegisteredModel { id: number | string; provider_id: string; model_name: string; display_name?: string | null }
const modelArray = (list: unknown): RegisteredModel[] => {
  if (!Array.isArray(list)) throw new Error('模型列表返回格式异常')
  return list as RegisteredModel[]
}

export const getProviderList = async (opts?: CallOpts) => {
  return await request.get('/get_all_providers', cfg(opts))
}
export const getProviderById = async (id: string) => {
  return await request.get(`/get_provider_by_id/${id}`)
}
export const updateProviderById = async (data: any, opts?: CallOpts) => {
  return await request.post('/update_provider', data, cfg(opts))
}

export const addProvider = async (data: any, opts?: CallOpts) => {
  return await request.post('/add_provider', data, cfg(opts))
}

export const deleteProviderById = async (id: string, opts?: CallOpts) => {
  const result = await request.delete(`/providers/${encodeURIComponent(id)}`, cfg(opts))
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('model-list-updated'))
  return result
}

export const testConnection = async (data: any, opts?: CallOpts) => {
  return await request.post('/connect_test', data, { ...cfg(opts), timeout: 65000 })
}

export const fetchPurposePreferences = async (opts?: CallOpts) => {
  return await request.get('/ai_purposes', cfg(opts))
}

export const savePurposePreferences = async (
  data: Record<string, { provider_id: string; model_name: string } | null>,
  opts?: CallOpts,
) => {
  return await request.put('/ai_purposes', data, cfg(opts))
}

export const fetchModels = async (providerId: string) => {
  return await request.get('/model_list/' + providerId)
}

export const fetchEnableModelById = async (id: string) => {
  const list = await request.get('/model_enable/' + id)
  return modelArray(list).filter(model => !isTranscriptionModel(model.model_name))
}

/** Retain existing audio model registrations without exposing them to chat selectors. */
export const fetchTranscriptionModelsByProvider = async (id: string) => {
  const list = await request.get('/model_enable/' + id)
  return modelArray(list).filter(model => isTranscriptionModel(model.model_name))
}

export async function addModel(
  data: { provider_id: string; model_name: string; display_name?: string | null },
  opts?: CallOpts,
) {
  const result = await request.post('/models', data, cfg(opts))
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('model-list-updated'))
  return result
}

export async function updateModelDisplayName(data: { id: number; display_name: string | null }, opts?: CallOpts) {
  const result = await request.post('/models/display_name', data, cfg(opts))
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('model-list-updated'))
  return result
}

export async function updateModelFull(
  data: { id: number; model_name?: string; display_name?: string | null },
  opts?: CallOpts,
) {
  const payload: { model_name?: string; display_name?: string | null } = {}
  if (data.model_name !== undefined) payload.model_name = data.model_name
  if (data.display_name !== undefined) payload.display_name = data.display_name
  const result = await request.put(`/models/${data.id}`, payload, cfg(opts))
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('model-list-updated'))
  return result
}

export async function addModelsBatch(
  data: { provider_id: string; models: { model_name: string; display_name?: string | null }[] },
  opts?: CallOpts,
) {
  const result = await request.post('/models/batch', data, cfg(opts))
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('model-list-updated'))
  return result
}

export async function deleteModelsBatch(ids: number[], opts?: CallOpts) {
  const result = await request.post('/models/batch-delete', { ids }, cfg(opts))
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('model-list-updated'))
  return result
}

export const fetchEnableModels = async (opts?: CallOpts) => {
  const list = await request.get('/model_list', cfg(opts))
  return modelArray(list).filter(model => !isTranscriptionModel(model.model_name))
}

export const deleteModelById = async (modelId: number) => {
  const result = await request.get(`/models/delete/${modelId}`)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('model-list-updated'))
  return result
}
