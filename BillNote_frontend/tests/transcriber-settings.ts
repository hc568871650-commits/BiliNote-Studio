import assert from 'node:assert/strict'
import { buildTranscriberUpdate, loadTranscriberDraft } from '../src/utils/transcriberSettings'
import type { TranscriberConfig } from '../src/services/transcriber'

const saved: TranscriberConfig = {
  transcriber_type: 'groq', whisper_model_size: 'base', mlx_whisper_model_size: 'large-v3',
  groq_model: 'whisper-large-v3', groq_connection: { base_url: 'https://example.test/v1', api_key: '********', enabled: false },
  available_types: [], whisper_model_sizes: [], mlx_whisper_available: true,
}
const draft = loadTranscriberDraft(saved, null)
assert.equal(draft.fastModel, 'base')
assert.equal(draft.mlxModel, 'large-v3')
assert.deepEqual(draft.connection, saved.groq_connection)
assert.equal(draft.groqModel, saved.groq_model)

const edited = { ...draft, connection: { ...draft.connection, api_key: 'unsaved-test-key' }, fastModel: 'small', groqModel: 'whisper-large-v3-turbo' }
// Navigating away and loading fresh saved settings must preserve session edits.
assert.equal(loadTranscriberDraft(saved, edited), edited)
assert.deepEqual(buildTranscriberUpdate({ ...edited, type: 'fast-whisper' }), { transcriber_type: 'fast-whisper', whisper_model_size: 'small' })
assert.deepEqual(buildTranscriberUpdate({ ...edited, type: 'mlx-whisper' }), { transcriber_type: 'mlx-whisper', mlx_whisper_model_size: 'large-v3' })
for (const type of ['bcut', 'kuaishou']) assert.deepEqual(buildTranscriberUpdate({ ...edited, type }), { transcriber_type: type })
assert.equal(edited.connection.api_key, 'unsaved-test-key')
assert.equal(edited.groqModel, 'whisper-large-v3-turbo')
assert.deepEqual(buildTranscriberUpdate({ ...draft, type: 'groq' }).groq_connection, saved.groq_connection)
assert.equal(buildTranscriberUpdate({ ...edited, type: 'groq', connection: { ...edited.connection, api_key: '' } }).groq_connection?.api_key, '')
console.log('Transcriber settings: restored independent models, retained drafts, engine-only updates, masked/cleared credentials passed')
