import assert from 'node:assert/strict'
import { useModelStore } from '../src/store/modelStore'
import { deferredModels, modelCalls } from './shims/generation-model-service'

const store = useModelStore.getState
const first = store().loadEnabledModels()
const second = store().loadEnabledModels()
assert.equal(modelCalls.length, 1, 'Opening multiple pickers shares the pending request')
deferredModels.shift()!.resolve([{ id: 'm1', provider_id: 'p1', model_name: 'model-one' }])
await Promise.all([first, second])
await store().loadEnabledModels()
assert.equal(modelCalls.length, 1, 'Fresh cached models render without another request')
const refresh = store().loadEnabledModels({ force: true })
assert.equal(store().modelList[0].model_name, 'model-one', 'Refreshing must retain the current options')
deferredModels.shift()!.reject(new Error('temporary offline'))
await refresh
assert.equal(store().modelList[0].model_name, 'model-one', 'Transport failure does not erase a usable model selection')
assert.ok(store().enabledError)
assert.equal(store().enabledLoading, false)
console.log('generation models: single flight / cache / refresh without flicker / failure retains options passed')
