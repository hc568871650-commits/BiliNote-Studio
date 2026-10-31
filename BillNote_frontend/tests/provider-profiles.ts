import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyProvider, newProviderEnabled, normalizeProviderUrl, officialProviderProtocol, providerPresets, resolveProviderProtocol, selectProviderPreset } from '../src/utils/providerProfiles'
import { useProviderProtocolStore } from '../src/store/providerProtocolStore'
import { useProviderStore } from '../src/store/providerStore'
import request from '../src/utils/request'
import { askQuestion, compactChat } from '../src/services/chat'
import { askQuestionStream, setChatStreamTransport } from '../src/services/chatStream'
import { planOrganization, messageOrganizerSession, compactOrganizerSession } from '../src/services/organizer'
import { previewRefinement } from '../src/services/noteRefinement'
import { getModelCapabilities, startCapabilityTest } from '../src/services/modelCapabilities'

for (const preset of providerPresets) {
  assert.equal(classifyProvider(preset.id, preset.baseUrl).kind, preset.id === 'ollama' ? 'local' : 'official')
}
assert.equal(classifyProvider('new-uuid', 'https://API.OPENAI.COM:443/v1/').kind, 'official')
assert.equal(classifyProvider('openai', 'https://relay.example/v1').kind, 'custom')
assert.equal(classifyProvider('deepseek', 'https://relay.example/v1').hostname, 'relay.example')
assert.equal(classifyProvider('openai', 'https://api.openai.com/v1/relay').kind, 'custom')
assert.equal(classifyProvider('qwen', 'https://dashscope.aliyuncs.com/v1').kind, 'custom')
assert.equal(classifyProvider('Claude', 'https://').kind, 'unconfigured')
assert.equal(classifyProvider('Claude', '').kind, 'unconfigured')
assert.equal(classifyProvider('openai', 'https://api.openai.com/v1?relay=1').kind, 'custom')
assert.equal(classifyProvider('openai', 'https://api.openai.com.evil.example/v1').kind, 'custom')
assert.equal(classifyProvider('openai', 'https://user@api.openai.com/v1').kind, 'custom')
for (const url of ['http://api.openai.com/v1', 'https://api.openai.com:8443/v1', 'https://api.anthropic.com/v1/messages', 'https://generativelanguage.googleapis.com/v1beta/relay', 'https://api.openai.com', 'https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta']) {
  assert.equal(classifyProvider('openai', url).kind, 'custom')
  assert.equal(officialProviderProtocol(url), undefined)
}
for (const [url, protocol] of [
  ['https://api.openai.com/v1/', 'openai-responses'],
  ['https://api.deepseek.com/v1', 'openai-chat'],
  ['https://api.anthropic.com/v1/', 'anthropic'],
  ['https://generativelanguage.googleapis.com/v1beta/openai/', 'gemini'],
  ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'openai-chat'],
]) {
  assert.equal(classifyProvider('relay-name', url).kind, 'official')
  assert.equal(resolveProviderProtocol(url, 'anthropic'), protocol, 'official protocol overrides old preferences')
}
assert.equal(resolveProviderProtocol('https://relay.example/v1', 'openai-responses'), 'openai-responses')
assert.equal(resolveProviderProtocol('http://localhost:11434/v1', 'openai-chat'), 'openai-chat')
assert.equal(selectProviderPreset(existingDraftPlaceholder(), 'openai').protocol, 'openai-responses')
function existingDraftPlaceholder() { return { name: 'Relay', baseUrl: '', apiKey: 'test' } }
assert.equal(classifyProvider('local', 'http://localhost:11434/v1').kind, 'local')
assert.equal(normalizeProviderUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1')
assert.equal(newProviderEnabled, 0, 'new connections require explicit enablement')
assert.equal(providerPresets.some(preset => preset.id as string === 'groq'), false, 'Groq belongs to transcription settings')
assert.equal(providerPresets.find(preset => preset.id === 'qwen')?.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
assert.equal(providerPresets.find(preset => preset.id === 'qwen-singapore')?.baseUrl, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
const existingDraft = { name: 'Existing relay', baseUrl: 'https://relay.example/v1', apiKey: 'unsaved-test-key', type: 'custom' }
const officialSelection = selectProviderPreset(existingDraft, 'claude')
assert.equal(officialSelection.draft.apiKey, existingDraft.apiKey, 'selecting a preset preserves the key')
assert.equal(existingDraft.baseUrl, 'https://relay.example/v1', 'preset selection does not mutate the source configuration')
assert.equal(officialSelection.protocol, 'anthropic')
assert.equal(officialSelection.customEditing, false)
const customSelection = selectProviderPreset(officialSelection.draft, '')
assert.equal(classifyProvider(undefined, customSelection.draft.baseUrl).kind, 'official')
assert.equal(customSelection.customEditing, true, 'Custom must unlock the URL even if it still matches an official endpoint')
assert.deepEqual(customSelection.draft, officialSelection.draft, 'Custom preserves the current URL and credentials')
assert.equal(customSelection.protocol, undefined, 'Custom preserves the current protocol')
const singaporeSelection = selectProviderPreset(existingDraft, 'qwen-singapore')
assert.equal(singaporeSelection.protocol, 'openai-chat')
assert.equal(singaporeSelection.draft.apiKey, existingDraft.apiKey)
const seeds = JSON.parse(readFileSync('../backend/app/db/builtin_providers.json', 'utf8')) as { id: string; enabled: number; base_url: string }[]
assert.equal(seeds.length, 7)
assert.ok(seeds.every(seed => seed.enabled === 0), 'all new-install seeds stay disabled')
assert.equal(seeds.find(seed => seed.id === 'Claude')?.base_url, 'https://api.anthropic.com')
// Provider-scoped protocol changes never mutate other provider preferences.
useProviderProtocolStore.getState().setProtocol('provider-a', 'anthropic')
useProviderProtocolStore.getState().setProtocol('provider-b', 'openai-responses')
assert.deepEqual(useProviderProtocolStore.getState().protocols, { 'provider-a': 'anthropic', 'provider-b': 'openai-responses' })
assert.equal(useProviderProtocolStore.getState().protocols['unconfigured-provider'] || 'openai-chat', 'openai-chat')
const persisted = JSON.parse(localStorage.getItem('bilinote-provider-protocols-v1')!)
assert.deepEqual(persisted.state, { protocols: { 'provider-a': 'anthropic', 'provider-b': 'openai-responses' } })
console.log('Provider address classification and protocol preferences passed.')

async function checkCallProtocols() {
  const sent: string[] = []
  let loads = 0
  const originalLoad = useProviderStore.getState().loadProviderById
  useProviderStore.setState({ provider: [], loadProviderById: async id => {
    loads++
    await Promise.resolve()
    return { id, name: 'Renamed official', baseUrl: 'https://api.openai.com/v1', apiKey: '', type: 'custom', enabled: 1, logo: 'custom' }
  } })
  request.defaults.adapter = async config => {
    const payload = config.params || JSON.parse(config.data)
    sent.push(payload.protocol)
    return { data: { code: 0, data: {} }, status: 200, statusText: 'OK', headers: {}, config }
  }
  const payload = { provider_id: 'cold-official', model_name: 'test', protocol: 'anthropic' as const }
  await askQuestion({ ...payload, task_id: 't', question: 'q', history: [] })
  await compactChat({ ...payload, task_id: 't', history: [], summary: '', keep_recent: 0 })
  const organizer = { ...payload, instruction: 'q', scope: { kind: 'all' as const }, expected_revision: 0, request_id: 'test' }
  await planOrganization(organizer)
  await messageOrganizerSession('s', organizer)
  await compactOrganizerSession('s', organizer)
  await previewRefinement('t', { ...payload, version_id: 'v', texts: [], start_time: 0, end_time: 1, instruction: 'q', use_video: false })
  await getModelCapabilities(payload.provider_id, payload.model_name, payload.protocol)
  await startCapabilityTest({ ...payload, checks: [] })
  setChatStreamTransport(async streamPayload => {
    sent.push(streamPayload.protocol!)
    return new Response('data: {"type":"done","result":{"answer":"ok","sources":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  await askQuestionStream({ ...payload, task_id: 't', question: 'q', history: [] }, () => {})
  assert.equal(loads, 9, 'each cold request waits for provider resolution')
  assert.deepEqual(sent, Array(9).fill('openai-responses'), 'all assistant request paths override stale preferences before transport')
  useProviderStore.setState({ loadProviderById: originalLoad, provider: [{ id: 'relay', name: 'OpenAI', baseUrl: 'https://relay.example/v1', apiKey: '', type: 'custom', enabled: 1, logo: 'custom' }] })
  await askQuestion({ ...payload, provider_id: 'relay', task_id: 't', question: 'q', history: [] })
  assert.equal(sent.at(-1), 'anthropic', 'a misleading provider name must not change a relay protocol')
  console.log('9 real assistant service paths and cold-start protocol resolution passed.')
}
checkCallProtocols().catch(error => { console.error(error); process.exitCode = 1 })
