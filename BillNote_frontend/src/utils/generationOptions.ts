import type { GenerationComparisonPayload, GenerationOptions, GenerationRequest, GenerationRun, GenerationUsage } from '@/services/generationRuns'

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  reasoning_effort: 'auto', temperature: 0.7, max_output_tokens: null,
  chunk_seconds: 600, chunk_text_chars: 8000, max_requests: 64, retry_attempts: 1,
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const bounded = (value: unknown, fallback: number, min: number, max: number) => finite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
export function normalizeGenerationOptions(value?: Partial<GenerationOptions> | null): GenerationOptions {
  const defaults = DEFAULT_GENERATION_OPTIONS
  const price = value?.price
  return {
    reasoning_effort: ['auto', 'none', 'low', 'medium', 'high', 'max'].includes(value?.reasoning_effort || '') ? value!.reasoning_effort! : 'auto',
    temperature: value?.temperature === null ? null : finite(value?.temperature) ? Math.min(2, Math.max(0, value.temperature)) : defaults.temperature,
    max_output_tokens: value?.max_output_tokens == null ? null : bounded(value.max_output_tokens, 8192, 256, 65536),
    chunk_seconds: bounded(value?.chunk_seconds, defaults.chunk_seconds, 60, 1800),
    chunk_text_chars: bounded(value?.chunk_text_chars, defaults.chunk_text_chars, 1000, 24000),
    max_requests: bounded(value?.max_requests, defaults.max_requests, 1, 200),
    retry_attempts: bounded(value?.retry_attempts, defaults.retry_attempts, 1, 3),
    ...(price && ['tokens', 'per_call'].includes(price.mode) && ['USD', 'CNY'].includes(price.currency)
      && (price.mode === 'tokens' ? finite(price.input_per_million) && finite(price.output_per_million) : finite(price.per_call)) ? { price: {
      mode: price.mode, currency: price.currency,
      input_per_million: finite(price.input_per_million) ? Math.max(0, price.input_per_million) : 0,
      output_per_million: finite(price.output_per_million) ? Math.max(0, price.output_per_million) : 0,
      ...(finite(price.cached_input_per_million) ? { cached_input_per_million: Math.max(0, price.cached_input_per_million) } : {}),
      ...(finite(price.per_call) ? { per_call: Math.max(0, price.per_call) } : {}),
    } } : {}),
  }
}
export interface DefaultsStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const defaultsKey = (providerId: string, modelName: string) => `bilinote-generation-defaults-v1:${JSON.stringify([providerId, modelName])}`
export function readGenerationDefaults(providerId: string, modelName: string, storage: DefaultsStorage = localStorage): GenerationOptions {
  try { return normalizeGenerationOptions(JSON.parse(storage.getItem(defaultsKey(providerId, modelName)) || 'null')) }
  catch { return normalizeGenerationOptions() }
}
// Called exclusively by the explicit "save model defaults" action.
export function saveGenerationDefaults(providerId: string, modelName: string, options: GenerationOptions, storage: DefaultsStorage = localStorage) {
  if (!providerId || !modelName) throw new Error('请先选择模型')
  storage.setItem(defaultsKey(providerId, modelName), JSON.stringify(normalizeGenerationOptions(options)))
}
export function formatUsage(value?: number | null) { return finite(value) && value >= 0 ? value.toLocaleString('zh-CN') : '未知' }
export function comparisonBound(options: GenerationOptions) {
  // The backend caps total HTTP attempts, including retries and compatibility fallbacks.
  const calls = options.max_requests
  const amount = options.price?.mode === 'per_call' && finite(options.price.per_call) ? calls * options.price.per_call : null
  return { calls, amount, currency: options.price?.currency }
}
export function estimatedTokenCost(usage: GenerationUsage, options: GenerationOptions): number | null {
  const price = options.price
  if (!price || price.mode !== 'tokens' || !finite(price.input_per_million) || !finite(price.output_per_million) || !finite(usage.input_tokens) || !finite(usage.output_tokens)) return null
  if (price.cached_input_per_million !== undefined && !finite(usage.cached_input_tokens)) return null
  const cached = Math.min(usage.input_tokens, usage.cached_input_tokens || 0)
  return ((usage.input_tokens - cached) * price.input_per_million + cached * (price.cached_input_per_million ?? price.input_per_million) + usage.output_tokens * price.output_per_million) / 1e6
}
const pendingKey = (taskId: string, versionId: string) => `bilinote-generation-pending-v1:${JSON.stringify([taskId, versionId])}`
export function readPendingComparison(taskId: string, versionId: string, storage: DefaultsStorage = localStorage): GenerationComparisonPayload | null {
  try {
    const value = JSON.parse(storage.getItem(pendingKey(taskId, versionId)) || 'null') as GenerationComparisonPayload | null
    if (!value || value.task_id !== taskId || value.version_id !== versionId || typeof value.request_id !== 'string' || !Array.isArray(value.variants) || value.variants.length !== 2) return null
    return { task_id: taskId, version_id: versionId, request_id: value.request_id, use_images: Boolean(value.use_images),
      start_time: finite(value.start_time) ? value.start_time : undefined, end_time: finite(value.end_time) ? value.end_time : undefined,
      variants: value.variants.map(item => ({ provider_id: item.provider_id, model_name: item.model_name, options: normalizeGenerationOptions(item.options) })) }
  } catch { return null }
}
export function savePendingComparison(payload: GenerationComparisonPayload, storage: DefaultsStorage = localStorage) {
  // Contains only model choices and numeric settings. The immutable source remains on the server.
  storage.setItem(pendingKey(payload.task_id, payload.version_id), JSON.stringify(payload))
}
export function clearPendingComparison(taskId: string, versionId: string, storage: DefaultsStorage = localStorage) {
  storage.setItem(pendingKey(taskId, versionId), 'null')
}
export function normalizeGenerationAttempt(item: GenerationRequest): GenerationRequest {
  const values = item.usage || item
  return { id: item.id || (item.index == null ? undefined : String(item.index)), phase: item.phase, status: item.status,
    duration_seconds: item.duration_seconds ?? (finite(item.elapsed_ms) ? item.elapsed_ms / 1000 : null),
    input_tokens: values.input_tokens ?? null, output_tokens: values.output_tokens ?? null,
    thinking_tokens: values.thinking_tokens ?? values.reasoning_tokens ?? null, cached_input_tokens: values.cached_input_tokens ?? null,
    total_tokens: values.total_tokens ?? null, cache_miss_tokens: values.cache_miss_tokens ?? null,
    logical_request_id: item.logical_request_id, retry_index: item.retry_index, reason: item.reason, http_status: item.http_status,
    finish_reason: item.finish_reason, error_type: item.error_type,
    settings_effective: item.settings_effective ? safeEffectiveSettings(item.settings_effective) : undefined,
  }
}
export function safeEffectiveSettings(settings: Record<string, unknown>) {
  return Object.fromEntries(['temperature', 'reasoning_effort', 'max_output_tokens', 'max_tokens', 'max_completion_tokens', 'output_token_parameter', 'chunk_seconds', 'chunk_text_chars', 'max_requests', 'retry_attempts', 'sdk_max_retries'].filter(key => key in settings && (settings[key] === null || ['string', 'number', 'boolean'].includes(typeof settings[key]))).map(key => [key, settings[key]]))
}
// Export an allowlist; never export raw prompts, credentials, source text or error bodies.
export function exportGenerationReport(run: GenerationRun) {
  const usage = (item: GenerationUsage) => ({ input_tokens: item.input_tokens ?? null, output_tokens: item.output_tokens ?? null, thinking_tokens: item.thinking_tokens ?? null, cached_input_tokens: item.cached_input_tokens ?? null, total_tokens: item.total_tokens ?? null, cache_miss_tokens: item.cache_miss_tokens ?? null })
  return {
    id: run.id, task_id: run.task_id, version_id: run.version_id, request_id: run.request_id,
    model_name: run.model_name, provider_id: run.provider_id, status: run.status, created_at: run.created_at, finished_at: run.finished_at,
    options: run.options ? normalizeGenerationOptions(run.options) : undefined,
    settings_effective: run.settings_effective ? safeEffectiveSettings(run.settings_effective) : undefined,
    counts: run.counts ? Object.fromEntries(['http_attempts', 'succeeded', 'failed', 'retries', 'temperature_fallbacks', 'truncations', 'merge_attempts', 'summarize_attempts'].map(key => [key, run.counts![key as keyof NonNullable<GenerationRun['counts']>] ?? null])) : undefined,
    summary: { ...usage(run.summary || {}), request_count: run.summary?.request_count ?? null, attempt_count: run.summary?.attempt_count ?? null,
      duration_seconds: run.summary?.duration_seconds ?? null, cost_estimate: run.summary?.cost_estimate ? { amount: run.summary.cost_estimate.amount, currency: run.summary.cost_estimate.currency, complete: run.summary.cost_estimate.complete } : null },
    attempts: (run.attempts || run.requests)?.map(normalizeGenerationAttempt),
    note: '使用量缺失表示未知；估算费用不等于服务商账单。原文、提示词与错误原文未导出。',
  }
}
