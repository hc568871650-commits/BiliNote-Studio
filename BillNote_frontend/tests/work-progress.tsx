import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import WorkProgress from '@/components/WorkProgress'
import type { ToolEvent } from '@/services/chat'
import type { OrganizerSession } from '@/services/organizer'

const event: ToolEvent = { id: 'search-one', tool: 'search_web', status: 'succeeded', query: '产品版本', source_count: 2 }
const completed = renderToStaticMarkup(<WorkProgress entries={['我先查一下官网']} events={[event]} />)
assert.match(completed, /aria-expanded="false"/)
assert.ok(!completed.includes('我先查一下官网'), 'Completed progress is not rendered into the answer')
assert.ok(!completed.includes('产品版本'), 'Completed tool details are folded too')
const active = renderToStaticMarkup(<WorkProgress active phase="read_web" entries={['我先查一下官网']} text="正在核对版本" events={[event]} />)
assert.match(active, /aria-expanded="true"/)
assert.match(active, /正在读取网页/)
assert.match(active, /正在核对版本/)
assert.match(active, /产品版本/)
assert.ok(!active.includes('<details'), 'Expanded progress has no second disclosure for tools')
assert.equal(renderToStaticMarkup(<WorkProgress text="最终回答" />), '', 'An ordinary final answer does not create an empty process panel')
assert.match(renderToStaticMarkup(<WorkProgress events={[event]} />), /工作过程/)
assert.match(renderToStaticMarkup(<WorkProgress active phase="compacting" />), /正在压缩上下文/)

const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) || null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} })
async function run() {
  const { useOrganizerStore: store } = await import('@/store/organizerStore')
  const { default: request } = await import('@/utils/request')
  const session: OrganizerSession = {
    session_id: 'work-progress-fixture', revision: 1, status: 'planning',
    scope: { kind: 'all', authorized: false, exclude_favorites: false, target_count: 0 },
    history: [{ id: 'u1', role: 'user', content: '查一下版本', created_at: 1 }],
    plan: null, result: null, error: null, events: [], updated_at: 1,
    streaming_work_log: ['我先查一下官网'], streaming_reply: '正在核对版本', streaming_phase: 'read_web', streaming_tool_events: [event],
  }
  const original = request.get
  request.get = (async () => structuredClone(session)) as typeof request.get
  try {
    await store.getState().restore(session.session_id)
    let message = store.getState().messages.at(-1)!
    assert.equal(message.active, true)
    assert.equal(message.work_phase, 'read_web')
    assert.deepEqual(message.work_log, ['我先查一下官网'])
    assert.equal(message.text, '正在核对版本')
    session.status = 'completed'; session.updated_at = 2
    session.history.push({ id: 'a1', role: 'assistant', content: '最终答案只有版本信息', created_at: 2, work_log: ['我先查一下官网'], tool_events: [event] })
    await store.getState().refresh()
    message = store.getState().messages.at(-1)!
    assert.equal(message.active, undefined)
    assert.equal(message.text, '最终答案只有版本信息')
    assert.deepEqual(message.work_log, ['我先查一下官网'])
    await store.getState().restore(session.session_id)
    assert.deepEqual(store.getState().messages.at(-1), message, 'Reload preserves the separation between progress and the answer')
  } finally { request.get = original }
  console.log('work progress: collapsed history, expanded active stages, inline tool evidence, organizer polling and reload passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
