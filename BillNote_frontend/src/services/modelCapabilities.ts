import request from '@/utils/request'
import type { ChatErrorDetails } from '@/services/chat'
import type { ProviderProtocol } from '@/store/providerProtocolStore'

export interface CapabilityFeature {
  status: 'passed' | 'unsupported' | 'failed' | 'inconclusive'
  evidence: string
  checked_at: string
  elapsed_ms: number
  usage?: Record<string, unknown>
  error_details?: ChatErrorDetails
}
export interface ModelCapabilityRecord {
  provider_id: string
  model_name: string
  protocol: ProviderProtocol
  candidates: string[]
  available_efforts: string[]
  features: Record<string, CapabilityFeature>
  stale: boolean
  external_search_available: boolean
}
export interface CapabilityJob {
  id: string
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
  completed: number
  total: number
  results: Record<string, CapabilityFeature>
  error?: string
}
export interface CapabilityTestRequest {
  provider_id: string
  model_name: string
  protocol: ProviderProtocol
  checks: string[]
}
const options = { suppressToast: true, timeout: 15000 }
export const getModelCapabilities = (providerId: string, modelName: string, protocol: ProviderProtocol) =>
  request.get('/model_capabilities', { ...options, params: { provider_id: providerId, model_name: modelName, protocol } }) as unknown as Promise<ModelCapabilityRecord>
export const startCapabilityTest = (body: CapabilityTestRequest) =>
  request.post('/model_capabilities/tests', body, options) as unknown as Promise<CapabilityJob>
export const getCapabilityJob = (id: string) =>
  request.get(`/model_capabilities/tests/${encodeURIComponent(id)}`, options) as unknown as Promise<CapabilityJob>
export const cancelCapabilityJob = (id: string) =>
  request.post(`/model_capabilities/tests/${encodeURIComponent(id)}/cancel`, {}, options) as unknown as Promise<CapabilityJob>
export const capabilityErrorMessage = (error: unknown) => {
  const value = error as { msg?: string; message?: string }
  return value?.msg || value?.message || '能力记录读取失败，请稍后重试'
}
