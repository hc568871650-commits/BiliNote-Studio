import assert from 'node:assert/strict'
import { clearPendingComparison, comparisonBound, DEFAULT_GENERATION_OPTIONS, estimatedTokenCost, exportGenerationReport, formatUsage, normalizeGenerationAttempt, normalizeGenerationOptions, readGenerationDefaults, readPendingComparison, saveGenerationDefaults, savePendingComparison } from '../src/utils/generationOptions'
import type { GenerationComparisonPayload, GenerationPrice, GenerationRun } from '../src/services/generationRuns'

const values = new Map<string, string>()
let writes = 0
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { writes++; values.set(key, value) } }
const first = readGenerationDefaults('provider-a', 'model-a', storage)
first.max_requests = 3
assert.equal(writes, 0, 'editing temporary options must not persist')
assert.equal(readGenerationDefaults('provider-a', 'model-a', storage).max_requests, DEFAULT_GENERATION_OPTIONS.max_requests)
saveGenerationDefaults('provider-a', 'model-a', first, storage)
assert.equal(readGenerationDefaults('provider-a', 'model-a', storage).max_requests, 3)
assert.equal(readGenerationDefaults('provider-b', 'model-a', storage).max_requests, 64, 'same model under a different provider is independent')
assert.equal(readGenerationDefaults('provider-a', 'model-b', storage).max_requests, 64, 'different model is independent')
const temporary = readGenerationDefaults('provider-a', 'model-a', storage)
temporary.max_requests = 9
assert.equal(readGenerationDefaults('provider-a', 'model-a', storage).max_requests, 3, 'reads return detached values')
assert.throws(() => saveGenerationDefaults('', 'model', first, storage))
assert.equal(normalizeGenerationOptions().price, undefined)
assert.equal(normalizeGenerationOptions({ price: { mode: 'tokens', currency: 'USD' } as GenerationPrice }).price, undefined, 'missing price must not become a free estimate')
assert.equal(normalizeGenerationOptions({ price: { mode: 'per_call', currency: 'USD', input_per_million: 0, output_per_million: 0 } }).price, undefined)
assert.equal(normalizeGenerationOptions({ max_requests: 999, retry_attempts: 0, max_output_tokens: 2 }).max_requests, 200)
assert.equal(normalizeGenerationOptions({ max_output_tokens: null }).max_output_tokens, null)
assert.equal(formatUsage(undefined), '未知')
assert.equal(formatUsage(null), '未知')
assert.equal(formatUsage(Number.NaN), '未知')
assert.equal(formatUsage(0), '0', 'explicit zero is valid usage')
const priced = normalizeGenerationOptions({ max_requests: 10, retry_attempts: 3, price: { mode: 'tokens', currency: 'CNY', input_per_million: 5, output_per_million: 10, cached_input_per_million: 1 } })
assert.equal(comparisonBound(priced).calls, 10, 'total attempt cap already includes retries')
assert.equal(comparisonBound(priced).amount, null, 'token prices cannot prove a money upper bound without input size')
assert.equal(estimatedTokenCost({ input_tokens: 100, output_tokens: 10 }, priced), null, 'cache amount unknown with cache-specific price')
assert.equal(estimatedTokenCost({ input_tokens: 100, output_tokens: null, cached_input_tokens: 0 }, priced), null)
assert.equal(estimatedTokenCost({ input_tokens: 100, output_tokens: 10, thinking_tokens: 8, cached_input_tokens: 20 }, priced), 0.00052, 'cache is a subset and thinking must not be added again')
assert.equal(comparisonBound(normalizeGenerationOptions({ max_requests: 10, retry_attempts: 3, price: { mode: 'per_call', currency: 'CNY', input_per_million: 0, output_per_million: 0, per_call: 0.25 } })).amount, 2.5)
const report = { id: 'report', task_id: 'task', status: 'failed', provider_id: 'p', model_name: 'm', summary: { input_tokens: null, output_tokens: 12 }, options: { ...DEFAULT_GENERATION_OPTIONS, api_key: 'SECRET' }, api_key: 'SECRET', error: 'SECRET source', prompt: 'SOURCE TEXT', attempts: [{ status: 'failed', error: 'SECRET', input_tokens: null, raw_response: { key: 'SECRET' } }] } as unknown as GenerationRun
const exported = JSON.stringify(exportGenerationReport(report))
assert.ok(!exported.includes('SECRET') && !exported.includes('SOURCE TEXT'), 'JSON export must exclude raw prompt and nested secrets')
assert.equal(exportGenerationReport(report).summary.input_tokens, null)
assert.equal(exportGenerationReport(report).attempts?.length, 1)
const normalizedAttempt = normalizeGenerationAttempt({ index: 2, elapsed_ms: 1230, reason: 'temperature_fallback', usage: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, cached_input_tokens: null }, settings_effective: { temperature: null, max_tokens: 2048, api_key: 'SECRET' } })
assert.equal(normalizedAttempt.duration_seconds, 1.23)
assert.equal(normalizedAttempt.input_tokens, 100, 'real backend nested attempt usage is used')
assert.equal(normalizedAttempt.thinking_tokens, 5, 'reasoning token alias is normalized')
assert.equal(normalizedAttempt.cached_input_tokens, null)
assert.equal(normalizedAttempt.reason, 'temperature_fallback')
assert.ok(!JSON.stringify(normalizedAttempt).includes('SECRET'))
const payload: GenerationComparisonPayload = { task_id: 'task', version_id: 'version', request_id: 'same-id', use_images: false, variants: [{ provider_id: 'p', model_name: 'm', options: first }, { provider_id: 'p', model_name: 'm2', options: first }] }
savePendingComparison(payload, storage)
assert.equal(readPendingComparison('task', 'version', storage)?.request_id, 'same-id', 'closing/reopening retains idempotency key')
assert.equal(readPendingComparison('another-task', 'version', storage), null)
clearPendingComparison('task', 'version', storage)
assert.equal(readPendingComparison('task', 'version', storage), null)
console.log('PASS generation options: explicit defaults isolation, unknown/zero costs, total attempt cap, safe export, durable request id')
