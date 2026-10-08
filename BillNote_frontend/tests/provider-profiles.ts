import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyProvider, newProviderEnabled, normalizeProviderUrl, providerPresets, selectProviderPreset } from '../src/utils/providerProfiles'
import { useProviderProtocolStore } from '../src/store/providerProtocolStore'

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
