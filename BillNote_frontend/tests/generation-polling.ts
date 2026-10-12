import assert from 'node:assert/strict'
import { useTaskPolling } from '../src/hooks/useTaskPolling'
import { cleanups, notices, replaceTasks, selectTask, setHandlers, tasks } from './shims/generation-polling'
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
Object.assign(globalThis, { window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: 'visible' }) })

// Slow requests exceed the polling interval; both concurrency and per-ID overlap stay bounded.
let active = 0, max = 0
const ids = new Set<string>()
let calls = 0
replaceTasks(Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, status: 'PENDING' })))
setHandlers(async id => {
  assert.equal(ids.has(id), false)
  ids.add(id); active++; max = Math.max(max, active); calls++
  await pause(20)
  active--; ids.delete(id)
  return { task_id: id, status: 'RUNNING', message: '仍在处理' }
}, async () => { throw new Error('unexpected detail read') })
useTaskPolling(2)
assert.equal(calls, 3, 'first round starts immediately with 3 workers')
await pause(65)
assert.equal(max, 3)
cleanups.pop()!()
await pause(25)
assert.equal(active, 0)

// A transient outage leaves the business status intact and recovers into authoritative final versions.
notices.length = 0
let attempt = 0
replaceTasks([{ id: 'recover', status: 'SUMMARIZING', attemptStartedAt: 1 }])
setHandlers(async id => {
  attempt++
  if (attempt === 1) throw { msg: 'temporary network error' }
  return { task_id: id, status: 'SUCCESS', message: '完成' }
}, async id => ({ id, status: 'SUCCESS', markdown: [{ ver_id: 'final', content: 'final saved version' }] }))
useTaskPolling(15)
await pause(3)
assert.equal(tasks[0].status, 'SUMMARIZING')
assert.equal(tasks[0].pollingError, 'temporary network error')
await pause(35)
assert.equal(tasks[0].status, 'SUCCESS')
assert.equal(tasks[0].pollingError, undefined)
assert.equal((tasks[0].markdown as any[])[0].ver_id, 'final')
assert.equal(notices.length, 1)
cleanups.pop()!()

// A real business failure retains its message; unchanged phases refresh the explanatory message.
replaceTasks([{ id: 'failed', status: 'SUMMARIZING', attemptStartedAt: 1 }])
setHandlers(async id => ({ task_id: id, status: 'FAILED', message: '模型返回限流，请稍后重试' }), async () => ({}))
useTaskPolling(10)
await pause(3)
assert.equal(tasks[0].status, 'FAILED')
assert.equal(tasks[0].statusMessage, '模型返回限流，请稍后重试')
assert.equal(tasks[0].last_active_status, 'SUMMARIZING', 'legacy API falls back to the actual last observed phase')
cleanups.pop()!()

replaceTasks([{ id: 'failed-server', status: 'PENDING', attemptStartedAt: 1, audioMeta: { title: '' } }])
const failureDetail = '笔记生成未完成：模型输出因长度限制被截断（finish_reason=length），未保存半截正文；请提高输出预算或缩小来源范围后手动重试。'
setHandlers(async id => ({ task_id: id, status: 'FAILED', message: failureDetail, last_active_status: 'SUMMARIZING', started_at: '2026-10-11T00:00:00Z', finished_at: '2026-10-11T00:00:06Z', audio_meta: { title: '真实视频标题' } }), async () => ({}))
useTaskPolling(10)
await pause(3)
assert.equal(tasks[0].last_active_status, 'SUMMARIZING', 'server last phase overrides stale local phase')
assert.equal(tasks[0].statusMessage, failureDetail)
assert.equal(tasks[0].finished_at, '2026-10-11T00:00:06Z')
assert.equal((tasks[0].audioMeta as any).title, '真实视频标题')
cleanups.pop()!()

// Selection and focus bypass the regular delay, refreshing the selected active task first.
replaceTasks([{ id: 'one', status: 'RUNNING' }, { id: 'two', status: 'RUNNING' }])
const order: string[] = []
setHandlers(async id => { order.push(id); return { task_id: id, status: 'RUNNING', message: '最新进度' } }, async () => ({}))
useTaskPolling(1000)
await pause(2)
order.length = 0
selectTask('two')
await pause(2)
assert.equal(order[0], 'two')
assert.equal(tasks[1].statusMessage, '最新进度')
order.length = 0
window.dispatchEvent(new Event('focus'))
await pause(2)
assert.equal(order[0], 'two')
cleanups.pop()!()

// Unmount aborts and prevents late writes even if the transport ignores AbortSignal.
let resolveLate!: (value: any) => void
let signal!: AbortSignal
replaceTasks([{ id: 'late', status: 'PENDING', attemptStartedAt: 1 }])
setHandlers(async (_, options) => { signal = options.signal; return new Promise(resolve => { resolveLate = resolve }) }, async () => ({}))
useTaskPolling(10)
cleanups.pop()!()
assert.equal(signal.aborted, true)
resolveLate({ status: 'FAILED', message: 'old result' })
await pause(2)
assert.equal(tasks[0].status, 'PENDING')

// A new attempt invalidates the response from the old attempt for the same ID.
setHandlers(async () => new Promise(resolve => { resolveLate = resolve }), async () => ({}))
useTaskPolling(100)
replaceTasks([{ id: 'late', status: 'PENDING', attemptStartedAt: 2 }])
resolveLate({ status: 'FAILED', message: 'previous attempt' })
await pause(1)
assert.equal(tasks[0].status, 'PENDING')
cleanups.pop()!()
// Same task ID can have an old successful response from a previous request.
replaceTasks([{ id: 'request-match', status: 'PENDING', formData: { request_id: 'new-request' } }])
setHandlers(async id => ({ task_id: id, status: 'SUCCESS', request_id: 'old-request' }), async () => { throw new Error('must not read old details') })
useTaskPolling(100)
await pause(2)
assert.equal(tasks[0].status, 'PENDING')
cleanups.pop()!()
console.log('generation polling: immediate / bounded / recovery / terminal / stale / abort passed')

replaceTasks([{ id: 'unknown', status: 'SUBMISSION_UNKNOWN', formData: { request_id: 'accepted-no-response' }, submissionError: 'response lost' }])
let unknownChecks = 0
let allowUnknownSuccess = false
setHandlers(async id => {
  unknownChecks++
  if (unknownChecks === 1) return { task_id: id, status: 'FAILED', request_id: 'previous-attempt', message: 'old error' }
  return { task_id: id, status: allowUnknownSuccess ? 'SUCCESS' : 'SUMMARIZING', request_id: 'accepted-no-response' }
}, async id => ({ id, status: 'SUCCESS', formData: { request_id: 'accepted-no-response' }, markdown: [{ ver_id: 'accepted-final', content: 'complete' }] }))
useTaskPolling(10)
await pause(3)
assert.equal(tasks[0].status, 'SUBMISSION_UNKNOWN', 'old attempt cannot settle unknown acceptance')
await pause(12)
assert.equal(tasks[0].status, 'SUMMARIZING', 'accepted request is discovered without repeating POST')
assert.equal(tasks[0].submissionError, undefined)
allowUnknownSuccess = true
await pause(20)
assert.equal(tasks[0].status, 'SUCCESS')
assert.equal((tasks[0].markdown as any[])[0].ver_id, 'accepted-final')
cleanups.pop()!()
console.log('unknown submission: exact request reconciliation / automatic progress / final versions passed')
