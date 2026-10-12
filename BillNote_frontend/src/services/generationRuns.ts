import request from '@/utils/request'

export interface GenerationPrice {
  mode: 'tokens' | 'per_call'; currency: 'USD' | 'CNY'
  input_per_million: number; output_per_million: number
  cached_input_per_million?: number; per_call?: number
}
export interface GenerationOptions {
  reasoning_effort: 'auto' | 'none' | 'low' | 'medium' | 'high' | 'max'
  temperature: number | null; max_output_tokens: number | null
  chunk_seconds: number; chunk_text_chars: number; max_requests: number; retry_attempts: number
  price?: GenerationPrice
}
export interface GenerationUsage {
  input_tokens?: number | null; output_tokens?: number | null
  thinking_tokens?: number | null; reasoning_tokens?: number | null; cached_input_tokens?: number | null
  total_tokens?: number | null; cache_miss_tokens?: number | null
}
export interface GenerationRequest extends GenerationUsage {
  id?: string; phase?: string; status?: string; duration_seconds?: number | null
  attempt_count?: number; error?: string
  index?: number; logical_request_id?: string; node?: string; retry_index?: number; reason?: string
  elapsed_ms?: number | null; http_status?: number | null; finish_reason?: string | null; error_type?: string | null
  usage?: GenerationUsage; settings_effective?: Record<string, unknown>
}
export interface GenerationRun {
  id: string; task_id: string; version_id?: string; request_id?: string
  provider_id: string; model_name: string; status: string; created_at?: string; finished_at?: string
  options?: GenerationOptions
  summary: GenerationUsage & { request_count?: number; attempt_count?: number; duration_seconds?: number | null
    cost_estimate?: { amount: number | null; currency: string; complete?: boolean; basis?: string } }
  requests?: GenerationRequest[]; attempts?: GenerationRequest[]; warnings?: string[]; error?: string | { type?: string } | null
  settings_effective?: Record<string, unknown>
  totals?: GenerationUsage
  counts?: { http_attempts?: number; succeeded?: number; failed?: number; retries?: number; temperature_fallbacks?: number; truncations?: number; merge_attempts?: number; summarize_attempts?: number }
}
export interface GenerationVariant { provider_id: string; model_name: string; options: GenerationOptions }
export interface GenerationComparisonPayload { task_id: string; version_id: string; request_id: string; variants: GenerationVariant[]; use_images: boolean; start_time?: number; end_time?: number }
export interface GenerationComparison {
  id: string; task_id: string; version_id: string; status: string; created_at?: string; request_id?: string
  source?: { fingerprint?: string; segments?: number; image_count?: number; duration_seconds?: number; prompt_version?: string }
  variants: (GenerationVariant & { status?: string; report?: GenerationRun; markdown?: string; error?: string })[]
}
const readOptions = { suppressToast: true, timeout: 10000 }
export const getGenerationRuns = (taskId: string) => request.get(`/notes/${encodeURIComponent(taskId)}/generation-runs`, readOptions) as unknown as Promise<GenerationRun[]>
export const listGenerationComparisons = (taskId: string) => request.get('/generation-comparisons', { ...readOptions, params: { task_id: taskId } }) as unknown as Promise<GenerationComparison[]>
export const getGenerationComparison = (id: string) => request.get(`/generation-comparisons/${encodeURIComponent(id)}`, readOptions) as unknown as Promise<GenerationComparison>
// A timed-out submission can still be accepted. The caller retains request_id and only reads afterwards.
export const createGenerationComparison = (data: GenerationComparisonPayload) => request.post('/generation-comparisons', data, { suppressToast: true, timeout: 30000 }) as unknown as Promise<GenerationComparison>
export const cancelGenerationComparison = (id: string) => request.post(`/generation-comparisons/${encodeURIComponent(id)}/cancel`, undefined, readOptions) as unknown as Promise<GenerationComparison>
