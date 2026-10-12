import assert from 'node:assert/strict'
import { get as getPersisted } from './shims/generation-idb'
const local = new Map<string, string>()
Object.assign(globalThis, { localStorage: {
  getItem: (name: string) => local.get(name) ?? null,
  setItem: (name: string, value: string) => { local.set(name, value) },
  removeItem: (name: string) => { local.delete(name) },
} })
const { useTaskStore: store } = await import('../src/store/taskStore')
const { default: request } = await import('../src/utils/request')
await store.persist.rehydrate()
store.getState().addPendingTask('saved', 'bilibili', { provider_id: 'p', model_name: 'm', request_id: 'previous-request' })
store.getState().updateTaskContent('saved', { status: 'SUCCESS', markdown: 'old saved note' })
const old = store.getState().tasks[0].markdown
store.getState().updateTaskContent('saved', { status: 'SUCCESS', markdown: 'duplicate', statusMessage: '完成', lastStatusAt: 22 })
assert.equal(store.getState().tasks[0].markdown, old)
assert.equal(store.getState().tasks[0].lastStatusAt, 22)
const calls: any[] = []
request.post = (async (_path: string, body: any) => { calls.push(body); throw { code: -1, msg: 'response unavailable' } }) as typeof request.post
const originalError = console.error
console.error = () => undefined
await assert.rejects(store.getState().retryTask('saved'), error => (error as any).msg === 'response unavailable')
console.error = originalError
assert.equal(calls.length, 1, 'failed submission is never retried automatically')
assert.equal(store.getState().tasks[0].markdown, old, 'unknown submission keeps old versions')
assert.equal(store.getState().tasks[0].status, 'SUBMISSION_UNKNOWN')
assert.equal(store.getState().tasks[0].submissionError, 'response unavailable')
assert.notEqual(calls[0].request_id, 'previous-request', 'explicit regeneration creates a fresh request ID')
assert.equal(store.getState().tasks[0].formData.request_id, calls[0].request_id, 'unknown accepted request keeps the submitted ID')
await assert.rejects(store.getState().retryTask('saved'), /避免重复提交/)
assert.equal(calls.length, 1, 'unknown acceptance blocks another paid POST')
store.getState().updateTaskContent('saved', { status: 'SUCCESS', submissionError: undefined })
request.post = (async (_path: string, body: any) => { calls.push(body); return { task_id: body.task_id } }) as typeof request.post
await store.getState().retryTask('saved', { provider_id: 'p', model_name: 'm', request_id: 'user-attempt' })
assert.equal(calls[1].request_id, 'user-attempt')
assert.equal(store.getState().tasks[0].status, 'PENDING')
assert.equal(store.getState().tasks[0].markdown, old)
assert.equal(store.getState().tasks[0].submissionError, undefined)
assert.equal(store.getState().tasks[0].formData.request_id, 'user-attempt')
assert.equal(typeof store.getState().tasks[0].attemptStartedAt, 'number')
assert.equal(store.getState().tasks[0].last_active_status, 'PENDING')
assert.equal(store.getState().tasks[0].finished_at, undefined)
store.getState().updateTaskContent('saved', { status: 'FAILED', statusMessage: 'finish_reason=length', last_active_status: 'SUMMARIZING', finished_at: '2026-10-11T00:00:06Z' })
const remote = { ...store.getState().tasks[0], statusMessage: undefined, last_active_status: undefined, finished_at: undefined }
request.get = (async () => remote) as typeof request.get
await store.getState().loadTask('saved')
assert.equal(store.getState().tasks[0].statusMessage, 'finish_reason=length', 'opening a note preserves terminal message omitted by old endpoint')
assert.equal(store.getState().tasks[0].last_active_status, 'SUMMARIZING')
request.get = (async () => [remote]) as typeof request.get
await store.getState().syncNotes()
assert.equal(store.getState().tasks[0].statusMessage, 'finish_reason=length', 'startup sync preserves same-attempt terminal details')
assert.equal(store.getState().tasks[0].finished_at, '2026-10-11T00:00:06Z')
let resolveDetail!: (value: any) => void
request.get = (async () => new Promise(resolve => { resolveDetail = resolve })) as typeof request.get
const staleLoad = store.getState().loadTask('saved')
await store.getState().retryTask('saved', { provider_id: 'p', model_name: 'm', request_id: 'next-attempt' })
resolveDetail(remote)
await staleLoad
assert.equal(store.getState().tasks[0].status, 'PENDING', 'late detail cannot roll back a new generation')
assert.equal(store.getState().tasks[0].last_active_status, 'PENDING')
store.getState().updateTaskContent('saved', { status: 'FAILED', statusMessage: 'prior failure' })
const rejectedId = store.getState().tasks[0].formData.request_id
request.post = (async () => { throw { code: 400, msg: '明确拒绝' } }) as typeof request.post
console.error = () => undefined
await assert.rejects(store.getState().retryTask('saved'), error => (error as any).code === 400)
console.error = originalError
assert.equal(store.getState().tasks[0].status, 'FAILED', 'explicit rejection keeps prior terminal status')
assert.equal(store.getState().tasks[0].formData.request_id, rejectedId, 'explicit rejection does not replace the accepted request ID')
let releasePost!: (value: any) => void
let concurrentPosts = 0
request.post = (async (_path: string, body: any) => {
  concurrentPosts++
  const persisted = JSON.parse((await getPersisted('task-storage'))!)
  assert.equal(persisted.state.tasks[0].formData.request_id, body.request_id, 'request ID is durable before POST')
  assert.equal(persisted.state.tasks[0].status, 'SUBMISSION_UNKNOWN')
  return new Promise(resolve => { releasePost = resolve })
}) as typeof request.post
const firstPost = store.getState().retryTask('saved')
await assert.rejects(store.getState().retryTask('saved'), /避免重复提交/)
await new Promise(resolve => setTimeout(resolve, 0))
assert.equal(concurrentPosts, 1, 'simultaneous retries are single-flight before POST returns')
releasePost({ task_id: 'saved' })
await firstPost
assert.equal(store.getState().tasks[0].status, 'PENDING')
store.getState().updateTaskContent('saved', { status: 'FAILED' })
request.post = (async () => { throw { code: -1, msg: 'request never reached server' } }) as typeof request.post
console.error = () => undefined
await assert.rejects(store.getState().retryTask('saved'))
console.error = originalError
const uncertainId = store.getState().tasks[0].formData.request_id
let resumedPosts = 0
request.post = (async (_path: string, body: any) => {
  resumedPosts++
  assert.equal(body.request_id, uncertainId, 'explicit recovery uses the saved ID, never a new paid attempt')
  assert.equal(body.resume_submission, undefined, 'client-only control is not sent to server')
  return new Promise(resolve => { releasePost = resolve })
}) as typeof request.post
const resumed = store.getState().resumeSubmission('saved')
await assert.rejects(store.getState().resumeSubmission('saved'), /避免重复提交/)
await new Promise(resolve => setTimeout(resolve, 0))
assert.equal(resumedPosts, 1, 'explicit same-ID recovery is single-flight')
releasePost({ task_id: 'saved' })
await resumed
assert.equal(store.getState().tasks[0].status, 'PENDING', 'never-accepted request has a safe explicit recovery')
assert.equal(store.getState().tasks[0].formData.request_id, uncertainId)
console.log('generation store: versions preserved / progress refresh / retry errors propagate / single submission / fresh ID passed')
