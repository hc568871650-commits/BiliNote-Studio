import request from '@/utils/request'
import { withProviderProtocol } from './providerProtocol'
import type { ChatErrorDetails } from '@/services/chat'
import type { ProviderProtocol } from '@/store/providerProtocolStore'

export interface CapabilityFeature {
  status: 'passed' | 'unsupported' | 'failed' | 'inconclusive' | 'skipped'
  job_id?: string
  check?: string
  stream?: boolean
  request_id?: string | null
  evidence: string
  checked_at?: string
  elapsed_ms?: number
  usage?: Record<string, unknown>
  upstream_protocol?: string
  image_sha256?: string
  sample_kind?: string
  request_attempts?: number
  validation?: Record<string, unknown>
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
  history?: CapabilityJob[]
}
export interface CapabilityJob {
  id: string
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
  completed: number
  total: number
  results: Record<string, CapabilityFeature>
  error?: string
  stale?: boolean
  protocol?: ProviderProtocol
  provider_id?: string
  model_name?: string
  checks?: string[]
  probe_stream?: boolean
  created_at?: string
  counts?: Record<string, number>
  skipped?: string[]
  outcome?: string
}
export interface CapabilityTestRequest {
  provider_id: string
  model_name: string
  protocol: ProviderProtocol
  checks: string[]
  probe_stream?: boolean
}
const options = { suppressToast: true, timeout: 15000 }
export const getModelCapabilities = async (providerId: string, modelName: string, protocol: ProviderProtocol) =>
  request.get('/model_capabilities', { ...options, params: await withProviderProtocol({ provider_id: providerId, model_name: modelName, protocol }) }) as unknown as Promise<ModelCapabilityRecord>
export const startCapabilityTest = async (body: CapabilityTestRequest) =>
  request.post('/model_capabilities/tests', await withProviderProtocol(body), options) as unknown as Promise<CapabilityJob>
export const getCapabilityJob = (id: string) =>
  request.get(`/model_capabilities/tests/${encodeURIComponent(id)}`, options) as unknown as Promise<CapabilityJob>
export const getActiveCapabilityJobs = () =>
  request.get('/model_capabilities/tests', options) as unknown as Promise<CapabilityJob[]>
export const cancelCapabilityJob = (id: string) =>
  request.post(`/model_capabilities/tests/${encodeURIComponent(id)}/cancel`, {}, options) as unknown as Promise<CapabilityJob>
export const capabilityErrorMessage = (error: unknown) => {
  const value = error as { msg?: string; message?: string }
  return value?.msg || value?.message || '能力记录读取失败，请稍后重试'
}

export interface CapabilitySubmission {
  body: CapabilityTestRequest
  startedAt: number
  failedAt: number
}

export const capabilitySubmissionRejected = (error: unknown) => {
  const details = (error as { data?: { error_details?: ChatErrorDetails } })?.data?.error_details
  return details?.kind === 'validation' && details.http_status == null
}

export const findCapabilitySubmission = (submission: CapabilitySubmission, jobs: CapabilityJob[]) => {
  const { body, startedAt, failedAt } = submission
  const checks = JSON.stringify([...body.checks].sort())
  const matches = jobs.filter(job => {
    const created = Date.parse(job.created_at || '')
    return !job.stale && job.provider_id === body.provider_id && job.model_name === body.model_name && job.protocol === body.protocol
      && JSON.stringify([...(job.checks || [])].sort()) === checks && Boolean(job.probe_stream) === Boolean(body.probe_stream)
      && Number.isFinite(created) && created >= startedAt && created <= failedAt
  })
  const unique = [...new Map(matches.map(job => [job.id, job])).values()]
  return unique.length === 1 ? unique[0] : null
}

export const recoverCapabilitySubmission = async (submission: CapabilitySubmission) => {
  const { body } = submission
  // Both are read-only. A missing/ambiguous record is not permission to resubmit.
  const [active, record] = await Promise.all([
    getActiveCapabilityJobs(), getModelCapabilities(body.provider_id, body.model_name, body.protocol),
  ])
  return findCapabilitySubmission(submission, [...active, ...(record.history || [])])
}
