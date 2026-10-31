import assert from 'node:assert/strict'

async function main() {
  const entries = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { value: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  } })
  Object.defineProperty(globalThis, 'window', { value: { localStorage: globalThis.localStorage } })
  const { useCreateNoteDraftStore: store } = await import('../src/store/createNoteDraftStore')
  const values = { video_url: 'fixture.mp4', platform: 'local', model_name: 'api-model', extras: 'keep me', style: 'knowledge' as const }
  const pending = { task_id: 'fixture-task', request_id: 'fixture-request', video_url: 'fixture.mp4', platform: 'local',
    provider_id: 'fixture-provider', model_name: 'api-model', quality: 'medium', style: 'knowledge', grid_size: [2, 2], format: ['link'] }
  store.getState().update({ values, providerId: 'fixture-provider', pending, submitting: true, uploading: true, advancedOpen: true, optionsOpen: true })
  const saved = JSON.parse(entries.get('bilinote-create-draft-v1')!).state
  assert.equal(saved.pending.request_id, 'fixture-request', 'An uncertain request survives reload to prevent duplicate submissions')
  assert.equal(saved.submitting, undefined, 'Never restore a spinner as an active request')
  assert.equal(saved.uploading, undefined)
  store.setState({ submitting: false, uploading: false })
  await store.persist.rehydrate()
  assert.deepEqual(store.getState().values, values)
  assert.equal(store.getState().advancedOpen, true)
  assert.equal(store.getState().optionsOpen, true)
  store.getState().clearSource()
  assert.equal(store.getState().values.video_url, '')
  assert.equal(store.getState().values.extras, 'keep me')
  assert.equal(store.getState().values.model_name, 'api-model')
  assert.equal(store.getState().providerId, 'fixture-provider')
  assert.equal(store.getState().pending, null)
  assert.equal(store.getState().submitting, false)
  assert.equal(JSON.parse(entries.get('bilinote-create-draft-v1')!).state.pending, null)
  console.log('PASS: draft persistence, request identity, transient state, expansion and accepted-source clearing')
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
