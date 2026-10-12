import assert from 'node:assert/strict'
import { createTaskStorage } from '../src/utils/taskStorage'
import { writes } from './shims/generation-idb'
const storage = createTaskStorage<{ tasks: object[]; currentTaskId: string | null }>()
const markdown = [{ ver_id: 'saved', content: 'long saved note'.repeat(10000) }]
const task = { id: 'large', status: 'SUMMARIZING', markdown, attemptStartedAt: 1 }
const state = { tasks: [task], currentTaskId: 'large' }
await storage.setItem('test', { state, version: 0 })
assert.equal(writes.length, 1)
for (let i = 0; i < 20; i++) {
  await storage.setItem('test', { state: { ...state, tasks: [{ ...task, lastStatusAt: i, statusMessage: `progress ${i}`, pollingError: undefined }] }, version: 0 })
}
assert.equal(writes.length, 1, 'progress-only polls never reserialize large notes')
await storage.setItem('test', { state: { ...state, tasks: [{ ...task, status: 'SUCCESS' }] }, version: 0 })
assert.equal(writes.length, 2, 'business status changes are durable')
const restored = await storage.getItem('test')
assert.equal(restored?.state.tasks[0] && (restored.state.tasks[0] as any).markdown[0].ver_id, 'saved')
assert.equal((restored?.state.tasks[0] as any).lastStatusAt, undefined)
await storage.setItem('test', { state: { ...state, tasks: [{ ...task, status: 'FAILED', statusMessage: '模型限流', last_active_status: 'SUMMARIZING', started_at: '2026-10-11T00:00:00Z', finished_at: '2026-10-11T00:00:06Z' }] }, version: 0 })
assert.equal(((await storage.getItem('test'))?.state.tasks[0] as any).statusMessage, '模型限流', 'terminal failure reason survives reload')
assert.equal(((await storage.getItem('test'))?.state.tasks[0] as any).last_active_status, 'SUMMARIZING')
assert.equal(((await storage.getItem('test'))?.state.tasks[0] as any).finished_at, '2026-10-11T00:00:06Z')
console.log('generation storage: progress skips giant-note writes / durable changes persist / roundtrip passed')
await storage.setItem('test', { state: { ...state, tasks: [{ ...task, status: 'SUBMISSION_UNKNOWN', formData: { request_id: 'accepted-no-response' }, statusMessage: '正在核对', submissionError: 'response lost' }] }, version: 0 })
const unknown = (await storage.getItem('test'))?.state.tasks[0] as any
assert.equal(unknown.formData.request_id, 'accepted-no-response')
assert.equal(unknown.submissionError, 'response lost')
assert.equal(unknown.statusMessage, '正在核对')
